// Response shapes of the SettleBack API, as the server's views define them.

export type Relation = "buyer" | "seller" | "operator";

export interface Health {
  environment: string;
  mode: "simulated" | "live";
  networkProfile: string;
  networkLabel: string;
  paymentChainId: number;
  registryChainId: number;
  paymentWrites: "enabled" | "disabled";
  paymentGateway: "simulated" | "hsp-agentic" | "none";
  registry: { status: "connected"; chainId: number; address: string; provenance: string } | { status: "not configured" };
}

export interface Session {
  address: string;
  chainId: number;
  roles: string[];
  expiresAt: string;
}

export interface SignInChallenge {
  challenge: string;
  message: string;
  expiresAt: string;
}

export interface CaseSummary {
  id: string;
  operationId: string;
  status: string;
  relations: Relation[];
  serviceId: string;
  priceUsd: string;
  recovery: { action: string; state: string } | null;
  rules: { outcome: "RESOLVES"; action: string } | { outcome: "ABSTAINS"; action: null } | null;
  updatedAt: string;
}

export interface EvidenceItem {
  id: string;
  source: string;
  provenance: string;
  mediaType: string;
  observedAt: string | null;
  receivedAt: string;
  contentSha256: string;
  storedSha256: string;
  content?: string;
}

export interface SpanRef {
  evidenceId: string;
  start: number;
  end: number;
  quote: string;
}

export interface RulesFinding {
  code: string;
  statement: string;
  support: "supported" | "unsupported";
  citations: SpanRef[];
}

export type RulesResult =
  | { outcome: "RESOLVES"; action: string; classification: string; findings: RulesFinding[] }
  | { outcome: "ABSTAINS"; reasons: { code: string; message: string }[]; missingEvidence: string[]; findings: RulesFinding[] };

export interface AssessmentFinding {
  statement: string;
  support: string;
  citations: { evidenceId: string; quote: string }[];
}

export interface AssessmentView {
  id: string;
  evidenceRevision: number;
  attempt: number;
  model: string;
  origin: string;
  requestedBy: string;
  requestedAt: string;
  status: "SUCCEEDED" | "FAILED" | "IN_PROGRESS";
  failureCode: string | null;
  assessment: { findings: AssessmentFinding[]; suggestedAction: string; artifactSha256: string | null; missingEvidence: string[]; explanation: string } | null;
  decision: { action: "RETRIEVE"; basis: string; artifactSha256: string; writer: string } | { action: "ESCALATE"; reasons: { code: string; message: string }[] } | null;
  completedAt: string | null;
}

export interface Proposal {
  caseKey: string;
  action: "RETRIEVE" | "REPAY";
  basis: string;
  classification: string;
  evidenceRevision: number;
  transfer: { payer: string; payee: string; chainId: number; token: string; amountBaseUnits: string } | null;
  artifactSha256: string | null;
  deadline: string;
  registry: { chainId: number; address: string };
  authorization: { mode: "PER_CASE" } | { mode: "STANDING_POLICY"; scope: string; version: number } | null;
}

export interface ActionView {
  id: string;
  action: "RETRIEVE" | "REPAY";
  state: string;
  authorizationMode: string | null;
  actionSha256: string;
  deadline: string;
  approvalTx: string | null;
  policyTx: string | null;
  registryTx: string | null;
  proposal: Proposal;
  updatedAt: string;
}

export interface PaymentView {
  id: string;
  purpose: string;
  state: string;
  payer: string;
  payee: string;
  chainId: number;
  amountBaseUnits: string;
  txHash: string | null;
  updatedAt: string;
}

export interface WalletCall {
  chainId: number;
  to: string;
  data: string;
}

export interface CaseView {
  id: string;
  operationId: string;
  relations: Relation[];
  status: string;
  revision: number;
  operation: { environment: string; buyer: string; seller: string; serviceId: string; policyId: string; chainId: number; token: string; tokenDecimals: number; priceUsd: string; amountBaseUnits: string; createdAt: string };
  originalPayment: { id: string; state: string } | null;
  evidence: { revision: number; sha256: string; items: EvidenceItem[] };
  rules: RulesResult | null;
  recoveryAction: ActionView | null;
  sellerCall: WalletCall | null;
  repayment: PaymentView | null;
  delivery: { artifactSha256: string; acknowledgedAt: string } | null;
  assessments?: AssessmentView[];
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseCheck {
  id: string;
  label: string;
  status: "passed" | "blocked" | "not-checked";
  reason: string | null;
}

export type PurchaseEventKind = "payment-verified" | "payment-unknown" | "job-started" | "delivered" | "error-response" | "deadline-passed" | "case-opened" | "records-updated";

/** A job bought from the workspace, as the server reports it; the stage follows server state only. */
export interface PurchaseView {
  operationId: string;
  scenario: { id: string; label: string };
  createdAt: string;
  stage: "review" | "authorize" | "payment" | "job";
  job: { serviceId: string; seller: string; priceUsd: string; amountBaseUnits: string; chainId: number; token: string; policyId: string };
  quote: {
    merchantName: string;
    cartMandateId: string;
    paymentRequestId: string;
    cartSha256: string;
    flowId: string | null;
    expiresAt: string;
    maxFeeBaseUnits: string;
    grossLimitBaseUnits: string | null;
    payeeAllowlist: string[];
    perPaymentCapBaseUnits: string;
    dailyCapBaseUnits: string;
  } | null;
  checks: PurchaseCheck[];
  authorization: AuthorizationSummary | null;
  payments: PaymentsInfo;
  payment: PaymentView | null;
  signatureSubmittedAt: string | null;
  run: { startedAt: string; deadlineAt: string; response: { status: number; at: string } | null } | null;
  events: { at: string; kind: PurchaseEventKind }[];
  caseId: string | null;
  done: boolean;
}

/** What a wallet is about to authorize, as the server checked it. */
export interface AuthorizationSummary {
  recipient: string;
  payer: string;
  /** Raw token units, exactly as authorized. */
  amountBaseUnits: string;
  quoteExpiresAt: string | null;
  preparedBy: "payment-agent" | "hsp";
}

export interface PaymentsInfo {
  gateway: "simulated" | "hsp-agentic";
  provenance: "SIMULATED" | "LIVE";
  chainId: number;
  token: string;
  tokenDecimals: number;
  coin: string;
}

/** The typed data a wallet signs (eth_signTypedData_v4). */
export interface TypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SignatureRequest {
  status: string;
  typedData?: TypedData;
  authorization?: AuthorizationSummary;
}
