import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, RotateCcw, Upload } from "lucide-react";
import { IMPORT_ENTITY_LABELS } from "@arms/contracts";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { Checkbox } from "../../components/ui/Field";
import { InlineError, LastFetched, Notice } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/Toast";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { importsApi, type ImportJob } from "./api";
import { ImportStateBadge, Stat } from "./common";
import { ErrorReportButton, ItemsTable } from "./StepResult";

/** A request may stop at the server's time budget (state committing / rollback in progress); continue until done. */
const MAX_CONTINUATIONS = 100;

interface Props {
  job: ImportJob;
  checkedAt?: string;
  onBackToResult(): void;
  onStartOver(): void;
}

const people = (job: ImportJob) => job.entity === "teachers" || job.entity === "students";

/** 4 移行確定: confirmation (backup + optional invitations), commit with continuation, result and rollback. */
export function StepCommit({ job, checkedAt, onBackToResult, onStartOver }: Props) {
  const online = useOnline();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [backup, setBackup] = useState(false);
  const [backupError, setBackupError] = useState(false);
  const [sendInvitations, setSendInvitations] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);

  const publish = (next: ImportJob) => {
    queryClient.setQueryData(["imports", next.id], { data: next, checked_at: new Date().toISOString() });
    void queryClient.invalidateQueries({ queryKey: ["imports", "list"] });
    void queryClient.invalidateQueries({ queryKey: ["imports", next.id, "items"] });
  };

  const commit = useIdempotentMutation(
    async (vars: { send: boolean }, key: string) => {
      const body = { backup_confirmed: true as const, send_invitations: vars.send };
      let res = (await importsApi.commit(job.id, body, key)).data;
      for (let i = 0; i < MAX_CONTINUATIONS && res.state === "committing"; i++) {
        publish(res);
        res = (await importsApi.commit(job.id, body, key)).data;
      }
      return res;
    },
    {
      onSuccess(res) {
        publish(res);
        setConfirmOpen(false);
        if (res.state === "completed") toast.success("移行を確定しました", `${res.committed_rows.toLocaleString("ja-JP")}件を反映しました。`);
        else if (res.state === "failed") toast.error("移行の確定が途中で止まりました", res.failure?.message_ja);
      },
    },
  );

  const rollback = useIdempotentMutation(
    async (_vars: { jobId: string }, key: string) => {
      let res = (await importsApi.rollback(job.id, key)).data;
      for (let i = 0; i < MAX_CONTINUATIONS && res.state !== "rolled_back" && !res.failure; i++) {
        publish(res);
        res = (await importsApi.rollback(job.id, key)).data;
      }
      return res;
    },
    {
      onSuccess(res) {
        publish(res);
        setRollbackOpen(false);
        if (res.state === "rolled_back") {
          toast.success("移行を取り消しました", res.manual_review_rows > 0 ? `${res.manual_review_rows}件は手動照合が必要です。` : undefined);
        } else if (res.failure) toast.error("取り消しが途中で止まりました", res.failure.message_ja);
      },
    },
  );

  const toApply = job.new_rows + job.update_rows;
  const committed = job.state === "completed" || job.state === "rolled_back" || job.state === "failed" || job.state === "committing";
  const canRollback = (job.state === "completed" || job.state === "failed" || job.state === "committing") && job.committed_rows > 0;

  return (
    <Card aria-labelledby="import-step4">
      <CardHeader
        id="import-step4"
        title={`移行確定（${IMPORT_ENTITY_LABELS[job.entity]}）`}
        description={`ファイル: ${job.filename}`}
        actions={
          <div className="flex flex-col items-end gap-1">
            <ImportStateBadge job={job} />
            <LastFetched checkedAt={checkedAt} />
          </div>
        }
      />

      {job.state === "validated" ? (
        <>
          <div className="flex flex-wrap gap-6">
            <Stat label="新規に登録" value={job.new_rows} />
            <Stat label="更新" value={job.update_rows} />
            <Stat label="変更なし（反映しない）" value={job.skip_rows} />
          </div>
          <div className="mt-4">
            <Notice tone="warning">
              確定すると組織のデータに反映されます。確定の前に、データベースのバックアップを取得してください。確定後に取り消すと、移行後に編集された行は変更せず「手動照合が必要」として残します。
            </Notice>
          </div>
          <div className="mt-6 flex flex-wrap justify-between gap-2">
            <Button variant="secondary" onClick={onBackToResult}>
              検証結果に戻る
            </Button>
            <Button icon={<Upload className="size-4" aria-hidden />} disabled={!online || toApply === 0 || job.error_rows > 0} onClick={() => setConfirmOpen(true)}>
              移行を確定
            </Button>
          </div>
          {toApply === 0 ? <p className="mt-2 text-right text-xs text-muted">反映する行がありません（すべて変更なし）。</p> : null}
        </>
      ) : null}

      {committed ? (
        <>
          <div className="flex flex-wrap gap-6">
            <Stat label="反映済み" value={job.committed_rows} />
            <Stat label="確定時の競合（未反映）" value={job.conflict_rows} tone={job.conflict_rows > 0 ? "warning" : undefined} />
            {job.rollback_started || job.state === "rolled_back" ? (
              <>
                <Stat label="取り消し済み" value={job.reverted_rows} />
                <Stat label="手動照合が必要" value={job.manual_review_rows} tone={job.manual_review_rows > 0 ? "warning" : undefined} />
              </>
            ) : null}
          </div>
          {job.invitations ? (
            <p className="mt-3 text-xs text-muted">
              招待メール: 送信済み {job.invitations.sent}件・送信失敗 {job.invitations.failed}件・未送信 {job.invitations.not_sent}件
              {job.invitations.not_sent > 0 ? "（講師管理・ユーザー管理から送信できます）" : ""}
            </p>
          ) : null}
          {job.committed_at ? <p className="mt-1 text-xs text-muted">確定 {fmt.dateTime(job.committed_at)}</p> : null}
          {job.rolled_back_at ? <p className="mt-1 text-xs text-muted">取り消し {fmt.dateTime(job.rolled_back_at)}</p> : null}
          {job.failure ? (
            <div className="mt-4">
              <Notice tone="warning">
                {job.failure.message_ja}
                {job.failure.from_row !== null ? `（${job.failure.from_row}行目〜${job.failure.to_row}行目の処理を取り消しました）` : ""}
                {job.rollback_started ? "「取り消しを再開」で続きから処理します。" : "「続きから再開」で未反映の行から処理します。"}
              </Notice>
            </div>
          ) : null}
          {job.state === "rolled_back" && job.manual_review_rows > 0 ? (
            <div className="mt-4">
              <Notice tone="warning">移行後に編集された行など {job.manual_review_rows} 件は元に戻していません。結果明細を確認し、手動で照合してください。</Notice>
            </div>
          ) : null}
          {commit.error ? (
            <div className="mt-4">
              <InlineError error={commit.error} />
            </div>
          ) : null}
          {rollback.error ? (
            <div className="mt-4">
              <InlineError error={rollback.error} />
            </div>
          ) : null}
          <ItemsTable job={job} initialFilter={job.manual_review_rows > 0 ? "manual" : job.conflict_rows > 0 ? "conflict" : "all"} />
          <div className="mt-6 flex flex-wrap items-start justify-end gap-2">
            <ErrorReportButton jobId={job.id} />
            {(job.state === "failed" || job.state === "committing") && !job.rollback_started ? (
              <Button disabled={!online} loading={commit.isPending} onClick={() => commit.mutate({ send: job.options?.send_invitations ?? false })}>
                続きから再開
              </Button>
            ) : null}
            {canRollback ? (
              <Button variant="danger" icon={<RotateCcw className="size-4" aria-hidden />} disabled={!online} loading={rollback.isPending} onClick={() => setRollbackOpen(true)}>
                {job.rollback_started ? "取り消しを再開" : "この移行を取り消す"}
              </Button>
            ) : null}
            <Button variant="secondary" icon={<CheckCircle2 className="size-4" aria-hidden />} onClick={onStartOver}>
              別のファイルを移行
            </Button>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) {
            setBackup(false);
            setBackupError(false);
          }
        }}
        title="移行を確定しますか？"
        tone="primary"
        confirmLabel="確定する"
        loading={commit.isPending}
        onConfirm={() => {
          if (!backup) setBackupError(true);
          else commit.mutate({ send: sendInvitations });
        }}
        description={
          <p>
            {IMPORT_ENTITY_LABELS[job.entity]}：新規 {job.new_rows.toLocaleString("ja-JP")}件・更新 {job.update_rows.toLocaleString("ja-JP")}件を反映します
            （変更なし {job.skip_rows.toLocaleString("ja-JP")}件は反映しません）。
          </p>
        }
      >
        <div className="flex flex-col gap-2">
          <Checkbox
            label="移行前にデータベースのバックアップを取得しました"
            checked={backup}
            aria-invalid={backupError}
            onChange={(e) => {
              setBackup(e.target.checked);
              setBackupError(false);
            }}
          />
          {backupError ? (
            <p role="alert" className="text-xs font-medium text-danger">
              移行前にバックアップを取得したことを確認してください。
            </p>
          ) : (
            <p className="text-xs text-muted">バックアップの取得を確認すると確定できます。</p>
          )}
          {people(job) ? (
            <>
              <Checkbox label="招待メールを送信" checked={sendInvitations} onChange={(e) => setSendInvitations(e.target.checked)} />
              <p className="text-xs text-muted">
                送信しない場合はアカウントだけを作成し「招待メール送信待ち」になります。講師管理・ユーザー管理から後で送信できます。パスワードは移行しません。
              </p>
            </>
          ) : null}
          {commit.error ? <InlineError error={commit.error} /> : null}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        title="この移行を取り消しますか？"
        confirmLabel="取り消す"
        loading={rollback.isPending}
        onConfirm={() => rollback.mutate({ jobId: job.id })}
        description={
          <div className="space-y-2">
            <p>
              移行で反映した {job.committed_rows.toLocaleString("ja-JP")}件を元に戻します。移行で作成した{job.entity === "progress" ? "進捗" : job.entity === "classrooms" ? "クラス" : "データ"}
              は削除し、更新した行は移行前の値に戻します。
            </p>
            <p>移行後に編集された行は変更せず「手動照合が必要」として残します。</p>
            {people(job) ? <p>講師・新入社員のアカウントは削除せず停止します（ログイン済みの可能性があるため）。</p> : null}
          </div>
        }
      >
        {rollback.error ? <InlineError error={rollback.error} /> : null}
      </ConfirmDialog>
    </Card>
  );
}
