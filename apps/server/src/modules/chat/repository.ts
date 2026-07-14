import type { Pool, QueryResultRow } from "pg";

import type { ChatMessageRecord, ChatRepository } from "./types.js";

interface ChatMessageRow extends QueryResultRow {
  id: string;
  drawing_id: string;
  user_id: string;
  author_name: string;
  body: string;
  created_at: Date;
}

export class PostgresChatRepository implements ChatRepository {
  public constructor(private readonly pool: Pool) {}

  public async insert(input: {
    id: string;
    drawingId: string;
    userId: string;
    body: string;
  }): Promise<ChatMessageRecord | null> {
    const result = await this.pool.query<ChatMessageRow>(
      `WITH inserted AS (
         INSERT INTO chat_messages (id, drawing_id, user_id, body)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, drawing_id, user_id, body, created_at
       )
       SELECT i.id, i.drawing_id, i.user_id, i.body, i.created_at,
              u.name AS author_name
       FROM inserted i
       JOIN "user" u ON u.id = i.user_id`,
      [input.id, input.drawingId, input.userId, input.body],
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
      `SELECT m.id, m.drawing_id, m.user_id, m.body, m.created_at,
              u.name AS author_name
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
}

function toRecord(row: ChatMessageRow): ChatMessageRecord {
  return {
    id: row.id,
    drawingId: row.drawing_id,
    userId: row.user_id,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
  };
}
