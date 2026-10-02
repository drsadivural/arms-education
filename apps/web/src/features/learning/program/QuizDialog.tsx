import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QuizDefinitionInput } from "@arms/contracts";
import { Button } from "../../../components/ui/Button";
import { Dialog } from "../../../components/ui/Dialog";
import { ErrorState, InlineError, LastFetched, LoadingRows, Notice } from "../../../components/ui/Feedback";
import { QuizEditor, emptyQuestion, fromQuizDefinition, toQuizDefinitionInput, type QuizDraft } from "../../../components/ui/QuizEditor";
import { useToast } from "../../../components/ui/Toast";
import { ApiError, api } from "../../../lib/api";
import { useOnline } from "../../../lib/online";
import { useIdempotentMutation } from "../../../lib/query";
import { learningKeys, type DataResponse, type Material, type QuizDefinition } from "../api";
import { useDiscardConfirm } from "../useDiscardConfirm";

/** Maps Zod issues / API field_errors ("questions.0.prompt") onto the editor. */
export function quizErrors(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) out[issue.path.map(String).join(".")] ??= issue.message;
  return out;
}

/** 確認テストの問題を編集 (GET/PUT /materials/{id}/quiz-definition — answers are visible to admin/teacher only). */
export function QuizDialog({ open, onOpenChange, material, onSaved }: { open: boolean; onOpenChange(o: boolean): void; material: Material; onSaved(): void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const def = useQuery({
    queryKey: learningKeys.quizDefinition(material.id),
    queryFn: () => api.get<DataResponse<QuizDefinition>>(`/materials/${material.id}/quiz-definition`),
    staleTime: 0,
  });
  const [draft, setDraft] = useState<QuizDraft | null>(null);
  const [initial, setInitial] = useState<string>("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (def.data && draft === null) {
      const d = def.data.data;
      const next = d.questions.length ? fromQuizDefinition(d) : { title: d.title, questions: [emptyQuestion()] };
      setDraft(next);
      setInitial(JSON.stringify(toQuizDefinitionInput(next)));
    }
  }, [def.data, draft]);
  const editable = def.data?.data.editable ?? false;
  const save = useIdempotentMutation((body: unknown, key: string) => api.put(`/materials/${material.id}/quiz-definition`, body, { idempotencyKey: key }));
  const dirty = !!draft && JSON.stringify(toQuizDefinitionInput(draft)) !== initial;
  const discard = useDiscardConfirm(dirty && editable, () => onOpenChange(false));

  const submit = async () => {
    if (!draft) return;
    const parsed = QuizDefinitionInput.safeParse(toQuizDefinitionInput(draft));
    if (!parsed.success) {
      setErrors(quizErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    try {
      await save.mutateAsync(parsed.data);
      const total = parsed.data.questions.reduce((s, q) => s + q.points, 0);
      toast.success("確認テストを保存しました", `${parsed.data.questions.length}問・合計${total}点。公開前に教材の「公開準備」を行ってください。`);
      await qc.invalidateQueries({ queryKey: learningKeys.quizDefinition(material.id) });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && (o ? onOpenChange(o) : discard.requestClose())} title="確認テストの問題を編集" description={`「${material.title}」`} wide>
      {def.isLoading ? (
        <LoadingRows rows={3} label="問題を読み込み中です" />
      ) : def.error ? (
        <ErrorState error={def.error} onRetry={() => void def.refetch()} />
      ) : draft ? (
        <div className="flex flex-col gap-4">
          {!editable ? <Notice tone="warning">公開済みのバージョンの確認テストは変更できません（閲覧のみ）。変更するには新しいバージョンを作成してください。</Notice> : null}
          <p className="text-xs text-muted">合格点：{def.data?.data.pass_score}点（単元の設定）。正答は管理者・講師のみが閲覧でき、受講者には表示されません。</p>
          <QuizEditor value={draft} onChange={setDraft} errors={errors} disabled={!editable || save.isPending} />
          <InlineError error={save.error && !(save.error instanceof ApiError && Object.keys(save.error.fieldErrors).length) ? save.error : null} />
          <div className="flex items-center justify-between gap-2">
            <LastFetched checkedAt={def.data?.checked_at} />
            <div className="flex gap-2">
              <Button variant="secondary" onClick={discard.requestClose} disabled={save.isPending}>
                {editable ? "キャンセル" : "閉じる"}
              </Button>
              {editable ? (
                <Button onClick={submit} loading={save.isPending} disabled={!online}>
                  問題を保存
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {discard.element}
    </Dialog>
  );
}
