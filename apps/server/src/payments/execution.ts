import type { DatabaseSync } from "node:sqlite";
import {
  assertProvenanceAllowed,
  buildSimulatedPaymentMandate,
  submitPaymentMandate,
  type ExecutionPayload,
  type PaymentRail,
  type Provenance,
  type SignedPayload,
  type ValidatedCart,
} from "@settleback/adapters";
import { canonicalJson, sha256Hex, type CanonicalValue } from "@settleback/domain/hash";
import { immediateTransaction } from "../db/database.ts";
import { StoreError } from "../db/errors.ts";
import { getOperation } from "../db/operations.ts";
import { getPaymentAttempt, moveAttempt, type PaymentAttemptRecord } from "../db/payments.ts";

export type ExecutionRefusal =
  | "ATTEMPT_NOT_FOUND"
  | "ROLE_FORBIDDEN"
  | "PERMIT_CONSUMED"
  | "ATTEMPT_NOT_EXECUTABLE"
  | "CART_MISMATCH"
  | "MANDATE_FORMAT_UNAVAILABLE"
  | "MANDATE_SIGNATURE_INVALID"
  | "CART_REJECTED";

/** A payment execution refused before its permit was consumed: nothing was signed or sent. */
export class ExecutionRefusedError extends StoreError {
  constructor(code: ExecutionRefusal, message: string) {
    super(code, message);
  }
}

/** Holds the payer's key: the labeled simulator locally; a guarded signer or wallet otherwise. */
export interface PaymentSigner {
  readonly provenance: Provenance;
  sign(payload: ExecutionPayload): Promise<SignedPayload>;
}

export interface ClaimExecutionInput {
  attemptId: string;
  /** The authenticated account asking for the transfer; it must be the attempt's payer. */
  requestedBy: string;
  /** The Payment Agent's validated cart: the mandate is built from it and must match the attempt. */
  cart: ValidatedCart;
  /** Of the signer and the rail; each must be allowed in the operation's environment. */
  provenances: readonly Provenance[];
  now: string;
  /**
   * Runs inside the claiming transaction, after the attempt checks and before the permit is
   * consumed. It may refuse, which leaves the permit unused, or record what the claim means for its
   * caller atomically with it: a repayment rechecks its reservation and moves its action here.
   */
  onClaim?: (db: DatabaseSync, attempt: PaymentAttemptRecord) => void;
  /** Builds the mandate the payer signs; by default the labeled placeholder mandate. */
  mandate?: (cart: ValidatedCart, attempt: PaymentAttemptRecord) => ExecutionPayload;
}

export interface ExecutionClaim {
  attempt: PaymentAttemptRecord;
  payload: ExecutionPayload;
  paymentMandateSha256: string;
  fencingToken: number;
}

/**
 * Consumes the attempt's one execution permit and records SIGNING_REQUESTED in the same
 * transaction, before anything is signed. Only the caller that gets the claim may sign and submit;
 * every later caller is refused with PERMIT_CONSUMED, including after a lost response, so an
 * ambiguous execution freezes instead of producing a second transfer. A permit is never reissued.
 */
export function claimExecution(db: DatabaseSync, input: ClaimExecutionInput): ExecutionClaim {
  return immediateTransaction(db, () => {
    const attempt = getPaymentAttempt(db, input.attemptId);
    if (attempt === undefined) throw new ExecutionRefusedError("ATTEMPT_NOT_FOUND", `Payment attempt ${input.attemptId} does not exist.`);
    const operation = getOperation(db, attempt.operationId);
    if (operation === undefined) throw new Error(`payment attempt ${attempt.id} has no operation`);
    for (const provenance of input.provenances) assertProvenanceAllowed(operation.environment, provenance);
    if (input.requestedBy.toLowerCase() !== attempt.payer) throw new ExecutionRefusedError("ROLE_FORBIDDEN", "Only the attempt's payer can execute it.");

    const permit = db.prepare("SELECT state FROM execution_permits WHERE attempt_id = ?").get(attempt.id);
    if (permit !== undefined) {
      throw new ExecutionRefusedError(
        "PERMIT_CONSUMED",
        `The execution permit for attempt ${attempt.id} was already used (the attempt is ${attempt.state}); its outcome is reconciled from the gateway and the chain, never sent again.`,
      );
    }
    if (attempt.state !== "PREPARED") throw new ExecutionRefusedError("ATTEMPT_NOT_EXECUTABLE", `Payment attempt ${attempt.id} is ${attempt.state}; only a prepared attempt can be executed.`);
    const mismatches = cartMismatches(attempt, input.cart);
    if (mismatches.length > 0) throw new ExecutionRefusedError("CART_MISMATCH", `The cart does not match payment attempt ${attempt.id}: ${mismatches.join(", ")}.`);
    input.onClaim?.(db, attempt);

    const payload = input.mandate === undefined ? mandateFor(input.cart, attempt, input.provenances) : input.mandate(input.cart, attempt);
    const paymentMandateSha256 = mandateDigest(payload);
    const fencingToken = attempt.revision + 1;
    db.prepare("INSERT INTO execution_permits (attempt_id, fencing_token, state, issued_at, consumed_at) VALUES (?, ?, 'CONSUMED', ?, ?)").run(
      attempt.id,
      fencingToken,
      input.now,
      input.now,
    );
    const moved = moveAttempt(db, attempt, {
      to: "SIGNING_REQUESTED",
      actor: "server",
      actorLabel: `payer:${attempt.payer}`,
      eventType: "PAYMENT_SIGNING_REQUESTED",
      payloadSha256: paymentMandateSha256,
      now: input.now,
      set: { paymentMandateSha256 },
    });
    return { attempt: moved, payload, paymentMandateSha256, fencingToken };
  });
}

export interface ExecutePaymentInput extends Omit<ClaimExecutionInput, "provenances" | "now"> {
  signer: PaymentSigner;
  rail: PaymentRail;
  now: () => Date;
}

export type ExecutionOutcome =
  | { status: "SUBMITTED"; attempt: PaymentAttemptRecord; paymentMandateSha256: string }
  | { status: "OUTCOME_UNKNOWN"; attempt: PaymentAttemptRecord; paymentMandateSha256: string; reason: string };

/**
 * Claims the permit, then signs and submits the mandate exactly once. Any failure after the claim
 * leaves the attempt SIGNING_REQUESTED with its outcome unknown: it is never signed or submitted
 * again, and a new attempt cannot start while this one is live. Reconciliation observes the
 * gateway and the chain; only an operator with evidence can close an attempt that never moved.
 */
export async function executePayment(db: DatabaseSync, input: ExecutePaymentInput): Promise<ExecutionOutcome> {
  const { signer, rail, now, ...claimInput } = input;
  const claim = claimExecution(db, { ...claimInput, provenances: [signer.provenance, rail.provenance], now: now().toISOString() });
  const unknown = (reason: string): ExecutionOutcome => ({ status: "OUTCOME_UNKNOWN", attempt: claim.attempt, paymentMandateSha256: claim.paymentMandateSha256, reason });

  let signed: SignedPayload;
  try {
    signed = await signer.sign(claim.payload);
  } catch (error) {
    return unknown(`the signer returned no signature (${describe(error)})`);
  }
  try {
    const submission = await submitPaymentMandate(rail, signed);
    if (submission === "OUTCOME_UNKNOWN") return unknown("the submission response was lost and the gateway shows no payment yet");
  } catch (error) {
    return unknown(`the submission failed (${describe(error)})`);
  }
  return { status: "SUBMITTED", attempt: claim.attempt, paymentMandateSha256: claim.paymentMandateSha256 };
}

/** The digest recorded with SIGNING_REQUESTED; a mandate rebuilt later must match it exactly. */
export function mandateDigest(payload: ExecutionPayload): string {
  return sha256Hex(canonicalJson(payload as unknown as CanonicalValue));
}

function cartMismatches(attempt: PaymentAttemptRecord, cart: ValidatedCart): string[] {
  const mismatches: string[] = [];
  if (attempt.cartMandateId === null || cart.cartMandateId !== attempt.cartMandateId) mismatches.push("cart mandate ID");
  if (attempt.paymentRequestId === null || cart.paymentRequestId !== attempt.paymentRequestId) mismatches.push("payment request ID");
  if (attempt.cartSha256 === null || cart.cartSha256 !== attempt.cartSha256) mismatches.push("cart hash");
  if (cart.payee.toLowerCase() !== attempt.payee) mismatches.push("payee");
  if (cart.chainId !== attempt.chainId) mismatches.push("chain");
  if (cart.token.toLowerCase() !== attempt.token) mismatches.push("token");
  if (cart.amountBaseUnits !== attempt.amountBaseUnits) mismatches.push("amount");
  return mismatches;
}

function mandateFor(cart: ValidatedCart, attempt: PaymentAttemptRecord, provenances: readonly Provenance[]): ExecutionPayload {
  if (provenances.some((provenance) => provenance !== "SIMULATED")) {
    throw new ExecutionRefusedError("MANDATE_FORMAT_UNAVAILABLE", "The live Payment Mandate format is not published yet; only simulated payments can be executed.");
  }
  return buildSimulatedPaymentMandate(cart, attempt.payer);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
