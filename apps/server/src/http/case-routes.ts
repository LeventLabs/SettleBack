import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { walletTypedData, type RegistryGateway, type WalletCall } from "@settleback/adapters";
import type { PolicyTerms } from "@settleback/domain";
import type { Session } from "../auth/sessions.ts";
import { getDeliveryAck, getRecoveryActionForCase, type RecoveryActionRecord } from "../db/actions.ts";
import { listAssessments } from "../db/assessments.ts";
import { openCase, readCaseEvidence, readCaseForOperation } from "../db/cases.ts";
import { readTransaction } from "../db/database.ts";
import { RecoveryRefusedError, StoreError } from "../db/errors.ts";
import { getOperation, type OperationRecord } from "../db/operations.ts";
import { getOriginalPayment } from "../db/payments.ts";
import { confirmRepaymentReservation, prepareRecovery } from "../recovery/actions.ts";
import { assessCase } from "../recovery/assessment.ts";
import { readCaseBaseline } from "../recovery/baseline.ts";
import type { AssessmentProvider } from "../recovery/provider.ts";
import { liveAttempt, requestRepaymentSignature, submitRepaymentSignature, type RepaymentPayments } from "../recovery/repayment.ts";
import { acknowledgeDelivery, retrieveResult, type ResultLookup } from "../recovery/retrieval.ts";
import type { RequestGuard } from "./guard.ts";
import { actionView, assessmentView, attemptView, caseSummaryView, caseView, operationView, type Relation } from "./views.ts";

export interface CaseRouteDependencies {
  db: DatabaseSync;
  guard: RequestGuard;
  clock: () => Date;
  registry: RegistryGateway | undefined;
  /** Service terms by policy ID. A case whose policy has none cannot be assessed or prepared. */
  terms: ReadonlyMap<string, PolicyTerms>;
  /** The job service and artifact store. Without them nothing is assessed against them or delivered. */
  lookup: ResultLookup | undefined;
  /** Without one, an assessment request is recorded as failed, never skipped. */
  provider: AssessmentProvider | undefined;
  assessmentTimeoutMs: number;
  /** The rail and signer repayments are paid with; absent when payment writes are disabled. */
  payments: RepaymentPayments | undefined;
}

const ID_PARAMS = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

/**
 * Operation, case, recovery, and delivery routes. Every route resolves the signed-in account's
 * relation to the operation on the server; an account with no relation gets the same NOT_FOUND as
 * an unknown ID, and a related account without the needed role gets ROLE_FORBIDDEN. Each route then
 * calls the same server function the tests exercise, which checks the identity again.
 */
export function registerCaseRoutes(app: FastifyInstance, deps: CaseRouteDependencies): void {
  const { db, guard } = deps;
  const now = (): Date => deps.clock();

  app.get("/api/operations/:id", { schema: { params: ID_PARAMS } }, async (request) => {
    const session = guard.session(request, { wallet: false });
    const { id } = request.params as { id: string };
    return readTransaction(db, () => {
      const { operation, relations } = scopeOperation(db, session, id);
      return operationView(operation, relations, getOriginalPayment(db, operation.id), readCaseForOperation(db, operation.id));
    });
  });

  app.post("/api/operations/:id/case", { schema: { params: ID_PARAMS } }, async (request) => {
    const session = guard.session(request, { wallet: true });
    const { id } = request.params as { id: string };
    const { operation, relations } = readTransaction(db, () => scopeOperation(db, session, id));
    const role = requireRelation(relations, ["buyer", "operator"], "Only the operation's buyer or an operator can open its case.");
    const opened = openCase(db, { operationId: operation.id, openedBy: { role: role === "buyer" ? "buyer" : "operator", identity: session.address }, now: now().toISOString() });
    return { created: opened.created, case: { id: opened.case.id, status: opened.case.status } };
  });

  // The cases the signed-in account may see: its own as buyer or seller, or every case for an operator.
  app.get("/api/cases", async (request) => {
    const session = guard.session(request, { wallet: false });
    const operator = session.roles.includes("operator");
    return readTransaction(db, () => {
      const rows = db
        .prepare(
          `SELECT c.id, c.operation_id, c.status, c.updated_at, o.buyer, o.seller, o.service_id, o.price_usd, o.policy_id, a.action, a.state AS action_state
           FROM cases c JOIN operations o ON o.id = c.operation_id LEFT JOIN recovery_actions a ON a.case_id = c.id
           WHERE ? OR o.buyer = ? OR o.seller = ?
           ORDER BY c.created_at DESC, c.id LIMIT 200`,
        )
        .all(operator ? 1 : 0, session.address, session.address);
      return {
        cases: rows.map((row) => {
          const relations: Relation[] = [];
          if (row.buyer === session.address) relations.push("buyer");
          if (row.seller === session.address) relations.push("seller");
          if (operator) relations.push("operator");
          const caseId = String(row.id);
          const rules = deps.terms.has(String(row.policy_id)) ? readCaseBaseline(db, caseId, deps.terms).result : undefined;
          return caseSummaryView({
            rules,
            id: caseId,
            operationId: String(row.operation_id),
            status: String(row.status),
            relations,
            serviceId: String(row.service_id),
            priceUsd: String(row.price_usd),
            action: row.action === null ? null : String(row.action),
            actionState: row.action_state === null ? null : String(row.action_state),
            updatedAt: String(row.updated_at),
          });
        }),
      };
    });
  });

  app.get("/api/cases/:id", { schema: { params: ID_PARAMS } }, async (request) => {
    const session = guard.session(request, { wallet: false });
    const { id } = request.params as { id: string };
    return readTransaction(db, () => {
      const { operation, relations } = scopeCase(db, session, id);
      const action = getRecoveryActionForCase(db, id);
      const rules = deps.terms.has(operation.policyId) ? readCaseBaseline(db, id, deps.terms) : undefined;
      const { case: caseRecord, items } = rules ?? readCaseEvidence(db, id);
      return caseView({
        caseRecord,
        relations,
        operation,
        payment: getOriginalPayment(db, operation.id),
        items,
        rules: rules?.result,
        action,
        ack: getDeliveryAck(db, operation.id),
        assessments: listAssessments(db, id),
        repayment: action?.action === "REPAY" ? liveAttempt(db, action) : undefined,
        sellerCall: awaitingSeller(action, relations, deps.registry),
      });
    });
  });

  app.post("/api/cases/:id/assess", { schema: { params: ID_PARAMS } }, async (request) => {
    const session = guard.session(request, { wallet: true });
    const { id } = request.params as { id: string };
    const { operation, relations } = readTransaction(db, () => scopeCase(db, session, id));
    const role = requireRelation(relations, ["seller", "operator"], "Only the operation's seller or an operator can request an assessment.");
    requireTerms(deps.terms, operation);
    const result = await assessCase(db, {
      caseId: id,
      requestedBy: { role: role === "seller" ? "seller" : "operator", identity: session.address },
      provider: deps.provider,
      lookup: requireLookup(deps.lookup),
      terms: deps.terms,
      timeoutMs: deps.assessmentTimeoutMs,
      clock: now,
    });
    return result.kind === "RULES_RESOLVED"
      ? { kind: result.kind, case: { id: result.case.id, status: result.case.status }, baseline: result.baseline }
      : { kind: result.kind, reused: result.reused, assessment: assessmentView(result.record) };
  });

  app.post("/api/cases/:id/recovery/prepare", { schema: { params: ID_PARAMS } }, async (request) => {
    const session = guard.session(request, { wallet: true });
    const { id } = request.params as { id: string };
    const { operation, relations } = readTransaction(db, () => scopeCase(db, session, id));
    const role = requireRelation(relations, ["seller", "operator"], "Only the operation's seller or an operator can prepare a recovery.");
    requireTerms(deps.terms, operation);
    const prepared = await prepareRecovery(db, {
      caseId: id,
      requestedBy: { role: role === "seller" ? "seller" : "operator", identity: session.address },
      registry: deps.registry,
      terms: deps.terms,
      now,
    });
    return { action: actionView(prepared.action), sellerCall: prepared.sellerCall, delegateCall: prepared.delegateCall, policyGaps: prepared.policyGaps };
  });

  app.post(
    "/api/cases/:id/recovery/approval-tx",
    {
      schema: {
        params: ID_PARAMS,
        body: { type: "object", additionalProperties: false, required: ["txHash"], properties: { txHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } } },
      },
    },
    async (request) => {
      const session = guard.session(request, { wallet: true });
      const { id } = request.params as { id: string };
      const { txHash } = request.body as { txHash: string };
      const { relations } = readTransaction(db, () => scopeCase(db, session, id));
      requireRelation(relations, ["seller"], "Only the operation's seller reports its reservation.");
      const action = readTransaction(db, () => getRecoveryActionForCase(db, id));
      if (action === undefined) throw new RecoveryRefusedError("ACTION_NOT_FOUND", `Case ${id} has no recovery action.`);
      const outcome = await confirmRepaymentReservation(db, { actionId: action.id, txHash, registry: deps.registry, now });
      return outcome.status === "CONFIRMED"
        ? { status: outcome.status, executable: outcome.executable, reasons: outcome.reasons, action: actionView(outcome.action) }
        : outcome;
    },
  );

  // The seller's wallet pays the repayment in two steps: this returns the mandate to sign, once the
  // permit is consumed; a repeated request offers the same mandate or reports the repayment under way.
  app.post("/api/cases/:id/recovery/repay", { schema: { params: ID_PARAMS } }, async (request) => {
    const session = guard.session(request, { wallet: true });
    const { id } = request.params as { id: string };
    const { relations } = readTransaction(db, () => scopeCase(db, session, id));
    requireRelation(relations, ["seller"], "Only the operation's seller pays its repayment.");
    const payments = requirePayments(deps.payments);
    const outcome = await requestRepaymentSignature(db, { caseId: id, requestedBy: session.address, registry: deps.registry, payments, now });
    return {
      status: outcome.status,
      ...(outcome.status === "SIGNATURE_REQUIRED" ? { typedData: walletTypedData(outcome.payload), mandate: outcome.payload.mandate } : {}),
      action: actionView(outcome.action),
      payment: outcome.attempt === undefined ? null : attemptView(outcome.attempt),
    };
  });

  app.post(
    "/api/cases/:id/recovery/repay/signature",
    {
      schema: {
        params: ID_PARAMS,
        body: { type: "object", additionalProperties: false, required: ["signature"], properties: { signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$" } } },
      },
    },
    async (request) => {
      const session = guard.session(request, { wallet: true });
      const { id } = request.params as { id: string };
      const { signature } = request.body as { signature: string };
      const { relations } = readTransaction(db, () => scopeCase(db, session, id));
      requireRelation(relations, ["seller"], "Only the operation's seller pays its repayment.");
      const outcome = await submitRepaymentSignature(db, { caseId: id, requestedBy: session.address, signature, registry: deps.registry, payments: requirePayments(deps.payments), now });
      return {
        status: outcome.status,
        ...(outcome.status === "OUTCOME_UNKNOWN" ? { reason: outcome.reason } : {}),
        action: actionView(outcome.action),
        payment: outcome.attempt === undefined ? null : attemptView(outcome.attempt),
      };
    },
  );

  // A GET because the buyer reads the result, but it releases a reserved retrieval, so it needs the
  // wallet header like a write; a cross-site page cannot send that header without a preflight.
  app.get("/api/operations/:id/result", { schema: { params: ID_PARAMS } }, async (request, reply) => {
    const session = guard.session(request, { wallet: true });
    const { id } = request.params as { id: string };
    const { operation, relations } = readTransaction(db, () => scopeOperation(db, session, id));
    requireRelation(relations, ["buyer"], "Only the operation's buyer can retrieve its result.");
    const result = await retrieveResult(db, { operationId: operation.id, buyer: session.address, registry: deps.registry, lookup: requireLookup(deps.lookup), now });
    // The bytes come from the seller's service; they are served as an opaque download, never rendered here.
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-disposition", "attachment")
      .header("x-settleback-artifact-sha256", result.artifactSha256)
      .header("x-settleback-action-state", result.action.state)
      .send(Buffer.from(result.content));
  });

  app.post(
    "/api/operations/:id/result/ack",
    {
      schema: {
        params: ID_PARAMS,
        body: { type: "object", additionalProperties: false, required: ["artifactSha256"], properties: { artifactSha256: { type: "string", pattern: "^[0-9a-fA-F]{64}$" } } },
      },
    },
    async (request) => {
      const session = guard.session(request, { wallet: true });
      const { id } = request.params as { id: string };
      const { artifactSha256 } = request.body as { artifactSha256: string };
      const { operation, relations } = readTransaction(db, () => scopeOperation(db, session, id));
      requireRelation(relations, ["buyer"], "Only the operation's buyer can acknowledge its result.");
      const acknowledged = await acknowledgeDelivery(db, { operationId: operation.id, buyer: session.address, artifactSha256, registry: deps.registry, now });
      const { outcome } = acknowledged;
      return {
        acknowledgementSha256: acknowledged.acknowledgementSha256,
        acknowledgedAt: acknowledged.acknowledgedAt,
        outcome: { status: outcome.status, ...(outcome.status === "PENDING" ? { reason: outcome.reason } : {}), action: actionView(outcome.action) },
      };
    },
  );
}

/** The seller's reservation call for a per-case repayment that still waits for it, on the registry the proposal names. */
function awaitingSeller(action: RecoveryActionRecord | undefined, relations: readonly Relation[], registry: RegistryGateway | undefined): WalletCall | null {
  if (action === undefined || action.action !== "REPAY" || action.state !== "PREPARED" || action.authorizationMode !== "PER_CASE") return null;
  if (!relations.includes("seller") || registry === undefined) return null;
  const named = action.proposal.registry;
  if (named.chainId !== registry.chainId || named.address.toLowerCase() !== registry.address.toLowerCase()) return null;
  return registry.reserveRepaymentCall(action.proposal.caseKey);
}

function relationsTo(session: Session, operation: OperationRecord): Relation[] {
  const relations: Relation[] = [];
  if (session.address === operation.buyer) relations.push("buyer");
  if (session.address === operation.seller) relations.push("seller");
  if (session.roles.includes("operator")) relations.push("operator");
  return relations;
}

/** Callers hold the transaction. An unknown ID and an unrelated account are refused alike, so IDs reveal nothing. */
function scopeOperation(db: DatabaseSync, session: Session, operationId: string): { operation: OperationRecord; relations: Relation[] } {
  const operation = getOperation(db, operationId);
  const relations = operation === undefined ? [] : relationsTo(session, operation);
  if (operation === undefined || relations.length === 0) throw new StoreError("NOT_FOUND", "No such operation for this account.");
  return { operation, relations };
}

/** Callers hold the transaction. */
function scopeCase(db: DatabaseSync, session: Session, caseId: string): { operation: OperationRecord; relations: Relation[] } {
  const row = db.prepare("SELECT operation_id FROM cases WHERE id = ?").get(caseId);
  const operation = row === undefined ? undefined : getOperation(db, String(row.operation_id));
  const relations = operation === undefined ? [] : relationsTo(session, operation);
  if (operation === undefined || relations.length === 0) throw new StoreError("NOT_FOUND", "No such case for this account.");
  return { operation, relations };
}

/** The first allowed relation the account holds, in the route's order of preference. */
function requireRelation(relations: readonly Relation[], allowed: readonly Relation[], message: string): Relation {
  const found = allowed.find((relation) => relations.includes(relation));
  if (found === undefined) throw new StoreError("ROLE_FORBIDDEN", message);
  return found;
}

function requireTerms(terms: ReadonlyMap<string, PolicyTerms>, operation: OperationRecord): void {
  if (!terms.has(operation.policyId)) throw new RecoveryRefusedError("DEPENDENCY_UNAVAILABLE", `No service terms are loaded for policy ${operation.policyId}.`);
}

function requirePayments(payments: RepaymentPayments | undefined): RepaymentPayments {
  if (payments === undefined) throw new RecoveryRefusedError("DEPENDENCY_UNAVAILABLE", "Payment writes are disabled or no payment rail is connected; repayments cannot be paid.");
  return payments;
}

function requireLookup(lookup: ResultLookup | undefined): ResultLookup {
  if (lookup === undefined) throw new RecoveryRefusedError("DEPENDENCY_UNAVAILABLE", "The job service and artifact store are not connected.");
  return lookup;
}
