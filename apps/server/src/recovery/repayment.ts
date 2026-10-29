import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  RegistryOutcomeUnknownError,
  RegistryRevertError,
  assertProvenanceAllowed,
  validateCartMandate,
  type Ap2MandatePayload,
  type PaymentRail,
  type PinnedMerchant,
  type RegistryCase,
  type RegistryGateway,
  type RegistryWrite,
  type ValidatedCart,
} from "@settleback/adapters";
import { REPAYMENT_EVIDENCE_SCHEMA, repaymentEvidenceSha256, type TransferTerms } from "@settleback/domain";
import { getRecoveryAction, getRecoveryActionForCase, moveRecoveryAction, type RecoveryActionRecord } from "../db/actions.ts";
import { readCaseEvidence } from "../db/cases.ts";
import { immediateTransaction, readTransaction } from "../db/database.ts";
import { ActionIntegrityError, RecoveryRefusedError } from "../db/errors.ts";
import { appendEvent } from "../db/events.ts";
import { getOperation, type OperationRecord } from "../db/operations.ts";
import { getPaymentAttempt, type PaymentAttemptRecord } from "../db/payments.ts";
import { insertProofAllocation } from "../db/proofs.ts";
import { ExecutionRefusedError, claimExecution, executePayment, mandateDigest, type PaymentSigner } from "../payments/execution.ts";
import { markPrepared } from "../payments/quote.ts";
import { attemptMandate, cartExpiryOf, submitWalletSignature } from "../payments/wallet-signing.ts";
import { freshness, moveCase, registrationTerms, requireRegistry, termsMismatch } from "./actions.ts";
import type { OutcomeRecording } from "./retrieval.ts";

/** How a repayment is paid: the rail, the payer's signer, and what the seller's Payment Agent accepts. */
export interface RepaymentPayments {
  rail: PaymentRail;
  signer: PaymentSigner;
  /** The receiving agent whose Cart Mandate the seller's Payment Agent accepts for a repayment. */
  merchant: PinnedMerchant;
  /** Identifies this application deployment in payment references. */
  deploymentId: string;
  /** Token symbol as the gateway lists it. */
  coin: string;
  /** The most the seller pays in fees on top of the principal. */
  maxFeeBaseUnits: string;
}

export interface RequestRepaymentInput {
  caseId: string;
  /** The authenticated account asking; for a per-case repayment it must be the seller. */
  requestedBy: string;
  registry: RegistryGateway | undefined;
  payments: RepaymentPayments;
  now: () => Date;
  newId?: () => string;
}

export type RepaymentRequest =
  | { status: "SUBMITTED"; action: RecoveryActionRecord; attempt: PaymentAttemptRecord }
  | { status: "OUTCOME_UNKNOWN"; action: RecoveryActionRecord; attempt: PaymentAttemptRecord; reason: string }
  | { status: "ALREADY_REQUESTED"; action: RecoveryActionRecord; attempt: PaymentAttemptRecord | undefined };

const REQUESTED: readonly RecoveryActionRecord["state"][] = ["EXECUTION_REQUESTED", "VERIFIED", "RECORD_PENDING", "COMPLETED"];
const LIVE_ATTEMPT = "purpose = 'REPAYMENT' AND state NOT IN ('REJECTED_NO_SEND', 'FAILED')";

interface StagedRepayment {
  action: RecoveryActionRecord;
  operation: OperationRecord;
  transfer: TransferTerms;
  attempt: PaymentAttemptRecord;
  cart: ValidatedCart;
}

/**
 * Everything before the permit: the reservation must be current in the database and on the
 * registry; the attempt and its gateway identifiers are stored before the order is created; and the
 * seller's Payment Agent checks the Cart Mandate against the proposal's transfer. A repayment
 * already requested is returned as such.
 */
async function stageRepayment(db: DatabaseSync, input: RequestRepaymentInput): Promise<StagedRepayment | { already: RecoveryActionRecord; attempt: PaymentAttemptRecord | undefined }> {
  const newId = input.newId ?? randomUUID;
  const read = readTransaction(db, () => {
    const action = getRecoveryActionForCase(db, input.caseId);
    if (action === undefined) throw new RecoveryRefusedError("ACTION_NOT_FOUND", `Case ${input.caseId} has no recovery action.`);
    if (action.action !== "REPAY") throw new RecoveryRefusedError("WRONG_ACTION_STATE", "Only a repayment is paid.");
    const operation = requireOperation(db, action);
    if (input.requestedBy.toLowerCase() !== operation.seller) throw new RecoveryRefusedError("ROLE_FORBIDDEN", "Only the seller pays a repayment from its own account.");
    const registry = requireRegistry(input.registry, action.proposal);
    if (REQUESTED.includes(action.state)) return { kind: "already" as const, action, attempt: liveAttempt(db, action) };
    if (action.state !== "RESERVED") throw new RecoveryRefusedError("WRONG_ACTION_STATE", `The repayment is ${action.state}; it can be paid only once reserved.`);
    if (action.authorizationMode !== "PER_CASE") {
      throw new RecoveryRefusedError("NOT_EXECUTABLE", "A standing-policy repayment is paid by the seller's guarded signer, which is not connected.");
    }
    assertExecutable(db, action, input.now());
    return { kind: "ready" as const, action, operation, registry, transfer: requireTransfer(action) };
  });
  if (read.kind === "already") return { already: read.action, attempt: read.attempt };
  const { action, operation, registry, transfer } = read;
  const { payments } = input;
  assertProvenanceAllowed(operation.environment, payments.rail.provenance);
  await assertReservedOnChain(registry, action);

  const attempt = immediateTransaction(db, () => {
    const existing = liveAttempt(db, action);
    if (existing !== undefined) return existing;
    const id = newId();
    const createdAt = input.now().toISOString();
    db.prepare(
      `INSERT INTO payment_attempts (id, operation_id, purpose, state, payer, payee, chain_id, token, amount_base_units,
         intent_sha256, deployment_id, cart_mandate_id, payment_request_id, created_at, updated_at)
       VALUES (?, ?, 'REPAYMENT', 'CREATED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      operation.id,
      transfer.payer,
      transfer.payee,
      transfer.chainId,
      transfer.token,
      transfer.amountBaseUnits,
      action.actionSha256,
      payments.deploymentId,
      `cart-${id}`,
      `pr-${id}`,
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
      payloadSha256: action.actionSha256,
      createdAt,
    });
    const created = getPaymentAttempt(db, id);
    if (created === undefined) throw new Error(`payment attempt ${id} was not stored`);
    return created;
  });
  if (attempt.state !== "CREATED" && attempt.state !== "PREPARED") return readTransaction(db, () => ({ already: reread(db, action.id), attempt: liveAttempt(db, action) }));
  if (attempt.cartMandateId === null || attempt.paymentRequestId === null) throw new ActionIntegrityError(`repayment attempt ${attempt.id} has no gateway identifiers`);

  const prepared = await payments.rail.prepare({
    cartMandateId: attempt.cartMandateId,
    paymentRequestId: attempt.paymentRequestId,
    payee: transfer.payee,
    chainId: transfer.chainId,
    token: transfer.token,
    coin: payments.coin,
    tokenDecimals: operation.tokenDecimals,
    priceUsd: operation.priceUsd,
    label: "SettleBack repayment",
    expiresAt: cartExpiryOf(attempt),
  });
  markPrepared(db, attempt.id, prepared, input.now().toISOString());

  const fee = BigInt(payments.maxFeeBaseUnits);
  const cap = (BigInt(transfer.amountBaseUnits) + fee).toString();
  const validation = validateCartMandate({
    cartMandate: prepared.cartMandate,
    merchant: payments.merchant,
    intent: {
      cartMandateId: attempt.cartMandateId,
      paymentRequestId: attempt.paymentRequestId,
      payee: transfer.payee,
      chainId: transfer.chainId,
      token: transfer.token,
      tokenDecimals: operation.tokenDecimals,
      priceUsd: operation.priceUsd,
    },
    // The seller approved this one transfer; the registry, not this cap, accounts for its exposure.
    policy: { payeeAllowlist: [transfer.payee], perPaymentCapBaseUnits: cap, dailyCapBaseUnits: cap, spentTodayBaseUnits: "0", maxFeeBaseUnits: payments.maxFeeBaseUnits, usdRate: "1" },
    now: input.now(),
  });
  if (!validation.ok) throw new RecoveryRefusedError("CART_REJECTED", `The repayment cart was rejected: ${validation.rejections.map((entry) => entry.message).join("; ")}.`);
  return { action, operation, transfer, attempt, cart: validation.cart };
}

/**
 * Inside the claiming transaction: the reservation must still be current and the case still
 * RESERVED, and the action and case move to EXECUTION_REQUESTED together with the permit.
 */
function claimReservation(action: RecoveryActionRecord, operation: OperationRecord, now: () => Date): (tx: DatabaseSync) => void {
  return (tx) => {
    const current = getRecoveryAction(tx, action.id);
    if (current === undefined || current.state !== "RESERVED") throw new RecoveryRefusedError("WRONG_ACTION_STATE", "The repayment is no longer reserved.");
    const at = now();
    assertExecutable(tx, current, at);
    const label = `seller:${operation.seller}`;
    moveRecoveryAction(tx, current, { to: "EXECUTION_REQUESTED", actor: "server", actorLabel: label, eventType: "RECOVERY_REPAYMENT_REQUESTED", now: at.toISOString() });
    moveCase(tx, readCaseEvidence(tx, current.caseId).case, "EXECUTION_REQUESTED", { actor: "server" }, label, "CASE_EXECUTION_REQUESTED", at.toISOString(), {});
  };
}

/**
 * Pays a reserved per-case repayment with a server-side signer: a new transfer from the seller to
 * the buyer who paid, on the original chain and token, for the principal, as an agent-to-agent
 * payment in the opposite direction. The deadline and evidence are checked again inside the
 * transaction that consumes the one execution permit. A repeated request returns the repayment
 * already under way, never a second one.
 */
export async function requestRepayment(db: DatabaseSync, input: RequestRepaymentInput): Promise<RepaymentRequest> {
  const staged = await stageRepayment(db, input);
  if ("already" in staged) return { status: "ALREADY_REQUESTED", action: staged.already, attempt: staged.attempt };
  const { action, operation, transfer, attempt, cart } = staged;
  try {
    const outcome = await executePayment(db, {
      attemptId: attempt.id,
      requestedBy: transfer.payer,
      cart,
      signer: input.payments.signer,
      rail: input.payments.rail,
      now: input.now,
      onClaim: claimReservation(action, operation, input.now),
    });
    const after = reread(db, action.id);
    return outcome.status === "SUBMITTED"
      ? { status: "SUBMITTED", action: after, attempt: outcome.attempt }
      : { status: "OUTCOME_UNKNOWN", action: after, attempt: outcome.attempt, reason: outcome.reason };
  } catch (error) {
    // A concurrent request consumed the permit first: that one repayment is the answer.
    if (error instanceof ExecutionRefusedError && error.code === "PERMIT_CONSUMED") return alreadyRequested(db, action.id);
    throw error;
  }
}

export type RepaymentSignatureRequest =
  | { status: "SIGNATURE_REQUIRED"; action: RecoveryActionRecord; attempt: PaymentAttemptRecord; payload: Ap2MandatePayload }
  | { status: "ALREADY_REQUESTED"; action: RecoveryActionRecord; attempt: PaymentAttemptRecord | undefined };

/**
 * The first step when the seller signs in its own wallet. The permit is consumed and the action
 * moves to EXECUTION_REQUESTED, as for a server-side signer, and the seller receives the AP2 Payment
 * Mandate with its EIP-3009 authorization to sign. Until a signature is submitted the same mandate
 * is offered again, rebuilt from the attempt and checked against the digest recorded with the
 * permit; its nonce lets the token execute it at most once, so offering it again cannot pay twice.
 */
export async function requestRepaymentSignature(db: DatabaseSync, input: RequestRepaymentInput): Promise<RepaymentSignatureRequest> {
  const pending = awaitingSignature(db, input);
  if (pending !== undefined) return pending;
  const staged = await stageRepayment(db, input);
  if ("already" in staged) return awaitingSignature(db, input) ?? { status: "ALREADY_REQUESTED", action: staged.already, attempt: staged.attempt };
  const { action, operation, transfer, attempt, cart } = staged;
  const merchantName = input.payments.merchant.merchantName;
  const provenance = input.payments.rail.provenance;
  try {
    const claim = claimExecution(db, {
      attemptId: attempt.id,
      requestedBy: transfer.payer,
      cart,
      provenances: [provenance],
      now: input.now().toISOString(),
      onClaim: claimReservation(action, operation, input.now),
      mandate: (_cart, current) => attemptMandate(current, operation.priceUsd, merchantName, provenance),
    });
    if (claim.payload.kind !== "ap2-eip3009") throw new Error("expected an AP2 mandate");
    return { status: "SIGNATURE_REQUIRED", action: reread(db, action.id), attempt: claim.attempt, payload: claim.payload };
  } catch (error) {
    if (error instanceof ExecutionRefusedError && error.code === "PERMIT_CONSUMED") return awaitingSignature(db, input) ?? alreadyRequested(db, action.id);
    throw error;
  }
}

export type RepaymentSubmission =
  | { status: "SUBMITTED"; action: RecoveryActionRecord; attempt: PaymentAttemptRecord }
  | { status: "OUTCOME_UNKNOWN"; action: RecoveryActionRecord; attempt: PaymentAttemptRecord; reason: string }
  | { status: "ALREADY_REQUESTED"; action: RecoveryActionRecord; attempt: PaymentAttemptRecord | undefined };

/**
 * The second step: the seller's EIP-712 signature of the mandate's authorization. It is accepted
 * only if it is the payer's signature of exactly the mandate recorded with the permit, and is then
 * submitted to the gateway. A lost response may be followed by the same signature again; the token
 * executes the authorization's nonce at most once, and reconciliation settles what happened.
 */
export async function submitRepaymentSignature(
  db: DatabaseSync,
  input: { caseId: string; requestedBy: string; signature: string; registry: RegistryGateway | undefined; payments: RepaymentPayments; now: () => Date },
): Promise<RepaymentSubmission> {
  const read = readTransaction(db, () => {
    const action = getRecoveryActionForCase(db, input.caseId);
    if (action === undefined) throw new RecoveryRefusedError("ACTION_NOT_FOUND", `Case ${input.caseId} has no recovery action.`);
    if (action.action !== "REPAY") throw new RecoveryRefusedError("WRONG_ACTION_STATE", "Only a repayment is paid.");
    const operation = requireOperation(db, action);
    if (input.requestedBy.toLowerCase() !== operation.seller) throw new RecoveryRefusedError("ROLE_FORBIDDEN", "Only the seller pays a repayment from its own account.");
    requireRegistry(input.registry, action.proposal);
    const attempt = liveAttempt(db, action);
    return { action, operation, attempt };
  });
  const { action, operation, attempt } = read;
  if (attempt === undefined || action.state === "RESERVED" || action.state === "PREPARED") {
    throw new RecoveryRefusedError("WRONG_ACTION_STATE", "Request the repayment mandate before signing it.");
  }
  if (attempt.state !== "SIGNING_REQUESTED") return { status: "ALREADY_REQUESTED", action, attempt };
  const payload = attemptMandate(attempt, operation.priceUsd, input.payments.merchant.merchantName, input.payments.rail.provenance);
  const outcome = await submitWalletSignature(attempt, payload, input.signature, input.payments.rail);
  // Refused because another submission of the same authorization got there first: that is the repayment.
  if (outcome.status === "ALREADY_REQUESTED") return alreadyRequested(db, action.id);
  const after = reread(db, action.id);
  return outcome.status === "SUBMITTED" ? { status: "SUBMITTED", action: after, attempt } : { status: "OUTCOME_UNKNOWN", action: after, attempt, reason: outcome.reason };
}

/** A repayment whose permit is consumed but whose signature has not been submitted: offer the same mandate again. */
function awaitingSignature(db: DatabaseSync, input: RequestRepaymentInput): RepaymentSignatureRequest | undefined {
  const found = readTransaction(db, () => {
    const action = getRecoveryActionForCase(db, input.caseId);
    if (action === undefined || action.action !== "REPAY" || action.state !== "EXECUTION_REQUESTED") return undefined;
    const operation = requireOperation(db, action);
    if (input.requestedBy.toLowerCase() !== operation.seller) throw new RecoveryRefusedError("ROLE_FORBIDDEN", "Only the seller pays a repayment from its own account.");
    const attempt = liveAttempt(db, action);
    return attempt?.state === "SIGNING_REQUESTED" ? { action, operation, attempt } : undefined;
  });
  if (found === undefined) return undefined;
  const payload = attemptMandate(found.attempt, found.operation.priceUsd, input.payments.merchant.merchantName, input.payments.rail.provenance);
  if (mandateDigest(payload) !== found.attempt.paymentMandateSha256) {
    // A mandate of another kind (for example a server-side signer's) was claimed; it is not offered to a wallet.
    return { status: "ALREADY_REQUESTED", action: found.action, attempt: found.attempt };
  }
  return { status: "SIGNATURE_REQUIRED", action: found.action, attempt: found.attempt, payload };
}


/**
 * Closes a repayment once the transfer is settled. A verified, final transfer is bound to this
 * action as its repayment proof (refused if the same transaction is bound anywhere else), then the
 * verifier records REPAID on the registry with the transaction and the evidence digest. The chain is
 * read first and decides after a lost receipt or a concurrent write. A transfer that is verified
 * but not yet recorded stays RECORD_PENDING, and the next pass retries the record, never the payment.
 */
export async function completeRepayment(db: DatabaseSync, input: { actionId: string; registry: RegistryGateway | undefined; now: () => Date }): Promise<OutcomeRecording> {
  const read = readTransaction(db, () => {
    const action = getRecoveryAction(db, input.actionId);
    if (action === undefined) throw new RecoveryRefusedError("ACTION_NOT_FOUND", `Recovery action ${input.actionId} does not exist.`);
    if (action.action !== "REPAY") throw new RecoveryRefusedError("WRONG_ACTION_STATE", "Only a repayment is completed by a transfer.");
    const registry = requireRegistry(input.registry, action.proposal);
    if (action.state === "COMPLETED") return { done: action };
    if (action.state !== "EXECUTION_REQUESTED" && action.state !== "VERIFIED" && action.state !== "RECORD_PENDING") {
      throw new RecoveryRefusedError("WRONG_ACTION_STATE", `The repayment is ${action.state}; it has no transfer to record.`);
    }
    const attempt = liveAttempt(db, action);
    if (attempt === undefined) throw new ActionIntegrityError(`repayment ${action.id} is ${action.state} without a payment attempt`);
    if (readCaseEvidence(db, action.caseId).case.status === "QUARANTINED") throw new RecoveryRefusedError("CASE_NOT_READY", `Case ${action.caseId} is quarantined; nothing is recorded.`);
    return { action, attempt, registry };
  });
  if ("done" in read) return { status: "RECORDED", action: read.done };
  const { registry, attempt } = read;
  let action = read.action;

  if (action.state === "EXECUTION_REQUESTED") {
    if (attempt.state !== "VERIFIED" || attempt.txHash === null) return { status: "PENDING", action, reason: `the repayment transfer is ${attempt.state}, not verified` };
    const txHash = attempt.txHash;
    action = immediateTransaction(db, () => {
      const current = reread(db, action.id);
      if (current.state !== "EXECUTION_REQUESTED") return current;
      const at = input.now().toISOString();
      const evidenceRef = `payment:${attempt.id}:${txHash}`;
      insertProofAllocation(db, {
        deploymentId: attempt.deploymentId,
        chainId: attempt.chainId,
        proofId: txHash,
        proofType: "REPAYMENT",
        operationId: attempt.operationId,
        actionId: current.id,
        actor: "reconciler",
        now: at,
      });
      moveRecoveryAction(db, current, { to: "VERIFIED", actor: "reconciler", actorLabel: "reconciler", evidenceRef, eventType: "RECOVERY_REPAYMENT_VERIFIED", now: at });
      moveCase(db, readCaseEvidence(db, current.caseId).case, "VERIFIED", { actor: "reconciler", evidenceRef }, "reconciler", "CASE_REPAYMENT_VERIFIED", at, {});
      return reread(db, current.id);
    });
  }
  const txHash = attempt.txHash;
  if (txHash === null) throw new ActionIntegrityError(`repayment ${action.id} is ${action.state} without a verified transaction`);

  const caseKey = action.proposal.caseKey;
  const evidence = repaymentEvidence(action, attempt, txHash);
  let onChain = await registry.readCase(caseKey);
  if (onChain === undefined) throw new RecoveryRefusedError("REGISTRY_TERMS_MISMATCH", `The registry holds no case ${caseKey}.`);
  const mismatch = termsMismatch(onChain, registrationTerms(action.proposal));
  if (mismatch !== undefined) throw new RecoveryRefusedError("REGISTRY_TERMS_MISMATCH", `The registry case has a different ${mismatch}.`);
  if (onChain.state === "REPAID") assertOutcome(onChain, txHash, evidence);
  else if (onChain.state !== "RESERVED_REPAY") throw new RecoveryRefusedError("REGISTRY_TERMS_MISMATCH", `The registry case is ${onChain.state}, not reserved for repayment.`);

  if (action.state === "VERIFIED") {
    action = immediateTransaction(db, () => {
      const current = reread(db, action.id);
      if (current.state !== "VERIFIED") return current;
      const at = input.now().toISOString();
      moveRecoveryAction(db, current, { to: "RECORD_PENDING", actor: "verifier", actorLabel: "verifier", eventType: "RECOVERY_OUTCOME_PENDING", now: at });
      const record = readCaseEvidence(db, current.caseId).case;
      if (record.status === "VERIFIED") moveCase(db, record, "RECORD_PENDING", { actor: "verifier" }, "verifier", "CASE_RECORD_PENDING", at, {});
      return reread(db, current.id);
    });
  }

  let write: RegistryWrite | undefined;
  if (onChain.state === "RESERVED_REPAY") {
    let reverted: RegistryRevertError | undefined;
    try {
      write = await registry.completeRepayment(caseKey, txHash, evidence);
    } catch (error) {
      // A lost receipt, or a concurrent write that landed first and made this one revert: the chain decides.
      if (error instanceof RegistryRevertError) reverted = error;
      else if (!(error instanceof RegistryOutcomeUnknownError)) return { status: "PENDING", action, reason: describe(error) };
    }
    onChain = await registry.readCase(caseKey);
    if (reverted !== undefined && onChain?.state !== "REPAID") throw reverted;
  }
  if (onChain?.state !== "REPAID") return { status: "PENDING", action, reason: "the registry has not recorded the repayment yet" };
  assertOutcome(onChain, txHash, evidence);

  return immediateTransaction(db, () => {
    const current = reread(db, action.id);
    if (current.state === "COMPLETED") return { status: "RECORDED" as const, action: current };
    const at = input.now().toISOString();
    const registryTx = write?.txHash.toLowerCase();
    const evidenceRef = registryTx ?? `registry:${caseKey}:REPAID`;
    moveRecoveryAction(db, current, {
      to: "COMPLETED",
      actor: "reconciler",
      actorLabel: "reconciler",
      evidenceRef,
      eventType: "RECOVERY_REPAYMENT_RECORDED",
      now: at,
      ...(registryTx === undefined ? {} : { set: { registryTx } }),
    });
    const record = readCaseEvidence(db, current.caseId).case;
    if (record.status === "RECORD_PENDING") moveCase(db, record, "REPAID", { actor: "reconciler", evidenceRef }, "reconciler", "CASE_REPAID", at, {});
    return { status: "RECORDED" as const, action: reread(db, current.id) };
  });
}

/** The evidence commitment the registry records: the verified transfer bound to its case, proposal, cart, and mandate. */
export function repaymentEvidence(action: RecoveryActionRecord, attempt: PaymentAttemptRecord, txHash: string): string {
  if (attempt.cartSha256 === null || attempt.paymentMandateSha256 === null || attempt.flowId === null) {
    throw new ActionIntegrityError(`repayment attempt ${attempt.id} lacks the cart, mandate, or gateway flow it was verified with`);
  }
  return repaymentEvidenceSha256({
    schema: REPAYMENT_EVIDENCE_SCHEMA,
    caseKey: action.proposal.caseKey,
    actionSha256: action.actionSha256,
    attemptId: attempt.id,
    payer: attempt.payer,
    payee: attempt.payee,
    chainId: attempt.chainId,
    token: attempt.token,
    amountBaseUnits: attempt.amountBaseUnits,
    cartSha256: attempt.cartSha256,
    paymentMandateSha256: attempt.paymentMandateSha256,
    flowId: attempt.flowId,
    txHash: txHash.toLowerCase(),
  });
}

/** The operation's live repayment attempt, which must be for this action's proposal. Callers hold the transaction. */
export function liveAttempt(db: DatabaseSync, action: RecoveryActionRecord): PaymentAttemptRecord | undefined {
  const row = db.prepare(`SELECT id FROM payment_attempts WHERE operation_id = ? AND ${LIVE_ATTEMPT}`).get(action.proposal.operationId);
  if (row === undefined) return undefined;
  const attempt = getPaymentAttempt(db, String(row.id));
  if (attempt === undefined) throw new Error(`payment attempt ${String(row.id)} disappeared`);
  if (attempt.intentSha256 !== action.actionSha256) throw new ActionIntegrityError(`repayment attempt ${attempt.id} is not for recovery action ${action.id}`);
  return attempt;
}

function alreadyRequested(db: DatabaseSync, actionId: string): { status: "ALREADY_REQUESTED"; action: RecoveryActionRecord; attempt: PaymentAttemptRecord | undefined } {
  return readTransaction(db, () => {
    const action = reread(db, actionId);
    return { status: "ALREADY_REQUESTED", action, attempt: liveAttempt(db, action) };
  });
}

function assertExecutable(db: DatabaseSync, action: RecoveryActionRecord, now: Date): void {
  const state = freshness(db, action, now);
  if (!state.executable) throw new RecoveryRefusedError("NOT_EXECUTABLE", `The repayment reservation cannot be executed: ${state.reasons.join("; ")}.`);
  const status = readCaseEvidence(db, action.caseId).case.status;
  if (status !== "RESERVED") throw new RecoveryRefusedError("NOT_EXECUTABLE", `The case is ${status}, not RESERVED.`);
}

async function assertReservedOnChain(registry: RegistryGateway, action: RecoveryActionRecord): Promise<void> {
  const onChain = await registry.readCase(action.proposal.caseKey);
  if (onChain === undefined) throw new RecoveryRefusedError("REGISTRY_TERMS_MISMATCH", `The registry holds no case ${action.proposal.caseKey}.`);
  const mismatch = termsMismatch(onChain, registrationTerms(action.proposal));
  if (mismatch !== undefined) throw new RecoveryRefusedError("REGISTRY_TERMS_MISMATCH", `The registry case has a different ${mismatch}.`);
  if (onChain.state !== "RESERVED_REPAY") throw new RecoveryRefusedError("NOT_EXECUTABLE", `The registry case is ${onChain.state}, not reserved for repayment.`);
}

function assertOutcome(onChain: RegistryCase, txHash: string, evidence: string): void {
  if (onChain.outcomeRef !== txHash.toLowerCase() || onChain.outcomeCommitment !== evidence) {
    throw new RecoveryRefusedError("REGISTRY_OUTCOME_MISMATCH", "The registry recorded a different repayment outcome; an operator must investigate.");
  }
}

function requireOperation(db: DatabaseSync, action: RecoveryActionRecord): OperationRecord {
  const operation = getOperation(db, action.proposal.operationId);
  if (operation === undefined) throw new ActionIntegrityError(`recovery action ${action.id} names an unknown operation`);
  return operation;
}

function requireTransfer(action: RecoveryActionRecord): TransferTerms {
  const transfer = action.proposal.transfer;
  if (transfer === null) throw new ActionIntegrityError(`repayment ${action.id} has no transfer`);
  return transfer;
}

function reread(db: DatabaseSync, id: string): RecoveryActionRecord {
  const action = getRecoveryAction(db, id);
  if (action === undefined) throw new Error(`recovery action ${id} disappeared`);
  return action;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
