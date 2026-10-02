import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ProgressStateBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { ErrorState, LastFetched, LoadingRows } from "../../components/ui/Feedback";
import { PageHeader } from "../../components/ui/PageHeader";
import { Timeline } from "../../components/ui/Timeline";
import { useToast } from "../../components/ui/Toast";
import { ApiError, api } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { learningKeys, type DataResponse, type ProgressRecord, type ProgressRecordDetail } from "../../features/learning/api";
import { fullDateLabel, progressColumnLabels } from "../../features/learning/format";
import { changeLines, eventLabel } from "../../features/learning/progress/history";
import { ProgressRecordForm, recordToValues, type RecordFormValues } from "../../features/learning/progress/ProgressRecordForm";
import { StudentSummary } from "../../features/learning/progress/StudentSummary";

function RecordView({ r }: { r: ProgressRecordDetail }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
      <dt className="text-xs font-bold text-muted">{progressColumnLabels.due_date}</dt>
      <dd className="tabular-nums">{fullDateLabel(r.due_date)}</dd>
      <dt className="text-xs font-bold text-muted">{progressColumnLabels.student_name}</dt>
      <dd>
        {r.student_name}
        <span className="ml-2 text-xs text-muted">社員番号 {r.employee_number}</span>
      </dd>
      <dt className="text-xs font-bold text-muted">{progressColumnLabels.department_name}</dt>
      <dd>{r.department_name}</dd>
      <dt className="text-xs font-bold text-muted">{progressColumnLabels.teacher_name}</dt>
      <dd>{r.teacher_name}</dd>
      <dt className="text-xs font-bold text-muted">{progressColumnLabels.content}</dt>
      <dd className="break-words whitespace-pre-wrap">{r.content}</dd>
      <dt className="text-xs font-bold text-muted">状態</dt>
      <dd>
        <ProgressStateBadge state={r.state} overdue={r.overdue} />
        {r.overdue ? <span className="ml-2 text-xs text-muted">終了予定日を過ぎていて未完了です</span> : null}
      </dd>
      <dt className="text-xs font-bold text-muted">備考</dt>
      <dd className="break-words whitespace-pre-wrap">{r.notes || <span className="text-muted">なし</span>}</dd>
      <dt className="text-xs font-bold text-muted">更新</dt>
      <dd className="text-xs text-muted">
        登録 {fmt.dateTime(r.created_at)}・最終更新 {fmt.dateTime(r.updated_at)}
      </dd>
    </dl>
  );
}

/** 教育記録の詳細 (/progress/records/:id): legacy columns, correction with 訂正理由 (If-Match), history timeline. */
export function ProgressRecordPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const editing = params.get("mode") === "edit";
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const detail = useQuery({ queryKey: learningKeys.record(id), queryFn: () => api.get<DataResponse<ProgressRecordDetail>>(`/progress-records/${id}`) });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const setEditing = (on: boolean) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (on) next.set("mode", "edit");
        else next.delete("mode");
        return next;
      },
      { replace: true },
    );

  if (detail.isLoading) return <LoadingRows rows={6} label="教育記録を読み込み中です" />;
  if (detail.error || !detail.data) {
    return (
      <>
        <PageHeader title="教育記録の詳細" crumbs={[{ label: "社員教育進捗管理", to: "/progress" }, { label: "教育記録の詳細" }]} />
        <Card>
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
        </Card>
      </>
    );
  }
  const r = detail.data.data;
  const conflict = saveError instanceof ApiError && saveError.code === "VERSION_CONFLICT";

  const save = async (values: RecordFormValues): Promise<RecordFormValues | void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.patch<DataResponse<ProgressRecord>>(`/progress-records/${r.id}`, values, { ifMatch: r.row_version });
      toast.success("教育記録を訂正しました", "変更内容と訂正理由を履歴に記録しました。");
      await qc.invalidateQueries({ queryKey: learningKeys.record(r.id) });
      void qc.invalidateQueries({ queryKey: ["learning", "records"] });
      void qc.invalidateQueries({ queryKey: learningKeys.studentRecords(r.student_id) });
      setEditing(false);
      return recordToValues(res.data);
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title={`${r.student_name}さんの教育記録`}
        crumbs={[{ label: "社員教育進捗管理", to: `/progress?month=${r.due_date.slice(0, 7)}` }, { label: `${r.student_name}さんの教育記録` }]}
        actions={
          <Link to={`/progress/students/${r.student_id}`} className="inline-flex h-10 items-center rounded-[var(--radius-control)] border border-line bg-surface px-4 text-sm font-medium hover:bg-surface-2">
            教育進捗の詳細を見る
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <Card aria-labelledby="summary-heading">
          <CardHeader id="summary-heading" title="研修サマリー" />
          <StudentSummary
            name={r.student_name}
            meta={[r.department_name, r.classroom_name, `社員番号 ${r.employee_number}`].filter(Boolean).join(" · ")}
            percent={r.progress_percent}
            footer={
              <>
                終了予定：{fullDateLabel(r.due_date)}
                {r.progress_percent === null ? <span className="ml-3">（受講が割り当てられていないため進捗率は未設定です）</span> : null}
              </>
            }
          />
          <LastFetched checkedAt={detail.data.checked_at} className="mt-4" />
        </Card>
        <Card aria-labelledby="record-heading">
          <CardHeader
            id="record-heading"
            title={editing ? "教育記録を編集" : "教育記録"}
            description={editing ? "値を変更すると訂正理由が必要です。変更前後と理由は履歴に残ります。" : undefined}
            actions={
              editing ? null : (
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)} disabled={!online}>
                  訂正する
                </Button>
              )
            }
          />
          {conflict ? (
            <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] border border-warning/50 bg-warning-soft px-3 py-2 text-xs">
              他の利用者がこの記録を更新しました。最新の内容を読み込んでから、もう一度訂正してください。
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  setSaveError(null);
                  await detail.refetch();
                }}
              >
                最新の内容を読み込む
              </Button>
            </div>
          ) : null}
          {editing ? (
            <ProgressRecordForm
              key={`${r.id}-${r.row_version}`}
              record={r}
              submitting={saving}
              submitError={conflict ? null : saveError}
              guardNavigation
              onCancel={() => {
                setSaveError(null);
                setEditing(false);
              }}
              onSubmit={save}
            />
          ) : (
            <RecordView r={r} />
          )}
        </Card>
      </div>
      <Card aria-labelledby="history-heading" className="mt-5">
        <CardHeader id="history-heading" title="変更履歴" description="登録・訂正の日時、実施者、変更前後の値と訂正理由です。" />
        {r.history.length === 0 ? (
          <p className="text-sm text-muted">履歴はありません。</p>
        ) : (
          <Timeline
            label="教育記録の変更履歴"
            items={r.history.map((h) => {
              const lines = changeLines(h);
              const created = h.event_type === "progress_record.created";
              return {
                id: h.id,
                at: h.created_at,
                atLabel: fmt.dateTime(h.created_at),
                actor: h.actor_name ?? "システム",
                title: eventLabel(h.event_type),
                body: (
                  <>
                    {created ? null : (
                      <ul className="flex flex-col gap-0.5">
                        {lines.map((l) => (
                          <li key={l.field}>
                            {l.label}：<span className="line-through decoration-1">{l.before}</span> → <span className="font-medium text-fg">{l.after}</span>
                            <span className="sr-only">（変更前 {l.before}、変更後 {l.after}）</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {h.reason ? <p className="mt-1">訂正理由：{h.reason}</p> : null}
                  </>
                ),
              };
            })}
          />
        )}
      </Card>
    </>
  );
}
