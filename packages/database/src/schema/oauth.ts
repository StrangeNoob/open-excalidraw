import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

/**
 * Better Auth's `mcp` plugin storage (it reuses the oidc-provider models). The
 * drizzle adapter resolves each model by the exported variable name, so these
 * must stay `oauthApplication`, `oauthAccessToken` and `oauthConsent` even
 * though the tables are snake_case.
 *
 * Clients arrive through Dynamic Client Registration; the registration guard in
 * the server's oauth router is what limits who may create a row here.
 */
export const oauthApplication = pgTable(
  "oauth_application",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    icon: text("icon"),
    metadata: text("metadata"),
    clientId: text("client_id").notNull(),
    // Empty for public clients, which is what PKCE-only registrations become.
    clientSecret: text("client_secret"),
    /** Comma-separated exact redirect URIs; the plugin splits on ",". */
    redirectUrls: text("redirect_urls").notNull(),
    type: text("type").notNull(),
    disabled: boolean("disabled").default(false).notNull(),
    /** The registering user's id when a session registered the client. */
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("oauth_application_client_id_unique").on(table.clientId),
    index("oauth_application_user_id_idx").on(table.userId),
    check(
      "oauth_application_type_valid",
      sql`${table.type} in ('web', 'public', 'native', 'user-agent-based')`,
    ),
  ],
);

/**
 * Issued access/refresh token pairs. Both values are stored as the same
 * `sha256:` digest personal access tokens and sessions use; hashing happens in
 * the auth adapter wrapper, so the plaintext only ever leaves through the token
 * endpoint response.
 */
export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }).notNull(),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }).notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** Space-separated granted scopes, e.g. "openid offline_access write". */
    scopes: text("scopes").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("oauth_access_token_access_token_unique").on(table.accessToken),
    uniqueIndex("oauth_access_token_refresh_token_unique").on(
      table.refreshToken,
    ),
    index("oauth_access_token_user_id_idx").on(table.userId),
    index("oauth_access_token_client_id_idx").on(table.clientId),
  ],
);

/** One row per (user, client) consent, written when the user accepts. */
export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    consentGiven: boolean("consent_given").notNull(),
    ...timestamps,
  },
  (table) => [
    index("oauth_consent_client_id_idx").on(table.clientId),
    index("oauth_consent_user_id_idx").on(table.userId),
  ],
);

export type OauthApplicationRow = typeof oauthApplication.$inferSelect;
export type OauthAccessTokenRow = typeof oauthAccessToken.$inferSelect;
