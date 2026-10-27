import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CaseState } from "@settleback/domain";
import { immediateTransaction, readTransaction } from "./database.ts";
import { CaseNotFoundError, CaseOpenForbiddenError, EvidenceIntegrityError, OperationNotFoundError } from "./errors.ts";
import { appendEvent } from "./events.ts";
import { ensurePolicyEvidence, listEvidence, snapshotOf, verifyEvidence, type EvidenceRecord, type EvidenceSnapshot } from "./evidence.ts";

export interface CaseRecord {
  id: string;
  operationId: string;
  status: CaseState;
  /** Row version for compare-and-swap; advances on every change. */
  revision: number;
  evidence: EvidenceSnapshot;
  openedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaseOpener {
  role: "buyer" | "operator";
  /** The buyer's wallet address, or the operator's identity. */
  identity: string;
}

export interface OpenCaseInput {
  operationId: string;
  openedBy: CaseOpener;
  now: string;
  newId?: () => string;
}

/**
 * Opens the operation's case, or returns it if one exists: an operation has at most one case,
 * however many times or by whom it is opened. Only the operation's buyer or an operator may open it.
 */
export function openCase(db: DatabaseSync, input: OpenCaseInput): { case: CaseRecord; created: boolean } {
  return immediateTransaction(db, () => {
    const operation = db.prepare("SELECT buyer FROM operations WHERE id = ?").get(input.operationId);
    if (operation === undefined) throw new OperationNotFoundError(input.operationId);
    const openedBy = authorizeOpener(input.openedBy, String(operation.buyer));

    const existing = caseRow(db, "operation_id", input.operationId);
    if (existing !== undefined) return { case: existing, created: false };

    ensurePolicyEvidence(db, input.operationId, input.now);
    const snapshot = snapshotOf(input.operationId, listEvidence(db, input.operationId));
    const id = (input.newId ?? randomUUID)();
    db.prepare(
      `INSERT INTO cases (id, operation_id, status, revision, evidence_sha256, opened_by, created_at, updated_at)
       VALUES (?, ?, 'OPEN', 0, ?, ?, ?, ?)`,
    ).run(id, input.operationId, snapshot.sha256, openedBy, input.now, input.now);
    appendEvent(db, {
      entityType: "case",
      entityId: id,
      eventType: "CASE_OPENED",
      priorRevision: null,
      newRevision: 0,
      actor: openedBy,
      payloadSha256: snapshot.sha256,
      createdAt: input.now,
    });
    const created = caseRow(db, "id", id);
    if (created === undefined) throw new Error(`case ${id} was not stored`);
    return { case: created, created: true };
  });
}

export function getCase(db: DatabaseSync, id: string): CaseRecord | undefined {
  return readTransaction(db, () => caseRow(db, "id", id));
}

/**
 * The case with its evidence, after checking every stored item against its digests and the
 * snapshot recorded on the case.
 */
export function loadCaseEvidence(db: DatabaseSync, caseId: string): { case: CaseRecord; items: EvidenceRecord[] } {
  return readTransaction(db, () => readCaseEvidence(db, caseId));
}

/** As loadCaseEvidence, for callers that already hold a transaction. */
export function readCaseEvidence(db: DatabaseSync, caseId: string): { case: CaseRecord; items: EvidenceRecord[] } {
  const record = caseRow(db, "id", caseId);
  if (record === undefined) throw new CaseNotFoundError(caseId);
  const items = listEvidence(db, record.operationId);
  verifyEvidence(items);
  return { case: record, items };
}

function authorizeOpener(opener: CaseOpener, buyer: string): string {
  if (opener.role === "buyer") {
    if (opener.identity.toLowerCase() !== buyer) throw new CaseOpenForbiddenError("Only the operation's buyer can open its case.");
    return `buyer:${buyer}`;
  }
  if (opener.role === "operator") {
    if (opener.identity.trim() === "") throw new CaseOpenForbiddenError("An operator identity is required.");
    return `operator:${opener.identity}`;
  }
  throw new CaseOpenForbiddenError("Only a buyer or an operator can open a case.");
}

/**
 * Reads a case and checks its recorded snapshot against the stored evidence; the evidence revision
 * is derived from the items, never stored separately.
 */
function caseRow(db: DatabaseSync, column: "id" | "operation_id", value: string): CaseRecord | undefined {
  const row = db.prepare(`SELECT * FROM cases WHERE ${column} = ?`).get(value);
  if (row === undefined) return undefined;
  const operationId = String(row.operation_id);
  const snapshot = snapshotOf(operationId, listEvidence(db, operationId));
  if (row.evidence_sha256 !== snapshot.sha256) {
    throw new EvidenceIntegrityError(`case ${String(row.id)} records a different evidence snapshot than the stored items`);
  }
  return {
    id: String(row.id),
    operationId,
    status: String(row.status) as CaseState,
    revision: Number(row.revision),
    evidence: snapshot,
    openedBy: String(row.opened_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
