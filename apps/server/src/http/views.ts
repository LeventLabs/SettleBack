import type { WalletCall } from "@settleback/adapters";
import type { BaselineResult, PaymentFacts } from "@settleback/domain";
import type { RecoveryActionRecord, DeliveryAckRecord } from "../db/actions.ts";
import type { AssessmentRecord } from "../db/assessments.ts";
import type { CaseRecord } from "../db/cases.ts";
import type { EvidenceRecord } from "../db/evidence.ts";
import type { OperationRecord } from "../db/operations.ts";
import type { PaymentAttemptRecord } from "../db/payments.ts";

/** How the signed-in account relates to an operation. Only these grant access; nothing in a request does. */
export type Relation = "buyer" | "seller" | "operator";

/** Evidence text and model assessments can quote the seller's internal records, so the buyer sees their digests only. */
function seesInternals(relations: readonly Relation[]): boolean {
  return relations.includes("seller") || relations.includes("operator");
}

export function operationView(operation: OperationRecord, relations: readonly Relation[], payment: PaymentFacts | undefined, caseRecord: CaseRecord | undefined) {
  return {
    id: operation.id,
    relations,
    environment: operation.environment,
    buyer: operation.buyer,
    seller: operation.seller,
    serviceId: operation.serviceId,
    policyId: operation.policyId,
    policySha256: operation.policySha256,
    chainId: operation.chainId,
    token: operation.token,
    priceUsd: operation.priceUsd,
    amountBaseUnits: operation.amountBaseUnits,
    intentSha256: operation.intentSha256,
    createdAt: operation.createdAt,
    originalPayment: payment === undefined ? null : { id: payment.id, state: payment.state },
    case: caseRecord === undefined ? null : { id: caseRecord.id, status: caseRecord.status },
  };
}

export interface CaseViewInput {
  caseRecord: CaseRecord;
  relations: readonly Relation[];
  operation: OperationRecord;
  payment: PaymentFacts | undefined;
  items: readonly EvidenceRecord[];
  /** The rules-only result for the current evidence, or undefined when the policy's terms are not loaded. */
  rules: BaselineResult | undefined;
  action: RecoveryActionRecord | undefined;
  ack: DeliveryAckRecord | undefined;
  assessments: readonly AssessmentRecord[];
  repayment: PaymentAttemptRecord | undefined;
  /** The reservation the seller's wallet sends, while a per-case repayment waits for it. */
  sellerCall: WalletCall | null;
}

export function caseView(input: CaseViewInput) {
  const { caseRecord, relations, operation, items, action, ack, repayment } = input;
  const internals = seesInternals(relations);
  return {
    id: caseRecord.id,
    operationId: caseRecord.operationId,
    relations,
    status: caseRecord.status,
    revision: caseRecord.revision,
    operation: {
      buyer: operation.buyer,
      seller: operation.seller,
      serviceId: operation.serviceId,
      policyId: operation.policyId,
      chainId: operation.chainId,
      token: operation.token,
      priceUsd: operation.priceUsd,
      amountBaseUnits: operation.amountBaseUnits,
      createdAt: operation.createdAt,
    },
    originalPayment: input.payment === undefined ? null : { id: input.payment.id, state: input.payment.state },
    evidence: {
      revision: caseRecord.evidence.revision,
      sha256: caseRecord.evidence.sha256,
      items: items.map((item) => ({
        id: item.id,
        source: item.source,
        provenance: item.provenance,
        mediaType: item.mediaType,
        observedAt: item.observedAt,
        receivedAt: item.receivedAt,
        contentSha256: item.contentSha256,
        storedSha256: item.storedSha256,
        ...(internals ? { content: item.content, redactions: item.redactions } : {}),
      })),
    },
    rules: input.rules === undefined ? null : internals ? input.rules : withoutRecordQuotes(input.rules, items),
    recoveryAction: action === undefined ? null : actionView(action),
    sellerCall: input.sellerCall,
    repayment: repayment === undefined ? null : attemptView(repayment),
    delivery: ack === undefined ? null : { artifactSha256: ack.artifactSha256, acknowledgedAt: ack.acknowledgedAt },
    ...(internals ? { assessments: input.assessments.map(assessmentView) } : {}),
    openedBy: caseRecord.openedBy,
    createdAt: caseRecord.createdAt,
    updatedAt: caseRecord.updatedAt,
  };
}

/** The rules' findings for a party who may not read the seller's records: quotes only from the bound terms. */
function withoutRecordQuotes(rules: BaselineResult, items: readonly EvidenceRecord[]): BaselineResult {
  const terms = new Set(items.filter((item) => item.provenance === "POLICY").map((item) => item.id));
  return {
    ...rules,
    findings: rules.findings.map((finding) => ({ ...finding, citations: finding.citations.filter((citation) => terms.has(citation.evidenceId)) })),
  };
}

export interface CaseSummaryRow {
  rules: BaselineResult | undefined;
  id: string;
  operationId: string;
  status: string;
  relations: readonly Relation[];
  serviceId: string;
  priceUsd: string;
  action: string | null;
  actionState: string | null;
  updatedAt: string;
}

export function caseSummaryView(row: CaseSummaryRow) {
  return {
    id: row.id,
    operationId: row.operationId,
    status: row.status,
    relations: row.relations,
    serviceId: row.serviceId,
    priceUsd: row.priceUsd,
    recovery: row.action === null ? null : { action: row.action, state: row.actionState },
    rules: row.rules === undefined ? null : row.rules.outcome === "RESOLVES" ? { outcome: "RESOLVES", action: row.rules.action } : { outcome: "ABSTAINS", action: null },
    updatedAt: row.updatedAt,
  };
}

/** The proposal is included in full: it is exactly what each party is asked to approve or accept. */
export function actionView(action: RecoveryActionRecord) {
  return {
    id: action.id,
    caseId: action.caseId,
    action: action.action,
    state: action.state,
    revision: action.revision,
    authorizationMode: action.authorizationMode,
    actionSha256: action.actionSha256,
    evidenceSha256: action.evidenceSha256,
    deadline: action.deadline,
    approvalTx: action.approvalTx,
    policyTx: action.policyTx,
    registryTx: action.registryTx,
    proposal: action.proposal,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

/** A payment attempt's state and references; the mandate itself is not exposed. */
export function attemptView(attempt: PaymentAttemptRecord) {
  return {
    id: attempt.id,
    purpose: attempt.purpose,
    state: attempt.state,
    payer: attempt.payer,
    payee: attempt.payee,
    chainId: attempt.chainId,
    token: attempt.token,
    amountBaseUnits: attempt.amountBaseUnits,
    paymentRequestId: attempt.paymentRequestId,
    flowId: attempt.flowId,
    txHash: attempt.txHash,
    updatedAt: attempt.updatedAt,
  };
}

/** The validated result and its decision; the raw model response stays in storage and the evidence bundle. */
export function assessmentView(record: AssessmentRecord) {
  const { request, result } = record;
  return {
    id: request.id,
    evidenceRevision: request.evidenceRevision,
    attempt: request.attempt,
    model: request.model,
    origin: request.origin,
    requestedBy: request.requestedBy,
    requestedAt: request.requestedAt,
    status: result === undefined ? "IN_PROGRESS" : result.status,
    failureCode: result?.failureCode ?? null,
    assessment: result?.assessment ?? null,
    decision: result?.decision ?? null,
    completedAt: result?.completedAt ?? null,
  };
}
