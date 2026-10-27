import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProofAlreadyAllocatedError } from "../../src/db/errors.ts";
import { allocateProof } from "../../src/db/proofs.ts";
import {
  BUYER,
  NOW,
  TX_A,
  TX_B,
  insertAttempt,
  insertCase,
  insertRepayAction,
  memoryDatabase,
  seedOperation,
} from "./helpers.ts";

let db: DatabaseSync;
let opA: string;
let opB: string;

beforeEach(() => {
  db = memoryDatabase();
  opA = seedOperation(db, "op-key-000A");
  opB = seedOperation(db, "op-key-000B", { requestSha256: "f".repeat(64) });
});

afterEach(() => {
  db.close();
});

function proof(overrides: Partial<Parameters<typeof allocateProof>[1]> = {}): Parameters<typeof allocateProof>[1] {
  return {
    deploymentId: "local-registry",
    chainId: 133,
    proofId: TX_A,
    proofType: "ORIGINAL_PAYMENT",
    operationId: opA,
    actionId: null,
    actor: "verifier",
    now: NOW,
    ...overrides,
  };
}

describe("proof allocation", () => {
  it("binds one original payment proof to one operation", () => {
    allocateProof(db, proof());
    expect(() => allocateProof(db, proof({ operationId: opB }))).toThrow(ProofAlreadyAllocatedError);
  });

  it("treats proof ids case-insensitively", () => {
    allocateProof(db, proof());
    expect(() => allocateProof(db, proof({ operationId: opB, proofId: TX_A.toUpperCase().replace("0X", "0x") }))).toThrow(
      ProofAlreadyAllocatedError,
    );
  });

  it("refuses a second original proof for the same operation", () => {
    allocateProof(db, proof());
    expect(() => allocateProof(db, proof({ proofId: TX_B }))).toThrow(ProofAlreadyAllocatedError);
  });

  it("refuses to reuse an original payment proof as a repayment", () => {
    allocateProof(db, proof());
    insertCase(db, "case-a", opA);
    insertRepayAction(db, "action-a", "case-a");
    expect(() => allocateProof(db, proof({ proofType: "REPAYMENT", actionId: "action-a" }))).toThrow(
      ProofAlreadyAllocatedError,
    );
    allocateProof(db, proof({ proofType: "REPAYMENT", actionId: "action-a", proofId: TX_B }));
  });

  it("allows the same transaction hash in a different deployment namespace", () => {
    allocateProof(db, proof());
    allocateProof(db, proof({ deploymentId: "other-registry", operationId: opB }));
  });

  it("keeps allocations immutable", () => {
    allocateProof(db, proof());
    expect(() => db.prepare("DELETE FROM proof_allocations").run()).toThrow(/immutable/);
  });
});

describe("payment attempts", () => {
  it("allow only one live original attempt per operation", () => {
    insertAttempt(db, { id: "att-1", operationId: opA });
    expect(() => insertAttempt(db, { id: "att-2", operationId: opA })).toThrow(/UNIQUE/);
    db.prepare("UPDATE payment_attempts SET state = 'FAILED', revision = revision + 1 WHERE id = 'att-1'").run();
    insertAttempt(db, { id: "att-2", operationId: opA });
  });

  it("require each update to advance the revision by exactly one", () => {
    insertAttempt(db, { id: "att-1", operationId: opA });
    expect(() => db.prepare("UPDATE payment_attempts SET state = 'PREPARED' WHERE id = 'att-1'").run()).toThrow(
      /revision must advance by one/,
    );
    expect(() =>
      db.prepare("UPDATE payment_attempts SET state = 'PREPARED', revision = revision + 2 WHERE id = 'att-1'").run(),
    ).toThrow(/revision must advance by one/);
    db.prepare("UPDATE payment_attempts SET state = 'PREPARED', revision = revision + 1 WHERE id = 'att-1'").run();
  });

  it("never change amount, parties, or a recorded transaction hash", () => {
    insertAttempt(db, { id: "att-1", operationId: opA });
    expect(() =>
      db.prepare("UPDATE payment_attempts SET amount_base_units = '1', revision = revision + 1 WHERE id = 'att-1'").run(),
    ).toThrow(/intent is immutable/);
    db.prepare("UPDATE payment_attempts SET tx_hash = ?, revision = revision + 1 WHERE id = 'att-1'").run(TX_A);
    expect(() =>
      db.prepare("UPDATE payment_attempts SET tx_hash = ?, revision = revision + 1 WHERE id = 'att-1'").run(TX_B),
    ).toThrow(/cannot change once recorded/);
  });

  it("reject malformed amounts", () => {
    for (const amount of ["0", "01", "-1", "1.5", ""]) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO payment_attempts (id, operation_id, purpose, state, payer, payee, chain_id, token,
               amount_base_units, intent_sha256, deployment_id, created_at, updated_at)
             VALUES ('bad', ?, 'ORIGINAL', 'CREATED', ?, ?, 133, ?, ?, ?, 'local-registry', ?, ?)`,
          )
          .run(opB, BUYER, BUYER.replace("b1", "a1"), BUYER, amount, "c".repeat(64), NOW, NOW),
        amount,
      ).toThrow(/CHECK constraint/);
    }
  });
});

describe("recovery actions and cases", () => {
  it("allow one case per operation and one recovery action per case", () => {
    insertCase(db, "case-a", opA);
    expect(() => insertCase(db, "case-a2", opA)).toThrow(/UNIQUE/);
    insertRepayAction(db, "action-a", "case-a");
    expect(() => insertRepayAction(db, "action-a2", "case-a")).toThrow(/UNIQUE/);
  });

  it("keep repayment terms fixed after creation", () => {
    insertCase(db, "case-a", opA);
    insertRepayAction(db, "action-a", "case-a");
    expect(() =>
      db.prepare("UPDATE recovery_actions SET payee = ?, revision = revision + 1 WHERE id = 'action-a'").run(BUYER.replace("b1", "c3")),
    ).toThrow(/terms are immutable/);
  });
});

describe("execution permits", () => {
  it("can be consumed exactly once and never reissued", () => {
    insertAttempt(db, { id: "att-1", operationId: opA });
    db.prepare("INSERT INTO execution_permits (attempt_id, fencing_token, state, issued_at) VALUES ('att-1', 1, 'ISSUED', ?)").run(NOW);
    expect(() =>
      db.prepare("INSERT INTO execution_permits (attempt_id, fencing_token, state, issued_at) VALUES ('att-1', 2, 'ISSUED', ?)").run(NOW),
    ).toThrow(/UNIQUE/);
    db.prepare("UPDATE execution_permits SET state = 'CONSUMED', consumed_at = ? WHERE attempt_id = 'att-1'").run(NOW);
    expect(() =>
      db.prepare("UPDATE execution_permits SET state = 'ISSUED', consumed_at = NULL WHERE attempt_id = 'att-1'").run(),
    ).toThrow(/consumed once/);
  });
});

describe("audit events", () => {
  it("are append-only", () => {
    expect(() => db.prepare("UPDATE events SET actor = 'someone-else'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
  });
});
