import type { DatabaseSync } from "node:sqlite";

export interface EventInput {
  entityType: string;
  entityId: string;
  eventType: string;
  priorRevision: number | null;
  newRevision: number | null;
  actor: string;
  payloadSha256: string;
  createdAt: string;
}

/** Appends an audit event; callers run it in the same transaction as the change it records. */
export function appendEvent(db: DatabaseSync, event: EventInput): void {
  db.prepare(
    `INSERT INTO events (entity_type, entity_id, event_type, prior_revision, new_revision, actor, payload_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.entityType,
    event.entityId,
    event.eventType,
    event.priorRevision,
    event.newRevision,
    event.actor,
    event.payloadSha256,
    event.createdAt,
  );
}
