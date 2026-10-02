import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, type Caller } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { seedOrg } from "../helpers/fixtures";
import { SAMPLE } from "../helpers/learning-fakes";
import { buildProgram, enrollStudent, linkClassroomProgram, type BuiltProgram } from "../helpers/learning-fixtures";
import { learningWorld, type LearningWorld } from "../helpers/learning-setup";
import { RequestDb } from "../../src/db/client";
import { pollScans } from "../../src/jobs/learning";

let w: LearningWorld;
let pub: BuiltProgram;
let draft: BuiltProgram;

beforeAll(async () => {
  w = await learningWorld();
  pub = await buildProgram(
    w.ctx.admin,
    w.org.orgId,
    [
      {
        title: "IT基礎・セキュリティ",
        passScore: 80,
        materials: [{ kind: "pdf" }, { kind: "link" }, { kind: "quiz", questions: [{ correct: ["b"] }, { correct: ["a", "c"] }] }],
      },
      { title: "実践課題", requiresReview: true, materials: [{ kind: "assignment" }] },
    ],
    { uploaderId: w.org.admin.userId, policy: { max_quiz_attempts: 2, quiz_score_policy: "highest" } },
  );
  await enrollStudent(w.ctx.admin, w.org.orgId, w.org.student.userId, pub.versionId);
  await enrollStudent(w.ctx.admin, w.org.orgId, w.org.otherStudent.userId, pub.versionId);
  draft = await buildProgram(w.ctx.admin, w.org.orgId, [{ title: "下書き単元", materials: [{ kind: "pdf" }, { kind: "quiz", questions: [] }] }], {
    state: "draft",
    uploaderId: w.org.admin.userId,
  });
  await linkClassroomProgram(w.ctx.admin, w.org.orgId, w.org.classroomId, draft.versionId);
});
afterAll(async () => w.ctx.close());

const m = (b: BuiltProgram, unit: number, idx: number) => b.units[unit]!.materials[idx]!.id;

async function uploadFile(caller: Caller, type: string, name: string, bytes: Uint8Array, purpose = "material") {
  const res = await call(w.ctx, caller, "POST", "/uploads", { body: { filename: name, content_type: type, size_bytes: bytes.length, purpose } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  w.storage.clientPut(res.body.data.object_key, bytes, type);
  const done = await call(w.ctx, caller, "POST", `/uploads/${res.body.data.id}/complete`);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return res.body.data.object_key as string;
}

describe("material editing (draft versions)", () => {
  it("creates file/link/quiz/assignment materials with Japanese validation", async () => {
    const unit = draft.units[0]!.id;
    const key = await uploadFile(w.admin, "application/pdf", "マナー.pdf", SAMPLE.pdf());
    const pdf = await call(w.ctx, w.admin, "POST", `/units/${unit}/materials`, { body: { title: "ビジネスマナー資料", kind: "pdf", required: true, object_key: key, description: "第1章" } });
    expect(pdf.status).toBe(200);
    expectContract(pdf, "post", "/units/{id}/materials");
    expect(pdf.body.data).toMatchObject({ kind: "pdf", scan_state: "clean", published: false, filename: "マナー.pdf", content_type: "application/pdf", external_url: null });
    expect(JSON.stringify(pdf.body)).not.toContain("materials/");

    const png = await uploadFile(w.admin, "image/png", "fig.png", SAMPLE.png());
    const mismatch = await call(w.ctx, w.admin, "POST", `/units/${unit}/materials`, { body: { title: "x", kind: "pdf", required: true, object_key: png } });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.field_errors.object_key).toContain("一致しません");
    const noFile = await call(w.ctx, w.admin, "POST", `/units/${unit}/materials`, { body: { title: "x", kind: "video", required: true } });
    expect(noFile.body.field_errors.object_key).toBe("ファイルをアップロードしてください。");
    const http = await call(w.ctx, w.admin, "POST", `/units/${unit}/materials`, { body: { title: "x", kind: "link", required: true, external_url: "http://example.com" } });
    expect(http.status).toBe(422);
    expect(http.body.field_errors.external_url).toContain("https://");
    const linkNoUrl = await call(w.ctx, w.admin, "POST", `/units/${unit}/materials`, { body: { title: "x", kind: "link", required: true } });
    expect(linkNoUrl.body.field_errors.external_url).toBe("リンク教材にはURLが必要です。");
    const quizFile = await call(w.ctx, w.admin, "POST", `/units/${unit}/materials`, { body: { title: "x", kind: "quiz", required: true, object_key: key } });
    expect(quizFile.body.field_errors.object_key).toContain("添付できません");
    const link = await call(w.ctx, w.admin, "POST", `/units/${unit}/materials`, { body: { title: "社内ポータル", kind: "link", required: false, external_url: "https://portal.example.com/a" } });
    expect(link.body.data).toMatchObject({ external_url: "https://portal.example.com/a", scan_state: "not_applicable" });
    expect((await call(w.ctx, null, "POST", `/units/${unit}/materials`, { body: { title: "x", kind: "assignment", required: true } })).status).toBe(401);
  });

  it("lets only admins and teachers of a classroom using the program edit materials", async () => {
    const unit = draft.units[0]!.id;
    const byTeacher = await call(w.ctx, w.teacher, "POST", `/units/${unit}/materials`, { body: { title: "講師の課題", kind: "assignment", required: true } });
    expect(byTeacher.status).toBe(200);
    const other = await call(w.ctx, w.otherTeacher, "POST", `/units/${unit}/materials`, { body: { title: "x", kind: "assignment", required: true } });
    expect(other.status).toBe(403);
    expectContract(other, "post", "/units/{id}/materials");
    expect((await call(w.ctx, w.student, "POST", `/units/${unit}/materials`, { body: { title: "x", kind: "assignment", required: true } })).status).toBe(403);
    // Teachers cannot attach someone else's upload.
    const adminFile = await uploadFile(w.admin, "application/pdf", "admin.pdf", SAMPLE.pdf());
    const borrowed = await call(w.ctx, w.teacher, "POST", `/units/${unit}/materials`, { body: { title: "x", kind: "pdf", required: true, object_key: adminFile } });
    expect(borrowed.status).toBe(422);

    const id = byTeacher.body.data.id;
    const patched = await call(w.ctx, w.teacher, "PATCH", `/materials/${id}`, { body: { title: "講師の課題（改）", kind: "assignment", required: false, description: "提出物" }, ifMatch: 1 });
    expect(patched.status).toBe(200);
    expectContract(patched, "patch", "/materials/{id}");
    expect(patched.body.data).toMatchObject({ title: "講師の課題（改）", required: false, description: "提出物", row_version: 2 });
    const kind = await call(w.ctx, w.teacher, "PATCH", `/materials/${id}`, { body: { title: "x", kind: "quiz", required: true }, ifMatch: 2 });
    expect(kind.body.field_errors.kind).toContain("変更できません");
    const stale = await call(w.ctx, w.teacher, "PATCH", `/materials/${id}`, { body: { title: "x", kind: "assignment", required: true }, ifMatch: 1 });
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    expect((await call(w.ctx, w.otherTeacher, "PATCH", `/materials/${id}`, { body: { title: "x", kind: "assignment", required: true }, ifMatch: 2 })).status).toBe(403);
  });

  it("defines quizzes (answers only for staff) and checks material publishability", async () => {
    const quiz = m(draft, 0, 1);
    const empty = await call(w.ctx, w.admin, "POST", `/materials/${quiz}/publish`);
    expect(empty.status).toBe(409);
    expect(empty.body.code).toBe("MATERIAL_NOT_PUBLISHABLE");
    expect(empty.body.details.problems[0].message_ja).toContain("問題が登録されていません");
    expectContract(empty, "post", "/materials/{id}/publish");

    const invalid = await call(w.ctx, w.teacher, "PUT", `/materials/${quiz}/quiz-definition`, {
      body: { title: "確認テスト", questions: [{ prompt: "Q", choices: [{ id: "a", label: "A" }], correct_option_ids: ["z"], points: 0 }] },
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.field_errors).toMatchObject({ "questions.0.choices": "2件以上指定してください。", "questions.0.points": "0より大きい値を入力してください。" });
    const def = await call(w.ctx, w.teacher, "PUT", `/materials/${quiz}/quiz-definition`, {
      body: {
        title: "セキュリティ確認テスト",
        questions: [
          { prompt: "不審なメールを受信した場合は？", choices: [{ id: "a", label: "添付ファイルを開く" }, { id: "b", label: "担当部署に報告する" }], correct_option_ids: ["b"], points: 10 },
          { prompt: "パスワードの扱いは？", choices: [{ id: "a", label: "共有しない" }, { id: "b", label: "付箋に書く" }], correct_option_ids: ["a"], points: 10 },
        ],
      },
    });
    expect(def.status).toBe(200);
    expectContract(def, "put", "/materials/{id}/quiz-definition");
    expect(JSON.stringify(def.body)).not.toMatch(/correct|answer_key/);
    expect(def.body.data).toMatchObject({ title: "セキュリティ確認テスト", total_points: 20 });
    const foreign = await call(w.ctx, w.otherTeacher, "PUT", `/materials/${quiz}/quiz-definition`, {
      body: { title: "x", questions: [{ prompt: "Q", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correct_option_ids: ["a"], points: 1 }] },
    });
    expect(foreign.status).toBe(403);

    const full = await call(w.ctx, w.teacher, "GET", `/materials/${quiz}/quiz-definition`);
    expect(full.status).toBe(200);
    expectContract(full, "get", "/materials/{id}/quiz-definition");
    expect(full.body.data.questions.map((q: { correct_option_ids: string[] }) => q.correct_option_ids)).toEqual([["b"], ["a"]]);
    expect(full.body.data.editable).toBe(true);
    expect((await call(w.ctx, w.student, "GET", `/materials/${quiz}/quiz-definition`)).status).toBe(403);
    const notQuiz = await call(w.ctx, w.admin, "GET", `/materials/${m(draft, 0, 0)}/quiz-definition`);
    expect(notQuiz.body.code).toBe("MATERIAL_KIND_MISMATCH");

    const ok = await call(w.ctx, w.admin, "POST", `/materials/${quiz}/publish`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.material).toMatchObject({ published: true, question_count: 2 });
  });
});

describe("material privacy for students", () => {
  it("lists only published materials of an enrolled version, with the learner's own status", async () => {
    const unit = pub.units[0]!.id;
    const res = await call(w.ctx, w.student, "GET", `/units/${unit}/materials`);
    expect(res.status).toBe(200);
    expectContract(res, "get", "/units/{id}/materials");
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items[0].learner_status).toEqual({
      confirmed_at: null,
      quiz_attempts_used: null,
      quiz_score: null,
      quiz_passed: null,
      submission_state: null,
      feedback: null,
    });
    expect((await call(w.ctx, w.student2, "GET", `/units/${unit}/materials`)).status).toBe(404);
    expect((await call(w.ctx, w.student, "GET", `/units/${draft.units[0]!.id}/materials`)).status).toBe(404);
    const staff = await call(w.ctx, w.otherTeacher, "GET", `/units/${draft.units[0]!.id}/materials`);
    expect(staff.status).toBe(200);
    expect(staff.body.items[0].learner_status).toBeUndefined();
  });

  it("issues 5-minute download URLs only after authorisation", async () => {
    const pdf = m(pub, 0, 0);
    const res = await call(w.ctx, w.student, "GET", `/materials/${pdf}/download`);
    expect(res.status).toBe(200);
    expectContract(res, "get", "/materials/{id}/download");
    expect(res.body.data.content_type).toBe("application/pdf");
    const signed = w.storage.presigned.at(-1)!;
    expect(signed).toMatchObject({ method: "GET", expiresSeconds: 300, disposition: "inline" });
    expect(new Date(res.body.data.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(300_000);

    const notEnrolled = await call(w.ctx, w.student2, "GET", `/materials/${pdf}/download`);
    expect(notEnrolled.status).toBe(404);
    expectContract(notEnrolled, "get", "/materials/{id}/download");
    expect((await call(w.ctx, w.student, "GET", `/materials/${m(draft, 0, 0)}/download`)).status).toBe(404);
    expect((await call(w.ctx, w.teacher, "GET", `/materials/${m(draft, 0, 0)}/download`)).status).toBe(200);
    expect((await call(w.ctx, null, "GET", `/materials/${pdf}/download`)).status).toBe(401);
    const link = await call(w.ctx, w.student, "GET", `/materials/${m(pub, 0, 1)}/download`);
    expect(link.body.data.url).toBe("https://example.com/guide");
    expect((await call(w.ctx, w.student, "GET", `/materials/${m(pub, 0, 2)}/download`)).body.code).toBe("MATERIAL_KIND_MISMATCH");

    const other = await seedOrg(w.ctx.admin);
    const foreign = await buildProgram(w.ctx.admin, other.orgId, [{ materials: [{ kind: "pdf" }] }], { uploaderId: other.admin.userId });
    expect((await call(w.ctx, w.admin, "GET", `/materials/${foreign.units[0]!.materials[0]!.id}/download`)).status).toBe(404);
  });

  it("never serves unpublished, unscanned or blocked files", async () => {
    // A published version containing an unpublished material (e.g. data repaired by hand) must stay hidden.
    const b = await buildProgram(w.ctx.admin, w.org.orgId, [{ materials: [{ kind: "pdf" }, { kind: "assignment" }] }], { state: "draft", uploaderId: w.org.admin.userId });
    await w.ctx.admin.query("UPDATE app.materials SET published = true WHERE id = $1", [b.units[0]!.materials[1]!.id]);
    await w.ctx.admin.query("UPDATE app.materials SET scan_state = 'blocked', object_key = NULL WHERE id = $1", [b.units[0]!.materials[0]!.id]);
    await w.ctx.admin.query("UPDATE app.program_versions SET state = 'published', published_at = now() WHERE id = $1", [b.versionId]);
    await enrollStudent(w.ctx.admin, w.org.orgId, w.org.student.userId, b.versionId);
    const blocked = b.units[0]!.materials[0]!.id;
    expect((await call(w.ctx, w.student, "GET", `/materials/${blocked}/download`)).status).toBe(404);
    expect((await call(w.ctx, w.student, "GET", `/materials/${blocked}`)).status).toBe(404);
    const list = await call(w.ctx, w.student, "GET", `/units/${b.units[0]!.id}/materials`);
    expect(list.body.items.map((x: { id: string }) => x.id)).toEqual([b.units[0]!.materials[1]!.id]);
    const admin = await call(w.ctx, w.admin, "GET", `/materials/${blocked}/download`);
    expect(admin.status).toBe(422);
    expect(admin.body.code).toBe("FILE_REJECTED");

    w.scanner.mode = "async";
    const pendingKey = await uploadFile(w.admin, "application/pdf", "pending.pdf", SAMPLE.pdf());
    w.scanner.mode = "sync";
    const pending = await call(w.ctx, w.admin, "POST", `/units/${draft.units[0]!.id}/materials`, { body: { title: "検査待ち", kind: "pdf", required: true, object_key: pendingKey } });
    expect(pending.body.data.scan_state).toBe("pending");
    const dl = await call(w.ctx, w.admin, "GET", `/materials/${pending.body.data.id}/download`);
    expect(dl.status).toBe(409);
    expect(dl.body.code).toBe("SCAN_PENDING");
    const publish = await call(w.ctx, w.admin, "POST", `/materials/${pending.body.data.id}/publish`);
    expect(publish.body.code).toBe("SCAN_PENDING");
    // The verdict arrives later (polling) and propagates to the draft material.
    const ref = (await w.ctx.admin.query("SELECT scan_reference FROM app.upload_jobs WHERE quarantine_key = $1", [pendingKey])).rows[0].scan_reference;
    w.scanner.finish(ref);
    const db = new RequestDb(w.ctx.deps.connections);
    try {
      await pollScans(w.ctx.deps, db, w.org.orgId);
    } finally {
      await db.close();
    }
    const after = await call(w.ctx, w.admin, "GET", `/materials/${pending.body.data.id}`);
    expect(after.body.data.scan_state).toBe("clean");
    expect((await call(w.ctx, w.admin, "GET", `/materials/${pending.body.data.id}/download`)).status).toBe(200);
    expectContract(after, "get", "/materials/{id}");
  });
});

describe("confirmation and quizzes (students)", () => {
  it("records material confirmation once and only for viewable kinds", async () => {
    const pdf = m(pub, 0, 0);
    const res = await call(w.ctx, w.student, "POST", `/materials/${pdf}/receipt`);
    expect(res.status).toBe(200);
    expectContract(res, "post", "/materials/{id}/receipt");
    expect(res.body.data).toMatchObject({ material_id: pdf, unit_state: "in_progress" });
    const again = await call(w.ctx, w.student, "POST", `/materials/${pdf}/receipt`);
    expect(again.body.data.confirmed_at).toBe(res.body.data.confirmed_at);
    expect((await call(w.ctx, w.student, "POST", `/materials/${m(pub, 0, 2)}/receipt`)).body.code).toBe("MATERIAL_KIND_MISMATCH");
    expect((await call(w.ctx, w.teacher, "POST", `/materials/${pdf}/receipt`)).status).toBe(403);
    expect((await call(w.ctx, w.student2, "POST", `/materials/${pdf}/receipt`)).status).toBe(404);
    expect((await call(w.ctx, w.student, "POST", `/materials/${pdf}/receipt`, { idempotencyKey: false })).body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("returns quiz questions without answers and scores attempts on the server within the attempt limit", async () => {
    const quiz = m(pub, 0, 2);
    const view = await call(w.ctx, w.student, "GET", `/materials/${quiz}/quiz`);
    expect(view.status).toBe(200);
    expectContract(view, "get", "/materials/{id}/quiz");
    expect(view.body.data).toMatchObject({ attempts_used: 0, attempts_remaining: 2, pass_score: 80, max_attempts: 2, score_policy: "highest", passed: false, effective_score: null });
    expect(JSON.stringify(view.body)).not.toMatch(/answer|correct/);
    expect((await call(w.ctx, w.teacher, "GET", `/materials/${quiz}/quiz`)).status).toBe(403);
    expect((await call(w.ctx, w.student2, "GET", `/materials/${quiz}/quiz`)).status).toBe(404);

    const [q1, q2] = pub.units[0]!.materials[2]!.questionIds;
    const bad = await call(w.ctx, w.student, "POST", `/materials/${quiz}/quiz-attempts`, {
      body: { answers: [{ question_id: crypto.randomUUID(), selected_option_ids: ["a"] }, { question_id: q1, selected_option_ids: ["zz"] }] },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.field_errors["answers.0.question_id"]).toBe("このテストの問題ではありません。");
    expect(bad.body.field_errors["answers.1.selected_option_ids"]).toBe("選択肢から選んでください。");

    // q2 needs both a and c: a partial selection is wrong.
    const first = await call(w.ctx, w.student, "POST", `/materials/${quiz}/quiz-attempts`, {
      body: { answers: [{ question_id: q1, selected_option_ids: ["b"] }, { question_id: q2, selected_option_ids: ["a"] }] },
    });
    expect(first.status).toBe(200);
    expectContract(first, "post", "/materials/{id}/quiz-attempts");
    expect(first.body.data).toMatchObject({ score: 50, passed: false, attempts_used: 1, attempts_remaining: 1, correct_count: 1, question_count: 2, pass_score: 80 });
    expect(JSON.stringify(first.body)).not.toMatch(/answer_key|correct_option/);

    const key = crypto.randomUUID();
    const body = { answers: [{ question_id: q1, selected_option_ids: ["b"] }, { question_id: q2, selected_option_ids: ["c", "a"] }] };
    const second = await call(w.ctx, w.student, "POST", `/materials/${quiz}/quiz-attempts`, { body, idempotencyKey: key });
    expect(second.body.data).toMatchObject({ score: 100, passed: true, attempts_remaining: 0, effective_score: 100 });
    const replay = await call(w.ctx, w.student, "POST", `/materials/${quiz}/quiz-attempts`, { body, idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(second.body.data.id);
    const conflict = await call(w.ctx, w.student, "POST", `/materials/${quiz}/quiz-attempts`, { body: { answers: [] }, idempotencyKey: key });
    expect(conflict.body.code).toBe("IDEMPOTENCY_CONFLICT");
    const third = await call(w.ctx, w.student, "POST", `/materials/${quiz}/quiz-attempts`, { body });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe("QUIZ_ATTEMPTS_EXCEEDED");
    expect(third.body.message_ja).toBe("受験回数の上限に達しました。");
    const count = await w.ctx.admin.query("SELECT count(*)::int AS n FROM app.quiz_attempts WHERE material_id = $1 AND student_id = $2", [quiz, w.org.student.userId]);
    expect(count.rows[0].n).toBe(2);
    const after = await call(w.ctx, w.student, "GET", `/materials/${quiz}/quiz`);
    expect(after.body.data).toMatchObject({ attempts_used: 2, attempts_remaining: 0, effective_score: 100, passed: true });
  });

  it("serialises concurrent attempts so the limit can never be exceeded", async () => {
    const quiz = m(pub, 0, 2);
    const [q1, q2] = pub.units[0]!.materials[2]!.questionIds;
    const body = { answers: [{ question_id: q1, selected_option_ids: ["b"] }, { question_id: q2, selected_option_ids: ["a", "c"] }] };
    const results = await Promise.all(Array.from({ length: 6 }, () => call(w.ctx, w.otherStudent, "POST", `/materials/${quiz}/quiz-attempts`, { body })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.body?.code === "QUIZ_ATTEMPTS_EXCEEDED")).toHaveLength(4);
  });
});

describe("assignments and teacher review", () => {
  let submissionId: string;

  it("accepts a submission and blocks resubmission while awaiting review", async () => {
    const assignment = m(pub, 1, 0);
    const empty = await call(w.ctx, w.student, "POST", `/materials/${assignment}/submissions`, { body: { body: "   " } });
    expect(empty.status).toBe(422);
    expect(empty.body.field_errors.body).toContain("ファイルを添付");
    const res = await call(w.ctx, w.student, "POST", `/materials/${assignment}/submissions`, { body: { body: "顧客訪問の報告書です。" } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/materials/{id}/submissions");
    expect(res.body.data).toMatchObject({ state: "submitted", scan_state: "not_applicable", has_file: false, unit_title: "実践課題", student_name: "和田 一夫" });
    submissionId = res.body.data.id;
    const ob = await w.ctx.admin.query("SELECT payload FROM app.outbox WHERE entity_id = $1 AND event_type = 'submission.created'", [submissionId]);
    expect(ob.rows[0].payload.teacher_id).toBe(w.org.teacher.userId);
    const dup = await call(w.ctx, w.student, "POST", `/materials/${assignment}/submissions`, { body: { body: "再提出" } });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("SUBMISSION_AWAITING_REVIEW");
    expect((await call(w.ctx, w.teacher, "POST", `/materials/${assignment}/submissions`, { body: { body: "x" } })).status).toBe(403);
    expect((await call(w.ctx, w.student, "POST", `/materials/${m(pub, 0, 0)}/submissions`, { body: { body: "x" } })).body.code).toBe("MATERIAL_KIND_MISMATCH");
    const progress = await call(w.ctx, w.student, "GET", `/students/${w.org.student.userId}/progress`);
    expect(progress.body.units.find((u: { title: string }) => u.title === "実践課題").state).toBe("review_pending");
  });

  it("shows the review queue to the student's teachers only", async () => {
    const mine = await call(w.ctx, w.teacher, "GET", "/submissions?state=submitted");
    expect(mine.status).toBe(200);
    expectContract(mine, "get", "/submissions");
    expect(mine.body.items.map((s: { id: string }) => s.id)).toContain(submissionId);
    const other = await call(w.ctx, w.otherTeacher, "GET", "/submissions");
    expect(other.body.items.map((s: { id: string }) => s.id)).not.toContain(submissionId);
    const byClass = await call(w.ctx, w.admin, "GET", `/submissions?classroom_id=${w.org.otherClassroomId}`);
    expect(byClass.body.items.map((s: { id: string }) => s.id)).not.toContain(submissionId);
    expect((await call(w.ctx, w.student, "GET", "/submissions")).status).toBe(403);
    expect((await call(w.ctx, null, "GET", "/submissions")).status).toBe(401);
  });

  it("reviews with feedback; other teachers get 403; stale versions conflict", async () => {
    const other = await call(w.ctx, w.otherTeacher, "POST", `/submissions/${submissionId}/review`, { body: { state: "accepted", feedback: "" } });
    expect(other.status).toBe(403);
    expectContract(other, "post", "/submissions/{id}/review");
    const noFeedback = await call(w.ctx, w.teacher, "POST", `/submissions/${submissionId}/review`, { body: { state: "revision_requested", feedback: "" } });
    expect(noFeedback.status).toBe(422);
    expect(noFeedback.body.field_errors.feedback).toContain("理由");
    const stale = await call(w.ctx, w.teacher, "POST", `/submissions/${submissionId}/review`, { body: { state: "revision_requested", feedback: "具体例を追加", expected_version: 5 } });
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const res = await call(w.ctx, w.teacher, "POST", `/submissions/${submissionId}/review`, { body: { state: "revision_requested", feedback: "具体例を追加してください。", expected_version: 1 } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/submissions/{id}/review");
    expect(res.body.data).toMatchObject({ state: "revision_requested", feedback: "具体例を追加してください。", row_version: 2 });
    expect(res.body.data.reviewer_name).toBe("田中 祥司");
    const twice = await call(w.ctx, w.teacher, "POST", `/submissions/${submissionId}/review`, { body: { state: "accepted", feedback: "" } });
    expect(twice.body.code).toBe("INVALID_STATE");
    const ob = await w.ctx.admin.query("SELECT payload FROM app.outbox WHERE entity_id = $1 AND event_type = 'submission.reviewed'", [submissionId]);
    expect(ob.rows[0].payload).toMatchObject({ student_id: w.org.student.userId, state: "revision_requested" });
  });

  it("resubmits with a scanned file; acceptance waits for the scan, then completes the unit", async () => {
    const assignment = m(pub, 1, 0);
    // Another student's upload can never be attached.
    const theirs = await uploadFile(w.otherStudent, "image/png", "x.png", SAMPLE.png(), "assignment");
    const steal = await call(w.ctx, w.student, "POST", `/materials/${assignment}/submissions`, { body: { body: "x", object_key: theirs } });
    expect(steal.status).toBe(422);
    expect(steal.body.field_errors.object_key).toBeTruthy();
    w.scanner.mode = "async";
    const key = await uploadFile(w.student, "application/pdf", "報告書.pdf", SAMPLE.pdf(), "assignment");
    w.scanner.mode = "sync";
    const res = await call(w.ctx, w.student, "POST", `/materials/${assignment}/submissions`, { body: { body: "修正版です。", object_key: key } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ has_file: true, scan_state: "pending", filename: "報告書.pdf" });
    const id = res.body.data.id;
    const early = await call(w.ctx, w.teacher, "POST", `/submissions/${id}/review`, { body: { state: "accepted", feedback: "" } });
    expect(early.body.code).toBe("SCAN_PENDING");
    expect((await call(w.ctx, w.teacher, "GET", `/submissions/${id}/file`)).body.code).toBe("SCAN_PENDING");

    const ref = (await w.ctx.admin.query("SELECT scan_reference FROM app.upload_jobs WHERE quarantine_key = $1", [key])).rows[0].scan_reference;
    w.scanner.finish(ref);
    const db = new RequestDb(w.ctx.deps.connections);
    try {
      await pollScans(w.ctx.deps, db, w.org.orgId);
    } finally {
      await db.close();
    }
    const file = await call(w.ctx, w.teacher, "GET", `/submissions/${id}/file`);
    expect(file.status).toBe(200);
    expectContract(file, "get", "/submissions/{id}/file");
    expect(w.storage.presigned.at(-1)).toMatchObject({ disposition: "attachment", expiresSeconds: 300 });
    expect((await call(w.ctx, w.student, "GET", `/submissions/${id}/file`)).status).toBe(200);
    expect((await call(w.ctx, w.otherStudent, "GET", `/submissions/${id}/file`)).status).toBe(404);
    expect((await call(w.ctx, w.otherTeacher, "GET", `/submissions/${id}/file`)).status).toBe(403);

    const accepted = await call(w.ctx, w.admin, "POST", `/submissions/${id}/review`, { body: { state: "accepted", feedback: "よくできています。" } });
    expect(accepted.status).toBe(200);
    const progress = await call(w.ctx, w.student, "GET", `/students/${w.org.student.userId}/progress`);
    const unit = progress.body.units.find((u: { title: string }) => u.title === "実践課題");
    expect(unit).toMatchObject({ state: "completed", submission_state: "accepted", feedback: "よくできています。" });
    const done = await call(w.ctx, w.student, "POST", `/materials/${assignment}/submissions`, { body: { body: "x" } });
    expect(done.body.code).toBe("SUBMISSION_ALREADY_ACCEPTED");
  });
});
