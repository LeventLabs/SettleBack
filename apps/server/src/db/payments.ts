import type { DatabaseSync } from "node:sqlite";
import { PAYMENT_ATTEMPT_MACHINE, assertTransition, type Actor, type Address, type PaymentAttemptState, type PaymentFacts } from "@settleback/domain";
import { appendEvent } from "./events.ts";

/**
 * The operation's original payment: its live attempt if there is one, otherwise the most recent
 * closed attempt. At most one original attempt can be live at a time (see the partial unique index).
 */
export function getOriginalPayment(db: DatabaseSync, operationId: string): PaymentFacts | undefined {
  const row = db
    .prepare(
      `SELECT id, operation_id, purpose, state, payer, payee, chain_id, token, amount_base_units
       FROM payment_attempts WHERE operation_id = ? AND purpose = 'ORIGINAL'
       ORDER BY state NOT IN ('REJECTED_NO_SEND', 'FAILED') DESC, created_at DESC, id DESC LIMIT 1`,
    )
    .get(operationId);
  if (row === undefined) return undefined;
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    purpose: "ORIGINAL",
    state: String(row.state) as PaymentAttemptState,
    payer: String(row.payer) as Address,
    payee: String(row.payee) as Address,
    chainId: Number(row.chain_id),
    token: String(row.token) as Address,
    amountBaseUnits: String(row.amount_base_units),
  };
}

export interface PaymentAttemptRecord {
  id: string;
  operationId: string;
  purpose: "ORIGINAL" | "REPAYMENT";
  state: PaymentAttemptState;
  revision: number;
  payer: Address;
  payee: Address;
  chainId: number;
  token: Address;
  amountBaseUnits: string;
  intentSha256: string;
  deploymentId: string;
  cartMandateId: string | null;
  paymentRequestId: string | null;
  flowId: string | null;
  requestId: string | null;
  cartSha256: string | null;
  paymentMandateSha256: string | null;
  txHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getPaymentAttempt(db: DatabaseSync, id: string): PaymentAttemptRecord | undefined {
  const row = db.prepare("SELECT * FROM payment_attempts WHERE id = ?").get(id);
  if (row === undefined) return undefined;
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    purpose: String(row.purpose) as PaymentAttemptRecord["purpose"],
    state: String(row.state) as PaymentAttemptState,
    revision: Number(row.revision),
    payer: String(row.payer) as Address,
    payee: String(row.payee) as Address,
    chainId: Number(row.chain_id),
    token: String(row.token) as Address,
    amountBaseUnits: String(row.amount_base_units),
    intentSha256: String(row.intent_sha256),
    deploymentId: String(row.deployment_id),
    cartMandateId: text(row.cart_mandate_id),
    paymentRequestId: text(row.payment_request_id),
    flowId: text(row.flow_id),
    requestId: text(row.request_id),
    cartSha256: text(row.cart_sha256),
    paymentMandateSha256: text(row.payment_mandate_sha256),
    txHash: text(row.tx_hash),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export interface AttemptMove {
  to: PaymentAttemptState;
  actor: Actor;
  actorLabel: string;
  evidenceRef?: string;
  eventType: string;
  /** Digest of what justified the move, recorded with the event. */
  payloadSha256: string;
  now: string;
  /** References are write-once; the schema refuses to change one already recorded. */
  set?: { paymentMandateSha256?: string; flowId?: string; requestId?: string; txHash?: string };
}

/** Moves an attempt through the payment state machine with a compare-and-swap on its revision. Callers hold the transaction. */
export function moveAttempt(db: DatabaseSync, record: PaymentAttemptRecord, move: AttemptMove): PaymentAttemptRecord {
  assertTransition(PAYMENT_ATTEMPT_MACHINE, record.state, move.to, { actor: move.actor, ...(move.evidenceRef === undefined ? {} : { evidenceRef: move.evidenceRef }) });
  const updated = db
    .prepare(
      `UPDATE payment_attempts SET state = ?, revision = ?, updated_at = ?,
         payment_mandate_sha256 = coalesce(?, payment_mandate_sha256), flow_id = coalesce(?, flow_id),
         request_id = coalesce(?, request_id), tx_hash = coalesce(?, tx_hash)
       WHERE id = ? AND revision = ?`,
    )
    .run(
      move.to,
      record.revision + 1,
      move.now,
      move.set?.paymentMandateSha256 ?? null,
      move.set?.flowId ?? null,
      move.set?.requestId ?? null,
      move.set?.txHash ?? null,
      record.id,
      record.revision,
    );
  if (updated.changes !== 1) throw new Error(`payment attempt ${record.id} changed concurrently`);
  appendEvent(db, {
    entityType: "payment_attempt",
    entityId: record.id,
    eventType: move.eventType,
    priorRevision: record.revision,
    newRevision: record.revision + 1,
    actor: move.actorLabel,
    payloadSha256: move.payloadSha256,
    createdAt: move.now,
  });
  const after = getPaymentAttempt(db, record.id);
  if (after === undefined) throw new Error(`payment attempt ${record.id} disappeared`);
  return after;
}
