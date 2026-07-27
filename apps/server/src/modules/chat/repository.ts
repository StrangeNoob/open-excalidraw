import type {
  ChatMessageAnchor,
  ChatParticipant,
} from "@open-excalidraw/contracts";
import type { Pool, QueryResultRow } from "pg";

import type { ChatMessageRecord, ChatRepository } from "./types.js";

interface ChatParticipantRow extends QueryResultRow {
  user_id: string;
  name: string;
}

interface ChatMessageRow extends QueryResultRow {
  id: string;
  drawing_id: string;
  user_id: string;
  author_name: string;
  body: string;
  mentions: string[] | null;
  anchor: ChatMessageAnchor | null;
  created_at: Date;
}

export class PostgresChatRepository implements ChatRepository {
  public constructor(private readonly pool: Pool) {}

  public async insert(input: {
    id: string;
    drawingId: string;
    userId: string;
    body: string;
    mentions?: string[];
    anchor?: ChatMessageAnchor;
  }): Promise<ChatMessageRecord | null> {
    const result = await this.pool.query<ChatMessageRow>(
      `WITH inserted AS (
         INSERT INTO chat_messages (id, drawing_id, user_id, body, mentions, anchor)
         VALUES ($1, $2, $3, $4, $5::uuid[], $6::jsonb)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, drawing_id, user_id, body, mentions, anchor, created_at
       )
       SELECT i.id, i.drawing_id, i.user_id, i.body, i.mentions, i.anchor,
              i.created_at, u.name AS author_name
       FROM inserted i
       JOIN "user" u ON u.id = i.user_id`,
      [
        input.id,
        input.drawingId,
        input.userId,
        input.body,
        input.mentions ?? null,
        input.anchor === undefined ? null : JSON.stringify(input.anchor),
      ],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  public async listBefore(
    drawingId: string,
    beforeMessageId: string | null,
    limit: number,
  ): Promise<ChatMessageRecord[]> {
    // The cursor row's created_at is resolved in-database because a
    // JS-serialized timestamp loses Postgres's microsecond precision.
    const result = await this.pool.query<ChatMessageRow>(
      `SELECT m.id, m.drawing_id, m.user_id, m.body, m.mentions, m.anchor,
              m.created_at, u.name AS author_name
       FROM chat_messages m
       JOIN "user" u ON u.id = m.user_id
       WHERE m.drawing_id = $1
         AND ($2::uuid IS NULL OR (m.created_at, m.id) <
           (SELECT c.created_at, c.id FROM chat_messages c WHERE c.id = $2))
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $3`,
      [drawingId, beforeMessageId, limit],
    );
    return result.rows.map(toRecord);
  }

  public async listParticipants(drawingId: string): Promise<ChatParticipant[]> {
    const result = await this.pool.query<ChatParticipantRow>(
      `SELECT d.owner_user_id AS user_id, u.name
       FROM drawings d JOIN "user" u ON u.id = d.owner_user_id
       WHERE d.id = $1 AND d.deleted_at IS NULL
       UNION
       SELECT m.user_id, u.name
       FROM drawing_members m JOIN "user" u ON u.id = m.user_id
       WHERE m.drawing_id = $1
       ORDER BY name, user_id`,
      [drawingId],
    );
    return result.rows.map((row) => ({ userId: row.user_id, name: row.name }));
  }
}

function toRecord(row: ChatMessageRow): ChatMessageRecord {
  return {
    id: row.id,
    drawingId: row.drawing_id,
    userId: row.user_id,
    authorName: row.author_name,
    body: row.body,
    mentions: row.mentions,
    anchor: row.anchor,
    createdAt: row.created_at,
  };
}
