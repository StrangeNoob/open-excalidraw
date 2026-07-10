import { z } from "zod";

import {
  isoDateTimeSchema,
  memberRoleSchema,
  roleSchema,
  uuidSchema,
} from "./common/primitives";

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
    manualUrl: z.string().url().optional(),
  })
  .strict()
  .refine(
    (value) => value.membership !== undefined || value.invitation !== undefined,
    {
      message: "A membership or invitation is required",
    },
  );

export const updateMemberRoleRequestSchema = z
  .object({ role: memberRoleSchema })
  .strict();

export type DrawingMember = z.infer<typeof drawingMemberSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
