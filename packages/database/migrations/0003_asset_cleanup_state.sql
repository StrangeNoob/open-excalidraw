ALTER TABLE drawing_assets
  ADD COLUMN storage_deleted_at TIMESTAMPTZ;

CREATE INDEX drawing_assets_pending_storage_cleanup_idx
  ON drawing_assets (deleted_at, id)
  WHERE deleted_at IS NOT NULL AND storage_deleted_at IS NULL;
