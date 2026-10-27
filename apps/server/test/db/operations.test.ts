import { describe, expect, it } from "vitest";
import { InvalidOperationIntentError } from "@settleback/domain";
import { operationIntentSha256 } from "@settleback/domain/digest";
import {
  IdempotencyConflictError,
  PolicyMismatchError,
  PolicyNotFoundError,
  PolicyVersionConflictError,
} from "../../src/db/errors.ts";
import { createOperation, getOperation, registerPolicy } from "../../src/db/operations.ts";
import { BUYER, NOW, memoryDatabase, sampleIntent, seedPolicy } from "./helpers.ts";

describe("registerPolicy", () => {
  it("is idempotent for identical content and refuses changed content under the same id", () => {
    const db = memoryDatabase();
    try {
      const first = registerPolicy(db, { id: "terms-v1", content: "Original terms.", now: NOW });
      const again = registerPolicy(db, { id: "terms-v1", content: "Original terms.", now: NOW });
      expect(first.created).toBe(true);
      expect(again.created).toBe(false);
      expect(again.policy.contentSha256).toBe(first.policy.contentSha256);
      expect(() => registerPolicy(db, { id: "terms-v1", content: "Edited terms.", now: NOW })).toThrow(
        PolicyVersionConflictError,
      );
      expect(() => db.prepare("UPDATE policies SET content = 'x' WHERE id = 'terms-v1'").run()).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});

describe("createOperation", () => {
  it("returns the same operation for a repeated request with the same key and body", () => {
    const db = memoryDatabase();
    try {
      const policySha256 = seedPolicy(db);
      const input = { actor: BUYER, idempotencyKey: "key-00000001", intent: sampleIntent(policySha256), environment: "local" as const, now: NOW };
      const first = createOperation(db, input);
      const replay = createOperation(db, input);
      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(replay.operation).toEqual(first.operation);
      expect(db.prepare("SELECT count(*) AS n FROM operations").get()?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rejects the same key with a different body, without creating anything", () => {
    const db = memoryDatabase();
    try {
      const policySha256 = seedPolicy(db);
      const base = { actor: BUYER, idempotencyKey: "key-00000002", environment: "local" as const, now: NOW };
      createOperation(db, { ...base, intent: sampleIntent(policySha256) });
      expect(() =>
        createOperation(db, { ...base, intent: sampleIntent(policySha256, { amountBaseUnits: "2000000", priceUsd: "2.00" }) }),
      ).toThrow(IdempotencyConflictError);
      expect(db.prepare("SELECT count(*) AS n FROM operations").get()?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("scopes idempotency keys to the caller", () => {
    const db = memoryDatabase();
    try {
      const policySha256 = seedPolicy(db);
      const intent = sampleIntent(policySha256);
      const a = createOperation(db, { actor: BUYER, idempotencyKey: "key-shared-1", intent, environment: "local", now: NOW });
      const b = createOperation(db, { actor: "other-client", idempotencyKey: "key-shared-1", intent, environment: "local", now: NOW });
      expect(b.operation.id).not.toBe(a.operation.id);
    } finally {
      db.close();
    }
  });

  it("requires the referenced policy to exist with the stated content hash", () => {
    const db = memoryDatabase();
    try {
      const base = { actor: BUYER, idempotencyKey: "key-00000003", environment: "local" as const, now: NOW };
      expect(() => createOperation(db, { ...base, intent: sampleIntent("0".repeat(64)) })).toThrow(PolicyNotFoundError);
      seedPolicy(db);
      expect(() => createOperation(db, { ...base, intent: sampleIntent("0".repeat(64)) })).toThrow(PolicyMismatchError);
    } finally {
      db.close();
    }
  });

  it("rejects invalid intents before touching the database", () => {
    const db = memoryDatabase();
    try {
      const policySha256 = seedPolicy(db);
      const base = { actor: BUYER, idempotencyKey: "key-00000004", environment: "local" as const, now: NOW };
      expect(() => createOperation(db, { ...base, intent: sampleIntent(policySha256, { amountBaseUnits: "1.5" }) })).toThrow(
        InvalidOperationIntentError,
      );
      expect(db.prepare("SELECT count(*) AS n FROM idempotency_records").get()?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it("round-trips the stored intent to the same digest and records an audit event", () => {
    const db = memoryDatabase();
    try {
      const policySha256 = seedPolicy(db);
      const { operation } = createOperation(db, {
        actor: BUYER,
        idempotencyKey: "key-00000005",
        intent: sampleIntent(policySha256),
        environment: "local",
        now: NOW,
      });
      const stored = getOperation(db, operation.id);
      if (stored === undefined) throw new Error("operation not stored");
      const { id: _id, environment: _env, intentSha256, createdAt: _at, ...intent } = stored;
      expect(operationIntentSha256(intent)).toBe(intentSha256);
      const event = db.prepare("SELECT event_type, payload_sha256 FROM events WHERE entity_id = ?").get(operation.id);
      expect(event).toEqual({ event_type: "OPERATION_CREATED", payload_sha256: intentSha256 });
    } finally {
      db.close();
    }
  });

  it("keeps operations immutable and permanent", () => {
    const db = memoryDatabase();
    try {
      const policySha256 = seedPolicy(db);
      const { operation } = createOperation(db, {
        actor: BUYER,
        idempotencyKey: "key-00000006",
        intent: sampleIntent(policySha256),
        environment: "local",
        now: NOW,
      });
      expect(() => db.prepare("UPDATE operations SET amount_base_units = '1' WHERE id = ?").run(operation.id)).toThrow(
        /immutable/,
      );
      expect(() => db.prepare("DELETE FROM operations WHERE id = ?").run(operation.id)).toThrow(/immutable/);
    } finally {
      db.close();
    }
  });
});
