import type { DatabaseSync } from "node:sqlite";
import { evaluateBaseline, type BaselineResult, type PolicyTerms } from "@settleback/domain";
import { readCaseEvidence, type CaseRecord } from "../db/cases.ts";
import { readTransaction } from "../db/database.ts";
import type { EvidenceRecord } from "../db/evidence.ts";
import { getOperation, type OperationRecord } from "../db/operations.ts";
import { getOriginalPayment } from "../db/payments.ts";

export interface CaseBaseline {
  case: CaseRecord;
  result: BaselineResult;
}

export interface CaseBaselineSnapshot extends CaseBaseline {
  operation: OperationRecord;
  items: EvidenceRecord[];
}

/**
 * Runs the rules-only assessment over the case's current evidence snapshot. `terms` maps policy
 * IDs to their machine-readable refund rules; the operation's bound policy must be among them.
 */
export function evaluateCaseBaseline(db: DatabaseSync, caseId: string, terms: ReadonlyMap<string, PolicyTerms>): CaseBaseline {
  const { case: record, result } = readTransaction(db, () => readCaseBaseline(db, caseId, terms));
  return { case: record, result };
}

/** As evaluateCaseBaseline, for callers that already hold a transaction; also returns what it read. */
export function readCaseBaseline(db: DatabaseSync, caseId: string, terms: ReadonlyMap<string, PolicyTerms>): CaseBaselineSnapshot {
  const { case: record, items } = readCaseEvidence(db, caseId);
  const operation = getOperation(db, record.operationId);
  if (operation === undefined) throw new Error(`case ${caseId} points to missing operation ${record.operationId}`);
  const originalPayment = getOriginalPayment(db, record.operationId);
  const policy = terms.get(operation.policyId);
  if (policy === undefined) throw new Error(`no machine-readable terms are configured for policy ${operation.policyId}`);

  const result = evaluateBaseline({
    operation: {
      id: operation.id,
      buyer: operation.buyer,
      seller: operation.seller,
      chainId: operation.chainId,
      token: operation.token,
      amountBaseUnits: operation.amountBaseUnits,
      policySha256: operation.policySha256,
    },
    policy,
    originalPayment,
    evidence: items.map((item) => ({
      id: item.id,
      source: item.source,
      provenance: item.provenance,
      contentSha256: item.storedSha256,
      content: item.content,
    })),
  });
  return { case: record, operation, items, result };
}
