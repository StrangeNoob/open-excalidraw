import type { NotificationSettings } from "@open-excalidraw/contracts";
import type { Pool, QueryResultRow } from "pg";

interface SettingsRow extends QueryResultRow {
  mention_emails: boolean;
}

export interface NotificationSettingsRepository {
  get(userId: string): Promise<NotificationSettings>;
  put(
    userId: string,
    settings: NotificationSettings,
  ): Promise<NotificationSettings>;
}

export class PostgresNotificationSettingsRepository implements NotificationSettingsRepository {
  public constructor(private readonly pool: Pool) {}

  public async get(userId: string): Promise<NotificationSettings> {
    const result = await this.pool.query<SettingsRow>(
      `SELECT mention_emails FROM user_notification_settings WHERE user_id = $1`,
      [userId],
    );
    // No row means nothing was ever turned off; the mention notifier reads the
    // same default through COALESCE, so neither side needs a backfill.
    return { mentionEmails: result.rows[0]?.mention_emails ?? true };
  }

  public async put(
    userId: string,
    settings: NotificationSettings,
  ): Promise<NotificationSettings> {
    const result = await this.pool.query<SettingsRow>(
      `INSERT INTO user_notification_settings (user_id, mention_emails)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET mention_emails = EXCLUDED.mention_emails
       RETURNING mention_emails`,
      [userId, settings.mentionEmails],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Notification settings upsert returned no row");
    return { mentionEmails: row.mention_emails };
  }
}
