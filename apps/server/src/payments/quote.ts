import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assertProvenanceAllowed, type CartMandate, type PaymentRail } from "@settleback/adapters";
import { PAYMENT_ATTEMPT_MACHINE, assertTransition, type PaymentAttemptState } from "@settleback/domain";
import { immediateTransaction } from "../db/database.ts";
import { OperationNotFoundError, StoreError } from "../db/errors.ts";
import { appendEvent } from "../db/events.ts";
import { getOperation } from "../db/operations.ts";

/** How long a quoted cart stays payable, as the gateway suggests for one-time orders. */
export const CART_LIFETIME_MS = 2 * 60 * 60 * 1000;
const QUOTABLE: readonly PaymentAttemptState[] = ["CREATED", "PREPARED"];

export class AttemptNotQuotableError extends StoreError {
  constructor(operationId: string, state: string) {
    super("ATTEMPT_NOT_QUOTABLE", `The original payment for operation ${operationId} is already ${state}; it cannot be quoted again.`);
  }
}

export interface QuoteInput {
  operationId: string;
  rail: PaymentRail;
  /** Identifies this application deployment in payment references. */
  deploymentId: string;
  /** Token symbol as the gateway lists it. */
  coin: string;
  label: string;
  now: () => Date;
  newId?: () => string;
}

export interface Quote {
  attemptId: string;
  cartMandate: CartMandate;
  cartMandateId: string;
  paymentRequestId: string;
  cartSha256: string;
  recovered: boolean;
}

/**
 * The receiving agent's quote for an operation: the merchant-signed Cart Mandate for the job's
 * immutable intent, backed by one gateway order. The attempt and its gateway identifiers are
 * stored before the order is created, so a crash or lost response is recovered by querying the
 * same identifiers; quoting again never creates a second order. Nothing here moves money.
 */
export async function quoteOperation(db: DatabaseSync, input: QuoteInput): Promise<Quote> {
  const newId = input.newId ?? randomUUID;
  const { attempt, operation } = immediateTransaction(db, () => {
    const operation = getOperation(db, input.operationId);
    if (operation === undefined) throw new OperationNotFoundError(input.operationId);
    assertProvenanceAllowed(operation.environment, input.rail.provenance);
    const live = db
      .prepare(
        `SELECT id, state, cart_mandate_id, payment_request_id, created_at FROM payment_attempts
         WHERE operation_id = ? AND purpose = 'ORIGINAL' AND state NOT IN ('REJECTED_NO_SEND', 'FAILED')`,
      )
      .get(operation.id);
    if (live !== undefined) {
      const state = String(live.state) as PaymentAttemptState;
      if (!QUOTABLE.includes(state)) throw new AttemptNotQuotableError(operation.id, state);
      return {
        operation,
        attempt: { id: String(live.id), cartMandateId: String(live.cart_mandate_id), paymentRequestId: String(live.payment_request_id), createdAt: String(live.created_at) },
      };
    }
    const id = newId();
    const createdAt = input.now().toISOString();
    const attempt = { id, cartMandateId: `cart-${id}`, paymentRequestId: `pr-${id}`, createdAt };
    db.prepare(
      `INSERT INTO payment_attempts (id, operation_id, purpose, state, payer, payee, chain_id, token, amount_base_units,
         intent_sha256, deployment_id, cart_mandate_id, payment_request_id, created_at, updated_at)
       VALUES (?, ?, 'ORIGINAL', 'CREATED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      operation.id,
      operation.buyer,
      operation.seller,
      operation.chainId,
      operation.token,
      operation.amountBaseUnits,
      operation.intentSha256,
      input.deploymentId,
      attempt.cartMandateId,
      attempt.paymentRequestId,
      createdAt,
      createdAt,
    );
    appendEvent(db, {
      entityType: "payment_attempt",
      entityId: id,
      eventType: "PAYMENT_ATTEMPT_CREATED",
      priorRevision: null,
      newRevision: 0,
      actor: "server",
      payloadSha256: operation.intentSha256,
      createdAt,
    });
    return { operation, attempt };
  });

  const prepared = await input.rail.prepare({
    cartMandateId: attempt.cartMandateId,
    paymentRequestId: attempt.paymentRequestId,
    payee: operation.seller,
    chainId: operation.chainId,
    token: operation.token,
    coin: input.coin,
    tokenDecimals: operation.tokenDecimals,
    priceUsd: operation.priceUsd,
    label: input.label,
    // Fixed by the attempt, so every quote for it has the same contents and cart hash.
    expiresAt: new Date(Date.parse(attempt.createdAt) + CART_LIFETIME_MS).toISOString(),
  });

  markPrepared(db, attempt.id, prepared, input.now().toISOString());

  return {
    attemptId: attempt.id,
    cartMandate: prepared.cartMandate,
    cartMandateId: attempt.cartMandateId,
    paymentRequestId: attempt.paymentRequestId,
    cartSha256: prepared.cartSha256,
    recovered: prepared.recovered,
  };
}

/**
 * Records the gateway order behind an attempt: CREATED becomes PREPARED with the cart hash. A
 * repeated or recovered quote of the same attempt must carry the same cart; once the attempt has
 * moved on, nothing changes.
 */
export function markPrepared(db: DatabaseSync, attemptId: string, prepared: { cartSha256: string; recovered: boolean }, now: string): void {
  immediateTransaction(db, () => {
    const row = db.prepare("SELECT state, revision, cart_sha256 FROM payment_attempts WHERE id = ?").get(attemptId);
    if (row === undefined) throw new Error(`payment attempt ${attemptId} disappeared`);
    const state = String(row.state) as PaymentAttemptState;
    if (row.cart_sha256 !== null && row.cart_sha256 !== prepared.cartSha256) {
      throw new StoreError("CART_MISMATCH", `Payment attempt ${attemptId} was quoted with different cart contents.`);
    }
    if (state !== "CREATED") return;
    assertTransition(PAYMENT_ATTEMPT_MACHINE, "CREATED", "PREPARED", { actor: "server" });
    const revision = Number(row.revision);
    const updated = db
      .prepare("UPDATE payment_attempts SET state = 'PREPARED', cart_sha256 = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
      .run(prepared.cartSha256, revision + 1, now, attemptId, revision);
    if (updated.changes !== 1) throw new Error(`payment attempt ${attemptId} changed while it was being quoted`);
    appendEvent(db, {
      entityType: "payment_attempt",
      entityId: attemptId,
      eventType: prepared.recovered ? "PAYMENT_ATTEMPT_PREPARED_RECOVERED" : "PAYMENT_ATTEMPT_PREPARED",
      priorRevision: revision,
      newRevision: revision + 1,
      actor: "server",
      payloadSha256: prepared.cartSha256,
      createdAt: now,
    });
  });
}
