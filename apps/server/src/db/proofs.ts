import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "@settleback/domain/hash";
import { immediateTransaction } from "./database.ts";
import { appendEvent } from "./events.ts";
import { ProofAlreadyAllocatedError, isUniqueViolation } from "./errors.ts";

export interface ProofAllocationInput {
  deploymentId: string;
  chainId: number;
  proofId: string;
  proofType: "ORIGINAL_PAYMENT" | "REPAYMENT";
  operationId: string;
  actionId: string | null;
  actor: string;
  now: string;
}

/**
 * Binds a settlement proof to exactly one operation or recovery action. A proof already bound
 * anywhere in this deployment and chain, or a second original for the same operation, is refused.
 */
export function allocateProof(db: DatabaseSync, input: ProofAllocationInput): void {
  immediateTransaction(db, () => insertProofAllocation(db, input));
}

/** As allocateProof, for callers that already hold a transaction. */
export function insertProofAllocation(db: DatabaseSync, input: ProofAllocationInput): void {
  const proofId = input.proofId.toLowerCase();
  try {
    db.prepare(
      `INSERT INTO proof_allocations (deployment_id, chain_id, proof_id, proof_type, operation_id, action_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.deploymentId, input.chainId, proofId, input.proofType, input.operationId, input.actionId, input.now);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProofAlreadyAllocatedError(proofId);
    throw error;
  }
  appendEvent(db, {
    entityType: input.actionId === null ? "operation" : "recovery_action",
    entityId: input.actionId ?? input.operationId,
    eventType: "PROOF_ALLOCATED",
    priorRevision: null,
    newRevision: null,
    actor: input.actor,
    payloadSha256: sha256Hex(proofId),
    createdAt: input.now,
  });
}
