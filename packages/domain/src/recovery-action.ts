import type { AssessmentDecision } from "./assessment.ts";
import type { BaselineResult } from "./baseline.ts";
import { BASELINE_RULES_VERSION } from "./baseline.ts";
import type { TransferTerms } from "./guards.ts";
import type { Address } from "./operation.ts";
import { canonicalJson, sha256Hex } from "./hash.ts";

/**
 * A recovery proposal fixes everything a recovery may do before anyone approves it: the action,
 * why it is eligible, the evidence revision it was based on, the service terms, the exact transfer
 * for a repayment, the artifact for a retrieval, the deadline, the registry, and the authority
 * mode. Its digest is what the registry records, so an approval can only ever match these terms.
 */
export const RECOVERY_ACTION_SCHEMA = "settleback.recovery-action.v1";
export const REGISTRY_CASE_KEY_SCHEMA = "settleback.registry-case-key.v1";
/** Identifies eligibility found by the deterministic checks on a verified artifact lead (see assessment.ts). */
export const VERIFIED_ARTIFACT_LEAD_RULES = "settleback.verified-artifact-lead.v1";

export type RecoveryKind = "RETRIEVE" | "REPAY";
export type EligibilityBasis = "RULES_BASELINE" | "VERIFIED_ARTIFACT_LEAD";

export interface Eligibility {
  action: RecoveryKind;
  basis: EligibilityBasis;
  classification: string;
}

export type EligibilityResult = { eligible: true; eligibility: Eligibility } | { eligible: false; reason: string };

/**
 * What the current evidence revision justifies. A repayment comes only from the rules. A model
 * assessment contributes only through its code-verified artifact lead, and only toward retrieval.
 */
export function deriveEligibility(baseline: BaselineResult, decision: AssessmentDecision | undefined): EligibilityResult {
  if (baseline.outcome === "RESOLVES") {
    if (baseline.action === "REPAY" || baseline.action === "RETRIEVE") {
      return { eligible: true, eligibility: { action: baseline.action, basis: "RULES_BASELINE", classification: baseline.classification } };
    }
    return { eligible: false, reason: `the rules resolve this case as ${baseline.action}, which is not a recovery action` };
  }
  if (decision?.action === "RETRIEVE") {
    return { eligible: true, eligibility: { action: "RETRIEVE", basis: "VERIFIED_ARTIFACT_LEAD", classification: "completed-delivery-lost" } };
  }
  return { eligible: false, reason: "the rules abstained and no assessment for this evidence revision verified a retrievable artifact" };
}

export function eligibilityRulesSha256(basis: EligibilityBasis): string {
  return sha256Hex(basis === "RULES_BASELINE" ? BASELINE_RULES_VERSION : VERIFIED_ARTIFACT_LEAD_RULES);
}

export interface RegistryRef {
  chainId: number;
  address: Address;
}

/** The registry key for a case: specific to the case and to the registry deployment. */
export function registryCaseKey(caseId: string, registry: RegistryRef): string {
  return `0x${sha256Hex([REGISTRY_CASE_KEY_SCHEMA, String(registry.chainId), registry.address.toLowerCase(), caseId].join("\n"))}`;
}

export type ProposalAuthorization = { mode: "PER_CASE" } | { mode: "STANDING_POLICY"; scope: string; version: number };

export interface RecoveryProposal {
  schema: typeof RECOVERY_ACTION_SCHEMA;
  caseId: string;
  caseKey: string;
  operationId: string;
  action: RecoveryKind;
  basis: EligibilityBasis;
  classification: string;
  evidenceRevision: number;
  evidenceSha256: string;
  policySha256: string;
  eligibilityRulesSha256: string;
  autoEligible: boolean;
  /** The operation's parties and principal, as the registry records them for every case. */
  parties: OperationParties;
  /** The original payment the case concerns, on the parties' chain. */
  originalTxHash: string;
  /** Exact repayment for REPAY: seller to original payer, same chain and token, the full principal. */
  transfer: TransferTerms | null;
  /** The artifact to deliver for RETRIEVE. */
  artifactSha256: string | null;
  deadline: string;
  registry: RegistryRef;
  authorization: ProposalAuthorization | null;
}

export interface OperationParties {
  buyer: Address;
  seller: Address;
  chainId: number;
  token: Address;
  amountBaseUnits: string;
}

export function proposalSha256(proposal: RecoveryProposal): string {
  return sha256Hex(canonicalJson(proposal as unknown as Parameters<typeof canonicalJson>[0]));
}

/**
 * The repayment a proposal may carry: from the seller to the buyer who paid, on the original chain
 * and token, for the principal. Nothing about it comes from the requester.
 */
export function repaymentTransfer(operation: OperationParties): TransferTerms {
  return { payer: operation.seller, payee: operation.buyer, chainId: operation.chainId, token: operation.token, amountBaseUnits: operation.amountBaseUnits };
}

export interface StandingPolicyView {
  status: "ACTIVE" | "PAUSED" | "REVOKED" | "REPLACED";
  seller: Address;
  token: Address;
  paymentChainId: number;
  servicePolicySha256: string;
  eligibilityRulesSha256: string;
  maxPerCaseBaseUnits: string;
  dailyLimitBaseUnits: string;
  validFrom: string;
  validUntil: string;
}

export interface PolicyFitInput {
  policy: StandingPolicyView;
  seller: Address;
  chainId: number;
  token: Address;
  amountBaseUnits: string;
  policySha256: string;
  eligibilityRulesSha256: string;
  bookedTodayBaseUnits: string;
  outstandingBaseUnits: string;
  now: Date;
}

/**
 * Whether the seller's active standing policy covers this repayment, read from confirmed registry
 * state. The registry enforces the same limits again when the delegate reserves; this read only
 * decides whether to route the case to the delegate or to the seller for an explicit approval.
 */
export function standingPolicyGaps(input: PolicyFitInput): string[] {
  const { policy } = input;
  const gaps: string[] = [];
  const at = input.now.getTime();
  if (policy.status !== "ACTIVE") gaps.push(`the policy is ${policy.status}`);
  if (policy.seller.toLowerCase() !== input.seller.toLowerCase()) gaps.push("the policy belongs to another seller");
  if (policy.token.toLowerCase() !== input.token.toLowerCase() || policy.paymentChainId !== input.chainId) gaps.push("the policy covers another chain or token");
  if (policy.servicePolicySha256 !== input.policySha256) gaps.push("the policy is bound to other service terms");
  if (policy.eligibilityRulesSha256 !== input.eligibilityRulesSha256) gaps.push("the policy is bound to other eligibility rules");
  if (at < Date.parse(policy.validFrom) || at >= Date.parse(policy.validUntil)) gaps.push("the policy is outside its validity window");
  const amount = BigInt(input.amountBaseUnits);
  if (amount > BigInt(policy.maxPerCaseBaseUnits)) gaps.push("the amount exceeds the per-case limit");
  if (BigInt(input.bookedTodayBaseUnits) + BigInt(input.outstandingBaseUnits) + amount > BigInt(policy.dailyLimitBaseUnits)) {
    gaps.push("the amount would exceed today's limit with what is booked and outstanding");
  }
  return gaps;
}
