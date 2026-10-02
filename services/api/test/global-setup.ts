/**
 * Creates a fresh PostgreSQL database per test run, applies db/ migrations as the owner, and grants the
 * runtime role (NOSUPERUSER NOBYPASSRLS) exactly like production. Tests talk to the API through that role.
 * Requires a reachable PostgreSQL (see infra/local/compose.yaml). TEST_DATABASE_ADMIN_URL overrides the default.
 */
import pg from "pg";
import type { TestProject } from "vitest/node";
// @ts-expect-error -- plain ESM script shared with the CLI migration runner
import { migrate } from "../../../scripts/db/migrate.mjs";

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres:arms_dev_pw@127.0.0.1:55433/postgres";
const RUNTIME_ROLE = "arms_app_test";
const RUNTIME_PASSWORD = "arms_app_test_pw";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    adminDatabaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const dbName = `arms_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
      CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    END IF; END $$`);
  await admin.end();

  const dbAdminUrl = withDatabase(ADMIN_URL, dbName);
  const client = new pg.Client({ connectionString: dbAdminUrl });
  await client.connect();
  await migrate(client, { runtimeRole: RUNTIME_ROLE });
  // Test-only fault injection (this throwaway database only): public.arms_test_arm_fault(email) makes the next
  // teacher/student profile insert for that e-mail fail once with SQLSTATE 57P01 (server shutdown → DB_UNAVAILABLE, not
  // retried by the transaction helper), like a database outage in the middle of the invitation saga. A per-email
  // sequence counts attempts because nextval() survives the rollback of the failing transaction.
  await client.query(`
    CREATE TABLE public.arms_test_faults(email text PRIMARY KEY, seq text NOT NULL);
    CREATE FUNCTION public.arms_test_arm_fault(target text) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE s text := 'arms_test_fault_' || md5(lower(target));
    BEGIN
      EXECUTE format('CREATE SEQUENCE public.%I', s);
      INSERT INTO public.arms_test_faults(email, seq) VALUES (lower(target), s);
    END $$;
    CREATE FUNCTION public.arms_test_fault_profile() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, public AS $$
    DECLARE s text; n bigint;
    BEGIN
      SELECT f.seq INTO s FROM public.arms_test_faults f JOIN app.users u ON lower(u.email) = f.email WHERE u.id = NEW.id;
      IF s IS NOT NULL THEN
        EXECUTE format('SELECT nextval(%L)', 'public.' || s) INTO n;
        IF n = 1 THEN RAISE EXCEPTION 'injected test fault' USING ERRCODE = '57P01'; END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER arms_test_fault BEFORE INSERT ON app.teacher_profiles FOR EACH ROW EXECUTE FUNCTION public.arms_test_fault_profile();
    CREATE TRIGGER arms_test_fault BEFORE INSERT ON app.student_profiles FOR EACH ROW EXECUTE FUNCTION public.arms_test_fault_profile();
  `);
  await client.end();

  const runtimeUrl = new URL(dbAdminUrl);
  runtimeUrl.username = RUNTIME_ROLE;
  runtimeUrl.password = RUNTIME_PASSWORD;
  project.provide("databaseUrl", runtimeUrl.toString());
  project.provide("adminDatabaseUrl", dbAdminUrl);

  return async () => {
    const c = new pg.Client({ connectionString: ADMIN_URL });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
  };
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
