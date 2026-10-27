import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CASE_MACHINE,
  EVIDENCE_LIMITS,
  assertTransition,
  prepareEvidence,
  type Actor,
  type CaseState,
  type EvidenceMediaType,
  type EvidenceProvenance,
  type EvidenceSource,
  type EvidenceSubmission,
  type PreparedEvidence,
  type Redaction,
} from "@settleback/domain";
import { evidenceSnapshotSha256 } from "@settleback/domain/digest";
import { sha256Hex } from "@settleback/domain/hash";
import { immediateTransaction } from "./database.ts";
import { EvidenceConflictError, EvidenceIntegrityError, EvidenceLimitError, OperationNotFoundError } from "./errors.ts";
import { appendEvent } from "./events.ts";

export interface EvidenceRecord {
  id: string;
  operationId: string;
  sequence: number;
  source: EvidenceSource;
  provenance: EvidenceProvenance;
  submittedBy: Actor;
  /** As submitted; stored namespaced by submitter so one role cannot occupy another's event IDs. */
  sourceEventId: string;
  mediaType: EvidenceMediaType;
  observedAt: string | null;
  receivedAt: string;
  /** SHA-256 of the submitted bytes. */
  contentSha256: string;
  /** SHA-256 of `content`, the stored text after redaction. */
  storedSha256: string;
  originalBytes: number;
  redactions: Redaction[];
  content: string;
}

export interface EvidenceSnapshot {
  /** Number of evidence items; it only grows because items cannot be removed. */
  revision: number;
  sha256: string;
}

export interface IngestEvidenceInput extends EvidenceSubmission {
  operationId: string;
  now: string;
  newId?: () => string;
}

/** Case states that return to OPEN when evidence changes; later states keep their action and fail freshness checks instead. */
const REOPEN_ON_EVIDENCE: readonly CaseState[] = ["ASSESSING", "REVIEW_REQUIRED", "UNRESOLVED", "ACTION_PREPARED"];

/**
 * Records one evidence item. Validation and redaction happen before the database is touched.
 * Replaying the same event with the same content returns the existing item; the same event with
 * different content is refused, and the attempt is kept in the audit log. Existing evidence is
 * never overwritten.
 */
export function ingestEvidence(db: DatabaseSync, input: IngestEvidenceInput): { item: EvidenceRecord; created: boolean } {
  const prepared = prepareEvidence(input);
  const newId = input.newId ?? randomUUID;
  const outcome = immediateTransaction(db, () => {
    ensurePolicyEvidence(db, input.operationId, input.now);
    return insertEvidence(db, input.operationId, prepared, input.now, newId);
  });
  if (outcome.kind === "conflict") throw new EvidenceConflictError(input.source, input.sourceEventId);
  return { item: outcome.item, created: outcome.kind === "created" };
}

export function listEvidence(db: DatabaseSync, operationId: string): EvidenceRecord[] {
  return db
    .prepare(
      `SELECT i.*, c.sequence, c.submitted_by, c.media_type, c.original_bytes, c.stored_sha256, c.redactions_json, c.content
       FROM evidence_items i JOIN evidence_contents c ON c.evidence_id = i.id
       WHERE i.operation_id = ? ORDER BY c.sequence`,
    )
    .all(operationId)
    .map(toRecord);
}

export function snapshotOf(operationId: string, items: readonly EvidenceRecord[]): EvidenceSnapshot {
  return {
    revision: items.length,
    sha256: evidenceSnapshotSha256(
      operationId,
      items.map((item) => ({
        id: item.id,
        sequence: item.sequence,
        source: item.source,
        provenance: item.provenance,
        submittedBy: item.submittedBy,
        sourceEventId: item.sourceEventId,
        contentSha256: item.contentSha256,
        storedSha256: item.storedSha256,
      })),
    ),
  };
}

/**
 * Re-hashes stored text and checks every item against its recorded digests. Stored text that no
 * longer matches is reported, never silently used.
 */
export function verifyEvidence(items: readonly EvidenceRecord[]): void {
  for (const item of items) {
    if (sha256Hex(item.content) !== item.storedSha256) {
      throw new EvidenceIntegrityError(`stored text of evidence ${item.id} does not match its recorded digest`);
    }
    if (item.redactions.length === 0 && item.storedSha256 !== item.contentSha256) {
      throw new EvidenceIntegrityError(`evidence ${item.id} has no redactions but its stored text differs from what was submitted`);
    }
  }
}

/**
 * The bound service terms are the operation's first evidence item, so clauses can be cited like
 * any other record. Callers hold the write transaction.
 */
export function ensurePolicyEvidence(db: DatabaseSync, operationId: string, now: string): void {
  const operation = db.prepare("SELECT policy_id, policy_sha256 FROM operations WHERE id = ?").get(operationId);
  if (operation === undefined) throw new OperationNotFoundError(operationId);
  const policy = db.prepare("SELECT content, content_sha256 FROM policies WHERE id = ?").get(String(operation.policy_id));
  if (policy === undefined || policy.content_sha256 !== operation.policy_sha256) {
    throw new EvidenceIntegrityError(`policy ${String(operation.policy_id)} no longer matches the operation's bound terms`);
  }
  const prepared = prepareEvidence({
    submittedBy: "server",
    source: "policy",
    mediaType: "text/plain",
    sourceEventId: String(operation.policy_id),
    content: String(policy.content),
    observedAt: null,
  });
  const outcome = insertEvidence(db, operationId, prepared, now, randomUUID);
  if (outcome.kind === "conflict") throw new EvidenceIntegrityError(`policy evidence for ${operationId} differs from the bound terms`);
}

type InsertOutcome = { kind: "created" | "existing"; item: EvidenceRecord } | { kind: "conflict" };

function insertEvidence(db: DatabaseSync, operationId: string, prepared: PreparedEvidence, now: string, newId: () => string): InsertOutcome {
  if (db.prepare("SELECT 1 FROM operations WHERE id = ?").get(operationId) === undefined) throw new OperationNotFoundError(operationId);

  const storedEventId = `${prepared.submittedBy}:${prepared.sourceEventId}`;
  const contentSha256 = sha256Hex(prepared.content);
  const existing = db
    .prepare("SELECT id, content_sha256 FROM evidence_items WHERE operation_id = ? AND source = ? AND source_event_id = ?")
    .get(operationId, prepared.source, storedEventId);
  if (existing !== undefined) {
    const item = getEvidence(db, String(existing.id));
    if (item === undefined) throw new EvidenceIntegrityError(`evidence ${String(existing.id)} has no stored content`);
    if (existing.content_sha256 === contentSha256 && item.mediaType === prepared.mediaType) return { kind: "existing", item };
    appendEvent(db, {
      entityType: "evidence",
      entityId: item.id,
      eventType: "EVIDENCE_CONFLICT_REJECTED",
      priorRevision: null,
      newRevision: null,
      actor: prepared.submittedBy,
      payloadSha256: contentSha256,
      createdAt: now,
    });
    return { kind: "conflict" };
  }

  enforceLimits(db, operationId, prepared);

  const id = newId();
  const sequence = Number(db.prepare("SELECT count(*) AS n FROM evidence_contents WHERE operation_id = ?").get(operationId)?.n) + 1;
  const storedSha256 = sha256Hex(prepared.storedContent);
  db.prepare(
    `INSERT INTO evidence_items (id, operation_id, source, provenance, source_event_id, observed_at, received_at, content_sha256, content_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, operationId, prepared.source, prepared.provenance, storedEventId, prepared.observedAt, now, contentSha256, `evidence_contents/${id}`);
  db.prepare(
    `INSERT INTO evidence_contents (evidence_id, operation_id, sequence, submitted_by, media_type, original_bytes, stored_sha256, redactions_json, content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    operationId,
    sequence,
    prepared.submittedBy,
    prepared.mediaType,
    prepared.originalBytes,
    storedSha256,
    JSON.stringify(prepared.redactions),
    prepared.storedContent,
  );
  appendEvent(db, {
    entityType: "evidence",
    entityId: id,
    eventType: "EVIDENCE_RECORDED",
    priorRevision: null,
    newRevision: null,
    actor: prepared.submittedBy,
    payloadSha256: contentSha256,
    createdAt: now,
  });
  refreshCase(db, operationId, now);

  const item = getEvidence(db, id);
  if (item === undefined) throw new EvidenceIntegrityError(`evidence ${id} was not stored`);
  return { kind: "created", item };
}

function enforceLimits(db: DatabaseSync, operationId: string, prepared: PreparedEvidence): void {
  const totals = db
    .prepare(
      `SELECT count(*) AS items, coalesce(sum(c.original_bytes), 0) AS bytes,
              coalesce(sum(i.provenance = 'CLAIM'), 0) AS claim_items,
              coalesce(sum(CASE WHEN i.provenance = 'CLAIM' THEN c.original_bytes ELSE 0 END), 0) AS claim_bytes
       FROM evidence_items i JOIN evidence_contents c ON c.evidence_id = i.id WHERE i.operation_id = ?`,
    )
    .get(operationId);
  const items = Number(totals?.items);
  const bytes = Number(totals?.bytes);
  if (items + 1 > EVIDENCE_LIMITS.maxItemsPerCase) {
    throw new EvidenceLimitError(`a case may hold at most ${EVIDENCE_LIMITS.maxItemsPerCase} evidence items`);
  }
  if (bytes + prepared.originalBytes > EVIDENCE_LIMITS.maxCaseBytes) {
    throw new EvidenceLimitError(`evidence for a case may not exceed ${EVIDENCE_LIMITS.maxCaseBytes} bytes`);
  }
  if (prepared.provenance !== "CLAIM") return;
  if (Number(totals?.claim_items) + 1 > EVIDENCE_LIMITS.maxClaimItemsPerCase) {
    throw new EvidenceLimitError(`a case may hold at most ${EVIDENCE_LIMITS.maxClaimItemsPerCase} claims`);
  }
  if (Number(totals?.claim_bytes) + prepared.originalBytes > EVIDENCE_LIMITS.maxClaimBytesPerCase) {
    throw new EvidenceLimitError(`claims for a case may not exceed ${EVIDENCE_LIMITS.maxClaimBytesPerCase} bytes`);
  }
}

/** Moves an open case to the new snapshot and, before any reservation, back to OPEN for reassessment. */
function refreshCase(db: DatabaseSync, operationId: string, now: string): void {
  const row = db.prepare("SELECT id, status, revision FROM cases WHERE operation_id = ?").get(operationId);
  if (row === undefined) return;
  const status = String(row.status) as CaseState;
  const revision = Number(row.revision);
  let next = status;
  if (REOPEN_ON_EVIDENCE.includes(status)) {
    assertTransition(CASE_MACHINE, status, "OPEN", { actor: "server" });
    next = "OPEN";
  }
  const snapshot = snapshotOf(operationId, listEvidence(db, operationId));
  const updated = db
    .prepare("UPDATE cases SET status = ?, evidence_sha256 = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
    .run(next, snapshot.sha256, revision + 1, now, String(row.id), revision);
  if (updated.changes !== 1) throw new Error(`case ${String(row.id)} changed during evidence ingestion`);
  appendEvent(db, {
    entityType: "case",
    entityId: String(row.id),
    eventType: next === status ? "CASE_EVIDENCE_CHANGED" : "CASE_REOPENED_ON_EVIDENCE",
    priorRevision: revision,
    newRevision: revision + 1,
    actor: "server",
    payloadSha256: snapshot.sha256,
    createdAt: now,
  });
}

function getEvidence(db: DatabaseSync, id: string): EvidenceRecord | undefined {
  const row = db
    .prepare(
      `SELECT i.*, c.sequence, c.submitted_by, c.media_type, c.original_bytes, c.stored_sha256, c.redactions_json, c.content
       FROM evidence_items i JOIN evidence_contents c ON c.evidence_id = i.id WHERE i.id = ?`,
    )
    .get(id);
  return row === undefined ? undefined : toRecord(row);
}

function toRecord(row: Record<string, unknown>): EvidenceRecord {
  const submittedBy = String(row.submitted_by) as Actor;
  const storedEventId = String(row.source_event_id);
  const prefix = `${submittedBy}:`;
  if (!storedEventId.startsWith(prefix)) throw new EvidenceIntegrityError(`evidence ${String(row.id)} has an event ID outside its submitter's namespace`);
  return {
    id: String(row.id),
    operationId: String(row.operation_id),
    sequence: Number(row.sequence),
    source: String(row.source) as EvidenceSource,
    provenance: String(row.provenance) as EvidenceProvenance,
    submittedBy,
    sourceEventId: storedEventId.slice(prefix.length),
    mediaType: String(row.media_type) as EvidenceMediaType,
    observedAt: row.observed_at === null ? null : String(row.observed_at),
    receivedAt: String(row.received_at),
    contentSha256: String(row.content_sha256),
    storedSha256: String(row.stored_sha256),
    originalBytes: Number(row.original_bytes),
    redactions: JSON.parse(String(row.redactions_json)) as Redaction[],
    content: String(row.content),
  };
}
