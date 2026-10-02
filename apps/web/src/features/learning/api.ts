/**
 * Typed access to the learning API (programs, versions, units, materials, uploads, quizzes, enrollments, legacy
 * progress records, student progress, submissions, exports) plus the lookups the learning screens share.
 * Every write goes through the shared client (CSRF, Idempotency-Key, If-Match); success is shown only after the
 * API confirms.
 */
import { useQuery } from "@tanstack/react-query";
import type { ActionResult, DataResponse, Page, components } from "@arms/contracts";
import { api, type QueryValue } from "../../lib/api";
import { useCurrentUser } from "../../lib/session";

type S = components["schemas"];
export type Program = S["Program"];
export type ProgramVersion = S["ProgramVersion"];
export type Unit = S["Unit"];
export type Material = S["Material"];
export type MaterialKind = Material["kind"];
export type ScanState = Material["scan_state"];
export type QuizDefinition = S["QuizDefinition"];
export type UploadTicket = S["Upload"];
export type UploadStatus = S["UploadStatus"];
export type Download = S["Download"];
export type Enrollment = S["Enrollment"];
export type ProgressRecord = S["ProgressRecord"];
export type ProgressRecordDetail = S["ProgressRecordDetail"];
export type ProgressRecordHistoryEntry = S["ProgressRecordHistoryEntry"];
export type Progress = S["Progress"];
export type UnitProgress = S["UnitProgress"];
export type EnrollmentProgress = S["EnrollmentProgress"];
export type Submission = S["Submission"];
export type ExportJob = S["Export"];
export type Teacher = S["Teacher"];
export type Student = S["Student"];
export type Classroom = S["Classroom"];
export type AuditEvent = S["AuditEvent"];
export type Settings = S["Settings"];
export type ProgressRecordStatus = ProgressRecord["state"] | "overdue";

export type { ActionResult, DataResponse, Page };

/** Query keys of the learning area. Mutations invalidate by prefix (e.g. ["learning", "units", versionId]). */
export const learningKeys = {
  all: ["learning"] as const,
  programs: (filters: Record<string, string | undefined>) => ["learning", "programs", filters] as const,
  program: (id: string) => ["learning", "program", id] as const,
  versions: (programId: string) => ["learning", "versions", programId] as const,
  units: (versionId: string) => ["learning", "units", versionId] as const,
  materials: (unitId: string) => ["learning", "materials", unitId] as const,
  quizDefinition: (materialId: string) => ["learning", "quiz-definition", materialId] as const,
  upload: (uploadId: string) => ["learning", "upload", uploadId] as const,
  records: (filters: Record<string, string | undefined>) => ["learning", "records", filters] as const,
  record: (id: string) => ["learning", "record", id] as const,
  studentProgress: (studentId: string) => ["learning", "student-progress", studentId] as const,
  submissions: (studentId: string) => ["learning", "submissions", studentId] as const,
  studentRecords: (studentId: string) => ["learning", "student-records", studentId] as const,
  studentEvents: (studentId: string) => ["learning", "student-events", studentId] as const,
};

/** Follows next_cursor up to `maxPages` pages (lookups: teachers, classrooms, units, materials). */
export async function fetchAllPages<T>(path: string, query: Record<string, QueryValue> = {}, maxPages = 10): Promise<{ items: T[]; checked_at: string; truncated: boolean }> {
  const items: T[] = [];
  let cursor: string | null = null;
  let checkedAt = "";
  for (let i = 0; i < maxPages; i++) {
    const page: Page<T> = await api.get<Page<T>>(path, { query: { ...query, limit: 100, cursor } });
    items.push(...page.items);
    checkedAt ||= page.checked_at;
    cursor = page.next_cursor;
    if (!cursor) return { items, checked_at: checkedAt, truncated: false };
  }
  return { items, checked_at: checkedAt, truncated: true };
}

// ---- lookups shared by the filters and forms ----------------------------------------------------

export function useTeachersLookup() {
  return useQuery({
    queryKey: ["lookup", "teachers"],
    queryFn: () => fetchAllPages<Teacher>("/teachers"),
    staleTime: 60_000,
  });
}

export function useClassroomsLookup() {
  return useQuery({
    queryKey: ["lookup", "classrooms"],
    queryFn: () => fetchAllPages<Classroom>("/classrooms"),
    staleTime: 60_000,
  });
}

/**
 * Department names for filters and forms: the organisation's department list (settings, admin only) plus the
 * departments teachers belong to, so teachers (who cannot read settings) still get the same choices.
 */
export function useDepartments(): { departments: string[]; isLoading: boolean } {
  const user = useCurrentUser();
  const settings = useQuery({
    queryKey: ["lookup", "settings-departments"],
    queryFn: () => api.get<DataResponse<Settings>>("/settings"),
    enabled: user.isAdmin,
    staleTime: 5 * 60_000,
    select: (r) => r.data.departments,
  });
  const teachers = useTeachersLookup();
  const names = new Set<string>();
  for (const d of settings.data ?? []) if (d) names.add(d);
  for (const t of teachers.data?.items ?? []) if (t.department_name) names.add(t.department_name);
  return { departments: [...names].sort((a, b) => a.localeCompare(b, "ja")), isLoading: settings.isLoading || teachers.isLoading };
}

// ---- programs / versions / units / materials -----------------------------------------------------

export const getProgram = (id: string) => api.get<DataResponse<Program>>(`/programs/${id}`);
export const getVersions = (programId: string) => fetchAllPages<ProgramVersion>(`/programs/${programId}/versions`);
export const getUnits = (versionId: string) => fetchAllPages<Unit>(`/program-versions/${versionId}/units`);
export const getMaterials = (unitId: string) => fetchAllPages<Material>(`/units/${unitId}/materials`);

/** Problems returned in `details.problems` by publish endpoints (VERSION_NOT_PUBLISHABLE, SCAN_PENDING…). */
export interface PublishProblem {
  code: string;
  message_ja: string;
  unit_id?: string;
  material_id?: string;
}
