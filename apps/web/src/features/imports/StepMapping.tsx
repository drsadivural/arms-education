import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PlayCircle } from "lucide-react";
import {
  IMPORT_ENCODINGS,
  IMPORT_ENCODING_LABELS,
  IMPORT_ENTITY_LABELS,
  IMPORT_FIELDS,
  suggestImportMapping,
  type ImportEncoding,
} from "@arms/contracts";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Field, Input, Select } from "../../components/ui/Field";
import { InlineError, Notice } from "../../components/ui/Feedback";
import { ApiError } from "../../lib/api";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { importsApi, type ImportJob, type ImportMappingBody } from "./api";
import { SimpleTable, td, type Draft } from "./common";

interface Props {
  draft: Draft;
  /** Existing job (mapping correction) or null (the job is created on the first dry run). */
  job: ImportJob | null;
  onJobCreated(job: ImportJob): void;
  onValidated(job: ImportJob): void;
  onBack(): void;
}

/** {target field → source header} from the job's {source header → target field}. */
function byField(columns: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(columns).map(([header, field]) => [field, header]));
}

/** 2 項目の対応: target fields (required markers, empty-cell meaning) ← CSV columns, then the dry run. */
export function StepMapping({ draft, job, onJobCreated, onValidated, onBack }: Props) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const defs = IMPORT_FIELDS[draft.entity];
  const [encoding, setEncoding] = useState<ImportEncoding>(job?.encoding ?? draft.encoding);
  const [sourceSystem, setSourceSystem] = useState(job?.source_system ?? draft.sourceSystem);
  const [selected, setSelected] = useState<Record<string, string>>(() =>
    job ? byField(job.mapping) : byField(suggestImportMapping(draft.entity, draft.headers)),
  );
  const [clientErrors, setClientErrors] = useState<Record<string, string>>({});

  const sampleOf = useMemo(() => {
    const index = new Map(draft.headers.map((h, i) => [h, i]));
    return (header: string) => {
      const i = index.get(header);
      if (i === undefined) return "";
      return draft.sample.map((r) => r[i] ?? "").find((v) => v.trim() !== "") ?? "";
    };
  }, [draft.headers, draft.sample]);

  const run = useIdempotentMutation(
    async (vars: { body: ImportMappingBody; jobId: string | null; version: number | null }, key: string) => {
      let current: ImportJob;
      if (vars.jobId && vars.version !== null) current = (await importsApi.update(vars.jobId, vars.body, vars.version)).data;
      else {
        current = (await importsApi.create(vars.body, key)).data;
        onJobCreated(current);
      }
      queryClient.setQueryData(["imports", current.id], { data: current, checked_at: new Date().toISOString() });
      return (await importsApi.validate(current.id)).data;
    },
    {
      onSuccess(validated) {
        void queryClient.invalidateQueries({ queryKey: ["imports", "list"] });
        onValidated(validated);
      },
    },
  );

  function submit() {
    const errors: Record<string, string> = {};
    for (const d of defs) if (d.required && !selected[d.field]) errors[`mapping.${d.field}`] = `${d.label}は必須です。対応する列を選択してください。`;
    const used = new Map<string, string[]>();
    for (const [field, header] of Object.entries(selected)) if (header) used.set(header, [...(used.get(header) ?? []), field]);
    for (const fields of used.values()) {
      if (fields.length > 1) for (const f of fields) errors[`mapping.${f}`] = "同じ列を複数の項目に対応付けることはできません。";
    }
    setClientErrors(errors);
    if (Object.keys(errors).length > 0 || sourceSystem.trim() === "") return;
    const columns: Record<string, string> = {};
    for (const [field, header] of Object.entries(selected)) if (header) columns[header] = field;
    run.mutate({
      body: { source_system: sourceSystem.trim(), encoding, entity: draft.entity, columns, upload_id: draft.uploadId },
      jobId: job?.id ?? null,
      version: job?.row_version ?? null,
    });
  }

  const serverErrors = run.error instanceof ApiError ? run.error.fieldErrors : {};
  const errorOf = (field: string) => clientErrors[`mapping.${field}`] ?? serverErrors[`mapping.${field}`];
  const encodingProblem = run.error instanceof ApiError && run.error.code.startsWith("IMPORT_ENCODING");

  return (
    <Card aria-labelledby="import-step2">
      <CardHeader
        id="import-step2"
        title={`項目の対応（${IMPORT_ENTITY_LABELS[draft.entity]}）`}
        description={`ファイル: ${draft.filename}。ARMSの項目ごとに、旧システムのCSVの列を選択してください。* は必須です。`}
      />
      <div className="mb-4 grid gap-4 md:grid-cols-2">
        <Field label="文字コード" required error={encodingProblem ? (run.error as ApiError).messageJa : undefined}>
          {(a) => (
            <Select {...a} value={encoding} onChange={(e) => setEncoding(e.target.value as ImportEncoding)}>
              {IMPORT_ENCODINGS.map((e) => (
                <option key={e} value={e}>
                  {IMPORT_ENCODING_LABELS[e]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="移行元システム名" required error={sourceSystem.trim() === "" ? "必須項目です。" : serverErrors.source_system}>
          {(a) => <Input {...a} value={sourceSystem} maxLength={100} onChange={(e) => setSourceSystem(e.target.value)} />}
        </Field>
      </div>
      <SimpleTable caption="ARMSの項目と旧システムの列の対応" head={["ARMS項目", "旧システムの列", "空欄の場合", "値の例"]}>
        {defs.map((d) => {
          const error = errorOf(d.field);
          const header = selected[d.field] ?? "";
          return (
            <tr key={d.field}>
              <th scope="row" className={`${td} text-left font-medium`}>
                {d.label}
                {d.required ? (
                  <>
                    <span className="ml-1 text-danger" aria-hidden>
                      *
                    </span>
                    <span className="sr-only">（必須）</span>
                  </>
                ) : null}
                {d.key ? <span className="ml-2 text-[11px] font-normal text-muted">照合キー</span> : null}
              </th>
              <td className={td}>
                <Select
                  aria-label={`${d.label}に対応する列`}
                  aria-invalid={!!error}
                  value={header}
                  onChange={(e) => setSelected((prev) => ({ ...prev, [d.field]: e.target.value }))}
                  className="min-w-[180px]"
                >
                  <option value="">（対応しない）</option>
                  {draft.headers
                    .filter((h) => h !== "")
                    .map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                </Select>
                {error ? (
                  <p role="alert" className="mt-1 text-xs font-medium text-danger">
                    {error}
                  </p>
                ) : null}
              </td>
              <td className={`${td} text-xs text-muted`}>{d.empty}</td>
              <td className={`${td} max-w-[200px] truncate text-xs`}>{header ? sampleOf(header) : "—"}</td>
            </tr>
          );
        })}
      </SimpleTable>
      <div className="mt-4">
        <Notice>ドライランでは全行を検証し、移行後の内容と行ごとのエラーを表示します。この時点ではデータは変更しません。</Notice>
      </div>
      {run.error && !encodingProblem && !(run.error instanceof ApiError && run.error.code === "IMPORT_MAPPING_INVALID") ? (
        <div className="mt-4">
          <InlineError error={run.error} />
        </div>
      ) : null}
      <div className="mt-6 flex flex-wrap justify-between gap-2">
        <Button variant="secondary" onClick={onBack} disabled={run.isPending}>
          {job?.state === "validated" ? "検証結果に戻る" : "ファイルを選び直す"}
        </Button>
        <Button icon={<PlayCircle className="size-4" aria-hidden />} onClick={submit} loading={run.isPending} disabled={!online}>
          ドライランを実行
        </Button>
      </div>
    </Card>
  );
}
