import { z } from "zod";

/**
 * Per-account notification preferences. Every kind defaults to on, so an
 * account that never touched this page has no stored row at all; future kinds
 * are further booleans here rather than a second resource.
 */
export const notificationSettingsSchema = z
  .object({
    mentionEmails: z.boolean().meta({
      description:
        "Email me when someone mentions me in a drawing I am away from.",
    }),
  })
  .strict();

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
