import type { ChatMessage } from "@open-excalidraw/contracts";

export interface ChatMessageRecord {
  id: string;
  drawingId: string;
  userId: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

export interface ChatRepository {
  insert(input: {
    id: string;
    drawingId: string;
    userId: string;
    body: string;
  }): Promise<ChatMessageRecord | null>;
  listBefore(
    drawingId: string,
    beforeMessageId: string | null,
    limit: number,
  ): Promise<ChatMessageRecord[]>;
}

export function toChatMessage(record: ChatMessageRecord): ChatMessage {
  return {
    id: record.id,
    drawingId: record.drawingId,
    userId: record.userId,
    authorName: record.authorName,
    body: record.body,
    createdAt: record.createdAt.toISOString(),
  };
}
