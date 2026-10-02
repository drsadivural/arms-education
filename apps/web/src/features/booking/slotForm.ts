/**
 * WEB-15 form model. Dates and times are entered as Japan wall-clock values (organisation timezone, independent of
 * the browser's timezone) and converted to ISO instants with zonedTimeToInstant before sending SlotInput.
 */
import { z } from "zod";
import { SlotInput, parseDateOnly, zonedParts, zonedTimeToInstant, type LessonSlot, type SlotInputT } from "@arms/contracts";
import { ORG_TZ } from "../../lib/format";

export interface SlotFormValues {
  title: string;
  classroom_id: string;
  teacher_id: string;
  unit_id: string;
  date: string;
  start_time: string;
  end_time: string;
  capacity: string;
  deadline_date: string;
  deadline_time: string;
  meeting_url: string;
  /** "" = organisation default (new slots only); otherwise seconds as text. */
  cancel_before: string;
  state: "open" | "closed";
}

export const EMPTY_SLOT_FORM: SlotFormValues = {
  title: "",
  classroom_id: "",
  teacher_id: "",
  unit_id: "",
  date: "",
  start_time: "",
  end_time: "",
  capacity: "10",
  deadline_date: "",
  deadline_time: "",
  meeting_url: "",
  cancel_before: "",
  state: "open",
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** Organisation-local {date, time} of an instant. */
export function toLocalParts(iso: string): { date: string; time: string } {
  const p = zonedParts(iso, ORG_TZ);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** ISO instant of an organisation-local date + HH:MM. */
export function toInstant(date: string, time: string): string {
  return zonedTimeToInstant(date, `${time}:00`, ORG_TZ).toISOString();
}

export function slotToFormValues(slot: LessonSlot): SlotFormValues {
  const start = toLocalParts(slot.starts_at);
  const end = toLocalParts(slot.ends_at);
  const deadline = toLocalParts(slot.booking_closes_at);
  return {
    title: slot.title,
    classroom_id: slot.classroom_id,
    teacher_id: slot.teacher_id,
    unit_id: slot.unit_id ?? "",
    date: start.date,
    start_time: start.time,
    end_time: end.time,
    capacity: String(slot.capacity),
    deadline_date: deadline.date,
    deadline_time: deadline.time,
    meeting_url: slot.meeting_url ?? "",
    cancel_before: String(slot.cancel_before_seconds),
    state: slot.state === "closed" ? "closed" : "open",
  };
}

/** Default booking deadline: one day before the lesson at the same time. */
export function defaultDeadline(date: string, time: string): { deadline_date: string; deadline_time: string } | null {
  if (!parseDateOnly(date) || !TIME_RE.test(time)) return null;
  const start = zonedTimeToInstant(date, `${time}:00`, ORG_TZ);
  const parts = toLocalParts(new Date(start.getTime() - 86_400_000).toISOString());
  return { deadline_date: parts.date, deadline_time: parts.time };
}

const required = (message: string) => z.string().trim().min(1, { message });
const dateField = required("日付を入力してください。").refine((v) => parseDateOnly(v) !== null, { message: "日付を正しく入力してください（例: 2026-10-05）。" });
const timeField = required("時刻を入力してください。").regex(TIME_RE, { message: "時刻を HH:MM 形式で入力してください（例: 14:00）。" });

/** Client-side validation with the same Japanese messages as the API (final validation is the server's). */
export const SlotFormSchema = z
  .object({
    title: required("授業名を入力してください。").max(200, { message: "200文字以内で入力してください。" }),
    classroom_id: required("クラスを選択してください。"),
    teacher_id: required("担当講師を選択してください。"),
    unit_id: z.string(),
    date: dateField,
    start_time: timeField,
    end_time: timeField,
    capacity: required("定員を入力してください。").refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1000, {
      message: "定員は1〜1,000の整数で入力してください。",
    }),
    deadline_date: dateField,
    deadline_time: timeField,
    meeting_url: z
      .string()
      .trim()
      .max(2048, { message: "2048文字以内で入力してください。" })
      .refine(
        (v) => {
          if (!v) return true;
          try {
            const u = new URL(v);
            return u.protocol === "https:" && !!u.hostname && !u.username && !u.password;
          } catch {
            return false;
          }
        },
        { message: "https:// から始まるURLを入力してください。" },
      ),
    cancel_before: z.string(),
    state: z.enum(["open", "closed"]),
  })
  .superRefine((v, ctx) => {
    if (!parseDateOnly(v.date) || !TIME_RE.test(v.start_time) || !TIME_RE.test(v.end_time)) return;
    if (v.end_time <= v.start_time) ctx.addIssue({ code: "custom", path: ["end_time"], message: "終了時刻は開始時刻より後にしてください。" });
    if (!parseDateOnly(v.deadline_date) || !TIME_RE.test(v.deadline_time)) return;
    if (`${v.deadline_date}T${v.deadline_time}` > `${v.date}T${v.start_time}`) {
      ctx.addIssue({ code: "custom", path: ["deadline_time"], message: "予約締切は授業開始時刻以前にしてください。" });
    }
  });

/** SlotInput for POST/PATCH. Empty optional fields are omitted (PATCH: unit/URL omitted = cleared). */
export function formValuesToInput(v: SlotFormValues): SlotInputT {
  const input: SlotInputT = {
    classroom_id: v.classroom_id,
    teacher_id: v.teacher_id,
    title: v.title.trim(),
    starts_at: toInstant(v.date, v.start_time),
    ends_at: toInstant(v.date, v.end_time),
    capacity: Number(v.capacity),
    booking_closes_at: toInstant(v.deadline_date, v.deadline_time),
    state: v.state,
  };
  if (v.unit_id) input.unit_id = v.unit_id;
  if (v.meeting_url.trim()) input.meeting_url = v.meeting_url.trim();
  if (v.cancel_before !== "") input.cancel_before_seconds = Number(v.cancel_before);
  return SlotInput.parse(input);
}

/** API field_errors (SlotInput names) → form field names. */
const SERVER_FIELD_MAP: Record<string, keyof SlotFormValues> = {
  title: "title",
  classroom_id: "classroom_id",
  teacher_id: "teacher_id",
  unit_id: "unit_id",
  starts_at: "start_time",
  ends_at: "end_time",
  capacity: "capacity",
  booking_closes_at: "deadline_time",
  meeting_url: "meeting_url",
  cancel_before_seconds: "cancel_before",
  state: "state",
};

export function mapServerFieldErrors(fieldErrors: Record<string, string>): { field: keyof SlotFormValues; message: string }[] {
  return Object.entries(fieldErrors)
    .map(([k, message]) => ({ field: SERVER_FIELD_MAP[k], message }))
    .filter((e): e is { field: keyof SlotFormValues; message: string } => !!e.field);
}
