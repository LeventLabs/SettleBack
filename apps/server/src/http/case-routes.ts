import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { RegistryGateway } from "@settleback/adapters";
import type { PolicyTerms } from "@settleback/domain";
import type { Session } from "../auth/sessions.ts";
import { getDeliveryAck, getRecoveryActionForCase } from "../db/actions.ts";
import { listAssessments } from "../db/assessments.ts";
import { openCase, readCaseEvidence, readCaseForOperation } from "../db/cases.ts";
import { readTransaction } from "../db/database.ts";
import { RecoveryRefusedError, StoreError } from "../db/errors.ts";
import { getOperation, type OperationRecord } from "../db/operations.ts";
import { getOriginalPayment } from "../db/payments.ts";
import { confirmRepaymentReservation, prepareRecovery } from "../recovery/actions.ts";
import { assessCase } from "../recovery/assessment.ts";
import type { AssessmentProvider } from "../recovery/provider.ts";
import { acknowledgeDelivery, retrieveResult, type ResultLookup } from "../recovery/retrieval.ts";
import type { RequestGuard } from "./guard.ts";
import { actionView, assessmentView, caseView, operationView, type Relation } from "./views.ts";

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

  app.get("/api/cases/:id", { schema: { params: ID_PARAMS } }, async (request) => {
    const session = guard.session(request, { wallet: false });
    const { id } = request.params as { id: string };
    return readTransaction(db, () => {
      const { operation, relations } = scopeCase(db, session, id);
      const { case: caseRecord, items } = readCaseEvidence(db, id);
      return caseView(caseRecord, relations, items, getRecoveryActionForCase(db, id), getDeliveryAck(db, operation.id), listAssessments(db, id));
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

function requireLookup(lookup: ResultLookup | undefined): ResultLookup {
  if (lookup === undefined) throw new RecoveryRefusedError("DEPENDENCY_UNAVAILABLE", "The job service and artifact store are not connected.");
  return lookup;
}
