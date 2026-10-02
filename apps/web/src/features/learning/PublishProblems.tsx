import { AlertTriangle } from "lucide-react";
import { ApiError, errorMessage } from "../../lib/api";
import type { PublishProblem } from "./api";

/** Publish blockers from `details.problems` (VERSION_NOT_PUBLISHABLE, MATERIAL_NOT_PUBLISHABLE, SCAN_PENDING…). */
export function problemsOf(error: unknown): PublishProblem[] {
  if (!(error instanceof ApiError)) return [];
  const list = error.details.problems;
  if (!Array.isArray(list)) return [];
  return list.filter((p): p is PublishProblem => !!p && typeof p === "object" && typeof (p as PublishProblem).message_ja === "string");
}

/** What the user can do about each blocking code, in Japanese. */
const NEXT_STEP: Record<string, string> = {
  SCANNER_UNAVAILABLE: "ファイル検査サービスが接続されるまで、ファイル教材を含むバージョン・教材は公開できません。管理者に検査サービスの設定を依頼してください。",
  SCAN_PENDING: "ファイル検査の完了をお待ちください。検査が完了すると公開できます。",
  VERSION_NOT_PUBLISHABLE: "下記の項目を修正してから、もう一度公開してください。",
  MATERIAL_NOT_PUBLISHABLE: "下記の項目を修正してから、もう一度公開してください。",
  PUBLISHED_VERSION_IMMUTABLE: "公開済みのバージョンは変更できません。「新しいバージョンを作成」から下書きを作成してください。",
  PROGRAM_ARCHIVED: "アーカイブ済みのプログラムは変更できません。",
};

/** Error banner for publish/scan failures: the API message, the next step and each blocking item. */
export function PublishProblems({ error }: { error: unknown }) {
  if (!error) return null;
  const problems = problemsOf(error);
  const code = error instanceof ApiError ? error.code : null;
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <div role="alert" className="rounded-[var(--radius-control)] border border-danger/60 bg-danger-soft px-3 py-2 text-xs text-fg">
      <p className="flex items-start gap-1.5 font-bold">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-danger" aria-hidden />
        {errorMessage(error)}
      </p>
      {code && NEXT_STEP[code] ? <p className="mt-1">{NEXT_STEP[code]}</p> : null}
      {problems.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {problems.map((p, i) => (
            <li key={`${p.code}-${p.material_id ?? p.unit_id ?? i}`}>{p.message_ja}</li>
          ))}
        </ul>
      ) : null}
      {requestId ? <p className="mt-1 opacity-80">問い合わせ番号: {requestId}</p> : null}
    </div>
  );
}
