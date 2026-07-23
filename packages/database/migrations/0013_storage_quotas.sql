-- Per-user storage quotas. app_settings is a single-row table (id is a boolean
-- pinned to true) holding the instance-wide default; the "user" column is a
-- per-user override. NULL everywhere means unlimited, preserving prior behavior.
CREATE TABLE app_settings (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  storage_quota_per_user_bytes BIGINT
    CHECK (storage_quota_per_user_bytes IS NULL
           OR storage_quota_per_user_bytes > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES (true);

ALTER TABLE "user" ADD COLUMN storage_quota_bytes BIGINT
  CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes > 0);
