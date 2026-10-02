-- 050: legacy data migration (WEB-17 既存システムからのデータ移植, docs/08_MIGRATION_JA.md).
--
-- import_jobs   one CSV file (upload_jobs row, purpose=import) + column mapping for one entity
--               (teachers / classrooms / students / progress). uploaded → validated → committing → completed
--               (or failed, resumable) → rolled_back. Commit and rollback run in bounded batches; a lease
--               (lease_token + locked_until) serialises them, commit_key / rollback_key make retries idempotent.
-- import_items  one row per CSV record: planned action, before_data (current DB row incl. row_version when
--               updating), after_data (planned values), Japanese row errors/warnings, and after commit the
--               entity id + committed_version used by rollback to refuse rows edited after the import
--               (reverted_version = row_version left behind by a rollback that restored/stopped the record).
-- import_classroom_keys  verified mapping of a legacy クラス番号 to the ARMS classroom it created
--               (classrooms have no natural number column; teachers/students/progress use 講師番号 / 社員番号 /
--               source_record_id).
BEGIN;

ALTER TABLE app.import_jobs
  ADD COLUMN upload_id uuid NOT NULL,
  ADD COLUMN entity text NOT NULL,
  ADD COLUMN encoding text NOT NULL,
  ADD COLUMN filename text NOT NULL DEFAULT '',
  ADD COLUMN options jsonb,
  ADD COLUMN failure jsonb,
  ADD COLUMN lease_token uuid,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN commit_key uuid,
  ADD COLUMN commit_hash text,
  ADD COLUMN rollback_key uuid,
  ADD COLUMN rollback_hash text,
  ADD COLUMN validated_at timestamptz,
  ADD COLUMN committed_at timestamptz,
  ADD COLUMN committed_by uuid,
  ADD COLUMN rolled_back_at timestamptz,
  ADD COLUMN rolled_back_by uuid,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN row_version int NOT NULL DEFAULT 1,
  ADD CONSTRAINT import_jobs_upload_fk FOREIGN KEY (org_id, upload_id) REFERENCES app.upload_jobs (org_id, id),
  ADD CONSTRAINT import_jobs_committer_fk FOREIGN KEY (org_id, committed_by) REFERENCES app.memberships (org_id, id),
  ADD CONSTRAINT import_jobs_rollbacker_fk FOREIGN KEY (org_id, rolled_back_by) REFERENCES app.memberships (org_id, id),
  ADD CONSTRAINT import_jobs_entity CHECK (entity IN ('teachers', 'classrooms', 'students', 'progress')),
  ADD CONSTRAINT import_jobs_encoding CHECK (encoding IN ('utf-8', 'utf-8-bom', 'cp932')),
  ADD CONSTRAINT import_jobs_source_system CHECK (length(source_system) BETWEEN 1 AND 100),
  ADD CONSTRAINT import_jobs_lease CHECK ((lease_token IS NULL) = (locked_until IS NULL));
CREATE INDEX import_jobs_recent ON app.import_jobs (org_id, created_at DESC, id);

ALTER TABLE app.import_items
  ADD COLUMN action text NOT NULL,
  ADD COLUMN source_key text,
  ADD COLUMN source_values jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN errors jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN commit_state text,
  ADD COLUMN commit_message text,
  ADD COLUMN committed_at timestamptz,
  ADD COLUMN rollback_state text,
  ADD COLUMN rollback_message text,
  ADD COLUMN reverted_version int,
  ADD CONSTRAINT import_items_action CHECK (action IN ('create', 'update', 'skip', 'error')),
  ADD CONSTRAINT import_items_entity_kind CHECK (entity_kind IN ('teacher', 'classroom', 'student', 'progress_record')),
  ADD CONSTRAINT import_items_commit_state CHECK (commit_state IN ('applied', 'conflict')),
  ADD CONSTRAINT import_items_rollback_state CHECK (rollback_state IN ('reverted', 'manual')),
  ADD CONSTRAINT import_items_errors_shape CHECK (jsonb_typeof(errors) = 'array' AND jsonb_typeof(warnings) = 'array'),
  ADD CONSTRAINT import_items_error_action CHECK ((action = 'error') = (jsonb_array_length(errors) > 0)),
  ADD CONSTRAINT import_items_applied CHECK (commit_state IS NULL OR commit_state = 'conflict' OR (entity_id IS NOT NULL AND committed_version IS NOT NULL)),
  ADD CONSTRAINT import_items_rollback_after_commit CHECK (rollback_state IS NULL OR commit_state = 'applied');
-- Dry-run table filters and the commit/rollback work queues.
CREATE INDEX import_items_action_row ON app.import_items (org_id, job_id, action, row_number);
CREATE INDEX import_items_commit_queue ON app.import_items (org_id, job_id, row_number)
  WHERE action IN ('create', 'update') AND commit_state IS NULL;
CREATE INDEX import_items_rollback_queue ON app.import_items (org_id, job_id, row_number DESC)
  WHERE commit_state = 'applied' AND rollback_state IS NULL;

CREATE TABLE app.import_classroom_keys(
  org_id uuid NOT NULL REFERENCES app.organizations,
  source_system text NOT NULL,
  classroom_code text NOT NULL,
  classroom_id uuid NOT NULL,
  job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, source_system, classroom_code),
  FOREIGN KEY (org_id, classroom_id) REFERENCES app.classrooms (org_id, id),
  FOREIGN KEY (org_id, job_id) REFERENCES app.import_jobs (org_id, id),
  CHECK (length(classroom_code) BETWEEN 1 AND 50));
CREATE UNIQUE INDEX import_classroom_keys_classroom ON app.import_classroom_keys (org_id, source_system, classroom_id);

ALTER TABLE app.import_classroom_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.import_classroom_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.import_classroom_keys USING (org_id = app.org_id()) WITH CHECK (org_id = app.org_id());

REVOKE ALL ON app.import_classroom_keys FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
COMMIT;
