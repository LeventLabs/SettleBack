import type { DatabaseSync } from "node:sqlite";
import type { AssessmentDecision, ValidatedAssessment } from "@settleback/domain";
import type { AssessmentOrigin } from "../recovery/provider.ts";

export interface AssessmentRequestRecord {
  id: string;
  caseId: string;
  evidenceRevision: number;
  evidenceSha256: string;
  attempt: number;
  promptVersion: string;
  promptSha256: string;
  provider: string;
  model: string;
  origin: AssessmentOrigin;
  requestedBy: string;
  requestedAt: string;
}

export interface AssessmentResultRecord {
  requestId: string;
  status: "SUCCEEDED" | "FAILED";
  failureCode: string | null;
  failureDetail: string | null;
  servedModel: string | null;
  stopReason: string | null;
  refusalCategory: string | null;
  responseText: string | null;
  responseSha256: string | null;
  assessment: ValidatedAssessment | null;
  /** The services' raw answers to the artifact lead lookup, if one ran. */
  lead: unknown;
  decision: AssessmentDecision;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  durationMs: number;
  completedAt: string;
}

export interface AssessmentRecord {
  request: AssessmentRequestRecord;
  /** Undefined while the request is in progress or after its process died. */
  result: AssessmentResultRecord | undefined;
}

/** Callers hold the transaction. */
export function insertAssessmentRequest(db: DatabaseSync, request: AssessmentRequestRecord): void {
  db.prepare(
    `INSERT INTO assessment_requests (id, case_id, evidence_revision, evidence_sha256, attempt, prompt_version, prompt_sha256,
       provider, model, origin, requested_by, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    request.id,
    request.caseId,
    request.evidenceRevision,
    request.evidenceSha256,
    request.attempt,
    request.promptVersion,
    request.promptSha256,
    request.provider,
    request.model,
    request.origin,
    request.requestedBy,
    request.requestedAt,
  );
}

/** Callers hold the transaction. */
export function insertAssessmentResult(db: DatabaseSync, result: AssessmentResultRecord): void {
  db.prepare(
    `INSERT INTO assessment_results (request_id, status, failure_code, failure_detail, served_model, stop_reason, refusal_category,
       response_text, response_sha256, assessment_json, lead_json, decision_json, input_tokens, output_tokens, thinking_tokens,
       duration_ms, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.requestId,
    result.status,
    result.failureCode,
    result.failureDetail,
    result.servedModel,
    result.stopReason,
    result.refusalCategory,
    result.responseText,
    result.responseSha256,
    result.assessment === null ? null : JSON.stringify(result.assessment),
    result.lead === undefined || result.lead === null ? null : JSON.stringify(result.lead),
    JSON.stringify(result.decision),
    result.inputTokens,
    result.outputTokens,
    result.thinkingTokens,
    result.durationMs,
    result.completedAt,
  );
}

/** Every attempt for the case, oldest first; limited to one evidence revision when given. */
export function listAssessments(db: DatabaseSync, caseId: string, evidenceRevision?: number): AssessmentRecord[] {
  const rows =
    evidenceRevision === undefined
      ? db
          .prepare(
            `SELECT r.*, s.request_id AS result_request_id, s.status, s.failure_code, s.failure_detail, s.served_model, s.stop_reason,
               s.refusal_category, s.response_text, s.response_sha256, s.assessment_json, s.lead_json, s.decision_json,
               s.input_tokens, s.output_tokens, s.thinking_tokens, s.duration_ms, s.completed_at
             FROM assessment_requests r LEFT JOIN assessment_results s ON s.request_id = r.id
             WHERE r.case_id = ? ORDER BY r.evidence_revision, r.attempt`,
          )
          .all(caseId)
      : db
          .prepare(
            `SELECT r.*, s.request_id AS result_request_id, s.status, s.failure_code, s.failure_detail, s.served_model, s.stop_reason,
               s.refusal_category, s.response_text, s.response_sha256, s.assessment_json, s.lead_json, s.decision_json,
               s.input_tokens, s.output_tokens, s.thinking_tokens, s.duration_ms, s.completed_at
             FROM assessment_requests r LEFT JOIN assessment_results s ON s.request_id = r.id
             WHERE r.case_id = ? AND r.evidence_revision = ? ORDER BY r.attempt`,
          )
          .all(caseId, evidenceRevision);
  return rows.map(toRecord);
}

function toRecord(row: Record<string, unknown>): AssessmentRecord {
  const request: AssessmentRequestRecord = {
    id: String(row.id),
    caseId: String(row.case_id),
    evidenceRevision: Number(row.evidence_revision),
    evidenceSha256: String(row.evidence_sha256),
    attempt: Number(row.attempt),
    promptVersion: String(row.prompt_version),
    promptSha256: String(row.prompt_sha256),
    provider: String(row.provider),
    model: String(row.model),
    origin: String(row.origin) as AssessmentOrigin,
    requestedBy: String(row.requested_by),
    requestedAt: String(row.requested_at),
  };
  if (row.result_request_id === null || row.result_request_id === undefined) return { request, result: undefined };
  return {
    request,
    result: {
      requestId: request.id,
      status: String(row.status) as AssessmentResultRecord["status"],
      failureCode: nullableString(row.failure_code),
      failureDetail: nullableString(row.failure_detail),
      servedModel: nullableString(row.served_model),
      stopReason: nullableString(row.stop_reason),
      refusalCategory: nullableString(row.refusal_category),
      responseText: nullableString(row.response_text),
      responseSha256: nullableString(row.response_sha256),
      assessment: row.assessment_json === null ? null : (JSON.parse(String(row.assessment_json)) as ValidatedAssessment),
      lead: row.lead_json === null ? null : (JSON.parse(String(row.lead_json)) as unknown),
      decision: JSON.parse(String(row.decision_json)) as AssessmentDecision,
      inputTokens: nullableNumber(row.input_tokens),
      outputTokens: nullableNumber(row.output_tokens),
      thinkingTokens: nullableNumber(row.thinking_tokens),
      durationMs: Number(row.duration_ms),
      completedAt: String(row.completed_at),
    },
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
