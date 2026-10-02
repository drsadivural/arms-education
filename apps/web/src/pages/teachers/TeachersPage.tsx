import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { PageHeader } from "../../components/ui/PageHeader";
import { Card } from "../../components/ui/Card";
import { ActiveBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { DataTable, type ColumnDef } from "../../components/ui/DataTable";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { InlineError, LastFetched, Notice } from "../../components/ui/Feedback";
import { FilterBar, FilterItem } from "../../components/ui/FilterBar";
import { Select } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { useOnline } from "../../lib/online";
import { useCurrentUser } from "../../lib/session";
import { adminKeys } from "../../features/admin/keys";
import { statusQuery, useClassroomOptions, useCursorList, useDepartments, useUrlFilters } from "../../features/admin/hooks";
import { DepartmentFilter, InvitationStateBadge, ListCount, PersonCell, SearchField, useResendInvite } from "../../features/admin/components";
import { conflictDetail, isVersionConflict } from "../../features/admin/errors";
import { primaryLinkClass, smallLinkClass } from "../../features/admin/styles";
import type { ActionResult, Teacher } from "../../features/admin/types";

const FILTER_KEYS = ["q", "department", "status", "classroom_id"] as const;

/** WEB-03 講師管理: 一覧（検索・部署・状態・担当クラス）、登録・編集・招待再送・停止（管理者のみ）。 */
export function TeachersPage() {
  const user = useCurrentUser();
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const [filters, setFilters] = useUrlFilters(FILTER_KEYS);
  const { departments } = useDepartments();
  const classrooms = useClassroomOptions("active");
  const query = { q: filters.q, department: filters.department, status: statusQuery(filters.status, "active"), classroom_id: filters.classroom_id };
  const list = useCursorList<Teacher>(adminKeys.teacherList(query), "/teachers", query);
  const [stopId, setStopId] = useState<string | null>(null);
  // Always the latest row, so a retry after a VERSION_CONFLICT refetch sends the new row_version.
  const stopTarget = stopId ? (list.items?.find((t) => t.id === stopId) ?? null) : null;

  const stop = useMutation({
    mutationFn: (t: Teacher) => api.delete<ActionResult>(`/teachers/${t.id}`, { ifMatch: t.row_version }),
    onSuccess: (res, t) => {
      toast.success(`${t.display_name}さんを停止しました`, "ログインできなくなり、新しい担当には選べなくなります。");
      setStopId(null);
      void qc.invalidateQueries({ queryKey: adminKeys.teachers });
      void qc.invalidateQueries({ queryKey: adminKeys.users });
    },
    onError: (e) => {
      if (isVersionConflict(e)) void qc.invalidateQueries({ queryKey: adminKeys.teachers });
    },
  });
  const resend = useResendInvite(() => void qc.invalidateQueries({ queryKey: adminKeys.teachers }));

  const columns = useMemo<ColumnDef<Teacher, unknown>[]>(() => {
    const cols: ColumnDef<Teacher, unknown>[] = [
      {
        id: "name",
        header: "氏名・ふりがな",
        cell: ({ row }) => <PersonCell name={row.original.display_name} sub={row.original.kana || row.original.email} to={`/teachers/${row.original.id}`} />,
      },
      { id: "number", header: "講師番号", cell: ({ row }) => <span className="tabular-nums">{row.original.teacher_number}</span> },
      { id: "department", header: "所属部署", cell: ({ row }) => row.original.department_name || "—" },
      {
        id: "specialties",
        header: "専門分野",
        cell: ({ row }) => <span title={row.original.specialties.join("・")}>{row.original.specialties.length ? row.original.specialties.join("・") : "—"}</span>,
      },
      {
        id: "classrooms",
        header: "担当クラス",
        cell: ({ row }) => {
          const cs = row.original.classrooms;
          if (!cs.length) return <span className="text-muted">未担当</span>;
          const text = cs.map((c) => `${c.name}${c.is_primary ? "（主）" : ""}`).join(" / ");
          return <span title={text}>{text}</span>;
        },
      },
      { id: "students", header: "担当受講者", cell: ({ row }) => <span className="tabular-nums">{row.original.student_count}名</span> },
      {
        id: "status",
        header: "状態",
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            <ActiveBadge active={row.original.active} />
            <InvitationStateBadge state={row.original.invitation_state} />
          </span>
        ),
      },
    ];
    cols.push({
      id: "actions",
      header: "操作",
      cell: ({ row }) => {
        const t = row.original;
        if (!user.isAdmin) {
          return (
            <Link to={`/teachers/${t.id}`} className={smallLinkClass} aria-label={`${t.display_name}さんの詳細`}>
              詳細
            </Link>
          );
        }
        const canResend = t.active && (t.invitation_state === "failed" || t.invitation_state === "profile_created");
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <Link to={`/teachers/${t.id}`} className={smallLinkClass} aria-label={`${t.display_name}さんを編集`}>
              編集
            </Link>
            {canResend ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!online}
                loading={resend.isPending && resend.variables === t.id}
                onClick={() => resend.mutate(t.id)}
                aria-label={`${t.display_name}さんに招待を再送`}
              >
                招待再送
              </Button>
            ) : null}
            {t.active ? (
              <Button size="sm" variant="ghost" className="text-danger" disabled={!online} onClick={() => (stop.reset(), setStopId(t.id))} aria-label={`${t.display_name}さんを停止`}>
                停止
              </Button>
            ) : null}
          </span>
        );
      },
    });
    return cols;
  }, [user.isAdmin, online, resend, stop]);

  return (
    <div>
      <PageHeader
        title="講師管理"
        crumbs={[{ label: "講師管理" }]}
        actions={
          user.isAdmin ? (
            <Link to="/teachers/new" className={primaryLinkClass}>
              <Plus className="size-4" aria-hidden />
              講師を登録
            </Link>
          ) : null
        }
      />
      <FilterBar label="講師の絞り込み">
        <SearchField label="検索" value={filters.q} onCommit={(q) => setFilters({ q })} placeholder="講師名・メール・講師番号で検索" />
        <FilterItem label="所属部署">
          {(id) => <DepartmentFilter id={id} departments={departments} value={filters.department} onChange={(v) => setFilters({ department: v })} />}
        </FilterItem>
        <FilterItem label="状態">
          {(id) => (
            <Select id={id} value={filters.status || "active"} onChange={(e) => setFilters({ status: e.target.value === "active" ? "" : e.target.value })}>
              <option value="active">有効</option>
              <option value="inactive">停止中</option>
              <option value="all">すべて</option>
            </Select>
          )}
        </FilterItem>
        <FilterItem label="担当クラス">
          {(id) => (
            <Select id={id} value={filters.classroom_id} onChange={(e) => setFilters({ classroom_id: e.target.value })}>
              <option value="">すべて</option>
              {(classrooms.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </FilterItem>
      </FilterBar>

      {!user.isAdmin ? (
        <div className="mb-4">
          <Notice>講師アカウントでは閲覧のみできます。登録・編集・停止は管理者が行います。</Notice>
        </div>
      ) : null}

      <Card aria-labelledby="teacher-list-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 id="teacher-list-title" className="text-base font-bold">
            講師一覧
          </h2>
          <div className="flex items-center gap-3">
            <ListCount count={list.items?.length} hasMore={list.hasMore} unit="名" />
            <LastFetched checkedAt={list.checkedAt} />
          </div>
        </div>
        <DataTable
          caption="講師一覧"
          columns={columns}
          data={list.items}
          getRowId={(t) => t.id}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={list.refetch}
          hasMore={list.hasMore}
          loadingMore={list.loadingMore}
          onLoadMore={list.loadMore}
          empty={{
            title: filters.q || filters.department || filters.classroom_id ? "条件に一致する講師はいません" : "講師が登録されていません",
            description: user.isAdmin ? "「講師を登録」から講師を追加すると、招待メールが送信されます。" : "条件を変更してください。",
            action: user.isAdmin ? (
              <Link to="/teachers/new" className={primaryLinkClass}>
                講師を登録
              </Link>
            ) : null,
          }}
        />
        {resend.error ? (
          <div className="mt-3">
            <InlineError error={resend.error} />
          </div>
        ) : null}
      </Card>

      <ConfirmDialog
        open={!!stopTarget}
        onOpenChange={(open) => !open && !stop.isPending && setStopId(null)}
        title="講師を停止しますか？"
        description={
          stopTarget ? (
            <p>
              <b>
                {stopTarget.display_name}（{stopTarget.teacher_number}）
              </b>
              のアカウントを停止します。停止するとログインできなくなり、新しいクラスや受講者の担当には選べなくなります。担当記録は保持されます。
            </p>
          ) : (
            ""
          )
        }
        confirmLabel="停止する"
        loading={stop.isPending}
        onConfirm={() => stopTarget && !stop.isPending && stop.mutate(stopTarget)}
      >
        {stop.error ? (
          <div className="flex flex-col gap-1">
            <InlineError error={stop.error} />
            {conflictDetail(stop.error) ? <p className="text-xs text-muted">{conflictDetail(stop.error)}</p> : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
