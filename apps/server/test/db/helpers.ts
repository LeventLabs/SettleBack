import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadPolicyText } from "@settleback/fixtures";
import { openDatabase } from "../../src/db/database.ts";
import { createOperation, registerPolicy } from "../../src/db/operations.ts";

export const NOW = "2026-10-30T10:00:00.000Z";
export const BUYER = "0x00000000000000000000000000000000000000b1";
export const SELLER = "0x00000000000000000000000000000000000000a1";
export const TOKEN = "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6";
export const TX_A = `0x${"a".repeat(64)}`;
export const TX_B = `0x${"b".repeat(64)}`;

export function memoryDatabase(): DatabaseSync {
  return openDatabase({ path: ":memory:", environment: "local", now: () => NOW });
}

export function withTempDir<T>(work: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "settleback-test-"));
  try {
    return work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function seedPolicy(db: DatabaseSync): string {
  const content = loadPolicyText("extraction-delivery-v1");
  return registerPolicy(db, { id: "extraction-delivery-v1", content, now: NOW }).policy.contentSha256;
}

export function sampleIntent(policySha256: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    buyer: BUYER,
    seller: SELLER,
    serviceId: "structured-extraction",
    requestSha256: "09fed74ec1dfb2c5d983d4e5bfce9f4fba51cf1df9aea4eb385673338771ee42",
    policyId: "extraction-delivery-v1",
    policySha256,
    chainId: 133,
    token: TOKEN,
    tokenDecimals: 6,
    priceUsd: "1.00",
    amountBaseUnits: "1000000",
    ...overrides,
  };
}

export function seedOperation(db: DatabaseSync, key = "op-key-0001", overrides: Record<string, unknown> = {}): string {
  const policySha256 = seedPolicy(db);
  return createOperation(db, {
    actor: BUYER,
    idempotencyKey: key,
    intent: sampleIntent(policySha256, overrides),
    environment: "local",
    now: NOW,
  }).operation.id;
}

export function insertAttempt(
  db: DatabaseSync,
  values: { id: string; operationId: string; purpose?: string; state?: string },
): void {
  db.prepare(
    `INSERT INTO payment_attempts (id, operation_id, purpose, state, payer, payee, chain_id, token, amount_base_units,
       intent_sha256, deployment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 133, ?, '1000000', ?, 'local-registry', ?, ?)`,
  ).run(
    values.id,
    values.operationId,
    values.purpose ?? "ORIGINAL",
    values.state ?? "CREATED",
    BUYER,
    SELLER,
    TOKEN,
    "c".repeat(64),
    NOW,
    NOW,
  );
}

export function insertCase(db: DatabaseSync, id: string, operationId: string): void {
  db.prepare(
    "INSERT INTO cases (id, operation_id, status, opened_by, created_at, updated_at) VALUES (?, ?, 'OPEN', ?, ?, ?)",
  ).run(id, operationId, BUYER, NOW, NOW);
}

export function insertRepayAction(db: DatabaseSync, id: string, caseId: string): void {
  db.prepare(
    `INSERT INTO recovery_actions (id, case_id, action, authorization_mode, action_sha256, evidence_sha256,
       amount_base_units, payer, payee, chain_id, token, deadline, state, created_at, updated_at)
     VALUES (?, ?, 'REPAY', 'PER_CASE', ?, ?, '1000000', ?, ?, 133, ?, ?, 'PREPARED', ?, ?)`,
  ).run(id, caseId, "d".repeat(64), "e".repeat(64), SELLER, BUYER, TOKEN, NOW, NOW, NOW);
}
