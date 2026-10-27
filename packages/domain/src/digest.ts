import { canonicalJson, sha256Hex } from "./hash.ts";
import type { OperationIntent } from "./operation.ts";

export const OPERATION_INTENT_SCHEMA = "settleback.operation-intent.v1";

/** Domain-separated digest of a validated intent; independent of property order. */
export function operationIntentSha256(intent: OperationIntent): string {
  return sha256Hex(canonicalJson({ schema: OPERATION_INTENT_SCHEMA, ...intent }));
}
