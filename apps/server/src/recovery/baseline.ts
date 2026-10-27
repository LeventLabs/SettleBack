import type { DatabaseSync } from "node:sqlite";
import { evaluateBaseline, type BaselineResult, type PolicyTerms } from "@settleback/domain";
import { readCaseEvidence, type CaseRecord } from "../db/cases.ts";
import { readTransaction } from "../db/database.ts";
import { getOperation } from "../db/operations.ts";
import { getOriginalPayment } from "../db/payments.ts";

export interface CaseBaseline {
  case: CaseRecord;
  result: BaselineResult;
}

/**
 * Runs the rules-only assessment over the case's current evidence snapshot. `terms` maps policy
 * IDs to their machine-readable refund rules; the operation's bound policy must be among them.
 */
export function evaluateCaseBaseline(db: DatabaseSync, caseId: string, terms: ReadonlyMap<string, PolicyTerms>): CaseBaseline {
  const { record, items, operation, originalPayment } = readTransaction(db, () => {
    const { case: record, items } = readCaseEvidence(db, caseId);
    return { record, items, operation: getOperation(db, record.operationId), originalPayment: getOriginalPayment(db, record.operationId) };
  });
  if (operation === undefined) throw new Error(`case ${caseId} points to missing operation ${record.operationId}`);
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
  return { case: record, result };
}
