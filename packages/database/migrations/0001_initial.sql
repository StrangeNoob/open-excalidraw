CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "user" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(120) NOT NULL,
  email CITEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_email_unique ON "user" (email);

CREATE TABLE "session" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id UUID NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX session_token_unique ON "session" (token);
CREATE INDEX session_user_id_idx ON "session" (user_id);
CREATE INDEX session_expires_at_idx ON "session" (expires_at);

CREATE TABLE account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX account_user_id_idx ON account (user_id);
CREATE UNIQUE INDEX account_provider_account_unique
  ON account (provider_id, account_id);

CREATE TABLE verification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX verification_identifier_idx ON verification (identifier);
CREATE INDEX verification_expires_at_idx ON verification (expires_at);

CREATE TABLE drawings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  title VARCHAR(120) NOT NULL,
  scene JSONB NOT NULL,
  scene_format_version INTEGER NOT NULL,
  content_revision BIGINT NOT NULL DEFAULT 0,
  metadata_revision BIGINT NOT NULL DEFAULT 0,
  scene_bytes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  last_checkpoint_at TIMESTAMPTZ,
  CONSTRAINT drawings_scene_format_version_positive
    CHECK (scene_format_version > 0),
  CONSTRAINT drawings_content_revision_nonnegative
    CHECK (content_revision >= 0),
  CONSTRAINT drawings_metadata_revision_nonnegative
    CHECK (metadata_revision >= 0),
  CONSTRAINT drawings_scene_bytes_nonnegative CHECK (scene_bytes >= 0)
);

CREATE INDEX drawings_owner_user_id_idx ON drawings (owner_user_id);
CREATE INDEX drawings_active_updated_at_idx
  ON drawings (updated_at)
  WHERE deleted_at IS NULL;
CREATE INDEX drawings_deleted_at_idx ON drawings (deleted_at);

CREATE TABLE drawing_members (
  drawing_id UUID NOT NULL REFERENCES drawings (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL,
  created_by_user_id UUID NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drawing_members_pkey PRIMARY KEY (drawing_id, user_id),
  CONSTRAINT drawing_members_role_valid CHECK (role IN ('editor', 'viewer'))
);

CREATE INDEX drawing_members_user_id_idx ON drawing_members (user_id);

CREATE TABLE drawing_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_id UUID NOT NULL REFERENCES drawings (id) ON DELETE CASCADE,
  invitee_email CITEXT NOT NULL,
  role VARCHAR(16) NOT NULL,
  token_hash BYTEA NOT NULL,
  invited_by_user_id UUID NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id UUID REFERENCES "user" (id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  delivery_status VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drawing_invitations_role_valid
    CHECK (role IN ('editor', 'viewer')),
  CONSTRAINT drawing_invitations_token_hash_length
    CHECK (octet_length(token_hash) = 32),
  CONSTRAINT drawing_invitations_delivery_status_valid
    CHECK (delivery_status IN ('sent', 'manual', 'failed')),
  CONSTRAINT drawing_invitations_acceptance_consistent CHECK (
    accepted_by_user_id IS NULL OR accepted_at IS NOT NULL
  ),
  CONSTRAINT drawing_invitations_not_accepted_and_revoked CHECK (
    NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX drawing_invitations_token_hash_unique
  ON drawing_invitations (token_hash);
CREATE UNIQUE INDEX drawing_invitations_active_email_unique
  ON drawing_invitations (drawing_id, invitee_email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX drawing_invitations_drawing_id_idx
  ON drawing_invitations (drawing_id);
CREATE INDEX drawing_invitations_expires_at_idx
  ON drawing_invitations (expires_at);

CREATE TABLE drawing_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_id UUID NOT NULL REFERENCES drawings (id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 BYTEA NOT NULL,
  file_version INTEGER,
  created_by_user_id UUID NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_referenced_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  CONSTRAINT drawing_assets_file_id_not_empty CHECK (length(file_id) > 0),
  CONSTRAINT drawing_assets_mime_type_not_empty CHECK (length(mime_type) > 0),
  CONSTRAINT drawing_assets_byte_size_nonnegative CHECK (byte_size >= 0),
  CONSTRAINT drawing_assets_sha256_length CHECK (octet_length(sha256) = 32),
  CONSTRAINT drawing_assets_file_version_positive
    CHECK (file_version IS NULL OR file_version > 0)
);

CREATE UNIQUE INDEX drawing_assets_storage_key_unique
  ON drawing_assets (storage_key);
CREATE UNIQUE INDEX drawing_assets_drawing_file_unique
  ON drawing_assets (drawing_id, file_id);
CREATE INDEX drawing_assets_active_drawing_idx
  ON drawing_assets (drawing_id)
  WHERE deleted_at IS NULL;
CREATE INDEX drawing_assets_unreferenced_cleanup_idx
  ON drawing_assets (last_referenced_at, created_at);

CREATE TABLE drawing_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_id UUID NOT NULL REFERENCES drawings (id) ON DELETE CASCADE,
  content_revision BIGINT NOT NULL,
  scene JSONB NOT NULL,
  scene_format_version INTEGER NOT NULL,
  scene_bytes INTEGER NOT NULL,
  author_user_id UUID NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  reason VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drawing_revisions_content_revision_nonnegative
    CHECK (content_revision >= 0),
  CONSTRAINT drawing_revisions_scene_format_version_positive
    CHECK (scene_format_version > 0),
  CONSTRAINT drawing_revisions_scene_bytes_nonnegative CHECK (scene_bytes >= 0),
  CONSTRAINT drawing_revisions_reason_valid
    CHECK (reason IN ('checkpoint', 'restore'))
);

CREATE UNIQUE INDEX drawing_revisions_drawing_revision_unique
  ON drawing_revisions (drawing_id, content_revision);
CREATE INDEX drawing_revisions_drawing_created_at_idx
  ON drawing_revisions (drawing_id, created_at);

CREATE TABLE drawing_mutations (
  drawing_id UUID NOT NULL REFERENCES drawings (id) ON DELETE CASCADE,
  mutation_id UUID NOT NULL,
  payload_hash BYTEA NOT NULL,
  base_revision BIGINT NOT NULL,
  resulting_revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT drawing_mutations_pkey PRIMARY KEY (drawing_id, mutation_id),
  CONSTRAINT drawing_mutations_payload_hash_length
    CHECK (octet_length(payload_hash) = 32),
  CONSTRAINT drawing_mutations_base_revision_nonnegative
    CHECK (base_revision >= 0),
  CONSTRAINT drawing_mutations_resulting_revision_valid
    CHECK (resulting_revision > base_revision)
);

CREATE INDEX drawing_mutations_created_at_idx
  ON drawing_mutations (created_at);

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES "user" (id) ON DELETE SET NULL,
  drawing_id UUID REFERENCES drawings (id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  request_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_drawing_created_at_idx
  ON audit_events (drawing_id, created_at);
CREATE INDEX audit_events_actor_created_at_idx
  ON audit_events (actor_user_id, created_at);
CREATE INDEX audit_events_type_created_at_idx
  ON audit_events (event_type, created_at);
