// Creates an administrator account (and the organisation, if it does not exist yet) in a deployed ARMS database.
// No password is set here: the administrator opens the Web login, chooses 「パスワードをお忘れですか？」 and sets a
// password from the e-mailed one-time link (this also proves the address), then registers TOTP at the first sign-in.
//
//   DATABASE_ADMIN_URL=postgres://<migration role>@<host>/<db> node scripts/admin/create-admin.mjs \
//     --org "<organisation name>" --email admin@example.com --name "管理者 氏名"
//
// Requires migrations to be applied (scripts/db/migrate.mjs). Idempotent: an existing user/membership is reused.
import pg from "pg";
import { randomUUID } from "node:crypto";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, v, i, all) => (v.startsWith("--") ? [...acc, [v.slice(2), all[i + 1]]] : acc), []),
);
const url = process.env.DATABASE_ADMIN_URL;
if (!url || !args.org || !args.email || !args.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.email)) {
  console.error('usage: DATABASE_ADMIN_URL=… node scripts/admin/create-admin.mjs --org "<organisation>" --email <address> --name "<display name>"');
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  const org =
    (await client.query("SELECT id FROM app.organizations WHERE name = $1", [args.org])).rows[0]?.id ??
    (await client.query("INSERT INTO app.organizations(name) VALUES ($1) RETURNING id", [args.org])).rows[0].id;
  const existing = (await client.query("SELECT id FROM app.users WHERE lower(email) = lower($1)", [args.email])).rows[0]?.id;
  const userId = existing ?? randomUUID();
  if (!existing) await client.query("INSERT INTO app.users(id, display_name, email) VALUES ($1, $2, $3)", [userId, args.name, args.email]);
  await client.query(
    "INSERT INTO app.memberships(org_id, id, role, active) VALUES ($1, $2, 'admin', true) ON CONFLICT (org_id, id) DO UPDATE SET role = 'admin', active = true",
    [org, userId],
  );
  await client.query(
    `INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload) VALUES ($1, NULL, 'user.admin_bootstrapped', $2, '{"via":"scripts/admin/create-admin.mjs"}'::jsonb)`,
    [org, userId],
  );
  await client.query("COMMIT");
  console.info(`organisation ${args.org} (${org}) / administrator ${args.email} (${userId}) ready.`);
  console.info("Next: open the Web login → 「パスワードをお忘れですか？」 with this address, set a password from the e-mail, then register TOTP.");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
