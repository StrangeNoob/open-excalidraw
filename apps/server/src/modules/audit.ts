import type { PoolClient } from "pg";

export interface AuditEventInput {
  actorUserId: string;
  drawingId: string;
  eventType: string;
  requestId: string;
  metadata?: Record<string, unknown>;
}

/** Insert into the caller's transaction so the event and mutation commit together. */
export async function insertAuditEvent(
  client: Pick<PoolClient, "query">,
  event: AuditEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (actor_user_id, drawing_id, event_type, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      event.actorUserId,
      event.drawingId,
      event.eventType,
      event.requestId,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}
