/**
 * Maps app deep links (services/api domain/notifications/rules.ts DEEP_LINKS, shared with iOS) to Web routes.
 * Only known shapes with a UUID are accepted, so a link can never navigate outside the app's own routes.
 */
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const RULES: { pattern: RegExp; to: (id: string) => string; label: string }[] = [
  { pattern: new RegExp(`^arms://reservations/(${UUID})$`), to: (id) => `/bookings/reservations/${id.toLowerCase()}`, label: "予約の詳細を開く" },
  { pattern: new RegExp(`^arms://lesson-slots/(${UUID})$`), to: (id) => `/bookings/slots/${id.toLowerCase()}`, label: "授業枠を開く" },
  { pattern: /^arms:\/\/lessons\/today$/, to: () => "/dashboard", label: "本日の授業を確認する" },
  { pattern: /^arms:\/\/settings\/users$/, to: () => "/settings/users", label: "ユーザー管理を開く" },
];

export interface WebLink {
  to: string;
  label: string;
}

export function webRouteForDeepLink(deepLink: string | null | undefined): WebLink | null {
  if (!deepLink) return null;
  for (const r of RULES) {
    const m = r.pattern.exec(deepLink.trim());
    if (m) return { to: r.to(m[1] ?? ""), label: r.label };
  }
  return null;
}
