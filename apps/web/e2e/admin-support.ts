/**
 * Helpers for the admin-area E2E specs (WEB-02〜08, WEB-16/18/19): API calls made from inside the signed-in page
 * (same-origin session cookie + CSRF token, like the app itself), unique names, and form helpers.
 */
import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import pg from "pg";
import { fixture } from "./helpers";

const DB = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:arms_dev_pw@127.0.0.1:55433/arms";

/** Short unique suffix for names/numbers created by a test. */
export const uniq = () => randomUUID().slice(0, 8);

/** Calls /api/v1 from the page (the page must already be on the app origin and signed in). Throws on non-2xx. */
export async function apiCall<T = unknown>(page: Page, method: string, path: string, body?: unknown, opts: { ifMatch?: number } = {}): Promise<T> {
  return page.evaluate(
    async ({ method, path, body, ifMatch, key }) => {
      const session = (await (await fetch("/api/v1/auth/session", { credentials: "same-origin" })).json()) as { data: { csrf_token: string } };
      const headers: Record<string, string> = { Accept: "application/json", "X-CSRF-Token": session.data.csrf_token };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (method === "POST" || method === "PUT") headers["Idempotency-Key"] = key;
      if (ifMatch !== undefined) headers["If-Match"] = `"${ifMatch}"`;
      const res = await fetch(`/api/v1${path}`, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
      return (text ? JSON.parse(text) : null) as never;
    },
    { method, path, body, ifMatch: opts.ifMatch, key: randomUUID() },
  );
}

export interface CreatedTeacher {
  id: string;
  display_name: string;
  teacher_number: string;
  row_version: number;
}

/** Registers a teacher through POST /teachers (invitation saga). */
export async function createTeacher(page: Page, name = `講師 ${uniq()}`): Promise<CreatedTeacher> {
  const n = uniq();
  const res = await apiCall<{ data: CreatedTeacher }>(page, "POST", "/teachers", {
    display_name: name,
    kana: "こうし",
    email: `e2e-t-${n}@example.invalid`,
    teacher_number: `T-${n}`,
    department_name: "開発部",
    specialties: [],
    active: true,
  });
  return res.data;
}

export interface CreatedClassroom {
  id: string;
  name: string;
  row_version: number;
}

export async function createClassroom(page: Page, primaryTeacherId: string, opts: { name?: string; capacity?: number } = {}): Promise<CreatedClassroom> {
  const res = await apiCall<{ data: CreatedClassroom }>(page, "POST", "/classrooms", {
    name: opts.name ?? `E2Eクラス ${uniq()}`,
    capacity: opts.capacity ?? 30,
    starts_on: "2026-10-01",
    ends_on: "2026-12-31",
    primary_teacher_id: primaryTeacherId,
    assistant_teacher_ids: [],
    program_version_ids: [],
  });
  return res.data;
}

export interface CreatedStudent {
  id: string;
  display_name: string;
  employee_number: string;
  row_version: number;
}

export async function createStudent(page: Page, classroomId: string, teacherId: string, opts: { name?: string; employeeNumber?: string } = {}): Promise<CreatedStudent> {
  const n = uniq();
  const res = await apiCall<{ data: CreatedStudent }>(page, "POST", "/students", {
    employee_number: opts.employeeNumber ?? `E-${n}`,
    display_name: opts.name ?? `受講者 ${n}`,
    kana: "じゅこうしゃ",
    email: `e2e-s-${n}@example.invalid`,
    company_name: "",
    department_name: "開発部",
    joined_on: "2026-10-01",
    classroom_id: classroomId,
    teacher_id: teacherId,
    training_starts_on: "2026-10-01",
    training_due_on: "2026-12-31",
    active: true,
  });
  return res.data;
}

/** Creates a program and publishes version 1 (one unit completed by attendance, so no files are needed). */
export async function createPublishedProgram(page: Page, name = `E2E研修 ${uniq()}`): Promise<{ programId: string; versionId: string; name: string }> {
  const program = await apiCall<{ data: { id: string } }>(page, "POST", "/programs", { name, description: "E2E", department_name: "" });
  const version = await apiCall<{ data: { id: string } }>(page, "POST", `/programs/${program.data.id}/versions`, { policy: { max_quiz_attempts: 3, quiz_score_policy: "highest" } });
  await apiCall(page, "POST", `/program-versions/${version.data.id}/units`, { title: "オリエンテーション", position: 0, required: true, weight: 1, required_attendance: true });
  await apiCall(page, "POST", `/program-versions/${version.data.id}/publish`);
  return { programId: program.data.id, versionId: version.data.id, name };
}

/** A failed notification delivery in the E2E organisation (no API creates one: it is the worker's result). */
export async function seedFailedDelivery(entityId: string): Promise<string> {
  const client = new pg.Client({ connectionString: DB });
  await client.connect();
  try {
    const row = await client.query<{ id: string }>(
      `INSERT INTO app.outbox(org_id, event_type, entity_id, payload, state, attempts) VALUES ($1, 'reservation.approved', $2, '{}'::jsonb, 'failed', 5) RETURNING id`,
      [fixture().orgId, entityId],
    );
    return row.rows[0]!.id;
  } finally {
    await client.end();
  }
}

/** Department control: a select when settings.departments is configured, otherwise free text. */
export async function setDepartment(field: Locator, value: string): Promise<void> {
  const tag = await field.evaluate((el) => el.tagName);
  if (tag === "SELECT") await field.selectOption(value);
  else await field.fill(value);
}

/** The page must not scroll horizontally (390 px layout). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Toasts render their title once in the toast and once in Radix's live region. */
export const toast = (page: Page, text: string | RegExp) => page.getByText(text).first();
