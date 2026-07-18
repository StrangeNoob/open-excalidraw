-- Minimal admin user management: a disable flag and a delete path that does not
-- trip over content the user authored in OTHER users' drawings.
--
-- disabled_at doubles as flag and timestamp: NULL means active.
ALTER TABLE "user" ADD COLUMN disabled_at TIMESTAMPTZ;

-- Deleting a user must not be blocked by attribution FKs on shared content.
-- These five drop RESTRICT for SET NULL so the columns null out on delete;
-- drawings.owner_user_id stays RESTRICT (owned drawings are purged first).
ALTER TABLE drawing_revisions ALTER COLUMN author_user_id DROP NOT NULL;
ALTER TABLE drawing_revisions
  DROP CONSTRAINT drawing_revisions_author_user_id_fkey;
ALTER TABLE drawing_revisions
  ADD CONSTRAINT drawing_revisions_author_user_id_fkey
  FOREIGN KEY (author_user_id) REFERENCES "user" (id) ON DELETE SET NULL;

ALTER TABLE drawing_assets ALTER COLUMN created_by_user_id DROP NOT NULL;
ALTER TABLE drawing_assets
  DROP CONSTRAINT drawing_assets_created_by_user_id_fkey;
ALTER TABLE drawing_assets
  ADD CONSTRAINT drawing_assets_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES "user" (id) ON DELETE SET NULL;

ALTER TABLE drawing_members ALTER COLUMN created_by_user_id DROP NOT NULL;
ALTER TABLE drawing_members
  DROP CONSTRAINT drawing_members_created_by_user_id_fkey;
ALTER TABLE drawing_members
  ADD CONSTRAINT drawing_members_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES "user" (id) ON DELETE SET NULL;

ALTER TABLE drawing_invitations ALTER COLUMN invited_by_user_id DROP NOT NULL;
ALTER TABLE drawing_invitations
  DROP CONSTRAINT drawing_invitations_invited_by_user_id_fkey;
ALTER TABLE drawing_invitations
  ADD CONSTRAINT drawing_invitations_invited_by_user_id_fkey
  FOREIGN KEY (invited_by_user_id) REFERENCES "user" (id) ON DELETE SET NULL;

ALTER TABLE drawing_share_links ALTER COLUMN created_by_user_id DROP NOT NULL;
ALTER TABLE drawing_share_links
  DROP CONSTRAINT drawing_share_links_created_by_user_id_fkey;
ALTER TABLE drawing_share_links
  ADD CONSTRAINT drawing_share_links_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES "user" (id) ON DELETE SET NULL;
