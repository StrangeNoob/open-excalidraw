-- Personal access tokens for REST automation. Only the SHA-256 hash of the full
-- secret is stored (bytea, 32 bytes) alongside last_four for identification; the
-- plaintext secret is shown once at creation and never persisted. A token
-- authenticates REST calls via `Authorization: Bearer oepat_...` but can neither
-- manage tokens nor open realtime collaboration sessions.
CREATE TABLE personal_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash BYTEA NOT NULL CHECK (octet_length(token_hash) = 32),
  last_four TEXT NOT NULL CHECK (length(last_four) = 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX personal_access_tokens_token_hash_unique
  ON personal_access_tokens (token_hash);
CREATE INDEX personal_access_tokens_user_id_idx
  ON personal_access_tokens (user_id);
