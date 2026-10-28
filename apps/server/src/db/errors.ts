export class StoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export class EnvironmentMismatchError extends StoreError {
  constructor(expected: string, actual: string) {
    super("ENVIRONMENT_MISMATCH", `Database belongs to the "${actual}" environment, not "${expected}".`);
  }
}

export class MigrationError extends StoreError {
  constructor(message: string) {
    super("MIGRATION_FAILED", message);
  }
}

export class IdempotencyConflictError extends StoreError {
  constructor(route: string) {
    super("IDEMPOTENCY_CONFLICT", `Idempotency key was already used for a different ${route} request.`);
  }
}

export class PolicyNotFoundError extends StoreError {
  constructor(policyId: string) {
    super("POLICY_NOT_FOUND", `Policy "${policyId}" is not registered.`);
  }
}

export class PolicyMismatchError extends StoreError {
  constructor(policyId: string) {
    super("POLICY_MISMATCH", `Policy "${policyId}" does not match the stated content hash.`);
  }
}

export class PolicyVersionConflictError extends StoreError {
  constructor(policyId: string) {
    super("POLICY_VERSION_CONFLICT", `Policy "${policyId}" already exists with different content; publish a new version.`);
  }
}

export class ProofAlreadyAllocatedError extends StoreError {
  constructor(proofId: string) {
    super("PROOF_ALREADY_ALLOCATED", `Settlement proof ${proofId} is already bound.`);
  }
}

export class OperationNotFoundError extends StoreError {
  constructor(operationId: string) {
    super("OPERATION_NOT_FOUND", `Operation ${operationId} does not exist.`);
  }
}

export class CaseNotFoundError extends StoreError {
  constructor(caseId: string) {
    super("CASE_NOT_FOUND", `Case ${caseId} does not exist.`);
  }
}

export class CaseOpenForbiddenError extends StoreError {
  constructor(message: string) {
    super("ROLE_FORBIDDEN", message);
  }
}

export class EvidenceConflictError extends StoreError {
  constructor(source: string, sourceEventId: string) {
    super("EVIDENCE_CONFLICT", `${source} event ${sourceEventId} was already recorded with different content; the rejected digest is in the audit log.`);
  }
}

export class EvidenceLimitError extends StoreError {
  constructor(message: string) {
    super("EVIDENCE_LIMIT", message);
  }
}

export class EvidenceIntegrityError extends StoreError {
  constructor(message: string) {
    super("EVIDENCE_INTEGRITY", message);
  }
}

const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return errcode === SQLITE_CONSTRAINT_UNIQUE || errcode === SQLITE_CONSTRAINT_PRIMARYKEY;
}

export class AssessmentForbiddenError extends StoreError {
  constructor(message: string) {
    super("ROLE_FORBIDDEN", message);
  }
}

export class CaseNotAssessableError extends StoreError {
  constructor(caseId: string, status: string) {
    super("CASE_NOT_READY", `Case ${caseId} is ${status}; only an open case or one under assessment or review can be assessed.`);
  }
}

export class AssessmentInProgressError extends StoreError {
  constructor(caseId: string) {
    super("ASSESSMENT_IN_PROGRESS", `Case ${caseId} already has an assessment in progress for this evidence revision.`);
  }
}

export class ActionIntegrityError extends StoreError {
  constructor(message: string) {
    super("ACTION_INTEGRITY", message);
  }
}

export type RecoveryRefusal =
  | "ROLE_FORBIDDEN"
  | "REGISTRY_REQUIRED"
  | "CASE_NOT_READY"
  | "ACTION_EXISTS"
  | "NOT_ELIGIBLE"
  | "ORIGINAL_REFERENCE_MISSING"
  | "REVISION_CONFLICT"
  | "REGISTRY_TERMS_MISMATCH"
  | "ACTION_NOT_FOUND"
  | "WRONG_ACTION_STATE";

/** A recovery step refused before anything was changed, on chain or in the database. */
export class RecoveryRefusedError extends StoreError {
  constructor(code: RecoveryRefusal, message: string) {
    super(code, message);
  }
}
