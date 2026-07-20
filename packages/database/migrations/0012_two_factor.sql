-- Opt-in TOTP two-factor enrollment for the Better Auth twoFactor plugin.
-- One row per enrolled user holds the shared secret and backup codes; the
-- user flag mirrors the plugin's user.twoFactorEnabled field.
ALTER TABLE "user" ADD COLUMN two_factor_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE two_factor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secret TEXT NOT NULL,
  backup_codes TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  verified BOOLEAN NOT NULL DEFAULT TRUE,
  failed_verification_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX two_factor_user_id_idx ON two_factor (user_id);
CREATE INDEX two_factor_secret_idx ON two_factor (secret);
