/**
 * Organisation settings (organizations.settings jsonb, flat keys read by other modules):
 *   booking_cancel_before_seconds, booking_pending_ttl_seconds   → booking (applied to new slots/requests only)
 *   voice_daily_quota_seconds, voice_max_session_seconds         → voice
 *   require_admin_mfa                                            → auth (default true)
 *   holidays, notifications_enabled, default_theme, departments, business_hours
 * Absent or malformed stored values fall back to the deployment defaults (Config).
 */
import { z } from "zod";
import { WeeklyHours, zDate, type components } from "@arms/contracts";
import type { Config } from "../../env";

export type Settings = components["schemas"]["Settings"];

export const DEFAULT_BUSINESS_HOURS = { weekdays: [1, 2, 3, 4, 5], start_time: "09:00", end_time: "18:00" };

const int = (min: number, max: number) => z.int().min(min).max(max);

function pick<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

export function effectiveSettings(org: { name: string; timezone: string; settings: Record<string, unknown> | null }, config: Config): Settings {
  const s = org.settings ?? {};
  return {
    organization_name: org.name,
    timezone: org.timezone,
    booking_cancel_before_seconds: pick(int(0, 2592000), s.booking_cancel_before_seconds, config.booking.cancelBeforeSeconds),
    booking_pending_ttl_seconds: pick(int(1, 1209600), s.booking_pending_ttl_seconds, config.booking.pendingTtlSeconds),
    voice_daily_quota_seconds: pick(int(0, 86400), s.voice_daily_quota_seconds, config.voice.dailyQuotaSeconds),
    voice_max_session_seconds: pick(int(60, 3600), s.voice_max_session_seconds, Math.max(60, config.voice.maxSessionSeconds)),
    holidays: normalizeHolidays(pick(z.array(zDate), s.holidays, [])),
    notifications_enabled: pick(z.boolean(), s.notifications_enabled, true),
    require_admin_mfa: pick(z.boolean(), s.require_admin_mfa, true),
    default_theme: pick(z.enum(["light", "dark", "system"]), s.default_theme, "system"),
    departments: pick(z.array(z.string()), s.departments, []),
    business_hours: pick(WeeklyHours, s.business_hours, DEFAULT_BUSINESS_HOURS),
  };
}

/** Unique, ascending. */
export function normalizeHolidays(dates: string[]): string[] {
  return [...new Set(dates)].sort();
}
