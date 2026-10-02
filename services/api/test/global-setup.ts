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
