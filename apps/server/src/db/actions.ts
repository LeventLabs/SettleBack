import type { DatabaseSync } from "node:sqlite";
import {
  REPAY_ACTION_MACHINE,
  RETRIEVE_ACTION_MACHINE,
  assertTransition,
  proposalSha256,
  type Actor,
  type RecoveryActionState,
  type RecoveryProposal,
} from "@settleback/domain";
import { ActionIntegrityError } from "./errors.ts";
import { appendEvent } from "./events.ts";

export interface RecoveryActionRecord {
  id: string;
  caseId: string;
  action: "RETRIEVE" | "REPAY";
  authorizationMode: "PER_CASE" | "STANDING_POLICY" | null;
  /** The registry scope (seller, payment chain, token) of a standing policy. */
  authorizationScope: string | null;
  /** The registry authorization ID of the policy version. */
  authorizationVersion: number | null;
  actionSha256: string;
  evidenceSha256: string;
  deadline: string;
  state: RecoveryActionState;
  revision: number;
  /** The seller's per-case reservation, or the verifier's retrieval reservation. */
  approvalTx: string | null;
  /** The delegate's reservation under a standing policy. */
  policyTx: string | null;
  /** The registry outcome write. */
  registryTx: string | null;
  createdAt: string;
  updatedAt: string;
  proposal: RecoveryProposal;
}

/** Callers hold the transaction. The digest columns come from the proposal, never from the caller. */
export function insertRecoveryAction(db: DatabaseSync, input: { id: string; proposal: RecoveryProposal; now: string }): void {
  const { proposal } = input;
  const digest = proposalSha256(proposal);
  const authorization = proposal.authorization;
  db.prepare(
    `INSERT INTO recovery_actions (id, case_id, action, authorization_mode, authorization_id, authorization_version, action_sha256,
       evidence_sha256, amount_base_units, payer, payee, chain_id, token, deadline, state, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', 0, ?, ?)`,
  ).run(
    input.id,
    proposal.caseId,
    proposal.action,
    authorization?.mode ?? null,
    authorization?.mode === "STANDING_POLICY" ? authorization.scope : null,
    authorization?.mode === "STANDING_POLICY" ? authorization.version : null,
    digest,
    proposal.evidenceSha256,
    proposal.transfer?.amountBaseUnits ?? null,
    proposal.transfer?.payer ?? null,
    proposal.transfer?.payee ?? null,
    proposal.transfer?.chainId ?? null,
    proposal.transfer?.token ?? null,
    proposal.deadline,
    input.now,
    input.now,
  );
  db.prepare("INSERT INTO recovery_proposals (action_id, proposal_json, proposal_sha256) VALUES (?, ?, ?)").run(input.id, JSON.stringify(proposal), digest);
}

export function getRecoveryAction(db: DatabaseSync, id: string): RecoveryActionRecord | undefined {
  return actionRow(db, "a.id", id);
}

export function getRecoveryActionForCase(db: DatabaseSync, caseId: string): RecoveryActionRecord | undefined {
  return actionRow(db, "a.case_id", caseId);
}

export interface ActionMove {
  to: RecoveryActionState;
  actor: Actor;
  actorLabel: string;
  evidenceRef?: string;
  eventType: string;
  now: string;
  set?: { approvalTx?: string; policyTx?: string; registryTx?: string };
}

/** Moves an action through its kind's state machine with a compare-and-swap on its revision. Callers hold the transaction. */
export function moveRecoveryAction(db: DatabaseSync, record: RecoveryActionRecord, move: ActionMove): void {
  const machine = record.action === "REPAY" ? REPAY_ACTION_MACHINE : RETRIEVE_ACTION_MACHINE;
  assertTransition(machine, record.state, move.to, { actor: move.actor, ...(move.evidenceRef === undefined ? {} : { evidenceRef: move.evidenceRef }) });
  const updated = db
    .prepare(
      `UPDATE recovery_actions SET state = ?, revision = ?, updated_at = ?,
         approval_tx = coalesce(?, approval_tx), policy_tx = coalesce(?, policy_tx), registry_tx = coalesce(?, registry_tx)
       WHERE id = ? AND revision = ?`,
    )
    .run(move.to, record.revision + 1, move.now, move.set?.approvalTx ?? null, move.set?.policyTx ?? null, move.set?.registryTx ?? null, record.id, record.revision);
  if (updated.changes !== 1) throw new Error(`recovery action ${record.id} changed concurrently`);
  appendEvent(db, {
    entityType: "recovery_action",
    entityId: record.id,
    eventType: move.eventType,
    priorRevision: record.revision,
    newRevision: record.revision + 1,
    actor: move.actorLabel,
    payloadSha256: record.actionSha256,
    createdAt: move.now,
  });
}

/**
 * Reads an action with its proposal and checks that they agree: the stored proposal hashes to the
 * action's digest, and every column other checks query matches the proposal.
 */
function actionRow(db: DatabaseSync, column: "a.id" | "a.case_id", value: string): RecoveryActionRecord | undefined {
  const row = db
    .prepare(`SELECT a.*, p.proposal_json, p.proposal_sha256 FROM recovery_actions a LEFT JOIN recovery_proposals p ON p.action_id = a.id WHERE ${column} = ?`)
    .get(value);
  if (row === undefined) return undefined;
  const id = String(row.id);
  if (row.proposal_json === null || row.proposal_json === undefined) throw new ActionIntegrityError(`recovery action ${id} has no stored proposal`);
  const proposal = JSON.parse(String(row.proposal_json)) as RecoveryProposal;
  const digest = proposalSha256(proposal);
  if (digest !== row.action_sha256 || digest !== row.proposal_sha256) throw new ActionIntegrityError(`recovery action ${id} does not match its proposal digest`);
  const transfer = proposal.transfer;
  const authorization = proposal.authorization;
  const consistent =
    proposal.caseId === String(row.case_id) &&
    proposal.action === String(row.action) &&
    proposal.evidenceSha256 === String(row.evidence_sha256) &&
    proposal.deadline === String(row.deadline) &&
    (authorization?.mode ?? null) === (row.authorization_mode ?? null) &&
    (transfer?.amountBaseUnits ?? null) === (row.amount_base_units ?? null) &&
    (transfer?.payer ?? null) === (row.payer ?? null) &&
    (transfer?.payee ?? null) === (row.payee ?? null) &&
    (transfer?.chainId ?? null) === (row.chain_id === null ? null : Number(row.chain_id)) &&
    (transfer?.token ?? null) === (row.token ?? null);
  if (!consistent) throw new ActionIntegrityError(`recovery action ${id} columns differ from its proposal`);
  return {
    id,
    caseId: String(row.case_id),
    action: String(row.action) as RecoveryActionRecord["action"],
    authorizationMode: row.authorization_mode === null ? null : (String(row.authorization_mode) as "PER_CASE" | "STANDING_POLICY"),
    authorizationScope: row.authorization_id === null ? null : String(row.authorization_id),
    authorizationVersion: row.authorization_version === null ? null : Number(row.authorization_version),
    actionSha256: String(row.action_sha256),
    evidenceSha256: String(row.evidence_sha256),
    deadline: String(row.deadline),
    state: String(row.state) as RecoveryActionState,
    revision: Number(row.revision),
    approvalTx: row.approval_tx === null ? null : String(row.approval_tx),
    policyTx: row.policy_tx === null ? null : String(row.policy_tx),
    registryTx: row.registry_tx === null ? null : String(row.registry_tx),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    proposal,
  };
}

