/**
 * Small helpers shared by the admin area (teachers, students, classrooms, settings, users, events, dashboard).
 */
import { z } from "zod";
import { zId } from "@arms/contracts";
import type { Actor } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";

/** Appends an audit event in the caller's transaction (never put secrets/tokens/file contents in the payload). */
export async function audit(tx: Tx, actor: Actor, eventType: string, entityId: string | null, payload: Record<string, unknown>): Promise<void> {
  await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
    VALUES (${actor.orgId}, ${actor.userId}, ${eventType}, ${entityId}, ${json(payload)}::jsonb)`);
}

/** Transactional outbox row (delivered by the notifications worker). */
export async function enqueue(tx: Tx, orgId: string, eventType: string, entityId: string, payload: Record<string, unknown>): Promise<void> {
  await tx.exec(sql`INSERT INTO app.outbox(org_id, event_type, entity_id, payload) VALUES (${orgId}, ${eventType}, ${entityId}, ${json(payload)}::jsonb)`);
}

/** `%term%` for ILIKE with the LIKE wildcards of the user input escaped (use with `ESCAPE '\'`). */
export function containsPattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** `term%` for prefix matching with escaped wildcards (use with `ESCAPE '\'`). */
export function prefixPattern(term: string): string {
  return `${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Deterministic JSON (sorted keys, undefined dropped) used for request hashing. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/** Query-string value: empty strings (e.g. an unselected filter) are treated as absent. */
export const optionalQuery = <S extends z.ZodType>(schema: S) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

export const zQueryText = z.string().trim().max(100, { message: "100文字以内で入力してください。" });

/** Common list query (cursor pagination + the filters each list supports). Unknown parameters are ignored. */
export const ListQuery = z.object({
  cursor: optionalQuery(z.string().max(1000)),
  limit: optionalQuery(z.string()),
  q: optionalQuery(zQueryText),
  classroom_id: optionalQuery(zId),
  teacher_id: optionalQuery(zId),
  department: optionalQuery(zQueryText),
  status: optionalQuery(z.enum(["active", "inactive"])),
});
export type ListQueryT = z.infer<typeof ListQuery>;

/** Keyset cursor shapes. */
export const TextIdCursor = z.object({ k: z.string(), id: zId });
export const TimeIdCursor = z.object({ t: z.string().min(1).max(64), id: zId });

/** Shallow before/after diff of plain values (JSON comparison), for audit payloads. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (stableStringify(before[key]) !== stableStringify(after[key])) out[key] = { before: before[key] ?? null, after: after[key] ?? null };
  }
  return out;
}
