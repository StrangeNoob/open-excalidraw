import { z } from "zod";

import { isoDateTimeSchema, uuidSchema } from "./common/primitives.js";
import { CONTRACT_LIMITS } from "./limits.js";

export const chatMessageBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(CONTRACT_LIMITS.chatMessageCharacters);

export const chatMessageSchema = z
  .object({
    id: uuidSchema,
    drawingId: uuidSchema,
    userId: uuidSchema,
    authorName: z.string().min(1).max(120),
    body: chatMessageBodySchema,
    createdAt: isoDateTimeSchema,
  })
  .strict();

export const chatSendEventSchema = z
  .object({
    type: z.literal("chat.send"),
    messageId: uuidSchema,
    body: chatMessageBodySchema,
  })
  .strict();

export const chatMessageEventSchema = z
  .object({
    type: z.literal("chat.message"),
    message: chatMessageSchema,
  })
  .strict();

export const chatHistoryResponseSchema = z
  .object({
    messages: z.array(chatMessageSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatSendEvent = z.infer<typeof chatSendEventSchema>;
export type ChatMessageEvent = z.infer<typeof chatMessageEventSchema>;
export type ChatHistoryResponse = z.infer<typeof chatHistoryResponseSchema>;
