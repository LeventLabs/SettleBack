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

const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return errcode === SQLITE_CONSTRAINT_UNIQUE || errcode === SQLITE_CONSTRAINT_PRIMARYKEY;
}
