import { useMemo } from "react";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { zonedDateString } from "@arms/contracts";
import { PageHeader } from "../../components/ui/PageHeader";
import { Card } from "../../components/ui/Card";
import { DataTable, type ColumnDef } from "../../components/ui/DataTable";
import { LastFetched, Notice } from "../../components/ui/Feedback";
import { FilterBar, FilterItem } from "../../components/ui/FilterBar";
import { Select } from "../../components/ui/Field";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { fmt, ORG_TZ } from "../../lib/format";
import { useCurrentUser } from "../../lib/session";
import { adminKeys } from "../../features/admin/keys";
import { statusQuery, useClassroomOptions, useCursorList, useDepartments, useTeacherOptions, useUrlFilters } from "../../features/admin/hooks";
import { DepartmentFilter, InvitationStateBadge, ListCount, PersonCell, SearchField, StatusBadge } from "../../features/admin/components";
import { trainingStatus } from "../../features/admin/labels";
import { primaryLinkClass, smallLinkClass } from "../../features/admin/styles";
import type { Student } from "../../features/admin/types";

const FILTER_KEYS = ["q", "department", "classroom_id", "teacher_id", "status"] as const;

/** WEB-05 新入社員管理: 一覧（検索・部署・クラス・担当講師・状態）。トップバーの検索は /students?q= で開く。 */
export function StudentsPage() {
  const user = useCurrentUser();
  const [filters, setFilters] = useUrlFilters(FILTER_KEYS);
  const { departments } = useDepartments();
  const classrooms = useClassroomOptions("all");
  const teachers = useTeacherOptions({}, user.isAdmin);
  const query = {
    q: filters.q,
    department: filters.department,
    classroom_id: filters.classroom_id,
    teacher_id: filters.teacher_id,
    status: statusQuery(filters.status, "active"),
  };
  const list = useCursorList<Student>(adminKeys.studentList(query), "/students", query);
  const today = list.checkedAt ? zonedDateString(list.checkedAt, ORG_TZ) : fmt.today();
  const filtered = !!(filters.q || filters.department || filters.classroom_id || filters.teacher_id);

  const columns = useMemo<ColumnDef<Student, unknown>[]>(
    () => [
      {
        id: "name",
        header: "社員名 / 社員番号",
        cell: ({ row }) => <PersonCell name={row.original.display_name} sub={row.original.employee_number} to={`/students/${row.original.id}`} />,
      },
      { id: "department", header: "所属部署", cell: ({ row }) => row.original.department_name || "—" },
      {
        id: "classroom",
        header: "所属クラス",
        cell: ({ row }) => (
          <Link to={`/classrooms/${row.original.classroom_id}`} className="hover:text-primary hover:underline" title={row.original.classroom_name}>
            {row.original.classroom_name}
          </Link>
        ),
      },
      { id: "teacher", header: "担当講師", cell: ({ row }) => row.original.teacher_name },
      {
        id: "period",
        header: "研修期間",
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap tabular-nums">
            {fmt.date(row.original.training_starts_on)}〜{fmt.date(row.original.training_due_on)}
          </span>
        ),
      },
      { id: "progress", header: "進捗", cell: ({ row }) => <ProgressBar value={row.original.progress_percent} label={`${row.original.display_name}の進捗`} /> },
      {
        id: "status",
        header: "状態",
        cell: ({ row }) => {
          const st = trainingStatus(row.original, today);
          return (
            <span className="flex flex-wrap gap-1">
              <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
              <InvitationStateBadge state={row.original.invitation_state} />
            </span>
          );
        },
      },
      {
        id: "actions",
        header: "操作",
        cell: ({ row }) => (
          <Link to={`/students/${row.original.id}`} className={smallLinkClass} aria-label={`${row.original.display_name}さんの${user.isAdmin ? "詳細・編集" : "詳細を見る"}`}>
            {user.isAdmin ? "詳細・編集" : "詳細を見る"}
          </Link>
        ),
      },
    ],
    [today, user.isAdmin],
  );

  return (
    <div>
      <PageHeader
        title="新入社員管理"
        crumbs={[{ label: "新入社員管理" }]}
        actions={
          user.isAdmin ? (
            <Link to="/students/new" className={primaryLinkClass}>
              <Plus className="size-4" aria-hidden />
              新入社員を登録
            </Link>
          ) : null
        }
      />
      <FilterBar label="新入社員の絞り込み">
        <SearchField label="検索" value={filters.q} onCommit={(q) => setFilters({ q })} placeholder="社員名・社員番号・メールで検索" />
        <FilterItem label="部署">{(id) => <DepartmentFilter id={id} departments={departments} value={filters.department} onChange={(v) => setFilters({ department: v })} />}</FilterItem>
        <FilterItem label="クラス">
          {(id) => (
            <Select id={id} value={filters.classroom_id} onChange={(e) => setFilters({ classroom_id: e.target.value })}>
              <option value="">すべて</option>
              {(classrooms.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.archived ? "（アーカイブ済み）" : ""}
                </option>
              ))}
            </Select>
          )}
        </FilterItem>
        {user.isAdmin ? (
          <FilterItem label="担当講師">
            {(id) => (
              <Select id={id} value={filters.teacher_id} onChange={(e) => setFilters({ teacher_id: e.target.value })}>
                <option value="">すべて</option>
                {(teachers.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.display_name}
                    {t.active ? "" : "（停止中）"}
                  </option>
                ))}
              </Select>
            )}
          </FilterItem>
        ) : null}
        <FilterItem label="状態">
          {(id) => (
            <Select id={id} value={filters.status || "active"} onChange={(e) => setFilters({ status: e.target.value === "active" ? "" : e.target.value })}>
              <option value="active">在籍</option>
              <option value="inactive">在籍終了</option>
              <option value="all">すべて</option>
            </Select>
          )}
        </FilterItem>
      </FilterBar>

      {!user.isAdmin ? (
        <div className="mb-4">
          <Notice>担当クラス・担当受講者のみ表示しています。登録・編集は管理者が行います。</Notice>
        </div>
      ) : null}

      <Card aria-labelledby="student-list-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 id="student-list-title" className="text-base font-bold">
            新入社員一覧
          </h2>
          <div className="flex items-center gap-3">
            <ListCount count={list.items?.length} hasMore={list.hasMore} unit="名" />
            <LastFetched checkedAt={list.checkedAt} />
          </div>
        </div>
        <DataTable
          caption="新入社員一覧"
          columns={columns}
          data={list.items}
          getRowId={(s) => s.id}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={list.refetch}
          hasMore={list.hasMore}
          loadingMore={list.loadingMore}
          onLoadMore={list.loadMore}
          empty={{
            title: filtered ? "条件に一致する新入社員はいません" : "新入社員が登録されていません",
            description: filtered ? "検索語や絞り込み条件を変更してください。" : user.isAdmin ? "「新入社員を登録」からクラスと担当講師を指定して登録します。" : "担当の受講者が登録されると表示されます。",
            action:
              user.isAdmin && !filtered ? (
                <Link to="/students/new" className={primaryLinkClass}>
                  新入社員を登録
                </Link>
              ) : filtered ? (
                <Link to="/students" className={smallLinkClass}>
                  条件をクリア
                </Link>
              ) : null,
          }}
        />
      </Card>
    </div>
  );
}
