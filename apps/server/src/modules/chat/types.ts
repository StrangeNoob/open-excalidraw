import type {
  ChatMessage,
  ChatMessageAnchor,
  ChatParticipant,
} from "@open-excalidraw/contracts";

export interface ChatMessageRecord {
  id: string;
  drawingId: string;
  userId: string;
  authorName: string;
  body: string;
  mentions: string[] | null;
  anchor: ChatMessageAnchor | null;
  createdAt: Date;
}

export interface ChatRepository {
  insert(input: {
    id: string;
    drawingId: string;
    userId: string;
    body: string;
    mentions?: string[];
    anchor?: ChatMessageAnchor;
  }): Promise<ChatMessageRecord | null>;
  listBefore(
    drawingId: string,
    beforeMessageId: string | null,
    limit: number,
  ): Promise<ChatMessageRecord[]>;
  listParticipants(drawingId: string): Promise<ChatParticipant[]>;
}

export function toChatMessage(record: ChatMessageRecord): ChatMessage {
  return {
    id: record.id,
    drawingId: record.drawingId,
    userId: record.userId,
    authorName: record.authorName,
    body: record.body,
    // chatMessageSchema is strict with optional mentions/anchor: an absent
    // value must be an absent key, never an explicit null or undefined.
    ...(record.mentions && record.mentions.length > 0
      ? { mentions: record.mentions }
      : {}),
    ...(record.anchor ? { anchor: record.anchor } : {}),
    createdAt: record.createdAt.toISOString(),
  };
}
