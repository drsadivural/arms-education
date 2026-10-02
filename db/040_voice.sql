-- 040: voice assistant support (docs/05). No audio or transcripts are stored; only session accounting,
-- confirmation drafts (hashed action tokens) and per-call results for idempotency.
BEGIN;

ALTER TABLE app.voice_sessions
  ADD COLUMN role text NOT NULL DEFAULT 'student' CHECK (role IN ('teacher','student')),
  ADD COLUMN model text NOT NULL DEFAULT '',
  ADD COLUMN end_reason text CHECK (end_reason IN ('client','replaced','expired','provider_error'));
CREATE INDEX voice_sessions_user_day ON app.voice_sessions (org_id, user_id, created_at DESC);
CREATE INDEX voice_sessions_open ON app.voice_sessions (expires_at) WHERE ended_at IS NULL;

ALTER TABLE app.voice_actions
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT voice_actions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$');
CREATE INDEX voice_actions_session ON app.voice_actions (org_id, session_id, created_at DESC);

ALTER TABLE app.voice_tool_executions
  ADD COLUMN tool_name text NOT NULL DEFAULT '';

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
COMMIT;
