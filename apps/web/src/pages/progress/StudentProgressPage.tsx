import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ADMIN_EVENT_LABELS, SUBMISSION_STATE_LABELS } from "@arms/contracts";
import { Badge, ProgressStateBadge, UnitStateBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { EmptyState, ErrorState, LastFetched, LoadingRows } from "../../components/ui/Feedback";
import { PageHeader } from "../../components/ui/PageHeader";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { Timeline, type TimelineItem } from "../../components/ui/Timeline";
import { api } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { useCurrentUser } from "../../lib/session";
import {
  learningKeys,
  type AuditEvent,
  type DataResponse,
  type EnrollmentProgress,
  type Page,
  type Progress,
  type ProgressRecord,
  type Student,
  type Submission,
  type UnitProgress,
} from "../../features/learning/api";
import { fullDateLabel, progressColumnLabels, versionLabel } from "../../features/learning/format";
import { StudentSummary } from "../../features/learning/progress/StudentSummary";
import { ReviewDialog, SubmissionFileLink, SubmissionStateBadge } from "../../features/learning/progress/Submissions";

type ProgressResponse = Progress & { checked_at: string };

function EnrollmentCard({ e }: { e: EnrollmentProgress }) {
  return (
    <article aria-label={`${e.program_name} ${versionLabel(e.version_number)}`} className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">{e.program_name}</h3>
          <p className="text-xs text-muted">割当バージョン {versionLabel(e.version_number)}（受講中は変わりません）</p>
        </div>
        {e.overdue ? <Badge tone="danger">期限超過</Badge> : e.progress_percent === 100 ? <Badge tone="success">修了</Badge> : <Badge tone="info">受講中</Badge>}
      </div>
      <ProgressBar value={e.progress_percent} label={`${e.program_name}の進捗`} />
      <p className="text-xs text-muted">
        必須単元 {e.required_completed} / {e.required_total} 完了・修了期限 {fullDateLabel(e.due_on)}
      </p>
    </article>
  );
}

function quizCell(u: UnitProgress): string {
  if (u.quiz_passed === null) return "—";
  if (u.score === null) return "未受験";
  return `${u.score}点・${u.quiz_passed ? "合格" : "不合格"}`;
}

function UnitsTable({ units, multiProgram }: { units: UnitProgress[]; multiProgram: boolean }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="単元別の状況（横にスクロールできます）">
      <table className="w-full min-w-[960px] text-sm">
        <caption className="sr-only">単元別の状況</caption>
        <thead>
          <tr className="bg-surface-2 text-left text-xs text-muted">
            <th scope="col" className="px-3 py-3 font-medium">単元</th>
            <th scope="col" className="px-3 py-3 font-medium">区分・重み</th>
            <th scope="col" className="px-3 py-3 font-medium">教材確認</th>
            <th scope="col" className="px-3 py-3 font-medium">テスト</th>
            <th scope="col" className="px-3 py-3 font-medium">課題・講師評価</th>
            <th scope="col" className="px-3 py-3 font-medium">出席</th>
            <th scope="col" className="px-3 py-3 font-medium">状態</th>
          </tr>
        </thead>
        <tbody>
          {units.map((u) => (
            <tr key={`${u.enrollment_id}-${u.id}`} className="border-b border-line last:border-b-0">
              <td className="px-3 py-3">
                <span className="font-medium">{u.title}</span>
                {multiProgram ? <span className="block text-[11px] text-muted">{u.program_name}</span> : null}
              </td>
              <td className="px-3 py-3 text-xs">
                {u.required ? "必須" : "任意"}・重み {u.weight}
              </td>
              <td className="px-3 py-3 text-xs tabular-nums">{u.materials_total === 0 ? "—" : `${u.materials_confirmed} / ${u.materials_total} 確認済み`}</td>
              <td className="px-3 py-3 text-xs">{quizCell(u)}</td>
              <td className="px-3 py-3 text-xs">
                {u.submission_state ? SUBMISSION_STATE_LABELS[u.submission_state] : u.requires_review ? "未提出" : "—"}
                {u.feedback ? <span className="block max-w-[220px] truncate text-muted" title={u.feedback}>コメント：{u.feedback}</span> : null}
              </td>
              <td className="px-3 py-3 text-xs">{u.attendance_required ? (u.attendance_satisfied ? "出席済み" : "未出席") : "—"}</td>
              <td className="px-3 py-3">
                <UnitStateBadge state={u.state} />
                {u.completed_at ? <span className="mt-1 block text-[11px] text-muted">{fmt.dateTime(u.completed_at)}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STUDENT_EVENT_LABELS: Record<string, string> = {
  ...ADMIN_EVENT_LABELS,
  "progress.enrolled": "受講を割当",
};

function eventDetail(e: AuditEvent): string | null {
  const d = e.details as Record<string, unknown>;
  if (e.event_type === "progress.enrolled" && typeof d.program_name === "string") {
    return `${d.program_name} ${typeof d.version_number === "number" ? versionLabel(d.version_number) : ""} を割当${typeof d.due_on === "string" ? `（修了期限 ${fullDateLabel(d.due_on)}）` : ""}`;
  }
  return null;
}

/**
 * History built from what the API provides: unit completions (progress service), assignment submissions and
 * reviews, and — for administrators — the audit events of the student (受講割当・所属変更など).
 */
export function buildStudentHistory(units: UnitProgress[], submissions: Submission[], events: AuditEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const u of units) {
    if (u.completed_at) items.push({ id: `unit-${u.enrollment_id}-${u.id}`, at: u.completed_at, atLabel: fmt.dateTime(u.completed_at), actor: "システム", title: `「${u.title}」を完了`, body: u.program_name });
  }
  for (const s of submissions) {
    items.push({ id: `sub-${s.id}`, at: s.submitted_at, atLabel: fmt.dateTime(s.submitted_at), actor: s.student_name, title: `「${s.material_title}」を提出`, body: s.unit_title });
    if (s.reviewed_at) {
      items.push({
        id: `rev-${s.id}`,
        at: s.reviewed_at,
        atLabel: fmt.dateTime(s.reviewed_at),
        actor: s.reviewer_name ?? "講師",
        title: `「${s.material_title}」を${s.state === "accepted" ? "承認" : "再提出依頼"}`,
        body: s.feedback ? `コメント：${s.feedback}` : undefined,
      });
    }
  }
  for (const e of events) {
    items.push({ id: `ev-${e.id}`, at: e.created_at, atLabel: fmt.dateTime(e.created_at), actor: e.actor_name, title: STUDENT_EVENT_LABELS[e.event_type as keyof typeof STUDENT_EVENT_LABELS] ?? e.event_type, body: eventDetail(e) ?? undefined });
  }
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** WEB-12 「○○さんの教育進捗」: overall/enrollment progress, per-unit conditions, assignment review, records, history. */
export function StudentProgressPage() {
  const { id = "" } = useParams();
  const user = useCurrentUser();
  const online = useOnline();
  const progress = useQuery({ queryKey: learningKeys.studentProgress(id), queryFn: () => api.get<ProgressResponse>(`/students/${id}/progress`) });
  const student = useQuery({ queryKey: ["learning", "student", id], queryFn: () => api.get<DataResponse<Student>>(`/students/${id}`), enabled: progress.isSuccess, retry: false });
  const submissions = useQuery({
    queryKey: learningKeys.submissions(id),
    queryFn: () => api.get<Page<Submission>>("/submissions", { query: { student_id: id, limit: 100 } }),
    enabled: progress.isSuccess,
  });
  const records = useQuery({
    queryKey: learningKeys.studentRecords(id),
    queryFn: () => api.get<Page<ProgressRecord>>("/progress-records", { query: { student_id: id, limit: 100 } }),
    enabled: progress.isSuccess,
  });
  const events = useQuery({
    queryKey: learningKeys.studentEvents(id),
    queryFn: () => api.get<Page<AuditEvent>>("/events", { query: { entity_id: id, limit: 50 } }),
    enabled: progress.isSuccess && user.isAdmin,
  });
  const [reviewing, setReviewing] = useState<Submission | null>(null);

  const history = useMemo(
    () => buildStudentHistory(progress.data?.units ?? [], submissions.data?.items ?? [], events.data?.items ?? []),
    [progress.data, submissions.data, events.data],
  );

  if (progress.isLoading) return <LoadingRows rows={6} label="教育進捗を読み込み中です" />;
  if (progress.error || !progress.data) {
    return (
      <>
        <PageHeader title="教育進捗" crumbs={[{ label: "社員教育進捗管理", to: "/progress" }, { label: "教育進捗" }]} />
        <Card>
          <ErrorState error={progress.error} onRetry={() => void progress.refetch()} />
        </Card>
      </>
    );
  }
  const p = progress.data;
  const s = student.data?.data;
  const title = `${p.student_name}さんの教育進捗`;
  const multiProgram = p.enrollments.length > 1;
  const pendingReviews = (submissions.data?.items ?? []).filter((x) => x.state === "submitted");

  return (
    <>
      <PageHeader title={title} crumbs={[{ label: "社員教育進捗管理", to: "/progress" }, { label: title }]} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Card aria-labelledby="summary-heading">
          <CardHeader id="summary-heading" title="研修サマリー" />
          <StudentSummary
            name={p.student_name}
            meta={s ? [s.department_name, s.classroom_name, `担当 ${s.teacher_name}`].filter(Boolean).join(" · ") : null}
            percent={p.progress_percent}
            footer={
              <>
                必須単元 {p.required_completed} / {p.required_total} 完了
                {s ? <span className="ml-3">研修終了予定：{fullDateLabel(s.training_due_on)}</span> : null}
                {p.progress_percent === null ? <span className="ml-3">（必須単元が割り当てられていないため未設定）</span> : null}
              </>
            }
          />
          <LastFetched checkedAt={p.checked_at} className="mt-4" />
        </Card>
        <Card aria-labelledby="records-heading">
          <CardHeader id="records-heading" title="教育記録" description="既存システムから引き継いだ項目（終了予定日・教育担当部署・教育担当者・内容）です。" />
          {records.isLoading ? (
            <LoadingRows rows={2} label="教育記録を読み込み中です" />
          ) : records.error ? (
            <ErrorState compact error={records.error} onRetry={() => void records.refetch()} />
          ) : records.data && records.data.items.length === 0 ? (
            <p className="text-sm text-muted">教育記録はありません。社員教育進捗管理の「教育記録を登録」から追加できます。</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {records.data?.items.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="text-sm">
                      <span className="tabular-nums">{fullDateLabel(r.due_date)}</span>
                      <span className="ml-2">{r.content}</span>
                    </p>
                    <p className="text-xs text-muted">
                      {progressColumnLabels.department_name} {r.department_name}・{progressColumnLabels.teacher_name} {r.teacher_name}
                    </p>
                  </div>
                  <span className="relative flex items-center gap-3">
                    <ProgressStateBadge state={r.state} overdue={r.overdue} />
                    <Link to={`/progress/records/${r.id}`} className="text-xs text-primary hover:underline" aria-label={`${fullDateLabel(r.due_date)}の教育記録を閲覧`}>
                      閲覧
                    </Link>
                    <Link to={`/progress/records/${r.id}?mode=edit`} className="text-xs text-primary hover:underline" aria-label={`${fullDateLabel(r.due_date)}の教育記録を編集`}>
                      編集
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {records.data?.next_cursor ? <p className="mt-2 text-xs text-muted">先頭100件を表示しています。社員教育進捗管理で検索するとすべて確認できます。</p> : null}
        </Card>
      </div>

      <Card aria-labelledby="enrollments-heading" className="mt-5">
        <CardHeader id="enrollments-heading" title="受講中のプログラム" description="割り当てられたバージョンの単元と重みで進捗を計算します（四捨五入）。" />
        {p.enrollments.length === 0 ? (
          <EmptyState
            title="受講が割り当てられていません"
            description={user.isAdmin ? "教育プログラム管理で公開中のバージョンを開き、「受講の割当」から割り当ててください。" : "管理者が受講を割り当てると、ここに表示されます。"}
            action={
              user.isAdmin ? (
                <Link to="/programs" className="text-sm text-primary underline-offset-2 hover:underline">
                  教育プログラム管理を開く
                </Link>
              ) : null
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {p.enrollments.map((e) => (
              <EnrollmentCard key={e.enrollment_id} e={e} />
            ))}
          </div>
        )}
      </Card>

      {p.units.length ? (
        <Card aria-labelledby="units-heading" className="mt-5">
          <CardHeader id="units-heading" title="単元別の状況" description="完了には、必須教材の確認・確認テスト合格・課題の講師承認・必要な出席のすべてが必要です。" />
          <UnitsTable units={p.units} multiProgram={multiProgram} />
        </Card>
      ) : null}

      <Card aria-labelledby="submissions-heading" className="mt-5">
        <CardHeader
          id="submissions-heading"
          title="課題の提出と評価"
          description={pendingReviews.length ? `評価待ちの課題が${pendingReviews.length}件あります。` : "評価待ちの課題はありません。"}
        />
        {submissions.isLoading ? (
          <LoadingRows rows={2} label="提出物を読み込み中です" />
        ) : submissions.error ? (
          <ErrorState compact error={submissions.error} onRetry={() => void submissions.refetch()} />
        ) : submissions.data && submissions.data.items.length === 0 ? (
          <p className="text-sm text-muted">提出された課題はありません。</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {submissions.data?.items.map((sub) => (
              <li key={sub.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {sub.material_title}
                    <span className="ml-2 text-xs font-normal text-muted">{sub.unit_title}</span>
                  </p>
                  <p className="text-xs text-muted">
                    提出 {fmt.dateTime(sub.submitted_at)}
                    {sub.reviewed_at ? `・評価 ${fmt.dateTime(sub.reviewed_at)}（${sub.reviewer_name ?? "講師"}）` : ""}
                  </p>
                  {sub.body ? <p className="mt-1 line-clamp-2 text-xs break-words">{sub.body}</p> : null}
                  {sub.feedback ? <p className="mt-1 text-xs">講師コメント：{sub.feedback}</p> : null}
                </div>
                <div className="relative flex flex-wrap items-center gap-2">
                  <SubmissionStateBadge state={sub.state} />
                  <SubmissionFileLink submission={sub} />
                  {sub.state === "submitted" ? (
                    <Button size="sm" disabled={!online} onClick={() => setReviewing(sub)} aria-label={`「${sub.material_title}」を評価`}>
                      評価する
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <LastFetched checkedAt={submissions.data?.checked_at} className="mt-3" />
      </Card>

      <Card aria-labelledby="history-heading" className="mt-5">
        <CardHeader
          id="history-heading"
          title="変更履歴"
          description={user.isAdmin ? "単元の完了・課題の提出と評価・受講割当などの記録です。" : "単元の完了・課題の提出と評価の記録です（割当などの操作履歴は管理者のみ閲覧できます）。"}
        />
        {history.length === 0 ? <p className="text-sm text-muted">まだ記録はありません。</p> : <Timeline label="教育進捗の変更履歴" items={history.slice(0, 50)} />}
        {events.error ? <ErrorState compact error={events.error} onRetry={() => void events.refetch()} /> : null}
      </Card>
      {reviewing ? <ReviewDialog submission={reviewing} studentId={id} onClose={() => setReviewing(null)} /> : null}
    </>
  );
}
