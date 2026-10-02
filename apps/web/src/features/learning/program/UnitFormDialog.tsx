import { useState } from "react";
import { UnitInput } from "@arms/contracts";
import { Button } from "../../../components/ui/Button";
import { Dialog } from "../../../components/ui/Dialog";
import { InlineError } from "../../../components/ui/Feedback";
import { Checkbox, Field, Input } from "../../../components/ui/Field";
import { ApiError, api } from "../../../lib/api";
import { useOnline } from "../../../lib/online";
import { useIdempotentMutation } from "../../../lib/query";
import type { DataResponse, Unit } from "../api";
import { useDiscardConfirm } from "../useDiscardConfirm";

interface Values {
  title: string;
  position: string;
  required: boolean;
  weight: string;
  pass_score: string;
  required_attendance: boolean;
  requires_review: boolean;
}

/** UnitInput body from a unit (PATCH /units is a full replacement: every field is sent). */
export function unitBody(u: Pick<Unit, "title" | "position" | "required" | "weight" | "pass_score" | "required_attendance" | "requires_review">) {
  return {
    title: u.title,
    position: u.position,
    required: u.required,
    weight: u.weight,
    ...(u.pass_score === null ? {} : { pass_score: u.pass_score }),
    required_attendance: u.required_attendance,
    requires_review: u.requires_review,
  };
}

function toValues(unit: Unit | null, nextPosition: number): Values {
  return {
    title: unit?.title ?? "",
    position: String(unit?.position ?? nextPosition),
    required: unit?.required ?? true,
    weight: unit ? String(unit.weight) : "10",
    pass_score: unit?.pass_score === null || unit?.pass_score === undefined ? (unit ? "" : "80") : String(unit.pass_score),
    required_attendance: unit?.required_attendance ?? false,
    requires_review: unit?.requires_review ?? false,
  };
}

/** Shared add/edit form of a unit of a draft version (順序・必須・重み・合格点・出席・講師承認). */
export function UnitFormDialog({
  open,
  onOpenChange,
  versionId,
  unit,
  nextPosition,
  onSaved,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  versionId: string;
  unit: Unit | null;
  nextPosition: number;
  onSaved(unit: Unit, created: boolean): void;
}) {
  const [initial] = useState<Values>(() => toValues(unit, nextPosition));
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const discard = useDiscardConfirm(JSON.stringify(values) !== JSON.stringify(initial), () => onOpenChange(false));
  const online = useOnline();
  const create = useIdempotentMutation((body: unknown, key: string) => api.post<DataResponse<Unit>>(`/program-versions/${versionId}/units`, body, { idempotencyKey: key }));
  const update = useIdempotentMutation((body: unknown) => api.patch<DataResponse<Unit>>(`/units/${unit!.id}`, body, { ifMatch: unit!.row_version }));
  const mutation = unit ? update : create;
  const set = <K extends keyof Values>(k: K, v: Values[K]) => setValues((prev) => ({ ...prev, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      title: values.title,
      position: values.position === "" ? Number.NaN : Number(values.position),
      required: values.required,
      weight: values.weight === "" ? Number.NaN : Number(values.weight),
      ...(values.pass_score.trim() === "" ? {} : { pass_score: Number(values.pass_score) }),
      required_attendance: values.required_attendance,
      requires_review: values.requires_review,
    };
    const parsed = UnitInput.safeParse(body);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[issue.path.join(".")] ??= issue.message;
      setErrors(next);
      return;
    }
    setErrors({});
    try {
      const res = await mutation.mutateAsync(parsed.data);
      onSaved(res.data, !unit);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
    }
  };

  const showBanner = mutation.error && !(mutation.error instanceof ApiError && Object.keys(mutation.error.fieldErrors).length);
  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && (o ? onOpenChange(o) : discard.requestClose())} title={unit ? "単元を編集" : "単元を追加"} description={unit ? `「${unit.title}」の設定を変更します。` : "下書きバージョンに単元を追加します。"}>
      <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="単元名" required error={errors.title} className="sm:col-span-2">
          {(p) => <Input {...p} maxLength={200} value={values.title} onChange={(e) => set("title", e.target.value)} />}
        </Field>
        <Field label="順序" required error={errors.position} hint="小さい順に表示されます（同じ番号は使えません）。">
          {(p) => <Input {...p} type="number" inputMode="numeric" min={0} max={10000} value={values.position} onChange={(e) => set("position", e.target.value)} />}
        </Field>
        <Field label="重み" required error={errors.weight} hint="進捗率＝完了した必須単元の重み÷必須単元の重みの合計">
          {(p) => <Input {...p} type="number" inputMode="decimal" min={0.01} max={10000} step="any" value={values.weight} onChange={(e) => set("weight", e.target.value)} />}
        </Field>
        <Field label="確認テストの合格点" error={errors.pass_score} hint="0〜100点。空欄の場合は100点（全問正解）が合格条件です。">
          {(p) => <Input {...p} type="number" inputMode="decimal" min={0} max={100} step="any" value={values.pass_score} onChange={(e) => set("pass_score", e.target.value)} />}
        </Field>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Checkbox label="必須単元（全体進捗の計算に含める）" checked={values.required} onChange={(e) => set("required", e.target.checked)} />
          <Checkbox label="授業への出席が必要" checked={values.required_attendance} onChange={(e) => set("required_attendance", e.target.checked)} />
          <Checkbox label="課題の講師承認が必要" checked={values.requires_review} onChange={(e) => set("requires_review", e.target.checked)} />
          <p className="text-xs text-muted">任意単元は全体進捗の分母に含まれません。動画だけの単元は、確認テスト・課題・出席のいずれかを必須にしないと公開できません。</p>
        </div>
        <div className="sm:col-span-2">
          <InlineError error={showBanner ? mutation.error : null} />
        </div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={discard.requestClose} disabled={mutation.isPending}>
            キャンセル
          </Button>
          <Button type="submit" loading={mutation.isPending} disabled={!online}>
            {unit ? "変更を保存" : "単元を追加"}
          </Button>
        </div>
      </form>
      {discard.element}
    </Dialog>
  );
}
