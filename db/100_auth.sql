-- ARMS's own authentication in PostgreSQL (replaces Supabase Auth; user instruction 2026-10-03, see
-- docs/dev/SPEC_DEVIATIONS_JA.md). Passwords (scrypt), administrator TOTP, iOS bearer sessions and the one-time
-- e-mail link tokens (invitation / password reset) live here.
--
-- These identity tables are global like app.users and app.web_sessions (one person may belong to several
-- organisations), so they carry no org_id and no RLS; only the API's authentication code reads them, and no
-- endpoint returns their contents. Secrets are never stored in plain text: passwords as scrypt hashes, tokens as
-- SHA-256 hashes, TOTP secrets AES-GCM encrypted by the API (WEB_SESSION_ENCRYPTION_KEY, AAD bound to the user).

CREATE TABLE app.user_credentials (
  user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  -- NULL until the user sets a password from the invitation link.
  password_hash text CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%'),
  password_changed_at timestamptz,
  -- Consecutive failed sign-ins; reaching the limit sets locked_until and starts counting again.
  failed_login_count int NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  -- Administrator TOTP (RFC 6238). The pending secret is the one shown as a QR code until its first verification.
  totp_secret_enc text,
  totp_enrolled_at timestamptz,
  totp_pending_secret_enc text,
  totp_pending_created_at timestamptz,
  -- Highest accepted 30-second time step: a code is never accepted twice (replay protection).
  totp_last_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credentials_totp_pair CHECK ((totp_secret_enc IS NULL) = (totp_enrolled_at IS NULL))
);

-- One-time links sent by e-mail. The raw token exists only in the e-mail (URL fragment); the DB keeps its hash.
CREATE TABLE app.auth_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('invite', 'password_reset')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_link_tokens_open ON app.auth_link_tokens (user_id, purpose) WHERE used_at IS NULL;
CREATE INDEX auth_link_tokens_expiry ON app.auth_link_tokens (expires_at);

-- iOS (Bearer) sessions: opaque access token (1 h) + rotating refresh token. A refresh token that was already
-- rotated away (previous_refresh_hash) and is presented again revokes the session (token theft detection).
CREATE TABLE app.bearer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  access_hash text NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL,
  refresh_hash text NOT NULL UNIQUE,
  previous_refresh_hash text,
  expires_at timestamptz NOT NULL,
  device_label text CHECK (device_label IS NULL OR length(device_label) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_reason text
);
CREATE INDEX bearer_sessions_user_open ON app.bearer_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX bearer_sessions_previous_refresh ON app.bearer_sessions (previous_refresh_hash) WHERE previous_refresh_hash IS NOT NULL;
CREATE INDEX bearer_sessions_expiry ON app.bearer_sessions (expires_at);

-- Web sessions no longer carry identity-provider tokens: the encrypted payload holds only the CSRF token.
-- Sessions created with Supabase tokens cannot be used any more and are revoked.
ALTER TABLE app.web_sessions RENAME COLUMN encrypted_provider_tokens TO encrypted_secrets;
UPDATE app.web_sessions SET revoked_at = now() WHERE revoked_at IS NULL;

COMMENT ON COLUMN app.invitation_jobs.auth_user_id IS 'app.users.id allocated by step 1 of the invitation saga';
