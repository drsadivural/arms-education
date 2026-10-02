/** Shared types of the legacy data migration (WEB-17). */
import { IMPORT_FIELDS, type ImportEncoding, type ImportEntity, type ImportFieldDef } from "@arms/contracts";

export type EntityKind = "teacher" | "classroom" | "student" | "progress_record";
export const ENTITY_KIND: Record<ImportEntity, EntityKind> = {
  teachers: "teacher",
  classrooms: "classroom",
  students: "student",
  progress: "progress_record",
};

export type ItemAction = "create" | "update" | "skip" | "error";
export type JobState = "uploaded" | "validated" | "committing" | "completed" | "failed" | "rolled_back";

export interface RowMessage {
  field: string;
  label_ja: string;
  message_ja: string;
}

/** One non-blank CSV data record after mapping. */
export interface SourceRow {
  /** Spreadsheet row number (header = 1). */
  row: number;
  /** target field → cell text (only mapped fields are present). */
  values: Map<string, string>;
  /** source header → original cell text (kept for the dry-run table and the error report). */
  source: Record<string, string>;
  /** Cells beyond the header width that are not empty. */
  extraCells: number;
}

export interface PlannedItem {
  row: number;
  action: ItemAction;
  key: string | null;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  errors: RowMessage[];
  warnings: RowMessage[];
  source: Record<string, string>;
}

export interface ColumnSummary {
  field: string;
  label_ja: string;
  required: boolean;
  source_header: string | null;
  empty_meaning_ja: string;
  empty_count: number | null;
  error_count: number | null;
}

/** import_jobs.summary (dry-run facts that do not change after validation). */
export interface JobSummary {
  headers?: string[];
  columns?: ColumnSummary[];
  detected_encoding?: string | null;
  encoding_mismatch?: boolean;
  blank_rows?: number;
}

export interface JobRow {
  id: string;
  created_by: string;
  created_by_name: string;
  source_system: string;
  object_key: string;
  mapping: Record<string, string>;
  state: JobState;
  summary: JobSummary;
  upload_id: string;
  entity: ImportEntity;
  encoding: ImportEncoding;
  filename: string;
  options: { send_invitations: boolean } | null;
  failure: { code: string; message_ja: string; from_row: number | null; to_row: number | null; row: number | null } | null;
  lease_token: string | null;
  leased: boolean;
  commit_key: string | null;
  commit_hash: string | null;
  rollback_key: string | null;
  rollback_hash: string | null;
  created_at: Date;
  updated_at: Date;
  validated_at: Date | null;
  committed_at: Date | null;
  rolled_back_at: Date | null;
  row_version: number;
}

export function fieldDefs(entity: ImportEntity): readonly ImportFieldDef[] {
  return IMPORT_FIELDS[entity];
}

export function fieldLabel(entity: ImportEntity, field: string): string {
  if (field === "_row") return "行全体";
  return IMPORT_FIELDS[entity].find((f) => f.field === field)?.label ?? field;
}

/** Fields compared to decide update vs skip (and shown as changed_fields). */
export const COMPARE_FIELDS: Record<ImportEntity, readonly string[]> = {
  teachers: ["display_name", "kana", "department_name"],
  classrooms: ["name", "capacity", "starts_on", "ends_on"],
  students: ["display_name", "kana", "company_name", "department_name", "joined_on", "training_starts_on", "training_due_on"],
  progress: ["student_id", "due_date", "department_name", "teacher_id", "teacher_name_snapshot", "content", "notes", "state"],
};

/** Planned/current values shown in the dry-run table (ids are resolved to numbers and names). */
export const DISPLAY_FIELDS: Record<ImportEntity, readonly string[]> = {
  teachers: ["teacher_number", "display_name", "kana", "email", "department_name", "active"],
  classrooms: ["classroom_code", "name", "capacity", "starts_on", "ends_on", "primary_teacher_number", "primary_teacher_name"],
  students: [
    "employee_number",
    "display_name",
    "kana",
    "email",
    "company_name",
    "department_name",
    "joined_on",
    "classroom_code",
    "classroom_name",
    "teacher_number",
    "teacher_name",
    "training_starts_on",
    "training_due_on",
    "active",
  ],
  progress: ["source_record_id", "employee_number", "student_name", "due_date", "department_name", "teacher_number", "teacher_name_snapshot", "content", "notes", "state"],
};
