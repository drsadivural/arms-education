/**
 * WEB-17 既存システムからのデータ移植 (hosted by the Settings page in the 「データ移植」 tab).
 *
 * 1 ファイル選択   CSV + 移行するデータ + 移行元システム名, local 文字コード・プレビュー, quarantined upload
 *                  (POST /uploads → presigned PUT → /uploads/{id}/complete → file scan)
 * 2 項目の対応     ARMS field ← CSV column (required markers, meaning of empty cells), then the dry run
 * 3 検証結果       counts, column status, Japanese row errors (+ error CSV), planned rows
 * 4 移行確定       confirmation (backup ticked, optional invitation e-mails), commit, result and rollback
 * plus the job history (open a job to continue at its step).
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ErrorState, LoadingRows, OfflineBanner } from "../../components/ui/Feedback";
import { importsApi, type ImportJob } from "./api";
import { draftFromJob, stepOfJob, StepIndicator, type Draft, type Step } from "./common";
import { ImportHistory } from "./ImportHistory";
import { StepCommit } from "./StepCommit";
import { StepMapping } from "./StepMapping";
import { StepResult } from "./StepResult";
import { StepUpload } from "./StepUpload";

export function ImportPanel() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [moreErrors, setMoreErrors] = useState<{ errors: ImportJob["errors"]; next: string | null; version: number } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);

  const jobQuery = useQuery({
    queryKey: ["imports", jobId],
    queryFn: () => importsApi.get(jobId as string),
    enabled: jobId !== null,
  });
  const job = jobQuery.data?.data ?? null;

  // Extra error pages belong to one dry run; a new dry run (row_version) starts over.
  useEffect(() => {
    if (job && moreErrors && moreErrors.version !== job.row_version) setMoreErrors(null);
  }, [job, moreErrors]);

  function open(next: ImportJob) {
    setJobId(next.id);
    setDraft(draftFromJob(next));
    setMoreErrors(null);
    setStep(stepOfJob(next));
  }

  function startOver() {
    setJobId(null);
    setDraft(null);
    setMoreErrors(null);
    setStep(1);
  }

  async function loadMoreErrors() {
    if (!job) return;
    const cursor = moreErrors?.next ?? job.errors_next_cursor;
    if (!cursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const res = await importsApi.get(job.id, cursor);
      setMoreErrors({ errors: [...(moreErrors?.errors ?? []), ...res.data.errors], next: res.data.errors_next_cursor, version: job.row_version });
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  const errors = job ? [...job.errors, ...(moreErrors?.errors ?? [])] : [];
  const nextErrors = moreErrors ? moreErrors.next : (job?.errors_next_cursor ?? null);
  const needsJob = step >= 3 || (step === 2 && jobId !== null && !draft);

  let body;
  if (needsJob && jobId && !job) {
    body = jobQuery.error ? <ErrorState error={jobQuery.error} onRetry={() => void jobQuery.refetch()} /> : <LoadingRows rows={4} />;
  } else if (step === 1) {
    body = (
      <StepUpload
        onUploaded={(d) => {
          setDraft(d);
          setJobId(null);
          setStep(2);
        }}
      />
    );
  } else if (step === 2 && draft) {
    body = (
      <StepMapping
        key={draft.uploadId}
        draft={draft}
        job={job}
        onJobCreated={(created) => setJobId(created.id)}
        onValidated={(validated) => {
          queryClient.setQueryData(["imports", validated.id], { data: validated, checked_at: new Date().toISOString() });
          setJobId(validated.id);
          setMoreErrors(null);
          setStep(3);
        }}
        onBack={() => (job?.state === "validated" ? setStep(3) : startOver())}
      />
    );
  } else if (step === 3 && job) {
    body = (
      <>
        <StepResult
          job={job}
          checkedAt={jobQuery.data?.checked_at}
          errors={errors}
          loadingMoreErrors={loadingMore}
          onMoreErrors={nextErrors ? () => void loadMoreErrors() : undefined}
          onEditMapping={() => {
            setDraft((d) => d ?? draftFromJob(job));
            setStep(2);
          }}
          onProceed={() => setStep(4)}
        />
        {moreError ? <ErrorState compact error={moreError} onRetry={() => void loadMoreErrors()} /> : null}
      </>
    );
  } else if (step === 4 && job) {
    body = <StepCommit job={job} checkedAt={jobQuery.data?.checked_at} onBackToResult={() => setStep(3)} onStartOver={startOver} />;
  } else {
    body = null;
  }

  return (
    <div>
      <OfflineBanner />
      <StepIndicator step={step} />
      {body}
      <ImportHistory currentJobId={jobId} onOpen={open} />
    </div>
  );
}
