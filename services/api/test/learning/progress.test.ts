import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerCaller, call, type Caller } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { createStudent, seedOrg } from "../helpers/fixtures";
import { buildProgram, enrollStudent, recordAttendance, type BuiltProgram } from "../helpers/learning-fixtures";
import { learningWorld, type LearningWorld } from "../helpers/learning-setup";
import { RequestDb } from "../../src/db/client";
import { progressPercent, recomputeStudentProgress } from "../../src/domain/progress";

let w: LearningWorld;

beforeAll(async () => {
  w = await learningWorld();
});
afterAll(async () => w.ctx.close());

interface Learner {
  id: string;
  caller: Caller;
}

async function newStudent(classroom: "mine" | "other" = "mine"): Promise<Learner> {
  const s = await createStudent(w.ctx.admin, w.org.orgId, {
    classroomId: classroom === "mine" ? w.org.classroomId : w.org.otherClassroomId,
    teacherId: classroom === "mine" ? w.org.teacher.userId : w.org.otherTeacher.userId,
  });
  return { id: s.userId, caller: await bearerCaller(s.userId, w.org.orgId) };
}

async function progressOf(l: Learner) {
  const res = await call(w.ctx, l.caller, "GET", `/students/${l.id}/progress`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const confirm = (l: Learner, materialId: string) => call(w.ctx, l.caller, "POST", `/materials/${materialId}/receipt`);
const mat = (b: BuiltProgram, u: number, i = 0) => b.units[u]!.materials[i]!.id;

async function recompute(studentId: string) {
  const db = new RequestDb(w.ctx.deps.connections);
  try {
    await db.tx({ orgId: w.org.orgId, userId: w.org.teacher.userId }, (tx) => recomputeStudentProgress(tx, w.org.orgId, studentId));
  } finally {
    await db.close();
  }
}

describe("progress formula", () => {
  it("rounds completed required weight / required weight × 100 (half up) and is null without a denominator", () => {
    expect(progressPercent(0, 0)).toBeNull();
    expect(progressPercent(100, 300)).toBe(33);
    expect(progressPercent(200, 300)).toBe(67);
    expect(progressPercent(125, 1000)).toBe(13);
    expect(progressPercent(1000, 1000)).toBe(100);
  });

  it("uses unit weights, excludes optional units and matches the DB view", async () => {
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [
      { title: "ビジネスマナー", weight: 10, materials: [{ kind: "link" }] },
      { title: "IT基礎", weight: 30, materials: [{ kind: "link" }] },
      { title: "実践", weight: 60, materials: [{ kind: "link" }] },
      { title: "任意: 業界研究", required: false, weight: 50, materials: [{ kind: "link" }] },
    ]);
    const s = await newStudent();
    const enrollment = await enrollStudent(w.ctx.admin, w.org.orgId, s.id, b.versionId);
    let p = await progressOf(s);
    expect(p).toMatchObject({ progress_percent: 0, required_total: 3, required_completed: 0 });
    expectContract({ status: 200, body: p }, "get", "/students/{id}/progress");

    await confirm(s, mat(b, 3)); // optional unit: not part of the denominator or numerator
    p = await progressOf(s);
    expect(p.progress_percent).toBe(0);
    expect(p.units.find((u: { title: string }) => u.title === "任意: 業界研究")).toMatchObject({ state: "completed", required: false });

    await confirm(s, mat(b, 0));
    await confirm(s, mat(b, 1));
    p = await progressOf(s);
    expect(p).toMatchObject({ progress_percent: 40, required_total: 3, required_completed: 2 });
    expect(p.enrollments[0]).toMatchObject({ progress_percent: 40, required_total: 3, required_completed: 2, overdue: false });
    const view = await w.ctx.admin.query("SELECT progress_percent FROM app.enrollment_progress WHERE enrollment_id = $1", [enrollment]);
    expect(Number(view.rows[0].progress_percent)).toBe(40);

    await confirm(s, mat(b, 2));
    expect((await progressOf(s)).progress_percent).toBe(100);
  });

  it("rounds fractional percentages", async () => {
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [
      { weight: 1, materials: [{ kind: "link" }] },
      { weight: 2, materials: [{ kind: "link" }] },
    ]);
    const s = await newStudent();
    await enrollStudent(w.ctx.admin, w.org.orgId, s.id, b.versionId);
    await confirm(s, mat(b, 0));
    expect((await progressOf(s)).progress_percent).toBe(33);
    await enrollStudent(w.ctx.admin, w.org.orgId, (await newStudent()).id, b.versionId);
    const t = await newStudent();
    await enrollStudent(w.ctx.admin, w.org.orgId, t.id, b.versionId);
    await confirm(t, mat(b, 1));
    expect((await progressOf(t)).progress_percent).toBe(67);
  });

  it("reports 「未設定」 (null) when no required units are assigned", async () => {
    const s = await newStudent();
    let p = await progressOf(s);
    expect(p).toMatchObject({ progress_percent: null, required_total: 0, required_completed: 0, units: [], enrollments: [] });
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [{ required: false, materials: [{ kind: "link" }] }]);
    await enrollStudent(w.ctx.admin, w.org.orgId, s.id, b.versionId);
    await confirm(s, mat(b, 0));
    p = await progressOf(s);
    expect(p).toMatchObject({ progress_percent: null, required_total: 0 });
    expect(p.enrollments[0].progress_percent).toBeNull();
  });
});

describe("unit completion conditions", () => {
  it("needs every required material confirmed; optional materials do not block", async () => {
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [{ materials: [{ kind: "pdf" }, { kind: "link" }, { kind: "link", required: false }] }], {
      uploaderId: w.org.admin.userId,
    });
    const s = await newStudent();
    await enrollStudent(w.ctx.admin, w.org.orgId, s.id, b.versionId);
    await confirm(s, mat(b, 0, 0));
    let unit = (await progressOf(s)).units[0];
    expect(unit).toMatchObject({ state: "in_progress", materials_total: 2, materials_confirmed: 1 });
    await confirm(s, mat(b, 0, 1));
    unit = (await progressOf(s)).units[0];
    expect(unit.state).toBe("completed");
    expect(unit.completed_at).toBeTruthy();
  });

  it("requires attendance (present/late) in a slot linked to the unit when required_attendance", async () => {
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [{ title: "研修振り返り", requiredAttendance: true, materials: [{ kind: "link" }] }]);
    const s = await newStudent();
    await enrollStudent(w.ctx.admin, w.org.orgId, s.id, b.versionId);
    await confirm(s, mat(b, 0));
    expect((await progressOf(s)).units[0]).toMatchObject({ state: "in_progress", attendance_required: true, attendance_satisfied: false });
    await recordAttendance(w.ctx.admin, w.org.orgId, { classroomId: w.org.classroomId, teacherId: w.org.teacher.userId, unitId: b.units[0]!.id, studentId: s.id, state: "absent" });
    await recompute(s.id);
    expect((await progressOf(s)).units[0].state).toBe("in_progress");
    await recordAttendance(w.ctx.admin, w.org.orgId, { classroomId: w.org.classroomId, teacherId: w.org.teacher.userId, unitId: b.units[0]!.id, studentId: s.id, state: "late" });
    await recompute(s.id);
    expect((await progressOf(s)).units[0]).toMatchObject({ state: "completed", attendance_satisfied: true });
    const history = await w.ctx.admin.query(
      "SELECT actor_id, payload FROM app.audit_events WHERE entity_id = $1 AND event_type = 'progress.unit_state_changed' ORDER BY created_at",
      [s.id],
    );
    expect(history.rows.map((r) => [r.payload.before, r.payload.after])).toEqual([
      ["not_started", "in_progress"],
      ["in_progress", "completed"],
    ]);
    expect(history.rows[1].actor_id).toBe(w.org.teacher.userId);
  });

  it("an attendance-only unit completes from attendance alone", async () => {
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [{ requiredAttendance: true, materials: [] }]);
    const s = await newStudent();
    await enrollStudent(w.ctx.admin, w.org.orgId, s.id, b.versionId);
    await recordAttendance(w.ctx.admin, w.org.orgId, { classroomId: w.org.classroomId, teacherId: w.org.teacher.userId, unitId: b.units[0]!.id, studentId: s.id, state: "present" });
    await recompute(s.id);
    expect((await progressOf(s)).progress_percent).toBe(100);
  });

  it("never completes a unit from a self-reported video view alone", async () => {
    // Built directly (publication would refuse this unit) to prove the runtime invariant.
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [{ materials: [{ kind: "video" }] }], { uploaderId: w.org.admin.userId });
    const s = await newStudent();
    await enrollStudent(w.ctx.admin, w.org.orgId, s.id, b.versionId);
    await confirm(s, mat(b, 0));
    expect((await progressOf(s)).units[0]).toMatchObject({ state: "in_progress", materials_confirmed: 1 });
    expect((await progressOf(s)).progress_percent).toBe(0);
  });

  it("treats a missing pass score as 100 (全問正解)", async () => {
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [{ passScore: null, materials: [{ kind: "quiz", questions: [{ correct: ["a"] }, { correct: ["b"] }] }] }]);
    const s = await newStudent();
    await enrollStudent(w.ctx.admin, w.org.orgId, s.id, b.versionId);
    const [q1, q2] = b.units[0]!.materials[0]!.questionIds;
    const half = await call(w.ctx, s.caller, "POST", `/materials/${mat(b, 0)}/quiz-attempts`, { body: { answers: [{ question_id: q1, selected_option_ids: ["a"] }] } });
    expect(half.body.data).toMatchObject({ score: 50, passed: false, pass_score: 100 });
    const full = await call(w.ctx, s.caller, "POST", `/materials/${mat(b, 0)}/quiz-attempts`, {
      body: { answers: [{ question_id: q1, selected_option_ids: ["a"] }, { question_id: q2, selected_option_ids: ["b"] }] },
    });
    expect(full.body.data.passed).toBe(true);
    expect((await progressOf(s)).units[0]).toMatchObject({ state: "completed", score: 100, quiz_passed: true });
  });

  it("applies the version's score policy: latest can revert completion, highest keeps it", async () => {
    const spec = [{ passScore: 80, materials: [{ kind: "quiz" as const, questions: [{ correct: ["a"] }] }] }];
    const latest = await buildProgram(w.ctx.admin, w.org.orgId, spec, { policy: { max_quiz_attempts: 5, quiz_score_policy: "latest" } });
    const highest = await buildProgram(w.ctx.admin, w.org.orgId, spec, { policy: { max_quiz_attempts: 5, quiz_score_policy: "highest" } });
    for (const [b, expected] of [
      [latest, "in_progress"],
      [highest, "completed"],
    ] as const) {
      const s = await newStudent();
      await enrollStudent(w.ctx.admin, w.org.orgId, s.id, b.versionId);
      const q = b.units[0]!.materials[0]!.questionIds[0]!;
      const quiz = mat(b, 0);
      await call(w.ctx, s.caller, "POST", `/materials/${quiz}/quiz-attempts`, { body: { answers: [{ question_id: q, selected_option_ids: ["a"] }] } });
      expect((await progressOf(s)).units[0].state).toBe("completed");
      const fail = await call(w.ctx, s.caller, "POST", `/materials/${quiz}/quiz-attempts`, { body: { answers: [{ question_id: q, selected_option_ids: ["b"] }] } });
      expect(fail.body.data.score).toBe(0);
      const unit = (await progressOf(s)).units[0];
      expect(unit.state).toBe(expected);
      expect(unit.score).toBe(expected === "completed" ? 100 : 0);
      expect(unit.completed_at === null).toBe(expected === "in_progress");
    }
  });
});

describe("version isolation", () => {
  it("keeps existing enrollments on their version when a new version is published", async () => {
    const v1 = await buildProgram(w.ctx.admin, w.org.orgId, [{ title: "IT基礎", weight: 10, materials: [{ kind: "link" }] }]);
    const a = await newStudent();
    await enrollStudent(w.ctx.admin, w.org.orgId, a.id, v1.versionId);
    await confirm(a, mat(v1, 0));
    expect((await progressOf(a)).progress_percent).toBe(100);

    const draft = await call(w.ctx, w.admin, "POST", `/programs/${v1.programId}/versions`, {
      body: { source_version_id: v1.versionId, policy: { max_quiz_attempts: 3, quiz_score_policy: "highest" } },
    });
    expect(draft.status).toBe(200);
    const v2 = draft.body.data.id;
    const added = await call(w.ctx, w.admin, "POST", `/program-versions/${v2}/units`, { body: { title: "追加単元", position: 1, required: true, weight: 90, required_attendance: true } });
    expect(added.status).toBe(200);
    expect((await call(w.ctx, w.admin, "POST", `/program-versions/${v2}/publish`)).status).toBe(200);

    const pa = await progressOf(a);
    expect(pa).toMatchObject({ progress_percent: 100, required_total: 1 });
    expect(pa.enrollments[0]).toMatchObject({ program_version_id: v1.versionId, version_number: 1 });
    // The archived version's materials stay available to students enrolled in it.
    expect((await call(w.ctx, a.caller, "GET", `/materials/${mat(v1, 0)}/download`)).status).toBe(200);

    const b = await newStudent();
    const enr = await call(w.ctx, w.admin, "POST", "/enrollments", { body: { student_id: b.id, program_version_id: v2, due_on: "2026-12-31" } });
    expect(enr.status).toBe(200);
    const pb = await progressOf(b);
    expect(pb).toMatchObject({ progress_percent: 0, required_total: 2 });
    // b cannot use v1 materials (not enrolled in v1); a cannot see v2.
    expect((await call(w.ctx, b.caller, "GET", `/materials/${mat(v1, 0)}/download`)).status).toBe(404);
    const v2Unit = pb.units[0].id;
    expect((await call(w.ctx, a.caller, "GET", `/units/${v2Unit}/materials`)).status).toBe(404);
    // Receipts on v1 materials do not count for v2 (different material ids).
    expect(pb.units[0].materials_confirmed).toBe(0);
    expect((await call(w.ctx, w.admin, "POST", "/enrollments", { body: { student_id: a.id, program_version_id: v2, due_on: "2026-12-31" } })).body.code).toBe("ENROLLMENT_EXISTS");
  });
});

describe("GET /students/{id}/progress authorisation", () => {
  it("allows the student, the student's teachers and admins only", async () => {
    const res = await call(w.ctx, w.student, "GET", `/students/${w.org.student.userId}/progress`);
    expect(res.status).toBe(200);
    expectContract(res, "get", "/students/{id}/progress");
    expect(res.body.student_name).toBe("和田 一夫");
    const peer = await call(w.ctx, w.student, "GET", `/students/${w.org.student2.userId}/progress`);
    expect(peer.status).toBe(403);
    expectContract(peer, "get", "/students/{id}/progress");
    expect((await call(w.ctx, w.teacher, "GET", `/students/${w.org.student.userId}/progress`)).status).toBe(200);
    const otherTeacher = await call(w.ctx, w.otherTeacher, "GET", `/students/${w.org.student.userId}/progress`);
    expect(otherTeacher.status).toBe(403);
    expect(otherTeacher.body.message_ja).toBe("この操作を行う権限がありません。");
    expect((await call(w.ctx, w.otherTeacher, "GET", `/students/${w.org.otherStudent.userId}/progress`)).status).toBe(200);
    expect((await call(w.ctx, w.admin, "GET", `/students/${w.org.otherStudent.userId}/progress`)).status).toBe(200);
    expect((await call(w.ctx, w.admin, "GET", `/students/${crypto.randomUUID()}/progress`)).status).toBe(404);
    expect((await call(w.ctx, w.student, "GET", `/students/${crypto.randomUUID()}/progress`)).status).toBe(403);
    expect((await call(w.ctx, null, "GET", `/students/${w.org.student.userId}/progress`)).status).toBe(401);
    const other = await seedOrg(w.ctx.admin);
    expect((await call(w.ctx, w.admin, "GET", `/students/${other.student.userId}/progress`)).status).toBe(404);
  });

  it("assistant teachers of the student's classroom are in scope", async () => {
    await w.ctx.admin.query("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary) VALUES ($1, $2, $3, false)", [
      w.org.orgId,
      w.org.otherClassroomId,
      w.org.teacher.userId,
    ]);
    expect((await call(w.ctx, w.teacher, "GET", `/students/${w.org.otherStudent.userId}/progress`)).status).toBe(200);
    await w.ctx.admin.query("DELETE FROM app.classroom_teachers WHERE classroom_id = $1 AND teacher_id = $2", [w.org.otherClassroomId, w.org.teacher.userId]);
  });

  it("derives overdue for enrollments from the organisation-local date", async () => {
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [{ materials: [{ kind: "link" }] }]);
    const s = await newStudent();
    await enrollStudent(w.ctx.admin, w.org.orgId, s.id, b.versionId, "2026-10-01");
    w.ctx.clock.now = new Date("2026-10-01T14:59:00Z"); // 23:59 JST on the due date
    expect((await progressOf(s)).enrollments[0].overdue).toBe(false);
    w.ctx.clock.now = new Date("2026-10-01T15:01:00Z"); // 00:01 JST the next day (still Oct 1 in UTC)
    expect((await progressOf(s)).enrollments[0].overdue).toBe(true);
    await confirm(s, mat(b, 0));
    expect((await progressOf(s)).enrollments[0].overdue).toBe(false);
    w.ctx.clock.now = null;
  });
});

describe("enrollments", () => {
  it("assigns a published version (admin only) and creates not_started unit progress", async () => {
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [{ materials: [{ kind: "link" }] }, { materials: [{ kind: "link" }] }]);
    const s = await newStudent();
    const res = await call(w.ctx, w.admin, "POST", "/enrollments", { body: { student_id: s.id, program_version_id: b.versionId, due_on: "2026-12-31" } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/enrollments");
    expect(res.body.data).toMatchObject({ student_id: s.id, program_version_id: b.versionId, due_on: "2026-12-31", version_number: 1 });
    const rows = await w.ctx.admin.query("SELECT state FROM app.unit_progress WHERE enrollment_id = $1", [res.body.data.id]);
    expect(rows.rows.map((r) => r.state)).toEqual(["not_started", "not_started"]);
    const dup = await call(w.ctx, w.admin, "POST", "/enrollments", { body: { student_id: s.id, program_version_id: b.versionId, due_on: "2026-12-31" } });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("ENROLLMENT_EXISTS");
    expect((await call(w.ctx, w.teacher, "POST", "/enrollments", { body: { student_id: s.id, program_version_id: b.versionId, due_on: "2026-12-31" } })).status).toBe(403);
    const bad = await call(w.ctx, w.admin, "POST", "/enrollments", { body: { student_id: "x", program_version_id: b.versionId, due_on: "2026-02-30" } });
    expect(bad.status).toBe(422);
    expect(bad.body.field_errors.due_on).toContain("日付");
    expect(bad.body.field_errors.student_id).toBe("選択肢から選んでください。");
    const unknown = await call(w.ctx, w.admin, "POST", "/enrollments", { body: { student_id: crypto.randomUUID(), program_version_id: b.versionId, due_on: "2026-12-31" } });
    expect(unknown.body.field_errors.student_id).toBeTruthy();

    const draft = await buildProgram(w.ctx.admin, w.org.orgId, [{ materials: [{ kind: "link" }] }], { state: "draft" });
    const notPublished = await call(w.ctx, w.admin, "POST", "/enrollments", { body: { student_id: s.id, program_version_id: draft.versionId, due_on: "2026-12-31" } });
    expect(notPublished.status).toBe(409);
    expect(notPublished.body.code).toBe("VERSION_NOT_PUBLISHED");
  });

  it("bulk-enrolls a classroom's active students explicitly (skipping existing enrollments)", async () => {
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [{ materials: [{ kind: "link" }] }]);
    await enrollStudent(w.ctx.admin, w.org.orgId, w.org.student.userId, b.versionId);
    const active = await w.ctx.admin.query("SELECT count(*)::int AS n FROM app.student_profiles WHERE classroom_id = $1 AND active", [w.org.classroomId]);
    const key = crypto.randomUUID();
    const res = await call(w.ctx, w.admin, "POST", `/classrooms/${w.org.classroomId}/enrollments`, { body: { program_version_id: b.versionId, due_on: "2026-12-31" }, idempotencyKey: key });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/classrooms/{id}/enrollments");
    expect(res.body.data).toMatchObject({ created: active.rows[0].n - 1, skipped: 1 });
    const replay = await call(w.ctx, w.admin, "POST", `/classrooms/${w.org.classroomId}/enrollments`, { body: { program_version_id: b.versionId, due_on: "2026-12-31" }, idempotencyKey: key });
    expect(replay.body.data).toEqual(res.body.data);
    const otherClass = await w.ctx.admin.query("SELECT count(*)::int AS n FROM app.enrollments e JOIN app.student_profiles sp ON sp.id = e.student_id WHERE sp.classroom_id = $1 AND e.program_version_id = $2", [
      w.org.otherClassroomId,
      b.versionId,
    ]);
    expect(otherClass.rows[0].n).toBe(0);
    expect((await call(w.ctx, w.admin, "POST", `/classrooms/${crypto.randomUUID()}/enrollments`, { body: { program_version_id: b.versionId, due_on: "2026-12-31" } })).status).toBe(404);
    expect((await call(w.ctx, w.teacher, "POST", `/classrooms/${w.org.classroomId}/enrollments`, { body: { program_version_id: b.versionId, due_on: "2026-12-31" } })).status).toBe(403);
  });
});
