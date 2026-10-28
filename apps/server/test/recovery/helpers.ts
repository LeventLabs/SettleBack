import type { DatabaseSync } from "node:sqlite";
import type { Address, AssessmentPrompt, PolicyTerms } from "@settleback/domain";
import { composeCaseEvidence, type ComposedCase } from "@settleback/demo-service";
import { loadCases, loadPolicyTerms, loadPolicyText, loadSourceBytes, loadSources } from "@settleback/fixtures";
import { loadCaseEvidence, openCase } from "../../src/db/cases.ts";
import type { EvidenceRecord } from "../../src/db/evidence.ts";
import { ingestEvidence } from "../../src/db/evidence.ts";
import { createOperation, registerPolicy } from "../../src/db/operations.ts";
import type { ServiceLookup } from "../../src/recovery/assessment.ts";
import type { AssessmentProvider, ProviderReply } from "../../src/recovery/provider.ts";
import { BUYER, NOW, SELLER, TOKEN, insertAttempt } from "../db/helpers.ts";

export const TERMS: ReadonlyMap<string, PolicyTerms> = new Map(loadPolicyTerms().map((entry) => [entry.id, entry]));
export const MODEL = "claude-opus-5-5";

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

/** Hand-written test input. Its origin is "scripted" so it can never be mistaken for a model's answer. */
export class ScriptedProvider implements AssessmentProvider {
  readonly name = "scripted";
  readonly origin = "scripted" as const;
  readonly model: string;
  readonly prompts: AssessmentPrompt[] = [];
  private readonly respond: (prompt: AssessmentPrompt, signal: AbortSignal) => Promise<ProviderReply> | ProviderReply;

  constructor(respond: (prompt: AssessmentPrompt, signal: AbortSignal) => Promise<ProviderReply> | ProviderReply, model = MODEL) {
    this.respond = respond;
    this.model = model;
  }

  async assess(prompt: AssessmentPrompt, signal: AbortSignal): Promise<ProviderReply> {
    this.prompts.push(prompt);
    return this.respond(prompt, signal);
  }
}

export function reply(body: unknown, overrides: Partial<ProviderReply> = {}): ProviderReply {
  return {
    model: MODEL,
    stopReason: "end_turn",
    text: typeof body === "string" ? body : JSON.stringify(body),
    refusalCategory: null,
    usage: { inputTokens: 3000, outputTokens: 1800, thinkingTokens: 300 },
    ...overrides,
  };
}

/** The line of `content` that contains `needle`, for quoting it verbatim. */
export function lineWith(content: string, needle: string): string {
  const line = content.split("\n").find((entry) => entry.includes(needle));
  if (line === undefined) throw new Error(`no line contains ${needle}`);
  return line;
}
