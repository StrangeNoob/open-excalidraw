-- Email notifications for chat mentions. user_notification_settings is kept
-- apart from the auth-owned "user" table so notification preferences are never
-- entangled with Better Auth's schema; an absent row means every notification
-- kind is on, and future kinds add COLUMNS here rather than new tables.
-- mention_email_state is the cooldown ledger: one row per (recipient, drawing)
-- recording the last send. It is claimed with a conditional upsert, so two
-- messages mentioning the same person at the same moment cannot both decide to
-- send. The maintenance job prunes rows older than the cooldown window, which
-- is why nothing here is in memory: cooldowns must survive a restart.
CREATE TABLE user_notification_settings (
  user_id UUID PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  mention_emails BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE mention_email_state (
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  drawing_id UUID NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
  last_sent_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT mention_email_state_pkey PRIMARY KEY (user_id, drawing_id)
);

-- The prune scans by age alone, which the composite PK cannot serve.
CREATE INDEX mention_email_state_last_sent_at_idx
  ON mention_email_state (last_sent_at);
