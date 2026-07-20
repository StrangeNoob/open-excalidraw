import { z } from "zod";

import { isoDateTimeSchema, uuidSchema } from "./common/primitives.js";

export const adminOverviewSchema = z
  .object({
    users: z.number().int().nonnegative(),
    drawings: z
      .number()
      .int()
      .nonnegative()
      .meta({ description: "Active (non-trashed) drawings." }),
    storageBytes: z
      .number()
      .int()
      .nonnegative()
      .meta({ description: "Total bytes of active drawing assets." }),
  })
  .strict();

export const adminUserSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(120),
    email: z.string().email(),
    emailVerified: z.boolean(),
    createdAt: isoDateTimeSchema,
    disabledAt: isoDateTimeSchema.nullable().meta({
      description: "Null when active; a timestamp when disabled.",
    }),
    twoFactorEnabled: z.boolean().meta({
      description: "True when the user has TOTP two-factor enrollment.",
    }),
    drawingCount: z
      .number()
      .int()
      .nonnegative()
      .meta({ description: "Active drawings the user owns." }),
  })
  .strict();

export const adminUserListSchema = z
  .object({
    users: z.array(adminUserSchema),
    total: z.number().int().nonnegative().meta({
      description: "Users matching the search, ignoring the limit.",
    }),
  })
  .strict();

export type AdminOverview = z.infer<typeof adminOverviewSchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
export type AdminUserList = z.infer<typeof adminUserListSchema>;
