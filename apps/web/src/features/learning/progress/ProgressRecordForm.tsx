import { useEffect, useId } from "react";
import { PROGRESS_RECORD_STATES, PROGRESS_RECORD_STATE_LABELS, ProgressRecordInput, ProgressRecordUpdateInput } from "@arms/contracts";
import { UnsavedChangesGuard } from "../../../components/forms/UnsavedChangesGuard";
import { useApiForm } from "../../../components/forms/useApiForm";
import { Button } from "../../../components/ui/Button";
import { InlineError } from "../../../components/ui/Feedback";
import { Field, Input, Select, Textarea } from "../../../components/ui/Field";
import { ApiError } from "../../../lib/api";
import { useOnline } from "../../../lib/online";
import { useCurrentUser } from "../../../lib/session";
import { useDepartments, useTeachersLookup, type ProgressRecord } from "../api";
import { progressColumnLabels } from "../format";
import { StudentPicker } from "../StudentPicker";

export interface RecordFormValues {
  student_id: string;
  teacher_id: string;
  department_name: string;
  due_date: string;
  content: string;
  notes: string;
  state: ProgressRecord["state"];
  correction_reason?: string;
}

export function recordToValues(r: ProgressRecord | null, defaults: Partial<RecordFormValues> = {}): RecordFormValues {
  return {
    student_id: r?.student_id ?? defaults.student_id ?? "",
    teacher_id: r?.teacher_id ?? defaults.teacher_id ?? "",
    department_name: r?.department_name ?? defaults.department_name ?? "",
    due_date: r?.due_date ?? defaults.due_date ?? "",
    content: r?.content ?? "",
    notes: r?.notes ?? "",
    state: r?.state ?? "not_started",
    ...(r ? { correction_reason: "" } : {}),
  };
}

/**
 * Shared add/edit form of a 教育記録 with the legacy columns (終了予定日・社員名・教育担当部署・教育担当者・内容). Edit mode
 * is a correction: changing any value requires 訂正理由, recorded with before/after, actor and time.
 */
export function ProgressRecordForm({
  record,
  defaults,
  submitting,
  submitError,
  onSubmit,
  onCancel,
  guardNavigation,
  onDirtyChange,
}: {
  record: ProgressRecord | null;
  defaults?: Partial<RecordFormValues>;
  submitting: boolean;
  submitError: unknown;
  onSubmit(values: RecordFormValues): Promise<RecordFormValues | void>;
  onCancel?(): void;
  guardNavigation?: boolean;
  onDirtyChange?(dirty: boolean): void;
}) {
  const user = useCurrentUser();
  const online = useOnline();
  const listId = useId();
  const editing = !!record;
  const form = useApiForm(editing ? ProgressRecordUpdateInput : ProgressRecordInput, recordToValues(record, defaults));
  const teachers = useTeachersLookup();
  const { departments } = useDepartments();
  const values = form.watch();
  const errors = form.formState.errors as Partial<Record<keyof RecordFormValues, { message?: string }>>;
  const dirty = form.formState.isDirty;

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  useEffect(() => {
    if (submitError instanceof ApiError) form.applyServerErrors(submitError);
  }, [submitError, form]);

  // Teachers may only name themselves as 教育担当者 when setting or changing it (the API enforces the same rule).
  const teacherOptions = (teachers.data?.items ?? []).filter((t) => {
    if (user.isTeacher) return t.id === user.id || t.id === record?.teacher_id;
    return t.active || t.id === record?.teacher_id;
  });

  const submit = form.handleSubmit(async (v) => {
    const out = v as unknown as RecordFormValues;
    if (editing && !out.correction_reason?.trim()) {
      form.setError("correction_reason" as never, { type: "required", message: "訂正理由を入力してください。" });
      return;
    }
    const saved = await onSubmit(out);
    if (saved) form.reset(saved);
  });

  const pickTeacher = (teacherId: string) => {
    form.setValue("teacher_id", teacherId, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
    const t = teachers.data?.items.find((x) => x.id === teacherId);
    if (t?.department_name && !form.getValues("department_name")) form.setValue("department_name", t.department_name, { shouldDirty: true });
  };

  return (
    <form onSubmit={submit} noValidate aria-label={editing ? "教育記録を訂正" : "教育記録を登録"} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {guardNavigation ? <UnsavedChangesGuard when={dirty && !submitting} /> : null}
      <Field label={progressColumnLabels.due_date} required error={errors.due_date?.message}>
        {(p) => <Input {...p} type="date" {...form.register("due_date")} />}
      </Field>
      <StudentPicker
        label={progressColumnLabels.student_name}
        required
        value={values.student_id}
        selectedLabel={record ? `${record.student_name}（${record.employee_number}）` : undefined}
        error={errors.student_id && !values.student_id ? "社員名を選択してください。" : errors.student_id?.message}
        onChange={(s) => {
          form.setValue("student_id", s?.id ?? "", { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
          if (s && !form.getValues("teacher_id")) {
            const own = user.isTeacher ? user.id : s.teacher_id;
            if (teacherOptions.some((t) => t.id === own)) pickTeacher(own);
          }
        }}
      />
      <Field label={progressColumnLabels.department_name} required error={errors.department_name?.message} hint="組織設定の部署から選ぶか、旧データの部署名を入力します。">
        {(p) => (
          <>
            <Input {...p} list={`${listId}-departments`} maxLength={100} autoComplete="off" {...form.register("department_name")} />
            <datalist id={`${listId}-departments`}>
              {departments.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field label={progressColumnLabels.teacher_name} required error={errors.teacher_id && !values.teacher_id ? "教育担当者を選択してください。" : errors.teacher_id?.message} hint={user.isTeacher ? "講師は自分を教育担当者として登録できます。" : undefined}>
        {(p) => (
          <Select {...p} value={values.teacher_id} onChange={(e) => pickTeacher(e.target.value)}>
            <option value="">{teachers.isLoading ? "読み込み中…" : "選択してください"}</option>
            {record && !teacherOptions.some((t) => t.id === record.teacher_id) ? <option value={record.teacher_id}>{record.teacher_name}</option> : null}
            {teacherOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.display_name}
                {t.department_name ? `（${t.department_name}）` : ""}
                {t.active ? "" : "（停止中）"}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={progressColumnLabels.content} required error={errors.content?.message} className="sm:col-span-2">
        {(p) => <Input {...p} maxLength={2000} {...form.register("content")} />}
      </Field>
      <Field label="状態" required error={errors.state?.message} hint="期限超過は終了予定日と今日（日本時間）から自動で判定されます。">
        {(p) => (
          <Select {...p} {...form.register("state")}>
            {PROGRESS_RECORD_STATES.map((s) => (
              <option key={s} value={s}>
                {PROGRESS_RECORD_STATE_LABELS[s]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="備考" error={errors.notes?.message}>
        {(p) => <Textarea {...p} maxLength={5000} className="min-h-10" {...form.register("notes")} />}
      </Field>
      {editing ? (
        <Field label="訂正理由" required error={errors.correction_reason?.message} hint="変更前後の値・理由・実施者・日時が変更履歴に記録されます。" className="sm:col-span-2">
          {(p) => <Textarea {...p} maxLength={1000} className="min-h-16" {...form.register("correction_reason" as never)} />}
        </Field>
      ) : null}
      <div className="sm:col-span-2">
        <InlineError error={submitError && !(submitError instanceof ApiError && Object.keys(submitError.fieldErrors).length) ? submitError : null} />
      </div>
      <div className="flex justify-end gap-2 sm:col-span-2">
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel} disabled={submitting}>
            キャンセル
          </Button>
        ) : null}
        <Button type="submit" loading={submitting} disabled={!online || (editing && !dirty)}>
          {editing ? "訂正を保存" : "登録する"}
        </Button>
      </div>
    </form>
  );
}
