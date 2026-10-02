/**
 * Accounts in E2E tests go through the real production paths: the invitation e-mail is read from Mailpit (local
 * stack: Worker → Resend-compatible relay → Mailpit), its one-time link sets the password (POST /auth/password), and
 * students sign in like the iOS app (POST /auth/tokens → Bearer access token).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";

const root = join(import.meta.dirname, "..", "..", "..");

/** services/api/.dev.vars (written by infra/local/setup.mjs). */
export const devVars = (): Record<string, string> =>
  Object.fromEntries(
    readFileSync(join(root, "services/api/.dev.vars"), "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

export const WEB_ORIGIN = `http://localhost:${process.env.ARMS_WEB_PORT ?? 5188}`;
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";

/** The one-time token of the newest invitation / password-reset e-mail to `email` (polls Mailpit up to 20 s). */
export async function mailLink(email: string, type: "invite" | "recovery"): Promise<string> {
  const subject = type === "invite" ? "ご招待" : "パスワード再設定";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const search = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json()) as {
      messages?: { ID: string; Subject: string }[];
    };
    const hit = (search.messages ?? []).find((m) => m.Subject.includes(subject));
    if (hit) {
      const message = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as { Text: string };
      const m = /\/auth\/callback#token=([^&\s]+)&type=(\w+)/.exec(message.Text);
      if (m?.[1] && m[2] === type) return decodeURIComponent(m[1]);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no ${type} e-mail for ${email} in Mailpit`);
}

/** Uses the invitation e-mail's link to set the password (what the person does on /auth/callback). */
export async function acceptInvitation(email: string, password: string): Promise<void> {
  const token = await mailLink(email, "invite");
  const res = await fetch(`${WEB_ORIGIN}/api/v1/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token, password }),
  });
  expect(res.status, `POST /auth/password ${await res.clone().text()}`).toBe(200);
}

/** Signs in like the iOS app and returns an API context with `Authorization: Bearer` (no cookies). */
export async function iosApi(email: string, password: string): Promise<APIRequestContext> {
  const res = await fetch(`${WEB_ORIGIN}/api/v1/auth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password, device_label: "E2E" }),
  });
  expect(res.status, `POST /auth/tokens ${await res.clone().text()}`).toBe(200);
  const { data } = (await res.json()) as { data: { access_token: string } };
  // No cookies: the API rejects requests carrying both a session cookie and a Bearer token (AMBIGUOUS_AUTH).
  return playwrightRequest.newContext({
    baseURL: WEB_ORIGIN,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { Authorization: `Bearer ${data.access_token}`, Accept: "application/json" },
  });
}
