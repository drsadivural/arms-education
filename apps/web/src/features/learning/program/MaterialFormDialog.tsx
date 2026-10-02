import { useState } from "react";
import { MATERIAL_KIND_LABELS, MATERIAL_KINDS, MaterialInput } from "@arms/contracts";
import { ScanStateBadge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Dialog } from "../../../components/ui/Dialog";
import { InlineError } from "../../../components/ui/Feedback";
import { Checkbox, Field, Input, Select, Textarea } from "../../../components/ui/Field";
import { ApiError, api } from "../../../lib/api";
import { useOnline } from "../../../lib/online";
import { useIdempotentMutation } from "../../../lib/query";
import type { DataResponse, Material, MaterialKind } from "../api";
import { fileSizeLabel } from "../format";
import { isFileKind } from "../upload";
import { useDiscardConfirm } from "../useDiscardConfirm";
import { MaterialFileUpload, type ReadyUpload } from "./MaterialFileUpload";

interface Values {
  kind: MaterialKind;
  title: string;
  required: boolean;
  description: string;
  external_url: string;
}

const KIND_HELP: Record<MaterialKind, string> = {
  pdf: "PDFファイルをアップロードします。受講者が内容を確認すると「確認済み」になります。",
  video: "動画ファイルをアップロードします。視聴の自己申告だけでは完了にならないため、確認テスト・課題・出席を組み合わせてください。",
  image: "画像ファイル（PNG・JPEG）をアップロードします。",
  link: "https:// から始まる外部ページのURLを登録します。",
  quiz: "登録後に問題・選択肢・正答・配点を設定します。採点はサーバーで行い、正答は受講者に表示されません。",
  assignment: "受講者が課題を提出し、講師が承認または再提出を依頼します。",
};

/**
 * Shared add/edit form of a material (PDF/動画/画像/外部リンク/確認テスト/課題). File kinds go through the quarantine
 * upload first; the material is registered only with an upload the API accepted. Kind cannot change after creation.
 */
export function MaterialFormDialog({
  open,
  onOpenChange,
  unitId,
  material,
  initialKind,
  initialFile,
  onSaved,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  unitId: string;
  material: Material | null;
  initialKind?: MaterialKind;
  initialFile?: File | null;
  onSaved(material: Material, created: boolean): void;
}) {
  const [initial] = useState<Values>(() => ({
    kind: material?.kind ?? initialKind ?? "pdf",
    title: material?.title ?? (initialFile ? initialFile.name.replace(/\.[^.]+$/, "") : ""),
    required: material?.required ?? true,
    description: material?.description ?? "",
    external_url: material?.external_url ?? "",
  }));
  const [values, setValues] = useState<Values>(initial);
  const [upload, setUpload] = useState<ReadyUpload | null>(null);
  const [replacing, setReplacing] = useState(!material);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const online = useOnline();
  const create = useIdempotentMutation((body: unknown, key: string) => api.post<DataResponse<Material>>(`/units/${unitId}/materials`, body, { idempotencyKey: key }));
  const update = useIdempotentMutation((body: unknown) => api.patch<DataResponse<Material>>(`/materials/${material!.id}`, body, { ifMatch: material!.row_version }));
  const mutation = material ? update : create;
  const dirty = JSON.stringify(values) !== JSON.stringify(initial) || !!upload;
  const discard = useDiscardConfirm(dirty, () => onOpenChange(false));
  const set = <K extends keyof Values>(k: K, v: Values[K]) => setValues((prev) => ({ ...prev, [k]: v }));
  const fileKind = isFileKind(values.kind) ? values.kind : null;
  const needsUpload = !!fileKind && (!material || replacing);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      title: values.title,
      kind: values.kind,
      required: values.required,
      description: values.description,
      ...(values.kind === "link" ? { external_url: values.external_url.trim() } : {}),
      ...(fileKind && upload ? { object_key: upload.objectKey } : {}),
    };
    const parsed = MaterialInput.safeParse(body);
    const next: Record<string, string> = {};
    if (!parsed.success) for (const issue of parsed.error.issues) next[issue.path.join(".")] ??= issue.message;
    if (needsUpload && !upload) next.object_key = "ファイルをアップロードしてください（検査待ちの状態でも登録できます）。";
    setErrors(next);
    if (!parsed.success || Object.keys(next).length) return;
    try {
      const res = await mutation.mutateAsync(parsed.data);
      onSaved(res.data, !material);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
    }
  };

  const showBanner = mutation.error && !(mutation.error instanceof ApiError && Object.keys(mutation.error.fieldErrors).length);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !mutation.isPending && (o ? onOpenChange(o) : discard.requestClose())}
      title={material ? "教材を編集" : "教材を追加"}
      description={material ? `「${material.title}」を変更します。変更した教材は未公開に戻ります。` : "下書きバージョンの単元に教材を追加します。"}
      wide
    >
      <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="種類" required error={errors.kind} hint={material ? "種類は登録後に変更できません。" : KIND_HELP[values.kind]}>
          {(p) => (
            <Select {...p} value={values.kind} disabled={!!material} onChange={(e) => (set("kind", e.target.value as MaterialKind), setUpload(null))}>
              {MATERIAL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {MATERIAL_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="教材名" required error={errors.title}>
          {(p) => <Input {...p} maxLength={200} value={values.title} onChange={(e) => set("title", e.target.value)} />}
        </Field>
        {values.kind === "link" ? (
          <Field label="URL" required error={errors.external_url} hint="https:// から始まるURLのみ登録できます。" className="sm:col-span-2">
            {(p) => <Input {...p} type="url" inputMode="url" maxLength={2048} placeholder="https://" value={values.external_url} onChange={(e) => set("external_url", e.target.value)} />}
          </Field>
        ) : null}
        <Field
          label={values.kind === "assignment" ? "課題の説明" : values.kind === "quiz" ? "テストの説明" : "説明"}
          error={errors.description}
          className="sm:col-span-2"
        >
          {(p) => <Textarea {...p} maxLength={5000} value={values.description} onChange={(e) => set("description", e.target.value)} />}
        </Field>
        <div className="sm:col-span-2">
          <Checkbox label="必須教材（単元の完了条件に含める）" checked={values.required} onChange={(e) => set("required", e.target.checked)} />
        </div>
        {fileKind ? (
          <div className="sm:col-span-2">
            {material && !replacing ? (
              <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border border-line p-3 text-sm">
                <span className="break-all">{material.filename ?? "（ファイル名なし）"}</span>
                <span className="text-xs text-muted">{fileSizeLabel(material.size_bytes)}</span>
                <ScanStateBadge state={material.scan_state} />
                <Button variant="secondary" size="sm" onClick={() => setReplacing(true)}>
                  ファイルを差し替える
                </Button>
              </div>
            ) : (
              <>
                <MaterialFileUpload key={fileKind} kind={fileKind} initialFile={material ? null : initialFile} onReady={setUpload} label={material ? "差し替えるファイル" : "ファイル"} />
                {material ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      setReplacing(false);
                      setUpload(null);
                    }}
                  >
                    差し替えをやめる（現在のファイルのまま）
                  </Button>
                ) : null}
              </>
            )}
            {errors.object_key ? (
              <p role="alert" className="mt-1 text-xs font-medium text-danger">
                {errors.object_key}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="sm:col-span-2">
          <InlineError error={showBanner ? mutation.error : null} />
        </div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={discard.requestClose} disabled={mutation.isPending}>
            キャンセル
          </Button>
          <Button type="submit" loading={mutation.isPending} disabled={!online || (needsUpload && !upload)}>
            {material ? "変更を保存" : values.kind === "quiz" ? "登録して問題を設定" : "教材を登録"}
          </Button>
        </div>
      </form>
      {discard.element}
    </Dialog>
  );
}
