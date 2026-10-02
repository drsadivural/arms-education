/** DTO aliases for the admin screens (generated from packages/contracts/openapi.json). */
import type { components } from "@arms/contracts";

type S = components["schemas"];

export type Teacher = S["Teacher"];
export type Student = S["Student"];
export type Classroom = S["Classroom"];
export type Dashboard = S["Dashboard"];
export type Settings = S["Settings"];
export type User = S["User"];
export type AuditEvent = S["AuditEvent"];
export type Delivery = S["Delivery"];
export type InviteResult = S["InviteResult"];
export type AccountDeletionRequest = S["AccountDeletionRequest"];
export type Program = S["Program"];
export type ProgramVersion = S["ProgramVersion"];
export type LessonSlot = S["LessonSlot"];
export type Reservation = S["Reservation"];
export type SettingsResponse = S["SettingsResponse"];
export type TeacherCreateResponse = S["TeacherCreateResponse"];
export type StudentCreateResponse = S["StudentCreateResponse"];
export type ActionResult = S["ActionResult"];

export type InvitationState = NonNullable<Teacher["invitation_state"]>;

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  checked_at: string;
}

export interface DataResponse<T> {
  data: T;
  checked_at: string;
}

/** Router `location.state` passed from a create form to the edit page so the invitation result can be shown. */
export interface CreatedState {
  invitation?: InviteResult;
}
