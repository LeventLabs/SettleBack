import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTORS,
  CASE_MACHINE,
  EVIDENCE_LIMITS,
  EVIDENCE_MEDIA_TYPES,
  EVIDENCE_PROVENANCES,
  EVIDENCE_SOURCES,
  InvalidEvidenceError,
  checkFreshness,
} from "@settleback/domain";
import { sha256Hex } from "@settleback/domain/hash";
import { getCase, loadCaseEvidence, openCase } from "../../src/db/cases.ts";
import { EvidenceConflictError, EvidenceIntegrityError, EvidenceLimitError, OperationNotFoundError } from "../../src/db/errors.ts";
import { ingestEvidence, listEvidence, type IngestEvidenceInput } from "../../src/db/evidence.ts";
import { BUYER, NOW, memoryDatabase, seedOperation } from "./helpers.ts";

let db: DatabaseSync;
let operationId: string;

beforeEach(() => {
  db = memoryDatabase();
  operationId = seedOperation(db);
});

afterEach(() => {
  db.close();
});

function evidence(overrides: Partial<IngestEvidenceInput> = {}): IngestEvidenceInput {
  return {
    operationId,
    submittedBy: "service",
    source: "worker-log",
    mediaType: "text/plain",
    sourceEventId: "req-1/worker-log",
    content: "2026-10-30T10:00:33.040Z INFO [wk-1a2b3c4d] artifact stored",
    observedAt: "2026-10-30T10:01:00.000Z",
    now: NOW,
    ...overrides,
  };
}

const count = (table: string): number => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
const events = (type: string): number => Number(db.prepare("SELECT count(*) AS n FROM events WHERE event_type = ?").get(type)?.n);

describe("ingestEvidence", () => {
  it("records the bound policy first, then the item, with provenance from the submitter", () => {
    const { item, created } = ingestEvidence(db, evidence());
    expect(created).toBe(true);
    const items = listEvidence(db, operationId);
    expect(items.map((entry) => [entry.sequence, entry.source, entry.provenance, entry.submittedBy])).toEqual([
      [1, "policy", "POLICY", "server"],
      [2, "worker-log", "AUTHENTICATED_SERVICE", "service"],
    ]);
    expect(item.contentSha256).toBe(sha256Hex(evidence().content));
    expect(item.storedSha256).toBe(item.contentSha256);
    expect(item.sourceEventId).toBe("req-1/worker-log");
    expect(events("EVIDENCE_RECORDED")).toBe(2);
  });

  it("returns the existing item for an identical replay", () => {
    const first = ingestEvidence(db, evidence());
    const replay = ingestEvidence(db, evidence({ now: "2026-10-30T11:00:00.000Z" }));
    expect(replay.created).toBe(false);
    expect(replay.item).toEqual(first.item);
    expect(count("evidence_items")).toBe(2);
  });

  it("refuses different content under the same event, keeps the original, and audits the attempt", () => {
    const first = ingestEvidence(db, evidence());
    expect(() => ingestEvidence(db, evidence({ content: "2026-10-30T10:00:33.040Z INFO [wk-1a2b3c4d] job failed" }))).toThrow(
      EvidenceConflictError,
    );
    expect(listEvidence(db, operationId).find((entry) => entry.id === first.item.id)?.content).toBe(evidence().content);
    expect(events("EVIDENCE_CONFLICT_REJECTED")).toBe(1);
  });

  it("keeps each submitter's event IDs apart, so a pasted claim cannot occupy the service's event", () => {
    ingestEvidence(db, evidence({ submittedBy: "seller", content: "pasted: job completed" }));
    const authentic = ingestEvidence(db, evidence());
    expect(authentic.created).toBe(true);
    expect(listEvidence(db, operationId).map((entry) => entry.provenance)).toEqual(["POLICY", "CLAIM", "AUTHENTICATED_SERVICE"]);
  });

  it("stores redacted text while recording the hash of what was submitted", () => {
    const content = "POST /callback Authorization: Bearer abc.def.ghi api_key=k-123";
    const { item } = ingestEvidence(db, evidence({ content }));
    expect(item.content).toBe("POST /callback Authorization: Bearer [REDACTED:authorization] api_key=[REDACTED:credential]");
    expect(item.contentSha256).toBe(sha256Hex(content));
    expect(item.storedSha256).toBe(sha256Hex(item.content));
    expect(item.redactions).toEqual([
      { kind: "authorization", count: 1 },
      { kind: "credential", count: 1 },
    ]);
  });

  it("refuses invalid evidence before anything is written", () => {
    const before = { items: count("evidence_items"), events: count("events") };
    expect(() => ingestEvidence(db, evidence({ content: "x".repeat(EVIDENCE_LIMITS.maxItemBytes + 1) }))).toThrow(InvalidEvidenceError);
    expect(() => ingestEvidence(db, evidence({ submittedBy: "assessor" }))).toThrow(InvalidEvidenceError);
    expect(() => ingestEvidence(db, evidence({ submittedBy: "buyer" }))).toThrow(InvalidEvidenceError);
    expect(() => ingestEvidence(db, evidence({ operationId: "missing" }))).toThrow(OperationNotFoundError);
    expect({ items: count("evidence_items"), events: count("events") }).toEqual(before);
  });

  it("enforces the per-case item limit, counting the policy", () => {
    for (let i = 1; i < EVIDENCE_LIMITS.maxItemsPerCase; i += 1) ingestEvidence(db, evidence({ sourceEventId: `e-${i}`, content: `line ${i}` }));
    expect(count("evidence_items")).toBe(EVIDENCE_LIMITS.maxItemsPerCase);
    expect(() => ingestEvidence(db, evidence({ sourceEventId: "e-over", content: "one too many" }))).toThrow(EvidenceLimitError);
    expect(count("evidence_items")).toBe(EVIDENCE_LIMITS.maxItemsPerCase);
  });

  it("enforces the per-case byte limit", () => {
    const big = "x".repeat(EVIDENCE_LIMITS.maxItemBytes);
    for (let i = 0; i < 3; i += 1) ingestEvidence(db, evidence({ sourceEventId: `big-${i}`, content: `${i}${big.slice(1)}` }));
    expect(() => ingestEvidence(db, evidence({ sourceEventId: "big-3", content: `3${big.slice(1)}` }))).toThrow(EvidenceLimitError);
  });

  it("caps claims at half of each budget, leaving room for service and gateway records", () => {
    for (let i = 0; i < EVIDENCE_LIMITS.maxClaimItemsPerCase; i += 1) {
      ingestEvidence(db, evidence({ submittedBy: "buyer", source: "buyer-claim", sourceEventId: `claim-${i}`, content: `claim ${i}` }));
    }
    expect(() => ingestEvidence(db, evidence({ submittedBy: "buyer", source: "buyer-claim", sourceEventId: "claim-x", content: "more" }))).toThrow(
      EvidenceLimitError,
    );
    expect(ingestEvidence(db, evidence()).created).toBe(true);
  });
});

describe("evidence schema", () => {
  it("refuses updates and deletes of stored evidence", () => {
    const { item } = ingestEvidence(db, evidence());
    expect(() => db.prepare("UPDATE evidence_contents SET content = 'edited' WHERE evidence_id = ?").run(item.id)).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM evidence_contents WHERE evidence_id = ?").run(item.id)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE evidence_items SET provenance = 'AUTHENTICATED_SERVICE' WHERE id = ?").run(item.id)).toThrow(/immutable/);
  });

  it("refuses a sequence gap, contents for another operation, and more than the byte limit, even from direct SQL", () => {
    const otherOperation = seedOperation(db, "op-key-0002", { requestSha256: "b".repeat(64) });
    const insertItem = (id: string, op: string) =>
      db
        .prepare(
          `INSERT INTO evidence_items (id, operation_id, source, provenance, source_event_id, received_at, content_sha256, content_path)
           VALUES (?, ?, 'worker-log', 'AUTHENTICATED_SERVICE', ?, ?, ?, 'x')`,
        )
        .run(id, op, `service:${id}`, NOW, "c".repeat(64));
    const insertContent = (id: string, op: string, sequence: number, bytes: number) =>
      db
        .prepare(
          `INSERT INTO evidence_contents (evidence_id, operation_id, sequence, submitted_by, media_type, original_bytes, stored_sha256, redactions_json, content)
           VALUES (?, ?, ?, 'service', 'text/plain', ?, ?, '[]', 'text')`,
        )
        .run(id, op, sequence, bytes, "c".repeat(64));
    insertItem("raw-1", operationId);
    expect(() => insertContent("raw-1", operationId, 2, 10)).toThrow(/next position/);
    expect(() => insertContent("raw-1", otherOperation, 1, 10)).toThrow(/belong to the operation/);
    insertContent("raw-1", operationId, 1, 262_144);
    for (let i = 2; i <= 4; i += 1) {
      insertItem(`raw-${i}`, operationId);
      insertContent(`raw-${i}`, operationId, i, 262_144);
    }
    insertItem("raw-5", operationId);
    expect(() => insertContent("raw-5", operationId, 5, 1)).toThrow(/may not exceed 1048576/);
  });

  it("accepts every domain source, provenance, media type, and submitting actor, and nothing else", () => {
    const insert = db.prepare(
      `INSERT INTO evidence_items (id, operation_id, source, provenance, source_event_id, received_at, content_sha256, content_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'x')`,
    );
    let n = 0;
    for (const source of EVIDENCE_SOURCES) {
      for (const provenance of EVIDENCE_PROVENANCES) {
        n += 1;
        expect(() => insert.run(`s-${n}`, operationId, source, provenance, `e-${n}`, NOW, "c".repeat(64))).not.toThrow();
      }
    }
    expect(() => insert.run("bad-source", operationId, "email", "CLAIM", "e-x", NOW, "c".repeat(64))).toThrow(/CHECK/);
    expect(() => insert.run("bad-prov", operationId, "worker-log", "TRUSTED", "e-y", NOW, "c".repeat(64))).toThrow(/CHECK/);

    const submitters = ACTORS.filter((actor) => actor !== "assessor" && actor !== "verifier");
    const content = db.prepare(
      `INSERT INTO evidence_contents (evidence_id, operation_id, sequence, submitted_by, media_type, original_bytes, stored_sha256, redactions_json, content)
       VALUES (?, ?, ?, ?, ?, 1, ?, '[]', 'x')`,
    );
    let sequence = 0;
    for (const submitter of submitters) {
      for (const mediaType of EVIDENCE_MEDIA_TYPES) {
        sequence += 1;
        expect(() => content.run(`s-${sequence}`, operationId, sequence, submitter, mediaType, "c".repeat(64)), submitter).not.toThrow();
      }
    }
    sequence += 1;
    expect(() => content.run(`s-${sequence}`, operationId, sequence, "assessor", "text/plain", "c".repeat(64))).toThrow(/CHECK/);
    expect(() => content.run(`s-${sequence}`, operationId, sequence, "service", "text/html", "c".repeat(64))).toThrow(/CHECK/);
  });

  it("detects stored text that no longer matches its digest", () => {
    const { case: opened } = openCase(db, { operationId, openedBy: { role: "buyer", identity: BUYER }, now: NOW });
    const { item } = ingestEvidence(db, evidence());
    db.exec("DROP TRIGGER evidence_contents_no_update");
    db.prepare("UPDATE evidence_contents SET content = 'tampered' WHERE evidence_id = ?").run(item.id);
    expect(() => loadCaseEvidence(db, opened.id)).toThrow(EvidenceIntegrityError);
  });
});

describe("case snapshots follow evidence", () => {
  it("advances the evidence revision and snapshot with each new item and keeps conflicting records side by side", () => {
    const { case: opened } = openCase(db, { operationId, openedBy: { role: "buyer", identity: BUYER }, now: NOW });
    expect(opened.evidence.revision).toBe(1);
    const running = JSON.stringify({ operationId, externalJobId: "wk-1", state: "RUNNING", artifactSha256: null, computeStarted: true, history: [] });
    const failed = JSON.stringify({ operationId, externalJobId: "wk-1", state: "FAILED", artifactSha256: null, computeStarted: true, history: [] });
    ingestEvidence(db, evidence({ source: "service-status", mediaType: "application/json", sourceEventId: "status-1", content: running }));
    ingestEvidence(db, evidence({ source: "service-status", mediaType: "application/json", sourceEventId: "status-2", content: failed }));
    const current = getCase(db, opened.id);
    expect(current?.evidence.revision).toBe(3);
    expect(current?.revision).toBe(2);
    expect(current?.evidence.sha256).not.toBe(opened.evidence.sha256);
    const statuses = loadCaseEvidence(db, opened.id).items.filter((entry) => entry.source === "service-status");
    expect(statuses.map((entry) => JSON.parse(entry.content).state)).toEqual(["RUNNING", "FAILED"]);
  });

  it("sends a case under review back to OPEN when evidence changes", () => {
    const { case: opened } = openCase(db, { operationId, openedBy: { role: "buyer", identity: BUYER }, now: NOW });
    db.prepare("UPDATE cases SET status = 'REVIEW_REQUIRED', revision = revision + 1 WHERE id = ?").run(opened.id);
    ingestEvidence(db, evidence());
    expect(getCase(db, opened.id)?.status).toBe("OPEN");
    expect(events("CASE_REOPENED_ON_EVIDENCE")).toBe(1);
    expect(CASE_MACHINE.edges.REVIEW_REQUIRED?.OPEN?.actors).toEqual(["server"]);
  });

  it("keeps a reserved case reserved, but its reservation is stale against the new evidence revision", () => {
    const { case: opened } = openCase(db, { operationId, openedBy: { role: "buyer", identity: BUYER }, now: NOW });
    db.prepare("UPDATE cases SET status = 'RESERVED', revision = revision + 1 WHERE id = ?").run(opened.id);
    const reservedAt = opened.evidence.revision;
    ingestEvidence(db, evidence());
    const current = getCase(db, opened.id);
    expect(current?.status).toBe("RESERVED");
    const freshness = checkFreshness(
      { policySha256: "p", evidenceRevision: reservedAt, deadline: "2026-10-30T12:00:00.000Z" },
      { policySha256: "p", evidenceRevision: current?.evidence.revision ?? -1, now: NOW },
    );
    expect(freshness.ok === false && freshness.reasons.map((reason) => reason.code)).toEqual(["STALE_EVIDENCE"]);
  });
});
