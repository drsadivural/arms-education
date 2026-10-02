import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { QUIZ_SCORE_POLICY_LABELS, VersionInput } from "@arms/contracts";
import { VersionStateBadge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader } from "../../../components/ui/Card";
import { Dialog } from "../../../components/ui/Dialog";
import { ErrorState, InlineError, LastFetched, LoadingRows, Notice } from "../../../components/ui/Feedback";
import { Field, Input, Select } from "../../../components/ui/Field";
import { useToast } from "../../../components/ui/Toast";
import { ApiError, api } from "../../../lib/api";
import { fmt } from "../../../lib/format";
import { useOnline } from "../../../lib/online";
import { useIdempotentMutation } from "../../../lib/query";
import { learningKeys, type DataResponse, type Program, type ProgramVersion } from "../api";
import { versionLabel } from "../format";

export function versionOptionLabel(v: ProgramVersion): string {
  if (v.state === "draft") return `下書き ${versionLabel(v.version_number)}（編集中）`;
  if (v.state === "published") return `公開中 ${versionLabel(v.version_number)}（参照のみ）`;
  return `公開終了 ${versionLabel(v.version_number)}（参照のみ）`;
}

/** Banner explaining what editing means for the selected version (published versions are immutable). */
export function VersionNotice({ versions, selected }: { versions: ProgramVersion[]; selected: ProgramVersion | null }) {
  const published = versions.find((v) => v.state === "published");
  const draft = versions.find((v) => v.state === "draft");
  let text: string;
  if (!selected) text = "バージョンがまだありません。「新しいバージョンを作成」で下書きを作成し、単元と教材を登録してください。";
  else if (selected.state === "draft" && published)
    text = `公開中 ${versionLabel(published.version_number)} の学習記録を保持し、変更は下書き ${versionLabel(selected.version_number)} として保存します。公開すると、これから割り当てる受講者に ${versionLabel(selected.version_number)} が適用されます。`;
  else if (selected.state === "draft") text = `下書き ${versionLabel(selected.version_number)} を編集しています。公開すると受講の割当ができるようになります。`;
  else
    text = `${versionLabel(selected.version_number)} は${selected.state === "published" ? "公開中" : "公開終了"}のため変更できません（受講中の新入社員は割り当てられたバージョンのまま学習を続けます）。${
      draft ? `変更は下書き ${versionLabel(draft.version_number)} で行ってください。` : "変更するには「新しいバージョンを作成」で下書きを作成してください。"
    }`;
  return <Notice>{text}</Notice>;
}

interface CreateValues {
  max_quiz_attempts: string;
  quiz_score_policy: "highest" | "latest";
  source_version_id: string;
}

function CreateVersionDialog({ open, onOpenChange, program, versions, onCreated }: { open: boolean; onOpenChange(o: boolean): void; program: Program; versions: ProgramVersion[]; onCreated(v: ProgramVersion): void }) {
  const published = versions.find((v) => v.state === "published");
  const base = published ?? versions[0];
  const [values, setValues] = useState<CreateValues>(() => ({
    max_quiz_attempts: String(base?.policy.max_quiz_attempts ?? 3),
    quiz_score_policy: base?.policy.quiz_score_policy ?? "highest",
    source_version_id: published?.id ?? "",
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const toast = useToast();
  const online = useOnline();
  const mutation = useIdempotentMutation((body: unknown, key: string) => api.post<DataResponse<ProgramVersion>>(`/programs/${program.id}/versions`, body, { idempotencyKey: key }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      policy: { max_quiz_attempts: Number(values.max_quiz_attempts), quiz_score_policy: values.quiz_score_policy },
      ...(values.source_version_id ? { source_version_id: values.source_version_id } : {}),
    };
    const parsed = VersionInput.safeParse(body);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] = issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    try {
      const res = await mutation.mutateAsync(parsed.data);
      toast.success(`下書き ${versionLabel(res.data.version_number)} を作成しました`, values.source_version_id ? "コピー元の単元と教材を複製しました。教材は公開前に再確認してください。" : undefined);
      onCreated(res.data);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)} title="新しいバージョンを作成" description="受験回数の上限と採点方式はバージョンごとに固定され、公開後は変更できません。">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="確認テストの受験回数上限" required error={errors["policy.max_quiz_attempts"]} hint="1〜100回">
          {(p) => (
            <Input {...p} type="number" inputMode="numeric" min={1} max={100} value={values.max_quiz_attempts} onChange={(e) => setValues({ ...values, max_quiz_attempts: e.target.value })} />
          )}
        </Field>
        <Field label="採点方式（複数回受験したとき）" required error={errors["policy.quiz_score_policy"]}>
          {(p) => (
            <Select {...p} value={values.quiz_score_policy} onChange={(e) => setValues({ ...values, quiz_score_policy: e.target.value as CreateValues["quiz_score_policy"] })}>
              {(Object.keys(QUIZ_SCORE_POLICY_LABELS) as (keyof typeof QUIZ_SCORE_POLICY_LABELS)[]).map((k) => (
                <option key={k} value={k}>
                  {QUIZ_SCORE_POLICY_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="単元・教材のコピー元" error={errors.source_version_id} hint="コピーした教材は未公開の状態で複製されます。ファイルの検査結果は引き継がれます。">
          {(p) => (
            <Select {...p} value={values.source_version_id} onChange={(e) => setValues({ ...values, source_version_id: e.target.value })}>
              <option value="">コピーしない（空の下書き）</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {versionLabel(v.version_number)}（{v.state === "published" ? "公開中" : v.state === "draft" ? "下書き" : "公開終了"}・単元{v.unit_count}・教材{v.material_count}）
                </option>
              ))}
            </Select>
          )}
        </Field>
        <InlineError error={mutation.error && !(mutation.error instanceof ApiError && Object.keys(mutation.error.fieldErrors).length) ? mutation.error : null} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            キャンセル
          </Button>
          <Button type="submit" loading={mutation.isPending} disabled={!online}>
            下書きを作成
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Version history (下書き/公開中/公開終了) with the fixed policy and DB-aggregated counts. */
export function VersionPanel({
  program,
  versions,
  checkedAt,
  isLoading,
  error,
  onRetry,
  selectedId,
  onSelect,
  canManage,
}: {
  program: Program;
  versions: ProgramVersion[] | undefined;
  checkedAt: string | null;
  isLoading: boolean;
  error: unknown;
  onRetry(): void;
  selectedId: string | null;
  onSelect(id: string): void;
  canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const hasDraft = !!versions?.some((v) => v.state === "draft");
  const online = useOnline();
  return (
    <Card aria-labelledby="versions-heading">
      <CardHeader
        id="versions-heading"
        title="バージョン"
        description="公開中のバージョンは変更できません。既存の受講者は割り当てられたバージョンのまま学習を続け、新しいバージョンの公開後に割り当てた受講者から新しい内容が適用されます。"
        actions={
          canManage && !program.archived ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="size-3.5" aria-hidden />}
              disabled={hasDraft || !online || !versions}
              title={hasDraft ? "編集中の下書きがあります。下書きを公開してから作成してください。" : undefined}
              onClick={() => setCreating(true)}
            >
              新しいバージョンを作成
            </Button>
          ) : null
        }
      />
      {canManage && hasDraft ? <p className="mb-3 text-xs text-muted">編集中の下書きがあるため、新しいバージョンは作成できません。下書きを編集・公開してください。</p> : null}
      {isLoading && !versions ? (
        <LoadingRows rows={2} label="バージョンを読み込み中です" />
      ) : error && !versions ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : versions && versions.length === 0 ? (
        <p className="py-4 text-sm text-muted">{canManage ? "バージョンがありません。「新しいバージョンを作成」から最初の下書きを作成してください。" : "バージョンはまだ作成されていません。"}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">バージョン一覧</caption>
            <thead>
              <tr className="bg-surface-2 text-left text-xs text-muted">
                <th scope="col" className="px-3 py-2 font-medium">バージョン</th>
                <th scope="col" className="px-3 py-2 font-medium">状態</th>
                <th scope="col" className="px-3 py-2 font-medium">単元・教材</th>
                <th scope="col" className="px-3 py-2 font-medium">必須の重み合計</th>
                <th scope="col" className="px-3 py-2 font-medium">受験回数・採点</th>
                <th scope="col" className="px-3 py-2 font-medium">公開日時</th>
                <th scope="col" className="px-3 py-2 font-medium">表示</th>
              </tr>
            </thead>
            <tbody>
              {versions?.map((v) => (
                <tr key={v.id} className="border-b border-line last:border-b-0" aria-current={v.id === selectedId ? "true" : undefined}>
                  <td className="px-3 py-3 font-bold">{versionLabel(v.version_number)}</td>
                  <td className="px-3 py-3">
                    <VersionStateBadge state={v.state} />
                  </td>
                  <td className="px-3 py-3">
                    {v.unit_count}単元 / {v.material_count}教材
                  </td>
                  <td className="px-3 py-3 tabular-nums">{v.required_weight_total}</td>
                  <td className="px-3 py-3 text-xs">
                    {v.policy.max_quiz_attempts}回・{QUIZ_SCORE_POLICY_LABELS[v.policy.quiz_score_policy]}
                  </td>
                  <td className="px-3 py-3 text-xs">{v.published_at ? fmt.dateTime(v.published_at) : "—"}</td>
                  <td className="px-3 py-3">
                    {v.id === selectedId ? (
                      <span className="text-xs font-bold text-primary">表示中</span>
                    ) : (
                      <Button variant="link" size="sm" className="text-xs" onClick={() => onSelect(v.id)} aria-label={`${versionLabel(v.version_number)}を表示`}>
                        表示する
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <LastFetched checkedAt={checkedAt} className="mt-3" />
      {creating && versions ? (
        <CreateVersionDialog
          open={creating}
          onOpenChange={setCreating}
          program={program}
          versions={versions}
          onCreated={(v) => {
            qc.invalidateQueries({ queryKey: learningKeys.versions(program.id) });
            qc.invalidateQueries({ queryKey: learningKeys.program(program.id) });
            qc.invalidateQueries({ queryKey: ["learning", "programs"] });
            onSelect(v.id);
          }}
        />
      ) : null}
    </Card>
  );
}
