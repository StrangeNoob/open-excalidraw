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
    storageBytes: z.number().int().nonnegative().meta({
      description: "Bytes of active assets across drawings the user owns.",
    }),
    storageQuotaBytes: z.number().int().positive().nullable().meta({
      description:
        "Per-user storage quota override in bytes; null falls back to the instance default.",
    }),
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

export const adminSettingsSchema = z
  .object({
    storageQuotaPerUserBytes: z.number().int().positive().nullable().meta({
      description:
        "Instance-wide per-user storage quota in bytes; null falls back to the STORAGE_QUOTA_PER_USER_BYTES environment default.",
    }),
    envFallbackBytes: z.number().int().positive().nullable().meta({
      description:
        "Read-only STORAGE_QUOTA_PER_USER_BYTES environment default; null means unlimited.",
    }),
  })
  .strict();

export const adminSettingsUpdateSchema = z
  .object({
    storageQuotaPerUserBytes: z.number().int().positive().nullable(),
  })
  .strict();

export const adminUserQuotaUpdateSchema = z
  .object({
    storageQuotaBytes: z.number().int().positive().nullable(),
  })
  .strict();

export type AdminOverview = z.infer<typeof adminOverviewSchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
export type AdminUserList = z.infer<typeof adminUserListSchema>;
export type AdminSettings = z.infer<typeof adminSettingsSchema>;
export type AdminSettingsUpdate = z.infer<typeof adminSettingsUpdateSchema>;
export type AdminUserQuotaUpdate = z.infer<typeof adminUserQuotaUpdateSchema>;
