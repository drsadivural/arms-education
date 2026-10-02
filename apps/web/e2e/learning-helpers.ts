/**
 * E2E helpers for the learning screens (WEB-09〜12). Test data is created through the real API exactly as the apps
 * do it: admin/teacher calls with the signed-in Web session (Origin + CSRF + Idempotency-Key), students with the
 * Bearer token from POST /auth/tokens after setting their password from the invitation e-mail (iOS). No data is
 * written to the database directly.
 */
import { randomUUID } from "node:crypto";
import { expect, request as playwrightRequest, type APIRequestContext, type Page } from "@playwright/test";
import { WEB_ORIGIN, acceptInvitation, iosApi } from "./accounts";

export { WEB_ORIGIN };

export const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/** JST (UTC+9) calendar date `days` from today. */
export const jstDate = (days = 0) => new Date(Date.now() + 9 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
export const jstMonth = (deltaMonths = 0) => {
  const [y, m] = jstDate(0).split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + deltaMonths;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
};

interface WebCall {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  ifMatch?: number;
}

/** Calls /api/v1 with the page's session cookie, adding Origin, CSRF token and Idempotency-Key like the Web client. */
export async function webApi<T = unknown>(page: Page, call: WebCall): Promise<{ status: number; body: T }> {
  const session = await page.request.get(`${WEB_ORIGIN}/api/v1/auth/session`);
  expect(session.status(), "web session").toBe(200);
  const csrf = ((await session.json()) as { data: { csrf_token: string } }).data.csrf_token;
  const headers: Record<string, string> = { Origin: WEB_ORIGIN, "X-CSRF-Token": csrf, Accept: "application/json" };
  if (call.method === "POST" || call.method === "PUT") headers["Idempotency-Key"] = randomUUID();
  if (call.ifMatch !== undefined) headers["If-Match"] = `"${call.ifMatch}"`;
  const res = await page.request.fetch(`${WEB_ORIGIN}/api/v1${call.path}`, { method: call.method, headers, data: call.body });
  const text = await res.text();
  return { status: res.status(), body: (text ? JSON.parse(text) : null) as T };
}

async function ok<T>(page: Page, call: WebCall): Promise<T> {
  const res = await webApi<T>(page, call);
  expect(res.status, `${call.method} ${call.path}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
}

export interface StudentActor {
  id: string;
  name: string;
  email: string;
  api: APIRequestContext;
}

/** Registers a student (admin Web session) and, with `withLogin`, sets the password from the invitation e-mail and signs in like the iOS app. */
export async function createStudent(
  adminPage: Page,
  input: { classroomId: string; teacherId: string; name: string; department?: string; withLogin?: boolean },
): Promise<StudentActor> {
  const id = uniq();
  const email = `e2e-learner-${id}@arms.local`;
  const created = await ok<{ data: { id: string } }>(adminPage, {
    method: "POST",
    path: "/students",
    body: {
      employee_number: `L-${id}`,
      display_name: input.name,
      email,
      department_name: input.department ?? "開発部",
      joined_on: "2026-04-01",
      classroom_id: input.classroomId,
      teacher_id: input.teacherId,
      training_starts_on: "2026-04-01",
      training_due_on: "2026-12-31",
      active: true,
    },
  });
  const userId = created.data.id;
  let api: APIRequestContext;
  if (input.withLogin) {
    const password = `E2e-${id}-Learner!`;
    await acceptInvitation(email, password);
    api = await iosApi(email, password);
  } else {
    api = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  }
  return { id: userId, name: input.name, email, api };
}

export interface SeededProgram {
  programId: string;
  versionId: string;
  unitId: string;
  linkMaterialId: string;
  quizMaterialId: string;
  assignmentMaterialId?: string;
  name: string;
}

/**
 * A published program without file materials (no malware scanner runs locally, so files never become clean):
 * one required unit with a required https link and a required quiz (optionally a reviewed assignment).
 */
export async function seedPublishedProgram(page: Page, opts: { name?: string; withAssignment?: boolean; publish?: boolean } = {}): Promise<SeededProgram> {
  const name = opts.name ?? `E2E研修 ${uniq()}`;
  const program = await ok<{ data: { id: string } }>(page, { method: "POST", path: "/programs", body: { name, description: "E2Eで作成したプログラム", department_name: "開発部" } });
  const version = await ok<{ data: { id: string } }>(page, {
    method: "POST",
    path: `/programs/${program.data.id}/versions`,
    body: { policy: { max_quiz_attempts: 3, quiz_score_policy: "highest" } },
  });
  const unit = await ok<{ data: { id: string } }>(page, {
    method: "POST",
    path: `/program-versions/${version.data.id}/units`,
    body: { title: "ビジネスマナー", position: 1, required: true, weight: 20, pass_score: 80, required_attendance: false, requires_review: !!opts.withAssignment },
  });
  const link = await ok<{ data: { id: string } }>(page, {
    method: "POST",
    path: `/units/${unit.data.id}/materials`,
    body: { title: "社内規程（リンク）", kind: "link", required: true, external_url: "https://example.com/handbook", description: "" },
  });
  const quiz = await ok<{ data: { id: string } }>(page, { method: "POST", path: `/units/${unit.data.id}/materials`, body: { title: "マナー確認テスト", kind: "quiz", required: true, description: "" } });
  await ok(page, {
    method: "PUT",
    path: `/materials/${quiz.data.id}/quiz-definition`,
    body: {
      title: "マナー確認テスト",
      questions: [{ prompt: "来客時の最初の挨拶は？", choices: [{ id: "c1", label: "いらっしゃいませ" }, { id: "c2", label: "何もしない" }], correct_option_ids: ["c1"], points: 10 }],
    },
  });
  let assignmentId: string | undefined;
  if (opts.withAssignment) {
    const a = await ok<{ data: { id: string } }>(page, { method: "POST", path: `/units/${unit.data.id}/materials`, body: { title: "振り返りレポート", kind: "assignment", required: true, description: "学んだことを書いてください。" } });
    assignmentId = a.data.id;
  }
  if (opts.publish !== false) await ok(page, { method: "POST", path: `/program-versions/${version.data.id}/publish` });
  return { programId: program.data.id, versionId: version.data.id, unitId: unit.data.id, linkMaterialId: link.data.id, quizMaterialId: quiz.data.id, assignmentMaterialId: assignmentId, name };
}

export async function enroll(page: Page, studentId: string, versionId: string, dueOn: string): Promise<void> {
  await ok(page, { method: "POST", path: "/enrollments", body: { student_id: studentId, program_version_id: versionId, due_on: dueOn } });
}

export interface RecordSeed {
  id: string;
  row_version: number;
}

export async function createRecord(
  page: Page,
  input: { studentId: string; teacherId: string; department: string; dueDate: string; content: string; state?: string },
): Promise<RecordSeed> {
  const res = await ok<{ data: RecordSeed }>(page, {
    method: "POST",
    path: "/progress-records",
    body: { student_id: input.studentId, teacher_id: input.teacherId, department_name: input.department, due_date: input.dueDate, content: input.content, state: input.state ?? "in_progress" },
  });
  return res.data;
}

/**
 * Same WCAG A/AA axe checks as helpers.expectNoA11yViolations, failing with the offending selectors (used before
 * the shared assertion so a failure is actionable).
 */
export async function a11yDetails(page: Page): Promise<string[]> {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary?.replace(/\n/g, " ")}`).join(" | ")}`);
}

/** No horizontal page scroll at the current viewport (tables scroll inside their own container). */
export async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "page must not scroll horizontally").toBeLessThanOrEqual(0);
}
