-- Purge-in-progress marker: set inside the purge's prepare transaction so a
-- concurrent restore can never resurrect a drawing whose blobs are being
-- deleted. Marked rows are hidden from the trash and reclaimed by the
-- maintenance purge regardless of their deleted_at age.
ALTER TABLE drawings
  ADD COLUMN purge_started_at TIMESTAMPTZ;

CREATE INDEX drawings_purge_started_at_idx
  ON drawings (purge_started_at)
  WHERE purge_started_at IS NOT NULL;
