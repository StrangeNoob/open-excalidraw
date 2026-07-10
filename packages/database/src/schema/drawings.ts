import { isNull, sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export type StoredScene = {
  type: "excalidraw";
  version: number;
  source: string;
  elements: unknown[];
  appState: Record<string, unknown>;
};

export const drawings = pgTable(
  "drawings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 120 }).notNull(),
    scene: jsonb("scene").$type<StoredScene>().notNull(),
    sceneFormatVersion: integer("scene_format_version").notNull(),
    contentRevision: bigint("content_revision", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    metadataRevision: bigint("metadata_revision", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    sceneBytes: integer("scene_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastCheckpointAt: timestamp("last_checkpoint_at", { withTimezone: true }),
  },
  (table) => [
    index("drawings_owner_user_id_idx").on(table.ownerUserId),
    index("drawings_active_updated_at_idx")
      .on(table.updatedAt)
      .where(sql`${table.deletedAt} is null`),
    index("drawings_deleted_at_idx").on(table.deletedAt),
    check(
      "drawings_scene_format_version_positive",
      sql`${table.sceneFormatVersion} > 0`,
    ),
    check(
      "drawings_content_revision_nonnegative",
      sql`${table.contentRevision} >= 0`,
    ),
    check(
      "drawings_metadata_revision_nonnegative",
      sql`${table.metadataRevision} >= 0`,
    ),
    check("drawings_scene_bytes_nonnegative", sql`${table.sceneBytes} >= 0`),
  ],
);

export const drawingRevisions = pgTable(
  "drawing_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    drawingId: uuid("drawing_id")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    contentRevision: bigint("content_revision", { mode: "bigint" }).notNull(),
    scene: jsonb("scene").$type<StoredScene>().notNull(),
    sceneFormatVersion: integer("scene_format_version").notNull(),
    sceneBytes: integer("scene_bytes").notNull(),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    reason: varchar("reason", { length: 16 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("drawing_revisions_drawing_revision_unique").on(
      table.drawingId,
      table.contentRevision,
    ),
    index("drawing_revisions_drawing_created_at_idx").on(
      table.drawingId,
      table.createdAt,
    ),
    check(
      "drawing_revisions_content_revision_nonnegative",
      sql`${table.contentRevision} >= 0`,
    ),
    check(
      "drawing_revisions_scene_format_version_positive",
      sql`${table.sceneFormatVersion} > 0`,
    ),
    check(
      "drawing_revisions_scene_bytes_nonnegative",
      sql`${table.sceneBytes} >= 0`,
    ),
    check(
      "drawing_revisions_reason_valid",
      sql`${table.reason} in ('checkpoint', 'restore')`,
    ),
  ],
);

export const drawingMutations = pgTable(
  "drawing_mutations",
  {
    drawingId: uuid("drawing_id")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    mutationId: uuid("mutation_id").notNull(),
    payloadHash: bytea("payload_hash").notNull(),
    baseRevision: bigint("base_revision", { mode: "bigint" }).notNull(),
    resultingRevision: bigint("resulting_revision", {
      mode: "bigint",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "drawing_mutations_pkey",
      columns: [table.drawingId, table.mutationId],
    }),
    index("drawing_mutations_created_at_idx").on(table.createdAt),
    check(
      "drawing_mutations_payload_hash_length",
      sql`octet_length(${table.payloadHash}) = 32`,
    ),
    check(
      "drawing_mutations_base_revision_nonnegative",
      sql`${table.baseRevision} >= 0`,
    ),
    check(
      "drawing_mutations_resulting_revision_valid",
      sql`${table.resultingRevision} > ${table.baseRevision}`,
    ),
  ],
);

/** Canonical predicate for all user-facing drawing reads. */
export function drawingIsActive() {
  return isNull(drawings.deletedAt);
}

export type Drawing = typeof drawings.$inferSelect;
export type NewDrawing = typeof drawings.$inferInsert;
