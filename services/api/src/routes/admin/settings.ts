/** WEB-16 設定: organisation settings (organizations.settings jsonb, optimistic concurrency on organizations.row_version). */
import { Hono } from "hono";
import { SettingsInput } from "@arms/contracts";
import type { AppContext, AppEnv } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { fail } from "../../http/errors";
import { readBody, requireIfMatch } from "../../http/validation";
import { audit, diff } from "../../domain/admin/common";
import { effectiveSettings, normalizeHolidays, type Settings } from "../../domain/admin/settings";

export const settingsRoutes = new Hono<AppEnv>();

interface OrgRow {
  name: string;
  timezone: string;
  settings: Record<string, unknown> | null;
  row_version: number;
}

async function loadOrg(tx: Tx, orgId: string, forUpdate = false): Promise<OrgRow> {
  // organizations is outside tenant RLS: always restrict to the actor's organisation explicitly.
  return tx.one<OrgRow>(
    forUpdate
      ? sql`SELECT name, timezone, settings, row_version FROM app.organizations WHERE id = ${orgId} FOR NO KEY UPDATE`
      : sql`SELECT name, timezone, settings, row_version FROM app.organizations WHERE id = ${orgId}`,
  );
}

function respond(c: AppContext, settings: Settings, rowVersion: number) {
  c.header("ETag", `"${rowVersion}"`);
  return c.json({ data: settings, row_version: rowVersion, checked_at: c.get("deps").now().toISOString() });
}

settingsRoutes.get("/settings", requireRole("admin"), async (c) => {
  const org = await actorTx(c, (tx) => loadOrg(tx, c.get("actor").orgId));
  return respond(c, effectiveSettings(org, c.get("deps").config), org.row_version);
});

/**
 * Omitted fields keep their stored value. Booking values apply to slots/requests created afterwards; existing
 * lesson slots and reservations keep the deadlines that were fixed when they were created.
 */
settingsRoutes.patch("/settings", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const config = c.get("deps").config;
  const expected = requireIfMatch(c);
  const input = await readBody(c, SettingsInput);
  const { organization_name, ...rest } = input;
  const patch: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if (Array.isArray(patch.holidays)) patch.holidays = normalizeHolidays(patch.holidays as string[]);
  const saved = await actorTx(c, async (tx) => {
    const before = await loadOrg(tx, actor.orgId, true);
    if (before.row_version !== expected) fail("VERSION_CONFLICT");
    const updated = await tx.one<OrgRow>(sql`
      UPDATE app.organizations SET name = ${organization_name}, settings = settings || ${json(patch)}::jsonb, row_version = row_version + 1
      WHERE id = ${actor.orgId} AND row_version = ${expected} RETURNING name, timezone, settings, row_version`);
    const beforeEffective = effectiveSettings(before, config);
    const afterEffective = effectiveSettings(updated, config);
    const changes = diff(beforeEffective as unknown as Record<string, unknown>, afterEffective as unknown as Record<string, unknown>);
    await audit(tx, actor, "settings.updated", actor.orgId, { changes });
    return { settings: afterEffective, row_version: updated.row_version };
  });
  return respond(c, saved.settings, saved.row_version);
});
