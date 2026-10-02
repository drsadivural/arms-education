// Applies db/NNN_*.sql in order with checksum bookkeeping, then (optionally) runtime-role grants.
// Usage: DATABASE_ADMIN_URL=postgres://... RUNTIME_DB_ROLE=arms_app node scripts/db/migrate.mjs
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dbDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "db");

export async function migrate(client, { runtimeRole, log = () => {} } = {}) {
  await client.query(
    "CREATE TABLE IF NOT EXISTS public.arms_schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Map((await client.query("SELECT version, checksum FROM public.arms_schema_migrations")).rows.map((r) => [r.version, r.checksum]));
  const files = readdirSync(dbDir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  for (const file of files) {
    const sql = readFileSync(join(dbDir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) throw new Error(`Applied migration ${file} was modified (checksum mismatch). Add a new migration instead.`);
      continue;
    }
    log(`applying ${file}`);
    await client.query(sql);
    await client.query("INSERT INTO public.arms_schema_migrations(version, checksum) VALUES ($1, $2)", [file, checksum]);
  }
  if (runtimeRole) {
    await client.query("SELECT set_config('arms.runtime_role', $1, false)", [runtimeRole]);
    await client.query(readFileSync(join(dbDir, "grants.sql"), "utf8"));
    log(`granted runtime privileges to ${runtimeRole}`);
  }
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error("DATABASE_ADMIN_URL is required");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(client, { runtimeRole: process.env.RUNTIME_DB_ROLE, log: (m) => console.info(m) });
    console.info("migrations complete");
  } finally {
    await client.end();
  }
}
