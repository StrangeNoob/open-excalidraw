import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { drawings } from "./drawings.js";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const drawingAssets = pgTable(
  "drawing_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    drawingId: uuid("drawing_id")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: bytea("sha256").notNull(),
    fileVersion: integer("file_version"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastReferencedAt: timestamp("last_referenced_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("drawing_assets_storage_key_unique").on(table.storageKey),
    uniqueIndex("drawing_assets_drawing_file_unique").on(
      table.drawingId,
      table.fileId,
    ),
    index("drawing_assets_active_drawing_idx")
      .on(table.drawingId)
      .where(sql`${table.deletedAt} is null`),
    index("drawing_assets_unreferenced_cleanup_idx").on(
      table.lastReferencedAt,
      table.createdAt,
    ),
    check("drawing_assets_file_id_not_empty", sql`length(${table.fileId}) > 0`),
    check(
      "drawing_assets_mime_type_not_empty",
      sql`length(${table.mimeType}) > 0`,
    ),
    check("drawing_assets_byte_size_nonnegative", sql`${table.byteSize} >= 0`),
    check(
      "drawing_assets_sha256_length",
      sql`octet_length(${table.sha256}) = 32`,
    ),
    check(
      "drawing_assets_file_version_positive",
      sql`${table.fileVersion} is null or ${table.fileVersion} > 0`,
    ),
  ],
);

export type DrawingAsset = typeof drawingAssets.$inferSelect;
export type NewDrawingAsset = typeof drawingAssets.$inferInsert;
