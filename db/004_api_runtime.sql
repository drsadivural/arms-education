-- 004: support required by the Workers API runtime (auth bootstrap, web sessions, settings versioning, indexes).
BEGIN;

-- Authentication bootstrap. Before the organisation is known, the API sets app.auth_user_id to the
-- server-verified JWT subject and may read only that user's own memberships across organisations.
-- Tenant isolation (tenant_scope) still applies to every other query.
CREATE FUNCTION app.auth_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.auth_user_id',true),'')::uuid $$;
CREATE POLICY auth_self_lookup ON app.memberships FOR SELECT USING (id = app.auth_user_id());

-- One auth account per e-mail address (Auth provider guarantees the same).
CREATE UNIQUE INDEX users_email_unique ON app.users (lower(email));

-- Web BFF sessions: the cookie holds a random 256-bit id; the table stores only its SHA-256 (id column),
-- AES-GCM encrypted provider tokens and the CSRF token hash. A session is bound to one organisation and role.
ALTER TABLE app.web_sessions
  ADD COLUMN org_id uuid NOT NULL,
  ADD COLUMN role text NOT NULL CHECK (role IN ('admin','teacher','student')),
  ADD COLUMN aal text NOT NULL DEFAULT 'aal1' CHECK (aal IN ('aal1','aal2')),
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN revoked_at timestamptz,
  ADD CONSTRAINT web_sessions_membership_fk FOREIGN KEY (org_id, user_id) REFERENCES app.memberships (org_id, id);
CREATE INDEX web_sessions_user ON app.web_sessions (user_id);
CREATE INDEX web_sessions_expiry ON app.web_sessions (expires_at);

-- Settings are stored in organizations.settings; optimistic concurrency for PATCH /settings.
ALTER TABLE app.organizations ADD COLUMN row_version int NOT NULL DEFAULT 1;

-- Membership audit columns used by user management.
ALTER TABLE app.memberships
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN row_version int NOT NULL DEFAULT 1;

-- Optimistic concurrency for PATCH /me/preferences.
ALTER TABLE app.user_preferences ADD COLUMN row_version int NOT NULL DEFAULT 1;

-- Lookup / list indexes.
CREATE INDEX audit_events_recent ON app.audit_events (org_id, created_at DESC, id);
CREATE INDEX audit_events_entity ON app.audit_events (org_id, entity_id, created_at);
CREATE INDEX outbox_due ON app.outbox (state, next_attempt_at) WHERE state IN ('pending','processing','failed');
CREATE INDEX reservations_student ON app.reservations (org_id, student_id, starts_at);
CREATE INDEX reservations_pending_expiry ON app.reservations (expires_at) WHERE status = 'pending';
CREATE INDEX lesson_slots_time ON app.lesson_slots (org_id, starts_at);
CREATE INDEX student_profiles_classroom ON app.student_profiles (org_id, classroom_id) WHERE active;
CREATE INDEX student_profiles_teacher ON app.student_profiles (org_id, teacher_id);
CREATE INDEX notifications_user ON app.notifications (org_id, user_id, created_at DESC);
CREATE INDEX idempotency_expiry ON app.idempotency_requests (expires_at);

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
COMMIT;
