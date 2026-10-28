import { describe, expect, it } from "vitest";
import {
  BASELINE_RULES_VERSION,
  deriveEligibility,
  eligibilityRulesSha256,
  proposalSha256,
  registryCaseKey,
  repaymentTransfer,
  standingPolicyGaps,
  type BaselineResult,
  type PolicyFitInput,
  type RecoveryProposal,
} from "../src/index.ts";
import { sha256Hex } from "../src/hash.ts";

const RESOLVES = (action: "RETRIEVE" | "REPAY" | "NO_ACTION" | "ESCALATE" | "FULFIL_EXISTING_PAYMENT"): BaselineResult => ({
  rulesVersion: BASELINE_RULES_VERSION,
  outcome: "RESOLVES",
  action,
  classification: "c",
  findings: [],
});
const ABSTAINS: BaselineResult = { rulesVersion: BASELINE_RULES_VERSION, outcome: "ABSTAINS", reasons: [{ code: "JOB_NOT_TERMINAL", message: "m" }], missingEvidence: [], findings: [] };
const LEAD = { action: "RETRIEVE" as const, basis: "VERIFIED_ARTIFACT_LEAD" as const, artifactSha256: "a".repeat(64), writer: "wk-1", reasons: [] as [] };
const BUYER = "0x00000000000000000000000000000000000000b1";
const SELLER = "0x00000000000000000000000000000000000000a1";
const TOKEN = "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6";

describe("recovery eligibility", () => {
  it("takes repayment only from the rules and retrieval from the rules or a verified lead", () => {
    expect(deriveEligibility(RESOLVES("REPAY"), undefined)).toMatchObject({ eligible: true, eligibility: { action: "REPAY", basis: "RULES_BASELINE" } });
    expect(deriveEligibility(RESOLVES("RETRIEVE"), undefined)).toMatchObject({ eligible: true, eligibility: { action: "RETRIEVE", basis: "RULES_BASELINE" } });
    expect(deriveEligibility(ABSTAINS, LEAD)).toMatchObject({ eligible: true, eligibility: { action: "RETRIEVE", basis: "VERIFIED_ARTIFACT_LEAD" } });
    expect(deriveEligibility(ABSTAINS, { action: "ESCALATE", reasons: [{ code: "MODEL_SUGGESTED_ESCALATE", message: "m" }] }).eligible).toBe(false);
    expect(deriveEligibility(ABSTAINS, undefined).eligible).toBe(false);
    for (const action of ["NO_ACTION", "ESCALATE", "FULFIL_EXISTING_PAYMENT"] as const) expect(deriveEligibility(RESOLVES(action), LEAD).eligible, action).toBe(false);
  });

  it("names the rules each basis rests on", () => {
    expect(eligibilityRulesSha256("RULES_BASELINE")).toBe(sha256Hex(BASELINE_RULES_VERSION));
    expect(eligibilityRulesSha256("VERIFIED_ARTIFACT_LEAD")).not.toBe(eligibilityRulesSha256("RULES_BASELINE"));
  });
});

describe("proposal identity", () => {
  const proposal: RecoveryProposal = {
    schema: "settleback.recovery-action.v1",
    caseId: "case-1",
    caseKey: `0x${"1".repeat(64)}`,
    operationId: "op-1",
    action: "REPAY",
    basis: "RULES_BASELINE",
    classification: "terminal-failure-refundable",
    evidenceRevision: 3,
    evidenceSha256: "e".repeat(64),
    policySha256: "p".repeat(64).replace(/p/g, "f"),
    eligibilityRulesSha256: eligibilityRulesSha256("RULES_BASELINE"),
    autoEligible: true,
    parties: { buyer: BUYER, seller: SELLER, chainId: 133, token: TOKEN, amountBaseUnits: "1000000" },
    originalTxHash: `0x${"ab".repeat(32)}`,
    transfer: repaymentTransfer({ buyer: BUYER, seller: SELLER, chainId: 133, token: TOKEN, amountBaseUnits: "1000000" }),
    artifactSha256: null,
    deadline: "2026-10-31T10:00:00.000Z",
    registry: { chainId: 133, address: "0xcc1a01fe331d65b683d8cab377c49e63dcb6996c" },
    authorization: { mode: "PER_CASE" },
  };

  it("repays the seller's principal to the buyer who paid, on the original chain and token", () => {
    expect(proposal.transfer).toEqual({ payer: SELLER, payee: BUYER, chainId: 133, token: TOKEN, amountBaseUnits: "1000000" });
  });

  it("changes its digest when any bound field changes", () => {
    const base = proposalSha256(proposal);
    const variants: Partial<RecoveryProposal>[] = [
      { evidenceRevision: 4 },
      { evidenceSha256: "0".repeat(64) },
      { transfer: { ...proposal.transfer!, amountBaseUnits: "999999" } },
      { transfer: { ...proposal.transfer!, payee: SELLER, payer: BUYER } },
      { deadline: "2026-10-31T10:00:01.000Z" },
      { authorization: { mode: "STANDING_POLICY", scope: `0x${"2".repeat(64)}`, version: 1 } },
      { registry: { chainId: 177, address: proposal.registry.address } },
      { autoEligible: false },
    ];
    for (const variant of variants) expect(proposalSha256({ ...proposal, ...variant }), JSON.stringify(variant)).not.toBe(base);
  });

  it("keys a case per registry deployment", () => {
    const a = registryCaseKey("case-1", { chainId: 133, address: "0xcc1a01fe331d65b683d8cab377c49e63dcb6996c" });
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(registryCaseKey("case-1", { chainId: 177, address: "0xcc1a01fe331d65b683d8cab377c49e63dcb6996c" })).not.toBe(a);
    expect(registryCaseKey("case-1", { chainId: 133, address: "0xCC1A01FE331D65B683D8CAB377C49E63DCB6996C" })).toBe(a);
  });
});

describe("standing policy coverage", () => {
  const fit = (overrides: Partial<PolicyFitInput> = {}, policy: Partial<PolicyFitInput["policy"]> = {}) =>
    standingPolicyGaps({
      policy: {
        status: "ACTIVE",
        seller: SELLER,
        token: TOKEN,
        paymentChainId: 133,
        servicePolicySha256: "s".repeat(64).replace(/s/g, "a"),
        eligibilityRulesSha256: "b".repeat(64),
        maxPerCaseBaseUnits: "1000000",
        dailyLimitBaseUnits: "3000000",
        validFrom: "2026-10-01T00:00:00.000Z",
        validUntil: "2026-11-01T00:00:00.000Z",
        ...policy,
      },
      seller: SELLER,
      chainId: 133,
      token: TOKEN,
      amountBaseUnits: "1000000",
      policySha256: "a".repeat(64),
      eligibilityRulesSha256: "b".repeat(64),
      bookedTodayBaseUnits: "1000000",
      outstandingBaseUnits: "1000000",
      now: new Date("2026-10-30T10:00:00.000Z"),
      ...overrides,
    });

  it("covers a repayment within every bound and limit, exactly at the daily limit", () => {
    expect(fit()).toEqual([]);
  });

  it("names each gap", () => {
    expect(fit({}, { status: "PAUSED" })).toEqual(["the policy is PAUSED"]);
    expect(fit({}, { seller: BUYER })).toEqual(["the policy belongs to another seller"]);
    expect(fit({ chainId: 177 })).toEqual(["the policy covers another chain or token"]);
    expect(fit({ policySha256: "c".repeat(64) })).toEqual(["the policy is bound to other service terms"]);
    expect(fit({ eligibilityRulesSha256: "c".repeat(64) })).toEqual(["the policy is bound to other eligibility rules"]);
    expect(fit({ now: new Date("2026-11-01T00:00:00.000Z") })).toEqual(["the policy is outside its validity window"]);
    expect(fit({ amountBaseUnits: "1000001", bookedTodayBaseUnits: "0" })).toEqual(["the amount exceeds the per-case limit"]);
    expect(fit({ outstandingBaseUnits: "1000001" })).toEqual(["the amount would exceed today's limit with what is booked and outstanding"]);
  });
});
