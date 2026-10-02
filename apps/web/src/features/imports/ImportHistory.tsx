import { useInfiniteQuery } from "@tanstack/react-query";
import { IMPORT_ENTITY_LABELS } from "@arms/contracts";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { DataTable, type ColumnDef } from "../../components/ui/DataTable";
import { LastFetched } from "../../components/ui/Feedback";
import { fmt } from "../../lib/format";
import { importsApi, type ImportJob } from "./api";
import { ImportStateBadge } from "./common";

/** 移行履歴: newest first, 「開く」 resumes the job at its current step. */
export function ImportHistory({ currentJobId, onOpen }: { currentJobId: string | null; onOpen(job: ImportJob): void }) {
  const query = useInfiniteQuery({
    queryKey: ["imports", "list"],
    queryFn: ({ pageParam }) => importsApi.list(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
  const rows = query.data?.pages.flatMap((p) => p.items);
  const columns: ColumnDef<ImportJob, unknown>[] = [
    { header: "登録日時", cell: ({ row }) => fmt.dateTime(row.original.created_at) },
    { header: "データ", cell: ({ row }) => IMPORT_ENTITY_LABELS[row.original.entity] },
    { header: "ファイル", cell: ({ row }) => <span title={row.original.filename}>{row.original.filename || "—"}</span> },
    { header: "状態", cell: ({ row }) => <ImportStateBadge job={row.original} /> },
    {
      header: "件数",
      cell: ({ row }) => {
        const j = row.original;
        if (j.state === "uploaded") return <span className="text-muted">未検証</span>;
        return (
          <span className="text-xs tabular-nums">
            全{j.total_rows}・新規{j.new_rows}・更新{j.update_rows}・エラー{j.error_rows}
            {j.committed_rows > 0 ? `・反映${j.committed_rows}` : ""}
          </span>
        );
      },
    },
    { header: "実行者", cell: ({ row }) => row.original.created_by_name || "—" },
    {
      header: "操作",
      cell: ({ row }) => (
        <Button size="sm" variant="secondary" disabled={row.original.id === currentJobId} onClick={() => onOpen(row.original)} aria-label={`${fmt.dateTime(row.original.created_at)}の移行を開く`}>
          {row.original.id === currentJobId ? "表示中" : "開く"}
        </Button>
      ),
    },
  ];
  return (
    <Card aria-labelledby="import-history" className="mt-6">
      <CardHeader id="import-history" title="移行履歴" actions={<LastFetched checkedAt={query.data?.pages[0]?.checked_at} />} />
      <DataTable
        caption="データ移植の履歴"
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        isLoading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={{ title: "移行の履歴はまだありません", description: "上の手順でCSVファイルを選択し、ドライランから始めてください。" }}
        hasMore={query.hasNextPage}
        loadingMore={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </Card>
  );
}
