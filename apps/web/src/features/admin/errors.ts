/** Mapping of API errors onto form fields and readable conflict explanations for the admin screens. */
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { ApiError } from "../../lib/api";

/** Business error codes that belong to one form field (the API sends no field_errors for them). */
const CODE_FIELDS: Record<string, string> = {
  EMAIL_TAKEN: "email",
  EMPLOYEE_NUMBER_TAKEN: "employee_number",
  TEACHER_NUMBER_TAKEN: "teacher_number",
  CLASSROOM_FULL: "classroom_id",
  TEACHER_CLASSROOM_MISMATCH: "teacher_id",
  TEACHER_INACTIVE: "teacher_id",
  CLASSROOM_NAME_TAKEN: "name",
  CAPACITY_BELOW_ENROLLMENT: "capacity",
};

/**
 * Puts API field errors (keys like "availability.end_time" or "specialties.0") and field-specific business errors
 * on the form. `rename` maps an API key to a form field (return null to skip). Returns true when anything was shown
 * on a field, so the caller can avoid repeating the message in a banner. Focuses the first field.
 */
export function applyApiErrors<T extends FieldValues, O>(form: UseFormReturn<T, unknown, O>, error: unknown, rename: (key: string) => string | null = defaultRename): boolean {
  if (!(error instanceof ApiError)) return false;
  const fieldNames = new Set(Object.keys(form.getValues()));
  const entries: [string, string][] = Object.entries(error.fieldErrors).map(([k, v]) => [rename(k) ?? k, v]);
  const codeField = CODE_FIELDS[error.code];
  if (codeField && !entries.some(([k]) => k === codeField)) entries.push([codeField, error.messageJa]);
  let applied = 0;
  for (const [key, message] of entries) {
    if (!fieldNames.has(key)) continue;
    form.setError(key as Path<T>, { type: "server", message }, { shouldFocus: applied === 0 });
    applied++;
  }
  return applied > 0;
}

/** "specialties.3" → "specialties"; "availability.start_time" → "start_time". */
export function defaultRename(key: string): string {
  const [head, second] = key.split(".");
  if ((head === "availability" || head === "business_hours") && second && !/^\d+$/.test(second)) return second === "weekdays" ? "weekdays" : second;
  if (head === "availability" || head === "business_hours") return "weekdays";
  return head ?? key;
}

export const isConflict = (error: unknown, code?: string): boolean => error instanceof ApiError && error.status === 409 && (!code || error.code === code);
export const isVersionConflict = (error: unknown): boolean => isConflict(error, "VERSION_CONFLICT");

/** Extra explanation for 409 responses that carry details (e.g. which classrooms block stopping a teacher). */
export function conflictDetail(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "TEACHER_IS_PRIMARY") {
    const classrooms = error.details.classrooms;
    if (Array.isArray(classrooms) && classrooms.length) {
      const names = classrooms.map((c) => (typeof c === "object" && c && "name" in c ? String((c as { name: unknown }).name) : "")).filter(Boolean);
      if (names.length) return `主担当のクラス: ${names.join("、")}`;
    }
  }
  if (error.code === "TEACHER_HAS_FUTURE_SLOTS" && typeof error.details.upcoming_slot_count === "number") {
    return `今後の授業枠: ${error.details.upcoming_slot_count}件`;
  }
  if (error.code === "CLASSROOM_TEACHER_IN_USE") {
    const parts: string[] = [];
    if (typeof error.details.student_count === "number") parts.push(`担当受講者 ${error.details.student_count}名`);
    if (typeof error.details.slot_count === "number") parts.push(`授業枠 ${error.details.slot_count}件`);
    if (parts.length) return parts.join("・");
  }
  return null;
}
