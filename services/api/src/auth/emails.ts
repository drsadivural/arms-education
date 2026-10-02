/**
 * Japanese account e-mails (invitation, password reset) sent through the transactional mailer
 * (integrations/mail.ts). Links point to the Web app's /auth/callback with the one-time token in the URL fragment,
 * so it never reaches server logs or Referer headers. Without a configured mailer the request fails with
 * NOT_CONFIGURED — an e-mail is never reported as sent when it was not.
 */
import type { Deps } from "../context";
import { ApiError } from "../http/errors";
import { MailDeliveryError } from "../integrations/mail";
import type { LinkPurpose } from "./tokens";

function linkFor(appOrigin: string, token: string, purpose: LinkPurpose): string {
  const type = purpose === "invite" ? "invite" : "recovery";
  return `${appOrigin}/auth/callback#token=${encodeURIComponent(token)}&type=${type}`;
}

function jst(d: Date): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

const FOOTER = "このメールに心当たりがない場合は、破棄してください。\nこのメールは送信専用です。返信いただいてもお答えできません。";

export function invitationEmail(p: { displayName: string; orgName: string; link: string; expiresAt: Date }) {
  return {
    subject: "【ARMS】新入社員研修システムへのご招待",
    text: [
      `${p.displayName} 様`,
      "",
      `${p.orgName} の ARMS 新入社員研修システムの利用者として登録されました。`,
      "次のリンクを開いて、パスワードを設定してください。",
      "",
      p.link,
      "",
      `リンクの有効期限：${jst(p.expiresAt)}（24時間）`,
      "期限が切れた場合は、管理者に招待の再送を依頼してください。",
      "",
      "受講者の方は、パスワード設定後に iOS アプリ「ARMS」からログインしてください。",
      "講師・管理者の方は Web 管理画面からログインできます。",
      "",
      FOOTER,
    ].join("\n"),
  };
}

export function passwordResetEmail(p: { displayName: string; link: string; expiresAt: Date }) {
  return {
    subject: "【ARMS】パスワード再設定のご案内",
    text: [
      `${p.displayName} 様`,
      "",
      "ARMS のパスワード再設定の依頼を受け付けました。",
      "次のリンクを開いて、新しいパスワードを設定してください。",
      "",
      p.link,
      "",
      `リンクの有効期限：${jst(p.expiresAt)}（1時間）`,
      "パスワードを設定すると、ほかの端末のログイン状態は解除されます。",
      "再設定を依頼していない場合は、このメールを破棄してください（パスワードは変更されません）。",
      "",
      FOOTER,
    ].join("\n"),
  };
}

/** Sends the e-mail for a freshly created link token. Delivery problems become Japanese API errors. */
export async function sendLinkEmail(
  deps: Deps,
  input: { to: string; displayName: string; orgName: string; token: string; tokenId: string; purpose: LinkPurpose; expiresAt: Date },
): Promise<void> {
  const mail = deps.integrations.mail;
  if (!mail) throw new ApiError("NOT_CONFIGURED", { message_ja: "メール送信サービスが未設定のため、メールを送信できません。管理者にお問い合わせください。" });
  const link = linkFor(deps.config.appOrigin, input.token, input.purpose);
  const message =
    input.purpose === "invite"
      ? invitationEmail({ displayName: input.displayName, orgName: input.orgName, link, expiresAt: input.expiresAt })
      : passwordResetEmail({ displayName: input.displayName, link, expiresAt: input.expiresAt });
  try {
    await mail.send({ to: input.to, subject: message.subject, text: message.text, idempotencyKey: `auth-link:${input.tokenId}` });
  } catch (e) {
    if (e instanceof MailDeliveryError) {
      throw new ApiError(e.code === "MAIL_RATE_LIMITED" ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE", {
        message_ja: "メールを送信できませんでした。時間をおいて再度お試しください。",
        details: { mail_error: e.code },
        cause: e,
      });
    }
    throw e;
  }
}
