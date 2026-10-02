import type { ReactNode } from "react";
import { AlertTriangle, Inbox, RefreshCw, WifiOff } from "lucide-react";
import { ApiError, NetworkError, errorMessage } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { Button } from "./Button";
import { cn } from "./cn";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-neutral-soft", className)} />;
}

/** Table/list loading placeholder announced to assistive technology once. */
export function LoadingRows({ rows = 5, label = "読み込み中です" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3 py-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

/** Zero state that tells the user the next concrete action. */
export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <Inbox className="size-8 text-muted" aria-hidden />
      <p className="text-sm font-bold">{title}</p>
      {description ? <p className="max-w-md text-xs text-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Error with the Japanese API message, the request id for support and a retry button. */
export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const offline = error instanceof NetworkError;
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <div role="alert" className={cn("flex flex-col items-center gap-2 text-center", compact ? "py-4" : "px-4 py-10")}>
      {offline ? <WifiOff className="size-7 text-warning" aria-hidden /> : <AlertTriangle className="size-7 text-danger" aria-hidden />}
      <p className="text-sm font-bold">{offline ? "オフラインです" : "読み込みに失敗しました"}</p>
      <p className="max-w-md text-xs text-muted">{errorMessage(error)}</p>
      {requestId ? <p className="text-[11px] text-muted">問い合わせ番号: {requestId}</p> : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={onRetry}>
          再試行
        </Button>
      ) : null}
    </div>
  );
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="flex items-center gap-2 bg-warning-soft px-4 py-2 text-xs font-medium text-warning">
      <WifiOff className="size-4" aria-hidden />
      オフラインです。表示は最後に取得した内容で、変更操作はできません。
    </div>
  );
}

/** 「最終取得 10月2日（金）14:05」 from the API checked_at. */
export function LastFetched({ checkedAt, className }: { checkedAt?: string | null; className?: string }) {
  if (!checkedAt) return null;
  return <p className={cn("text-[11px] text-muted", className)}>最終取得 {fmt.dateTime(checkedAt)}</p>;
}

/** Inline form/mutation error banner (Japanese message + request id). */
export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <div role="alert" className="rounded-[var(--radius-control)] border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
      {errorMessage(error)}
      {requestId ? <span className="ml-2 opacity-80">（問い合わせ番号: {requestId}）</span> : null}
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warning" }) {
  return (
    <div className={cn("rounded-[var(--radius-control)] border-l-4 px-4 py-3 text-xs", tone === "info" ? "border-primary bg-primary-soft text-fg" : "border-warning bg-warning-soft text-fg")}>
      {children}
    </div>
  );
}
