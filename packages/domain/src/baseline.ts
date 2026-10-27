import type { EvidenceProvenance, EvidenceSource } from "./evidence.ts";
import {
  checkJobStart,
  checkRefundEligibility,
  type OperationFacts,
  type PaymentFacts,
  type ReasonCode,
  type RefundRule,
} from "./guards.ts";
import { findLineSpan, findSpan, leadingSpan, type SpanRef } from "./spans.ts";
import { SERVICE_JOB_STATES, type ServiceJobState } from "./states.ts";

/**
 * The rules-only assessment. It reads structured records from trusted sources and nothing else:
 * free-text logs and claims never change its outcome. When those records do not settle the case
 * it abstains instead of guessing, and a missing record is never read as proof that a job did not run.
 */
export const BASELINE_RULES_VERSION = "settleback.rules-baseline.v1";

export interface PolicyTerms {
  id: string;
  sha256: string;
  refundRule: RefundRule;
  /** Clause numbers in the policy text, cited by the findings that rely on them. */
  clauses: { delivery: string; refund: string; timeout: string; evidence: string };
}

export interface BaselineEvidence {
  id: string;
  source: EvidenceSource;
  provenance: EvidenceProvenance;
  /** SHA-256 of `content`, the stored text. */
  contentSha256: string;
  content: string;
}

export interface BaselineInput {
  operation: OperationFacts;
  policy: PolicyTerms;
  /** The operation's live original payment attempt or, if none is live, its latest closed one. */
  originalPayment: PaymentFacts | undefined;
  evidence: readonly BaselineEvidence[];
}

export type BaselineAction = "RETRIEVE" | "REPAY" | "ESCALATE" | "FULFIL_EXISTING_PAYMENT" | "NO_ACTION";

export type BaselineCode =
  | "POLICY_CHANGED"
  | "PAYMENT_MISSING"
  | "PAYMENT_PENDING"
  | "PAYMENT_UNCERTAIN"
  | "PAYMENT_MISMATCH"
  | "PAYMENT_RECORD_CONFLICT"
  | "INVALID_RECORD"
  | "OPERATION_MISMATCH"
  | "NO_SERVICE_STATUS"
  | "SERVICE_RECORD_CONFLICT"
  | "JOB_NOT_TERMINAL"
  | "NO_ARTIFACT_RECORD"
  | "PAYMENT_NOT_SETTLED"
  | "PAYMENT_VERIFIED"
  | "JOB_NOT_STARTED"
  | "TERMINAL_FAILURE_REFUNDABLE"
  | "TERMINAL_FAILURE_BILLABLE"
  | "ARTIFACT_RETRIEVABLE"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_ALTERED"
  | "ARTIFACT_WRITER_MISMATCH"
  | "UNSUPPORTED_CLAIM";

export interface BaselineFinding {
  code: BaselineCode;
  statement: string;
  /** "unsupported" marks claims: recorded and shown, never used as proof. */
  support: "supported" | "unsupported";
  citations: SpanRef[];
}

export interface BaselineReason {
  code: BaselineCode;
  message: string;
}

export type BaselineResult =
  | {
      rulesVersion: typeof BASELINE_RULES_VERSION;
      outcome: "RESOLVES";
      action: BaselineAction;
      classification: string;
      findings: BaselineFinding[];
    }
  | {
      rulesVersion: typeof BASELINE_RULES_VERSION;
      outcome: "ABSTAINS";
      reasons: BaselineReason[];
      missingEvidence: string[];
      findings: BaselineFinding[];
    };

export interface ServiceStatusRecord {
  operationId: string;
  externalJobId: string | null;
  state: ServiceJobState;
  artifactSha256: string | null;
  computeStarted: boolean;
}

export interface ArtifactStoreRecord {
  sha256: string;
  writer: string;
  size: number;
  storedAt: string;
  currentSha256: string;
}

export interface GatewayRecordFacts {
  paymentRequestId: string;
  status: string;
  txSignature: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const TERMINAL_JOB_STATES: readonly ServiceJobState[] = ["COMPLETED", "FAILED"];
const PAYMENT_TERMS_MISMATCH: readonly ReasonCode[] = [
  "OPERATION_MISMATCH",
  "NOT_ORIGINAL_PAYMENT",
  "PAYER_MISMATCH",
  "PAYEE_MISMATCH",
  "CHAIN_MISMATCH",
  "TOKEN_MISMATCH",
  "AMOUNT_MISMATCH",
];

class Abstain extends Error {
  readonly reason: BaselineReason;
  readonly missing: string[];

  constructor(code: BaselineCode, message: string, missing: string[] = []) {
    super(message);
    this.reason = { code, message };
    this.missing = missing;
  }
}

export function evaluateBaseline(input: BaselineInput): BaselineResult {
  const findings = claimFindings(input.evidence);
  try {
    const resolution = resolve(input, findings);
    return { rulesVersion: BASELINE_RULES_VERSION, outcome: "RESOLVES", ...resolution, findings };
  } catch (error) {
    if (!(error instanceof Abstain)) throw error;
    return {
      rulesVersion: BASELINE_RULES_VERSION,
      outcome: "ABSTAINS",
      reasons: [error.reason],
      missingEvidence: error.missing,
      findings,
    };
  }
}

function resolve(input: BaselineInput, findings: BaselineFinding[]): { action: BaselineAction; classification: string } {
  const { operation, policy, originalPayment } = input;
  if (policy.sha256 !== operation.policySha256) {
    throw new Abstain("POLICY_CHANGED", "the supplied terms are not the terms bound to the operation");
  }
  const policyItem = input.evidence.find((item) => item.provenance === "POLICY" && item.source === "policy" && item.contentSha256 === policy.sha256);
  const clause = (number: string): SpanRef[] => {
    if (policyItem === undefined) return [];
    const span = findLineSpan(policyItem.id, policyItem.content, new RegExp(`^${escapeRegExp(number)}\\. `));
    return span === undefined ? [] : [span];
  };

  const gatewayItems = trusted(input.evidence, "gateway-record", "GATEWAY").map((item) => ({ item, record: parseOrAbstain(item, parseGatewayRecord) }));

  if (originalPayment === undefined) {
    throw new Abstain("PAYMENT_MISSING", "no original payment attempt is recorded", ["the original payment attempt"]);
  }
  const paymentCheck = checkJobStart(operation, originalPayment);
  const mismatches = paymentCheck.ok ? [] : paymentCheck.reasons.filter((reason) => PAYMENT_TERMS_MISMATCH.includes(reason.code));
  if (mismatches.length > 0) {
    throw new Abstain("PAYMENT_MISMATCH", mismatches.map((reason) => reason.message).join("; "));
  }

  if (originalPayment.state === "FAILED" || originalPayment.state === "REJECTED_NO_SEND") {
    const withTransaction = gatewayItems.find(({ record }) => record.txSignature !== null);
    if (withTransaction !== undefined) {
      throw new Abstain("PAYMENT_RECORD_CONFLICT", "the payment is closed as unsent, but a gateway record names a transaction");
    }
    findings.push({
      code: "PAYMENT_NOT_SETTLED",
      statement: `The original payment is ${originalPayment.state} and no settlement transaction exists, so there is nothing to repay.`,
      support: "supported",
      citations: gatewayItems.flatMap(({ item, record }) => cite(item, `"status": "${record.status}"`, `"tx_signature": null`)),
    });
    return { action: "NO_ACTION", classification: "payment-not-settled" };
  }
  if (originalPayment.state === "UNKNOWN") {
    throw new Abstain("PAYMENT_UNCERTAIN", "the original payment outcome is unknown and must be reconciled first", [
      "a reconciled gateway record and on-chain transfer for the original payment",
    ]);
  }
  if (originalPayment.state !== "VERIFIED") {
    throw new Abstain("PAYMENT_PENDING", `the original payment is ${originalPayment.state}, not yet verified`, [
      "verification of the original payment",
    ]);
  }
  const failedRecord = gatewayItems.find(({ record }) => record.status === "payment-failed");
  if (failedRecord !== undefined) {
    throw new Abstain("PAYMENT_RECORD_CONFLICT", "the payment is verified, but a gateway record reports it failed");
  }
  findings.push({
    code: "PAYMENT_VERIFIED",
    statement: "The original payment is verified against the gateway record and the chain.",
    support: "supported",
    citations: gatewayItems.flatMap(({ item, record }) => cite(item, `"status": "${record.status}"`)),
  });

  const status = currentStatus(input);
  const statusItem = status.item;
  const job = status.record;

  if (job.state === "NOT_STARTED") {
    findings.push({
      code: "JOB_NOT_STARTED",
      statement: "The service has no job for this operation, so the verified payment can be fulfilled once without a new payment.",
      support: "supported",
      citations: cite(statusItem, `"state": "NOT_STARTED"`),
    });
    return { action: "FULFIL_EXISTING_PAYMENT", classification: "paid-not-started" };
  }
  if (!TERMINAL_JOB_STATES.includes(job.state)) {
    throw new Abstain("JOB_NOT_TERMINAL", `the service's last structured status is ${job.state}`, [
      "a terminal status record from the job service, or the stored artifact located by its digest",
    ]);
  }

  if (job.state === "FAILED") {
    const refund = checkRefundEligibility({
      rule: policy.refundRule,
      operation,
      originalPayment,
      job: { operationId: job.operationId, state: job.state, computeStarted: job.computeStarted, artifactSha256: job.artifactSha256 },
    });
    if (refund.ok) {
      findings.push({
        code: "TERMINAL_FAILURE_REFUNDABLE",
        statement: "The job failed terminally before producing an artifact, and the bound terms permit a full repayment of the principal.",
        support: "supported",
        citations: [...cite(statusItem, `"state": "FAILED"`, `"artifactSha256": null`), ...clause(policy.clauses.refund)],
      });
      return { action: "REPAY", classification: "terminal-failure-refundable" };
    }
    if (refund.reasons.every((reason) => reason.code === "COMPUTE_BILLABLE")) {
      findings.push({
        code: "TERMINAL_FAILURE_BILLABLE",
        statement: "The job failed after compute started, and the bound terms keep started compute billable.",
        support: "supported",
        citations: [...cite(statusItem, `"state": "FAILED"`, `"computeStarted": true`), ...clause(policy.clauses.refund)],
      });
      return { action: "NO_ACTION", classification: "terminal-failure-billable" };
    }
    throw new Abstain("SERVICE_RECORD_CONFLICT", refund.reasons.map((reason) => reason.message).join("; "));
  }

  const digest = job.artifactSha256;
  if (digest === null) throw new Abstain("INVALID_RECORD", "a COMPLETED status must name its artifact digest");
  const storeItems = trusted(input.evidence, "artifact-store", "AUTHENTICATED_SERVICE").map((item) => ({ item, records: parseOrAbstain(item, parseArtifactRecords) }));
  if (storeItems.length === 0) {
    throw new Abstain("NO_ARTIFACT_RECORD", "the job reports completion, but no artifact store record is available", [
      `the artifact store record for ${digest}`,
    ]);
  }
  const matches = storeItems.flatMap(({ item, records }) => records.filter((record) => record.sha256 === digest).map((record) => ({ item, record })));
  const statusDigest = cite(statusItem, `"artifactSha256": "${digest}"`);

  if (matches.length === 0) {
    findings.push({
      code: "ARTIFACT_MISSING",
      statement: "The job reports a completed artifact that the artifact store does not hold.",
      support: "supported",
      citations: [...statusDigest, ...storeItems.flatMap(({ item }) => cite(item))],
    });
    return { action: "ESCALATE", classification: "unresolved-conflict" };
  }
  const altered = matches.find(({ record }) => record.currentSha256 !== digest);
  if (altered !== undefined) {
    findings.push({
      code: "ARTIFACT_ALTERED",
      statement: "The stored artifact's bytes no longer match the digest recorded at completion.",
      support: "supported",
      citations: [...statusDigest, ...cite(altered.item, `"currentSha256": "${altered.record.currentSha256}"`)],
    });
    return { action: "ESCALATE", classification: "unresolved-conflict" };
  }
  const foreign = matches.find(({ record }) => record.writer !== job.externalJobId);
  if (foreign !== undefined) {
    findings.push({
      code: "ARTIFACT_WRITER_MISMATCH",
      statement: "The stored artifact was written by a different job than the one serving this operation.",
      support: "supported",
      citations: [...cite(statusItem, `"externalJobId": "${job.externalJobId ?? ""}"`), ...cite(foreign.item, `"writer": "${foreign.record.writer}"`)],
    });
    return { action: "ESCALATE", classification: "unresolved-conflict" };
  }
  const [match] = matches;
  if (match === undefined) throw new Error("unreachable: matches is non-empty");
  findings.push({
    code: "ARTIFACT_RETRIEVABLE",
    statement: "The job completed, and the stored artifact matches its digest and was written by this operation's job; the buyer can retrieve it without a new paid job.",
    support: "supported",
    citations: [
      ...cite(statusItem, `"state": "COMPLETED"`, `"artifactSha256": "${digest}"`),
      ...cite(match.item, `"sha256": "${digest}"`, `"writer": "${match.record.writer}"`),
      ...clause(policy.clauses.delivery),
    ],
  });
  return { action: "RETRIEVE", classification: "completed-delivery-lost" };
}

/**
 * The job's status from authenticated structured records. One terminal record settles it; two
 * different terminal records, or disagreeing job identities, are a conflict.
 */
function currentStatus(input: BaselineInput): { item: BaselineEvidence; record: ServiceStatusRecord } {
  const statuses = trusted(input.evidence, "service-status", "AUTHENTICATED_SERVICE").map((item) => ({ item, record: parseOrAbstain(item, parseServiceStatus) }));
  if (statuses.length === 0) {
    throw new Abstain("NO_SERVICE_STATUS", "no authenticated structured job status is available; missing records do not show the job never ran", [
      "the structured job status from the service",
    ]);
  }
  for (const { record } of statuses) {
    if (record.operationId !== input.operation.id) {
      throw new Abstain("OPERATION_MISMATCH", `a job status belongs to operation ${record.operationId}`);
    }
  }
  const jobIds = new Set(statuses.map(({ record }) => record.externalJobId).filter((id) => id !== null));
  if (jobIds.size > 1) throw new Abstain("SERVICE_RECORD_CONFLICT", "job status records name different jobs");

  const terminal = statuses.filter(({ record }) => TERMINAL_JOB_STATES.includes(record.state));
  const distinctTerminal = new Set(terminal.map(({ record }) => `${record.state}:${record.artifactSha256 ?? ""}`));
  if (distinctTerminal.size > 1) throw new Abstain("SERVICE_RECORD_CONFLICT", "job status records report different terminal outcomes");
  const [settled] = terminal;
  if (settled !== undefined) return settled;

  const started = statuses.find(({ record }) => record.state !== "NOT_STARTED");
  if (started !== undefined) return started;
  const [notStarted] = statuses;
  if (notStarted === undefined) throw new Error("unreachable: statuses is non-empty");
  return notStarted;
}

function claimFindings(evidence: readonly BaselineEvidence[]): BaselineFinding[] {
  return evidence
    .filter((item) => item.provenance === "CLAIM")
    .map((item) => ({
      code: "UNSUPPORTED_CLAIM" as const,
      statement: `A ${item.source} item was submitted by a person; it is recorded as a claim and not used as proof.`,
      support: "unsupported" as const,
      citations: [leadingSpan(item.id, item.content)],
    }));
}

function trusted(evidence: readonly BaselineEvidence[], source: EvidenceSource, provenance: EvidenceProvenance): BaselineEvidence[] {
  return evidence.filter((item) => item.source === source && item.provenance === provenance);
}

function parseOrAbstain<T>(item: BaselineEvidence, parse: (content: string) => T | undefined): T {
  const parsed = parse(item.content);
  if (parsed === undefined) throw new Abstain("INVALID_RECORD", `${item.source} item ${item.id} is not a valid structured record`);
  return parsed;
}

/** Spans for each quote that occurs in the item; the item's leading span when none does. */
function cite(item: BaselineEvidence, ...quotes: string[]): SpanRef[] {
  const spans = quotes.map((quote) => findSpan(item.id, item.content, quote)).filter((span) => span !== undefined);
  return spans.length > 0 ? spans : [leadingSpan(item.id, item.content)];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseServiceStatus(content: string): ServiceStatusRecord | undefined {
  const o = parseObject(content);
  if (o === undefined) return undefined;
  const { operationId, externalJobId, state, artifactSha256, computeStarted, history } = o;
  if (typeof operationId !== "string" || operationId === "") return undefined;
  if (externalJobId !== null && (typeof externalJobId !== "string" || externalJobId === "")) return undefined;
  if (typeof state !== "string" || !(SERVICE_JOB_STATES as readonly string[]).includes(state)) return undefined;
  if (artifactSha256 !== null && (typeof artifactSha256 !== "string" || !SHA256_HEX.test(artifactSha256))) return undefined;
  if (typeof computeStarted !== "boolean" || !Array.isArray(history)) return undefined;
  const jobState = state as ServiceJobState;
  // Only a completed job has an artifact, and a job that never started has no identity or history.
  if ((jobState === "COMPLETED") !== (artifactSha256 !== null)) return undefined;
  if (jobState === "NOT_STARTED" && (externalJobId !== null || history.length > 0 || computeStarted)) return undefined;
  if (jobState !== "NOT_STARTED" && externalJobId === null) return undefined;
  return { operationId, externalJobId, state: jobState, artifactSha256, computeStarted };
}

export function parseArtifactRecords(content: string): ArtifactStoreRecord[] | undefined {
  const value = parseJson(content);
  if (!Array.isArray(value)) return undefined;
  const records: ArtifactStoreRecord[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const { sha256, writer, size, storedAt, currentSha256 } = entry as Record<string, unknown>;
    if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) return undefined;
    if (typeof currentSha256 !== "string" || !SHA256_HEX.test(currentSha256)) return undefined;
    if (typeof writer !== "string" || writer === "" || typeof storedAt !== "string") return undefined;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
    records.push({ sha256, writer, size, storedAt, currentSha256 });
  }
  return records;
}

export function parseGatewayRecord(content: string): GatewayRecordFacts | undefined {
  const o = parseObject(content);
  if (o === undefined) return undefined;
  const { payment_request_id: paymentRequestId, status, tx_signature: txSignature } = o;
  if (typeof paymentRequestId !== "string" || paymentRequestId === "") return undefined;
  if (typeof status !== "string" || !status.startsWith("payment-")) return undefined;
  if (txSignature !== null && typeof txSignature !== "string") return undefined;
  return { paymentRequestId, status, txSignature };
}

function parseObject(content: string): Record<string, unknown> | undefined {
  const value = parseJson(content);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}
