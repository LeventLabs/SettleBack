import { describe, expect, it } from "vitest";
import {
  checkActionPreparation,
  checkExecutionRequest,
  checkFreshness,
  checkJobStart,
  checkRecoveredClosure,
  checkRefundEligibility,
  checkRepaidClosure,
  checkRepaymentTerms,
  type ActionFacts,
  type Check,
  type JobFacts,
  type OperationFacts,
  type PaymentFacts,
  type ReasonCode,
  type TransferTerms,
} from "../src/index.ts";

const BUYER = "0x00000000000000000000000000000000000000b1";
const SELLER = "0x00000000000000000000000000000000000000a1";
const TOKEN = "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6";
const DIGEST = "4b2661adfe637a7eacb81fee1f651e33c5a6eabdedb32de310e20af29c6a1a7f";
const NOW = "2026-10-30T10:00:00Z";
const LATER = "2026-10-30T12:00:00Z";

const operation: OperationFacts = {
  id: "op-1",
  buyer: BUYER,
  seller: SELLER,
  chainId: 133,
  token: TOKEN,
  amountBaseUnits: "1000000",
  policySha256: "1".repeat(64),
};

const original: PaymentFacts = {
  id: "att-1",
  operationId: "op-1",
  purpose: "ORIGINAL",
  state: "VERIFIED",
  payer: BUYER,
  payee: SELLER,
  chainId: 133,
  token: TOKEN,
  amountBaseUnits: "1000000",
};

const repayment: PaymentFacts = { ...original, id: "att-2", purpose: "REPAYMENT", payer: SELLER, payee: BUYER };

const failedJob: JobFacts = { operationId: "op-1", state: "FAILED", computeStarted: true, artifactSha256: null };

function codes(check: Check): ReasonCode[] {
  return check.ok ? [] : check.reasons.map((r) => r.code);
}

describe("checkJobStart", () => {
  it("allows work only after this operation's own original payment is verified", () => {
    expect(checkJobStart(operation, original)).toEqual({ ok: true });
    expect(codes(checkJobStart(operation, { ...original, state: "OBSERVED" }))).toEqual(["PAYMENT_NOT_VERIFIED"]);
    expect(codes(checkJobStart(operation, { ...original, state: "UNKNOWN" }))).toEqual(["PAYMENT_UNCERTAIN"]);
  });

  it("keeps the operation identity bound to its payment", () => {
    expect(codes(checkJobStart(operation, { ...original, operationId: "op-2" }))).toEqual(["OPERATION_MISMATCH"]);
    expect(codes(checkJobStart(operation, { ...original, amountBaseUnits: "999999" }))).toEqual(["AMOUNT_MISMATCH"]);
    expect(codes(checkJobStart(operation, { ...original, payee: BUYER }))).toEqual(["PAYEE_MISMATCH"]);
    expect(codes(checkJobStart(operation, repayment))).toContain("NOT_ORIGINAL_PAYMENT");
  });
});

describe("checkRefundEligibility", () => {
  const base = { rule: "TERMINAL_FAILURE_BEFORE_ARTIFACT" as const, operation, originalPayment: original, job: failedJob };

  it("permits repayment for a terminal failure before any artifact under delivery-based terms", () => {
    expect(checkRefundEligibility(base)).toEqual({ ok: true });
  });

  it("keeps started compute billable under compute-billable terms", () => {
    expect(codes(checkRefundEligibility({ ...base, rule: "FAILURE_BEFORE_COMPUTE" }))).toEqual(["COMPUTE_BILLABLE"]);
    expect(checkRefundEligibility({ ...base, rule: "FAILURE_BEFORE_COMPUTE", job: { ...failedJob, computeStarted: false } })).toEqual({
      ok: true,
    });
  });

  it("never treats a timeout, a running job, or missing evidence as a failure", () => {
    for (const state of ["NOT_STARTED", "INVOKED", "RUNNING", "COMPLETED"] as const) {
      expect(codes(checkRefundEligibility({ ...base, job: { ...failedJob, state } })), state).toEqual(["JOB_NOT_FAILED"]);
    }
    expect(codes(checkRefundEligibility({ ...base, job: { ...failedJob, state: "UNKNOWN" } }))).toEqual(["JOB_UNCERTAIN"]);
  });

  it("refuses repayment when the payment itself is uncertain", () => {
    expect(codes(checkRefundEligibility({ ...base, originalPayment: { ...original, state: "UNKNOWN" } }))).toEqual([
      "PAYMENT_UNCERTAIN",
    ]);
  });

  it("prefers recovering an existing artifact over repayment", () => {
    expect(codes(checkRefundEligibility({ ...base, job: { ...failedJob, artifactSha256: DIGEST } }))).toEqual(["ARTIFACT_EXISTS"]);
  });
});

describe("checkRepaymentTerms", () => {
  const proposal: TransferTerms = { payer: SELLER, payee: BUYER, chainId: 133, token: TOKEN, amountBaseUnits: "1000000" };

  it("requires seller-to-original-buyer on the same chain and token for exactly the principal", () => {
    expect(checkRepaymentTerms(operation, proposal)).toEqual({ ok: true });
    expect(codes(checkRepaymentTerms(operation, { ...proposal, payee: "0x00000000000000000000000000000000000000c3" }))).toEqual([
      "PAYEE_MISMATCH",
    ]);
    expect(codes(checkRepaymentTerms(operation, { ...proposal, chainId: 177 }))).toEqual(["CHAIN_MISMATCH"]);
  });

  it("rejects a fee-inclusive amount in place of the job price", () => {
    expect(codes(checkRepaymentTerms(operation, { ...proposal, amountBaseUnits: "1050000" }))).toEqual(["AMOUNT_MISMATCH"]);
    expect(codes(checkRepaymentTerms(operation, { ...proposal, amountBaseUnits: "10000000" }))).toEqual(["AMOUNT_MISMATCH"]);
  });
});

describe("checkActionPreparation", () => {
  it("allows one recovery action per case, prepared only from assessment or review", () => {
    expect(checkActionPreparation({ caseState: "ASSESSING", existingAction: false })).toEqual({ ok: true });
    expect(codes(checkActionPreparation({ caseState: "ASSESSING", existingAction: true }))).toEqual(["ACTION_EXISTS"]);
    expect(codes(checkActionPreparation({ caseState: "OPEN", existingAction: false }))).toEqual(["CASE_NOT_READY"]);
  });
});

describe("checkFreshness", () => {
  const binding = { policySha256: operation.policySha256, evidenceRevision: 3, deadline: LATER };

  it("rejects stale evidence, a changed policy, and an expired deadline", () => {
    expect(checkFreshness(binding, { policySha256: operation.policySha256, evidenceRevision: 3, now: NOW })).toEqual({ ok: true });
    expect(codes(checkFreshness(binding, { policySha256: operation.policySha256, evidenceRevision: 4, now: NOW }))).toEqual([
      "STALE_EVIDENCE",
    ]);
    expect(codes(checkFreshness(binding, { policySha256: "2".repeat(64), evidenceRevision: 3, now: NOW }))).toEqual(["POLICY_CHANGED"]);
    expect(codes(checkFreshness(binding, { policySha256: operation.policySha256, evidenceRevision: 3, now: LATER }))).toEqual(["EXPIRED"]);
  });
});

describe("checkExecutionRequest", () => {
  const action: ActionFacts = {
    kind: "REPAY",
    state: "RESERVED",
    reservationConfirmed: true,
    policySha256: operation.policySha256,
    evidenceRevision: 3,
    deadline: LATER,
  };
  const current = { policySha256: operation.policySha256, evidenceRevision: 3, now: NOW };

  it("allows a confirmed, fresh reservation with no prior repayment attempt and an unused permit", () => {
    expect(checkExecutionRequest({ action, current, repaymentAttempts: [], permit: { state: "ISSUED" } })).toEqual({ ok: true });
  });

  it("blocks a second transfer while any repayment attempt is live, unknown, or settled", () => {
    for (const state of ["CREATED", "SIGNING_REQUESTED", "SUBMITTED", "UNKNOWN", "VERIFIED"] as const) {
      expect(codes(checkExecutionRequest({ action, current, repaymentAttempts: [{ ...repayment, state }], permit: undefined })), state).toEqual([
        "ATTEMPT_IN_FLIGHT",
      ]);
    }
    expect(checkExecutionRequest({ action, current, repaymentAttempts: [{ ...repayment, state: "REJECTED_NO_SEND" }], permit: undefined })).toEqual({
      ok: true,
    });
  });

  it("refuses an unconfirmed or unreserved action, a stale binding, and a consumed permit", () => {
    expect(codes(checkExecutionRequest({ action: { ...action, reservationConfirmed: false }, current, repaymentAttempts: [], permit: undefined }))).toEqual([
      "RESERVATION_UNCONFIRMED",
    ]);
    expect(codes(checkExecutionRequest({ action: { ...action, state: "PREPARED" }, current, repaymentAttempts: [], permit: undefined }))).toEqual([
      "NOT_RESERVED",
    ]);
    expect(codes(checkExecutionRequest({ action, current: { ...current, evidenceRevision: 4 }, repaymentAttempts: [], permit: undefined }))).toEqual([
      "STALE_EVIDENCE",
    ]);
    expect(codes(checkExecutionRequest({ action, current, repaymentAttempts: [], permit: { state: "CONSUMED" } }))).toEqual(["PERMIT_CONSUMED"]);
  });
});

describe("terminal outcomes require their evidence", () => {
  it("closes REPAID only with a verified principal repayment, an allocated proof, and a confirmed record", () => {
    const ready = { operation, actionKind: "REPAY" as const, repayment, proofAllocated: true, registryConfirmed: true };
    expect(checkRepaidClosure(ready)).toEqual({ ok: true });
    expect(codes(checkRepaidClosure({ ...ready, registryConfirmed: false }))).toEqual(["RECORD_NOT_CONFIRMED"]);
    expect(codes(checkRepaidClosure({ ...ready, proofAllocated: false }))).toEqual(["PROOF_NOT_ALLOCATED"]);
    expect(codes(checkRepaidClosure({ ...ready, repayment: { ...repayment, state: "UNKNOWN" } }))).toEqual(["PAYMENT_NOT_VERIFIED"]);
    expect(codes(checkRepaidClosure({ ...ready, repayment: { ...repayment, amountBaseUnits: "1050000" } }))).toEqual(["AMOUNT_MISMATCH"]);
    expect(codes(checkRepaidClosure({ ...ready, actionKind: "RETRIEVE" }))).toEqual(["WRONG_ACTION_KIND"]);
  });

  it("closes RECOVERED only when the buyer acknowledged the stored artifact digest and the record is confirmed", () => {
    const completed: JobFacts = { operationId: "op-1", state: "COMPLETED", computeStarted: true, artifactSha256: DIGEST };
    const ready = { actionKind: "RETRIEVE" as const, job: completed, acknowledgedSha256: DIGEST, registryConfirmed: true };
    expect(checkRecoveredClosure(ready)).toEqual({ ok: true });
    expect(codes(checkRecoveredClosure({ ...ready, acknowledgedSha256: "0".repeat(64) }))).toEqual(["DIGEST_MISMATCH"]);
    expect(codes(checkRecoveredClosure({ ...ready, acknowledgedSha256: null }))).toEqual(["DIGEST_MISMATCH"]);
    expect(codes(checkRecoveredClosure({ ...ready, job: failedJob }))).toEqual(["JOB_NOT_COMPLETED"]);
    expect(codes(checkRecoveredClosure({ ...ready, registryConfirmed: false }))).toEqual(["RECORD_NOT_CONFIRMED"]);
  });
});
