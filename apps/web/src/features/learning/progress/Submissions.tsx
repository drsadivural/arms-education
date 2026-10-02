import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SCAN_STATE_LABELS, SUBMISSION_STATE_LABELS } from "@arms/contracts";
import { ExternalLink } from "lucide-react";
import { Badge, type Tone } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Dialog } from "../../../components/ui/Dialog";
import { InlineError } from "../../../components/ui/Feedback";
import { Field, Textarea } from "../../../components/ui/Field";
import { useToast } from "../../../components/ui/Toast";
import { ApiError, api } from "../../../lib/api";
import { fmt } from "../../../lib/format";
import { useOnline } from "../../../lib/online";
import { useIdempotentMutation } from "../../../lib/query";
import { learningKeys, type DataResponse, type Download, type Submission } from "../api";
import { useDiscardConfirm } from "../useDiscardConfirm";

const SUBMISSION_TONE: Record<Submission["state"], Tone> = { submitted: "warning", accepted: "success", revision_requested: "danger" };

export function SubmissionStateBadge({ state }: { state: Submission["state"] | null }) {
  if (!state) return <span className="text-xs text-muted">未提出</span>;
  return <Badge tone={SUBMISSION_TONE[state]}>{SUBMISSION_STATE_LABELS[state]}</Badge>;
}

/** 提出ファイル: fetches a fresh 5-minute URL on demand (admin / teacher in scope), then offers it as a link. */
export function SubmissionFileLink({ submission }: { submission: Submission }) {
  const [url, setUrl] = useState<Download | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  if (!submission.has_file) return <span className="text-xs text-muted">ファイルなし</span>;
  if (submission.scan_state !== "clean") {
    return (
      <span className="text-xs text-muted">
        {submission.filename ?? "提出ファイル"}：{SCAN_STATE_LABELS[submission.scan_state]}
        {submission.scan_state === "pending" ? "（検査完了後に開けます）" : ""}
      </span>
    );
  }
  if (url) {
    return (
      <span className="flex flex-col gap-0.5">
        <a href={url.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline">
          <ExternalLink className="size-3.5" aria-hidden />
          {submission.filename ?? "提出ファイル"}を開く
        </a>
        <span className="text-[11px] text-muted">{fmt.time(url.expires_at)}まで有効（5分間）</span>
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      <Button
        variant="secondary"
        size="sm"
        loading={loading}
        onClick={async () => {
          setLoading(true);
          setError(null);
          try {
            setUrl((await api.get<DataResponse<Download>>(`/submissions/${submission.id}/file`)).data);
          } catch (e) {
            setError(e);
          } finally {
            setLoading(false);
          }
        }}
      >
        提出ファイルを確認
      </Button>
      {error ? <InlineError error={error} /> : null}
    </span>
  );
}

/** 課題の評価: 承認 or 再提出依頼 (reason required) with expected_version (optimistic concurrency). */
export function ReviewDialog({ submission, studentId, onClose }: { submission: Submission; studentId: string; onClose(): void }) {
  const [decision, setDecision] = useState<"accepted" | "revision_requested">("accepted");
  const [feedback, setFeedback] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const review = useIdempotentMutation((body: unknown, key: string) => api.post<DataResponse<Submission>>(`/submissions/${submission.id}/review`, body, { idempotencyKey: key }));
  const discard = useDiscardConfirm(feedback.trim().length > 0, onClose);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (decision === "revision_requested" && !feedback.trim()) {
      setFieldError("再提出を依頼する理由を入力してください。");
      return;
    }
    setFieldError(null);
    try {
      await review.mutateAsync({ state: decision, feedback: feedback.trim(), expected_version: submission.row_version });
      toast.success(decision === "accepted" ? "課題を承認しました" : "再提出を依頼しました", `${submission.student_name}さん・${submission.material_title}`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: learningKeys.submissions(studentId) }),
        qc.invalidateQueries({ queryKey: learningKeys.studentProgress(studentId) }),
      ]);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.feedback) setFieldError(err.fieldErrors.feedback);
    }
  };

  const stale = review.error instanceof ApiError && (review.error.code === "VERSION_CONFLICT" || review.error.code === "INVALID_STATE");
  return (
    <Dialog open onOpenChange={(o) => !o && !review.isPending && discard.requestClose()} title="課題を評価" description={`${submission.student_name}さん・${submission.unit_title}「${submission.material_title}」`}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="rounded-[var(--radius-control)] border border-line p-3 text-sm">
          <p className="text-xs text-muted">提出日時 {fmt.dateTime(submission.submitted_at)}</p>
          {submission.body ? <p className="mt-2 break-words whitespace-pre-wrap">{submission.body}</p> : <p className="mt-2 text-xs text-muted">本文なし</p>}
          <div className="mt-2">
            <SubmissionFileLink submission={submission} />
          </div>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-bold">
            評価<span className="ml-1 text-danger" aria-hidden>*</span>
          </legend>
          <label className="inline-flex min-h-10 items-center gap-2 text-sm">
            <input type="radio" name="decision" value="accepted" checked={decision === "accepted"} onChange={() => setDecision("accepted")} className="size-4 accent-[var(--arms-primary)]" />
            承認する（単元の完了条件を満たします）
          </label>
          <label className="inline-flex min-h-10 items-center gap-2 text-sm">
            <input
              type="radio"
              name="decision"
              value="revision_requested"
              checked={decision === "revision_requested"}
              onChange={() => setDecision("revision_requested")}
              className="size-4 accent-[var(--arms-primary)]"
            />
            再提出を依頼する
          </label>
        </fieldset>
        <Field label={decision === "revision_requested" ? "再提出を依頼する理由（受講者に表示）" : "講師コメント（任意・受講者に表示）"} required={decision === "revision_requested"} error={fieldError ?? undefined}>
          {(p) => <Textarea {...p} maxLength={2000} value={feedback} onChange={(e) => setFeedback(e.target.value)} />}
        </Field>
        {stale ? (
          <p role="alert" className="rounded-[var(--radius-control)] border border-warning/50 bg-warning-soft px-3 py-2 text-xs">
            {review.error instanceof ApiError ? review.error.messageJa : ""} 一覧を再読み込みして最新の提出を確認してください。
          </p>
        ) : (
          <InlineError error={review.error && !(review.error instanceof ApiError && review.error.fieldErrors.feedback) ? review.error : null} />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={discard.requestClose} disabled={review.isPending}>
            キャンセル
          </Button>
          <Button type="submit" variant={decision === "accepted" ? "primary" : "danger"} loading={review.isPending} disabled={!online}>
            {decision === "accepted" ? "承認する" : "再提出を依頼する"}
          </Button>
        </div>
      </form>
      {discard.element}
    </Dialog>
  );
}
