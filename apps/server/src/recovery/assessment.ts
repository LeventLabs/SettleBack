import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ASSESSMENT_PROMPT_VERSION,
  CASE_MACHINE,
  assertTransition,
  buildAssessmentPrompt,
  decideAssessment,
  parseServiceStatus,
  readArtifactLead,
  validateAssessment,
  type ArtifactLead,
  type AssessmentDecision,
  type AssessmentPrompt,
  type AssessmentRejection,
  type AssessmentSnapshot,
  type BaselineResult,
  type CaseState,
  type PolicyTerms,
  type ServiceStatusRecord,
  type ValidatedAssessment,
} from "@settleback/domain";
import { sha256Hex } from "@settleback/domain/hash";
import { insertAssessmentRequest, insertAssessmentResult, listAssessments, type AssessmentRecord, type AssessmentRequestRecord } from "../db/assessments.ts";
import { readCaseEvidence, type CaseRecord } from "../db/cases.ts";
import { immediateTransaction } from "../db/database.ts";
import { AssessmentForbiddenError, AssessmentInProgressError, CaseNotAssessableError } from "../db/errors.ts";
import { appendEvent } from "../db/events.ts";
import { readCaseBaseline, type CaseBaselineSnapshot } from "./baseline.ts";
import { ProviderError, type AssessmentProvider, type ProviderFailure, type ProviderReply } from "./provider.ts";

/**
 * Read-only access to the job service and artifact store for checking an artifact lead. Each call
 * returns the service's own JSON so it can be parsed with the same rules as case evidence and kept
 * for audit.
 */
export interface ServiceLookup {
  /** The job service's status record for the operation, or null when it has no job for it. */
  jobStatus(operationId: string, signal: AbortSignal): Promise<string | null>;
  /** The artifact store's records for the digest, as a JSON array (empty when it holds none). */
  artifactRecords(sha256: string, signal: AbortSignal): Promise<string>;
}

export interface AssessmentRequester {
  role: "seller" | "operator";
  /** The seller's wallet address, or the operator's identity. */
  identity: string;
}

export interface AssessCaseInput {
  caseId: string;
  requestedBy: AssessmentRequester;
  /** Undefined when no provider is configured: the attempt is recorded as failed, never skipped. */
  provider: AssessmentProvider | undefined;
  lookup: ServiceLookup;
  terms: ReadonlyMap<string, PolicyTerms>;
  timeoutMs: number;
  lookupTimeoutMs?: number;
  clock?: () => Date;
  newId?: () => string;
}

export type AssessCaseResult =
  | { kind: "RULES_RESOLVED"; case: CaseRecord; baseline: BaselineResult }
  | { kind: "ASSESSED"; reused: boolean; record: AssessmentRecord };

export type AssessmentFailure =
  | ProviderFailure
  | AssessmentRejection
  | "REFUSED"
  | "TRUNCATED"
  | "UNEXPECTED_STOP"
  | "MODEL_MISMATCH"
  | "SUPERSEDED"
  | "INTERNAL_ERROR";

const ASSESSABLE: readonly CaseState[] = ["OPEN", "ASSESSING", "REVIEW_REQUIRED"];
const DEFAULT_LOOKUP_TIMEOUT_MS = 10_000;
const MAX_STORED_RESPONSE_CHARS = 65_536;

interface Started {
  kind: "started";
  request: AssessmentRequestRecord;
  snapshot: AssessmentSnapshot;
  prompt: AssessmentPrompt;
  recordedStatuses: ServiceStatusRecord[];
}

/**
 * Requests one model assessment for the case's current evidence revision. When the rules already
 * resolve the case, no model is called. A revision with a successful assessment returns it rather
 * than asking again; a failed attempt can be retried explicitly. The result can at most make
 * RETRIEVE eligible after code verifies the artifact; it never changes payment state.
 */
export async function assessCase(db: DatabaseSync, input: AssessCaseInput): Promise<AssessCaseResult> {
  const clock = input.clock ?? (() => new Date());
  const newId = input.newId ?? randomUUID;
  const lookupTimeoutMs = input.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;

  const begun = immediateTransaction(db, () => {
    const snapshot = readCaseBaseline(db, input.caseId, input.terms);
    const requestedBy = authorizeRequester(input.requestedBy, snapshot.operation.seller);
    if (snapshot.result.outcome === "RESOLVES") {
      return { kind: "rules" as const, case: snapshot.case, baseline: snapshot.result };
    }
    const record = snapshot.case;
    if (!ASSESSABLE.includes(record.status)) throw new CaseNotAssessableError(record.id, record.status);

    const prior = listAssessments(db, record.id, record.evidence.revision);
    const succeeded = prior.find((attempt) => attempt.result?.status === "SUCCEEDED");
    if (succeeded !== undefined) return { kind: "existing" as const, record: succeeded };
    const now = clock();
    const abandonedBefore = now.getTime() - (2 * input.timeoutMs + lookupTimeoutMs);
    if (prior.some((attempt) => attempt.result === undefined && Date.parse(attempt.request.requestedAt) > abandonedBefore)) {
      throw new AssessmentInProgressError(record.id);
    }

    const assessmentSnapshot = toAssessmentSnapshot(snapshot);
    const prompt = buildAssessmentPrompt(assessmentSnapshot);
    const request: AssessmentRequestRecord = {
      id: newId(),
      caseId: record.id,
      evidenceRevision: record.evidence.revision,
      evidenceSha256: record.evidence.sha256,
      attempt: prior.length + 1,
      promptVersion: ASSESSMENT_PROMPT_VERSION,
      promptSha256: sha256Hex(`${prompt.system}\n\n${prompt.user}`),
      provider: input.provider?.name ?? "unconfigured",
      model: input.provider?.model ?? "unconfigured",
      origin: input.provider?.origin ?? "live",
      requestedBy,
      requestedAt: now.toISOString(),
    };
    insertAssessmentRequest(db, request);
    appendEvent(db, {
      entityType: "assessment",
      entityId: request.id,
      eventType: "ASSESSMENT_REQUESTED",
      priorRevision: null,
      newRevision: null,
      actor: requestedBy,
      payloadSha256: request.promptSha256,
      createdAt: request.requestedAt,
    });
    if (record.status === "OPEN") {
      moveCase(db, record, "ASSESSING", input.requestedBy.role, requestedBy, "CASE_ASSESSING", request.requestedAt, request.promptSha256);
    }
    const recordedStatuses = recordedServiceStatuses(assessmentSnapshot);
    return { kind: "started" as const, request, snapshot: assessmentSnapshot, prompt, recordedStatuses } satisfies Started;
  });

  if (begun.kind === "rules") return { kind: "RULES_RESOLVED", case: begun.case, baseline: begun.baseline };
  if (begun.kind === "existing") return { kind: "ASSESSED", reused: true, record: begun.record };

  const startedAt = clock().getTime();
  let outcome: Outcome;
  try {
    outcome = await run(begun, input, lookupTimeoutMs);
  } catch (error) {
    // Record the attempt as failed so it is visible and retryable, then surface the defect.
    const detail = error instanceof Error ? error.message : String(error);
    finish(db, begun, { reply: undefined, failure: { code: "INTERNAL_ERROR", detail }, assessment: undefined, lead: undefined }, input, clock, startedAt);
    throw error;
  }
  const record = finish(db, begun, outcome, input, clock, startedAt);
  return { kind: "ASSESSED", reused: false, record };
}

interface Outcome {
  reply: ProviderReply | undefined;
  failure: { code: AssessmentFailure; detail: string } | undefined;
  assessment: ValidatedAssessment | undefined;
  lead: { decision: ArtifactLead | undefined; failed: boolean; raw: unknown } | undefined;
}

async function run(started: Started, input: AssessCaseInput, lookupTimeoutMs: number): Promise<Outcome> {
  const provider = input.provider;
  if (provider === undefined) {
    return failed(undefined, "PROVIDER_NOT_CONFIGURED", "no assessment provider is configured; set ANTHROPIC_API_KEY");
  }
  let reply: ProviderReply;
  try {
    reply = await provider.assess(started.prompt, AbortSignal.timeout(input.timeoutMs));
  } catch (error) {
    if (error instanceof ProviderError) return failed(undefined, error.code, error.message);
    throw error;
  }

  const interpreted = interpretReply(reply, provider.model, started.snapshot);
  if (!interpreted.ok) return failed(reply, interpreted.code, interpreted.detail);
  const { assessment } = interpreted;

  const digest = assessment.artifactSha256;
  if (assessment.suggestedAction !== "RETRIEVE" || digest === null) return { reply, failure: undefined, assessment, lead: undefined };
  return { reply, failure: undefined, assessment, lead: await lookUpLead(input.lookup, started.snapshot.operationId, digest, lookupTimeoutMs) };
}

/** The assessment's view of a case read with readCaseBaseline. */
export function toAssessmentSnapshot(snapshot: CaseBaselineSnapshot): AssessmentSnapshot {
  return {
    caseId: snapshot.case.id,
    operationId: snapshot.case.operationId,
    evidenceRevision: snapshot.case.evidence.revision,
    evidenceSha256: snapshot.case.evidence.sha256,
    evidence: snapshot.items.map((item) => ({ id: item.id, source: item.source, provenance: item.provenance, content: item.content })),
    baseline: snapshot.result,
  };
}

/** Service statuses already recorded as authenticated case evidence. */
export function recordedServiceStatuses(snapshot: { evidence: readonly { source: string; provenance: string; content: string }[] }): ServiceStatusRecord[] {
  return snapshot.evidence
    .filter((item) => item.source === "service-status" && item.provenance === "AUTHENTICATED_SERVICE")
    .flatMap((item) => {
      const parsed = parseServiceStatus(item.content);
      return parsed === undefined ? [] : [parsed];
    });
}

/**
 * Accepts a reply only when the pinned model answered, finished normally, and returned text that
 * validates against the snapshot.
 */
export function interpretReply(
  reply: ProviderReply,
  model: string,
  snapshot: AssessmentSnapshot,
): { ok: true; assessment: ValidatedAssessment } | { ok: false; code: AssessmentFailure; detail: string } {
  if (reply.model !== model) return { ok: false, code: "MODEL_MISMATCH", detail: `requested ${model}, but ${reply.model} answered` };
  if (reply.stopReason === "refusal") return { ok: false, code: "REFUSED", detail: `the model declined (${reply.refusalCategory ?? "no category"})` };
  if (reply.stopReason === "max_tokens") return { ok: false, code: "TRUNCATED", detail: "the response hit the output token limit before it was complete" };
  if (reply.stopReason !== "end_turn") return { ok: false, code: "UNEXPECTED_STOP", detail: `the response stopped with ${reply.stopReason}` };
  if (reply.text === null) return { ok: false, code: "MALFORMED_OUTPUT", detail: "the response carried no text" };
  const validation = validateAssessment(reply.text, snapshot);
  return validation.ok ? { ok: true, assessment: validation.assessment } : { ok: false, code: validation.code, detail: validation.detail };
}

/** Asks the services about the digest. A malformed or failed answer is a failed lookup, not "no record". */
async function lookUpLead(lookup: ServiceLookup, operationId: string, digest: string, timeoutMs: number): Promise<NonNullable<Outcome["lead"]>> {
  let statusText: string | null;
  let artifactText: string;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    [statusText, artifactText] = await Promise.all([lookup.jobStatus(operationId, signal), lookup.artifactRecords(digest, signal)]);
  } catch (error) {
    return { decision: undefined, failed: true, raw: { digest, error: error instanceof Error ? error.message : String(error) } };
  }
  const raw = { digest, jobStatus: statusText, artifactRecords: artifactText };
  const decision = readArtifactLead(digest, statusText, artifactText);
  return { decision, failed: decision === undefined, raw };
}

function failed(reply: ProviderReply | undefined, code: AssessmentFailure, detail: string): Outcome {
  return { reply, failure: { code, detail }, assessment: undefined, lead: undefined };
}

function finish(db: DatabaseSync, started: Started, outcome: Outcome, input: AssessCaseInput, clock: () => Date, startedAt: number): AssessmentRecord {
  const completedAt = clock();
  return immediateTransaction(db, () => {
    const current = readCaseEvidence(db, started.request.caseId).case;
    const attempts = listAssessments(db, started.request.caseId, started.request.evidenceRevision);
    // A later attempt means this one was given up as abandoned; its answer must not act on the case.
    const superseded = attempts.some((attempt) => attempt.request.attempt > started.request.attempt);
    const failure = superseded ? { code: "SUPERSEDED" as const, detail: "a later attempt replaced this one" } : outcome.failure;
    const assessment = failure === undefined ? outcome.assessment : undefined;

    const decision: AssessmentDecision = decideAssessment({
      operationId: started.snapshot.operationId,
      baseline: started.snapshot.baseline,
      assessment,
      lead: assessment === undefined ? undefined : outcome.lead?.decision,
      leadLookupFailed: outcome.lead?.failed === true,
      recordedStatuses: started.recordedStatuses,
    });
    const responseText = outcome.reply?.text ?? null;
    const stored = responseText === null ? null : responseText.slice(0, MAX_STORED_RESPONSE_CHARS);
    insertAssessmentResult(db, {
      requestId: started.request.id,
      status: failure === undefined ? "SUCCEEDED" : "FAILED",
      failureCode: failure?.code ?? null,
      failureDetail: failure?.detail ?? null,
      servedModel: outcome.reply?.model ?? null,
      stopReason: outcome.reply?.stopReason ?? null,
      refusalCategory: outcome.reply?.refusalCategory ?? null,
      responseText: stored,
      responseSha256: responseText === null ? null : sha256Hex(responseText),
      assessment: assessment ?? null,
      lead: outcome.lead?.raw ?? null,
      decision,
      inputTokens: outcome.reply?.usage?.inputTokens ?? null,
      outputTokens: outcome.reply?.usage?.outputTokens ?? null,
      thinkingTokens: outcome.reply?.usage?.thinkingTokens ?? null,
      durationMs: Math.max(0, completedAt.getTime() - startedAt),
      completedAt: completedAt.toISOString(),
    });
    const decisionSha256 = sha256Hex(JSON.stringify(decision));
    appendEvent(db, {
      entityType: "assessment",
      entityId: started.request.id,
      eventType: failure === undefined ? "ASSESSMENT_COMPLETED" : "ASSESSMENT_FAILED",
      priorRevision: null,
      newRevision: null,
      actor: "server",
      payloadSha256: decisionSha256,
      createdAt: completedAt.toISOString(),
    });

    const fresh = current.evidence.sha256 === started.request.evidenceSha256;
    if (!superseded && fresh && decision.action === "ESCALATE" && current.status === "ASSESSING") {
      moveCase(db, current, "REVIEW_REQUIRED", "server", "server", "CASE_REVIEW_REQUIRED", completedAt.toISOString(), decisionSha256);
    }
    const record = listAssessments(db, started.request.caseId, started.request.evidenceRevision).find(
      (attempt) => attempt.request.id === started.request.id,
    );
    if (record?.result === undefined) throw new Error(`assessment ${started.request.id} was not stored`);
    return record;
  });
}

function moveCase(
  db: DatabaseSync,
  record: CaseRecord,
  to: CaseState,
  actor: "seller" | "operator" | "server",
  actorLabel: string,
  eventType: string,
  now: string,
  payloadSha256: string,
): void {
  assertTransition(CASE_MACHINE, record.status, to, { actor });
  const updated = db
    .prepare("UPDATE cases SET status = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?")
    .run(to, record.revision + 1, now, record.id, record.revision);
  if (updated.changes !== 1) throw new Error(`case ${record.id} changed during assessment`);
  appendEvent(db, {
    entityType: "case",
    entityId: record.id,
    eventType,
    priorRevision: record.revision,
    newRevision: record.revision + 1,
    actor: actorLabel,
    payloadSha256,
    createdAt: now,
  });
}

function authorizeRequester(requester: AssessmentRequester, seller: string): string {
  if (requester.role === "seller") {
    if (requester.identity.toLowerCase() !== seller) throw new AssessmentForbiddenError("Only the operation's seller can request its assessment.");
    return `seller:${seller}`;
  }
  if (requester.role === "operator") {
    if (requester.identity.trim() === "") throw new AssessmentForbiddenError("An operator identity is required.");
    return `operator:${requester.identity}`;
  }
  throw new AssessmentForbiddenError("Only the seller or an operator can request an assessment.");
}
