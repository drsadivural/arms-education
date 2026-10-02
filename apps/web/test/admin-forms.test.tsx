import { beforeAll, describe, expect, it } from "vitest";
import { installJapaneseErrors } from "@arms/contracts";
import {
  ClassroomForm,
  SettingsForm,
  StudentForm,
  TeacherForm,
  settingsDefaults,
  settingsFieldName,
  studentDefaults,
  teacherDefaults,
  toSettingsInput,
  toTeacherInput,
} from "../src/features/admin/forms";
import { defaultRename } from "../src/features/admin/errors";
import type { Settings } from "../src/features/admin/types";

beforeAll(() => installJapaneseErrors());

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  Object.fromEntries((r.error?.issues ?? []).map((i) => [String(i.path[0]), i.message]));

describe("講師フォーム", () => {
  const valid = { ...teacherDefaults(), teacher_number: "T005", display_name: "佐藤 直子", email: "sato@example.invalid", department_name: "人事部" };

  it("必須項目を日本語で検証する", () => {
    const r = TeacherForm.safeParse(teacherDefaults());
    expect(issues(r)).toMatchObject({ teacher_number: "必須項目です。", display_name: "必須項目です。", email: "必須項目です。", department_name: "必須項目です。" });
  });

  it("稼働時間は未入力なら送らず、一部だけ入力した場合はエラーにする", () => {
    const parsed = TeacherForm.parse(valid);
    expect(toTeacherInput(parsed)).not.toHaveProperty("availability");
    const partial = TeacherForm.safeParse({ ...valid, weekdays: [1, 2] });
    expect(issues(partial)).toMatchObject({ start_time: "開始時刻を入力してください。", end_time: "終了時刻を入力してください。" });
    const reversed = TeacherForm.safeParse({ ...valid, weekdays: [1], start_time: "17:00", end_time: "09:00" });
    expect(issues(reversed).end_time).toBe("終了時刻は開始時刻より後にしてください。");
  });

  it("稼働時間を入力するとAPIのavailability形式に変換する", () => {
    const body = toTeacherInput(TeacherForm.parse({ ...valid, weekdays: [1, 3, 5], start_time: "09:00", end_time: "17:00", specialties: ["IT基礎"] }));
    expect(body).toEqual({
      display_name: "佐藤 直子",
      kana: "",
      email: "sato@example.invalid",
      teacher_number: "T005",
      department_name: "人事部",
      specialties: ["IT基礎"],
      active: true,
      availability: { weekdays: [1, 3, 5], start_time: "09:00", end_time: "17:00" },
    });
  });

  it("メール形式の誤りを日本語で返す", () => {
    expect(issues(TeacherForm.safeParse({ ...valid, email: "not-mail" })).email).toBe("メールアドレスの形式が正しくありません。");
  });
});

describe("新入社員フォーム", () => {
  it("研修終了予定日が開始日より前ならエラー", () => {
    const r = StudentForm.safeParse({
      ...studentDefaults(),
      employee_number: "E1",
      display_name: "中村 翔太",
      email: "n@example.invalid",
      department_name: "開発部",
      joined_on: "2026-10-01",
      classroom_id: "6f3d25fc-bfc1-4ff9-8a23-8b3356df639c",
      teacher_id: "ab3366a7-ec12-4c96-ad62-e9146660bb0c",
      training_starts_on: "2026-10-01",
      training_due_on: "2026-09-30",
    });
    expect(issues(r).training_due_on).toBe("研修終了予定日は開始日以降にしてください。");
  });

  it("クラス・講師未選択と存在しない日付を検出する", () => {
    const r = StudentForm.safeParse({ ...studentDefaults(), joined_on: "2026-02-30" });
    const e = issues(r);
    expect(e.classroom_id).toBe("所属クラスを選択してください。");
    expect(e.teacher_id).toBe("担当講師を選択してください。");
    expect(e.joined_on).toBe("存在しない日付です。");
  });
});

describe("クラスフォーム", () => {
  it("主担当講師を補助講師に含めるとエラー、定員は1以上", () => {
    const r = ClassroomForm.safeParse({
      name: "A",
      capacity: 0,
      starts_on: "2026-10-01",
      ends_on: "2026-12-31",
      primary_teacher_id: "t1",
      assistant_teacher_ids: ["t1"],
      program_version_ids: [],
    });
    const e = issues(r);
    expect(e.capacity).toBe("1以上の値を入力してください。");
    expect(e.assistant_teacher_ids).toBe("主担当講師は補助講師に指定できません。");
  });

  it("空の定員（NaN）は数値エラー", () => {
    const r = ClassroomForm.safeParse({ name: "A", capacity: Number.NaN, starts_on: "2026-10-01", ends_on: "2026-10-01", primary_teacher_id: "t1", assistant_teacher_ids: [], program_version_ids: [] });
    expect(issues(r).capacity).toBe("数値を入力してください。");
  });
});

describe("システム設定フォーム", () => {
  const settings: Settings = {
    organization_name: "H&A研修センター",
    timezone: "Asia/Tokyo",
    booking_cancel_before_seconds: 86400,
    booking_pending_ttl_seconds: 43200,
    voice_daily_quota_seconds: 900,
    voice_max_session_seconds: 600,
    holidays: ["2026-12-31"],
    notifications_enabled: false,
    require_admin_mfa: true,
    default_theme: "system",
    departments: ["開発部"],
    business_hours: { weekdays: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "18:00" },
  };

  it("秒を時間・分に変換して表示し、保存時に秒へ戻す", () => {
    const d = settingsDefaults(settings);
    expect(d).toMatchObject({ cancel_hours: 24, pending_hours: 12, voice_daily_minutes: 15, voice_max_minutes: 10, notifications_enabled: "false" });
    const body = toSettingsInput(SettingsForm.parse({ ...d, cancel_hours: 1.5, holidays: ["2027-01-02", "2026-12-31", "2027-01-02"] }));
    expect(body).toMatchObject({
      booking_cancel_before_seconds: 5400,
      booking_pending_ttl_seconds: 43200,
      voice_daily_quota_seconds: 900,
      voice_max_session_seconds: 600,
      notifications_enabled: false,
      holidays: ["2026-12-31", "2027-01-02"],
      business_hours: { weekdays: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "18:00" },
    });
  });

  it("範囲外の値と営業曜日なしを日本語で検出する", () => {
    const e = issues(SettingsForm.safeParse({ ...settingsDefaults(settings), pending_hours: 0, voice_max_minutes: 61, weekdays: [] }));
    expect(e.pending_hours).toBe("0より大きい値を入力してください。");
    expect(e.voice_max_minutes).toBe("60以下の値を入力してください。");
    expect(e.weekdays).toBe("曜日を1つ以上選択してください。");
  });

  it("APIの項目名をフォームの項目名に対応付ける", () => {
    expect(settingsFieldName("booking_cancel_before_seconds")).toBe("cancel_hours");
    expect(settingsFieldName("voice_daily_quota_seconds")).toBe("voice_daily_minutes");
    expect(settingsFieldName("business_hours.end_time")).toBe("end_time");
    expect(settingsFieldName("business_hours.weekdays.0")).toBe("weekdays");
    expect(settingsFieldName("departments.2")).toBe("departments");
    expect(defaultRename("availability.start_time")).toBe("start_time");
    expect(defaultRename("specialties.3")).toBe("specialties");
  });
});
