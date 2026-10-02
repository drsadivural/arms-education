/**
 * E2E helpers for the booking screens. Students use only the iOS app (Bearer tokens), so their reservations are
 * created through the real API: the student is registered with the admin Web session (POST /students with the
 * CSRF token), receives a password through the GoTrue admin API, signs in with the password grant and books
 * with `Authorization: Bearer` + Idempotency-Key — exactly what the app does.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, request as playwrightRequest, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const root = join(import.meta.dirname, "..", "..", "..");
const vars = Object.fromEntries(
  readFileSync(join(root, "services/api/.dev.vars"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;
const AUTH = vars.SUPABASE_AUTH_URL ?? "http://localhost:9999";
const ADMIN_SECRET = vars.SUPABASE_ADMIN_SECRET ?? "";

export const WEB_ORIGIN = `http://localhost:${process.env.ARMS_WEB_PORT ?? 5188}`;

/** A unique suffix per call so parallel/re-run data never collides. */
export const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** JST (UTC+9, no DST) date `days` from today as YYYY-MM-DD. */
export const jstDate = (days: number) => new Date(Date.now() + 9 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
/** ISO instant of a JST wall-clock date + HH:MM. */
export const jstInstant = (date: string, time: string) => new Date(`${date}T${time}:00+09:00`).toISOString();

interface WebCall {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  ifMatch?: number;
}

/**
 * Calls /api/v1 with the signed-in page's session cookie (admin/teacher), adding the Origin, CSRF token and
 * Idempotency-Key the Web client sends.
 */
export async function webApi<T = unknown>(page: Page, call: WebCall): Promise<{ status: number; body: T }> {
  const session = await page.request.get(`${WEB_ORIGIN}/api/v1/auth/session`);
  expect(session.status(), "web session").toBe(200);
  const csrf = ((await session.json()) as { data: { csrf_token: string } }).data.csrf_token;
  const headers: Record<string, string> = { Origin: WEB_ORIGIN, "X-CSRF-Token": csrf, Accept: "application/json" };
  if (call.method === "POST") headers["Idempotency-Key"] = randomUUID();
  if (call.ifMatch !== undefined) headers["If-Match"] = `"${call.ifMatch}"`;
  const res = await page.request.fetch(`${WEB_ORIGIN}/api/v1${call.path}`, { method: call.method, headers, data: call.body });
  const text = await res.text();
  return { status: res.status(), body: (text ? JSON.parse(text) : null) as T };
}

export interface SlotSeed {
  id: string;
  title: string;
  row_version: number;
  starts_at: string;
  ends_at: string;
}

/** Creates a lesson slot through POST /lesson-slots as the signed-in admin/teacher. */
export async function createSlot(
  page: Page,
  input: { classroomId: string; teacherId: string; title: string; date: string; start: string; end: string; capacity?: number; meetingUrl?: string },
): Promise<SlotSeed> {
  const startsAt = jstInstant(input.date, input.start);
  const res = await webApi<{ data: SlotSeed }>(page, {
    method: "POST",
    path: "/lesson-slots",
    body: {
      classroom_id: input.classroomId,
      teacher_id: input.teacherId,
      title: input.title,
      starts_at: startsAt,
      ends_at: jstInstant(input.date, input.end),
      capacity: input.capacity ?? 5,
      booking_closes_at: startsAt,
      ...(input.meetingUrl ? { meeting_url: input.meetingUrl } : {}),
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

export interface StudentActor {
  id: string;
  name: string;
  email: string;
  api: APIRequestContext;
}

/**
 * Registers a student in the classroom with the admin Web session, sets a password with the GoTrue admin API and
 * returns an API context authenticated like the iOS app (Bearer access token).
 */
export async function createStudent(adminPage: Page, input: { classroomId: string; teacherId: string; name: string }): Promise<StudentActor> {
  const id = uniq();
  const email = `e2e-student-${id}@arms.local`;
  const password = `E2e-${id}-Student!`;
  const created = await webApi<{ data: { id: string } }>(adminPage, {
    method: "POST",
    path: "/students",
    body: {
      employee_number: `S-${id}`,
      display_name: input.name,
      email,
      department_name: "開発部",
      joined_on: "2026-04-01",
      classroom_id: input.classroomId,
      teacher_id: input.teacherId,
      training_starts_on: "2026-04-01",
      training_due_on: "2027-03-31",
      active: true,
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const userId = created.body.data.id;

  const admin = { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_SECRET}`, apikey: ADMIN_SECRET };
  const pw = await fetch(`${AUTH}/admin/users/${userId}`, { method: "PUT", headers: admin, body: JSON.stringify({ password, email_confirm: true }) });
  expect(pw.status, "GoTrue admin password").toBe(200);
  const tokenRes = await fetch(`${AUTH}/token?grant_type=password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  expect(tokenRes.status, "GoTrue password grant").toBe(200);
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  // No cookies: the API rejects requests carrying both a session cookie and a Bearer token (AMBIGUOUS_AUTH).
  const api = await playwrightRequest.newContext({
    baseURL: WEB_ORIGIN,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Authorization: `Bearer ${access_token}`, Accept: "application/json" },
  });
  return { id: userId, name: input.name, email, api };
}

/** The student books a slot: POST /reservations with Bearer + Idempotency-Key (201 → pending). */
export async function requestReservation(student: StudentActor, slotId: string): Promise<{ id: string; status: string; row_version: number }> {
  const res = await student.api.post("/api/v1/reservations", { headers: { "Idempotency-Key": randomUUID() }, data: { slot_id: slotId } });
  const body = (await res.json()) as { id: string; status: string; row_version: number };
  expect(res.status(), JSON.stringify(body)).toBe(201);
  return body;
}

/** Same WCAG checks as helpers.expectNoA11yViolations, with the failing selectors and details in the message. */
export async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(" ")} — ${n.failureSummary?.replace(/\n/g, " ")}`).join("\n")}`,
  );
  expect(summary, summary.join("\n")).toEqual([]);
}
