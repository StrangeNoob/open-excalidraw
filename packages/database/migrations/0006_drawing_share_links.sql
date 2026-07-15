CREATE TABLE drawing_share_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_id UUID NOT NULL REFERENCES drawings (id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  created_by_user_id UUID NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT drawing_share_links_token_format CHECK (token ~ '^[A-Za-z0-9_-]{43}$')
);

CREATE UNIQUE INDEX drawing_share_links_token_unique
  ON drawing_share_links (token);

CREATE UNIQUE INDEX drawing_share_links_active_drawing_unique
  ON drawing_share_links (drawing_id)
  WHERE revoked_at IS NULL;
