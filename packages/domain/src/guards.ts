import type { Address } from "./operation.ts";
import type { PaymentAttemptState, RecoveryActionState, ServiceJobState } from "./states.ts";

// Pure, deterministic checks that gate state transitions. None of them accept model output:
// a recommendation or confidence score is not an input to any decision about money.

export type ReasonCode =
  | "OPERATION_MISMATCH"
  | "NOT_ORIGINAL_PAYMENT"
  | "NOT_REPAYMENT"
  | "PAYMENT_NOT_VERIFIED"
  | "PAYMENT_UNCERTAIN"
  | "PAYER_MISMATCH"
  | "PAYEE_MISMATCH"
  | "CHAIN_MISMATCH"
  | "TOKEN_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "JOB_NOT_FAILED"
  | "JOB_UNCERTAIN"
  | "ARTIFACT_EXISTS"
  | "COMPUTE_BILLABLE"
  | "ACTION_EXISTS"
  | "CASE_NOT_READY"
  | "POLICY_CHANGED"
  | "STALE_EVIDENCE"
  | "EXPIRED"
  | "NOT_RESERVED"
  | "RESERVATION_UNCONFIRMED"
  | "ATTEMPT_IN_FLIGHT"
  | "PERMIT_CONSUMED"
  | "WRONG_ACTION_KIND"
  | "PROOF_NOT_ALLOCATED"
  | "RECORD_NOT_CONFIRMED"
  | "JOB_NOT_COMPLETED"
  | "DIGEST_MISMATCH";

export interface Reason {
  code: ReasonCode;
  message: string;
}

export type Check = { ok: true } | { ok: false; reasons: Reason[] };

export interface OperationFacts {
  id: string;
  buyer: Address;
  seller: Address;
  chainId: number;
  token: Address;
  /** Principal job price in token base units; fees are never part of it. */
  amountBaseUnits: string;
  policySha256: string;
}

export interface PaymentFacts {
  id: string;
  operationId: string;
  purpose: "ORIGINAL" | "REPAYMENT";
  state: PaymentAttemptState;
  payer: Address;
  payee: Address;
  chainId: number;
  token: Address;
  amountBaseUnits: string;
}

export interface JobFacts {
  operationId: string;
  state: ServiceJobState;
  computeStarted: boolean;
  artifactSha256: string | null;
}

/** How the bound service terms decide refundability; see the fixture policies. */
export type RefundRule = "TERMINAL_FAILURE_BEFORE_ARTIFACT" | "FAILURE_BEFORE_COMPUTE";

export interface TransferTerms {
  payer: Address;
  payee: Address;
  chainId: number;
  token: Address;
  amountBaseUnits: string;
}

const LIVE_OR_SETTLED: readonly PaymentAttemptState[] = [
  "CREATED",
  "PREPARED",
  "SIGNING_REQUESTED",
  "SUBMITTED",
  "OBSERVED",
  "UNKNOWN",
  "VERIFIED",
];

function result(reasons: Reason[]): Check {
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

function reason(code: ReasonCode, message: string): Reason {
  return { code, message };
}

/** The original payment must belong to this operation and match its intent exactly. */
function originalPaymentReasons(operation: OperationFacts, payment: PaymentFacts): Reason[] {
  const reasons: Reason[] = [];
  if (payment.operationId !== operation.id) reasons.push(reason("OPERATION_MISMATCH", "payment belongs to another operation"));
  if (payment.purpose !== "ORIGINAL") reasons.push(reason("NOT_ORIGINAL_PAYMENT", "payment is not the original purchase"));
  reasons.push(
    ...termsReasons(
      { payer: operation.buyer, payee: operation.seller, chainId: operation.chainId, token: operation.token, amountBaseUnits: operation.amountBaseUnits },
      payment,
    ),
  );
  if (payment.state === "UNKNOWN") {
    reasons.push(reason("PAYMENT_UNCERTAIN", "original payment outcome is unknown and must be reconciled first"));
  } else if (payment.state !== "VERIFIED") {
    reasons.push(reason("PAYMENT_NOT_VERIFIED", `original payment is ${payment.state}, not VERIFIED`));
  }
  return reasons;
}

function termsReasons(expected: TransferTerms, actual: TransferTerms): Reason[] {
  const reasons: Reason[] = [];
  if (actual.payer !== expected.payer) reasons.push(reason("PAYER_MISMATCH", `payer must be ${expected.payer}`));
  if (actual.payee !== expected.payee) reasons.push(reason("PAYEE_MISMATCH", `payee must be ${expected.payee}`));
  if (actual.chainId !== expected.chainId) reasons.push(reason("CHAIN_MISMATCH", `chain must be ${expected.chainId}`));
  if (actual.token !== expected.token) reasons.push(reason("TOKEN_MISMATCH", `token must be ${expected.token}`));
  if (actual.amountBaseUnits !== expected.amountBaseUnits) {
    reasons.push(reason("AMOUNT_MISMATCH", `amount must be exactly ${expected.amountBaseUnits} base units`));
  }
  return reasons;
}

/** Work starts only after the operation's own original payment is verified. */
export function checkJobStart(operation: OperationFacts, originalPayment: PaymentFacts): Check {
  return result(originalPaymentReasons(operation, originalPayment));
}

/**
 * Refund eligibility from deterministic facts only. A timeout, a non-terminal job, or an unknown
 * payment is never eligible; missing evidence is not evidence of failure.
 */
export function checkRefundEligibility(input: {
  rule: RefundRule;
  operation: OperationFacts;
  originalPayment: PaymentFacts;
  job: JobFacts;
}): Check {
  const { rule, operation, originalPayment, job } = input;
  const reasons = originalPaymentReasons(operation, originalPayment);
  if (job.operationId !== operation.id) reasons.push(reason("OPERATION_MISMATCH", "job belongs to another operation"));

  if (job.state === "UNKNOWN") {
    reasons.push(reason("JOB_UNCERTAIN", "job outcome is unknown"));
  } else if (job.state !== "FAILED") {
    reasons.push(reason("JOB_NOT_FAILED", `job is ${job.state}, not a terminal failure`));
  } else {
    if (job.artifactSha256 !== null) reasons.push(reason("ARTIFACT_EXISTS", "a result artifact exists; recover it instead"));
    if (rule === "FAILURE_BEFORE_COMPUTE" && job.computeStarted) {
      reasons.push(reason("COMPUTE_BILLABLE", "the terms keep started compute billable"));
    }
  }
  return result(reasons);
}

/** A repayment goes from the original seller to the original buyer, on the same chain and token, for the principal. */
export function checkRepaymentTerms(operation: OperationFacts, proposal: TransferTerms): Check {
  return result(
    termsReasons(
      { payer: operation.seller, payee: operation.buyer, chainId: operation.chainId, token: operation.token, amountBaseUnits: operation.amountBaseUnits },
      proposal,
    ),
  );
}

export function checkActionPreparation(input: { caseState: string; existingAction: boolean }): Check {
  const reasons: Reason[] = [];
  if (input.existingAction) reasons.push(reason("ACTION_EXISTS", "this case already has a recovery action"));
  if (input.caseState !== "ASSESSING" && input.caseState !== "REVIEW_REQUIRED") {
    reasons.push(reason("CASE_NOT_READY", `case is ${input.caseState}`));
  }
  return result(reasons);
}

export interface Binding {
  policySha256: string;
  evidenceRevision: number;
  deadline: string;
}

export interface CurrentState {
  policySha256: string;
  evidenceRevision: number;
  now: string;
}

/** An approval or reservation is bound to the policy, the evidence revision it saw, and a deadline. */
export function checkFreshness(binding: Binding, current: CurrentState): Check {
  const reasons: Reason[] = [];
  if (binding.policySha256 !== current.policySha256) reasons.push(reason("POLICY_CHANGED", "bound policy differs from the operation's policy"));
  if (binding.evidenceRevision !== current.evidenceRevision) {
    reasons.push(reason("STALE_EVIDENCE", `bound to evidence revision ${binding.evidenceRevision}, current is ${current.evidenceRevision}`));
  }
  if (!(Date.parse(current.now) < Date.parse(binding.deadline))) reasons.push(reason("EXPIRED", `deadline ${binding.deadline} has passed`));
  return result(reasons);
}

export interface ActionFacts extends Binding {
  kind: "RETRIEVE" | "REPAY";
  state: RecoveryActionState;
  reservationConfirmed: boolean;
}

/**
 * Last check before anything payment-producing is issued. For repayments, any existing repayment
 * attempt that is live, unknown, or already settled blocks a new one.
 */
export function checkExecutionRequest(input: {
  action: ActionFacts;
  current: CurrentState;
  repaymentAttempts: PaymentFacts[];
  permit: { state: "ISSUED" | "CONSUMED" } | undefined;
}): Check {
  const { action, current, repaymentAttempts, permit } = input;
  const reasons: Reason[] = [];
  if (action.state !== "RESERVED") reasons.push(reason("NOT_RESERVED", `action is ${action.state}, not RESERVED`));
  if (!action.reservationConfirmed) reasons.push(reason("RESERVATION_UNCONFIRMED", "registry reservation is not confirmed"));
  const freshness = checkFreshness(action, current);
  if (!freshness.ok) reasons.push(...freshness.reasons);
  if (action.kind === "REPAY") {
    for (const attempt of repaymentAttempts) {
      if (attempt.purpose !== "REPAYMENT") reasons.push(reason("NOT_REPAYMENT", `attempt ${attempt.id} is not a repayment`));
      else if (LIVE_OR_SETTLED.includes(attempt.state)) {
        reasons.push(reason("ATTEMPT_IN_FLIGHT", `repayment attempt ${attempt.id} is ${attempt.state}`));
      }
    }
    if (permit?.state === "CONSUMED") reasons.push(reason("PERMIT_CONSUMED", "the execution permit was already used"));
  }
  return result(reasons);
}

/**
 * A case may show a terminal business outcome only with the evidence for it. When settlement or
 * delivery is proven but the registry outcome is not yet confirmed, the case is RECORD_PENDING.
 */
export function checkRepaidClosure(input: {
  operation: OperationFacts;
  actionKind: "RETRIEVE" | "REPAY";
  repayment: PaymentFacts | undefined;
  proofAllocated: boolean;
  registryConfirmed: boolean;
}): Check {
  const reasons: Reason[] = [];
  if (input.actionKind !== "REPAY") reasons.push(reason("WRONG_ACTION_KIND", "only a repayment action can close as REPAID"));
  if (input.repayment === undefined) {
    reasons.push(reason("PAYMENT_NOT_VERIFIED", "no repayment attempt"));
  } else {
    if (input.repayment.purpose !== "REPAYMENT") reasons.push(reason("NOT_REPAYMENT", "attempt is not a repayment"));
    if (input.repayment.operationId !== input.operation.id) reasons.push(reason("OPERATION_MISMATCH", "repayment belongs to another operation"));
    if (input.repayment.state !== "VERIFIED") reasons.push(reason("PAYMENT_NOT_VERIFIED", `repayment is ${input.repayment.state}`));
    const terms = checkRepaymentTerms(input.operation, input.repayment);
    if (!terms.ok) reasons.push(...terms.reasons);
  }
  if (!input.proofAllocated) reasons.push(reason("PROOF_NOT_ALLOCATED", "repayment proof is not allocated"));
  if (!input.registryConfirmed) reasons.push(reason("RECORD_NOT_CONFIRMED", "registry outcome is not confirmed"));
  return result(reasons);
}

export function checkRecoveredClosure(input: {
  actionKind: "RETRIEVE" | "REPAY";
  job: JobFacts;
  acknowledgedSha256: string | null;
  registryConfirmed: boolean;
}): Check {
  const reasons: Reason[] = [];
  if (input.actionKind !== "RETRIEVE") reasons.push(reason("WRONG_ACTION_KIND", "only a retrieval action can close as RECOVERED"));
  if (input.job.state !== "COMPLETED" || input.job.artifactSha256 === null) {
    reasons.push(reason("JOB_NOT_COMPLETED", "no completed artifact"));
  } else if (input.acknowledgedSha256 !== input.job.artifactSha256) {
    reasons.push(reason("DIGEST_MISMATCH", "buyer acknowledgement does not match the stored artifact digest"));
  }
  if (!input.registryConfirmed) reasons.push(reason("RECORD_NOT_CONFIRMED", "registry outcome is not confirmed"));
  return result(reasons);
}
