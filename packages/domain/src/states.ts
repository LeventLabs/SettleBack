// State names mirror the CHECK constraints in migrations/0001_core.sql; a server test keeps them in sync.

export const PAYMENT_ATTEMPT_STATES = [
  "CREATED",
  "PREPARED",
  "SIGNING_REQUESTED",
  "SUBMITTED",
  "OBSERVED",
  "VERIFIED",
  "UNKNOWN",
  "REJECTED_NO_SEND",
  "FAILED",
] as const;

export const SERVICE_JOB_STATES = ["NOT_STARTED", "INVOKED", "RUNNING", "COMPLETED", "FAILED", "UNKNOWN"] as const;

export const CASE_STATES = [
  "OPEN",
  "ASSESSING",
  "REVIEW_REQUIRED",
  "UNRESOLVED",
  "ACTION_PREPARED",
  "RESERVED",
  "EXECUTION_REQUESTED",
  "VERIFIED",
  "DELIVERY_ACKED",
  "RECORD_PENDING",
  "RECOVERED",
  "REPAID",
  "QUARANTINED",
] as const;

export const RECOVERY_ACTION_STATES = [
  "PREPARED",
  "RESERVED",
  "EXECUTION_REQUESTED",
  "VERIFIED",
  "DELIVERY_ACKED",
  "RECORD_PENDING",
  "COMPLETED",
  "STRANDED",
] as const;

export type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number];
export type ServiceJobState = (typeof SERVICE_JOB_STATES)[number];
export type CaseState = (typeof CASE_STATES)[number];
export type RecoveryActionState = (typeof RECOVERY_ACTION_STATES)[number];

/**
 * Who asks for a transition.
 * - server: application logic acting on already-validated input
 * - reconciler: server-side observation and verification of gateway and chain evidence
 * - service: the authenticated job service
 * - verifier: the registry verifier key
 * - assessor: the language model; it never appears on any transition
 */
export const ACTORS = ["server", "reconciler", "service", "verifier", "operator", "seller", "buyer", "assessor"] as const;
export type Actor = (typeof ACTORS)[number];
