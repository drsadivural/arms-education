import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ArrowRight, RefreshCw } from "lucide-react";
import { formatMonthJa, zonedDateString } from "@arms/contracts";
import { PageHeader } from "../../components/ui/PageHeader";
import { Card, CardHeader, StatCard } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { EmptyState, ErrorState, LastFetched, LoadingRows, Skeleton } from "../../components/ui/Feedback";
import { FilterBar, FilterItem } from "../../components/ui/FilterBar";
import { Select } from "../../components/ui/Field";
import { LineChart, type LineSeries } from "../../components/ui/LineChart";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { api } from "../../lib/api";
import { fmt, ORG_TZ } from "../../lib/format";
import { useCurrentUser } from "../../lib/session";
import { adminKeys } from "../../features/admin/keys";
import { useClassroomOptions, useDepartments, useUrlFilters } from "../../features/admin/hooks";
import { DepartmentFilter, PersonCell, StatusBadge } from "../../features/admin/components";
import { trainingStatus } from "../../features/admin/labels";
import type { Dashboard, DataResponse, LessonSlot, Page, Student } from "../../features/admin/types";

const FILTER_KEYS = ["department", "classroom_id"] as const;

function useDashboard(filters: { department?: string; classroom_id?: string }, enabled = true) {
  return useQuery({
    queryKey: adminKeys.dashboard(filters),
    queryFn: ({ signal }) => api.get<DataResponse<Dashboard>>("/dashboard", { query: filters, signal }),
    refetchInterval: 60_000,
    enabled,
  });
}

/** WEB-02 ダッシュボード: 在籍・平均進捗・承認待ち・本日の授業（講師は担当範囲のみ、APIが判定）。 */
export function DashboardPage() {
  const user = useCurrentUser();
  const [filters, setFilters] = useUrlFilters(FILTER_KEYS);
  const department = filters.department || undefined;
  const classroomId = filters.classroom_id || undefined;
  const dashboard = useDashboard({ department, classroom_id: classroomId });
  // Overall line for comparison when one classroom is selected (same department filter).
  const overall = useDashboard({ department }, !!classroomId);
  const classrooms = useClassroomOptions("all");
  const { departments } = useDepartments();
  const students = useQuery({
    queryKey: adminKeys.studentList({ preview: "dashboard", department, classroom_id: classroomId }),
    queryFn: ({ signal }) => api.get<Page<Student>>("/students", { query: { limit: 5, status: "active", department, classroom_id: classroomId }, signal }),
  });

  const data = dashboard.data?.data;
  const checkedAt = dashboard.data?.checked_at;
  const today = checkedAt ? zonedDateString(checkedAt, ORG_TZ) : fmt.today();
  const classroomName = classrooms.data?.find((c) => c.id === classroomId)?.name;

  const trend = data?.progress_trend ?? [];
  const labels = trend.map((t) => `${Number(t.month.slice(5))}月`);
  const series: LineSeries[] = [];
  if (classroomId) {
    if (overall.data) series.push({ key: "overall", name: department ? `${department}の平均` : "全体平均", values: overall.data.data.progress_trend.map((t) => t.percent) });
    series.push({ key: "classroom", name: classroomName ?? "選択したクラス", values: trend.map((t) => t.percent) });
  } else {
    series.push({ key: "overall", name: department ? `${department}の平均` : "全体平均", values: trend.map((t) => t.percent) });
  }
  const hasTrend = series.some((s) => s.values.some((v) => v !== null));
  const range = trend.length ? `${formatMonthJa(trend[0]?.month ?? "")}〜${Number(trend[trend.length - 1]?.month.slice(5))}月` : "";

  const last = trend[trend.length - 1]?.percent;
  const prev = trend[trend.length - 2]?.percent;
  const delta = typeof last === "number" && typeof prev === "number" ? last - prev : null;
  const scopeLabel = [department ?? (user.isAdmin ? "全部署" : null), classroomName ?? (classroomId ? "選択したクラス" : user.isAdmin ? "全クラス" : "担当範囲")].filter(Boolean).join("・");
  const lessons = data?.today_lessons ?? [];
  const online = lessons.filter((l) => l.has_meeting_url).length;

  return (
    <div>
      <PageHeader title="ダッシュボード" crumbs={[{ label: "ダッシュボード" }]} />

      <section aria-labelledby="dashboard-hero" className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          {checkedAt ? <p className="text-sm font-medium tracking-wide text-primary">{fmt.instantDate(checkedAt)}</p> : <Skeleton className="h-5 w-40" />}
          <h2 id="dashboard-hero" className="mt-2 text-2xl font-bold text-fg">
            新入社員の成長を、ひとつの画面で。
          </h2>
          <p className="mt-2 text-xs text-muted">本日の研修状況と、対応が必要な予約を確認できます。</p>
        </div>
        <Link
          to={`/progress?month=${today.slice(0, 7)}`}
          className="inline-flex h-10 items-center rounded-[var(--radius-control)] border border-line bg-surface px-4 text-sm font-medium hover:bg-surface-2"
        >
          今月のレポート
        </Link>
      </section>

      <FilterBar label="ダッシュボードの絞り込み">
        <FilterItem label="部署">
          {(id) => <DepartmentFilter id={id} departments={departments} value={filters.department} onChange={(v) => setFilters({ department: v })} />}
        </FilterItem>
        <FilterItem label="クラス">
          {(id) => (
            <Select id={id} value={filters.classroom_id} onChange={(e) => setFilters({ classroom_id: e.target.value })}>
              <option value="">{user.isAdmin ? "すべてのクラス" : "担当のすべてのクラス"}</option>
              {(classrooms.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.archived ? "（アーカイブ済み）" : ""}
                </option>
              ))}
            </Select>
          )}
        </FilterItem>
        <div className="ml-auto flex items-center gap-3 self-center">
          <LastFetched checkedAt={checkedAt} />
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" aria-hidden />} loading={dashboard.isFetching && !!data} onClick={() => void dashboard.refetch()}>
            更新
          </Button>
        </div>
      </FilterBar>

      {dashboard.error && !data ? (
        <Card>
          <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
        </Card>
      ) : (
        <>
          <section aria-label="主要な指標" className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            {data ? (
              <>
                <StatCard label="在籍受講者" value={fmt.number(data.student_count)} unit="名" note={scopeLabel} />
                <StatCard
                  label="平均研修進捗"
                  value={data.average_progress_percent === null ? "未設定" : Math.round(data.average_progress_percent)}
                  unit={data.average_progress_percent === null ? undefined : "%"}
                  note={data.average_progress_percent === null ? "教育プログラムの割当後に表示されます" : delta === null ? "前月のデータはありません" : `先月から ${delta >= 0 ? "+" : ""}${Math.round(delta)}ポイント`}
                />
                <StatCard
                  label="承認待ち予約"
                  value={fmt.number(data.pending_reservation_count)}
                  unit="件"
                  note={data.pending_reservation_count > 0 ? "本日中の確認を推奨" : "確認が必要な申請はありません"}
                />
                <StatCard
                  label="本日の授業"
                  value={fmt.number(data.today_lesson_count)}
                  unit="コマ"
                  note={lessons.length === data.today_lesson_count && data.today_lesson_count > 0 ? `会議URLあり ${online} / なし ${data.today_lesson_count - online}` : fmt.instantDate(checkedAt ?? new Date())}
                />
              </>
            ) : (
              Array.from({ length: 4 }, (_, i) => (
                <Card key={i} aria-hidden>
                  <Skeleton className="mb-4 h-3 w-20" />
                  <Skeleton className="mb-4 h-8 w-24" />
                  <Skeleton className="h-3 w-32" />
                </Card>
              ))
            )}
          </section>

          <div className="mb-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <Card aria-labelledby="trend-title">
              <CardHeader id="trend-title" title="研修進捗の推移" actions={range ? <span className="text-[11px] text-muted">{range}</span> : null} />
              {!data ? (
                <LoadingRows rows={4} label="研修進捗の推移を読み込み中です" />
              ) : hasTrend ? (
                <LineChart title={`研修進捗の推移（${range}）`} labels={labels} series={series} />
              ) : (
                <EmptyState title="進捗データがまだありません" description="受講者に教育プログラムを割り当てると、月ごとの平均進捗が表示されます。" />
              )}
            </Card>

            <Card aria-labelledby="lessons-title">
              <CardHeader
                id="lessons-title"
                title="本日の授業"
                actions={
                  <Link to="/bookings" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                    すべて見る <ArrowRight className="size-3" aria-hidden />
                  </Link>
                }
              />
              {!data ? (
                <LoadingRows rows={3} label="本日の授業を読み込み中です" />
              ) : lessons.length === 0 ? (
                <EmptyState
                  title="本日の授業はありません"
                  description="授業・予約枠を追加すると、ここに本日の予定が表示されます。"
                  action={
                    user.isAdmin ? (
                      <Link to="/bookings/slots/new" className="text-sm font-medium text-primary hover:underline">
                        授業・予約枠を追加
                      </Link>
                    ) : null
                  }
                />
              ) : (
                <ul className="flex flex-col">
                  {lessons.map((l) => (
                    <LessonRow key={l.id} lesson={l} />
                  ))}
                  {data.today_lesson_count > lessons.length ? (
                    <li className="pt-3 text-xs text-muted">ほか {data.today_lesson_count - lessons.length} コマ（予約システムで確認できます）</li>
                  ) : null}
                </ul>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <Card aria-labelledby="students-title">
              <CardHeader
                id="students-title"
                title="新入社員の進捗"
                actions={
                  <Link to="/students" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                    すべて見る <ArrowRight className="size-3" aria-hidden />
                  </Link>
                }
              />
              {students.isLoading ? (
                <LoadingRows rows={3} label="新入社員の進捗を読み込み中です" />
              ) : students.error ? (
                <ErrorState compact error={students.error} onRetry={() => void students.refetch()} />
              ) : (students.data?.items.length ?? 0) === 0 ? (
                <EmptyState
                  title="在籍中の新入社員はいません"
                  action={
                    user.isAdmin ? (
                      <Link to="/students/new" className="text-sm font-medium text-primary hover:underline">
                        新入社員を登録
                      </Link>
                    ) : null
                  }
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] border-collapse text-sm">
                    <caption className="sr-only">新入社員の進捗</caption>
                    <thead>
                      <tr className="bg-surface-2 text-left text-xs text-muted">
                        <th scope="col" className="rounded-l-lg px-3 py-3 font-medium">
                          社員名
                        </th>
                        <th scope="col" className="px-3 py-3 font-medium">
                          部署
                        </th>
                        <th scope="col" className="px-3 py-3 font-medium">
                          進捗
                        </th>
                        <th scope="col" className="rounded-r-lg px-3 py-3 font-medium">
                          状態
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {students.data?.items.map((s) => {
                        const st = trainingStatus(s, today);
                        return (
                          <tr key={s.id} className="border-b border-line last:border-b-0">
                            <td className="px-3 py-3">
                              <PersonCell name={s.display_name} sub={s.employee_number} to={`/students/${s.id}`} />
                            </td>
                            <td className="px-3 py-3">{s.department_name || "—"}</td>
                            <td className="px-3 py-3">
                              <ProgressBar value={s.progress_percent} label={`${s.display_name}の進捗`} />
                            </td>
                            <td className="px-3 py-3">
                              <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card aria-labelledby="pending-title">
              <CardHeader
                id="pending-title"
                title="承認待ちの予約"
                actions={
                  <Link to="/bookings?status=pending" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                    すべて見る <ArrowRight className="size-3" aria-hidden />
                  </Link>
                }
              />
              {!data ? (
                <LoadingRows rows={3} label="承認待ちの予約を読み込み中です" />
              ) : data.pending_reservations.length === 0 ? (
                <EmptyState title="承認待ちの予約はありません" description="受講者が予約を申請すると、ここに表示されます。" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[440px] border-collapse text-sm">
                    <caption className="sr-only">承認待ちの予約</caption>
                    <thead>
                      <tr className="bg-surface-2 text-left text-xs text-muted">
                        <th scope="col" className="rounded-l-lg px-3 py-3 font-medium">
                          申請者
                        </th>
                        <th scope="col" className="px-3 py-3 font-medium">
                          希望日時
                        </th>
                        <th scope="col" className="px-3 py-3 font-medium">
                          研修
                        </th>
                        <th scope="col" className="rounded-r-lg px-3 py-3 font-medium">
                          操作
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.pending_reservations.map((r) => (
                        <tr key={r.id} className="border-b border-line last:border-b-0">
                          <td className="px-3 py-3 font-medium">{r.student_name ?? "—"}</td>
                          <td className="px-3 py-3 whitespace-nowrap tabular-nums">{fmt.slotRange(r.starts_at, r.ends_at)}</td>
                          <td className="max-w-[180px] truncate px-3 py-3">{r.slot_title ?? "—"}</td>
                          <td className="px-3 py-3">
                            <Link
                              to={`/bookings/reservations/${r.id}`}
                              className="inline-flex h-8 items-center rounded-[var(--radius-control)] border border-line px-3 text-xs font-medium hover:bg-surface-2"
                              aria-label={`${r.student_name ?? ""}さんの予約申請を確認`}
                            >
                              確認
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.pending_reservation_count > data.pending_reservations.length ? (
                    <p className="mt-3 text-xs text-muted">ほか {data.pending_reservation_count - data.pending_reservations.length} 件の承認待ちがあります。</p>
                  ) : null}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function lessonStatus(l: LessonSlot): { label: string; tone: "success" | "warning" | "neutral" | "danger" | "info" } {
  if (l.state === "cancelled") return { label: "取消", tone: "danger" };
  const pending = l.pending_count ?? 0;
  const approved = l.approved_count ?? 0;
  if (pending > 0) return { label: `承認待ち ${pending}件`, tone: "warning" };
  if (approved > 0) return { label: `承認済み ${approved}名`, tone: "success" };
  return { label: l.state === "closed" ? "受付終了" : "受付中", tone: "neutral" };
}

function LessonRow({ lesson }: { lesson: LessonSlot }) {
  const st = lessonStatus(lesson);
  return (
    <li className="flex items-center gap-4 border-b border-line py-3 last:border-b-0">
      <span className="flex w-16 shrink-0 flex-col items-center rounded-[10px] bg-primary-soft py-2 text-xs text-primary tabular-nums">
        <span className="font-bold">{fmt.time(lesson.starts_at)}</span>
        <span>{fmt.time(lesson.ends_at)}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-bold">{lesson.title}</span>
        <span className="truncate text-[11px] text-muted">
          {lesson.classroom_name} · {lesson.teacher_name}
        </span>
      </span>
      <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
    </li>
  );
}
