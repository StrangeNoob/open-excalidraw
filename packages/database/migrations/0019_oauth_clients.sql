-- OAuth authorization-server storage for Better Auth's `mcp` plugin, which
-- lets a client we do not control (claude.ai's custom connectors) acquire its
-- own credential instead of pasting a personal access token.
--
-- Access and refresh tokens are stored as the same `sha256:` digest sessions
-- and personal access tokens use; the plaintext is returned once by the token
-- endpoint and never persisted.
CREATE TABLE oauth_application (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  icon TEXT,
  metadata TEXT,
  client_id TEXT NOT NULL,
  -- Empty for public (PKCE-only) clients.
  client_secret TEXT,
  -- Comma-separated exact redirect URIs; the plugin splits on ",".
  redirect_urls TEXT NOT NULL,
  type TEXT NOT NULL,
  disabled BOOLEAN NOT NULL DEFAULT false,
  user_id UUID REFERENCES "user"(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT oauth_application_type_valid
    CHECK (type IN ('web', 'public', 'native', 'user-agent-based'))
);

CREATE UNIQUE INDEX oauth_application_client_id_unique
  ON oauth_application (client_id);
CREATE INDEX oauth_application_user_id_idx ON oauth_application (user_id);

CREATE TABLE oauth_access_token (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,
  client_id TEXT NOT NULL
    REFERENCES oauth_application(client_id) ON DELETE CASCADE,
  user_id UUID REFERENCES "user"(id) ON DELETE CASCADE,
  -- Space-separated granted scopes, e.g. "openid offline_access write".
  scopes TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX oauth_access_token_access_token_unique
  ON oauth_access_token (access_token);
CREATE UNIQUE INDEX oauth_access_token_refresh_token_unique
  ON oauth_access_token (refresh_token);
CREATE INDEX oauth_access_token_user_id_idx ON oauth_access_token (user_id);
CREATE INDEX oauth_access_token_client_id_idx ON oauth_access_token (client_id);

CREATE TABLE oauth_consent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL
    REFERENCES oauth_application(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  consent_given BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX oauth_consent_client_id_idx ON oauth_consent (client_id);
CREATE INDEX oauth_consent_user_id_idx ON oauth_consent (user_id);
