import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  QUOTE_MARGIN_MS,
  checkPreparedPayment,
  isQuoteExpired,
  verifyEip3009Signature,
  type CheckedOffer,
  type HspAgenticRail,
  type HspOfferPayload,
  type OfferCheck,
  type OfferExpectations,
  type PrepareInput,
  type ValidatedCart,
} from "@settleback/adapters";
import type { Address } from "@settleback/domain";
import { sha256Hex } from "@settleback/domain/hash";
import { immediateTransaction, readTransaction } from "../db/database.ts";
import { ActionIntegrityError } from "../db/errors.ts";
import { getPaymentAttempt, type PaymentAttemptRecord } from "../db/payments.ts";
import { ExecutionRefusedError, claimExecution } from "./execution.ts";
import { markPrepared } from "./quote.ts";

/**
 * How long an HSP cart stays payable. Kept short because the authorization HSP prepares may stay
 * valid until the cart expires, and a signed authorization can be executed until then.
 */
export const HSP_CART_LIFETIME_MS = 30 * 60 * 1000;

export function hspCartExpiryOf(attempt: { createdAt: string }): string {
  return new Date(Date.parse(attempt.createdAt) + HSP_CART_LIFETIME_MS).toISOString();
}

/** The order terms an attempt sends to HSP; the cart expiry is fixed by the attempt, so recreating the order sends the same cart. */
export function hspOrderInput(attempt: PaymentAttemptRecord, terms: { tokenDecimals: number; priceUsd: string; coin: string; label: string }): PrepareInput {
  if (attempt.cartMandateId === null || attempt.paymentRequestId === null) throw new ActionIntegrityError(`payment attempt ${attempt.id} has no gateway identifiers`);
  return {
    cartMandateId: attempt.cartMandateId,
    paymentRequestId: attempt.paymentRequestId,
    payee: attempt.payee,
    chainId: attempt.chainId,
    token: attempt.token,
    coin: terms.coin,
    tokenDecimals: terms.tokenDecimals,
    priceUsd: terms.priceUsd,
    label: terms.label,
    expiresAt: hspCartExpiryOf(attempt),
  };
}

/** Creates HSP's order for a CREATED attempt and records it: PREPARED, with the cart hash and HSP's flow ID. */
export async function orderAttempt(db: DatabaseSync, input: { attempt: PaymentAttemptRecord; rail: HspAgenticRail; order: PrepareInput; now: () => Date }): Promise<PaymentAttemptRecord> {
  if (input.attempt.state !== "CREATED") return input.attempt;
  const order = await input.rail.createOrder(input.order);
  markPrepared(db, input.attempt.id, { cartSha256: order.cartSha256, recovered: order.recovered, flowId: order.flowId }, input.now().toISOString());
  return requireAttempt(db, input.attempt.id);
}

interface StoredOffer {
  id: string;
  raw: unknown;
  sha256: string;
  quoteExpiresAt: string;
}

export type OfferOutcome =
  | { status: "SIGNATURE_REQUIRED"; attempt: PaymentAttemptRecord; offer: CheckedOffer; checks: OfferCheck[] }
  | { status: "REFUSED"; attempt: PaymentAttemptRecord; checks: OfferCheck[]; reasons: string[] }
  | { status: "ALREADY_REQUESTED"; attempt: PaymentAttemptRecord };

export interface OfferInput {
  attemptId: string;
  rail: HspAgenticRail;
  /** The order's intent and the payer's policy, read when the check runs (today's spend changes). */
  expectations: (attempt: PaymentAttemptRecord) => OfferExpectations;
  now: () => Date;
  newId?: () => string;
}

/**
 * The authorization the payer is asked to sign. HSP prepares it; the Payment Agent checks every
 * field; only then is it stored and returned. While its quote is valid the same offer is returned
 * again, checked again. Once the quote has expired a new one is prepared: the old offer was never
 * claimed, so its signature, if the payer made one, never reached this server's submission or
 * HSP, and only the payer could hold it. Nothing here consumes the permit.
 */
export async function offerAuthorization(db: DatabaseSync, input: OfferInput): Promise<OfferOutcome> {
  return serialized(input.attemptId, async () => {
    const attempt = requireAttempt(db, input.attemptId);
    if (attempt.state !== "PREPARED") {
      if (attempt.state === "CREATED") throw new ActionIntegrityError(`payment attempt ${attempt.id} has no HSP order yet`);
      return { status: "ALREADY_REQUESTED", attempt };
    }
    if (attempt.flowId === null) throw new ActionIntegrityError(`payment attempt ${attempt.id} has no HSP flow`);
    const stored = latestUnclaimed(db, attempt.id);
    if (stored !== undefined && Date.parse(stored.quoteExpiresAt) - input.now().getTime() >= QUOTE_MARGIN_MS) {
      const again = checkPreparedPayment(stored.raw, input.expectations(attempt), input.now());
      return again.ok ? { status: "SIGNATURE_REQUIRED", attempt, offer: again.offer, checks: again.checks } : { status: "REFUSED", attempt, checks: again.checks, reasons: again.reasons };
    }

    const raw = await input.rail.prepare(attempt.flowId, attempt.payer);
    const checked = checkPreparedPayment(raw, input.expectations(attempt), input.now());
    if (!checked.ok) return { status: "REFUSED", attempt, checks: checked.checks, reasons: checked.reasons };
    const json = JSON.stringify(raw);
    const { authorization } = checked.offer;
    immediateTransaction(db, () => {
      const current = getPaymentAttempt(db, attempt.id);
      if (current?.state !== "PREPARED") throw new ExecutionRefusedError("ATTEMPT_NOT_EXECUTABLE", `Payment attempt ${attempt.id} moved on while HSP prepared the authorization.`);
      db.prepare(
        `INSERT INTO payment_offers (id, attempt_id, offer_json, offer_sha256, authorized_base_units, authorization_nonce, valid_before, quote_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run((input.newId ?? randomUUID)(), attempt.id, json, sha256Hex(json), authorization.value, authorization.nonce, Number(authorization.validBefore), checked.offer.quoteExpiresAt, input.now().toISOString());
    });
    return { status: "SIGNATURE_REQUIRED", attempt, offer: checked.offer, checks: checked.checks };
  });
}

export type AuthorizationSubmission =
  | { status: "SUBMITTED"; attempt: PaymentAttemptRecord }
  | { status: "OUTCOME_UNKNOWN"; attempt: PaymentAttemptRecord; reason: string }
  | { status: "ALREADY_REQUESTED"; attempt: PaymentAttemptRecord };

export interface SubmitAuthorizationInput extends OfferInput {
  /** The authenticated account; it must be the attempt's payer. */
  requestedBy: string;
  signature: string;
  priceUsd: string;
  /** Runs inside the claiming transaction; see ClaimExecutionInput.onClaim. */
  onClaim?: (db: DatabaseSync, attempt: PaymentAttemptRecord) => void;
}

/**
 * The payer's signature of the current offer. The offer is checked again, so an expired quote is
 * refused before anything leaves this server, and the signature must recover to the payer over
 * exactly that offer. Then, in one transaction, the attempt's one permit is consumed and the offer
 * is marked as the claimed one; only after that does the signature go to HSP, which finalizes and
 * submits it once. Anything uncertain from then on is left to reconciliation, never retried.
 */
export async function submitAuthorization(db: DatabaseSync, input: SubmitAuthorizationInput): Promise<AuthorizationSubmission> {
  return serialized(input.attemptId, async () => {
    const attempt = requireAttempt(db, input.attemptId);
    if (attempt.state !== "PREPARED") {
      if (attempt.state === "CREATED") throw new ExecutionRefusedError("ATTEMPT_NOT_EXECUTABLE", "Request the authorization before signing it.");
      return { status: "ALREADY_REQUESTED", attempt };
    }
    const stored = latestUnclaimed(db, attempt.id);
    if (stored === undefined) throw new ExecutionRefusedError("ATTEMPT_NOT_EXECUTABLE", "Request the authorization before signing it.");
    const checked = checkPreparedPayment(stored.raw, input.expectations(attempt), input.now());
    if (!checked.ok) throw new ExecutionRefusedError("CART_REJECTED", `This authorization can no longer be submitted (${checked.reasons.join("; ")}); request a new one.`);
    const offer = checked.offer;
    if (!(await verifyEip3009Signature(offer, input.signature))) {
      throw new ExecutionRefusedError("MANDATE_SIGNATURE_INVALID", "The signature is not the payer's signature of this authorization.");
    }
    const now = input.now().toISOString();
    const claim = claimExecution(db, {
      attemptId: attempt.id,
      requestedBy: input.requestedBy,
      cart: cartFromOffer(attempt, offer, input.priceUsd),
      provenances: [input.rail.provenance],
      now,
      onClaim: (tx, current) => {
        const marked = tx.prepare("UPDATE payment_offers SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL").run(now, stored.id);
        if (marked.changes !== 1) throw new ExecutionRefusedError("PERMIT_CONSUMED", `The authorization for attempt ${attempt.id} was already claimed.`);
        input.onClaim?.(tx, current);
      },
      mandate: (_cart, current) => offerPayload(current, offer, stored.sha256),
    });
    try {
      await input.rail.submit(offer, input.signature);
      return { status: "SUBMITTED", attempt: claim.attempt };
    } catch (error) {
      const reason = isQuoteExpired(error)
        ? "HSP refused the submission as an expired quote (30043); the payment is observed until its outcome is known"
        : `the submission to HSP did not complete (${error instanceof Error ? `${error.name}: ${error.message}` : String(error)})`;
      return { status: "OUTCOME_UNKNOWN", attempt: claim.attempt, reason };
    }
  });
}

/** The amount and nonce of the authorization handed to HSP for an attempt, for reconciliation. */
export function claimedAuthorization(db: DatabaseSync, attemptId: string): { authorizedBaseUnits: string; authorizationNonce: string } | undefined {
  const row = db.prepare("SELECT authorized_base_units, authorization_nonce FROM payment_offers WHERE attempt_id = ? AND claimed_at IS NOT NULL").get(attemptId);
  return row === undefined ? undefined : { authorizedBaseUnits: String(row.authorized_base_units), authorizationNonce: String(row.authorization_nonce) };
}

/** The most recent offer for an attempt that was never claimed, as stored. */
function latestUnclaimed(db: DatabaseSync, attemptId: string): StoredOffer | undefined {
  return readTransaction(db, () => {
    const row = db.prepare("SELECT id, offer_json, offer_sha256, quote_expires_at FROM payment_offers WHERE attempt_id = ? AND claimed_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get(attemptId);
    if (row === undefined) return undefined;
    const json = String(row.offer_json);
    if (sha256Hex(json) !== String(row.offer_sha256)) throw new ActionIntegrityError(`payment offer ${String(row.id)} no longer matches its digest`);
    return { id: String(row.id), raw: JSON.parse(json) as unknown, sha256: String(row.offer_sha256), quoteExpiresAt: String(row.quote_expires_at) };
  });
}

/** The cart the permit is claimed against, from the checked offer, so the attempt must agree with what HSP prepared. */
function cartFromOffer(attempt: PaymentAttemptRecord, offer: CheckedOffer, priceUsd: string): ValidatedCart {
  if (attempt.cartMandateId === null || attempt.cartSha256 === null) throw new ActionIntegrityError(`payment attempt ${attempt.id} has no recorded cart`);
  return {
    cartMandateId: attempt.cartMandateId,
    paymentRequestId: offer.prepared.paymentRequestId,
    cartSha256: attempt.cartSha256,
    methodIndex: 0,
    payee: offer.authorization.to,
    chainId: offer.domain.chainId,
    token: offer.domain.verifyingContract,
    totalUsd: priceUsd,
    amountBaseUnits: attempt.amountBaseUnits,
    grossLimitBaseUnits: offer.authorization.value,
  };
}

function offerPayload(attempt: PaymentAttemptRecord, offer: CheckedOffer, offerSha256: string): HspOfferPayload {
  if (attempt.cartMandateId === null || attempt.paymentRequestId === null || attempt.cartSha256 === null) throw new ActionIntegrityError(`payment attempt ${attempt.id} has no prepared cart`);
  return {
    provenance: "LIVE",
    kind: "hsp-agentic-eip3009",
    cartMandateId: attempt.cartMandateId,
    cartSha256: attempt.cartSha256,
    paymentRequestId: attempt.paymentRequestId,
    payer: attempt.payer,
    payee: attempt.payee,
    chainId: attempt.chainId,
    token: attempt.token,
    amountBaseUnits: attempt.amountBaseUnits,
    nonce: offer.authorization.nonce,
    offerSha256,
    authorizedBaseUnits: offer.authorization.value,
  };
}

/** The policy a seller's single approved repayment carries: that one payee, capped at the principal plus the maximum fee. */
export function singleTransferPolicy(payee: Address, principalBaseUnits: string, maxFeeBaseUnits: string): OfferExpectations["policy"] {
  const cap = (BigInt(principalBaseUnits) + BigInt(maxFeeBaseUnits)).toString();
  return { payeeAllowlist: [payee], perPaymentCapBaseUnits: cap, dailyCapBaseUnits: cap, spentTodayBaseUnits: "0" };
}

// One step at a time per attempt within this process; the permit's transaction guards across processes.
const queues = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, step: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(step);
  queues.set(key, run);
  try {
    return await run;
  } finally {
    if (queues.get(key) === run) queues.delete(key);
  }
}

function requireAttempt(db: DatabaseSync, attemptId: string): PaymentAttemptRecord {
  const attempt = readTransaction(db, () => getPaymentAttempt(db, attemptId));
  if (attempt === undefined) throw new ExecutionRefusedError("ATTEMPT_NOT_FOUND", `Payment attempt ${attemptId} does not exist.`);
  return attempt;
}
