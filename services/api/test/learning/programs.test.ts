import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, cookieCaller, type TestContext } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { seedOrg } from "../helpers/fixtures";
import { buildProgram, enrollStudent, linkClassroomProgram } from "../helpers/learning-fixtures";
import { SAMPLE } from "../helpers/learning-fakes";
import { contextWith, learningWorld, type LearningWorld } from "../helpers/learning-setup";

let w: LearningWorld;
let noScanner: TestContext;

beforeAll(async () => {
  w = await learningWorld();
  noScanner = contextWith({ storage: w.storage, scanner: null });
});
afterAll(async () => {
  await w.ctx.close();
  await noScanner.close();
});

const POLICY = { max_quiz_attempts: 2, quiz_score_policy: "highest" as const };

async function createProgram(name = `新入社員 基礎研修 ${crypto.randomUUID().slice(0, 6)}`) {
  const res = await call(w.ctx, w.admin, "POST", "/programs", { body: { name, description: "入社後3か月の基礎研修", department_name: "全部署" } });
  expect(res.status).toBe(200);
  return res.body.data as { id: string; row_version: number };
}

async function createDraft(programId: string, extra: Record<string, unknown> = {}) {
  const res = await call(w.ctx, w.admin, "POST", `/programs/${programId}/versions`, { body: { policy: POLICY, ...extra } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { id: string; version_number: number; state: string };
}

async function addUnit(versionId: string, body: Record<string, unknown>) {
  return call(w.ctx, w.admin, "POST", `/program-versions/${versionId}/units`, { body });
}

describe("programs", () => {
  it("creates a program (admin) with DB-computed counts", async () => {
    const res = await call(w.ctx, w.admin, "POST", "/programs", { body: { name: "新入社員 基礎研修", description: "入社後3か月", department_name: "開発部" } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/programs");
    expect(res.body.data).toMatchObject({ name: "新入社員 基礎研修", archived: false, unit_count: 0, material_count: 0, student_count: 0, published_version_id: null, latest_version: null });
    expect(res.headers.get("etag")).toBe('"1"');
  });

  it("requires authentication, the admin role and valid input", async () => {
    expect((await call(w.ctx, null, "POST", "/programs", { body: { name: "x", description: "" } })).status).toBe(401);
    const teacher = await call(w.ctx, w.teacher, "POST", "/programs", { body: { name: "x", description: "" } });
    expect(teacher.status).toBe(403);
    expectContract(teacher, "post", "/programs");
    const bad = await call(w.ctx, w.admin, "POST", "/programs", { body: { name: "", description: 1 } });
    expect(bad.status).toBe(422);
    expect(bad.body.field_errors.name).toBe("必須項目です。");
    expect(bad.body.field_errors.description).toBeTruthy();
    expectContract(bad, "post", "/programs");
  });

  it("lists programs for admin and teachers (students forbidden) with counts, filters and cursor paging", async () => {
    const built = await buildProgram(w.ctx.admin, w.org.orgId, [{ materials: [{ kind: "link" }, { kind: "quiz" }] }, { materials: [{ kind: "assignment" }] }], {
      name: "あああ 一覧テスト研修",
    });
    await enrollStudent(w.ctx.admin, w.org.orgId, w.org.student.userId, built.versionId);
    await linkClassroomProgram(w.ctx.admin, w.org.orgId, w.org.classroomId, built.versionId);
    const res = await call(w.ctx, w.teacher, "GET", `/programs?q=${encodeURIComponent("一覧テスト")}`);
    expect(res.status).toBe(200);
    expectContract(res, "get", "/programs");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ unit_count: 2, material_count: 3, student_count: 1, published_version_id: built.versionId });
    const byClass = await call(w.ctx, w.admin, "GET", `/programs?classroom_id=${w.org.classroomId}`);
    expect(byClass.body.items.map((p: { id: string }) => p.id)).toContain(built.programId);
    const otherClass = await call(w.ctx, w.admin, "GET", `/programs?classroom_id=${w.org.otherClassroomId}`);
    expect(otherClass.body.items.map((p: { id: string }) => p.id)).not.toContain(built.programId);

    const first = await call(w.ctx, w.admin, "GET", "/programs?limit=1");
    expect(first.body.items).toHaveLength(1);
    expect(first.body.next_cursor).toBeTruthy();
    const second = await call(w.ctx, w.admin, "GET", `/programs?limit=1&cursor=${first.body.next_cursor}`);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    expect((await call(w.ctx, w.admin, "GET", "/programs?cursor=garbage")).status).toBe(400);
    expect((await call(w.ctx, w.admin, "GET", "/programs?status=bogus")).status).toBe(422);

    const student = await call(w.ctx, w.student, "GET", "/programs");
    expect(student.status).toBe(403);
    expect((await call(w.ctx, null, "GET", "/programs")).status).toBe(401);
  });

  it("hides other organisations' programs (404) and rejects malformed ids as 404", async () => {
    const other = await seedOrg(w.ctx.admin);
    const foreign = await buildProgram(w.ctx.admin, other.orgId, [{ materials: [{ kind: "link" }] }]);
    const res = await call(w.ctx, w.admin, "GET", `/programs/${foreign.programId}`);
    expect(res.status).toBe(404);
    expectContract(res, "get", "/programs/{id}");
    expect((await call(w.ctx, w.admin, "GET", "/programs/not-a-uuid")).status).toBe(404);
    const otherAdmin = await cookieCaller(w.ctx, { userId: other.admin.userId, orgId: other.orgId, role: "admin" });
    const list = await call(w.ctx, otherAdmin, "GET", "/programs?status=all&limit=100");
    const mine = await w.ctx.admin.query("SELECT id FROM app.programs WHERE org_id = $1", [w.org.orgId]);
    expect(mine.rows.length).toBeGreaterThan(0);
    const visible = new Set(list.body.items.map((p: { id: string }) => p.id));
    expect(mine.rows.some((r) => visible.has(r.id))).toBe(false);
    expect(visible.has(foreign.programId)).toBe(true);
  });

  it("edits with If-Match and archives (soft) — archived programs cannot change", async () => {
    const p = await createProgram();
    expect((await call(w.ctx, w.admin, "PATCH", `/programs/${p.id}`, { body: { name: "改名", description: "" } })).status).toBe(400);
    const stale = await call(w.ctx, w.admin, "PATCH", `/programs/${p.id}`, { body: { name: "改名", description: "" }, ifMatch: 9 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const ok = await call(w.ctx, w.admin, "PATCH", `/programs/${p.id}`, { body: { name: "改名後", description: "説明", department_name: "営業部" }, ifMatch: 1 });
    expect(ok.status).toBe(200);
    expectContract(ok, "patch", "/programs/{id}");
    expect(ok.body.data).toMatchObject({ name: "改名後", department_name: "営業部", row_version: 2 });
    expect((await call(w.ctx, w.teacher, "PATCH", `/programs/${p.id}`, { body: { name: "x", description: "" }, ifMatch: 2 })).status).toBe(403);

    const invalid = await call(w.ctx, w.admin, "PATCH", `/programs/${p.id}`, { body: { name: " ", description: "x".repeat(5001), extra: 1 }, ifMatch: 2 });
    expect(invalid.status).toBe(422);
    expect(invalid.body.field_errors).toMatchObject({ name: "必須項目です。", description: "5000文字以内で入力してください。" });
    expect(invalid.body.field_errors._).toContain("許可されていない項目");
    expect((await call(w.ctx, null, "GET", `/programs/${p.id}`)).status).toBe(401);
    expect((await call(w.ctx, w.student, "GET", `/programs/${p.id}`)).status).toBe(403);
    expect((await call(w.ctx, w.admin, "DELETE", `/programs/${p.id}`)).body.code).toBe("IF_MATCH_REQUIRED");
    expect((await call(w.ctx, w.teacher, "DELETE", `/programs/${p.id}`, { ifMatch: 2 })).status).toBe(403);
    const del = await call(w.ctx, w.admin, "DELETE", `/programs/${p.id}`, { ifMatch: 2 });
    expect(del.status).toBe(200);
    expectContract(del, "delete", "/programs/{id}");
    const again = await call(w.ctx, w.admin, "PATCH", `/programs/${p.id}`, { body: { name: "x", description: "" }, ifMatch: 3 });
    expect(again.body.code).toBe("PROGRAM_ARCHIVED");
    const version = await call(w.ctx, w.admin, "POST", `/programs/${p.id}/versions`, { body: { policy: POLICY } });
    expect(version.status).toBe(409);
    expect(version.body.code).toBe("PROGRAM_ARCHIVED");
    const archived = await call(w.ctx, w.admin, "GET", "/programs?status=archived");
    expect(archived.body.items.map((x: { id: string }) => x.id)).toContain(p.id);
    const audit = await w.ctx.admin.query("SELECT event_type FROM app.audit_events WHERE entity_id = $1 ORDER BY created_at", [p.id]);
    expect(audit.rows.map((r) => r.event_type)).toEqual(["program.created", "program.updated", "program.archived"]);
  });
});

describe("program versions and units", () => {
  it("creates a draft with a fixed policy; only one draft at a time", async () => {
    const p = await createProgram();
    const res = await call(w.ctx, w.admin, "POST", `/programs/${p.id}/versions`, { body: { policy: POLICY } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/programs/{id}/versions");
    expect(res.body.data).toMatchObject({ version_number: 1, state: "draft", policy: POLICY, unit_count: 0 });
    const dup = await call(w.ctx, w.admin, "POST", `/programs/${p.id}/versions`, { body: { policy: POLICY } });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("DRAFT_VERSION_EXISTS");
    const invalid = await call(w.ctx, w.admin, "POST", `/programs/${p.id}/versions`, { body: { policy: { max_quiz_attempts: 0, quiz_score_policy: "best" } } });
    expect(invalid.status).toBe(422);
    expect(Object.keys(invalid.body.field_errors)).toEqual(expect.arrayContaining(["policy.max_quiz_attempts", "policy.quiz_score_policy"]));
    const get = await call(w.ctx, w.teacher, "GET", `/program-versions/${res.body.data.id}`);
    expect(get.status).toBe(200);
    expectContract(get, "get", "/program-versions/{id}");
    expect((await call(w.ctx, w.student, "GET", `/program-versions/${res.body.data.id}`)).status).toBe(403);
    const list = await call(w.ctx, w.teacher, "GET", `/programs/${p.id}/versions`);
    expect(list.status).toBe(200);
    expectContract(list, "get", "/programs/{id}/versions");
    expect(list.body.items).toHaveLength(1);
    expect((await call(w.ctx, w.student, "GET", `/programs/${p.id}/versions`)).status).toBe(403);
    expect((await call(w.ctx, null, "GET", `/programs/${p.id}/versions`)).status).toBe(401);
    expect((await call(w.ctx, w.admin, "GET", `/programs/${crypto.randomUUID()}/versions`)).status).toBe(404);
    expect((await call(w.ctx, w.teacher, "POST", `/programs/${p.id}/versions`, { body: { policy: POLICY } })).status).toBe(403);
  });

  it("manages draft units: position uniqueness, If-Match, Japanese errors, read scope", async () => {
    const p = await createProgram();
    const v = await createDraft(p.id);
    const created = await addUnit(v.id, { title: "ビジネスマナー", position: 1, required: true, weight: 20, pass_score: 80 });
    expect(created.status).toBe(200);
    expectContract(created, "post", "/program-versions/{id}/units");
    const dup = await addUnit(v.id, { title: "IT基礎", position: 1, required: true, weight: 30 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("UNIT_POSITION_TAKEN");
    expect(dup.body.field_errors.position).toContain("順番");
    const bad = await addUnit(v.id, { title: "", position: -1, required: "yes", weight: 0 });
    expect(bad.status).toBe(422);
    expect(bad.body.field_errors).toMatchObject({ title: "必須項目です。", position: "0以上の値を入力してください。", weight: "0より大きい値を入力してください。" });
    expect((await addUnit(v.id, { title: "x", position: 5, required: true, weight: 1 })).status).toBe(200);
    expect((await call(w.ctx, w.teacher, "POST", `/program-versions/${v.id}/units`, { body: { title: "x", position: 9, required: true, weight: 1 } })).status).toBe(403);

    const unitId = created.body.data.id;
    const patched = await call(w.ctx, w.admin, "PATCH", `/units/${unitId}`, { body: { title: "ビジネスマナー基礎", position: 0, required: true, weight: 25 }, ifMatch: 1 });
    expect(patched.status).toBe(200);
    expectContract(patched, "patch", "/units/{id}");
    expect(patched.body.data).toMatchObject({ position: 0, weight: 25, pass_score: null, row_version: 2 });
    const stale = await call(w.ctx, w.admin, "PATCH", `/units/${unitId}`, { body: { title: "x", position: 0, required: true, weight: 1 }, ifMatch: 1 });
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    const clash = await call(w.ctx, w.admin, "PATCH", `/units/${unitId}`, { body: { title: "x", position: 5, required: true, weight: 1 }, ifMatch: 2 });
    expect(clash.body.code).toBe("UNIT_POSITION_TAKEN");

    const list = await call(w.ctx, w.teacher, "GET", `/program-versions/${v.id}/units`);
    expect(list.status).toBe(200);
    expectContract(list, "get", "/program-versions/{id}/units");
    expect(list.body.items.map((u: { position: number }) => u.position)).toEqual([0, 5]);
    const studentDraft = await call(w.ctx, w.student, "GET", `/program-versions/${v.id}/units`);
    expect(studentDraft.status).toBe(404);
  });

  it("refuses to publish versions that do not meet the publication rules", async () => {
    const p = await createProgram();
    const v = await createDraft(p.id);
    const empty = await call(w.ctx, w.admin, "POST", `/program-versions/${v.id}/publish`);
    expect(empty.status).toBe(409);
    expectContract(empty, "post", "/program-versions/{id}/publish");
    expect(empty.body.code).toBe("VERSION_NOT_PUBLISHABLE");
    expect(empty.body.details.problems[0].code).toBe("no_units");

    const u1 = (await addUnit(v.id, { title: "条件なし", position: 0, required: true, weight: 10 })).body.data.id;
    const u2 = (await addUnit(v.id, { title: "講師承認", position: 1, required: true, weight: 10, requires_review: true })).body.data.id;
    const u3 = (await addUnit(v.id, { title: "動画のみ", position: 2, required: true, weight: 10 })).body.data.id;
    const quiz = await call(w.ctx, w.admin, "POST", `/units/${u2}/materials`, { body: { title: "空のテスト", kind: "quiz", required: true } });
    expect(quiz.status).toBe(200);
    const video = await uploadMaterial("video/mp4", "intro.mp4", SAMPLE.mp4());
    expect((await call(w.ctx, w.admin, "POST", `/units/${u3}/materials`, { body: { title: "導入動画", kind: "video", required: true, object_key: video } })).status).toBe(200);
    const res = await call(w.ctx, w.admin, "POST", `/program-versions/${v.id}/publish`);
    expect(res.status).toBe(409);
    const codes = res.body.details.problems.map((x: { code: string }) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["unit_without_condition", "review_without_assignment", "video_self_report_only", "quiz_empty"]));
    expect(res.body.details.problems.find((x: { unit_id?: string }) => x.unit_id === u1).message_ja).toContain("完了条件");
    expect((await call(w.ctx, w.teacher, "POST", `/program-versions/${v.id}/publish`)).status).toBe(403);
  });

  it("blocks publication while a file is unscanned: SCAN_PENDING, or SCANNER_UNAVAILABLE without a scanner", async () => {
    const p = await createProgram();
    const v = await createDraft(p.id);
    const unit = (await addUnit(v.id, { title: "PDF確認", position: 0, required: true, weight: 10 })).body.data.id;
    w.scanner.mode = "async";
    const key = await uploadMaterial("application/pdf", "guide.pdf", SAMPLE.pdf());
    w.scanner.mode = "sync";
    expect((await call(w.ctx, w.admin, "POST", `/units/${unit}/materials`, { body: { title: "ガイド", kind: "pdf", required: true, object_key: key } })).status).toBe(200);
    const pending = await call(w.ctx, w.admin, "POST", `/program-versions/${v.id}/publish`);
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe("SCAN_PENDING");
    const unavailable = await call(noScanner, w.admin, "POST", `/program-versions/${v.id}/publish`);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.code).toBe("SCANNER_UNAVAILABLE");
    expect(unavailable.body.message_ja).toContain("公開を停止");
  });

  it("publishes a valid version, makes it immutable, archives the previous one and deep-copies into a new draft", async () => {
    const p = await createProgram();
    const v1 = await createDraft(p.id);
    const unit = (await addUnit(v1.id, { title: "IT基礎", position: 0, required: true, weight: 30, pass_score: 80 })).body.data.id;
    const pdfKey = await uploadMaterial("application/pdf", "security.pdf", SAMPLE.pdf());
    const pdf = await call(w.ctx, w.admin, "POST", `/units/${unit}/materials`, { body: { title: "情報セキュリティ基本ガイド", kind: "pdf", required: true, object_key: pdfKey } });
    expect(pdf.status).toBe(200);
    const quiz = (await call(w.ctx, w.admin, "POST", `/units/${unit}/materials`, { body: { title: "確認テスト", kind: "quiz", required: true } })).body.data.id;
    const def = await call(w.ctx, w.admin, "PUT", `/materials/${quiz}/quiz-definition`, {
      body: { title: "確認テスト", questions: [{ prompt: "不審なメールは？", choices: [{ id: "a", label: "開く" }, { id: "b", label: "報告する" }], correct_option_ids: ["b"], points: 10 }] },
    });
    expect(def.status).toBe(200);

    const published = await call(w.ctx, w.admin, "POST", `/program-versions/${v1.id}/publish`);
    expect(published.status).toBe(200);
    expectContract(published, "post", "/program-versions/{id}/publish");
    expect(published.body.data.version).toMatchObject({ state: "published", unit_count: 1, material_count: 2, required_weight_total: 30 });
    const mats = await call(w.ctx, w.admin, "GET", `/units/${unit}/materials`);
    expect(mats.body.items.every((m: { published: boolean }) => m.published)).toBe(true);
    const again = await call(w.ctx, w.admin, "POST", `/program-versions/${v1.id}/publish`);
    expect(again.body.code).toBe("PUBLISHED_VERSION_IMMUTABLE");

    // Published content is immutable (API pre-checks and DB guards).
    const patch = await call(w.ctx, w.admin, "PATCH", `/units/${unit}`, { body: { title: "x", position: 0, required: true, weight: 1 }, ifMatch: 1 });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe("PUBLISHED_VERSION_IMMUTABLE");
    expect((await addUnit(v1.id, { title: "追加", position: 3, required: true, weight: 1 })).body.code).toBe("PUBLISHED_VERSION_IMMUTABLE");
    expect((await call(w.ctx, w.admin, "POST", `/units/${unit}/materials`, { body: { title: "x", kind: "assignment", required: true } })).body.code).toBe(
      "PUBLISHED_VERSION_IMMUTABLE",
    );
    const redefine = await call(w.ctx, w.admin, "PUT", `/materials/${quiz}/quiz-definition`, {
      body: { title: "x", questions: [{ prompt: "?", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correct_option_ids: ["a"], points: 1 }] },
    });
    expect(redefine.body.code).toBe("PUBLISHED_VERSION_IMMUTABLE");
    await expect(w.ctx.admin.query("UPDATE app.units SET weight = 1 WHERE id = $1", [unit])).rejects.toThrow(/PUBLISHED_VERSION_IMMUTABLE/);
    await expect(w.ctx.admin.query("UPDATE app.program_versions SET policy = '{}' WHERE id = $1", [v1.id])).rejects.toThrow(/PUBLISHED_VERSION_IMMUTABLE/);

    // New draft copies units, materials (unpublished) and quiz questions with new ids.
    const v2 = await createDraft(p.id, { source_version_id: v1.id });
    expect(v2.version_number).toBe(2);
    const v2Units = await call(w.ctx, w.admin, "GET", `/program-versions/${v2.id}/units`);
    expect(v2Units.body.items).toHaveLength(1);
    const copiedUnit = v2Units.body.items[0];
    expect(copiedUnit.id).not.toBe(unit);
    expect(copiedUnit).toMatchObject({ title: "IT基礎", weight: 30, pass_score: 80 });
    const copied = await call(w.ctx, w.admin, "GET", `/units/${copiedUnit.id}/materials`);
    expect(copied.body.items.map((m: { kind: string; published: boolean; scan_state: string }) => [m.kind, m.published, m.scan_state])).toEqual([
      ["pdf", false, "clean"],
      ["quiz", false, "not_applicable"],
    ]);
    const copiedQuiz = copied.body.items.find((m: { kind: string }) => m.kind === "quiz");
    expect(copiedQuiz.question_count).toBe(1);
    const wrongSource = await call(w.ctx, w.admin, "POST", `/programs/${(await createProgram()).id}/versions`, { body: { policy: POLICY, source_version_id: v1.id } });
    expect(wrongSource.status).toBe(422);
    expect(wrongSource.body.field_errors.source_version_id).toBeTruthy();

    // Change the copy and publish it: v1 becomes archived, v2 published.
    const changed = await call(w.ctx, w.admin, "PATCH", `/units/${copiedUnit.id}`, { body: { title: "IT基礎（改訂）", position: 0, required: true, weight: 50, pass_score: 90 }, ifMatch: copiedUnit.row_version });
    expect(changed.status).toBe(200);
    const pub2 = await call(w.ctx, w.admin, "POST", `/program-versions/${v2.id}/publish`);
    expect(pub2.status).toBe(200);
    expect(pub2.body.data.archived_version_id).toBe(v1.id);
    const v1After = await call(w.ctx, w.admin, "GET", `/program-versions/${v1.id}`);
    expect(v1After.body.data.state).toBe("archived");
    const program = await call(w.ctx, w.admin, "GET", `/programs/${p.id}`);
    expect(program.body.data).toMatchObject({ published_version_id: v2.id, latest_version: { version_number: 2, state: "published" } });
    // The archived version's weights are untouched.
    const v1Units = await call(w.ctx, w.admin, "GET", `/program-versions/${v1.id}/units`);
    expect(v1Units.body.items[0]).toMatchObject({ title: "IT基礎", weight: 30 });
    // Students read the units of the version they are enrolled in (even after it was archived), and nothing else.
    const enrolled = await call(w.ctx, w.admin, "POST", "/enrollments", { body: { student_id: w.org.student2.userId, program_version_id: v2.id, due_on: "2026-12-31" } });
    expect(enrolled.status).toBe(200);
    const studentUnits = await call(w.ctx, w.student2, "GET", `/program-versions/${v2.id}/units`);
    expect(studentUnits.status).toBe(200);
    expect(studentUnits.body.items[0]).toMatchObject({ title: "IT基礎（改訂）", weight: 50, pass_score: 90 });
    expect((await call(w.ctx, w.student2, "GET", `/program-versions/${v1.id}/units`)).status).toBe(404);
    expect((await call(w.ctx, w.student, "GET", `/program-versions/${v2.id}/units`)).status).toBe(404);
  });
});

/** Uploads a material file through the API (presign → client PUT → complete) and returns its object key. */
async function uploadMaterial(contentType: string, filename: string, bytes: Uint8Array): Promise<string> {
  const res = await call(w.ctx, w.admin, "POST", "/uploads", { body: { filename, content_type: contentType, size_bytes: bytes.length, purpose: "material" } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  w.storage.clientPut(res.body.data.object_key, bytes, contentType);
  const done = await call(w.ctx, w.admin, "POST", `/uploads/${res.body.data.id}/complete`);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return res.body.data.object_key;
}
