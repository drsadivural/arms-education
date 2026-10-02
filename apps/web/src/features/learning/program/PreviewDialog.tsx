import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Dialog } from "../../../components/ui/Dialog";
import { ErrorState, LoadingRows } from "../../../components/ui/Feedback";
import { api } from "../../../lib/api";
import { fmt } from "../../../lib/format";
import type { DataResponse, Download, Material } from "../api";

/**
 * プレビュー: the API authorises the caller and returns a 5-minute signed URL (links return their https URL). The
 * URL is fetched when the dialog opens and never cached, so an expired link is never reused.
 */
export function PreviewDialog({ material, onClose }: { material: Material; onClose(): void }) {
  const q = useQuery({
    queryKey: ["learning", "download", material.id],
    queryFn: () => api.get<DataResponse<Download>>(`/materials/${material.id}/download`),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const d = q.data?.data;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="教材のプレビュー" description={`「${material.title}」`} wide>
      {q.isLoading ? (
        <LoadingRows rows={2} label="プレビュー用のURLを発行しています" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : d ? (
        <div className="flex flex-col gap-3">
          {material.kind === "image" ? <img src={d.url} alt={material.title} className="max-h-[60vh] w-full rounded-[var(--radius-control)] object-contain" /> : null}
          {material.kind === "video" ? (
            <video src={d.url} controls className="max-h-[60vh] w-full rounded-[var(--radius-control)]">
              <track kind="captions" />
            </video>
          ) : null}
          <a
            href={d.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-control)] bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-primary-strong dark:text-[#0b1421]"
          >
            <ExternalLink className="size-4" aria-hidden />
            {material.kind === "link" ? "リンク先を新しいタブで開く" : "新しいタブで開く"}
          </a>
          <p className="text-xs text-muted">
            {material.kind === "link"
              ? `外部サイト（${new URL(d.url).host}）が開きます。`
              : `このURLは ${fmt.dateTime(d.expires_at)} まで有効です（発行から5分間）。期限後はもう一度プレビューを開いてください。`}
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}
