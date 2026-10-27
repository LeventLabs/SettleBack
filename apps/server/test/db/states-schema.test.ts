import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CASE_STATES, PAYMENT_ATTEMPT_STATES, RECOVERY_ACTION_STATES, SERVICE_JOB_STATES } from "@settleback/domain";
import { NOW, insertAttempt, insertCase, insertRepayAction, memoryDatabase, seedOperation } from "./helpers.ts";

let db: DatabaseSync;
let operationId: string;

beforeEach(() => {
  db = memoryDatabase();
  operationId = seedOperation(db);
});

afterEach(() => {
  db.close();
});

/** Walks one row through every domain state; the schema's CHECK constraints must accept each one. */
function acceptsEveryState(table: string, keyColumn: string, key: string, states: readonly string[]): void {
  for (const state of states) {
    expect(() =>
      db.prepare(`UPDATE ${table} SET state = ?, revision = revision + 1 WHERE ${keyColumn} = ?`).run(state, key),
    ).not.toThrow();
  }
  expect(() =>
    db.prepare(`UPDATE ${table} SET state = 'NOT_A_STATE', revision = revision + 1 WHERE ${keyColumn} = ?`).run(key),
  ).toThrow(/CHECK constraint/);
}

describe("domain state names match the schema", () => {
  it("for payment attempts", () => {
    insertAttempt(db, { id: "att-1", operationId });
    acceptsEveryState("payment_attempts", "id", "att-1", PAYMENT_ATTEMPT_STATES);
  });

  it("for service jobs", () => {
    db.prepare("INSERT INTO service_jobs (operation_id, state, updated_at) VALUES (?, 'NOT_STARTED', ?)").run(operationId, NOW);
    acceptsEveryState("service_jobs", "operation_id", operationId, SERVICE_JOB_STATES);
  });

  it("for cases", () => {
    insertCase(db, "case-1", operationId);
    for (const status of CASE_STATES) {
      expect(() =>
        db.prepare("UPDATE cases SET status = ?, revision = revision + 1 WHERE id = 'case-1'").run(status),
      ).not.toThrow();
    }
    expect(() => db.prepare("UPDATE cases SET status = 'CLOSED', revision = revision + 1 WHERE id = 'case-1'").run()).toThrow(
      /CHECK constraint/,
    );
  });

  it("for recovery actions", () => {
    insertCase(db, "case-1", operationId);
    insertRepayAction(db, "action-1", "case-1");
    acceptsEveryState("recovery_actions", "id", "action-1", RECOVERY_ACTION_STATES);
  });
});
