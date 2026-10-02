// Local bootstrap: applies migrations, creates the runtime role, the first organisation and an administrator
// account in GoTrue (password login). Usage: node infra/local/bootstrap.mjs admin@example.invalid 'password'
import pg from "pg";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../../scripts/db/migrate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [email, password, orgName = "H&A研修センター"] = process.argv.slice(2);
if (!email || !password) {
  console.error("usage: node infra/local/bootstrap.mjs <admin-email> <password> [organisation name]");
  process.exit(1);
}
const vars = Object.fromEntries(
  readFileSync(join(here, "..", "..", "services", "api", ".dev.vars"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:arms_dev_pw@127.0.0.1:55433/arms";
const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arms_app') THEN
  CREATE ROLE arms_app LOGIN PASSWORD 'arms_app_dev_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$`);
await migrate(client, { runtimeRole: "arms_app", log: (m) => console.info(m) });

const res = await fetch(`${vars.SUPABASE_AUTH_URL}/admin/users`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${vars.SUPABASE_ADMIN_SECRET}`, apikey: vars.SUPABASE_ADMIN_SECRET },
  body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: "管理者" } }),
});
const body = await res.json();
if (!res.ok && !String(body.msg ?? body.message ?? "").match(/already/)) throw new Error(`GoTrue: ${res.status} ${JSON.stringify(body)}`);
let userId = body.id;
if (!userId) {
  const existing = await client.query("SELECT id FROM auth.users WHERE lower(email) = lower($1)", [email]);
  userId = existing.rows[0]?.id;
}
const org = await client.query("SELECT id FROM app.organizations WHERE name = $1", [orgName]);
const orgId = org.rows[0]?.id ?? (await client.query("INSERT INTO app.organizations(name) VALUES ($1) RETURNING id", [orgName])).rows[0].id;
await client.query("INSERT INTO app.users(id, display_name, email) VALUES ($1, '管理者', $2) ON CONFLICT (id) DO NOTHING", [userId, email]);
await client.query("INSERT INTO app.memberships(org_id, id, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING", [orgId, userId]);
await client.end();
console.info(`organisation ${orgName} (${orgId}) / administrator ${email} (${userId}) ready`);
