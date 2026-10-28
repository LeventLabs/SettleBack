import type { DatabaseSync } from "node:sqlite";
import type { Address, PolicyTerms } from "@settleback/domain";
import { composeCaseEvidence, type ComposedCase } from "@settleback/demo-service";
import { loadCases, loadPolicyTerms, loadPolicyText, loadSourceBytes, loadSources } from "@settleback/fixtures";
import { loadCaseEvidence, openCase } from "../src/db/cases.ts";
import { ingestEvidence, type EvidenceRecord } from "../src/db/evidence.ts";
import { createOperation, registerPolicy } from "../src/db/operations.ts";
import type { ServiceLookup } from "../src/recovery/assessment.ts";

/**
 * Sets up fixture cases for tests and the assessment evaluation: the demo service produces the
 * evidence, the server records it, and a lookup reads the same simulated services.
 */
export const NOW = "2026-10-30T10:00:00.000Z";
export const BUYER = "0x00000000000000000000000000000000000000b1";
export const SELLER = "0x00000000000000000000000000000000000000a1";
export const TOKEN = "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6";

export const TERMS: ReadonlyMap<string, PolicyTerms> = new Map(loadPolicyTerms().map((entry) => [entry.id, entry]));
export function registerFixturePolicies(db: DatabaseSync): void {
  for (const policy of TERMS.values()) registerPolicy(db, { id: policy.id, content: loadPolicyText(policy.id), now: NOW });
}

export interface FixtureCaseSetup {
  caseId: string;
  operationId: string;
  composed: ComposedCase;
  lookup: ServiceLookup;
  items(): EvidenceRecord[];
  item(source: EvidenceRecord["source"]): EvidenceRecord;
}

/** Runs the components for a fixture, records their evidence, opens the case, and connects a lookup to the same services. */
export async function setupFixtureCase(db: DatabaseSync, fixtureId: string): Promise<FixtureCaseSetup> {
  const fixture = loadCases().find((entry) => entry.id === fixtureId);
  const source = loadSources()[0];
  if (fixture === undefined || source === undefined) throw new Error(`fixture ${fixtureId} missing`);
  const policy = TERMS.get(fixture.policyId);
  if (policy === undefined) throw new Error(`no terms for ${fixture.policyId}`);
  const { operation } = createOperation(db, {
    actor: BUYER,
    idempotencyKey: `key-${fixture.id}`,
    environment: "local",
    now: NOW,
    intent: {
      buyer: BUYER,
      seller: SELLER,
      serviceId: "structured-extraction",
      requestSha256: source.sourceSha256,
      policyId: policy.id,
      policySha256: policy.sha256,
      chainId: 133,
      token: TOKEN,
      tokenDecimals: 6,
      priceUsd: "1.00",
      amountBaseUnits: "1000000",
    },
  });
  const composed = await composeCaseEvidence(
    fixture,
    { operationId: operation.id, requestId: `req-${fixture.id}`, buyer: BUYER as Address, seller: SELLER as Address, chainId: 133, token: TOKEN as Address, tokenDecimals: 6, priceUsd: "1.00" },
    loadSourceBytes(source).toString("utf8"),
  );
  insertAttempt(db, { id: `att-${fixture.id}`, operationId: operation.id, state: composed.paymentState });
  for (const submission of composed.evidence) ingestEvidence(db, { ...submission, operationId: operation.id, now: NOW });
  const caseId = openCase(db, { operationId: operation.id, openedBy: { role: "buyer", identity: BUYER }, now: NOW }).case.id;
  const run = composed.serviceRun;
  const lookup: ServiceLookup = {
    jobStatus: async (operationId) => {
      const status = run?.service.status(operationId);
      return status === undefined ? null : JSON.stringify(status);
    },
    artifactRecords: async (sha256) => {
      const record = run?.store.record(sha256);
      return JSON.stringify(record === undefined ? [] : [record]);
    },
  };
  const items = (): EvidenceRecord[] => loadCaseEvidence(db, caseId).items;
  const item = (wanted: EvidenceRecord["source"]): EvidenceRecord => {
    const found = items().find((entry) => entry.source === wanted);
    if (found === undefined) throw new Error(`${fixtureId} has no ${wanted} evidence`);
    return found;
  };
  return { caseId, operationId: operation.id, composed, lookup, items, item };
}

export function insertAttempt(db: DatabaseSync, values: { id: string; operationId: string; purpose?: string; state?: string }): void {
  db.prepare(
    `INSERT INTO payment_attempts (id, operation_id, purpose, state, payer, payee, chain_id, token, amount_base_units,
       intent_sha256, deployment_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 133, ?, '1000000', ?, 'local-registry', ?, ?)`,
  ).run(values.id, values.operationId, values.purpose ?? "ORIGINAL", values.state ?? "CREATED", BUYER, SELLER, TOKEN, "c".repeat(64), NOW, NOW);
}
