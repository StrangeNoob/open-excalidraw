import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Single-row instance settings. The boolean primary key pinned to true by a
 * CHECK constraint keeps the table to exactly one row, so reads and writes
 * never juggle multiple rows. bigint uses mode "number": quotas are far below
 * 2^53 bytes.
 */
export const appSettings = pgTable(
  "app_settings",
  {
    id: boolean("id").primaryKey().default(true),
    storageQuotaPerUserBytes: bigint("storage_quota_per_user_bytes", {
      mode: "number",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("app_settings_single_row", sql`${table.id}`),
    check(
      "app_settings_storage_quota_positive",
      sql`${table.storageQuotaPerUserBytes} IS NULL OR ${table.storageQuotaPerUserBytes} > 0`,
    ),
  ],
);

export type AppSettings = typeof appSettings.$inferSelect;
export type NewAppSettings = typeof appSettings.$inferInsert;
