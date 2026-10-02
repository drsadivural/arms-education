import { describe, expect, it } from "vitest";
import { installJapaneseErrors, type LessonSlot } from "@arms/contracts";
import {
  EMPTY_SLOT_FORM,
  SlotFormSchema,
  defaultDeadline,
  formValuesToInput,
  mapServerFieldErrors,
  slotToFormValues,
  toInstant,
  toLocalParts,
  type SlotFormValues,
} from "../src/features/booking/slotForm";
import { cancelBeforeLabel, holdRemaining } from "../src/features/booking/format";

installJapaneseErrors();

const CLASSROOM = "11111111-1111-4111-8111-111111111111";
const TEACHER = "22222222-2222-4222-8222-222222222222";

const values: SlotFormValues = {
  ...EMPTY_SLOT_FORM,
  title: " IT基礎・セキュリティ ",
  classroom_id: CLASSROOM,
  teacher_id: TEACHER,
  date: "2026-10-05",
  start_time: "14:00",
  end_time: "15:30",
  capacity: "10",
  deadline_date: "2026-10-04",
  deadline_time: "14:00",
};

describe("JST conversion (independent of the browser timezone)", () => {
  it("converts Japan wall-clock date + time to UTC instants", () => {
    expect(toInstant("2026-10-05", "14:00")).toBe("2026-10-05T05:00:00.000Z");
    // Early morning JST is the previous UTC day.
    expect(toInstant("2026-10-05", "08:30")).toBe("2026-10-04T23:30:00.000Z");
    expect(toInstant("2026-10-05", "00:00")).toBe("2026-10-04T15:00:00.000Z");
  });

  it("reads instants back as JST date + time", () => {
    expect(toLocalParts("2026-10-04T23:30:00.000Z")).toEqual({ date: "2026-10-05", time: "08:30" });
    expect(toLocalParts("2026-12-31T15:00:00Z")).toEqual({ date: "2027-01-01", time: "00:00" });
  });

  it("defaults the booking deadline to one day before the start (across month boundaries)", () => {
    expect(defaultDeadline("2026-11-01", "09:00")).toEqual({ deadline_date: "2026-10-31", deadline_time: "09:00" });
    expect(defaultDeadline("", "09:00")).toBeNull();
    expect(defaultDeadline("2026-11-01", "9時")).toBeNull();
  });
});

describe("form ↔ SlotInput", () => {
  it("builds SlotInput with ISO instants and omits empty optional fields", () => {
    expect(formValuesToInput(values)).toEqual({
      classroom_id: CLASSROOM,
      teacher_id: TEACHER,
      title: "IT基礎・セキュリティ",
      starts_at: "2026-10-05T05:00:00.000Z",
      ends_at: "2026-10-05T06:30:00.000Z",
      capacity: 10,
      booking_closes_at: "2026-10-04T05:00:00.000Z",
      state: "open",
    });
  });

  it("sends unit, private URL and cancel deadline when set", () => {
    const input = formValuesToInput({
      ...values,
      unit_id: "33333333-3333-4333-8333-333333333333",
      meeting_url: " https://meet.example.invalid/a ",
      cancel_before: "43200",
      state: "closed",
    });
    expect(input).toMatchObject({ unit_id: "33333333-3333-4333-8333-333333333333", meeting_url: "https://meet.example.invalid/a", cancel_before_seconds: 43200, state: "closed" });
  });

  it("round-trips an API slot through the form", () => {
    const slot = {
      id: "44444444-4444-4444-8444-444444444444",
      classroom_id: CLASSROOM,
      teacher_id: TEACHER,
      unit_id: null,
      title: "IT基礎",
      starts_at: "2026-10-05T05:00:00.000Z",
      ends_at: "2026-10-05T06:30:00.000Z",
      capacity: 10,
      booking_closes_at: "2026-10-04T05:00:00.000Z",
      meeting_url: "https://meet.example.invalid/x",
      has_meeting_url: true,
      cancel_before_seconds: 86400,
      teacher_name: "田中 祥司",
      classroom_name: "Aクラス",
      remaining: 10,
      state: "closed",
      row_version: 3,
    } satisfies LessonSlot;
    const form = slotToFormValues(slot);
    expect(form).toMatchObject({ date: "2026-10-05", start_time: "14:00", end_time: "15:30", deadline_date: "2026-10-04", deadline_time: "14:00", cancel_before: "86400", state: "closed" });
    expect(formValuesToInput(form)).toMatchObject({ starts_at: slot.starts_at, ends_at: slot.ends_at, booking_closes_at: slot.booking_closes_at, meeting_url: slot.meeting_url });
  });
});

describe("SlotFormSchema (Japanese messages)", () => {
  const errors = (v: SlotFormValues) => {
    const r = SlotFormSchema.safeParse(v);
    return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [String(i.path[0]), i.message]));
  };

  it("accepts a complete form", () => {
    expect(errors(values)).toEqual({});
  });

  it("requires fields and validates times, deadline, capacity and https", () => {
    expect(errors(EMPTY_SLOT_FORM)).toMatchObject({ title: "授業名を入力してください。", classroom_id: "クラスを選択してください。", date: "日付を入力してください。" });
    expect(errors({ ...values, end_time: "14:00" })).toEqual({ end_time: "終了時刻は開始時刻より後にしてください。" });
    expect(errors({ ...values, deadline_date: "2026-10-05", deadline_time: "14:05" })).toEqual({ deadline_time: "予約締切は授業開始時刻以前にしてください。" });
    expect(errors({ ...values, capacity: "0" })).toEqual({ capacity: "定員は1〜1,000の整数で入力してください。" });
    expect(errors({ ...values, capacity: "1.5" })).toEqual({ capacity: "定員は1〜1,000の整数で入力してください。" });
    expect(errors({ ...values, meeting_url: "http://insecure.example.invalid" })).toEqual({ meeting_url: "https:// から始まるURLを入力してください。" });
    expect(errors({ ...values, meeting_url: "https://user:pw@example.invalid" })).toEqual({ meeting_url: "https:// から始まるURLを入力してください。" });
  });

  it("maps API field errors (SlotInput names) onto form fields", () => {
    expect(mapServerFieldErrors({ starts_at: "開始時刻は現在より後にしてください。", booking_closes_at: "x", teacher_id: "y", unknown: "z" })).toEqual([
      { field: "start_time", message: "開始時刻は現在より後にしてください。" },
      { field: "deadline_time", message: "x" },
      { field: "teacher_id", message: "y" },
    ]);
  });
});

describe("booking display helpers", () => {
  const now = Date.parse("2026-10-02T05:20:00Z");
  it("formats the seat-hold countdown", () => {
    expect(holdRemaining("2026-10-03T05:20:00Z", now)).toBe("あと1日0時間");
    expect(holdRemaining("2026-10-03T05:19:00Z", now)).toBe("あと23時間59分");
    expect(holdRemaining("2026-10-02T05:45:00Z", now)).toBe("あと25分");
    expect(holdRemaining("2026-10-02T05:20:30Z", now)).toBe("あと1分未満");
    expect(holdRemaining("2026-10-02T05:20:00Z", now)).toBeNull();
  });

  it("labels cancel deadlines", () => {
    expect(cancelBeforeLabel(86_400)).toBe("開始24時間前");
    expect(cancelBeforeLabel(172_800)).toBe("開始2日前");
    expect(cancelBeforeLabel(1800)).toBe("開始30分前");
    expect(cancelBeforeLabel(0)).toBe("開始時刻まで");
  });
});
