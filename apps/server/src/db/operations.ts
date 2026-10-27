import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { validateOperationIntent, type Address, type Environment, type OperationIntent } from "@settleback/domain";
import { operationIntentSha256 } from "@settleback/domain/digest";
import { sha256Hex } from "@settleback/domain/hash";
import { immediateTransaction } from "./database.ts";
import { appendEvent } from "./events.ts";
import {
  IdempotencyConflictError,
  PolicyMismatchError,
  PolicyNotFoundError,
  PolicyVersionConflictError,
} from "./errors.ts";

const CREATE_OPERATION_ROUTE = "POST /operations";

export interface PolicyRecord {
  id: string;
  contentSha256: string;
  createdAt: string;
}

export interface OperationRecord extends OperationIntent {
  id: string;
  environment: Environment;
  intentSha256: string;
  createdAt: string;
}

export interface CreateOperationInput {
  actor: string;
  idempotencyKey: string;
  intent: unknown;
  environment: Environment;
  now: string;
  newId?: () => string;
}

/** Registers immutable policy text. Re-registering identical content is a no-op; changed content is refused. */
export function registerPolicy(
  db: DatabaseSync,
  input: { id: string; content: string; now: string },
): { policy: PolicyRecord; created: boolean } {
  const contentSha256 = sha256Hex(input.content);
  return immediateTransaction(db, () => {
    const existing = getPolicy(db, input.id);
    if (existing !== undefined) {
      if (existing.contentSha256 !== contentSha256) throw new PolicyVersionConflictError(input.id);
      return { policy: existing, created: false };
    }
    db.prepare("INSERT INTO policies (id, content, content_sha256, created_at) VALUES (?, ?, ?, ?)").run(
      input.id,
      input.content,
      contentSha256,
      input.now,
    );
    appendEvent(db, {
      entityType: "policy",
      entityId: input.id,
      eventType: "POLICY_REGISTERED",
      priorRevision: null,
      newRevision: null,
      actor: "system",
      payloadSha256: contentSha256,
      createdAt: input.now,
    });
    return { policy: { id: input.id, contentSha256, createdAt: input.now }, created: true };
  });
}

export function getPolicy(db: DatabaseSync, id: string): PolicyRecord | undefined {
  const row = db.prepare("SELECT id, content_sha256, created_at FROM policies WHERE id = ?").get(id);
  if (row === undefined) return undefined;
  return { id: String(row.id), contentSha256: String(row.content_sha256), createdAt: String(row.created_at) };
}

/**
 * Persists an immutable operation intent. The same actor and idempotency key with an identical
 * body returns the original operation; a different body is a conflict.
 */
export function createOperation(
  db: DatabaseSync,
  input: CreateOperationInput,
): { operation: OperationRecord; created: boolean } {
  const intent = validateOperationIntent(input.intent);
  const intentSha256 = operationIntentSha256(intent);

  return immediateTransaction(db, () => {
    const prior = db
      .prepare("SELECT request_sha256, result_ref FROM idempotency_records WHERE actor = ? AND route = ? AND key = ?")
      .get(input.actor, CREATE_OPERATION_ROUTE, input.idempotencyKey);
    if (prior !== undefined) {
      if (prior.request_sha256 !== intentSha256) throw new IdempotencyConflictError(CREATE_OPERATION_ROUTE);
      const operation = getOperation(db, String(prior.result_ref));
      if (operation === undefined) throw new Error(`Idempotency record points to missing operation ${prior.result_ref}`);
      return { operation, created: false };
    }

    const policy = getPolicy(db, intent.policyId);
    if (policy === undefined) throw new PolicyNotFoundError(intent.policyId);
    if (policy.contentSha256 !== intent.policySha256) throw new PolicyMismatchError(intent.policyId);

    const id = (input.newId ?? randomUUID)();
    db.prepare(
      `INSERT INTO operations (
         id, environment, buyer, seller, service_id, request_sha256, policy_id, policy_sha256,
         chain_id, token, token_decimals, price_usd, amount_base_units, intent_sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.environment,
      intent.buyer,
      intent.seller,
      intent.serviceId,
      intent.requestSha256,
      intent.policyId,
      intent.policySha256,
      intent.chainId,
      intent.token,
      intent.tokenDecimals,
      intent.priceUsd,
      intent.amountBaseUnits,
      intentSha256,
      input.now,
    );
    db.prepare(
      "INSERT INTO idempotency_records (actor, route, key, request_sha256, result_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(input.actor, CREATE_OPERATION_ROUTE, input.idempotencyKey, intentSha256, id, input.now);
    appendEvent(db, {
      entityType: "operation",
      entityId: id,
      eventType: "OPERATION_CREATED",
      priorRevision: null,
      newRevision: null,
      actor: input.actor,
      payloadSha256: intentSha256,
      createdAt: input.now,
    });

    return {
      operation: { ...intent, id, environment: input.environment, intentSha256, createdAt: input.now },
      created: true,
    };
  });
}

export function getOperation(db: DatabaseSync, id: string): OperationRecord | undefined {
  const row = db.prepare("SELECT * FROM operations WHERE id = ?").get(id);
  if (row === undefined) return undefined;
  return {
    id: String(row.id),
    environment: String(row.environment) as Environment,
    buyer: String(row.buyer) as Address,
    seller: String(row.seller) as Address,
    serviceId: String(row.service_id),
    requestSha256: String(row.request_sha256),
    policyId: String(row.policy_id),
    policySha256: String(row.policy_sha256),
    chainId: Number(row.chain_id),
    token: String(row.token) as Address,
    tokenDecimals: Number(row.token_decimals),
    priceUsd: String(row.price_usd),
    amountBaseUnits: String(row.amount_base_units),
    intentSha256: String(row.intent_sha256),
    createdAt: String(row.created_at),
  };
}
