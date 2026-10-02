import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { EmptyState, ErrorState, LoadingRows } from "./Feedback";
import { Button } from "./Button";
import { cn } from "./cn";

export type { ColumnDef };

interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[] | undefined;
  getRowId: (row: T) => string;
  caption: string;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: { title: string; description?: ReactNode; action?: ReactNode };
  /** Cursor pagination: show 「さらに読み込む」 while more pages exist. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  rowClassName?: (row: T) => string | undefined;
}

/**
 * Accessible data table (caption, th scope) that scrolls horizontally on narrow screens.
 * Handles loading / error / empty states so every list behaves the same.
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  caption,
  isLoading,
  error,
  onRetry,
  empty,
  hasMore,
  loadingMore,
  onLoadMore,
  rowClassName,
}: DataTableProps<T>) {
  const table = useReactTable({ data: data ?? [], columns, getCoreRowModel: getCoreRowModel(), getRowId: (r) => getRowId(r) });
  if (isLoading && !data) return <LoadingRows />;
  if (error && !data) return <ErrorState error={error} onRetry={onRetry} />;
  if (data && data.length === 0) return <EmptyState title={empty?.title ?? "データがありません"} description={empty?.description} action={empty?.action} />;
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="bg-surface-2">
                {hg.headers.map((h) => (
                  <th key={h.id} scope="col" className="px-3 py-3 text-left text-xs font-medium whitespace-nowrap text-muted first:rounded-l-lg last:rounded-r-lg">
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className={cn("border-b border-line last:border-b-0", rowClassName?.(row.original))}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="max-w-[320px] truncate px-3 py-4 align-middle">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && data ? <ErrorState compact error={error} onRetry={onRetry} /> : null}
      {hasMore && onLoadMore ? (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" size="sm" loading={loadingMore} onClick={onLoadMore}>
            さらに読み込む
          </Button>
        </div>
      ) : null}
    </div>
  );
}
