// Labels and tones. Only confirmed final states are ever shown as done; anything uncertain is a warning.

export type Tone = "done" | "pending" | "attention" | "neutral";

const STATE_TONES: Record<string, Tone> = {
  RECOVERED: "done",
  REPAID: "done",
  COMPLETED: "done",
  VERIFIED: "pending",
  QUARANTINED: "attention",
  UNKNOWN: "attention",
  FAILED: "attention",
  STRANDED: "attention",
  REVIEW_REQUIRED: "attention",
  UNRESOLVED: "attention",
};

const PENDING = ["ASSESSING", "ACTION_PREPARED", "RESERVED", "EXECUTION_REQUESTED", "DELIVERY_ACKED", "RECORD_PENDING", "SIGNING_REQUESTED", "SUBMITTED", "OBSERVED", "PREPARED"];

export function toneOf(state: string, final = true): Tone {
  const tone = STATE_TONES[state];
  if (tone === "done" && !final) return "pending";
  if (tone !== undefined) return tone;
  return PENDING.includes(state) ? "pending" : "neutral";
}

const STATE_LABELS: Record<string, string> = {
  OPEN: "Open",
  ASSESSING: "Assessing",
  REVIEW_REQUIRED: "Review required",
  UNRESOLVED: "Unresolved",
  ACTION_PREPARED: "Recovery prepared",
  RESERVED: "Reserved on registry",
  EXECUTION_REQUESTED: "Execution requested",
  VERIFIED: "Verified, record pending",
  DELIVERY_ACKED: "Delivery acknowledged",
  RECORD_PENDING: "Registry record pending",
  RECOVERED: "Recovered",
  REPAID: "Repaid",
  QUARANTINED: "Quarantined",
  PREPARED: "Prepared",
  COMPLETED: "Completed",
  STRANDED: "Stranded",
  CREATED: "Created",
  SIGNING_REQUESTED: "Signing requested",
  SUBMITTED: "Submitted to gateway",
  OBSERVED: "Observed on chain",
  UNKNOWN: "Unknown, needs reconciliation",
  REJECTED_NO_SEND: "Rejected, not sent",
  FAILED: "Failed",
};

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/** A payment attempt's VERIFIED is final: the gateway record and the chain transfer matched. */
export function paymentLabel(state: string): string {
  return state === "VERIFIED" ? "Verified on gateway and chain" : stateLabel(state);
}

export function paymentTone(state: string): Tone {
  return state === "VERIFIED" ? "done" : toneOf(state);
}

export const SOURCE_LABELS: Record<string, string> = {
  "gateway-record": "Gateway record",
  "edge-log": "Edge proxy log",
  "worker-log": "Worker log",
  "artifact-store": "Artifact store",
  "service-status": "Job service status",
  "buyer-claim": "Buyer claim",
  policy: "Service terms",
  chain: "Chain",
};

export const PROVENANCE_LABELS: Record<string, string> = {
  AUTHENTICATED_SERVICE: "Seller service (authenticated)",
  GATEWAY: "Gateway (reconciled)",
  CHAIN: "Chain (reconciled)",
  CLAIM: "Claim, not proof",
  POLICY: "Bound terms",
};

/** Which lane of the timeline an evidence source belongs to. */
export function laneOf(source: string): "payment" | "execution" | "delivery" | "terms" {
  if (source === "gateway-record" || source === "chain") return "payment";
  if (source === "edge-log" || source === "worker-log" || source === "service-status") return "execution";
  if (source === "policy") return "terms";
  return "delivery";
}

const ACTION_LABELS: Record<string, string> = {
  RETRIEVE: "Deliver the existing result",
  REPAY: "Seller-funded repayment",
  NO_ACTION: "No recovery owed",
  ESCALATE: "Escalate to a person",
  FULFIL_EXISTING_PAYMENT: "Run the job under the existing payment",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function short(value: string, keep = 6): string {
  if (value.length <= keep * 2 + 2) return value;
  return `${value.slice(0, keep + 2)}…${value.slice(-keep)}`;
}

export function when(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function roleLabel(relations: readonly string[]): string {
  return relations.length === 0 ? "No role" : relations.map((relation) => relation[0]?.toUpperCase() + relation.slice(1)).join(" · ");
}
