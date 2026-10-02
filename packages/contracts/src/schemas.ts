/**
 * Request-body schemas mirroring packages/contracts/openapi.json (additionalProperties:false → strictObject).
 * Shared by the API (server-side validation) and the Web forms (same Japanese field errors).
 * test/schemas.test.ts checks these stay aligned with the OpenAPI required/property lists.
 */
import { z } from "zod";
import { parseDateOnly } from "./time";

/** Japanese issue messages. Installed once per runtime with installJapaneseErrors(). */
export const japaneseCustomError: z.core.$ZodErrorMap = (iss) => {
  switch (iss.code) {
    case "invalid_type":
      if (iss.input === undefined || iss.input === null) return "必須項目です。";
      if (iss.expected === "number" || iss.expected === "int") return "数値を入力してください。";
      if (iss.expected === "boolean") return "選択してください。";
      return "入力形式が正しくありません。";
    case "too_small":
      if (iss.origin === "string") return Number(iss.minimum) <= 1 ? "必須項目です。" : `${iss.minimum}文字以上で入力してください。`;
      if (iss.origin === "array") return Number(iss.minimum) <= 1 ? "1件以上指定してください。" : `${iss.minimum}件以上指定してください。`;
      if (iss.origin === "number") return iss.inclusive ? `${iss.minimum}以上の値を入力してください。` : `${iss.minimum}より大きい値を入力してください。`;
      return undefined;
    case "too_big":
      if (iss.origin === "string") return `${iss.maximum}文字以内で入力してください。`;
      if (iss.origin === "array") return `${iss.maximum}件以内で指定してください。`;
      if (iss.origin === "number") return `${iss.maximum}以下の値を入力してください。`;
      return undefined;
    case "invalid_format":
      switch (iss.format) {
        case "email":
          return "メールアドレスの形式が正しくありません。";
        case "date":
          return "日付を正しく入力してください（例: 2026-10-05）。";
        case "datetime":
          return "日時を正しく入力してください。";
        case "guid":
        case "uuid":
          return "選択肢から選んでください。";
        case "url":
          return "https:// から始まるURLを入力してください。";
        default:
          return "形式が正しくありません。";
      }
    case "invalid_value":
      return "選択肢から選んでください。";
    case "unrecognized_keys":
      return `許可されていない項目が含まれています（${iss.keys.join(", ")}）。`;
    default:
      return undefined;
  }
};

let installed = false;
export function installJapaneseErrors(): void {
  if (installed) return;
  z.config(z.locales.ja());
  z.config({ customError: japaneseCustomError });
  installed = true;
}

// ---- primitives ---------------------------------------------------------------------------

export const zId = z.guid();
/** Strict calendar date (rejects 2026-02-30). */
export const zDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "日付を正しく入力してください（例: 2026-10-05）。" })
  .refine((v) => parseDateOnly(v) !== null, { message: "存在しない日付です。" });
export const zDateTime = z.iso.datetime({ offset: true });
export const zHttpsUrl = z
  .string()
  .max(2048, { message: "2048文字以内で入力してください。" })
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === "https:" && u.hostname.length > 0 && !u.username && !u.password;
      } catch {
        return false;
      }
    },
    { message: "https:// から始まるURLを入力してください。" },
  );
const trimmed = (max: number) => z.string().trim().max(max);
const required = (max: number) => z.string().trim().min(1).max(max);
export const zReason = z.string().trim().min(1, { message: "理由を入力してください。" }).max(1000);

export const ROLES = ["admin", "teacher", "student"] as const;
export const zRole = z.enum(ROLES);

// ---- auth / me ----------------------------------------------------------------------------

export const LoginInput = z.strictObject({
  email: z.email(),
  password: z.string().min(1).max(256),
  selected_role: zRole,
  organization_id: zId.optional(),
});
export const PasswordResetInput = z.strictObject({ email: z.email() });
/** 10〜128文字、英字と数字を含む（組織の初期パスワードポリシー）。 */
export const zNewPassword = z
  .string()
  .min(10, { message: "10文字以上で入力してください。" })
  .max(128)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), { message: "英字と数字を両方含めてください。" });
export const PasswordSetInput = z.strictObject({
  access_token: z.string().min(20).max(4096),
  password: zNewPassword,
});
export const MfaVerifyInput = z.strictObject({ code: z.string().regex(/^\d{6}$/, { message: "6桁の数字を入力してください。" }) });
export const PreferenceInput = z.strictObject({
  theme: z.enum(["light", "dark", "system"]),
  notifications_enabled: z.boolean(),
});
export const DeleteAccountInput = z.strictObject({ reason: trimmed(1000).optional() });
export const DeviceInput = z.strictObject({
  token: z.string().regex(/^[0-9a-fA-F]{32,200}$/, { message: "デバイストークンの形式が正しくありません。" }),
  environment: z.enum(["sandbox", "production"]),
});

// ---- people & classrooms -------------------------------------------------------------------

/** "HH:MM" (24h) wall-clock time in the organisation timezone. */
export const zTimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "時刻を HH:MM 形式で入力してください（例: 09:00）。" });
/** Weekdays (0=日曜〜6=土曜) and a time window; used for teacher availability and business hours. */
export const WeeklyHours = z
  .strictObject({
    weekdays: z
      .array(z.int().min(0).max(6))
      .min(1, { message: "曜日を1つ以上選択してください。" })
      .max(7)
      .refine((v) => new Set(v).size === v.length, { message: "曜日が重複しています。" }),
    start_time: zTimeOfDay,
    end_time: zTimeOfDay,
  })
  .refine((v) => v.end_time > v.start_time, { path: ["end_time"], message: "終了時刻は開始時刻より後にしてください。" });

export const TeacherInput = z.strictObject({
  display_name: required(100),
  kana: trimmed(100).optional(),
  email: z.email().max(254),
  teacher_number: required(50),
  department_name: trimmed(100),
  specialties: z.array(required(50)).max(20).optional(),
  availability: WeeklyHours.optional(),
  active: z.boolean(),
});

export const StudentInput = z
  .strictObject({
    employee_number: required(50),
    display_name: required(100),
    kana: trimmed(100).optional(),
    email: z.email().max(254),
    company_name: trimmed(100).optional(),
    department_name: required(100),
    joined_on: zDate,
    classroom_id: zId,
    teacher_id: zId,
    training_starts_on: zDate,
    training_due_on: zDate,
    active: z.boolean(),
  })
  .refine((v) => v.training_due_on >= v.training_starts_on, {
    path: ["training_due_on"],
    message: "研修終了予定日は開始日以降にしてください。",
  });

export const TransferInput = z.strictObject({
  classroom_id: zId,
  teacher_id: zId,
  reason: zReason,
  expected_version: z.int().min(1),
});

export const ClassroomInput = z
  .strictObject({
    name: required(100),
    capacity: z.int().min(1).max(10000),
    starts_on: zDate,
    ends_on: zDate,
    primary_teacher_id: zId,
    assistant_teacher_ids: z.array(zId).max(50).optional(),
    program_version_ids: z.array(zId).max(50).optional(),
  })
  .refine((v) => v.ends_on >= v.starts_on, { path: ["ends_on"], message: "終了日は開始日以降にしてください。" })
  .refine((v) => !(v.assistant_teacher_ids ?? []).includes(v.primary_teacher_id), {
    path: ["assistant_teacher_ids"],
    message: "主担当講師は補助講師に指定できません。",
  });

export const UserInvite = z.strictObject({
  email: z.email().max(254),
  display_name: required(100),
  role: zRole,
});

export const SettingsInput = z.strictObject({
  organization_name: required(200),
  booking_cancel_before_seconds: z.int().min(0).max(60 * 60 * 24 * 30).optional(),
  booking_pending_ttl_seconds: z.int().min(1).max(60 * 60 * 24 * 14).optional(),
  voice_daily_quota_seconds: z.int().min(0).max(60 * 60 * 24).optional(),
  voice_max_session_seconds: z.int().min(60).max(60 * 60).optional(),
  holidays: z.array(zDate).max(366).optional(),
  notifications_enabled: z.boolean().optional(),
  require_admin_mfa: z.boolean().optional(),
  default_theme: z.enum(["light", "dark", "system"]).optional(),
  departments: z
    .array(required(100))
    .max(100)
    .refine((v) => new Set(v).size === v.length, { message: "部署名が重複しています。" })
    .optional(),
  business_hours: WeeklyHours.optional(),
});

// ---- programs & materials ------------------------------------------------------------------

export const ProgramInput = z.strictObject({
  name: required(200),
  description: trimmed(5000),
  department_name: trimmed(100).optional(),
});

export const VersionInput = z.strictObject({
  source_version_id: zId.optional(),
  policy: z.strictObject({
    max_quiz_attempts: z.int().min(1).max(100),
    quiz_score_policy: z.enum(["highest", "latest"]),
  }),
});

export const UnitInput = z.strictObject({
  title: required(200),
  position: z.int().min(0).max(10000),
  required: z.boolean(),
  weight: z.number().positive().max(10000),
  pass_score: z.number().min(0).max(100).optional(),
  required_attendance: z.boolean().optional(),
  requires_review: z.boolean().optional(),
});

export const MATERIAL_KINDS = ["pdf", "video", "image", "link", "quiz", "assignment"] as const;
export const MaterialInput = z
  .strictObject({
    title: required(200),
    kind: z.enum(MATERIAL_KINDS),
    required: z.boolean(),
    external_url: zHttpsUrl.optional(),
    object_key: z.string().min(1).max(300).optional(),
    description: trimmed(5000).optional(),
  })
  .refine((v) => v.kind !== "link" || !!v.external_url, { path: ["external_url"], message: "リンク教材にはURLが必要です。" })
  .refine((v) => v.kind === "link" || !v.external_url, { path: ["external_url"], message: "URLはリンク教材にのみ指定できます。" });

export const QuizDefinitionInput = z.strictObject({
  title: required(200),
  questions: z
    .array(
      z
        .strictObject({
          prompt: required(2000),
          choices: z.array(z.strictObject({ id: required(50), label: required(500) })).min(2).max(10),
          correct_option_ids: z.array(required(50)).min(1),
          points: z.number().positive().max(1000),
        })
        .refine((q) => q.correct_option_ids.every((id) => q.choices.some((c) => c.id === id)), {
          path: ["correct_option_ids"],
          message: "正答は選択肢から選んでください。",
        })
        .refine((q) => new Set(q.choices.map((c) => c.id)).size === q.choices.length, {
          path: ["choices"],
          message: "選択肢IDが重複しています。",
        }),
    )
    .min(1)
    .max(100),
});

export const QuizInput = z.strictObject({
  answers: z
    .array(z.strictObject({ question_id: zId, selected_option_ids: z.array(z.string().max(50)).max(10) }))
    .max(100),
});

export const SubmissionInput = z.strictObject({
  body: z.string().max(10000),
  object_key: z.string().min(1).max(300).optional(),
});

export const ReviewInput = z.strictObject({
  state: z.enum(["accepted", "revision_requested"]),
  feedback: z.string().trim().max(2000),
  expected_version: z.int().min(1).optional(),
});

export const EnrollmentInput = z.strictObject({ student_id: zId, program_version_id: zId, due_on: zDate });

export const PROGRESS_RECORD_STATES = ["unverified", "not_started", "in_progress", "review_pending", "completed"] as const;
export const ProgressRecordInput = z.strictObject({
  student_id: zId,
  teacher_id: zId,
  department_name: required(100),
  due_date: zDate,
  content: required(2000),
  notes: trimmed(5000).optional(),
  state: z.enum(PROGRESS_RECORD_STATES),
});

export const ExportInput = z.strictObject({
  format: z.enum(["csv", "pdf"]),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: "YYYY-MM形式で指定してください。" }).optional(),
  department: trimmed(100).optional(),
  classroom_id: zId.optional(),
  teacher_id: zId.optional(),
  status: z.enum([...PROGRESS_RECORD_STATES, "overdue"]).optional(),
  q: trimmed(100).optional(),
});

// ---- booking -------------------------------------------------------------------------------

export const SlotInput = z
  .strictObject({
    classroom_id: zId,
    teacher_id: zId,
    unit_id: zId.optional(),
    title: required(200),
    starts_at: zDateTime,
    ends_at: zDateTime,
    capacity: z.int().min(1).max(1000),
    booking_closes_at: zDateTime,
    meeting_url: zHttpsUrl.optional(),
    cancel_before_seconds: z.int().min(0).max(60 * 60 * 24 * 30).optional(),
    state: z.enum(["open", "closed"]).optional(),
  })
  .refine((v) => new Date(v.ends_at) > new Date(v.starts_at), { path: ["ends_at"], message: "終了時刻は開始時刻より後にしてください。" })
  .refine((v) => new Date(v.booking_closes_at) <= new Date(v.starts_at), {
    path: ["booking_closes_at"],
    message: "予約締切は授業開始時刻以前にしてください。",
  });

export const ReservationInput = z.strictObject({ slot_id: zId });
export const DecisionInput = z.strictObject({ expected_version: z.int().min(1), reason: z.string().trim().max(1000).optional() });
export const DeactivateInput = z.strictObject({ reason: zReason, expected_version: z.int().min(1) });

export const AttendanceInput = z.strictObject({
  records: z
    .array(
      z.strictObject({
        student_id: zId,
        state: z.enum(["present", "absent", "late", "excused"]),
        note: trimmed(1000).optional(),
      }),
    )
    .min(1)
    .max(1000),
});

// ---- files, imports, voice -----------------------------------------------------------------

export const UploadInput = z.strictObject({
  filename: z.string().trim().min(1).max(200),
  content_type: z.string().min(1).max(200),
  size_bytes: z.int().min(1),
  purpose: z.enum(["material", "assignment", "import"]),
});

export const ImportMapping = z.strictObject({
  source_system: required(100),
  /** {source CSV header → target field}; the target fields allowed per entity are IMPORT_FIELDS (labels.ts). */
  columns: z
    .record(z.string().min(1).max(200), z.string().min(1).max(50))
    .refine((v) => Object.keys(v).length >= 1, { message: "列の対応付けを1つ以上指定してください。" })
    .refine((v) => Object.keys(v).length <= 100, { message: "対応付けできる列は100列までです。" }),
  encoding: z.enum(["utf-8", "utf-8-bom", "cp932"]),
  entity: z.enum(["teachers", "classrooms", "students", "progress"]),
  upload_id: zId,
});

export const VoiceToolInput = z.strictObject({
  session_id: zId,
  call_id: z.string().min(1).max(200),
  tool_name: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()),
});

export type LoginInputT = z.infer<typeof LoginInput>;
export type TeacherInputT = z.infer<typeof TeacherInput>;
export type StudentInputT = z.infer<typeof StudentInput>;
export type ClassroomInputT = z.infer<typeof ClassroomInput>;
export type SlotInputT = z.infer<typeof SlotInput>;
export type DecisionInputT = z.infer<typeof DecisionInput>;
export type SettingsInputT = z.infer<typeof SettingsInput>;
export type ProgressRecordInputT = z.infer<typeof ProgressRecordInput>;

// ---- area: admin (append below) ----

// ---- area: learning (append below) ----

/** PATCH /progress-records/{id}: the full record plus the correction reason (required when any value changes). */
export const ProgressRecordUpdateInput = z.strictObject({
  student_id: zId,
  teacher_id: zId,
  department_name: required(100),
  due_date: zDate,
  content: required(2000),
  notes: trimmed(5000).optional(),
  state: z.enum(PROGRESS_RECORD_STATES),
  correction_reason: z.string().trim().min(1, { message: "訂正理由を入力してください。" }).max(1000).optional(),
});

/** POST /classrooms/{id}/enrollments: assigns a published version to every active student of the classroom. */
export const ClassroomEnrollmentInput = z.strictObject({ program_version_id: zId, due_on: zDate });

/** POST /uploads/{id}/scan-result: scanner callback body (extra provider fields are ignored). */
export const ScanCallbackInput = z.looseObject({
  scan_id: z.string().min(1).max(200),
  status: z.string().min(1).max(50),
  upload_id: zId.optional(),
});

/** Upload purposes and the roles allowed to create each. */
export const UPLOAD_PURPOSES = ["material", "assignment", "import"] as const;

export type ProgressRecordUpdateInputT = z.infer<typeof ProgressRecordUpdateInput>;
export type ExportInputT = z.infer<typeof ExportInput>;

// ---- area: booking & notifications (append below) ----

export const RESERVATION_STATUSES = ["pending", "approved", "rejected", "cancelled", "expired", "removed"] as const;
export const SLOT_STATES = ["open", "closed", "cancelled"] as const;
export const RESERVATION_SORTS = ["starts_at", "-starts_at", "-created_at"] as const;
export const NOTIFICATION_FILTERS = ["all", "unread", "read"] as const;

/** Decision reasons: required (1〜1,000 characters after trimming) for reject/remove. */
export function isValidDecisionReason(reason: string | undefined | null): reason is string {
  return typeof reason === "string" && reason.trim().length >= 1 && reason.trim().length <= 1000;
}

/** sha256(lower-case hex device token) as hex — the identifier used by DELETE /devices/{token_hash}. */
export const zDeviceTokenHash = z.string().regex(/^[0-9a-f]{64}$/, { message: "端末識別子の形式が正しくありません。" });

// ---- area: voice (append below) ----

// ---- area: imports & exports (append below) ----

/** POST /imports/{id}/commit: the admin confirms a backup was taken; invitations are sent only when requested. */
export const ImportCommitInput = z.strictObject({
  backup_confirmed: z.literal(true, { message: "移行前にバックアップを取得したことを確認してください。" }),
  send_invitations: z.boolean().optional(),
});
export type ImportCommitInputT = z.infer<typeof ImportCommitInput>;
export type ImportMappingT = z.infer<typeof ImportMapping>;

/** GET /imports/{id}/items status filter. */
export const IMPORT_ITEM_FILTERS = ["all", "create", "update", "skip", "error", "warning", "conflict", "manual"] as const;
export type ImportItemFilter = (typeof IMPORT_ITEM_FILTERS)[number];
