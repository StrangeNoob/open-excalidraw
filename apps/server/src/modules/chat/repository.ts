import type {
  ChatMessageAnchor,
  ChatParticipant,
} from "@open-excalidraw/contracts";
import type { Pool, QueryResultRow } from "pg";

import type {
  ChatMessageRecord,
  ChatRepository,
  MentionEmailRecipient,
  MentionNotificationRepository,
} from "./types.js";

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

interface MentionRecipientRow extends QueryResultRow {
  user_id: string;
  email: string;
  mention_emails: boolean;
  drawing_title: string;
}

export class PostgresMentionNotificationRepository implements MentionNotificationRepository {
  public constructor(private readonly pool: Pool) {}

  public async findMentionRecipients(input: {
    drawingId: string;
    userIds: string[];
  }): Promise<MentionEmailRecipient[]> {
    // No settings row means opted in, so the join is a LEFT one and the
    // default lives in COALESCE rather than in a backfill. Membership is
    // re-checked here: the caller filtered at send time, but notification is
    // detached, and nobody who lost access in between may be told the title.
    const result = await this.pool.query<MentionRecipientRow>(
      `SELECT u.id AS user_id, u.email, d.title AS drawing_title,
              COALESCE(s.mention_emails, true) AS mention_emails
       FROM drawings d
       JOIN "user" u ON u.id = ANY($2::uuid[])
       LEFT JOIN user_notification_settings s ON s.user_id = u.id
       WHERE d.id = $1 AND d.deleted_at IS NULL AND u.disabled_at IS NULL
         AND (u.id = d.owner_user_id
              OR EXISTS (SELECT 1 FROM drawing_members m
                         WHERE m.drawing_id = d.id AND m.user_id = u.id))`,
      [input.drawingId, input.userIds],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      mentionEmails: row.mention_emails,
      drawingTitle: row.drawing_title,
    }));
  }

  public async claimMentionEmailCooldown(input: {
    drawingId: string;
    userIds: string[];
    cooldownMinutes: number;
  }): Promise<string[]> {
    // The conditional DO UPDATE is the claim: a row still inside its window
    // matches no update and is therefore not returned, so two concurrent
    // mentions of the same person in the same drawing yield one email. The
    // ORDER BY is what keeps that concurrency safe: every claimant locks the
    // shared rows in user_id order, so overlapping batches cannot deadlock.
    const result = await this.pool.query<{ user_id: string }>(
      `INSERT INTO mention_email_state (user_id, drawing_id, last_sent_at)
       SELECT DISTINCT unnest($2::uuid[]), $1::uuid, now()
       ORDER BY 1
       ON CONFLICT (user_id, drawing_id) DO UPDATE SET last_sent_at = now()
         WHERE mention_email_state.last_sent_at
               <= now() - ($3::int * interval '1 minute')
       RETURNING user_id`,
      [input.drawingId, input.userIds, input.cooldownMinutes],
    );
    return result.rows.map((row) => row.user_id);
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
