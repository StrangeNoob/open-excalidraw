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

export interface MentionEmailRecipient {
  userId: string;
  email: string;
  /** false only when the user explicitly opted out; an absent row is opted in. */
  mentionEmails: boolean;
  drawingTitle: string;
}

export interface MentionNotificationRepository {
  /**
   * Address and mention-email preference of each mentioned user, carrying the
   * title of the drawing they were mentioned in. Users the drawing no longer
   * has (or that no longer exist) are simply absent: membership is a condition
   * of the lookup, not something the caller has to guarantee.
   */
  findMentionRecipients(input: {
    drawingId: string;
    userIds: string[];
  }): Promise<MentionEmailRecipient[]>;
  /**
   * Claim the per (recipient, drawing) cooldown in one atomic upsert and
   * return only the ids that may be emailed now. Concurrent claims for the
   * same pair resolve to exactly one winner.
   */
  claimMentionEmailCooldown(input: {
    drawingId: string;
    userIds: string[];
    cooldownMinutes: number;
  }): Promise<string[]>;
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
