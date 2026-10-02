import { describe, expect, it } from "vitest";
import { completionConditionLabel, currentMonth, dueDateLabel, fileSizeLabel, materialKindsSummary, monthShortLabel, resolveMonth, shiftMonth } from "../src/features/learning/format";
import { changeLines, eventLabel } from "../src/features/learning/progress/history";
import { totalLabel } from "../src/pages/progress/ProgressPage";
import { buildStudentHistory } from "../src/pages/progress/StudentProgressPage";
import { defaultVersion } from "../src/pages/programs/ProgramEditPage";
import type { AuditEvent, ProgramVersion, Submission, UnitProgress } from "../src/features/learning/api";

describe("learning month helpers (JST)", () => {
  it("derives the current month in Asia/Tokyo, not from the UTC date", () => {
    // 2026-09-30 15:30 UTC is already 2026-10-01 00:30 in Tokyo.
    expect(currentMonth(new Date("2026-09-30T15:30:00Z"))).toBe("2026-10");
    expect(currentMonth(new Date("2026-10-31T14:59:00Z"))).toBe("2026-10");
    expect(currentMonth(new Date("2026-10-31T15:00:00Z"))).toBe("2026-11");
  });

  it("uses the URL month only when it is a valid YYYY-MM", () => {
    const now = new Date("2026-10-02T03:00:00Z");
    expect(resolveMonth("2019-08", now)).toBe("2019-08");
    expect(resolveMonth("2019-13", now)).toBe("2026-10");
    expect(resolveMonth("abc", now)).toBe("2026-10");
    expect(resolveMonth(null, now)).toBe("2026-10");
  });

  it("moves by months and six-month windows across years", () => {
    expect(shiftMonth("2026-10", 1)).toBe("2026-11");
    expect(shiftMonth("2026-10", 6)).toBe("2027-04");
    expect(shiftMonth("2026-03", -6)).toBe("2025-09");
    expect(monthShortLabel("2026-10")).toBe("10月");
  });

  it("shows date-only due dates exactly as stored, with the year when it differs (legacy 2019 rows)", () => {
    expect(dueDateLabel("2026-10-05", 2026)).toBe("10月5日（月）");
    expect(dueDateLabel("2019-08-31", 2026)).toBe("2019年8月31日（土）");
    // No timezone shift at day boundaries.
    expect(dueDateLabel("2026-12-31", 2026)).toBe("12月31日（木）");
  });
});

describe("unit summaries (WEB-10)", () => {
  it("summarises material kinds and completion conditions in server terms", () => {
    const mats = [
      { kind: "pdf", required: true },
      { kind: "video", required: false },
      { kind: "quiz", required: true },
    ] as const;
    expect(materialKindsSummary([...mats])).toBe("PDF / 動画 / テスト");
    expect(completionConditionLabel({ pass_score: 80, required_attendance: false, requires_review: false }, [...mats])).toBe("確認 + 80点以上");
    expect(completionConditionLabel({ pass_score: null, required_attendance: false, requires_review: false }, [{ kind: "quiz", required: true }])).toBe("テスト全問正解");
    expect(completionConditionLabel({ pass_score: null, required_attendance: true, requires_review: true }, [{ kind: "assignment", required: true }])).toBe("課題の講師承認 + 出席");
    expect(completionConditionLabel({ pass_score: null, required_attendance: false, requires_review: false }, [{ kind: "pdf", required: false }])).toBe("条件未設定");
    expect(materialKindsSummary([])).toBe("教材なし");
  });

  it("formats file sizes", () => {
    expect(fileSizeLabel(512)).toBe("1 KB");
    expect(fileSizeLabel(20 * 1024 * 1024)).toBe("20.0 MB");
    expect(fileSizeLabel(null)).toBe("—");
  });

  it("opens the draft by default, then the published version, then the newest", () => {
    const v = (id: string, state: ProgramVersion["state"]) => ({ id, state }) as ProgramVersion;
    expect(defaultVersion([v("3", "draft"), v("2", "published"), v("1", "archived")])?.id).toBe("3");
    expect(defaultVersion([v("2", "published"), v("1", "archived")])?.id).toBe("2");
    expect(defaultVersion([v("1", "archived")])?.id).toBe("1");
    expect(defaultVersion([])).toBeNull();
  });
});

describe("progress list totals", () => {
  it("states the total only when every page is loaded (the API returns no total count)", () => {
    expect(totalLabel(28, false)).toBe("全28件");
    expect(totalLabel(50, true)).toBe("50件を表示中（続きがあります）");
  });
});

describe("correction history (教育記録)", () => {
  it("renders before → after in Japanese and hides raw ids", () => {
    const lines = changeLines({
      changes: {
        content: { before: "新規顧客開拓", after: "新規顧客開拓・研修振り返り" },
        due_date: { before: "2019-09-30", after: "2019-10-01" },
        state: { before: "in_progress", after: "completed" },
        teacher_id: { before: "11111111-1111-4111-8111-111111111111", after: "22222222-2222-4222-8222-222222222222" },
        teacher_name: { before: "田中 祥司", after: "別府 悦子" },
        notes: { before: "", after: "面談済み" },
      },
    });
    expect(lines.map((l) => `${l.label}：${l.before} → ${l.after}`)).toEqual([
      "終了予定日：2019年9月30日（月） → 2019年10月1日（火）",
      "教育担当者：田中 祥司 → 別府 悦子",
      "内容：新規顧客開拓 → 新規顧客開拓・研修振り返り",
      "状態：受講中 → 完了",
      "備考：（なし） → 面談済み",
    ]);
    expect(eventLabel("progress_record.corrected")).toBe("教育記録を訂正");
    expect(eventLabel("unknown.event")).toBe("unknown.event");
  });
});

describe("student history (WEB-12)", () => {
  it("merges unit completions, submissions/reviews and audit events newest first", () => {
    const unit = { id: "u1", enrollment_id: "e1", title: "ビジネスマナー", program_name: "基礎研修", completed_at: "2026-10-02T02:20:00Z" } as UnitProgress;
    const sub = {
      id: "s1",
      student_name: "和田 一夫",
      material_title: "振り返りレポート",
      unit_title: "ビジネスマナー",
      submitted_at: "2026-10-01T01:00:00Z",
      reviewed_at: "2026-10-02T02:19:00Z",
      reviewer_name: "田中 祥司",
      state: "accepted",
      feedback: "よくできています",
    } as Submission;
    const ev = { id: "a1", event_type: "progress.enrolled", actor_name: "システム", created_at: "2026-10-01T00:00:00Z", details: { program_name: "基礎研修", version_number: 1, due_on: "2026-12-31" } } as unknown as AuditEvent;
    const items = buildStudentHistory([unit], [sub], [ev]);
    expect(items.map((i) => i.title)).toEqual(["「ビジネスマナー」を完了", "「振り返りレポート」を承認", "「振り返りレポート」を提出", "受講を割当"]);
    expect(items[1]!.actor).toBe("田中 祥司");
    expect(items[0]!.atLabel).toBe("10月2日（金）11:20");
    expect(items[3]!.body).toBe("基礎研修 v1 を割当（修了期限 2026年12月31日（木））");
  });
});
