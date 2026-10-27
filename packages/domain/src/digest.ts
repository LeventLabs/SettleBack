import { canonicalJson, sha256Hex } from "./hash.ts";
import type { OperationIntent } from "./operation.ts";

export const OPERATION_INTENT_SCHEMA = "settleback.operation-intent.v1";

/** Domain-separated digest of a validated intent; independent of property order. */
export function operationIntentSha256(intent: OperationIntent): string {
  return sha256Hex(canonicalJson({ schema: OPERATION_INTENT_SCHEMA, ...intent }));
}

export const EVIDENCE_SNAPSHOT_SCHEMA = "settleback.evidence-snapshot.v1";

export interface SnapshotItem {
  id: string;
  sequence: number;
  source: string;
  provenance: string;
  submittedBy: string;
  sourceEventId: string;
  contentSha256: string;
  storedSha256: string;
}

/**
 * Identifies the evidence an assessment or approval saw. Items are ordered by their per-operation
 * sequence, so the snapshot at revision r is exactly the items with sequence <= r.
 */
export function evidenceSnapshotSha256(operationId: string, items: readonly SnapshotItem[]): string {
  const ordered = [...items].sort((a, b) => a.sequence - b.sequence);
  ordered.forEach((item, index) => {
    if (item.sequence !== index + 1) throw new Error(`evidence sequence must be contiguous from 1; found ${item.sequence} at position ${index + 1}`);
  });
  return sha256Hex(
    canonicalJson({
      schema: EVIDENCE_SNAPSHOT_SCHEMA,
      operationId,
      items: ordered.map((item) => ({ ...item })),
    }),
  );
}
