import type { PaymentFacts } from "@settleback/domain";
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

export function caseView(
  caseRecord: CaseRecord,
  relations: readonly Relation[],
  items: readonly EvidenceRecord[],
  action: RecoveryActionRecord | undefined,
  ack: DeliveryAckRecord | undefined,
  assessments: readonly AssessmentRecord[],
  repayment: PaymentAttemptRecord | undefined,
) {
  const internals = seesInternals(relations);
  return {
    id: caseRecord.id,
    operationId: caseRecord.operationId,
    relations,
    status: caseRecord.status,
    revision: caseRecord.revision,
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
    recoveryAction: action === undefined ? null : actionView(action),
    repayment: repayment === undefined ? null : attemptView(repayment),
    delivery: ack === undefined ? null : { artifactSha256: ack.artifactSha256, acknowledgedAt: ack.acknowledgedAt },
    ...(internals ? { assessments: assessments.map(assessmentView) } : {}),
    openedBy: caseRecord.openedBy,
    createdAt: caseRecord.createdAt,
    updatedAt: caseRecord.updatedAt,
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
