import { z } from "zod";

import { isoDateTimeSchema, uuidSchema } from "./common/primitives.js";
import { CONTRACT_LIMITS } from "./limits.js";

export const chatMessageBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(CONTRACT_LIMITS.chatMessageCharacters);

export const chatMentionsSchema = z
  .array(uuidSchema)
  .min(1)
  .max(CONTRACT_LIMITS.chatMentionsPerMessage)
  .meta({ description: "User ids of mentioned drawing members." });

// Element ids are opaque Excalidraw strings, not uuids, and are never checked
// against scene content: the scene moves on, so an anchor can only be resolved
// where it is used.
export const chatMessageAnchorSchema = z
  .object({
    elementIds: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(CONTRACT_LIMITS.chatAnchorElements),
  })
  .strict();

export const chatMessageSchema = z
  .object({
    id: uuidSchema,
    drawingId: uuidSchema,
    userId: uuidSchema,
    authorName: z.string().min(1).max(120),
    body: chatMessageBodySchema,
    mentions: chatMentionsSchema.optional(),
    anchor: chatMessageAnchorSchema.optional(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const chatSendEventSchema = z
  .object({
    type: z.literal("chat.send"),
    messageId: uuidSchema,
    body: chatMessageBodySchema,
    mentions: chatMentionsSchema.optional(),
    anchor: chatMessageAnchorSchema.optional(),
  })
  .strict();

export const chatMessageEventSchema = z
  .object({
    type: z.literal("chat.message"),
    message: chatMessageSchema,
  })
  .strict();

// Names only: every member reads this roster to compose and render mentions,
// while emails, roles and invitations stay with the owner-only sharing list.
export const chatParticipantSchema = z
  .object({
    userId: uuidSchema,
    name: z.string().min(1).max(120),
  })
  .strict();

export const chatParticipantsResponseSchema = z
  .object({ participants: z.array(chatParticipantSchema) })
  .strict();

export const chatHistoryResponseSchema = z
  .object({
    messages: z.array(chatMessageSchema),
    nextCursor: z.string().nullable().meta({
      description: "Pass as `before` to fetch the next older page.",
    }),
  })
  .strict();

export type ChatMessageAnchor = z.infer<typeof chatMessageAnchorSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatSendEvent = z.infer<typeof chatSendEventSchema>;
export type ChatMessageEvent = z.infer<typeof chatMessageEventSchema>;
export type ChatHistoryResponse = z.infer<typeof chatHistoryResponseSchema>;
export type ChatParticipant = z.infer<typeof chatParticipantSchema>;
export type ChatParticipantsResponse = z.infer<
  typeof chatParticipantsResponseSchema
>;
