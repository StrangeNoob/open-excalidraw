import { z } from "zod";

import { isoDateTimeSchema, uuidSchema } from "./common/primitives.js";

/** Personal access tokens are prefixed so leaked strings are attributable. */
export const PERSONAL_ACCESS_TOKEN_PREFIX = "oepat_";

export const tokenScopeSchema = z.enum(["read", "write", "full"]).meta({
  description:
    "read: safe methods only. write: adds unsafe methods, but not " +
    "/api/v1/admin. full: everything the owner can do over REST.",
});

export const personalAccessTokenSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(100),
    scope: tokenScopeSchema,
    lastFour: z.string().length(4).meta({
      description: "Last four characters of the secret, for identification.",
    }),
    createdAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema.nullable().meta({
      description: "Null when the token never expires.",
    }),
    lastUsedAt: isoDateTimeSchema.nullable().meta({
      description:
        "Coarse-grained (updated at most hourly); null when never used.",
    }),
  })
  .strict();

export const personalAccessTokenListSchema = z
  .object({
    tokens: z.array(personalAccessTokenSchema),
  })
  .strict();

export const personalAccessTokenCreateSchema = z
  .object({
    name: z.string().min(1).max(100),
    expiresInDays: z.number().int().min(1).max(365).nullable().meta({
      description: "Null means the token never expires.",
    }),
    scope: tokenScopeSchema.optional().meta({
      description: "Defaults to `write`; omitting it never grants `full`.",
    }),
  })
  .strict();

export const personalAccessTokenCreatedSchema = z
  .object({
    token: personalAccessTokenSchema,
    secret: z
      .string()
      .startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)
      .meta({ description: "The full token value, shown exactly once." }),
  })
  .strict();

export type TokenScope = z.infer<typeof tokenScopeSchema>;
export type PersonalAccessToken = z.infer<typeof personalAccessTokenSchema>;
export type PersonalAccessTokenList = z.infer<
  typeof personalAccessTokenListSchema
>;
export type PersonalAccessTokenCreate = z.infer<
  typeof personalAccessTokenCreateSchema
>;
export type PersonalAccessTokenCreated = z.infer<
  typeof personalAccessTokenCreatedSchema
>;
