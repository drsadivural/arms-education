-- 020: learning area — program version lifecycle, material/upload quarantine lifecycle, quiz/submission
-- evidence, progress-record history columns and export bookkeeping.
-- Columns added to tables shared with other areas use ADD COLUMN IF NOT EXISTS so parallel migrations that add
-- the same bookkeeping column (e.g. created_at) do not collide.
BEGIN;

-- ---- programs & versions ------------------------------------------------------------------------
ALTER TABLE app.programs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE app.program_versions
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS published_by uuid,
  ADD COLUMN IF NOT EXISTS source_version_id uuid;

-- One editable draft and one published version per program; publishing archives the previous published one.
CREATE UNIQUE INDEX IF NOT EXISTS learning_program_versions_single_draft ON app.program_versions (org_id, program_id) WHERE state = 'draft';
CREATE UNIQUE INDEX IF NOT EXISTS learning_program_versions_single_published ON app.program_versions (org_id, program_id) WHERE state = 'published';

-- Version state machine draft → published → archived; the policy (attempt limit, score policy) and identity
-- of a non-draft version are fixed so past progress is never re-evaluated under different rules.
CREATE FUNCTION app.guard_program_version_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.state <> 'draft' AND (NEW.policy IS DISTINCT FROM OLD.policy OR NEW.version_number <> OLD.version_number
      OR NEW.program_id <> OLD.program_id OR NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE';
  END IF;
  IF NOT (NEW.state = OLD.state OR (OLD.state = 'draft' AND NEW.state = 'published') OR (OLD.state = 'published' AND NEW.state = 'archived')) THEN
    RAISE EXCEPTION 'INVALID_STATE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER program_version_change_guard BEFORE UPDATE OR DELETE ON app.program_versions
  FOR EACH ROW EXECUTE FUNCTION app.guard_program_version_change();

-- ---- uploads (quarantine lifecycle) --------------------------------------------------------------
-- object_key always points at the current location: quarantine/<org>/<uuid> until the scanner reports clean,
-- then the final prefix (materials|submissions|imports)/<org>/<uuid>. quarantine_key keeps the key returned
-- to the client by POST /uploads (clients reference uploads by it).
ALTER TABLE app.upload_jobs
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'awaiting_upload'
    CHECK (state IN ('awaiting_upload', 'scanning', 'clean', 'blocked', 'rejected', 'expired')),
  ADD COLUMN IF NOT EXISTS quarantine_key text,
  ADD COLUMN IF NOT EXISTS detected_type text,
  ADD COLUMN IF NOT EXISTS size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes > 0),
  ADD COLUMN IF NOT EXISTS scan_reference text,
  ADD COLUMN IF NOT EXISTS scan_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS scan_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scanned_at timestamptz,
  ADD COLUMN IF NOT EXISTS reject_code text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS learning_upload_jobs_quarantine_key ON app.upload_jobs (quarantine_key) WHERE quarantine_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS learning_upload_jobs_open ON app.upload_jobs (org_id, state, expires_at) WHERE state IN ('awaiting_upload', 'scanning');

-- ---- materials ----------------------------------------------------------------------------------
ALTER TABLE app.materials
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  ADD COLUMN IF NOT EXISTS upload_id uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE app.materials ADD CONSTRAINT materials_upload_fk FOREIGN KEY (org_id, upload_id) REFERENCES app.upload_jobs (org_id, id);
CREATE INDEX IF NOT EXISTS learning_materials_unit_order ON app.materials (org_id, unit_id, created_at, id);
CREATE INDEX IF NOT EXISTS learning_materials_upload ON app.materials (org_id, upload_id) WHERE upload_id IS NOT NULL;
ALTER TABLE app.quiz_questions ADD COLUMN IF NOT EXISTS position int NOT NULL DEFAULT 0 CHECK (position >= 0);
CREATE INDEX IF NOT EXISTS learning_quiz_questions_material ON app.quiz_questions (org_id, material_id, position);

-- ---- learning evidence --------------------------------------------------------------------------
ALTER TABLE app.quiz_attempts
  ADD COLUMN IF NOT EXISTS earned_points numeric CHECK (earned_points IS NULL OR earned_points >= 0),
  ADD COLUMN IF NOT EXISTS total_points numeric CHECK (total_points IS NULL OR total_points > 0),
  ADD COLUMN IF NOT EXISTS correct_count int,
  ADD COLUMN IF NOT EXISTS question_count int;
CREATE INDEX IF NOT EXISTS learning_quiz_attempts_student_material ON app.quiz_attempts (org_id, student_id, material_id, submitted_at DESC, id);

ALTER TABLE app.submissions ADD COLUMN IF NOT EXISTS upload_id uuid;
ALTER TABLE app.submissions ADD CONSTRAINT submissions_upload_fk FOREIGN KEY (org_id, upload_id) REFERENCES app.upload_jobs (org_id, id);
CREATE INDEX IF NOT EXISTS learning_submissions_student_material ON app.submissions (org_id, student_id, material_id, submitted_at DESC, id);
CREATE INDEX IF NOT EXISTS learning_submissions_state ON app.submissions (org_id, state, submitted_at DESC, id);
CREATE INDEX IF NOT EXISTS learning_submissions_upload ON app.submissions (org_id, upload_id) WHERE upload_id IS NOT NULL;

ALTER TABLE app.unit_progress ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS learning_attendance_student ON app.attendance (org_id, student_id);
CREATE INDEX IF NOT EXISTS learning_lesson_slots_unit ON app.lesson_slots (org_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS learning_enrollments_version ON app.enrollments (org_id, program_version_id);

-- ---- legacy progress records (社員教育進捗管理) --------------------------------------------------
ALTER TABLE app.progress_records
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by uuid;
CREATE INDEX IF NOT EXISTS learning_progress_records_due ON app.progress_records (org_id, due_date, id);
CREATE INDEX IF NOT EXISTS learning_progress_records_student ON app.progress_records (org_id, student_id);
CREATE INDEX IF NOT EXISTS learning_progress_records_teacher ON app.progress_records (org_id, teacher_id);

-- ---- exports ------------------------------------------------------------------------------------
-- filters->>'kind' identifies the export type ('progress_records'); file_expires_at bounds retention of the
-- generated file (personal data) — the learning job deletes the object afterwards.
ALTER TABLE app.export_jobs
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS row_count int,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS filename text,
  ADD COLUMN IF NOT EXISTS file_expires_at timestamptz,
  -- Generation lease: the file is rendered and stored outside DB transactions; the lease keeps two workers from
  -- generating the same job and lets an interrupted generation be retried once it expires.
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;
CREATE INDEX IF NOT EXISTS learning_export_jobs_state ON app.export_jobs (org_id, state, created_at);

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
COMMIT;
