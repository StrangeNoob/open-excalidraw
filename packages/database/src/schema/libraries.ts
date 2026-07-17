import { sql } from "drizzle-orm";
import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { user } from "./auth.js";

export const userLibraries = pgTable("user_libraries", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  items: jsonb("items")
    .$type<unknown[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type UserLibrary = typeof userLibraries.$inferSelect;
export type NewUserLibrary = typeof userLibraries.$inferInsert;
