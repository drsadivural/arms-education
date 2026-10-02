-- 010: admin area — resumable invitation saga bookkeeping and list/scope indexes.
--
-- Invitation saga (contracts/API_NOTES_JA.md 「管理者inviteはAuth provider作成とDB profileのsagaをinvitation_jobsで追跡」):
--   pending        job recorded, Auth provider user not created yet
--   auth_created   provider user exists (auth_user_id), app.users/memberships/profile not created yet
--   profile_created DB profile committed, invitation e-mail not sent yet (or account registered as inactive)
--   sent           invitation e-mail accepted by the provider
--   failed         sending failed after the profile was created (resend possible)
-- External calls are made outside DB transactions; a short lease (locked_until) serialises work on one job.
BEGIN;

ALTER TABLE app.invitation_jobs
  ADD COLUMN created_by uuid,
  ADD COLUMN idempotency_key uuid,
  ADD COLUMN request_hash text,
  ADD COLUMN resend_key uuid,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN profile_created_at timestamptz,
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT invitation_jobs_creator_fk FOREIGN KEY (org_id, created_by) REFERENCES app.memberships (org_id, id),
  ADD CONSTRAINT invitation_jobs_auth_user CHECK (state = 'pending' OR auth_user_id IS NOT NULL),
  ADD CONSTRAINT invitation_jobs_profile CHECK (state NOT IN ('profile_created', 'sent', 'failed') OR profile_created_at IS NOT NULL),
  ADD CONSTRAINT invitation_jobs_email_length CHECK (length(email) BETWEEN 3 AND 254);

-- Replays of the same create request (same admin + Idempotency-Key) resume the same job.
CREATE UNIQUE INDEX invitation_jobs_request ON app.invitation_jobs (org_id, created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- At most one unfinished (pre-profile) job per e-mail and organisation: a later request adopts it, so an
-- Auth provider user created by an interrupted saga is reused instead of being created twice.
CREATE UNIQUE INDEX invitation_jobs_open_email ON app.invitation_jobs (org_id, lower(email)) WHERE state IN ('pending', 'auth_created');
CREATE INDEX invitation_jobs_user ON app.invitation_jobs (org_id, auth_user_id, created_at DESC);

-- Teacher scope lookups (classrooms a teacher is assigned to) and teacher list aggregates.
CREATE INDEX classroom_teachers_teacher ON app.classroom_teachers (org_id, teacher_id);
CREATE INDEX lesson_slots_teacher_time ON app.lesson_slots (org_id, teacher_id, starts_at);
-- Audit log search by event-type prefix and by actor.
CREATE INDEX audit_events_type ON app.audit_events (org_id, event_type text_pattern_ops, created_at DESC);
CREATE INDEX audit_events_actor ON app.audit_events (org_id, actor_id, created_at DESC);
-- Settings: account deletion queue and delivery (outbox) monitor.
CREATE INDEX account_deletion_requests_state ON app.account_deletion_requests (org_id, state, created_at DESC);
CREATE INDEX outbox_org_state ON app.outbox (org_id, state, created_at DESC);

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
COMMIT;
