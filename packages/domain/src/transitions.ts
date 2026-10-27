import {
  CASE_STATES,
  PAYMENT_ATTEMPT_STATES,
  RECOVERY_ACTION_STATES,
  SERVICE_JOB_STATES,
  type Actor,
  type CaseState,
  type PaymentAttemptState,
  type RecoveryActionState,
  type ServiceJobState,
} from "./states.ts";

export interface Edge {
  actors: readonly Actor[];
  /** The caller must cite recorded evidence (for example, an evidence item ID) for this transition. */
  requiresEvidence?: true;
}

export interface Machine<S extends string> {
  name: string;
  states: readonly S[];
  terminal: readonly S[];
  edges: { readonly [From in S]?: { readonly [To in S]?: Edge } };
}

export type TransitionResult = { allowed: true } | { allowed: false; code: TransitionRefusal; message: string };

export type TransitionRefusal = "UNKNOWN_STATE" | "TERMINAL_STATE" | "ILLEGAL_TRANSITION" | "ACTOR_NOT_ALLOWED" | "EVIDENCE_REQUIRED";

export interface TransitionRequest {
  actor: Actor;
  evidenceRef?: string;
}

export class IllegalTransitionError extends Error {
  readonly code: TransitionRefusal;

  constructor(code: TransitionRefusal, message: string) {
    super(message);
    this.name = "IllegalTransitionError";
    this.code = code;
  }
}

export function checkTransition<S extends string>(
  machine: Machine<S>,
  from: S,
  to: S,
  request: TransitionRequest,
): TransitionResult {
  if (!machine.states.includes(from) || !machine.states.includes(to)) {
    return refuse("UNKNOWN_STATE", `${machine.name}: unknown state ${from} or ${to}`);
  }
  if (machine.terminal.includes(from)) {
    return refuse("TERMINAL_STATE", `${machine.name}: ${from} is terminal`);
  }
  const edge = machine.edges[from]?.[to];
  if (edge === undefined) {
    return refuse("ILLEGAL_TRANSITION", `${machine.name}: ${from} -> ${to} is not allowed`);
  }
  if (!edge.actors.includes(request.actor)) {
    return refuse("ACTOR_NOT_ALLOWED", `${machine.name}: ${request.actor} cannot move ${from} -> ${to}`);
  }
  if (edge.requiresEvidence && (request.evidenceRef === undefined || request.evidenceRef.trim() === "")) {
    return refuse("EVIDENCE_REQUIRED", `${machine.name}: ${from} -> ${to} requires recorded evidence`);
  }
  return { allowed: true };
}

export function assertTransition<S extends string>(
  machine: Machine<S>,
  from: S,
  to: S,
  request: TransitionRequest,
): void {
  const result = checkTransition(machine, from, to, request);
  if (!result.allowed) throw new IllegalTransitionError(result.code, result.message);
}

function refuse(code: TransitionRefusal, message: string): TransitionResult {
  return { allowed: false, code, message };
}

const SERVER = ["server"] as const;
const RECONCILER = ["reconciler"] as const;
const SERVICE = ["service"] as const;
const OPERATOR_WITH_EVIDENCE: Edge = { actors: ["operator"], requiresEvidence: true };

/**
 * Payment attempts only ever move toward observation. After a possible transfer, a lost response
 * becomes UNKNOWN; UNKNOWN can only be reconciled to what the same attempt actually did, or closed
 * by an operator citing positive evidence. Nothing frees UNKNOWN for a fresh attempt automatically.
 */
export const PAYMENT_ATTEMPT_MACHINE: Machine<PaymentAttemptState> = {
  name: "payment attempt",
  states: PAYMENT_ATTEMPT_STATES,
  terminal: ["VERIFIED", "REJECTED_NO_SEND", "FAILED"],
  edges: {
    CREATED: {
      PREPARED: { actors: SERVER },
      REJECTED_NO_SEND: { actors: SERVER, requiresEvidence: true },
    },
    PREPARED: {
      SIGNING_REQUESTED: { actors: SERVER },
      REJECTED_NO_SEND: { actors: SERVER, requiresEvidence: true },
    },
    SIGNING_REQUESTED: {
      SUBMITTED: { actors: RECONCILER },
      UNKNOWN: { actors: RECONCILER },
      REJECTED_NO_SEND: { actors: RECONCILER, requiresEvidence: true },
    },
    SUBMITTED: {
      OBSERVED: { actors: RECONCILER },
      UNKNOWN: { actors: RECONCILER },
    },
    OBSERVED: {
      VERIFIED: { actors: RECONCILER, requiresEvidence: true },
      UNKNOWN: { actors: RECONCILER },
      FAILED: { actors: RECONCILER, requiresEvidence: true },
    },
    UNKNOWN: {
      SUBMITTED: { actors: RECONCILER },
      OBSERVED: { actors: RECONCILER },
      VERIFIED: { actors: RECONCILER, requiresEvidence: true },
      FAILED: OPERATOR_WITH_EVIDENCE,
    },
  },
};

/** Execution never restarts on its own: there is no edge back to NOT_STARTED or INVOKED. */
export const SERVICE_JOB_MACHINE: Machine<ServiceJobState> = {
  name: "service job",
  states: SERVICE_JOB_STATES,
  terminal: ["COMPLETED", "FAILED"],
  edges: {
    NOT_STARTED: { INVOKED: { actors: SERVER } },
    INVOKED: {
      RUNNING: { actors: SERVICE },
      FAILED: { actors: SERVICE, requiresEvidence: true },
      UNKNOWN: { actors: RECONCILER },
    },
    RUNNING: {
      COMPLETED: { actors: SERVICE, requiresEvidence: true },
      FAILED: { actors: SERVICE, requiresEvidence: true },
      UNKNOWN: { actors: RECONCILER },
    },
    UNKNOWN: {
      RUNNING: { actors: ["service", "operator"], requiresEvidence: true },
      COMPLETED: { actors: ["service", "operator"], requiresEvidence: true },
      FAILED: { actors: ["service", "operator"], requiresEvidence: true },
    },
  },
};

const REOPEN_ON_NEW_EVIDENCE: Edge = { actors: SERVER };

/**
 * Cases. New evidence before a reservation sends the case back to OPEN for reassessment. After a
 * reservation, evidence changes cannot rewrite the in-flight action; execution guards reject stale
 * reservations instead. QUARANTINED stops all automation.
 */
export const CASE_MACHINE: Machine<CaseState> = {
  name: "case",
  states: CASE_STATES,
  terminal: ["RECOVERED", "REPAID", "QUARANTINED"],
  edges: {
    OPEN: {
      ASSESSING: { actors: ["server", "seller", "operator"] },
      QUARANTINED: { actors: ["reconciler", "operator"], requiresEvidence: true },
    },
    ASSESSING: {
      ACTION_PREPARED: { actors: SERVER },
      REVIEW_REQUIRED: { actors: SERVER },
      OPEN: REOPEN_ON_NEW_EVIDENCE,
      QUARANTINED: { actors: ["reconciler", "operator"], requiresEvidence: true },
    },
    REVIEW_REQUIRED: {
      ACTION_PREPARED: { actors: ["seller", "operator"] },
      UNRESOLVED: { actors: ["operator"] },
      OPEN: REOPEN_ON_NEW_EVIDENCE,
      QUARANTINED: { actors: ["reconciler", "operator"], requiresEvidence: true },
    },
    UNRESOLVED: {
      OPEN: REOPEN_ON_NEW_EVIDENCE,
      QUARANTINED: { actors: ["reconciler", "operator"], requiresEvidence: true },
    },
    ACTION_PREPARED: {
      RESERVED: { actors: RECONCILER, requiresEvidence: true },
      OPEN: REOPEN_ON_NEW_EVIDENCE,
      QUARANTINED: { actors: ["reconciler", "operator"], requiresEvidence: true },
    },
    RESERVED: {
      EXECUTION_REQUESTED: { actors: SERVER },
      QUARANTINED: { actors: ["reconciler", "operator"], requiresEvidence: true },
    },
    EXECUTION_REQUESTED: {
      VERIFIED: { actors: RECONCILER, requiresEvidence: true },
      DELIVERY_ACKED: { actors: ["buyer"], requiresEvidence: true },
      QUARANTINED: { actors: ["reconciler", "operator"], requiresEvidence: true },
    },
    VERIFIED: {
      RECORD_PENDING: { actors: ["verifier"] },
      QUARANTINED: { actors: ["reconciler", "operator"], requiresEvidence: true },
    },
    DELIVERY_ACKED: {
      RECORD_PENDING: { actors: ["verifier"] },
      QUARANTINED: { actors: ["reconciler", "operator"], requiresEvidence: true },
    },
    RECORD_PENDING: {
      REPAID: { actors: RECONCILER, requiresEvidence: true },
      RECOVERED: { actors: RECONCILER, requiresEvidence: true },
      QUARANTINED: { actors: ["reconciler", "operator"], requiresEvidence: true },
    },
  },
};

const STRAND: Edge = { actors: ["operator"], requiresEvidence: true };

/** Repayment actions: settlement is verified by the reconciler, then the registry outcome is recorded. */
export const REPAY_ACTION_MACHINE: Machine<RecoveryActionState> = {
  name: "repay action",
  states: RECOVERY_ACTION_STATES,
  terminal: ["COMPLETED", "STRANDED"],
  edges: {
    PREPARED: { RESERVED: { actors: RECONCILER, requiresEvidence: true }, STRANDED: STRAND },
    RESERVED: { EXECUTION_REQUESTED: { actors: SERVER }, STRANDED: STRAND },
    EXECUTION_REQUESTED: { VERIFIED: { actors: RECONCILER, requiresEvidence: true } },
    VERIFIED: { RECORD_PENDING: { actors: ["verifier"] } },
    RECORD_PENDING: { COMPLETED: { actors: RECONCILER, requiresEvidence: true } },
  },
};

/** Retrieval actions: the buyer acknowledges the expected digest, then the registry outcome is recorded. */
export const RETRIEVE_ACTION_MACHINE: Machine<RecoveryActionState> = {
  name: "retrieve action",
  states: RECOVERY_ACTION_STATES,
  terminal: ["COMPLETED", "STRANDED"],
  edges: {
    PREPARED: { RESERVED: { actors: ["verifier"], requiresEvidence: true }, STRANDED: STRAND },
    RESERVED: { EXECUTION_REQUESTED: { actors: SERVER }, STRANDED: STRAND },
    EXECUTION_REQUESTED: { DELIVERY_ACKED: { actors: ["buyer"], requiresEvidence: true } },
    DELIVERY_ACKED: { RECORD_PENDING: { actors: ["verifier"] } },
    RECORD_PENDING: { COMPLETED: { actors: RECONCILER, requiresEvidence: true } },
  },
};
