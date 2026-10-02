export * from "./errors";
export * from "./labels";
export * from "./time";
export * from "./schemas";
export type { paths, components, operations } from "./openapi";

import type { components } from "./openapi";
type S = components["schemas"];
export type Teacher = S["Teacher"];
export type Student = S["Student"];
export type Classroom = S["Classroom"];
export type Program = S["Program"];
export type ProgramVersion = S["ProgramVersion"];
export type Unit = S["Unit"];
export type Material = S["Material"];
export type LessonSlot = S["LessonSlot"];
export type Reservation = S["Reservation"];
export type ProgressRecord = S["ProgressRecord"];
export type Progress = S["Progress"];
export type UnitProgress = S["UnitProgress"];
export type Notification = S["Notification"];
export type AuditEvent = S["AuditEvent"];
export type Dashboard = S["Dashboard"];
export type SessionInfo = S["SessionInfo"];
export type Me = S["Me"];
export type User = S["User"];
export type ImportJob = S["ImportJob"];
export type Quiz = S["Quiz"];
export type QuizQuestion = S["QuizQuestion"];
export type QuizResult = S["QuizResult"];
export type Submission = S["Submission"];
export type Enrollment = S["Enrollment"];
export type Upload = S["Upload"];
export type Download = S["Download"];
export type Export = S["Export"];
export type InviteResult = S["InviteResult"];
export type VoiceSession = S["VoiceSession"];

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  checked_at: string;
}
export interface DataResponse<T> {
  data: T;
  checked_at: string;
}
export interface ActionResult {
  success: boolean;
  checked_at: string;
  data?: Record<string, unknown>;
}
