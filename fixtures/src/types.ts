export const CASE_CATEGORIES = ["straightforward", "ambiguous", "conflicting", "policy-sensitive", "injected"] as const;
export const RECOVERY_ACTIONS = ["RETRIEVE", "REPAY", "ESCALATE", "FULFIL_EXISTING_PAYMENT", "NO_ACTION"] as const;
export const EVIDENCE_SOURCES = [
  "gateway-record",
  "edge-log",
  "worker-log",
  "artifact-store",
  "service-status",
  "buyer-claim",
  "policy",
] as const;
export const COMPONENTS = ["gateway", "edge", "worker", "artifact-store", "buyer", "seller"] as const;
export const PAYMENT_STATES = ["verified", "failed-without-transaction", "unknown"] as const;
export const AUTHORIZATION_MODES = ["PER_CASE", "STANDING_POLICY"] as const;
export const RULES_BASELINE = ["RESOLVES", "ABSTAINS"] as const;
export const GUARD_SIGNERS = ["seller-guard", "buyer-guard"] as const;
export const GUARD_DECISIONS = ["SIGN", "ROUTE_TO_HUMAN", "REFUSE"] as const;
export const POLICY_STATUSES = ["active", "paused", "revoked"] as const;
export const EXISTING_ACTIONS = ["NONE", "PER_CASE_RESERVED", "STANDING_RESERVED"] as const;
export const EXISTING_ATTEMPTS = ["NONE", "SIGNING_REQUESTED", "SUBMITTED", "UNKNOWN"] as const;

export type CaseCategory = (typeof CASE_CATEGORIES)[number];
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
export type Component = (typeof COMPONENTS)[number];
export type PaymentState = (typeof PAYMENT_STATES)[number];
export type AuthorizationMode = (typeof AUTHORIZATION_MODES)[number];
export type RulesBaseline = (typeof RULES_BASELINE)[number];
export type GuardSigner = (typeof GUARD_SIGNERS)[number];
export type GuardDecision = (typeof GUARD_DECISIONS)[number];
export type PolicyStatus = (typeof POLICY_STATUSES)[number];
export type ExistingAction = (typeof EXISTING_ACTIONS)[number];
export type ExistingAttempt = (typeof EXISTING_ATTEMPTS)[number];

export interface Fault {
  component: Component;
  point: string;
  description: string;
}

/** Describes evidence a running component must produce; the actual records come from the demo service. */
export interface EvidenceSpec {
  source: EvidenceSource;
  producedBy: Component;
  format: string;
  shows: string;
  jobAlias?: string;
  clockOffsetMs?: number;
  handWritten?: boolean;
  /** The hand-written text; present exactly when `handWritten` is set. */
  text?: string;
}

export interface Citation {
  source: EvidenceSource;
  mustShow: string;
}

export interface FixtureCase {
  id: string;
  title: string;
  category: CaseCategory;
  policyId: string;
  sourceId: string;
  payment: PaymentState;
  authorizationMode?: AuthorizationMode;
  faults: Fault[];
  evidence: EvidenceSpec[];
  expected: {
    classification: string;
    action: RecoveryAction;
    rulesBaseline: RulesBaseline;
    citations: Citation[];
    forbidden: string[];
    reasons: string[];
  };
}

export interface FixtureSource {
  id: string;
  file: string;
  sourceSha256: string;
  expectedArtifact: ExtractionArtifact;
  expectedArtifactSha256: string;
}

export interface ExtractionArtifact {
  schema: "settleback.extraction.v1";
  sourceId: string;
  items: ExtractedItem[];
}

export interface ExtractedItem {
  sku: string;
  name: string;
  unitPriceUsd: string | null;
  status: "available" | "discontinued";
}

export interface AuthorizationFixture {
  id: string;
  title: string;
  signer: GuardSigner;
  policy: {
    status: PolicyStatus;
    validFrom: string;
    validUntil: string;
    dailyCapBaseUnits: string;
    perCaseCapBaseUnits?: string;
    perPaymentCapBaseUnits?: string;
    maxFeeBaseUnits?: string;
    payeeAllowlist?: string[];
  };
  state: {
    at: string;
    bookedTodayBaseUnits: string;
    outstandingBaseUnits: string;
    existingAction?: ExistingAction;
    existingAttempt?: ExistingAttempt;
  };
  request: {
    amountBaseUnits: string;
    payee?: string;
  };
  expected: {
    decision: GuardDecision;
    reason: string;
  };
}
