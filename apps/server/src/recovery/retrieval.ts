import type { DatabaseSync } from "node:sqlite";
import { RegistryOutcomeUnknownError, RegistryRevertError, type RegistryCase, type RegistryGateway, type RegistryWrite } from "@settleback/adapters";
import {
  DELIVERY_ACK_SCHEMA,
  checkArtifactLead,
  deliveryAckSha256,
  readArtifactLead,
  type Address,
  type CaseState,
  type RecoveryActionState,
  type ServiceStatusRecord,
} from "@settleback/domain";
import { sha256Hex } from "@settleback/domain/hash";
import {
  getDeliveryAck,
  getRecoveryAction,
  getRecoveryActionForCase,
  insertDeliveryAck,
  moveRecoveryAction,
  type DeliveryAckRecord,
  type RecoveryActionRecord,
} from "../db/actions.ts";
import { readCaseEvidence, readCaseForOperation } from "../db/cases.ts";
import { immediateTransaction, readTransaction } from "../db/database.ts";
import { ActionIntegrityError, RecoveryRefusedError } from "../db/errors.ts";
import { getOperation } from "../db/operations.ts";
import { freshness, moveCase, registrationTerms, requireRegistry, termsMismatch } from "./actions.ts";
import { recordedServiceStatuses, type ServiceLookup } from "./assessment.ts";

/** Read access to the job service and artifact store for delivering a result that already exists. */
export interface ResultLookup extends ServiceLookup {
  /** The bytes the artifact store holds under the digest, or null when it holds none. */
  artifactBytes(sha256: string, signal: AbortSignal): Promise<Uint8Array | null>;
}

export const DEFAULT_RESULT_LOOKUP_TIMEOUT_MS = 10_000;
// Once released, the same verified bytes may be delivered again, so a lost response or a lost
// acknowledgement is repeated rather than turned into new work.
const RELEASED: readonly RecoveryActionState[] = ["EXECUTION_REQUESTED", "DELIVERY_ACKED", "RECORD_PENDING", "COMPLETED"];

export interface RetrieveResultInput {
  operationId: string;
  /** The authenticated buyer's wallet address. */
  buyer: string;
  registry: RegistryGateway | undefined;
  lookup: ResultLookup;
  now: () => Date;
  timeoutMs?: number;
}

export interface RetrievedResult {
  action: RecoveryActionRecord;
  artifactSha256: string;
  content: Uint8Array;
}

/**
 * Delivers the existing artifact of a reserved retrieval to the operation's buyer. Nothing is run
 * again and nothing is paid: the bytes come from the artifact store, and are released only after
 * the same binding checks that make an artifact lead eligible pass against the live services and
 * the bytes hash to the digest the proposal fixed. The first release also needs a fresh
 * reservation that the registry still holds; a failure at any step leaves the delivery pending.
 */
export async function retrieveResult(db: DatabaseSync, input: RetrieveResultInput): Promise<RetrievedResult> {
  const read = readTransaction(db, () => {
    const { action, buyer, artifactSha256 } = buyerRetrieval(db, input.operationId, input.buyer);
    const registry = requireRegistry(input.registry, action.proposal);
    const { case: record, items } = readCaseEvidence(db, action.caseId);
    if (record.status === "QUARANTINED") throw new RecoveryRefusedError("CASE_NOT_READY", `Case ${record.id} is quarantined; nothing is delivered.`);
    if (action.state === "RESERVED") {
      assertReleasable(db, action, record.status, input.now());
    } else if (!RELEASED.includes(action.state)) {
      throw new RecoveryRefusedError("WRONG_ACTION_STATE", `The retrieval is ${action.state}; there is no result to deliver.`);
    }
    return { action, buyer, artifactSha256, registry, recorded: recordedServiceStatuses({ evidence: items }) };
  });
  const { action, artifactSha256 } = read;

  if (action.state === "RESERVED") await assertReservedOnChain(read.registry, action);
  const content = await fetchVerifiedArtifact(input.lookup, action.proposal.operationId, artifactSha256, read.recorded, input.timeoutMs ?? DEFAULT_RESULT_LOOKUP_TIMEOUT_MS);
  if (action.state !== "RESERVED") return { action, artifactSha256, content };

  const released = immediateTransaction(db, () => {
    const current = getRecoveryAction(db, action.id);
    if (current === undefined) throw new Error(`recovery action ${action.id} disappeared`);
    if (RELEASED.includes(current.state)) return current;
    if (current.state !== "RESERVED") throw new RecoveryRefusedError("WRONG_ACTION_STATE", `The retrieval is ${current.state}; there is no result to deliver.`);
    const record = readCaseEvidence(db, current.caseId).case;
    const now = input.now();
    assertReleasable(db, current, record.status, now);
    const at = now.toISOString();
    const label = `buyer:${read.buyer}`;
    moveRecoveryAction(db, current, { to: "EXECUTION_REQUESTED", actor: "server", actorLabel: label, eventType: "RECOVERY_RESULT_RELEASED", now: at });
    moveCase(db, record, "EXECUTION_REQUESTED", { actor: "server" }, label, "CASE_EXECUTION_REQUESTED", at, {});
    return reread(db, current.id);
  });
  return { action: released, artifactSha256, content };
}

export interface AcknowledgeDeliveryInput {
  operationId: string;
  /** The authenticated buyer's wallet address. */
  buyer: string;
  /** The digest the buyer computed over the bytes it received. */
  artifactSha256: string;
  registry: RegistryGateway | undefined;
  now: () => Date;
}

export type OutcomeRecording = { status: "RECORDED"; action: RecoveryActionRecord } | { status: "PENDING"; action: RecoveryActionRecord; reason: string };

export interface AcknowledgedDelivery {
  acknowledgementSha256: string;
  acknowledgedAt: string;
  outcome: OutcomeRecording;
}

/**
 * Records the buyer's acknowledgement of the expected digest, then has the verifier record the
 * outcome on the registry. The acknowledgement is stored once per operation; repeating it returns
 * the stored one and retries a registry write that has not landed. A failed registry write leaves
 * the acknowledgement stored and the outcome pending, never undone.
 */
export async function acknowledgeDelivery(db: DatabaseSync, input: AcknowledgeDeliveryInput): Promise<AcknowledgedDelivery> {
  const acked = immediateTransaction(db, () => {
    const { action, buyer, artifactSha256 } = buyerRetrieval(db, input.operationId, input.buyer);
    requireRegistry(input.registry, action.proposal);
    if (input.artifactSha256.toLowerCase() !== artifactSha256) {
      throw new RecoveryRefusedError("ACK_DIGEST_MISMATCH", "The acknowledged digest is not the artifact this recovery delivers.");
    }
    const existing = getDeliveryAck(db, input.operationId);
    if (existing !== undefined) return { action, ack: existing };
    if (action.state !== "EXECUTION_REQUESTED") {
      throw new RecoveryRefusedError("WRONG_ACTION_STATE", `The result has not been delivered; the retrieval is ${action.state}.`);
    }
    const record = readCaseEvidence(db, action.caseId).case;
    if (record.status !== "EXECUTION_REQUESTED") throw new RecoveryRefusedError("CASE_NOT_READY", `Case ${record.id} is ${record.status}.`);
    const at = input.now().toISOString();
    const ack: DeliveryAckRecord = { operationId: input.operationId, buyer, artifactSha256, acknowledgedAt: at };
    const evidenceRef = `ack:${acknowledgementSha256(action, ack)}`;
    const label = `buyer:${buyer}`;
    insertDeliveryAck(db, ack);
    moveRecoveryAction(db, action, { to: "DELIVERY_ACKED", actor: "buyer", actorLabel: label, evidenceRef, eventType: "RECOVERY_DELIVERY_ACKNOWLEDGED", now: at });
    moveCase(db, record, "DELIVERY_ACKED", { actor: "buyer", evidenceRef }, label, "CASE_DELIVERY_ACKED", at, {});
    return { action: reread(db, action.id), ack };
  });

  let outcome: OutcomeRecording;
  try {
    outcome = await recordRetrievalOutcome(db, { actionId: acked.action.id, registry: input.registry, now: input.now });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    outcome = { status: "PENDING", action: readTransaction(db, () => reread(db, acked.action.id)), reason };
  }
  return { acknowledgementSha256: acknowledgementSha256(acked.action, acked.ack), acknowledgedAt: acked.ack.acknowledgedAt, outcome };
}

/**
 * Has the verifier record RECOVERED on the registry with the artifact digest and the
 * acknowledgement digest. Safe to repeat after a crash or a lost receipt: it reads the chain first,
 * writes only when the case is still reserved, and completes the action from what the chain holds.
 */
export async function recordRetrievalOutcome(
  db: DatabaseSync,
  input: { actionId: string; registry: RegistryGateway | undefined; now: () => Date },
): Promise<OutcomeRecording> {
  const read = readTransaction(db, () => {
    const action = getRecoveryAction(db, input.actionId);
    if (action === undefined) throw new RecoveryRefusedError("ACTION_NOT_FOUND", `Recovery action ${input.actionId} does not exist.`);
    const registry = requireRegistry(input.registry, action.proposal);
    if (action.action !== "RETRIEVE") throw new RecoveryRefusedError("WRONG_ACTION_STATE", "Only a retrieval is completed by an acknowledgement.");
    if (action.state === "COMPLETED") return { done: action };
    if (action.state !== "DELIVERY_ACKED" && action.state !== "RECORD_PENDING") {
      throw new RecoveryRefusedError("WRONG_ACTION_STATE", `The retrieval is ${action.state}; it has no acknowledgement to record.`);
    }
    const ack = getDeliveryAck(db, action.proposal.operationId);
    if (ack === undefined) throw new ActionIntegrityError(`recovery action ${action.id} is ${action.state} without a stored acknowledgement`);
    const status = readCaseEvidence(db, action.caseId).case.status;
    if (status === "QUARANTINED") throw new RecoveryRefusedError("CASE_NOT_READY", `Case ${action.caseId} is quarantined; nothing is recorded.`);
    return { action, registry, ack };
  });
  if ("done" in read) return { status: "RECORDED", action: read.done };

  const { action, registry, ack } = read;
  const caseKey = action.proposal.caseKey;
  const commitment = acknowledgementSha256(action, ack);
  let onChain = await registry.readCase(caseKey);
  if (onChain === undefined) throw new RecoveryRefusedError("REGISTRY_TERMS_MISMATCH", `The registry holds no case ${caseKey}.`);
  const mismatch = termsMismatch(onChain, registrationTerms(action.proposal));
  if (mismatch !== undefined) throw new RecoveryRefusedError("REGISTRY_TERMS_MISMATCH", `The registry case has a different ${mismatch}.`);
  if (onChain.state === "RECOVERED") assertOutcome(onChain, ack.artifactSha256, commitment);
  else if (onChain.state !== "RESERVED_RETRIEVE") throw new RecoveryRefusedError("REGISTRY_TERMS_MISMATCH", `The registry case is ${onChain.state}, not reserved for retrieval.`);

  let pending = action;
  if (action.state === "DELIVERY_ACKED") {
    pending = immediateTransaction(db, () => {
      const current = reread(db, action.id);
      if (current.state !== "DELIVERY_ACKED") return current;
      const at = input.now().toISOString();
      moveRecoveryAction(db, current, { to: "RECORD_PENDING", actor: "verifier", actorLabel: "verifier", eventType: "RECOVERY_OUTCOME_PENDING", now: at });
      const record = readCaseEvidence(db, current.caseId).case;
      if (record.status === "DELIVERY_ACKED") moveCase(db, record, "RECORD_PENDING", { actor: "verifier" }, "verifier", "CASE_RECORD_PENDING", at, {});
      return reread(db, current.id);
    });
  }

  let write: RegistryWrite | undefined;
  if (onChain.state === "RESERVED_RETRIEVE") {
    let reverted: RegistryRevertError | undefined;
    try {
      write = await registry.completeRetrieval(caseKey, ack.artifactSha256, commitment);
    } catch (error) {
      // A lost receipt, or a concurrent attempt that landed first and made this one revert: the chain decides.
      if (error instanceof RegistryRevertError) reverted = error;
      else if (!(error instanceof RegistryOutcomeUnknownError)) throw error;
    }
    onChain = await registry.readCase(caseKey);
    if (reverted !== undefined && onChain?.state !== "RECOVERED") throw reverted;
  }
  if (onChain?.state !== "RECOVERED") return { status: "PENDING", action: pending, reason: "the registry has not recorded the outcome yet" };
  assertOutcome(onChain, ack.artifactSha256, commitment);

  return immediateTransaction(db, () => {
    const current = reread(db, action.id);
    if (current.state === "COMPLETED") return { status: "RECORDED" as const, action: current };
    const at = input.now().toISOString();
    const txHash = write?.txHash.toLowerCase();
    const evidenceRef = txHash ?? `registry:${caseKey}:RECOVERED`;
    moveRecoveryAction(db, current, {
      to: "COMPLETED",
      actor: "reconciler",
      actorLabel: "reconciler",
      evidenceRef,
      eventType: "RECOVERY_RETRIEVAL_RECORDED",
      now: at,
      ...(txHash === undefined ? {} : { set: { registryTx: txHash } }),
    });
    const record = readCaseEvidence(db, current.caseId).case;
    if (record.status === "RECORD_PENDING") moveCase(db, record, "RECOVERED", { actor: "reconciler", evidenceRef }, "reconciler", "CASE_RECOVERED", at, {});
    return { status: "RECORDED" as const, action: reread(db, current.id) };
  });
}

/** The acknowledgement commitment the registry records: the stored acknowledgement bound to its case and proposal. */
export function acknowledgementSha256(action: RecoveryActionRecord, ack: DeliveryAckRecord): string {
  return deliveryAckSha256({
    schema: DELIVERY_ACK_SCHEMA,
    caseKey: action.proposal.caseKey,
    actionSha256: action.actionSha256,
    operationId: ack.operationId,
    buyer: ack.buyer as Address,
    artifactSha256: ack.artifactSha256,
    acknowledgedAt: ack.acknowledgedAt,
  });
}

/** The operation's retrieval, for its own buyer only. */
function buyerRetrieval(db: DatabaseSync, operationId: string, buyer: string): { action: RecoveryActionRecord; buyer: string; artifactSha256: string } {
  const operation = getOperation(db, operationId);
  if (operation === undefined) throw new RecoveryRefusedError("ACTION_NOT_FOUND", `Operation ${operationId} does not exist.`);
  if (buyer.toLowerCase() !== operation.buyer) throw new RecoveryRefusedError("ROLE_FORBIDDEN", "Only the operation's buyer can retrieve or acknowledge its result.");
  const record = readCaseForOperation(db, operationId);
  const action = record === undefined ? undefined : getRecoveryActionForCase(db, record.id);
  if (action === undefined || action.action !== "RETRIEVE") throw new RecoveryRefusedError("ACTION_NOT_FOUND", `Operation ${operationId} has no result recovery.`);
  const artifactSha256 = action.proposal.artifactSha256;
  if (artifactSha256 === null) throw new ActionIntegrityError(`retrieval ${action.id} names no artifact`);
  return { action, buyer: operation.buyer, artifactSha256 };
}

function assertReleasable(db: DatabaseSync, action: RecoveryActionRecord, caseStatus: CaseState, now: Date): void {
  const state = freshness(db, action, now);
  if (!state.executable) throw new RecoveryRefusedError("NOT_EXECUTABLE", `The retrieval reservation cannot be executed: ${state.reasons.join("; ")}.`);
  if (caseStatus !== "RESERVED") throw new RecoveryRefusedError("NOT_EXECUTABLE", `The case is ${caseStatus}, not RESERVED.`);
}

async function assertReservedOnChain(registry: RegistryGateway, action: RecoveryActionRecord): Promise<void> {
  const onChain = await registry.readCase(action.proposal.caseKey);
  if (onChain === undefined) throw new RecoveryRefusedError("REGISTRY_TERMS_MISMATCH", `The registry holds no case ${action.proposal.caseKey}.`);
  const mismatch = termsMismatch(onChain, registrationTerms(action.proposal));
  if (mismatch !== undefined) throw new RecoveryRefusedError("REGISTRY_TERMS_MISMATCH", `The registry case has a different ${mismatch}.`);
  if (onChain.state !== "RESERVED_RETRIEVE") throw new RecoveryRefusedError("NOT_EXECUTABLE", `The registry case is ${onChain.state}, not reserved for retrieval.`);
}

/** Reads the artifact and its records from the services and returns the bytes only if every binding check passes. */
async function fetchVerifiedArtifact(
  lookup: ResultLookup,
  operationId: string,
  digest: string,
  recorded: readonly ServiceStatusRecord[],
  timeoutMs: number,
): Promise<Uint8Array> {
  let statusText: string | null;
  let recordsText: string;
  let bytes: Uint8Array | null;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    [statusText, recordsText, bytes] = await Promise.all([
      lookup.jobStatus(operationId, signal),
      lookup.artifactRecords(digest, signal),
      lookup.artifactBytes(digest, signal),
    ]);
  } catch (error) {
    throw new RecoveryRefusedError("DEPENDENCY_UNAVAILABLE", `The job service or artifact store did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lead = readArtifactLead(digest, statusText, recordsText);
  if (lead === undefined) throw new RecoveryRefusedError("DEPENDENCY_UNAVAILABLE", "The job service or artifact store returned an unreadable answer.");
  const reasons = checkArtifactLead(operationId, lead, recorded);
  if (reasons.length > 0) throw new RecoveryRefusedError("ARTIFACT_MISMATCH", reasons.map((reason) => reason.message).join("; "));
  if (bytes === null) throw new RecoveryRefusedError("ARTIFACT_MISMATCH", "The artifact store returned no bytes for the digest.");
  if (sha256Hex(bytes) !== digest) throw new RecoveryRefusedError("ARTIFACT_MISMATCH", "The bytes the artifact store returned do not hash to the expected digest.");
  return bytes;
}

function assertOutcome(onChain: RegistryCase, artifactSha256: string, commitment: string): void {
  if (onChain.outcomeRef !== `0x${artifactSha256}` || onChain.outcomeCommitment !== commitment) {
    throw new RecoveryRefusedError("REGISTRY_OUTCOME_MISMATCH", "The registry recorded a different retrieval outcome; an operator must investigate.");
  }
}

function reread(db: DatabaseSync, id: string): RecoveryActionRecord {
  const action = getRecoveryAction(db, id);
  if (action === undefined) throw new Error(`recovery action ${id} disappeared`);
  return action;
}
