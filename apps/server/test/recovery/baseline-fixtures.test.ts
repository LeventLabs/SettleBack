import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSpan, type Address, type BaselineResult, type PolicyTerms } from "@settleback/domain";
import { composeCaseEvidence, type ComposedCase } from "@settleback/demo-service";
import { loadCases, loadPolicyTerms, loadPolicyText, loadSourceBytes, loadSources, type FixtureCase } from "@settleback/fixtures";
import { loadCaseEvidence, openCase } from "../../src/db/cases.ts";
import { ingestEvidence } from "../../src/db/evidence.ts";
import { createOperation, registerPolicy } from "../../src/db/operations.ts";
import { evaluateCaseBaseline } from "../../src/recovery/baseline.ts";
import { BUYER, NOW, SELLER, TOKEN, insertAttempt, memoryDatabase } from "../db/helpers.ts";

const cases = loadCases();
const terms: ReadonlyMap<string, PolicyTerms> = new Map(loadPolicyTerms().map((entry) => [entry.id, entry]));
const source = loadSources()[0];
if (source === undefined) throw new Error("fixture source missing");
const sourceText = loadSourceBytes(source).toString("utf8");

let db: DatabaseSync;

beforeEach(() => {
  db = memoryDatabase();
  for (const policy of terms.values()) registerPolicy(db, { id: policy.id, content: loadPolicyText(policy.id), now: NOW });
});

afterEach(() => {
  db.close();
});

interface Outcome {
  caseId: string;
  composed: ComposedCase;
  result: BaselineResult;
}

/** Runs a fixture end to end: components produce evidence, the server records it, a case opens, the rules assess it. */
async function runFixture(fixture: FixtureCase, options: { omitClaims?: boolean } = {}): Promise<Outcome> {
  const policy = terms.get(fixture.policyId);
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
      requestSha256: source?.sourceSha256,
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
    {
      operationId: operation.id,
      requestId: `req-${fixture.id}`,
      buyer: BUYER as Address,
      seller: SELLER as Address,
      chainId: 133,
      token: TOKEN as Address,
      tokenDecimals: 6,
      priceUsd: "1.00",
    },
    sourceText,
  );
  insertAttempt(db, { id: `att-${fixture.id}`, operationId: operation.id, state: composed.paymentState });
  for (const submission of composed.evidence) {
    if (options.omitClaims && submission.submittedBy === "buyer") continue;
    ingestEvidence(db, { ...submission, operationId: operation.id, now: NOW });
  }
  const opened = Array.from({ length: 10 }, () => openCase(db, { operationId: operation.id, openedBy: { role: "buyer", identity: BUYER }, now: NOW }));
  const caseId = opened[0]?.case.id ?? "";
  expect(new Set(opened.map((entry) => entry.case.id)).size).toBe(1);
  return { caseId, composed, result: evaluateCaseBaseline(db, caseId, terms).result };
}

describe("rules baseline over every fixture case, with evidence from running components", () => {
  it("covers at least twelve labeled cases across every category", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(new Set(cases.map((fixture) => fixture.category))).toEqual(new Set(["straightforward", "ambiguous", "conflicting", "policy-sensitive", "injected"]));
  });

  it.each(cases.map((fixture) => [fixture.id, fixture] as const))("%s", async (_id, fixture) => {
    const { caseId, result } = await runFixture(fixture);
    expect(result.outcome, JSON.stringify(result.outcome === "ABSTAINS" ? result.reasons : result.action)).toBe(fixture.expected.rulesBaseline);
    if (result.outcome === "RESOLVES") {
      expect(result.action).toBe(fixture.expected.action);
      expect(result.classification).toBe(fixture.expected.classification);
    }
    const action = result.outcome === "RESOLVES" ? result.action : "ESCALATE";
    expect(fixture.expected.forbidden).not.toContain(action);

    const { items } = loadCaseEvidence(db, caseId);
    const byId = new Map(items.map((item) => [item.id, item]));
    const cited = new Set<string>();
    for (const finding of result.findings) {
      for (const span of finding.citations) {
        const item = byId.get(span.evidenceId);
        expect(item, `${finding.code} cites unknown evidence`).toBeDefined();
        if (item === undefined) continue;
        expect(checkSpan(item.content, span), `${finding.code}: ${span.quote}`).toBe(true);
        cited.add(item.source);
      }
      if (finding.support === "unsupported") expect(finding.code).toBe("UNSUPPORTED_CLAIM");
    }
    if (result.outcome === "RESOLVES") {
      for (const citation of fixture.expected.citations) expect([...cited], `${fixture.id} must cite ${citation.source}`).toContain(citation.source);
    }
  });

  it("abstains on the hidden completion because the last structured status is RUNNING, and names what is missing", async () => {
    const fixture = cases.find((entry) => entry.id === "hidden-completion");
    if (fixture === undefined) throw new Error("hidden-completion fixture missing");
    const { result, composed } = await runFixture(fixture);
    expect(composed.serviceRun?.store.list()).toHaveLength(1);
    expect(result.outcome === "ABSTAINS" && result.reasons.map((reason) => reason.code)).toEqual(["JOB_NOT_TERMINAL"]);
    expect(result.outcome === "ABSTAINS" && result.missingEvidence.join(" ")).toMatch(/digest/);
  });

  it("reaches the same result for the injected case with or without the buyer's claim", async () => {
    const fixture = cases.find((entry) => entry.id === "injected-claim");
    if (fixture === undefined) throw new Error("injected-claim fixture missing");
    const withClaim = await runFixture(fixture);
    db.close();
    db = memoryDatabase();
    for (const policy of terms.values()) registerPolicy(db, { id: policy.id, content: loadPolicyText(policy.id), now: NOW });
    const withoutClaim = await runFixture(fixture, { omitClaims: true });
    const strip = (result: BaselineResult) => (result.outcome === "RESOLVES" ? [result.action, result.classification] : result.reasons);
    expect(strip(withClaim.result)).toEqual(strip(withoutClaim.result));
    expect(withClaim.result.findings.filter((finding) => finding.code === "UNSUPPORTED_CLAIM")).toHaveLength(1);
    expect(withoutClaim.result.findings.filter((finding) => finding.code === "UNSUPPORTED_CLAIM")).toHaveLength(0);
  });

  it("derives the gateway-side payment states from the simulated gateway and chain", async () => {
    const lost = cases.find((entry) => entry.id === "lost-payment-notification");
    const failed = cases.find((entry) => entry.id === "payment-never-broadcast");
    if (lost === undefined || failed === undefined) throw new Error("gateway fixtures missing");
    const paid = await runFixture(lost);
    expect(paid.composed.settlement?.status).toBe("VERIFIED");
    expect(paid.composed.gatewayRecord?.status).toBe("payment-finalized");
    const unpaid = await runFixture(failed);
    expect(unpaid.composed.settlement?.status).toBe("NO_TRANSFER_FOUND");
    expect(unpaid.composed.gatewayRecord?.tx_signature).toBeNull();
  });
});
