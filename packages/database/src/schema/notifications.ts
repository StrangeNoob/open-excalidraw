import {
  boolean,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { drawings } from "./drawings.js";

/**
 * Per-user notification preferences. Deliberately not columns on the
 * auth-owned "user" table; an absent row means every kind is on, so a new
 * notification kind is a new column with a default, never a new table.
 */
export const userNotificationSettings = pgTable("user_notification_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  mentionEmails: boolean("mention_emails").notNull().default(true),
});

/**
 * Cooldown ledger for mention emails: at most one email per (recipient,
 * drawing) per window, claimed with a conditional upsert so concurrent
 * mentions cannot double-send. Rows older than the window are pruned by the
 * maintenance job.
 */
export const mentionEmailState = pgTable(
  "mention_email_state",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    drawingId: uuid("drawing_id")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "mention_email_state_pkey",
      columns: [table.userId, table.drawingId],
    }),
  ],
);

export type UserNotificationSettings =
  typeof userNotificationSettings.$inferSelect;
export type MentionEmailStateRow = typeof mentionEmailState.$inferSelect;
