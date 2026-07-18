import { z } from "zod";

import {
  isoDateTimeSchema,
  memberRoleSchema,
  revisionSchema,
  roleSchema,
  uuidSchema,
} from "./common/primitives.js";
import { sceneEnvelopeSchema } from "./content.js";
import { drawingTitleSchema } from "./drawings.js";

export const drawingMemberSchema = z
  .object({
    userId: uuidSchema,
    email: z.string().email(),
    name: z.string().min(1).max(120),
    image: z.string().url().nullable(),
    role: roleSchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const invitationStatusSchema = z.enum([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

export const invitationSchema = z
  .object({
    id: uuidSchema,
    drawingId: uuidSchema,
    email: z.string().email(),
    role: memberRoleSchema,
    status: invitationStatusSchema,
    expiresAt: isoDateTimeSchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const createInvitationRequestSchema = z
  .object({
    email: z.string().email(),
    role: memberRoleSchema,
  })
  .strict();

export const createInvitationResponseSchema = z
  .object({
    membership: drawingMemberSchema.optional(),
    invitation: invitationSchema.optional(),
    deliveryStatus: z.enum(["sent", "manual", "failed", "not-needed"]),
    manualUrl: z
      .string()
      .url()
      .meta({
        description:
          "Invitation link for manual delivery when email was not sent.",
      })
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.membership !== undefined) !== (value.invitation !== undefined),
    {
      message: "Exactly one of membership or invitation is required",
    },
  )
  .meta({
    description:
      "Exactly one of `membership` (the email already had an account) or " +
      "`invitation` is present.",
  });

export const updateMemberRoleRequestSchema = z
  .object({ role: memberRoleSchema })
  .strict();

export const shareLinkStatusSchema = z
  .object({
    active: z.boolean(),
    url: z.string().url().optional(),
    createdAt: isoDateTimeSchema.optional(),
  })
  .strict()
  .refine((value) => !value.active || value.url !== undefined, {
    message: "An active share link must include its url",
  });

export const createShareLinkResponseSchema = z
  .object({
    url: z.string().url(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const sharedDrawingResponseSchema = z
  .object({
    drawingId: uuidSchema,
    title: drawingTitleSchema,
    scene: sceneEnvelopeSchema,
    revision: revisionSchema,
  })
  .strict();

export type DrawingMember = z.infer<typeof drawingMemberSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type ShareLinkStatus = z.infer<typeof shareLinkStatusSchema>;
export type CreateShareLinkResponse = z.infer<
  typeof createShareLinkResponseSchema
>;
export type SharedDrawingResponse = z.infer<typeof sharedDrawingResponseSchema>;
