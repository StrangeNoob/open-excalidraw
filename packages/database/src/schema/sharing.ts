import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { citext, user } from "./auth.js";
import { drawings } from "./drawings.js";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const drawingMembers = pgTable(
  "drawing_members",
  {
    drawingId: uuid("drawing_id")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "drawing_members_pkey",
      columns: [table.drawingId, table.userId],
    }),
    index("drawing_members_user_id_idx").on(table.userId),
    check(
      "drawing_members_role_valid",
      sql`${table.role} in ('editor', 'viewer')`,
    ),
  ],
);

export const drawingInvitations = pgTable(
  "drawing_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    drawingId: uuid("drawing_id")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    inviteeEmail: citext("invitee_email").notNull(),
    role: varchar("role", { length: 16 }).notNull(),
    tokenHash: bytea("token_hash").notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    deliveryStatus: varchar("delivery_status", { length: 16 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("drawing_invitations_token_hash_unique").on(table.tokenHash),
    uniqueIndex("drawing_invitations_active_email_unique")
      .on(table.drawingId, table.inviteeEmail)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    index("drawing_invitations_drawing_id_idx").on(table.drawingId),
    index("drawing_invitations_expires_at_idx").on(table.expiresAt),
    check(
      "drawing_invitations_role_valid",
      sql`${table.role} in ('editor', 'viewer')`,
    ),
    check(
      "drawing_invitations_token_hash_length",
      sql`octet_length(${table.tokenHash}) = 32`,
    ),
    check(
      "drawing_invitations_delivery_status_valid",
      sql`${table.deliveryStatus} in ('sent', 'manual', 'failed')`,
    ),
    check(
      "drawing_invitations_acceptance_consistent",
      sql`${table.acceptedByUserId} is null or ${table.acceptedAt} is not null`,
    ),
    check(
      "drawing_invitations_not_accepted_and_revoked",
      sql`not (${table.acceptedAt} is not null and ${table.revokedAt} is not null)`,
    ),
  ],
);

export const drawingShareLinks = pgTable(
  "drawing_share_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    drawingId: uuid("drawing_id")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("drawing_share_links_token_unique").on(table.token),
    uniqueIndex("drawing_share_links_active_drawing_unique")
      .on(table.drawingId)
      .where(sql`${table.revokedAt} is null`),
    check(
      "drawing_share_links_token_format",
      sql`${table.token} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
  ],
);

export type DrawingMember = typeof drawingMembers.$inferSelect;
export type DrawingInvitation = typeof drawingInvitations.$inferSelect;
export type DrawingShareLink = typeof drawingShareLinks.$inferSelect;
