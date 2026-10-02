import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ProgramInput } from "@arms/contracts";
import { UnsavedChangesGuard } from "../../../components/forms/UnsavedChangesGuard";
import { useApiForm } from "../../../components/forms/useApiForm";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader } from "../../../components/ui/Card";
import { InlineError } from "../../../components/ui/Feedback";
import { Field, Input, Select, Textarea } from "../../../components/ui/Field";
import { useToast } from "../../../components/ui/Toast";
import { ApiError, api } from "../../../lib/api";
import { useOnline } from "../../../lib/online";
import { useIdempotentMutation } from "../../../lib/query";
import { learningKeys, useDepartments, type DataResponse, type Program } from "../api";

interface Values {
  name: string;
  description: string;
  department_name: string;
}

const toValues = (p?: Program | null): Values => ({ name: p?.name ?? "", description: p?.description ?? "", department_name: p?.department_name ?? "" });

/**
 * Shared add/edit form of a program (WEB-10 プログラム情報). Add mode creates the program (POST, Idempotency-Key) and
 * moves to its edit screen; edit mode saves with If-Match. Teachers see it read-only.
 */
export function ProgramInfoForm({ program, readOnly, versionSelector }: { program: Program | null; readOnly: boolean; versionSelector?: React.ReactNode }) {
  const mode = program ? "edit" : "create";
  const toast = useToast();
  const qc = useQueryClient();
  const online = useOnline();
  const navigate = useNavigate();
  const { departments } = useDepartments();
  const form = useApiForm(ProgramInput, toValues(program));
  const [goTo, setGoTo] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (goTo) navigate(goTo, { replace: true });
  }, [goTo, navigate]);

  // Keep the form in sync with a reloaded program unless the user is editing.
  useEffect(() => {
    if (program && !form.formState.isDirty) form.reset(toValues(program));
  }, [program, form]);

  const create = useIdempotentMutation((input: Values, key: string) => api.post<DataResponse<Program>>("/programs", input, { idempotencyKey: key }));
  const update = useIdempotentMutation((input: Values & { row_version: number }) => {
    const { row_version, ...body } = input;
    return api.patch<DataResponse<Program>>(`/programs/${program!.id}`, body, { ifMatch: row_version });
  });
  const mutation = mode === "create" ? create : update;

  const onSubmit = form.handleSubmit(async (values) => {
    const body: Values = { name: values.name, description: values.description, department_name: values.department_name ?? "" };
    setConflict(false);
    try {
      if (mode === "create") {
        const res = await create.mutateAsync(body);
        form.reset(toValues(res.data));
        qc.invalidateQueries({ queryKey: ["learning", "programs"] });
        toast.success("プログラムを登録しました", "続けてバージョンを作成し、単元と教材を設定してください。");
        setGoTo(`/programs/${res.data.id}`);
      } else {
        const res = await update.mutateAsync({ ...body, row_version: program!.row_version });
        qc.setQueryData(learningKeys.program(res.data.id), res);
        form.reset(toValues(res.data));
        qc.invalidateQueries({ queryKey: ["learning", "programs"] });
        toast.success("プログラム情報を保存しました");
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "VERSION_CONFLICT") setConflict(true);
      form.applyServerErrors(e);
    }
  });

  const reload = async () => {
    if (!program) return;
    const fresh = await qc.fetchQuery({ queryKey: learningKeys.program(program.id), queryFn: () => api.get<DataResponse<Program>>(`/programs/${program.id}`), staleTime: 0 });
    form.reset(toValues(fresh.data));
    setConflict(false);
    mutation.reset();
  };

  const errors = form.formState.errors;
  const current = form.watch("department_name") ?? "";
  const options = current && !departments.includes(current) ? [current, ...departments] : departments;
  const fieldDisabled = readOnly || !!program?.archived || mutation.isPending;

  return (
    <Card>
      <UnsavedChangesGuard when={form.formState.isDirty && !readOnly} />
      <CardHeader title="プログラム情報" description={mode === "create" ? "登録後にバージョンを作成し、単元と教材を設定します。" : undefined} />
      <form onSubmit={onSubmit} noValidate aria-label="プログラム情報">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="名称" required error={errors.name?.message}>
            {(p) => <Input {...p} maxLength={200} {...form.register("name")} disabled={fieldDisabled} />}
          </Field>
          <Field label="対象部署" error={errors.department_name?.message} hint="「全部署」はすべての部署が対象です。">
            {(p) => (
              <Select {...p} {...form.register("department_name")} disabled={fieldDisabled}>
                <option value="">全部署</option>
                {options.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="説明" error={errors.description?.message} className="md:col-span-1">
            {(p) => <Textarea {...p} maxLength={5000} className="min-h-10" {...form.register("description")} disabled={fieldDisabled} />}
          </Field>
          {versionSelector ? <div>{versionSelector}</div> : null}
        </div>
        {conflict ? (
          <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 rounded-[var(--radius-control)] border border-warning/50 bg-warning-soft px-3 py-2 text-xs">
            他の利用者がこのプログラムを更新しました。最新の内容を読み込んでから、もう一度保存してください。
            <Button size="sm" variant="secondary" onClick={reload}>
              最新の内容を読み込む
            </Button>
          </div>
        ) : (
          <div className="mt-4">
            <InlineError error={mutation.error && !(mutation.error instanceof ApiError && Object.keys(mutation.error.fieldErrors).length) ? mutation.error : null} />
          </div>
        )}
        {!readOnly && !program?.archived ? (
          <div className="mt-4 flex justify-end gap-2">
            <Button type="submit" loading={mutation.isPending} disabled={!online || (mode === "edit" && !form.formState.isDirty)}>
              {mode === "create" ? "登録する" : "プログラム情報を保存"}
            </Button>
          </div>
        ) : null}
        {program?.archived ? <p className="mt-3 text-xs text-muted">このプログラムはアーカイブ済みのため変更できません。</p> : null}
      </form>
    </Card>
  );
}
