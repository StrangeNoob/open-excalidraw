import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Personal access tokens. Only the SHA-256 hash of the full secret is stored;
 * the plaintext is returned once at creation and never persisted or logged.
 */
export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: bytea("token_hash").notNull(),
    lastFour: text("last_four").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("personal_access_tokens_token_hash_unique").on(table.tokenHash),
    index("personal_access_tokens_user_id_idx").on(table.userId),
    check(
      "personal_access_tokens_name_length",
      sql`length(${table.name}) between 1 and 100`,
    ),
    check(
      "personal_access_tokens_token_hash_length",
      sql`octet_length(${table.tokenHash}) = 32`,
    ),
    check(
      "personal_access_tokens_last_four_length",
      sql`length(${table.lastFour}) = 4`,
    ),
  ],
);

export type PersonalAccessTokenRow = typeof personalAccessTokens.$inferSelect;
export type NewPersonalAccessToken = typeof personalAccessTokens.$inferInsert;
