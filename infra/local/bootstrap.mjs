// Local bootstrap: applies migrations, creates the runtime role, the first organisation and an administrator with a
// password (ARMS's own authentication in PostgreSQL). The administrator registers TOTP at the first Web sign-in.
// Usage: node infra/local/bootstrap.mjs admin@example.invalid 'password'
import pg from "pg";
import { migrate } from "../../scripts/db/migrate.mjs";
import { setPassword } from "../../scripts/auth/credentials.mjs";

const [email, password, orgName = "H&A研修センター"] = process.argv.slice(2);
if (!email || !password) {
  console.error("usage: node infra/local/bootstrap.mjs <admin-email> <password> [organisation name]");
  process.exit(1);
}
const adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:arms_dev_pw@127.0.0.1:55433/arms";
const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arms_app') THEN
  CREATE ROLE arms_app LOGIN PASSWORD 'arms_app_dev_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$`);
await migrate(client, { runtimeRole: "arms_app", log: (m) => console.info(m) });

const existing = await client.query("SELECT id FROM app.users WHERE lower(email) = lower($1)", [email]);
const userId = existing.rows[0]?.id ?? crypto.randomUUID();
const org = await client.query("SELECT id FROM app.organizations WHERE name = $1", [orgName]);
const orgId = org.rows[0]?.id ?? (await client.query("INSERT INTO app.organizations(name) VALUES ($1) RETURNING id", [orgName])).rows[0].id;
await client.query("INSERT INTO app.users(id, display_name, email) VALUES ($1, '管理者', $2) ON CONFLICT (id) DO NOTHING", [userId, email]);
await client.query("INSERT INTO app.memberships(org_id, id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING", [orgId, userId]);
await setPassword(client, userId, password);
await client.end();
console.info(`organisation ${orgName} (${orgId}) / administrator ${email} (${userId}) ready`);
