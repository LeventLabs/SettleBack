import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  RegistryOutcomeUnknownError,
  RegistryRevertError,
  type RegisterCaseInput,
  type RegistryCase,
  type RegistryGateway,
  type WalletCall,
} from "@settleback/adapters";
import {
  CASE_MACHINE,
  RECOVERY_ACTION_SCHEMA,
  assertTransition,
  deriveEligibility,
  eligibilityRulesSha256,
  parseServiceStatus,
  proposalSha256,
  registryCaseKey,
  repaymentTransfer,
  standingPolicyGaps,
  type Actor,
  type Address,
  type CaseState,
  type PolicyTerms,
  type ProposalAuthorization,
  type RecoveryProposal,
} from "@settleback/domain";
import { getRecoveryAction, getRecoveryActionForCase, insertRecoveryAction, moveRecoveryAction, type RecoveryActionRecord } from "../db/actions.ts";
import { listAssessments } from "../db/assessments.ts";
import { readCaseEvidence, type CaseRecord } from "../db/cases.ts";
import { immediateTransaction, readTransaction } from "../db/database.ts";
import { RecoveryRefusedError } from "../db/errors.ts";
import { appendEvent } from "../db/events.ts";
import { readCaseBaseline } from "./baseline.ts";

/** How long a prepared recovery stays approvable. The registry stores the same deadline. */
export const DEFAULT_RECOVERY_DEADLINE_MS = 24 * 60 * 60 * 1000;
// A case the rules resolve outright is still OPEN: it never needed a model assessment.
const PREPARABLE: readonly CaseState[] = ["OPEN", "ASSESSING", "REVIEW_REQUIRED"];

export interface RecoveryRequester {
  role: "seller" | "operator";
  identity: string;
}

export interface PrepareRecoveryInput {
  caseId: string;
  requestedBy: RecoveryRequester;
  /** Required: without the registry there is no integrated recovery. */
  registry: RegistryGateway | undefined;
  terms: ReadonlyMap<string, PolicyTerms>;
  now: () => Date;
  deadlineMs?: number;
  newId?: () => string;
}

export interface PreparedRecovery {
  action: RecoveryActionRecord;
  /** For a per-case repayment: the reservation the seller's wallet signs. */
  sellerCall: WalletCall | null;
  /** For a standing-policy repayment: the reservation the seller's delegate sends. */
  delegateCall: WalletCall | null;
  /** Why the seller's standing policy did not cover this repayment, when it did not. */
  policyGaps: string[];
}

/**
 * Prepares the one recovery action a case may ever have. Eligibility is recomputed from the
 * current evidence, the proposal binds every term, and the case is registered on chain with the
 * proposal's digest. A retrieval is then reserved by the verifier; a repayment waits for the
 * seller's reservation (PER_CASE) or the delegate's under the seller's active policy (STANDING_POLICY).
 */
export async function prepareRecovery(db: DatabaseSync, input: PrepareRecoveryInput): Promise<PreparedRecovery> {
  const registry = input.registry;
  if (registry === undefined) throw new RecoveryRefusedError("REGISTRY_REQUIRED", "No recovery registry is configured; integrated recovery is unavailable.");
  const newId = input.newId ?? randomUUID;
  const now = input.now();

  const read = readTransaction(db, () => {
    const snapshot = readCaseBaseline(db, input.caseId, input.terms);
    const requester = authorizeRequester(input.requestedBy, snapshot.operation.seller);
    const record = snapshot.case;
    if (getRecoveryActionForCase(db, record.id) !== undefined) throw new RecoveryRefusedError("ACTION_EXISTS", `Case ${record.id} already has its recovery action.`);
    if (!PREPARABLE.includes(record.status)) throw new RecoveryRefusedError("CASE_NOT_READY", `Case ${record.id} is ${record.status}; prepare a recovery after assessment.`);
    const assessed = listAssessments(db, record.id, record.evidence.revision).find((attempt) => attempt.result?.status === "SUCCEEDED");
    const eligibility = deriveEligibility(snapshot.result, assessed?.result?.decision);
    if (!eligibility.eligible) throw new RecoveryRefusedError("NOT_ELIGIBLE", eligibility.reason);
    const original = db
      .prepare("SELECT tx_hash FROM payment_attempts WHERE operation_id = ? AND purpose = 'ORIGINAL' AND state = 'VERIFIED'")
      .get(record.operationId);
    if (original === undefined || original.tx_hash === null) {
      throw new RecoveryRefusedError("ORIGINAL_REFERENCE_MISSING", "The verified original payment has no recorded transaction to bind.");
    }
    let artifactSha256: string | null = null;
    if (eligibility.eligibility.action === "RETRIEVE") {
      const decision = assessed?.result?.decision;
      artifactSha256 =
        eligibility.eligibility.basis === "VERIFIED_ARTIFACT_LEAD" && decision?.action === "RETRIEVE"
          ? decision.artifactSha256
          : completedArtifact(snapshot.items.filter((item) => item.source === "service-status" && item.provenance === "AUTHENTICATED_SERVICE").map((item) => item.content));
      if (artifactSha256 === null) throw new RecoveryRefusedError("NOT_ELIGIBLE", "No completed artifact digest is recorded for retrieval.");
    }
    return { snapshot, requester, eligibility: eligibility.eligibility, originalTxHash: String(original.tx_hash), artifactSha256 };
  });

  const { snapshot, eligibility } = read;
  const operation = snapshot.operation;
  const record = snapshot.case;
  const caseKey = registryCaseKey(record.id, { chainId: registry.chainId, address: registry.address });
  const rulesSha256 = eligibilityRulesSha256(eligibility.basis);
  const autoEligible = eligibility.action === "REPAY" && eligibility.basis === "RULES_BASELINE";

  let authorization: ProposalAuthorization | null = null;
  let policyGaps: string[] = [];
  if (eligibility.action === "REPAY") {
    authorization = { mode: "PER_CASE" };
    const policyId = await registry.activePolicyId(operation.seller, operation.chainId, operation.token);
    if (policyId === 0) {
      policyGaps = ["the seller has no active standing policy for this chain and token"];
    } else {
      const policy = await registry.readPolicy(policyId);
      const budget = await registry.readBudget(operation.seller, operation.chainId, operation.token);
      policyGaps =
        policy === undefined
          ? ["the active policy could not be read"]
          : standingPolicyGaps({
              policy: { ...policy.terms, status: policy.status, seller: policy.seller },
              seller: operation.seller,
              chainId: operation.chainId,
              token: operation.token,
              amountBaseUnits: operation.amountBaseUnits,
              policySha256: operation.policySha256,
              eligibilityRulesSha256: rulesSha256,
              bookedTodayBaseUnits: budget.bookedOnDayBaseUnits,
              outstandingBaseUnits: budget.outstandingBaseUnits,
              now,
            });
      if (policyGaps.length === 0 && autoEligible) authorization = { mode: "STANDING_POLICY", scope: budget.scope, version: policyId };
    }
  }

  const proposal: RecoveryProposal = {
    schema: RECOVERY_ACTION_SCHEMA,
    caseId: record.id,
    caseKey,
    operationId: operation.id,
    action: eligibility.action,
    basis: eligibility.basis,
    classification: eligibility.classification,
    evidenceRevision: record.evidence.revision,
    evidenceSha256: record.evidence.sha256,
    policySha256: operation.policySha256,
    eligibilityRulesSha256: rulesSha256,
    autoEligible,
    parties: { buyer: operation.buyer, seller: operation.seller, chainId: operation.chainId, token: operation.token, amountBaseUnits: operation.amountBaseUnits },
    originalTxHash: read.originalTxHash,
    transfer: eligibility.action === "REPAY" ? repaymentTransfer(operation) : null,
    artifactSha256: read.artifactSha256,
    deadline: new Date(now.getTime() + (input.deadlineMs ?? DEFAULT_RECOVERY_DEADLINE_MS)).toISOString(),
    registry: { chainId: registry.chainId, address: registry.address },
    authorization,
  };

  const actionId = newId();
  immediateTransaction(db, () => {
    const current = readCaseEvidence(db, record.id).case;
    if (current.evidence.sha256 !== record.evidence.sha256 || current.status !== record.status) {
      throw new RecoveryRefusedError("REVISION_CONFLICT", `Case ${record.id} changed while the recovery was being prepared.`);
    }
    if (getRecoveryActionForCase(db, record.id) !== undefined) throw new RecoveryRefusedError("ACTION_EXISTS", `Case ${record.id} already has its recovery action.`);
    const at = now.toISOString();
    insertRecoveryAction(db, { id: actionId, proposal, now: at });
    appendEvent(db, {
      entityType: "recovery_action",
      entityId: actionId,
      eventType: "RECOVERY_PREPARED",
      priorRevision: null,
      newRevision: 0,
      actor: read.requester,
      payloadSha256: proposalSha256(proposal),
      createdAt: at,
    });
    // From OPEN or ASSESSING the server prepares on the requester's behalf; from REVIEW_REQUIRED the requester decides.
    let caseRecord = current;
    if (caseRecord.status === "OPEN") {
      moveCase(db, caseRecord, "ASSESSING", { actor: "server" }, read.requester, "CASE_ASSESSING", at, {});
      caseRecord = readCaseEvidence(db, record.id).case;
    }
    const actor: Actor = caseRecord.status === "ASSESSING" ? "server" : input.requestedBy.role;
    moveCase(db, caseRecord, "ACTION_PREPARED", { actor }, read.requester, "CASE_ACTION_PREPARED", at, {
      registryCaseKey: caseKey,
      eligibilityRulesSha256: rulesSha256,
      autoEligible,
    });
  });

  const action = await ensureRegistered(db, { actionId, registry, now: input.now });
  return {
    action,
    sellerCall: authorization?.mode === "PER_CASE" ? registry.reserveRepaymentCall(caseKey) : null,
    delegateCall: authorization?.mode === "STANDING_POLICY" ? registry.reserveUnderPolicyCall(caseKey, authorization.version) : null,
    policyGaps,
  };
}

/**
 * Makes sure the case is registered on chain with exactly the proposal's terms, and for a
 * retrieval that the verifier's reservation exists. Safe to repeat after a crash or a lost
 * receipt: it reads the chain first and only writes what is missing.
 */
export async function ensureRegistered(db: DatabaseSync, input: { actionId: string; registry: RegistryGateway; now: () => Date }): Promise<RecoveryActionRecord> {
  const { registry } = input;
  const action = readTransaction(db, () => getRecoveryAction(db, input.actionId));
  if (action === undefined) throw new RecoveryRefusedError("ACTION_NOT_FOUND", `Recovery action ${input.actionId} does not exist.`);
  requireRegistry(registry, action.proposal);
  if (action.state !== "PREPARED") return action;
  const expected = registrationTerms(action.proposal);

  let onChain = await registry.readCase(expected.caseKey);
  if (onChain === undefined) {
    try {
      await registry.registerCase(expected);
    } catch (error) {
      // Another attempt may have registered it, or the receipt was lost; the chain decides.
      if (!(error instanceof RegistryOutcomeUnknownError) && !(error instanceof RegistryRevertError && error.reason === "CaseExists")) throw error;
    }
    onChain = await registry.readCase(expected.caseKey);
    if (onChain === undefined) throw new RegistryOutcomeUnknownError("", `case ${expected.caseKey} is not registered yet; retry later`);
  }
  const mismatch = termsMismatch(onChain, expected);
  if (mismatch !== undefined) {
    throw new RecoveryRefusedError("REGISTRY_TERMS_MISMATCH", `The registry holds case ${expected.caseKey} with a different ${mismatch}; an operator must strand this action.`);
  }
  if (action.action === "REPAY") return action;

  let reservationTx: string | undefined;
  if (onChain.state === "OPEN") {
    try {
      reservationTx = (await registry.reserveRetrieval(expected.caseKey)).txHash;
    } catch (error) {
      if (!(error instanceof RegistryOutcomeUnknownError) && !(error instanceof RegistryRevertError && error.reason === "WrongState")) throw error;
    }
    onChain = await registry.readCase(expected.caseKey);
  }
  if (onChain?.state !== "RESERVED_RETRIEVE" && onChain?.state !== "RECOVERED") return action;

  return immediateTransaction(db, () => {
    const current = getRecoveryAction(db, action.id);
    if (current === undefined || current.state !== "PREPARED") return current ?? action;
    const at = input.now().toISOString();
    const evidenceRef = reservationTx ?? `registry:${expected.caseKey}:RESERVED_RETRIEVE`;
    moveRecoveryAction(db, current, {
      to: "RESERVED",
      actor: "verifier",
      actorLabel: "verifier",
      evidenceRef,
      eventType: "RECOVERY_RETRIEVAL_RESERVED",
      now: at,
      ...(reservationTx === undefined ? {} : { set: { approvalTx: reservationTx } }),
    });
    const record = readCaseEvidence(db, current.caseId).case;
    if (record.status === "ACTION_PREPARED") moveCase(db, record, "RESERVED", { actor: "reconciler", evidenceRef }, "reconciler", "CASE_RESERVED", at, {});
    const updated = getRecoveryAction(db, action.id);
    if (updated === undefined) throw new Error(`recovery action ${action.id} disappeared`);
    return updated;
  });
}

export type ReservationOutcome =
  | { status: "CONFIRMED"; action: RecoveryActionRecord; executable: boolean; reasons: string[] }
  | { status: "PENDING"; reason: string }
  | { status: "REJECTED"; reason: string };

/**
 * Accepts a reported repayment reservation only after the registry confirms it from the chain:
 * the right sender (the seller for PER_CASE, the policy's delegate for STANDING_POLICY), the right
 * case, mode, and authorization, enough confirmations, and on-chain case terms equal to the
 * proposal. Who reports the transaction does not matter; a buyer or operator cannot make another
 * account's approval. A confirmed reservation is recorded even when the proposal has gone stale or
 * expired, because the chain now holds it; it is then not executable, and nothing resets it.
 */
export async function confirmRepaymentReservation(
  db: DatabaseSync,
  input: { actionId: string; txHash: string; registry: RegistryGateway | undefined; now: () => Date },
): Promise<ReservationOutcome> {
  if (input.registry === undefined) throw new RecoveryRefusedError("REGISTRY_REQUIRED", "No recovery registry is configured; integrated recovery is unavailable.");
  const action = readTransaction(db, () => getRecoveryAction(db, input.actionId));
  if (action === undefined) throw new RecoveryRefusedError("ACTION_NOT_FOUND", `Recovery action ${input.actionId} does not exist.`);
  const registry = requireRegistry(input.registry, action.proposal);
  if (action.action !== "REPAY") throw new RecoveryRefusedError("WRONG_ACTION_STATE", "Only a repayment is reserved by the seller or a delegate.");
  const recorded = action.approvalTx ?? action.policyTx;
  if (action.state !== "PREPARED") {
    if (recorded !== null && recorded === input.txHash.toLowerCase()) return { status: "CONFIRMED", action, ...freshness(db, action, input.now()) };
    return { status: "REJECTED", reason: `the action is already ${action.state}` };
  }

  const authorization = action.proposal.authorization;
  let reservedBy: Address;
  if (authorization?.mode === "STANDING_POLICY") {
    const policy = await registry.readPolicy(authorization.version);
    if (policy === undefined) return { status: "REJECTED", reason: "the bound policy does not exist on the registry" };
    if (policy.seller !== action.proposal.transfer?.payer) return { status: "REJECTED", reason: "the bound policy belongs to another seller" };
    reservedBy = policy.terms.delegate;
  } else {
    const seller = action.proposal.transfer?.payer;
    if (seller === undefined) return { status: "REJECTED", reason: "the proposal has no repayment terms" };
    reservedBy = seller;
  }

  const confirmation = await registry.confirmReservation(input.txHash, {
    caseKey: action.proposal.caseKey,
    mode: authorization?.mode === "STANDING_POLICY" ? "STANDING_POLICY" : "PER_CASE",
    reservedBy,
    ...(authorization?.mode === "STANDING_POLICY" ? { authorizationId: authorization.version } : {}),
  });
  if (confirmation.status !== "CONFIRMED") return confirmation;
  const onChain = await registry.readCase(action.proposal.caseKey);
  const mismatch = onChain === undefined ? "registration" : termsMismatch(onChain, registrationTerms(action.proposal));
  if (mismatch !== undefined) return { status: "REJECTED", reason: `the registry case has a different ${mismatch}` };
  if (confirmation.amountBaseUnits !== action.proposal.transfer?.amountBaseUnits) return { status: "REJECTED", reason: "the reserved amount differs from the proposal" };

  return immediateTransaction(db, () => {
    const current = getRecoveryAction(db, action.id);
    if (current === undefined) throw new Error(`recovery action ${action.id} disappeared`);
    if (current.state !== "PREPARED") {
      const already = current.approvalTx ?? current.policyTx;
      return already === confirmation.txHash
        ? { status: "CONFIRMED" as const, action: current, ...freshness(db, current, input.now()) }
        : { status: "REJECTED" as const, reason: `the action is already ${current.state}` };
    }
    const at = input.now().toISOString();
    moveRecoveryAction(db, current, {
      to: "RESERVED",
      actor: "reconciler",
      actorLabel: "reconciler",
      evidenceRef: confirmation.txHash,
      eventType: authorization?.mode === "STANDING_POLICY" ? "RECOVERY_RESERVED_UNDER_POLICY" : "RECOVERY_RESERVED_BY_SELLER",
      now: at,
      set: authorization?.mode === "STANDING_POLICY" ? { policyTx: confirmation.txHash } : { approvalTx: confirmation.txHash },
    });
    const updated = getRecoveryAction(db, action.id);
    if (updated === undefined) throw new Error(`recovery action ${action.id} disappeared`);
    const state = freshness(db, updated, input.now());
    const record = readCaseEvidence(db, updated.caseId).case;
    if (state.executable && record.status === "ACTION_PREPARED") {
      moveCase(db, record, "RESERVED", { actor: "reconciler", evidenceRef: confirmation.txHash }, "reconciler", "CASE_RESERVED", at, {});
    }
    return { status: "CONFIRMED" as const, action: updated, ...state };
  });
}

/**
 * An operator ends an action that can no longer proceed (stale, expired, or with mismatched
 * registry terms). The reservation and its exposure stay on chain; nothing is released or reset,
 * and the case keeps its one action.
 */
export function strandRecovery(db: DatabaseSync, input: { actionId: string; operator: string; reason: string; now: () => Date }): RecoveryActionRecord {
  if (input.operator.trim() === "") throw new RecoveryRefusedError("ROLE_FORBIDDEN", "An operator identity is required.");
  if (input.reason.trim() === "") throw new RecoveryRefusedError("WRONG_ACTION_STATE", "Stranding needs a recorded reason.");
  return immediateTransaction(db, () => {
    const action = getRecoveryAction(db, input.actionId);
    if (action === undefined) throw new RecoveryRefusedError("ACTION_NOT_FOUND", `Recovery action ${input.actionId} does not exist.`);
    moveRecoveryAction(db, action, {
      to: "STRANDED",
      actor: "operator",
      actorLabel: `operator:${input.operator}`,
      evidenceRef: input.reason,
      eventType: "RECOVERY_STRANDED",
      now: input.now().toISOString(),
    });
    const updated = getRecoveryAction(db, action.id);
    if (updated === undefined) throw new Error(`recovery action ${action.id} disappeared`);
    return updated;
  });
}

/** Whether the action may still lead to execution: its evidence is current and its deadline has not passed. */
export function freshness(db: DatabaseSync, action: RecoveryActionRecord, now: Date): { executable: boolean; reasons: string[] } {
  const record = readCaseEvidence(db, action.caseId).case;
  const reasons: string[] = [];
  if (record.evidence.sha256 !== action.evidenceSha256) reasons.push("STALE_EVIDENCE: the case evidence changed after the recovery was prepared");
  if (!(now.getTime() < Date.parse(action.deadline))) reasons.push("EXPIRED: the recovery deadline has passed");
  return { executable: reasons.length === 0, reasons };
}

export function registrationTerms(proposal: RecoveryProposal): RegisterCaseInput {
  const { parties } = proposal;
  return {
    caseKey: proposal.caseKey,
    buyer: parties.buyer,
    seller: parties.seller,
    token: parties.token,
    amountBaseUnits: parties.amountBaseUnits,
    originalRef: { chainId: parties.chainId, txHash: proposal.originalTxHash },
    policySha256: proposal.policySha256,
    eligibilityRulesSha256: proposal.eligibilityRulesSha256,
    autoEligible: proposal.autoEligible,
    actionDigest: proposalSha256(proposal),
    evidenceDigest: proposal.evidenceSha256,
    actionKind: proposal.action,
    deadline: proposal.deadline,
  };
}

/**
 * The registry an action must use: the one its proposal was registered on. Another deployment,
 * even with the same verifier, would hold a different case under a different key.
 */
export function requireRegistry(registry: RegistryGateway | undefined, proposal: RecoveryProposal): RegistryGateway {
  if (registry === undefined) throw new RecoveryRefusedError("REGISTRY_REQUIRED", "No recovery registry is configured; integrated recovery is unavailable.");
  if (registry.chainId !== proposal.registry.chainId || registry.address.toLowerCase() !== proposal.registry.address.toLowerCase()) {
    throw new RecoveryRefusedError(
      "WRONG_REGISTRY",
      `The recovery was prepared on registry ${proposal.registry.address} (chain ${proposal.registry.chainId}), not the configured ${registry.address} (chain ${registry.chainId}).`,
    );
  }
  return registry;
}

/** The first field where the registry's record differs from the proposal's terms, if any. */
export function termsMismatch(onChain: RegistryCase, expected: RegisterCaseInput): string | undefined {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(onChain.buyer, expected.buyer)) return "buyer";
  if (!same(onChain.seller, expected.seller)) return "seller";
  if (!same(onChain.token, expected.token)) return "token";
  if (onChain.amountBaseUnits !== expected.amountBaseUnits) return "amount";
  if (onChain.originalRef.chainId !== expected.originalRef.chainId || !same(onChain.originalRef.txHash, expected.originalRef.txHash)) return "original payment";
  if (onChain.policySha256 !== expected.policySha256) return "service terms";
  if (onChain.eligibilityRulesSha256 !== expected.eligibilityRulesSha256) return "eligibility rules";
  if (onChain.autoEligible !== expected.autoEligible) return "eligibility flag";
  if (onChain.actionDigest !== expected.actionDigest) return "action digest";
  if (onChain.evidenceDigest !== expected.evidenceDigest) return "evidence digest";
  if (onChain.actionKind !== expected.actionKind) return "action kind";
  if (Math.floor(Date.parse(onChain.deadline) / 1000) !== Math.floor(Date.parse(expected.deadline) / 1000)) return "deadline";
  return undefined;
}

function completedArtifact(statusContents: readonly string[]): string | null {
  for (const content of statusContents) {
    const status = parseServiceStatus(content);
    if (status?.state === "COMPLETED" && status.artifactSha256 !== null) return status.artifactSha256;
  }
  return null;
}

export function moveCase(
  db: DatabaseSync,
  record: CaseRecord,
  to: CaseState,
  request: { actor: Actor; evidenceRef?: string },
  actorLabel: string,
  eventType: string,
  now: string,
  set: { registryCaseKey?: string; eligibilityRulesSha256?: string; autoEligible?: boolean },
): void {
  assertTransition(CASE_MACHINE, record.status, to, request);
  const updated = db
    .prepare(
      `UPDATE cases SET status = ?, revision = ?, updated_at = ?,
         registry_case_key = coalesce(?, registry_case_key),
         eligibility_rules_sha256 = coalesce(?, eligibility_rules_sha256),
         auto_eligible = coalesce(?, auto_eligible)
       WHERE id = ? AND revision = ?`,
    )
    .run(
      to,
      record.revision + 1,
      now,
      set.registryCaseKey ?? null,
      set.eligibilityRulesSha256 ?? null,
      set.autoEligible === undefined ? null : set.autoEligible ? 1 : 0,
      record.id,
      record.revision,
    );
  if (updated.changes !== 1) throw new Error(`case ${record.id} changed concurrently`);
  appendEvent(db, {
    entityType: "case",
    entityId: record.id,
    eventType,
    priorRevision: record.revision,
    newRevision: record.revision + 1,
    actor: actorLabel,
    payloadSha256: record.evidence.sha256,
    createdAt: now,
  });
}

function authorizeRequester(requester: RecoveryRequester, seller: string): string {
  if (requester.role === "seller") {
    if (requester.identity.toLowerCase() !== seller) throw new RecoveryRefusedError("ROLE_FORBIDDEN", "Only the operation's seller can prepare its recovery.");
    return `seller:${seller}`;
  }
  if (requester.role === "operator") {
    if (requester.identity.trim() === "") throw new RecoveryRefusedError("ROLE_FORBIDDEN", "An operator identity is required.");
    return `operator:${requester.identity}`;
  }
  throw new RecoveryRefusedError("ROLE_FORBIDDEN", "Only the seller or an operator can prepare a recovery.");
}
