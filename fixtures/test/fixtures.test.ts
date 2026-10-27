import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex, type CanonicalValue } from "@settleback/domain/hash";
import {
  CASE_CATEGORIES,
  GUARD_DECISIONS,
  fixturePath,
  loadAuthorizationFixtures,
  loadCases,
  loadPolicyTerms,
  loadPolicyText,
  loadSourceBytes,
  loadSources,
  type AuthorizationFixture,
  type GuardDecision,
} from "../src/index.ts";

const cases = loadCases();
const sources = loadSources();
const authorization = loadAuthorizationFixtures();

function uniqueIds(items: { id: string }[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

describe("sources", () => {
  it("have unique ids and files whose bytes match the recorded digest", () => {
    expect(uniqueIds(sources)).toBe(true);
    for (const source of sources) {
      expect(sha256Hex(loadSourceBytes(source)), source.id).toBe(source.sourceSha256);
    }
  });

  it("record the canonical digest of their expected artifact", () => {
    for (const source of sources) {
      expect(source.expectedArtifact.sourceId).toBe(source.id);
      const digest = sha256Hex(canonicalJson(source.expectedArtifact as unknown as CanonicalValue));
      expect(digest, source.id).toBe(source.expectedArtifactSha256);
    }
  });
});

describe("cases", () => {
  it("have unique ids and resolve their policy and source", () => {
    expect(uniqueIds(cases)).toBe(true);
    const sourceIds = new Set(sources.map((source) => source.id));
    for (const fixture of cases) {
      expect(existsSync(fixturePath(`policies/${fixture.policyId}.md`)), fixture.id).toBe(true);
      expect(loadPolicyText(fixture.policyId)).toContain(`Policy ID: ${fixture.policyId}`);
      expect(sourceIds.has(fixture.sourceId), fixture.id).toBe(true);
    }
  });

  it("form an evaluation set of at least twelve cases covering every category", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    for (const category of CASE_CATEGORIES) {
      expect(cases.some((fixture) => fixture.category === category), category).toBe(true);
    }
  });

  it("include at least two ambiguous cases the rules baseline cannot resolve but that have a concrete answer", () => {
    const decisive = cases.filter(
      (fixture) =>
        fixture.category === "ambiguous" &&
        fixture.expected.rulesBaseline === "ABSTAINS" &&
        fixture.expected.action !== "ESCALATE",
    );
    expect(decisive.length).toBeGreaterThanOrEqual(2);
  });

  it("never forbid their own expected action", () => {
    for (const fixture of cases) {
      expect(fixture.expected.forbidden, fixture.id).not.toContain(fixture.expected.action);
      expect(fixture.expected.reasons.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.expected.citations.length, fixture.id).toBeGreaterThan(0);
    }
  });

  it("only cite evidence sources the case actually produces", () => {
    for (const fixture of cases) {
      const produced = new Set(fixture.evidence.map((evidence) => evidence.source));
      for (const citation of fixture.expected.citations) {
        expect(produced.has(citation.source), `${fixture.id} cites ${citation.source}`).toBe(true);
      }
    }
  });

  it("allow hand-written evidence only for buyer claims, and give each its text", () => {
    for (const fixture of cases) {
      for (const evidence of fixture.evidence) {
        if (evidence.handWritten) expect(evidence.source, fixture.id).toBe("buyer-claim");
        expect(evidence.text !== undefined, fixture.id).toBe(evidence.handWritten === true);
      }
    }
  });

  it("give every case's policy machine-readable terms pinned to the policy text", () => {
    const policyTerms = loadPolicyTerms();
    for (const terms of policyTerms) expect(terms.sha256, terms.id).toBe(sha256Hex(loadPolicyText(terms.id)));
    const ids = new Set(policyTerms.map((terms) => terms.id));
    for (const fixture of cases) expect(ids.has(fixture.policyId), fixture.id).toBe(true);
    expect(Object.fromEntries(policyTerms.map((terms) => [terms.id, terms.refundRule]))).toEqual({
      "extraction-delivery-v1": "TERMINAL_FAILURE_BEFORE_ARTIFACT",
      "extraction-compute-billable-v1": "FAILURE_BEFORE_COMPUTE",
    });
  });

  it("set an authorization mode exactly on repayment cases and cover both modes", () => {
    for (const fixture of cases) {
      expect(fixture.authorizationMode !== undefined, fixture.id).toBe(fixture.expected.action === "REPAY");
    }
    const modes = new Set(cases.map((fixture) => fixture.authorizationMode).filter(Boolean));
    expect([...modes].sort()).toEqual(["PER_CASE", "STANDING_POLICY"]);
  });
});

/**
 * Independent arithmetic check that each fixture's numbers really produce its stated decision.
 * It guards the fixtures against typos; the guard implementation itself is built and tested separately.
 */
function referenceDecision(fixture: AuthorizationFixture): GuardDecision {
  const { policy, state, request } = fixture;
  const at = Date.parse(state.at);
  const active = policy.status === "active" && at >= Date.parse(policy.validFrom) && at < Date.parse(policy.validUntil);
  const exposure = BigInt(state.bookedTodayBaseUnits) + BigInt(state.outstandingBaseUnits);

  if (fixture.signer === "seller-guard") {
    if (state.existingAction !== "NONE") return "REFUSE";
    if (!active) return "ROUTE_TO_HUMAN";
    const amount = BigInt(request.amountBaseUnits);
    if (amount > BigInt(policy.perCaseCapBaseUnits ?? "0")) return "ROUTE_TO_HUMAN";
    if (exposure + amount > BigInt(policy.dailyCapBaseUnits)) return "ROUTE_TO_HUMAN";
    return "SIGN";
  }

  if (state.existingAttempt !== "NONE") return "REFUSE";
  if (!active) return "ROUTE_TO_HUMAN";
  if (request.payee === undefined || !(policy.payeeAllowlist ?? []).includes(request.payee)) return "ROUTE_TO_HUMAN";
  const gross = BigInt(request.amountBaseUnits) + BigInt(policy.maxFeeBaseUnits ?? "0");
  if (gross > BigInt(policy.perPaymentCapBaseUnits ?? "0")) return "ROUTE_TO_HUMAN";
  if (exposure + gross > BigInt(policy.dailyCapBaseUnits)) return "ROUTE_TO_HUMAN";
  return "SIGN";
}

describe("authorization fixtures", () => {
  it("have unique ids and cover both guards and every decision", () => {
    expect(uniqueIds(authorization)).toBe(true);
    expect(new Set(authorization.map((fixture) => fixture.signer))).toEqual(new Set(["seller-guard", "buyer-guard"]));
    for (const decision of GUARD_DECISIONS) {
      expect(authorization.some((fixture) => fixture.expected.decision === decision), decision).toBe(true);
    }
  });

  it("state decisions that their own numbers produce", () => {
    for (const fixture of authorization) {
      expect(referenceDecision(fixture), fixture.id).toBe(fixture.expected.decision);
    }
  });
});
