import { z } from "zod";

import { isoDateTimeSchema, uuidSchema } from "./common/primitives.js";

export const adminOverviewSchema = z
  .object({
    users: z.number().int().nonnegative(),
    drawings: z.number().int().nonnegative(),
    storageBytes: z.number().int().nonnegative(),
  })
  .strict();

export const adminUserSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(120),
    email: z.string().email(),
    emailVerified: z.boolean(),
    createdAt: isoDateTimeSchema,
    // NULL means active; a timestamp means disabled.
    disabledAt: isoDateTimeSchema.nullable(),
    drawingCount: z.number().int().nonnegative(),
  })
  .strict();

export const adminUserListSchema = z
  .object({
    users: z.array(adminUserSchema),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type AdminOverview = z.infer<typeof adminOverviewSchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
export type AdminUserList = z.infer<typeof adminUserListSchema>;
