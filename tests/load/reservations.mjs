// Load / concurrency check against a running stack (wrangler dev or staging) — docs/01 非機能目標:
//   * 100 concurrent requests for the last seat → exactly 1 success, 0 over-booking
//   * API read p95 ≤ 500 ms, reservation mutation p95 ≤ 1 s (same region, notifications not awaited)
// Creates an isolated organisation with N students in Supabase Auth (GoTrue admin API) and the DB owner connection.
//
// Usage (local): node tests/load/reservations.mjs [students=100]
// Env: API_BASE (default http://127.0.0.1:8787/api/v1), DATABASE_ADMIN_URL, AUTH_URL, AUTH_ADMIN_SECRET (defaults from services/api/.dev.vars)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const devVars = (() => {
  try {
    return Object.fromEntries(
      readFileSync(join(root, "services/api/.dev.vars"), "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  } catch {
    return {};
  }
})();
const API = process.env.API_BASE ?? "http://127.0.0.1:8787/api/v1";
const AUTH = process.env.AUTH_URL ?? devVars.SUPABASE_AUTH_URL ?? "http://localhost:9999";
const ADMIN_SECRET = process.env.AUTH_ADMIN_SECRET ?? devVars.SUPABASE_ADMIN_SECRET;
const DB = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:arms_dev_pw@127.0.0.1:55433/arms";
const N = Number(process.argv[2] ?? 100);
const stamp = Date.now().toString(36);
const password = `Load-${stamp}-Pass!`;

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function createAuthUser(email) {
  const res = await fetch(`${AUTH}/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_SECRET}`, apikey: ADMIN_SECRET },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`auth user: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body.id;
}

async function token(email) {
  const res = await fetch(`${AUTH}/token?grant_type=password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`token: ${res.status}`);
  return body.access_token;
}

async function timed(fn) {
  const t = performance.now();
  const res = await fn();
  return { ms: performance.now() - t, res };
}

const db = new pg.Client({ connectionString: DB });
await db.connect();
console.info(`seeding ${N} students…`);
const org = (await db.query("INSERT INTO app.organizations(name) VALUES ($1) RETURNING id", [`負荷試験 ${stamp}`])).rows[0].id;
const teacherEmail = `load-teacher-${stamp}@arms.local`;
const teacherId = await createAuthUser(teacherEmail);
await db.query("INSERT INTO app.users(id, display_name, email) VALUES ($1, '負荷 講師', $2)", [teacherId, teacherEmail]);
await db.query("INSERT INTO app.memberships(org_id, id, role) VALUES ($1, $2, 'teacher')", [org, teacherId]);
await db.query("INSERT INTO app.teacher_profiles(org_id, id, teacher_number) VALUES ($1, $2, 'LT1')", [org, teacherId]);
const classroom = (await db.query("INSERT INTO app.classrooms(org_id, name, capacity, starts_on, ends_on) VALUES ($1, '負荷クラス', $2, current_date, current_date + 90) RETURNING id", [org, N + 10])).rows[0].id;
await db.query("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary) VALUES ($1, $2, $3, true)", [org, classroom, teacherId]);
const students = [];
for (let i = 0; i < N; i++) {
  const email = `load-s${i}-${stamp}@arms.local`;
  const id = await createAuthUser(email);
  await db.query("INSERT INTO app.users(id, display_name, email) VALUES ($1, $2, $3)", [id, `負荷 受講者${i}`, email]);
  await db.query("INSERT INTO app.memberships(org_id, id, role) VALUES ($1, $2, 'student')", [org, id]);
  await db.query(
    "INSERT INTO app.student_profiles(org_id, id, employee_number, department_name, joined_on, classroom_id, teacher_id, training_starts_on, training_due_on) VALUES ($1, $2, $3, '開発部', current_date, $4, $5, current_date, current_date + 90)",
    [org, id, `LE${i}`, classroom, teacherId],
  );
  students.push({ id, email });
}
const lastSeat = (
  await db.query(
    "INSERT INTO app.lesson_slots(org_id, classroom_id, teacher_id, title, starts_at, ends_at, capacity, booking_closes_at, state) VALUES ($1, $2, $3, '残席1の授業', now() + interval '3 days', now() + interval '3 days 90 minutes', 1, now() + interval '2 days', 'open') RETURNING id",
    [org, classroom, teacherId],
  )
).rows[0].id;
const roomy = (
  await db.query(
    "INSERT INTO app.lesson_slots(org_id, classroom_id, teacher_id, title, starts_at, ends_at, capacity, booking_closes_at, state) VALUES ($1, $2, $3, '大教室の授業', now() + interval '5 days', now() + interval '5 days 60 minutes', $4, now() + interval '4 days', 'open') RETURNING id",
    [org, classroom, teacherId, N],
  )
).rows[0].id;

const tokens = await Promise.all(students.map((s) => token(s.email)));
const teacherToken = await token(teacherEmail);
const call = (tok, method, path, body, key) =>
  fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// 1) Last seat: N concurrent different students.
const lastSeatResults = await Promise.all(tokens.map((t) => timed(() => call(t, "POST", "/reservations", { slot_id: lastSeat }, crypto.randomUUID()))));
const created = lastSeatResults.filter((r) => r.res.status === 201).length;
const full = lastSeatResults.filter((r) => r.res.body?.code === "SLOT_FULL").length;
const active = (await db.query("SELECT count(*)::int AS n FROM app.reservations WHERE org_id = $1 AND slot_id = $2 AND status IN ('pending','approved')", [org, lastSeat])).rows[0].n;

// 2) Concurrent reads (100 users list available slots).
const reads = await Promise.all(tokens.map((t) => timed(() => call(t, "GET", "/lesson-slots"))));
// 3) Concurrent reservation mutations with plenty of seats.
const writes = await Promise.all(tokens.map((t) => timed(() => call(t, "POST", "/reservations", { slot_id: roomy }, crypto.randomUUID()))));
// 4) Teacher approvals (sequential decisions on N pending requests, measured individually).
const pending = (await call(teacherToken, "GET", `/reservations?status=pending&limit=100`)).body?.items ?? [];
const approvals = [];
for (const r of pending.slice(0, 30)) approvals.push(await timed(() => call(teacherToken, "POST", `/reservations/${r.id}/approve`, { expected_version: r.row_version }, crypto.randomUUID())));

const summary = {
  when: new Date().toISOString(),
  git_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  os: `${os.type()} ${os.release()} ${os.cpus().length} vCPU`,
  api: API,
  students: N,
  last_seat: { requests: N, created, slot_full: full, other: N - created - full, active_reservations_in_db: active, pass: created === 1 && active === 1 },
  read_lesson_slots_ms: { p50: pct(reads.map((r) => r.ms), 50), p95: pct(reads.map((r) => r.ms), 95), errors: reads.filter((r) => r.res.status !== 200).length },
  create_reservation_ms: { p50: pct(writes.map((r) => r.ms), 50), p95: pct(writes.map((r) => r.ms), 95), created: writes.filter((r) => r.res.status === 201).length },
  approve_ms: approvals.length ? { p50: pct(approvals.map((r) => r.ms), 50), p95: pct(approvals.map((r) => r.ms), 95), ok: approvals.filter((r) => r.res.status === 200).length } : null,
  note: "Local single-host run (wrangler dev/workerd + local PostgreSQL); not a substitute for a same-region staging measurement.",
};
mkdirSync(join(root, "tests/results"), { recursive: true });
writeFileSync(join(root, "tests/results", `load-reservations-${stamp}.json`), JSON.stringify(summary, null, 2));
console.info(JSON.stringify(summary, null, 2));
await db.end();
process.exit(summary.last_seat.pass ? 0 : 1);
