import { useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Plus } from "lucide-react";
import { VERSION_STATE_LABELS } from "@arms/contracts";
import { Badge, VersionStateBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorState, InlineError, LastFetched, LoadingRows } from "../../components/ui/Feedback";
import { Select } from "../../components/ui/Field";
import { FilterBar, FilterItem } from "../../components/ui/FilterBar";
import { PageHeader } from "../../components/ui/PageHeader";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { useCurrentUser } from "../../lib/session";
import { learningKeys, useDepartments, type Program } from "../../features/learning/api";
import { orderLabel, versionLabel } from "../../features/learning/format";
import { SearchField } from "../../features/learning/SearchField";
import { useCursorList } from "../../features/learning/useCursorList";
import { useUrlParams } from "../../features/learning/useUrlParams";

const FILTER_KEYS = ["q", "department", "status"] as const;

const STATUS_OPTIONS = [
  { value: "", label: "すべて（アーカイブを除く）" },
  { value: "published", label: "公開中" },
  { value: "draft", label: "下書きあり" },
  { value: "archived", label: "アーカイブ済み" },
  { value: "all", label: "アーカイブを含むすべて" },
] as const;

function ProgramStateBadges({ program }: { program: Program }) {
  if (program.archived) return <Badge tone="neutral">アーカイブ済み</Badge>;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {program.published_version_id ? <VersionStateBadge state="published" /> : null}
      {program.draft_version_id ? <VersionStateBadge state="draft" /> : null}
      {!program.latest_version ? <Badge tone="warning">バージョン未作成</Badge> : null}
    </span>
  );
}

function ProgramCard({ program, index, canArchive, onArchive }: { program: Program; index: number; canArchive: boolean; onArchive(p: Program): void }) {
  const latest = program.latest_version;
  const titleId = `program-${program.id}`;
  return (
    <article aria-labelledby={titleId} className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-[0_3px_14px_#243f6410]">
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} className="text-base font-bold break-words">
          {program.name}
        </h2>
        <ProgramStateBadges program={program} />
      </div>
      <div aria-hidden className="rounded-[var(--radius-control)] bg-primary-soft px-5 py-3 text-4xl font-bold text-primary">
        {orderLabel(index)}
      </div>
      <p className="line-clamp-2 min-h-10 text-sm">{program.description || <span className="text-muted">説明は登録されていません。</span>}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">対象部署</dt>
        <dd>{program.department_name || "全部署"}</dd>
        <dt className="text-muted">最新バージョン</dt>
        <dd>{latest ? `${versionLabel(latest.version_number)}（${VERSION_STATE_LABELS[latest.state]}）` : "未作成"}</dd>
        <dt className="text-muted">公開状態</dt>
        <dd>{program.published_version_id ? "公開中のバージョンあり" : "未公開"}</dd>
        <dt className="text-muted">単元・教材</dt>
        <dd className="text-primary">
          {program.unit_count}単元 / {program.material_count}教材
        </dd>
        <dt className="text-muted">受講者</dt>
        <dd>{fmt.number(program.student_count)}名</dd>
      </dl>
      <div className="mt-auto flex flex-wrap justify-end gap-2 pt-2">
        {canArchive && !program.archived ? (
          <Button variant="ghost" size="sm" icon={<Archive className="size-3.5" aria-hidden />} onClick={() => onArchive(program)} aria-label={`「${program.name}」をアーカイブ`}>
            アーカイブ
          </Button>
        ) : null}
        <Link
          to={`/programs/${program.id}`}
          aria-label={`「${program.name}」の教材を見る`}
          className="inline-flex h-8 items-center rounded-[var(--radius-control)] border border-line bg-surface px-3 text-xs font-medium hover:bg-surface-2"
        >
          教材を見る
        </Link>
      </div>
    </article>
  );
}

/** WEB-09 教育プログラム管理: programs with target department, published version, unit/material/learner counts. */
export function ProgramsPage() {
  const user = useCurrentUser();
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const [filters, setFilters] = useUrlParams(FILTER_KEYS);
  const { departments } = useDepartments();
  const query = { q: filters.q || undefined, department: filters.department || undefined, status: filters.status || undefined };
  const list = useCursorList<Program>(learningKeys.programs(query), "/programs", query, { limit: 30 });
  const [archiving, setArchiving] = useState<Program | null>(null);
  const [archiveError, setArchiveError] = useState<unknown>(null);
  const [archivePending, setArchivePending] = useState(false);

  const archive = async () => {
    if (!archiving) return;
    setArchivePending(true);
    setArchiveError(null);
    try {
      await api.delete(`/programs/${archiving.id}`, { ifMatch: archiving.row_version });
      toast.success("プログラムをアーカイブしました", `「${archiving.name}」は一覧から非表示になりました。受講記録と履歴は保持されています。`);
      setArchiving(null);
      await qc.invalidateQueries({ queryKey: ["learning", "programs"] });
    } catch (e) {
      setArchiveError(e);
    } finally {
      setArchivePending(false);
    }
  };

  const departmentOptions = filters.department && !departments.includes(filters.department) ? [filters.department, ...departments] : departments;

  return (
    <>
      <PageHeader
        title="教育プログラム管理"
        crumbs={[{ label: "教育プログラム管理" }]}
        description={user.isAdmin ? undefined : "講師は閲覧のみです。担当クラスのプログラムでは下書きバージョンの教材を編集できます。"}
        actions={
          user.isAdmin ? (
            <Link
              to="/programs/new"
              className="inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-control)] bg-brand px-4 text-sm font-medium text-white shadow-sm hover:bg-primary-strong dark:text-[#0b1421]"
            >
              <Plus className="size-4" aria-hidden />
              プログラムを追加
            </Link>
          ) : null
        }
      />
      <FilterBar label="プログラムの絞り込み">
        <FilterItem label="プログラム名で検索">
          {(id) => <SearchField id={id} value={filters.q} placeholder="名称・説明" onCommit={(v) => setFilters({ q: v }, { replace: true })} />}
        </FilterItem>
        <FilterItem label="対象部署">
          {(id) => (
            <Select id={id} value={filters.department} onChange={(e) => setFilters({ department: e.target.value })}>
              <option value="">すべて</option>
              {departmentOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          )}
        </FilterItem>
        <FilterItem label="公開状態">
          {(id) => (
            <Select id={id} value={filters.status} onChange={(e) => setFilters({ status: e.target.value })}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </FilterItem>
      </FilterBar>
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs text-muted" aria-live="polite">
          {list.items ? `${list.items.length}件${list.hasMore ? "（続きがあります）" : ""}` : ""}
        </p>
        <LastFetched checkedAt={list.checkedAt} />
      </div>
      {list.isLoading && !list.items ? (
        <LoadingRows rows={4} label="プログラムを読み込み中です" />
      ) : list.error && !list.items ? (
        <ErrorState error={list.error} onRetry={list.refetch} />
      ) : list.items && list.items.length === 0 ? (
        <EmptyState
          title={filters.q || filters.department || filters.status ? "条件に一致するプログラムはありません" : "教育プログラムがまだありません"}
          description={
            filters.q || filters.department || filters.status
              ? "検索語や絞り込み条件を変更してください。"
              : user.isAdmin
                ? "「プログラムを追加」から最初のプログラムを登録し、単元と教材を設定してください。"
                : "管理者がプログラムを登録すると、ここに表示されます。"
          }
          action={
            user.isAdmin && !(filters.q || filters.department || filters.status) ? (
              <Link to="/programs/new" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
                プログラムを追加する
              </Link>
            ) : null
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {list.items?.map((p, i) => (
              <ProgramCard key={p.id} program={p} index={i} canArchive={user.isAdmin && online} onArchive={(prog) => (setArchiveError(null), setArchiving(prog))} />
            ))}
          </div>
          {list.error ? <ErrorState compact error={list.error} onRetry={list.refetch} /> : null}
          {list.hasMore ? (
            <div className="mt-5 flex justify-center">
              <Button variant="secondary" size="sm" loading={list.loadingMore} onClick={list.loadMore}>
                さらに読み込む
              </Button>
            </div>
          ) : null}
        </>
      )}
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(open) => !open && !archivePending && setArchiving(null)}
        title="プログラムをアーカイブしますか？"
        description={
          <>
            <p>「{archiving?.name}」をアーカイブし、一覧から非表示にします。</p>
            <p className="mt-2 text-xs text-muted">受講中の新入社員の割当・進捗・履歴は保持されます。アーカイブ後はプログラム・バージョン・教材を変更できません。</p>
          </>
        }
        confirmLabel="アーカイブする"
        loading={archivePending}
        onConfirm={archive}
      >
        <InlineError error={archiveError} />
      </ConfirmDialog>
    </>
  );
}
