import { useState } from "react";
import { Upload } from "lucide-react";
import { IMPORT_DEFAULT_SOURCE_SYSTEM, IMPORT_ENCODINGS, IMPORT_ENCODING_LABELS, IMPORT_ENTITIES, IMPORT_ENTITY_LABELS, type ImportEncoding, type ImportEntity } from "@arms/contracts";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Field";
import { InlineError, Notice } from "../../components/ui/Feedback";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { uploadImportFile } from "./api";
import { SimpleTable, td, type Draft } from "./common";
import { fileProblem, previewFile, type CsvPreview } from "./preview";

const ENTITY_HINTS: Record<ImportEntity, string> = {
  teachers: "講師番号・氏名・メール。講師番号で照合します（同姓同名は別人として扱います）。",
  classrooms: "クラス番号・名称・定員・期間・主担当講師番号。講師を先に移行してください。",
  students: "社員番号・氏名・メール・部署・入社日・クラス番号・担当講師番号。クラスを先に移行してください。",
  progress: "旧システムの社員教育進捗（終了予定日・社員番号・教育担当部署・教育担当者・内容）。新入社員を先に移行してください。",
};

interface Props {
  onUploaded(draft: Draft): void;
}

/** 1 ファイル選択: data kind, legacy system name, CSV file, encoding with a local preview, then the quarantined upload. */
export function StepUpload({ onUploaded }: Props) {
  const online = useOnline();
  const [entity, setEntity] = useState<ImportEntity>("teachers");
  const [sourceSystem, setSourceSystem] = useState(IMPORT_DEFAULT_SOURCE_SYSTEM);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<(CsvPreview & { decodeFailed: boolean }) | null>(null);
  const [encoding, setEncoding] = useState<ImportEncoding>("utf-8-bom");
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  async function choose(next: File | null) {
    setFile(next);
    setPreview(null);
    setScanMessage(null);
    upload.reset();
    if (!next) return;
    const problem = fileProblem(next);
    setFileError(problem);
    if (problem) return;
    const p = await previewFile(next);
    setEncoding(p.encoding);
    setPreview(p);
  }

  async function changeEncoding(next: ImportEncoding) {
    setEncoding(next);
    if (file) setPreview(await previewFile(file, next));
  }

  const upload = useIdempotentMutation(
    async (_vars: { name: string; size: number; lastModified: number }, key: string) => {
      if (!file) throw new Error("no file");
      setScanMessage(null);
      return uploadImportFile(file, key, { onScanning: () => setScanMessage("ファイルを検査しています。しばらくお待ちください…") });
    },
    {
      onSuccess(outcome) {
        if (outcome.kind === "clean" && file && preview) {
          onUploaded({
            entity,
            sourceSystem: sourceSystem.trim() || IMPORT_DEFAULT_SOURCE_SYSTEM,
            encoding,
            uploadId: outcome.uploadId,
            filename: file.name,
            headers: preview.headers,
            sample: preview.rows,
          });
        } else if (outcome.kind === "unscanned") {
          setScanMessage(
            "ファイル検査（マルウェアスキャン）サービスが設定されていないため、アップロードしたファイルを取り込めません。システム管理者にファイル検査サービスの設定を依頼してください。",
          );
        } else {
          setScanMessage("ファイルの検査に時間がかかっています。しばらくしてから、もう一度「アップロードして次へ」を押してください。");
        }
      },
    },
  );

  const canUpload = !!file && !fileError && !!preview && !preview.decodeFailed && preview.headers.length > 0 && sourceSystem.trim() !== "";
  const mismatch = preview && preview.detected !== "ascii" && preview.detected !== "unknown" && preview.detected !== encoding;

  return (
    <Card aria-labelledby="import-step1">
      <CardHeader id="import-step1" title="移行するファイルを選択" description="CSV（UTF-8・UTF-8 BOM付き・Shift_JIS）、10MB・10,000行まで。ファイルは非公開で検査・保管され、数式やHTMLは実行しません。" />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="移行するデータ" required hint={ENTITY_HINTS[entity]}>
          {(a) => (
            <Select {...a} value={entity} onChange={(e) => setEntity(e.target.value as ImportEntity)}>
              {IMPORT_ENTITIES.map((e, i) => (
                <option key={e} value={e}>
                  {i + 1}. {IMPORT_ENTITY_LABELS[e]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="移行元システム名" required hint="再移行するときは同じ名称にしてください（旧システムのIDで照合します）。" error={sourceSystem.trim() === "" ? "必須項目です。" : undefined}>
          {(a) => <Input {...a} value={sourceSystem} maxLength={100} onChange={(e) => setSourceSystem(e.target.value)} />}
        </Field>
        <Field label="CSVファイル" required error={fileError ?? undefined} className="md:col-span-2">
          {(a) => (
            <input
              {...a}
              type="file"
              accept=".csv,text/csv"
              className="block w-full text-sm file:mr-3 file:rounded-[var(--radius-control)] file:border file:border-line file:bg-surface-2 file:px-3 file:py-2 file:text-sm"
              onChange={(e) => void choose(e.target.files?.[0] ?? null)}
            />
          )}
        </Field>
      </div>

      {preview ? (
        <section aria-labelledby="import-preview" className="mt-6">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 id="import-preview" className="text-sm font-bold">
                文字コード・プレビュー
              </h3>
              <p className="mt-1 text-xs text-muted">
                判定結果: {preview.detected === "unknown" ? "判別できません" : IMPORT_ENCODING_LABELS[preview.detected]}
              </p>
            </div>
            <Field label="文字コード" required className="min-w-[220px]">
              {(a) => (
                <Select {...a} value={encoding} onChange={(e) => void changeEncoding(e.target.value as ImportEncoding)}>
                  {IMPORT_ENCODINGS.map((e) => (
                    <option key={e} value={e}>
                      {IMPORT_ENCODING_LABELS[e]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {mismatch ? <Notice tone="warning">選択した文字コードとファイルの判定結果が異なります。文字化けしていないかプレビューで確認してください。</Notice> : null}
          {preview.decodeFailed ? (
            <Notice tone="warning">この文字コードではファイルを読み取れません。別の文字コードを選択してください。</Notice>
          ) : preview.headers.length === 0 ? (
            <Notice tone="warning">1行目に見出し（列名）がありません。</Notice>
          ) : (
            <div className="mt-3">
              <SimpleTable caption="ファイルの先頭行のプレビュー" head={preview.headers.map((h, i) => h || `（列${i + 1}）`)}>
                {preview.rows.map((r, i) => (
                  <tr key={i}>
                    {preview.headers.map((_, j) => (
                      <td key={j} className={`${td} max-w-[240px] truncate whitespace-pre-line`}>
                        {r[j] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </SimpleTable>
              <p className="mt-2 text-[11px] text-muted">先頭{preview.rows.length}行を表示しています。値は文字列として扱い、数式は実行しません。</p>
            </div>
          )}
        </section>
      ) : null}

      {scanMessage ? (
        <div className="mt-4">
          <Notice tone={upload.data?.kind === "unscanned" ? "warning" : "info"}>{scanMessage}</Notice>
        </div>
      ) : null}
      {upload.error ? (
        <div className="mt-4">
          <InlineError error={upload.error} />
        </div>
      ) : null}
      <div className="mt-6 flex justify-end">
        <Button
          icon={<Upload className="size-4" aria-hidden />}
          disabled={!canUpload || !online}
          loading={upload.isPending}
          onClick={() => file && upload.mutate({ name: file.name, size: file.size, lastModified: file.lastModified })}
        >
          アップロードして次へ
        </Button>
      </div>
    </Card>
  );
}
