import { Link } from "react-router";
import { Plus } from "lucide-react";
import { CLASSROOM_STATUS_LABELS } from "@arms/contracts";
import { PageHeader } from "../../components/ui/PageHeader";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState, ErrorState, LastFetched, Skeleton } from "../../components/ui/Feedback";
import { FilterBar, FilterItem } from "../../components/ui/FilterBar";
import { Select } from "../../components/ui/Field";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { fmt } from "../../lib/format";
import { useCurrentUser } from "../../lib/session";
import { adminKeys } from "../../features/admin/keys";
import { statusQuery, useCursorList, useTeacherOptions, useUrlFilters } from "../../features/admin/hooks";
import { ListCount, SearchField } from "../../features/admin/components";
import { primaryLinkClass, smallLinkClass } from "../../features/admin/styles";
import type { Classroom } from "../../features/admin/types";

const FILTER_KEYS = ["q", "status", "teacher_id"] as const;

/** WEB-07 クラスルーム管理: 在籍/定員（APIのDB集計値）・主担当・期間・平均進捗のカード一覧。 */
export function ClassroomsPage() {
  const user = useCurrentUser();
  const [filters, setFilters] = useUrlFilters(FILTER_KEYS);
  const teachers = useTeacherOptions({}, user.isAdmin);
  const query = { q: filters.q, status: statusQuery(filters.status, "active"), teacher_id: filters.teacher_id };
  const list = useCursorList<Classroom>(adminKeys.classroomList(query), "/classrooms", query, { limit: 30 });
  const filtered = !!(filters.q || filters.teacher_id);

  return (
    <div>
      <PageHeader
        title="クラスルーム管理"
        crumbs={[{ label: "クラスルーム管理" }]}
        actions={
          user.isAdmin ? (
            <Link to="/classrooms/new" className={primaryLinkClass}>
              <Plus className="size-4" aria-hidden />
              クラスを追加
            </Link>
          ) : null
        }
      />
      <FilterBar label="クラスの絞り込み">
        <SearchField label="検索" value={filters.q} onCommit={(q) => setFilters({ q })} placeholder="クラス名で検索（例: 2026年度）" />
        <FilterItem label="状態">
          {(id) => (
            <Select id={id} value={filters.status || "active"} onChange={(e) => setFilters({ status: e.target.value === "active" ? "" : e.target.value })}>
              <option value="active">開講中</option>
              <option value="archived">アーカイブ済み</option>
              <option value="all">すべて</option>
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
                  </option>
                ))}
              </Select>
            )}
          </FilterItem>
        ) : null}
        <div className="ml-auto flex items-center gap-3 self-center">
          <ListCount count={list.items?.length} hasMore={list.hasMore} unit="クラス" />
          <LastFetched checkedAt={list.checkedAt} />
        </div>
      </FilterBar>

      {list.isLoading && !list.items ? (
        <div role="status" aria-live="polite" className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          <span className="sr-only">クラスを読み込み中です</span>
          {Array.from({ length: 6 }, (_, i) => (
            <Card key={i} aria-hidden>
              <Skeleton className="mb-5 h-5 w-48" />
              <Skeleton className="mb-4 h-9 w-24" />
              <Skeleton className="mb-4 h-3 w-36" />
              <Skeleton className="h-2 w-40" />
            </Card>
          ))}
        </div>
      ) : list.error && !list.items ? (
        <Card>
          <ErrorState error={list.error} onRetry={list.refetch} />
        </Card>
      ) : list.items && list.items.length === 0 ? (
        <Card>
          <EmptyState
            title={filtered ? "条件に一致するクラスはありません" : "クラスがありません"}
            description={user.isAdmin ? "「クラスを追加」で名称・定員・期間・主担当講師を登録します。" : "担当のクラスが割り当てられると表示されます。"}
            action={
              user.isAdmin && !filtered ? (
                <Link to="/classrooms/new" className={primaryLinkClass}>
                  クラスを追加
                </Link>
              ) : null
            }
          />
        </Card>
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3" aria-label="クラス一覧">
            {list.items?.map((c) => (
              <li key={c.id}>
                <ClassroomCard classroom={c} />
              </li>
            ))}
          </ul>
          {list.error ? (
            <div className="mt-4">
              <ErrorState compact error={list.error} onRetry={list.refetch} />
            </div>
          ) : null}
          {list.hasMore ? (
            <div className="mt-5 flex justify-center">
              <Button variant="secondary" size="sm" loading={list.loadingMore} onClick={list.loadMore}>
                さらに読み込む
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function ClassroomCard({ classroom: c }: { classroom: Classroom }) {
  const full = c.student_count >= c.capacity;
  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base leading-snug font-bold break-words">{c.name}</h2>
        <Badge tone={c.archived ? "neutral" : "success"}>{CLASSROOM_STATUS_LABELS[c.archived ? "archived" : "active"]}</Badge>
      </div>
      <p className="mt-4 flex items-baseline gap-1">
        <span className="text-4xl font-bold">{c.student_count}</span>
        <span className="text-sm text-muted">/ {c.capacity}名</span>
        <span className="sr-only">（在籍 {c.student_count}名、定員 {c.capacity}名）</span>
        {full ? (
          <Badge tone="warning" className="ml-2">
            満席
          </Badge>
        ) : null}
      </p>
      <p className="mt-3 text-sm text-muted">主担当：{c.primary_teacher_name || "未設定"}</p>
      <div className="mt-3">
        <ProgressBar value={c.average_progress_percent} label={`${c.name}の平均進捗`} />
      </div>
      <div className="mt-4 border-t border-line pt-4">
        <p className="text-xs text-muted">研修期間</p>
        <p className="mt-1 text-xs font-bold">
          {fmt.date(c.starts_on, true)}〜{fmt.date(c.ends_on, true)}
        </p>
      </div>
      <div className="mt-auto flex justify-end pt-4">
        <Link to={`/classrooms/${c.id}`} className={smallLinkClass} aria-label={`${c.name}の詳細を見る`}>
          詳細を見る
        </Link>
      </div>
    </Card>
  );
}
