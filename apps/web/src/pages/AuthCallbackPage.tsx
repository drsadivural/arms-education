import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { zNewPassword } from "@arms/contracts";
import { Brand } from "../components/layout/Brand";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Field";
import { InlineError } from "../components/ui/Feedback";
import { ApiError, api } from "../lib/api";

interface LinkParams {
  token: string | null;
  type: string | null;
}

/** Reads the one-time token from the URL fragment once and removes it from the address bar/history. */
function takeLinkParams(): LinkParams {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const params = { token: hash.get("token"), type: hash.get("type") };
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  return params;
}

/** 招待メール・パスワード再設定メールのリンク先。新しいパスワードを設定する（全ロール共通、ログインではない）。 */
export function AuthCallbackPage() {
  const [link] = useState<LinkParams>(takeLinkParams);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ message: string; signIn: "web" | "ios" } | null>(null);

  useEffect(() => {
    document.title = "パスワードの設定 | ARMS";
  }, []);

  const heading = link.type === "invite" ? "ARMSへようこそ" : "パスワードの再設定";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const errs: Record<string, string> = {};
    const parsed = zNewPassword.safeParse(password);
    if (!parsed.success) errs.password = parsed.error.issues[0]?.message ?? "パスワードを確認してください。";
    if (password !== confirm) errs.confirm = "確認用のパスワードが一致しません。";
    setFieldErrors(errs);
    if (Object.keys(errs).length || !link.token) return;
    setBusy(true);
    try {
      const res = await api.post<{ data: { message_ja: string; sign_in: "web" | "ios" } }>("/auth/password", { token: link.token, password });
      setDone({ message: res.data.message_ja, signIn: res.data.sign_in });
    } catch (err) {
      if (err instanceof ApiError) setFieldErrors(err.fieldErrors);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <main className="w-full max-w-[420px] rounded-[20px] border border-line bg-surface p-8 shadow-[0_10px_40px_#243f6418]">
        <div className="mb-6">
          <Brand compact />
        </div>
        <h1 className="text-xl font-bold">{heading}</h1>
        {!link.token ? (
          <div className="mt-4 flex flex-col gap-3">
            <InlineError
              error={new ApiError(401, {
                code: "SESSION_EXPIRED",
                message_ja: "メールのリンクから開いてください。リンクの有効期限が切れている場合は再送してください。",
              })}
            />
            <Link to="/login" className="text-sm text-primary hover:underline">
              ログイン画面（パスワード再設定メールの再送）へ
            </Link>
          </div>
        ) : done ? (
          <div className="mt-4 flex flex-col gap-4">
            <p role="status" className="rounded-[var(--radius-control)] bg-success-soft px-3 py-2 text-sm text-success">
              {done.message}
            </p>
            {done.signIn === "web" ? (
              <Link to="/login" className="text-sm font-medium text-primary hover:underline">
                ログイン画面へ
              </Link>
            ) : (
              <p className="text-xs text-muted">ARMSのiOSアプリを開き、メールアドレスと設定したパスワードでログインしてください。</p>
            )}
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-4">
            <p className="text-xs text-muted">10文字以上で、英字と数字を両方含めてください。</p>
            <Field label="新しいパスワード" required error={fieldErrors.password}>
              {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
            <Field label="新しいパスワード（確認）" required error={fieldErrors.confirm}>
              {(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
            </Field>
            <InlineError error={error} />
            <Button type="submit" loading={busy} className="w-full">
              パスワードを設定
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}
