-- Runtime (API) role privileges. Re-run after every migration (scripts/db/migrate.mjs does this when
-- RUNTIME_DB_ROLE is set). The role itself must be NOSUPERUSER NOBYPASSRLS with no DDL rights:
--   CREATE ROLE arms_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
-- The role name is passed in the session setting arms.runtime_role.
DO $$
DECLARE r text := current_setting('arms.runtime_role');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'runtime role % must be NOSUPERUSER NOBYPASSRLS', r;
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA app TO %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO %I', r);
  -- Audit log is append-only for the API.
  EXECUTE format('REVOKE UPDATE, DELETE ON app.audit_events FROM %I', r);
  EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO %I', r);
  EXECUTE format('REVOKE CREATE ON SCHEMA app FROM %I', r);
END $$;
