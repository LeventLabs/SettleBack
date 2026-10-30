import type { DatabaseSync } from "node:sqlite";
import {
  RailRejectedError,
  RailTimeoutError,
  RailUnavailableError,
  assertProvenanceAllowed,
  verifySettlement,
  type GatewayPaymentRecord,
  type ObservationKind,
  type PaymentRail,
  type RailObservation,
  type SettlementStatus,
  type SettlementVerdict,
} from "@settleback/adapters";
import type { PaymentAttemptState } from "@settleback/domain";
import { canonicalJson, sha256Hex, type CanonicalValue } from "@settleback/domain/hash";
import { immediateTransaction, readTransaction } from "../db/database.ts";
import { getOperation } from "../db/operations.ts";
import { getPaymentAttempt, moveAttempt, type PaymentAttemptRecord } from "../db/payments.ts";
import { ExecutionRefusedError } from "./execution.ts";
import { claimedAuthorization } from "./hsp-authorization.ts";

/** States after the permit was consumed and before a final answer: the ones observation may move. */
export const RECONCILABLE: readonly PaymentAttemptState[] = ["SIGNING_REQUESTED", "SUBMITTED", "OBSERVED", "UNKNOWN"];
const PROGRESSION: readonly PaymentAttemptState[] = ["SIGNING_REQUESTED", "SUBMITTED", "OBSERVED", "VERIFIED"];

/** What reconciliation needs from a payment rail: reading a payment, never making one. */
export type PaymentObserver = Pick<PaymentRail, "provenance" | "observe">;

export interface ReconcileAttemptInput {
  attemptId: string;
  rail: PaymentObserver;
  now: () => Date;
  /** The gateway level at which a matching on-chain transfer counts as verified. */
  requiredLevel: "SAFE" | "FINAL";
  pinnedUsdRate?: string;
}

export interface Reconciliation {
  attempt: PaymentAttemptRecord;
  /** The states the attempt moved through, in order; empty when nothing changed. */
  moved: PaymentAttemptState[];
  observed: ObservationKind | null;
  verdict: SettlementStatus | null;
  reason: string | null;
}

/**
 * Observes one attempt and moves it only forward, as far as the gateway record and the chain
 * together support. It never signs, submits, or opens anything: a lost or ambiguous payment is
 * asked about again later, never sent again. VERIFIED needs the gateway at the required level and
 * a matching on-chain transfer. A contradiction (mismatched transfer, failure after inclusion, a
 * changed gateway identity, a payment that disappears) makes the attempt UNKNOWN, which only
 * further evidence or an operator resolves. An unreachable gateway changes nothing.
 */
export async function reconcileAttempt(db: DatabaseSync, input: ReconcileAttemptInput): Promise<Reconciliation> {
  const { attempt, tokenDecimals, environment } = readTransaction(db, () => {
    const attempt = getPaymentAttempt(db, input.attemptId);
    if (attempt === undefined) throw new ExecutionRefusedError("ATTEMPT_NOT_FOUND", `Payment attempt ${input.attemptId} does not exist.`);
    const operation = getOperation(db, attempt.operationId);
    if (operation === undefined) throw new Error(`payment attempt ${attempt.id} has no operation`);
    return { attempt, tokenDecimals: operation.tokenDecimals, environment: operation.environment };
  });
  const unchanged = (current: PaymentAttemptRecord, reason: string, observed: ObservationKind | null = null, verdict: SettlementStatus | null = null): Reconciliation => ({
    attempt: current,
    moved: [],
    observed,
    verdict,
    reason,
  });
  if (!RECONCILABLE.includes(attempt.state)) return unchanged(attempt, `the attempt is ${attempt.state}`);
  if (attempt.paymentRequestId === null) return unchanged(attempt, "the attempt has no gateway order");

  let observation: RailObservation;
  try {
    observation = await input.rail.observe(attempt.paymentRequestId);
  } catch (error) {
    if (error instanceof RailRejectedError) return unchanged(attempt, `the gateway has no payment record for this order (${error.code})`);
    if (error instanceof RailUnavailableError || error instanceof RailTimeoutError) return unchanged(attempt, "the gateway could not be reached; observe again later");
    throw error;
  }
  assertProvenanceAllowed(environment, observation.provenance);
  const record = observation.record;
  if (record.payment_request_id !== attempt.paymentRequestId || record.cart_mandate_id !== attempt.cartMandateId) {
    return unchanged(attempt, "the gateway answered with a record for a different order", observation.kind);
  }
  // An authorization a gateway prepared names the exact amount and nonce the transfer must carry.
  const authorized = readTransaction(db, () => claimedAuthorization(db, attempt.id));
  const verdict = verifySettlement({
    expected: { payer: attempt.payer, payee: attempt.payee, chainId: attempt.chainId, token: attempt.token, amountBaseUnits: attempt.amountBaseUnits },
    tokenDecimals,
    record,
    transfer: observation.transfer,
    requiredLevel: input.requiredLevel,
    ...(input.pinnedUsdRate === undefined ? {} : { pinnedUsdRate: input.pinnedUsdRate }),
    ...(authorized === undefined ? {} : authorized),
  });

  return immediateTransaction(db, () => {
    const current = getPaymentAttempt(db, attempt.id);
    if (current === undefined) throw new Error(`payment attempt ${attempt.id} disappeared`);
    if (current.revision !== attempt.revision) return unchanged(current, "the attempt changed while it was being observed; observe again", observation.kind, verdict.status);

    const conflict = identityConflict(current, record, verdict);
    const target = conflict === undefined ? targetFor(current.state, observation.kind, verdict) : { state: "UNKNOWN" as const, reason: conflict };
    const path = target.state === null ? [] : pathTo(current.state, target.state);
    if (path.length === 0) return unchanged(current, target.reason, observation.kind, verdict.status);

    const now = input.now().toISOString();
    const recordSha256 = sha256Hex(canonicalJson(record as unknown as CanonicalValue));
    const refs = conflict === undefined ? newReferences(current, record) : {};
    let moved = current;
    for (const [index, to] of path.entries()) {
      const verified = to === "VERIFIED" && verdict.txHash !== null;
      moved = moveAttempt(db, moved, {
        to,
        actor: "reconciler",
        actorLabel: "reconciler",
        eventType: `PAYMENT_${to}`,
        payloadSha256: recordSha256,
        now,
        ...(verified ? { evidenceRef: `gateway:${record.flow_id}:${record.status};chain:${verdict.txHash}` } : {}),
        set: { ...(index === 0 ? refs : {}), ...(verified && verdict.txHash !== null ? { txHash: verdict.txHash.toLowerCase() } : {}) },
      });
    }
    return { attempt: moved, moved: path, observed: observation.kind, verdict: verdict.status, reason: target.reason };
  });
}

/** Where the observation puts the attempt, or null to leave it where it is. */
function targetFor(current: PaymentAttemptState, kind: ObservationKind, verdict: SettlementVerdict): { state: PaymentAttemptState | null; reason: string } {
  switch (kind) {
    case "AWAITING_PAYER":
      return current === "SUBMITTED" || current === "OBSERVED"
        ? { state: "UNKNOWN", reason: "the gateway no longer shows the submitted payment" }
        : { state: null, reason: "the gateway has not received the payment" };
    case "SUBMITTED":
      return { state: "SUBMITTED", reason: "the gateway accepted the payment" };
    case "INCLUDED":
      return { state: "OBSERVED", reason: "the transfer is included on chain but not yet at the required level" };
    case "SAFE":
    case "FINAL":
      if (verdict.status === "VERIFIED") return { state: "VERIFIED", reason: "the gateway record and the on-chain transfer match the attempt" };
      if (verdict.status === "PENDING") return { state: "OBSERVED", reason: verdict.reasons.join("; ") };
      return { state: "UNKNOWN", reason: `${verdict.status}: ${verdict.reasons.join("; ")}` };
    case "FAILED_NO_TRANSACTION":
    case "FAILED_AFTER_INCLUSION":
      return { state: "UNKNOWN", reason: `${verdict.status}: ${verdict.reasons.join("; ")}; an operator closes the attempt with this evidence` };
  }
}

/** The forward steps from one state to another along the payment state machine. */
function pathTo(from: PaymentAttemptState, to: PaymentAttemptState): PaymentAttemptState[] {
  if (to === "UNKNOWN") return from === "UNKNOWN" ? [] : [to];
  if (from === "UNKNOWN") return [to];
  const fromRank = PROGRESSION.indexOf(from);
  const toRank = PROGRESSION.indexOf(to);
  if (fromRank === -1 || toRank === -1 || toRank <= fromRank) return [];
  return PROGRESSION.slice(fromRank + 1, toRank + 1);
}

/** A gateway that changes an order's flow, request, or transaction after recording it is not believed. */
function identityConflict(current: PaymentAttemptRecord, record: GatewayPaymentRecord, verdict: SettlementVerdict): string | undefined {
  if (current.flowId !== null && current.flowId !== record.flow_id) return "the gateway reports a different flow for this order";
  if (current.requestId !== null && record.request_id !== null && current.requestId !== record.request_id) return "the gateway reports a different request for this order";
  if (current.txHash !== null && verdict.txHash !== null && current.txHash !== verdict.txHash.toLowerCase()) return "the gateway reports a different transaction for this order";
  return undefined;
}

function newReferences(current: PaymentAttemptRecord, record: GatewayPaymentRecord): { flowId?: string; requestId?: string } {
  return {
    ...(current.flowId === null ? { flowId: record.flow_id } : {}),
    ...(current.requestId === null && record.request_id !== null ? { requestId: record.request_id } : {}),
  };
}
