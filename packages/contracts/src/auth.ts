import { z } from "zod";

import { isoDateTimeSchema, uuidSchema } from "./common/primitives";

export const authCapabilitiesSchema = z
  .object({
    emailPassword: z.boolean(),
    google: z.boolean(),
    github: z.boolean(),
    smtp: z.boolean(),
  })
  .strict();

export const currentUserSchema = z
  .object({
    id: uuidSchema,
    email: z.string().email(),
    name: z.string().min(1).max(120),
    image: z.string().url().nullable(),
    emailVerified: z.boolean(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const sessionResponseSchema = z
  .object({
    user: currentUserSchema.nullable(),
    capabilities: authCapabilitiesSchema,
  })
  .strict();

export type AuthCapabilities = z.infer<typeof authCapabilitiesSchema>;
export type CurrentUser = z.infer<typeof currentUserSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
