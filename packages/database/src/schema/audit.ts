import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { drawings } from "./drawings";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    drawingId: uuid("drawing_id").references(() => drawings.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    requestId: text("request_id").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_events_drawing_created_at_idx").on(
      table.drawingId,
      table.createdAt,
    ),
    index("audit_events_actor_created_at_idx").on(
      table.actorUserId,
      table.createdAt,
    ),
    index("audit_events_type_created_at_idx").on(
      table.eventType,
      table.createdAt,
    ),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
