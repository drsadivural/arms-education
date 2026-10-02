/**
 * Form models of the admin screens. Each form schema reuses the request schemas/primitives of @arms/contracts
 * (same Japanese messages as the API) and adds UI-only shapes (weekday toggles, hours/minutes instead of seconds).
 * `to*Input` builds the exact request body; `*Defaults` turns a DTO back into form values.
 */
import { z } from "zod";
import { WeeklyHours, zDate, type SettingsInputT, type TeacherInputT } from "@arms/contracts";
import { fromHours, fromMinutes, toHours, toMinutes } from "./labels";
import type { Classroom, Settings, Student, Teacher } from "./types";

const requiredText = (max: number) => z.string().trim().min(1, { message: "必須項目です。" }).max(max, { message: `${max}文字以内で入力してください。` });
const optionalText = (max: number) => z.string().trim().max(max, { message: `${max}文字以内で入力してください。` });
const requiredEmail = z.string().trim().min(1, { message: "必須項目です。" }).max(254, { message: "254文字以内で入力してください。" }).pipe(z.email({ message: "メールアドレスの形式が正しくありません。" }));
const requiredDate = z.string().min(1, { message: "日付を入力してください。" }).pipe(zDate);
const requiredSelect = (message: string) => z.string().min(1, { message });

/** Weekday + time window that is optional as a whole (all empty = not set) but valid when partially filled. */
function refineHours(v: { weekdays: number[]; start_time: string; end_time: string }, ctx: z.RefinementCtx, required: boolean) {
  const touched = v.weekdays.length > 0 || !!v.start_time || !!v.end_time;
  if (!touched && !required) return;
  const parsed = WeeklyHours.safeParse({ weekdays: v.weekdays, start_time: v.start_time, end_time: v.end_time });
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? "weekdays");
    const message = key === "start_time" && !v.start_time ? "開始時刻を入力してください。" : key === "end_time" && !v.end_time ? "終了時刻を入力してください。" : issue.message;
    ctx.addIssue({ code: "custom", path: [key], message });
  }
}

// ---- teacher (WEB-04) ----------------------------------------------------------------------

export const TeacherForm = z
  .object({
    teacher_number: requiredText(50),
    display_name: requiredText(100),
    kana: optionalText(100),
    email: requiredEmail,
    department_name: requiredText(100),
    specialties: z.array(z.string()).max(20, { message: "20件以内で指定してください。" }),
    weekdays: z.array(z.number().int()),
    start_time: z.string(),
    end_time: z.string(),
    active: z.boolean(),
  })
  .superRefine((v, ctx) => refineHours(v, ctx, false));
export type TeacherFormValues = z.input<typeof TeacherForm>;

export const teacherDefaults = (t?: Teacher): TeacherFormValues => ({
  teacher_number: t?.teacher_number ?? "",
  display_name: t?.display_name ?? "",
  kana: t?.kana ?? "",
  email: t?.email ?? "",
  department_name: t?.department_name ?? "",
  specialties: t?.specialties ?? [],
  weekdays: t?.availability?.weekdays ?? [],
  start_time: t?.availability?.start_time ?? "",
  end_time: t?.availability?.end_time ?? "",
  active: t?.active ?? true,
});

export function toTeacherInput(v: z.output<typeof TeacherForm>): TeacherInputT {
  const hasHours = v.weekdays.length > 0 || !!v.start_time || !!v.end_time;
  const body: TeacherInputT = {
    display_name: v.display_name,
    kana: v.kana,
    email: v.email,
    teacher_number: v.teacher_number,
    department_name: v.department_name,
    specialties: v.specialties,
    active: v.active,
    ...(hasHours ? { availability: { weekdays: v.weekdays, start_time: v.start_time, end_time: v.end_time } } : {}),
  };
  return body;
}

// ---- student (WEB-06) ----------------------------------------------------------------------

export const StudentForm = z
  .object({
    employee_number: requiredText(50),
    display_name: requiredText(100),
    kana: optionalText(100),
    email: requiredEmail,
    company_name: optionalText(100),
    department_name: requiredText(100),
    joined_on: requiredDate,
    classroom_id: requiredSelect("所属クラスを選択してください。"),
    teacher_id: requiredSelect("担当講師を選択してください。"),
    training_starts_on: requiredDate,
    training_due_on: requiredDate,
    active: z.boolean(),
  })
  .refine((v) => !v.training_starts_on || !v.training_due_on || v.training_due_on >= v.training_starts_on, {
    path: ["training_due_on"],
    message: "研修終了予定日は開始日以降にしてください。",
  });
export type StudentFormValues = z.input<typeof StudentForm>;

export const studentDefaults = (s?: Student): StudentFormValues => ({
  employee_number: s?.employee_number ?? "",
  display_name: s?.display_name ?? "",
  kana: s?.kana ?? "",
  email: s?.email ?? "",
  company_name: s?.company_name ?? "",
  department_name: s?.department_name ?? "",
  joined_on: s?.joined_on ?? "",
  classroom_id: s?.classroom_id ?? "",
  teacher_id: s?.teacher_id ?? "",
  training_starts_on: s?.training_starts_on ?? "",
  training_due_on: s?.training_due_on ?? "",
  active: s?.active ?? true,
});

export const TransferForm = z.object({
  classroom_id: requiredSelect("移動先のクラスを選択してください。"),
  teacher_id: requiredSelect("担当講師を選択してください。"),
  reason: z.string().trim().min(1, { message: "理由を入力してください。" }).max(1000, { message: "1000文字以内で入力してください。" }),
});
export type TransferFormValues = z.input<typeof TransferForm>;

// ---- classroom (WEB-08) --------------------------------------------------------------------

export const ClassroomForm = z
  .object({
    name: requiredText(100),
    capacity: z.number({ message: "数値を入力してください。" }).int({ message: "整数を入力してください。" }).min(1, { message: "1以上の値を入力してください。" }).max(10000, { message: "10000以下の値を入力してください。" }),
    starts_on: requiredDate,
    ends_on: requiredDate,
    primary_teacher_id: requiredSelect("主担当講師を選択してください。"),
    assistant_teacher_ids: z.array(z.string()).max(50, { message: "50件以内で指定してください。" }),
    program_version_ids: z.array(z.string()).max(50, { message: "50件以内で指定してください。" }),
  })
  .refine((v) => !v.starts_on || !v.ends_on || v.ends_on >= v.starts_on, { path: ["ends_on"], message: "終了日は開始日以降にしてください。" })
  .refine((v) => !v.assistant_teacher_ids.includes(v.primary_teacher_id), { path: ["assistant_teacher_ids"], message: "主担当講師は補助講師に指定できません。" });
export type ClassroomFormValues = z.input<typeof ClassroomForm>;

export const classroomDefaults = (c?: Classroom): ClassroomFormValues => ({
  name: c?.name ?? "",
  capacity: c?.capacity ?? 30,
  starts_on: c?.starts_on ?? "",
  ends_on: c?.ends_on ?? "",
  primary_teacher_id: c?.primary_teacher_id ?? "",
  assistant_teacher_ids: c?.assistant_teacher_ids ?? [],
  program_version_ids: c?.program_version_ids ?? [],
});

// ---- settings (WEB-16) ---------------------------------------------------------------------

const hours = (max: number) =>
  z.number({ message: "数値を入力してください。" }).min(0, { message: "0以上の値を入力してください。" }).max(max, { message: `${max}以下の値を入力してください。` });

export const SettingsForm = z
  .object({
    organization_name: requiredText(200),
    default_theme: z.enum(["light", "dark", "system"]),
    require_admin_mfa: z.boolean(),
    notifications_enabled: z.enum(["true", "false"]),
    cancel_hours: hours(720),
    pending_hours: z.number({ message: "数値を入力してください。" }).positive({ message: "0より大きい値を入力してください。" }).max(336, { message: "336以下の値を入力してください。" }),
    voice_max_minutes: z.number({ message: "数値を入力してください。" }).min(1, { message: "1以上の値を入力してください。" }).max(60, { message: "60以下の値を入力してください。" }),
    voice_daily_minutes: z.number({ message: "数値を入力してください。" }).min(0, { message: "0以上の値を入力してください。" }).max(1440, { message: "1440以下の値を入力してください。" }),
    departments: z.array(z.string()).max(100, { message: "100件以内で指定してください。" }),
    holidays: z.array(z.string()).max(366, { message: "366件以内で指定してください。" }),
    weekdays: z.array(z.number().int()),
    start_time: z.string(),
    end_time: z.string(),
  })
  .superRefine((v, ctx) => refineHours(v, ctx, true));
export type SettingsFormValues = z.input<typeof SettingsForm>;

export const settingsDefaults = (s?: Settings): SettingsFormValues => ({
  organization_name: s?.organization_name ?? "",
  default_theme: s?.default_theme ?? "system",
  require_admin_mfa: s?.require_admin_mfa ?? true,
  notifications_enabled: s?.notifications_enabled === false ? "false" : "true",
  cancel_hours: s ? toHours(s.booking_cancel_before_seconds) : 24,
  pending_hours: s ? toHours(s.booking_pending_ttl_seconds) : 24,
  voice_max_minutes: s ? toMinutes(s.voice_max_session_seconds) : 10,
  voice_daily_minutes: s ? toMinutes(s.voice_daily_quota_seconds) : 15,
  departments: s?.departments ?? [],
  holidays: s?.holidays ?? [],
  weekdays: s?.business_hours.weekdays ?? [1, 2, 3, 4, 5],
  start_time: s?.business_hours.start_time ?? "09:00",
  end_time: s?.business_hours.end_time ?? "18:00",
});

export function toSettingsInput(v: z.output<typeof SettingsForm>): SettingsInputT {
  return {
    organization_name: v.organization_name,
    default_theme: v.default_theme,
    require_admin_mfa: v.require_admin_mfa,
    notifications_enabled: v.notifications_enabled === "true",
    booking_cancel_before_seconds: fromHours(v.cancel_hours),
    booking_pending_ttl_seconds: Math.max(1, fromHours(v.pending_hours)),
    voice_max_session_seconds: fromMinutes(v.voice_max_minutes),
    voice_daily_quota_seconds: fromMinutes(v.voice_daily_minutes),
    departments: v.departments,
    holidays: [...new Set(v.holidays)].sort(),
    business_hours: { weekdays: v.weekdays, start_time: v.start_time, end_time: v.end_time },
  };
}

/** API field names of PATCH /settings → form field names. */
export function settingsFieldName(key: string): string {
  const [head, second] = key.split(".");
  switch (head) {
    case "booking_cancel_before_seconds":
      return "cancel_hours";
    case "booking_pending_ttl_seconds":
      return "pending_hours";
    case "voice_max_session_seconds":
      return "voice_max_minutes";
    case "voice_daily_quota_seconds":
      return "voice_daily_minutes";
    case "business_hours":
      return second && !/^\d+$/.test(second) ? second : "weekdays";
    default:
      return head ?? key;
  }
}

// ---- users (WEB-18) ------------------------------------------------------------------------

export const InviteForm = z.object({ display_name: requiredText(100), email: requiredEmail });
export type InviteFormValues = z.input<typeof InviteForm>;
