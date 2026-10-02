import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { LoginInput } from "@arms/contracts";
import { Brand } from "../components/layout/Brand";
import { Button } from "../components/ui/Button";
import { Field, Input, Select } from "../components/ui/Field";
import { InlineError } from "../components/ui/Feedback";
import { ApiError, api } from "../lib/api";
import { useSession } from "../lib/session";
import { useOnline } from "../lib/online";

type Step = "credentials" | "mfa" | "reset";

/** WEB-01 ログイン: 利用区分（管理者/講師）+ メール + パスワード → 管理者は二段階認証。受講者はiOSアプリへ案内。 */
export function LoginPage() {
  const { state, login, enrollMfa, verifyMfa } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const online = useOnline();
  const next = new URLSearchParams(location.search).get("next") ?? "/dashboard";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";

  const [step, setStep] = useState<Step>(state.status === "mfa" ? "mfa" : "credentials");
  const [role, setRole] = useState<"admin" | "teacher">("admin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<{ qr_code: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [resetSent, setResetSent] = useState(false);

  if (state.status === "authenticated") return <Navigate to={safeNext} replace />;
  const mfaEnrolled = state.status === "mfa" ? state.session.mfa_enrolled : false;
  const effectiveStep: Step = state.status === "mfa" ? "mfa" : step === "mfa" ? "credentials" : step;

  const submitCredentials = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = LoginInput.safeParse({ email: email.trim(), password, selected_role: role });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[String(issue.path[0])] ??= issue.message;
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      const info = await login(parsed.data);
      if (info.mfa_required) {
        setStep("mfa");
        if (!info.mfa_enrolled) setEnrollment(await enrollMfa());
      } else navigate(safeNext, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setFieldErrors(err.fieldErrors);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const startEnrollment = async () => {
    setError(null);
    setBusy(true);
    try {
      setEnrollment(await enrollMfa());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setFieldErrors({ code: "6桁の数字を入力してください。" });
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      await verifyMfa(code);
      navigate(safeNext, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setFieldErrors(err.fieldErrors);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/password-reset", { email: email.trim() });
      setResetSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-bg lg:flex-row">
      <section className="flex flex-1 flex-col justify-center px-6 py-10 lg:px-20" aria-hidden="false">
        <div className="mb-10 lg:hidden">
          <Brand />
        </div>
        <p className="text-xs tracking-[0.1em] text-primary">ARMS / 新入社員研修システム</p>
        <h1 className="mt-4 text-4xl leading-tight font-bold text-fg lg:text-5xl">
          学びの一歩を、
          <br />
          成長につなげる。
        </h1>
        <p className="mt-4 text-sm text-muted">研修・教材・進捗・予約を、ひとつに。</p>
      </section>
      <section className="flex flex-1 items-center justify-center px-4 pb-12 lg:pb-0">
        <div className="w-full max-w-[420px] rounded-[20px] border border-line bg-surface p-8 shadow-[0_10px_40px_#243f6418]">
          <div className="mb-6 hidden lg:block">
            <Brand compact />
          </div>
          {state.status === "anonymous" && state.reason && effectiveStep === "credentials" && !error ? (
            <div className="mb-4">
              <InlineError error={new ApiError(401, { code: "SESSION_EXPIRED", message_ja: state.reason })} />
            </div>
          ) : null}

          {effectiveStep === "credentials" ? (
            <form onSubmit={submitCredentials} noValidate className="flex flex-col gap-4">
              <div>
                <h2 className="text-xl font-bold">ARMSにログイン</h2>
                <p className="mt-1 text-xs text-muted">管理者・講師向け管理画面</p>
              </div>
              <Field label="利用区分" required error={fieldErrors.selected_role}>
                {(p) => (
                  <Select {...p} value={role} onChange={(e) => setRole(e.target.value as "admin" | "teacher")}>
                    <option value="admin">管理者</option>
                    <option value="teacher">講師</option>
                  </Select>
                )}
              </Field>
              <Field label="メールアドレス" required error={fieldErrors.email}>
                {(p) => <Input {...p} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}
              </Field>
              <Field label="パスワード" required error={fieldErrors.password}>
                {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
              </Field>
              <InlineError error={error} />
              <Button type="submit" loading={busy} disabled={!online} className="mt-2 w-full">
                ログイン
              </Button>
              <button type="button" className="text-sm text-primary hover:underline" onClick={() => (setStep("reset"), setError(null), setResetSent(false))}>
                パスワードをお忘れですか？
              </button>
              <p className="text-center text-[11px] text-muted">受講者の方はiOSアプリをご利用ください。</p>
            </form>
          ) : null}

          {effectiveStep === "mfa" ? (
            <form onSubmit={submitCode} noValidate className="flex flex-col gap-4">
              <div>
                <h2 className="text-xl font-bold">二段階認証</h2>
                <p className="mt-1 text-xs text-muted">管理者は認証アプリのワンタイムコードが必要です。</p>
              </div>
              {!mfaEnrolled && !enrollment ? (
                <Button variant="secondary" loading={busy} onClick={startEnrollment}>
                  認証アプリを登録する
                </Button>
              ) : null}
              {enrollment ? (
                <div className="flex flex-col items-center gap-2 rounded-[var(--radius-control)] border border-line p-4">
                  <img src={enrollment.qr_code} alt="認証アプリ登録用QRコード" className="size-44 bg-white p-2" />
                  <p className="text-center text-[11px] text-muted">認証アプリ（Google Authenticator等）でQRコードを読み取り、表示された6桁のコードを入力してください。</p>
                </div>
              ) : null}
              <Field label="認証コード（6桁）" required error={fieldErrors.code}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  />
                )}
              </Field>
              <InlineError error={error} />
              <Button type="submit" loading={busy} disabled={!online || (!mfaEnrolled && !enrollment)} className="w-full">
                認証して続ける
              </Button>
            </form>
          ) : null}

          {effectiveStep === "reset" ? (
            <form onSubmit={submitReset} noValidate className="flex flex-col gap-4">
              <div>
                <h2 className="text-xl font-bold">パスワードの再設定</h2>
                <p className="mt-1 text-xs text-muted">登録済みのメールアドレスに再設定の案内を送信します。</p>
              </div>
              <Field label="メールアドレス" required>
                {(p) => <Input {...p} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}
              </Field>
              {resetSent ? (
                <p role="status" className="rounded-[var(--radius-control)] bg-success-soft px-3 py-2 text-xs text-success">
                  登録済みのメールアドレスの場合、再設定の案内を送信しました。メールをご確認ください。
                </p>
              ) : null}
              <InlineError error={error} />
              <Button type="submit" loading={busy} disabled={!online || !email.trim()} className="w-full">
                再設定メールを送信
              </Button>
              <button type="button" className="text-sm text-primary hover:underline" onClick={() => (setStep("credentials"), setError(null))}>
                ログイン画面に戻る
              </button>
            </form>
          ) : null}
        </div>
      </section>
    </div>
  );
}
