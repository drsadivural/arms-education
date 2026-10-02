/**
 * Voice tool registry (contracts/voice-tools.json). The server — not the model or the client — decides which tools
 * a role may call and validates every argument; organisation, user and role always come from the session's actor.
 */
import { z } from "zod";
import voiceTools from "@arms/contracts/voice-tools.json";
import { zDate, zId } from "@arms/contracts";
import type { Role } from "../../context";

export type ToolName =
  | "today_lessons"
  | "get_progress"
  | "search_slots"
  | "get_reservations"
  | "prepare_reservation"
  | "commit_reservation"
  | "prepare_cancellation"
  | "commit_cancellation";

export const TOOL_ARGUMENTS: Record<ToolName, z.ZodType> = {
  today_lessons: z.strictObject({}),
  get_progress: z.strictObject({ student_id: zId.optional() }),
  search_slots: z.strictObject({ date: zDate, time_band: z.enum(["morning", "afternoon", "evening", "any"]) }),
  get_reservations: z.strictObject({ reservation_id: zId.optional() }),
  prepare_reservation: z.strictObject({ slot_id: zId }),
  commit_reservation: z.strictObject({ action_token: z.string().min(32).max(128) }),
  prepare_cancellation: z.strictObject({ reservation_id: zId }),
  commit_cancellation: z.strictObject({ action_token: z.string().min(32).max(128) }),
};

/** docs/05: teachers may only read (their lessons, their students' progress, reservations on their lessons). */
export const ROLE_TOOLS: Record<Exclude<Role, "admin">, readonly ToolName[]> = {
  student: ["today_lessons", "get_progress", "search_slots", "get_reservations", "prepare_reservation", "commit_reservation", "prepare_cancellation", "commit_cancellation"],
  teacher: ["today_lessons", "get_progress", "get_reservations"],
};

interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

const DEFINITIONS = (voiceTools as { tools: ToolDefinition[] }).tools;

/** Function tool definitions sent to the Realtime session for this role. */
export function toolDefinitionsFor(role: Exclude<Role, "admin">): ToolDefinition[] {
  const allowed = new Set<string>(ROLE_TOOLS[role]);
  return DEFINITIONS.filter((t) => allowed.has(t.name)).map((t) =>
    t.name === "get_progress" && role === "teacher"
      ? {
          ...t,
          description: "担当受講者の進捗をDBから取得。講師は受講者IDの指定が必要。",
          parameters: { ...t.parameters, required: ["student_id"] },
        }
      : t,
  );
}

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_ARGUMENTS, name);
}
