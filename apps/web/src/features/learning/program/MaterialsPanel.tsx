import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MATERIAL_KIND_LABELS } from "@arms/contracts";
import { Plus } from "lucide-react";
import { Badge, ScanStateBadge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader } from "../../../components/ui/Card";
import { EmptyState, ErrorState, LastFetched, LoadingRows } from "../../../components/ui/Feedback";
import { FileDropZone } from "../../../components/ui/FileUpload";
import { useToast } from "../../../components/ui/Toast";
import { api } from "../../../lib/api";
import { useOnline } from "../../../lib/online";
import { learningKeys, type ActionResult, type Material, type MaterialKind, type Unit } from "../api";
import { fileSizeLabel } from "../format";
import { PublishProblems } from "../PublishProblems";
import { acceptFor, kindForFile } from "../upload";
import { MaterialFormDialog } from "./MaterialFormDialog";
import { PreviewDialog } from "./PreviewDialog";
import { QuizDialog } from "./QuizDialog";

type Editing = { material: Material | null; kind?: MaterialKind; file?: File | null } | null;

function canPreview(m: Material): boolean {
  if (m.kind === "link") return !!m.external_url;
  return (m.kind === "pdf" || m.kind === "video" || m.kind === "image") && !!m.upload_id;
}

function MaterialDetail({ m }: { m: Material }) {
  if (m.kind === "link") return <span className="break-all text-xs text-muted">{m.external_url}</span>;
  if (m.kind === "quiz") return <span className="text-xs text-muted">{m.question_count ? `${m.question_count}問` : "問題が未登録です"}</span>;
  if (m.kind === "assignment") return <span className="text-xs text-muted">受講者が提出</span>;
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <span className="break-all">{m.filename ?? "ファイル未添付"}</span>
      {m.size_bytes ? <span>{fileSizeLabel(m.size_bytes)}</span> : null}
    </span>
  );
}

/**
 * Materials of one unit: list with scan/publication state, add (drop zone or form), edit, quiz questions, preview
 * and 公開準備 (POST /materials/{id}/publish). Editing is limited to draft versions and allowed writers.
 */
export function MaterialsPanel({
  unit,
  materials,
  checkedAt,
  isLoading,
  error,
  onRetry,
  editable,
  lockedReason,
}: {
  unit: Unit;
  materials: Material[] | undefined;
  checkedAt: string | null;
  isLoading: boolean;
  error: unknown;
  onRetry(): void;
  editable: boolean;
  lockedReason: string | null;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const [editing, setEditing] = useState<Editing>(null);
  const [quizFor, setQuizFor] = useState<Material | null>(null);
  const [preview, setPreview] = useState<Material | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<{ id: string; error: unknown } | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: learningKeys.materials(unit.id) });
    void qc.invalidateQueries({ queryKey: ["learning", "units", unit.program_version_id] });
    void qc.invalidateQueries({ queryKey: ["learning", "versions"] });
  };

  const publish = async (m: Material) => {
    setPublishing(m.id);
    setPublishError(null);
    try {
      await api.post<ActionResult>(`/materials/${m.id}/publish`);
      toast.success("教材の公開準備ができました", `「${m.title}」はバージョンの公開時に受講者へ公開されます。`);
      refresh();
    } catch (e) {
      setPublishError({ id: m.id, error: e });
    } finally {
      setPublishing(null);
    }
  };

  const onDrop = (file: File) => {
    const kind = kindForFile(file);
    if (!kind) {
      setDropError(`${file.name}：PDF・動画（MP4/MOV/WebM）・画像（PNG/JPEG）のファイルを選択してください。リンク・確認テスト・課題は「教材を追加」から登録します。`);
      return;
    }
    setDropError(null);
    setEditing({ material: null, kind, file });
  };

  return (
    <Card aria-labelledby={`materials-${unit.id}`} className="mt-5">
      <CardHeader
        id={`materials-${unit.id}`}
        title={`「${unit.title}」の教材`}
        description={editable ? "教材は「公開準備」を行うとバージョンの公開時に受講者へ公開されます。ファイル教材は安全性の検査（検査済み）が必要です。" : (lockedReason ?? undefined)}
        actions={
          editable ? (
            <Button size="sm" icon={<Plus className="size-3.5" aria-hidden />} disabled={!online} onClick={() => setEditing({ material: null })}>
              教材を追加
            </Button>
          ) : null
        }
      />
      {isLoading && !materials ? (
        <LoadingRows rows={2} label="教材を読み込み中です" />
      ) : error && !materials ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : materials && materials.length === 0 ? (
        <EmptyState title="教材がありません" description={editable ? "PDF・動画・画像をアップロードするか、リンク・確認テスト・課題を追加してください。" : undefined} />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {materials?.map((m) => (
            <li key={m.id} className="flex flex-col gap-2 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{MATERIAL_KIND_LABELS[m.kind]}</Badge>
                    <span className="font-medium break-words">{m.title}</span>
                    <Badge tone={m.required ? "warning" : "neutral"}>{m.required ? "必須" : "任意"}</Badge>
                  </div>
                  <MaterialDetail m={m} />
                  <div className="flex flex-wrap items-center gap-2">
                    {m.kind === "pdf" || m.kind === "video" || m.kind === "image" ? <ScanStateBadge state={m.scan_state} /> : null}
                    <Badge tone={m.published ? "success" : "neutral"}>{m.published ? "公開準備済み" : "未公開"}</Badge>
                  </div>
                </div>
                <div className="relative flex flex-wrap items-center gap-1">
                  {canPreview(m) ? (
                    <Button variant="ghost" size="sm" onClick={() => setPreview(m)} aria-label={`「${m.title}」をプレビュー`}>
                      プレビュー
                    </Button>
                  ) : null}
                  {m.kind === "quiz" ? (
                    <Button variant="ghost" size="sm" onClick={() => setQuizFor(m)} aria-label={`「${m.title}」の問題を${editable ? "編集" : "表示"}`}>
                      {editable ? "問題を編集" : "問題を表示"}
                    </Button>
                  ) : null}
                  {editable ? (
                    <>
                      <Button variant="ghost" size="sm" disabled={!online} onClick={() => setEditing({ material: m })} aria-label={`「${m.title}」を編集`}>
                        編集
                      </Button>
                      {!m.published ? (
                        <Button variant="secondary" size="sm" loading={publishing === m.id} disabled={!online} onClick={() => publish(m)} aria-label={`「${m.title}」の公開準備`}>
                          公開準備
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
              {publishError?.id === m.id ? <PublishProblems error={publishError.error} /> : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <FileDropZone
          className="mt-4"
          title="教材を追加"
          description="PDF・動画・画像をアップロード / HTTPSリンク・確認テスト・課題は「教材を追加」ボタンから登録"
          hint="ファイルは安全性の検査後に公開できます（PDF 20MB・動画 200MB・画像 10MBまで）。"
          accept={acceptFor()}
          disabled={!online}
          onFile={onDrop}
        >
          {dropError ? (
            <p role="alert" className="text-xs font-medium text-danger">
              {dropError}
            </p>
          ) : null}
        </FileDropZone>
      ) : null}
      <LastFetched checkedAt={checkedAt} className="mt-3" />
      {editing ? (
        <MaterialFormDialog
          open
          onOpenChange={(o) => !o && setEditing(null)}
          unitId={unit.id}
          material={editing.material}
          initialKind={editing.kind}
          initialFile={editing.file}
          onSaved={(saved, created) => {
            refresh();
            toast.success(created ? "教材を登録しました" : "教材を保存しました", saved.kind === "quiz" && created ? "続けて問題を登録してください。" : undefined);
            if (created && saved.kind === "quiz") setQuizFor(saved);
          }}
        />
      ) : null}
      {quizFor ? <QuizDialog open onOpenChange={(o) => !o && setQuizFor(null)} material={quizFor} onSaved={refresh} /> : null}
      {preview ? <PreviewDialog material={preview} onClose={() => setPreview(null)} /> : null}
    </Card>
  );
}
