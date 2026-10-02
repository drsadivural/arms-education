import { useState } from "react";
import { Controller } from "react-hook-form";
import { Link, useLocation, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, ChartColumn } from "lucide-react";
import { STUDENT_STATUS_LABELS } from "@arms/contracts";
import { PageHeader } from "../../components/ui/PageHeader";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog";
import { ErrorState, InlineError, LastFetched, LoadingRows, Notice } from "../../components/ui/Feedback";
import { Checkbox, Field, Input, Select, Textarea } from "../../components/ui/Field";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { useToast } from "../../components/ui/Toast";
import { UnsavedChangesGuard } from "../../components/forms/UnsavedChangesGuard";
import { useApiForm } from "../../components/forms/useApiForm";
import { api } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { useCurrentUser } from "../../lib/session";
import { adminKeys } from "../../features/admin/keys";
import { useClassroomOptions, useDepartments, useNavigateAfterSave } from "../../features/admin/hooks";
import { DepartmentInput, FormSection, InvitationResultCard, InvitationStateBadge, SaveErrorBanner, VersionConflictNotice } from "../../features/admin/components";
import { applyApiErrors, isVersionConflict, providerSyncMessage } from "../../features/admin/errors";
import { StudentForm, TransferForm, studentDefaults, type StudentFormValues } from "../../features/admin/forms";
import { secondaryLinkClass } from "../../features/admin/styles";
import type { ActionResult, Classroom, CreatedState, DataResponse, Page, Student, StudentCreateResponse, Teacher } from "../../features/admin/types";

/** Selectable teachers of one classroom (active teachers assigned to it; primary first). */
function useClassroomTeachers(classroomId: string) {
  return useQuery({
    queryKey: adminKeys.classroomTeachers(classroomId),
    queryFn: ({ signal }) => api.get<Page<Teacher>>(`/classrooms/${classroomId}/teachers`, { signal }),
    enabled: !!classroomId,
    staleTime: 30_000,
  });
}

const classroomLabel = (c: Classroom) => `${c.name}（${c.student_count} / ${c.capacity}名）${c.student_count >= c.capacity ? " 満席" : ""}`;

/** WEB-06 新入社員を登録 / 新入社員情報の編集。クラス・担当講師の変更は「クラス移動」から理由付きで行う。 */
export function StudentFormPage() {
  const { id } = useParams();
  const isNew = !id;
  const student = useQuery({
    queryKey: adminKeys.student(id ?? "new"),
    queryFn: ({ signal }) => api.get<DataResponse<Student>>(`/students/${id}`, { signal }),
    enabled: !isNew,
  });
  if (!isNew && !student.data) {
    return (
      <div>
        <PageHeader title="新入社員の情報" crumbs={[{ label: "新入社員管理", to: "/students" }, { label: "新入社員の情報" }]} />
        <Card>{student.error ? <ErrorState error={student.error} onRetry={() => void student.refetch()} /> : <LoadingRows rows={8} label="新入社員の情報を読み込み中です" />}</Card>
      </div>
    );
  }
  return <StudentFormView key={id ?? "new"} student={student.data?.data} checkedAt={student.data?.checked_at} reload={async () => (await student.refetch()).data?.data} />;
}

function StudentFormView({ student, checkedAt, reload }: { student?: Student; checkedAt?: string; reload(): Promise<Student | undefined> }) {
  const user = useCurrentUser();
  const readOnly = !user.isAdmin;
  const isNew = !student;
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const location = useLocation();
  const goAfterSave = useNavigateAfterSave();
  const { departments } = useDepartments();
  const classrooms = useClassroomOptions("active");
  const created = (location.state as CreatedState | null)?.invitation;

  const form = useApiForm(StudentForm, studentDefaults(student));
  const { register, control, handleSubmit, formState, watch, setValue, getValues } = form;
  const errors = formState.errors;
  const classroomId = watch("classroom_id");
  const teachers = useClassroomTeachers(isNew ? classroomId : "");
  const [baseVersion, setBaseVersion] = useState(student?.row_version ?? 0);
  const [fieldsFailed, setFieldsFailed] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: adminKeys.students });
    void qc.invalidateQueries({ queryKey: adminKeys.classrooms });
    void qc.invalidateQueries({ queryKey: adminKeys.teachers });
    void qc.invalidateQueries({ queryKey: adminKeys.dashboardAll });
    void qc.invalidateQueries({ queryKey: adminKeys.users });
  };
  const adopt = (s: Student) => {
    qc.setQueryData(adminKeys.student(s.id), { data: s, checked_at: new Date().toISOString() });
    form.reset(studentDefaults(s));
    setBaseVersion(s.row_version);
  };

  const create = useIdempotentMutation((body: StudentFormValues, key: string) => api.post<StudentCreateResponse>("/students", body, { idempotencyKey: key }), {
    onSuccess: (res) => {
      form.reset(studentDefaults(res.data));
      invalidate();
      toast.success("新入社員を登録しました", res.invitation.state === "sent" ? "招待メールを送信しました。" : "招待メールの状態を確認してください。");
      goAfterSave(`/students/${res.data.id}`, { invitation: res.invitation } satisfies CreatedState);
    },
    onError: (e) => setFieldsFailed(applyApiErrors(form, e)),
  });
  const update = useMutation({
    mutationFn: (body: StudentFormValues) => api.patch<DataResponse<Student>>(`/students/${student?.id}`, body, { ifMatch: baseVersion }),
    onSuccess: (res) => {
      adopt(res.data);
      invalidate();
      toast.success("新入社員の情報を保存しました");
    },
    onError: (e) => setFieldsFailed(applyApiErrors(form, e)),
  });
  const archive = useMutation({
    mutationFn: () => api.delete<ActionResult>(`/students/${student?.id}`, { ifMatch: baseVersion }),
    onSuccess: async (res) => {
      setArchiveOpen(false);
      invalidate();
      toast.success(`${student?.display_name}さんを在籍終了にしました`, providerSyncMessage(res) ?? "アカウントは停止され、研修記録は保持されます。");
      const fresh = await reload();
      if (fresh) adopt(fresh);
    },
  });
  const saving = create.isPending || update.isPending;
  const saveError = create.error ?? update.error;

  const onSubmit = handleSubmit((values) => {
    if (saving || readOnly) return;
    setFieldsFailed(false);
    if (isNew) create.mutate(values);
    else update.mutate(values);
  });

  const reloadLatest = async () => {
    setReloading(true);
    try {
      const fresh = await reload();
      if (fresh) {
        adopt(fresh);
        update.reset();
        archive.reset();
      }
    } finally {
      setReloading(false);
    }
  };

  const onClassroomChange = (value: string) => {
    setValue("classroom_id", value, { shouldDirty: true, shouldValidate: formState.isSubmitted });
    // Teachers are specific to the classroom: never keep a teacher of the previous class.
    setValue("teacher_id", "", { shouldDirty: true });
    const c = classrooms.data?.find((x) => x.id === value);
    if (c) {
      if (!getValues("training_starts_on")) setValue("training_starts_on", c.starts_on, { shouldDirty: true });
      if (!getValues("training_due_on")) setValue("training_due_on", c.ends_on, { shouldDirty: true });
    }
  };

  const title = isNew ? "新入社員を登録" : readOnly ? `${student.display_name}さんの情報` : "新入社員情報の編集";
  return (
    <div>
      <PageHeader
        title={title}
        crumbs={[{ label: "新入社員管理", to: "/students" }, { label: isNew ? "新入社員を登録" : student.display_name }]}
        description={
          isNew
            ? "新規登録：受講者アカウントを作成し、招待メールを送信します。"
            : readOnly
              ? "閲覧のみ：情報の変更は管理者が行います。"
              : "編集：社員情報と研修期間を変更します。クラス・担当講師は「クラス移動」から変更します。"
        }
        actions={
          !isNew ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={student.active ? "success" : "neutral"}>{STUDENT_STATUS_LABELS[student.active ? "active" : "inactive"]}</Badge>
              <InvitationStateBadge state={student.invitation_state} />
              <Link to={`/progress?student_id=${student.id}`} className={secondaryLinkClass}>
                <ChartColumn className="size-4" aria-hidden />
                進捗を見る
              </Link>
            </span>
          ) : null
        }
      />
      {created ? <InvitationResultCard invitation={created} onChange={() => void qc.invalidateQueries({ queryKey: adminKeys.students })} /> : null}

      <form onSubmit={onSubmit} noValidate aria-label={title}>
        <fieldset disabled={readOnly} className="min-w-0">
          <FormSection title="社員情報">
            <Field label="社員番号" required error={errors.employee_number?.message}>
              {(p) => <Input {...p} {...register("employee_number")} autoComplete="off" placeholder="例: E129" />}
            </Field>
            <Field label="氏名" required error={errors.display_name?.message}>
              {(p) => <Input {...p} {...register("display_name")} autoComplete="off" placeholder="例: 中村 翔太" />}
            </Field>
            <Field label="ふりがな" error={errors.kana?.message}>
              {(p) => <Input {...p} {...register("kana")} autoComplete="off" placeholder="例: なかむら しょうた" />}
            </Field>
            <Field
              label="メールアドレス"
              required
              error={errors.email?.message}
              hint={isNew ? "招待メールの送信先で、ログインIDになります。" : "ログインIDのため変更できません。"}
            >
              {(p) => <Input {...p} {...register("email")} type="email" autoComplete="off" readOnly={!isNew} className={!isNew ? "bg-surface-2" : undefined} />}
            </Field>
            <Field label="会社名" error={errors.company_name?.message}>
              {(p) => <Input {...p} {...register("company_name")} autoComplete="organization" />}
            </Field>
            <Field label="所属部署" required error={errors.department_name?.message}>
              {(p) => (
                <Controller
                  control={control}
                  name="department_name"
                  render={({ field }) => <DepartmentInput {...p} departments={departments} value={field.value} onChange={field.onChange} onBlur={field.onBlur} />}
                />
              )}
            </Field>
            <Field label="入社日" required error={errors.joined_on?.message}>
              {(p) => <Input {...p} {...register("joined_on")} type="date" />}
            </Field>
          </FormSection>

          <FormSection title="研修の割当">
            {isNew ? (
              <>
                <Field label="所属クラス" required error={errors.classroom_id?.message ?? (classrooms.error ? "クラスを取得できませんでした。再読み込みしてください。" : undefined)}>
                  {(p) => (
                    <Select {...p} value={classroomId} onChange={(e) => onClassroomChange(e.target.value)} disabled={classrooms.isLoading}>
                      <option value="">{classrooms.isLoading ? "読み込み中…" : "クラスを選択してください"}</option>
                      {(classrooms.data ?? []).map((c) => (
                        <option key={c.id} value={c.id} disabled={c.student_count >= c.capacity}>
                          {classroomLabel(c)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field
                  label="担当講師"
                  required
                  error={errors.teacher_id?.message}
                  hint={classroomId && teachers.data?.items.length === 0 ? "このクラスに有効な講師がいません。クラス設定で講師を割り当ててください。" : undefined}
                >
                  {(p) => (
                    <Select {...p} {...register("teacher_id")} disabled={!classroomId || teachers.isLoading}>
                      <option value="">{!classroomId ? "先にクラスを選択してください" : teachers.isLoading ? "読み込み中…" : "担当講師を選択してください"}</option>
                      {(teachers.data?.items ?? []).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.display_name}
                          {t.classrooms.some((c) => c.id === classroomId && c.is_primary) ? "（主担当）" : ""}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                {teachers.error ? (
                  <div className="md:col-span-2">
                    <InlineError error={teachers.error} />
                  </div>
                ) : null}
              </>
            ) : (
              <div className="flex flex-col gap-2 md:col-span-2">
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-bold">所属クラス</dt>
                    <dd className="mt-1 text-sm">
                      <Link to={`/classrooms/${student.classroom_id}`} className="text-primary hover:underline">
                        {student.classroom_name}
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-bold">担当講師</dt>
                    <dd className="mt-1 text-sm">{student.teacher_name}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-bold">進捗</dt>
                    <dd className="mt-1">
                      <ProgressBar value={student.progress_percent} label={`${student.display_name}の進捗`} />
                    </dd>
                  </div>
                </dl>
                {!readOnly ? (
                  <div>
                    <Button variant="secondary" size="sm" icon={<ArrowLeftRight className="size-3.5" aria-hidden />} disabled={!online || !student.active} onClick={() => setTransferOpen(true)}>
                      クラス移動
                    </Button>
                    <p className="mt-1 text-xs text-muted">クラス・担当講師の変更は理由を記録して行います（定員を確認します）。</p>
                  </div>
                ) : null}
              </div>
            )}
            <Field label="研修開始日" required error={errors.training_starts_on?.message}>
              {(p) => <Input {...p} {...register("training_starts_on")} type="date" />}
            </Field>
            <Field label="終了予定日" required error={errors.training_due_on?.message}>
              {(p) => <Input {...p} {...register("training_due_on")} type="date" />}
            </Field>
            {isNew ? (
              <>
                <div className="md:col-span-2">
                  <Checkbox label="在籍として登録する（クラス定員の集計対象）" {...register("active")} />
                </div>
                <div className="md:col-span-2">
                  <Notice>担当講師は、選択したクラスに所属する有効な講師から選べます。</Notice>
                </div>
              </>
            ) : !student.active ? (
              <div className="md:col-span-2">
                <Checkbox label="在籍に戻す（クラスの定員に空きが必要です）" {...register("active")} />
              </div>
            ) : null}
          </FormSection>
        </fieldset>

        {readOnly ? null : (
          <div className="flex flex-col gap-3">
            {isVersionConflict(update.error) ? (
              <VersionConflictNotice onReload={() => void reloadLatest()} reloading={reloading} />
            ) : (
              <SaveErrorBanner error={saveError} onFields={fieldsFailed} />
            )}
            {!online ? <p className="text-xs text-warning">オフラインのため保存できません。</p> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                {!isNew && student.active ? (
                  <Button variant="ghost" className="text-danger" disabled={!online} onClick={() => (archive.reset(), setArchiveOpen(true))}>
                    在籍終了（アーカイブ）
                  </Button>
                ) : null}
                {!isNew ? <LastFetched checkedAt={checkedAt} /> : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Link to="/students" className={secondaryLinkClass}>
                  キャンセル
                </Link>
                <Button type="submit" loading={saving} disabled={!online}>
                  {isNew ? "登録して招待" : "変更を保存"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </form>
      <UnsavedChangesGuard when={!readOnly && formState.isDirty && !saving} />

      {!isNew && !readOnly ? (
        <>
          <TransferDialog
            open={transferOpen}
            onOpenChange={setTransferOpen}
            student={student}
            expectedVersion={baseVersion}
            classrooms={classrooms.data ?? []}
            onConflict={() => void reloadLatest()}
            onDone={(s) => {
              adopt(s);
              invalidate();
              setTransferOpen(false);
              toast.success("クラス・担当講師を変更しました", `${s.classroom_name} / ${s.teacher_name}`);
            }}
          />
          <ConfirmDialog
            open={archiveOpen}
            onOpenChange={(open) => !archive.isPending && setArchiveOpen(open)}
            title="在籍終了にしますか？"
            description={
              <p>
                <b>
                  {student.display_name}（{student.employee_number}）
                </b>
                を在籍終了にします。アカウントは停止されログインできなくなります。クラスの在籍人数から外れ、研修記録は保持されます。
              </p>
            }
            confirmLabel="在籍終了にする"
            loading={archive.isPending}
            onConfirm={() => !archive.isPending && archive.mutate()}
          >
            {isVersionConflict(archive.error) ? <VersionConflictNotice onReload={() => void reloadLatest()} reloading={reloading} /> : archive.error ? <InlineError error={archive.error} /> : null}
          </ConfirmDialog>
        </>
      ) : null}
    </div>
  );
}

function TransferDialog({
  open,
  onOpenChange,
  student,
  expectedVersion,
  classrooms,
  onDone,
  onConflict,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  student: Student;
  expectedVersion: number;
  classrooms: Classroom[];
  onDone(s: Student): void;
  onConflict(): void;
}) {
  const online = useOnline();
  const form = useApiForm(TransferForm, { classroom_id: student.classroom_id, teacher_id: "", reason: "" });
  const { register, handleSubmit, formState, watch, setValue } = form;
  const classroomId = watch("classroom_id");
  const teachers = useClassroomTeachers(open ? classroomId : "");
  const [fieldsFailed, setFieldsFailed] = useState(false);
  const transfer = useIdempotentMutation(
    (body: { classroom_id: string; teacher_id: string; reason: string; expected_version: number }, key: string) =>
      api.post<DataResponse<Student>>(`/students/${student.id}/transfer`, body, { idempotencyKey: key }),
    {
      onSuccess: (res) => {
        form.reset({ classroom_id: res.data.classroom_id, teacher_id: "", reason: "" });
        onDone(res.data);
      },
      onError: (e) => {
        setFieldsFailed(applyApiErrors(form, e));
        // Someone changed the student meanwhile: load the latest version so the next attempt can succeed.
        if (isVersionConflict(e)) onConflict();
      },
    },
  );
  const onSubmit = handleSubmit((v) => {
    if (transfer.isPending) return;
    setFieldsFailed(false);
    transfer.mutate({ ...v, expected_version: expectedVersion });
  });
  const unchanged = classroomId === student.classroom_id && watch("teacher_id") === student.teacher_id;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !transfer.isPending && onOpenChange(o)}
      title="クラス移動"
      description={`${student.display_name}（${student.employee_number}）の所属クラス・担当講師を変更します。理由は変更履歴に記録されます。`}
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <p className="text-xs text-muted">
          現在: {student.classroom_name} / {student.teacher_name}（研修開始 {fmt.date(student.training_starts_on)}）
        </p>
        <Field label="移動先のクラス" required error={formState.errors.classroom_id?.message}>
          {(p) => (
            <Select
              {...p}
              value={classroomId}
              onChange={(e) => {
                setValue("classroom_id", e.target.value, { shouldDirty: true });
                setValue("teacher_id", "", { shouldDirty: true });
              }}
            >
              <option value="">クラスを選択してください</option>
              {classrooms.map((c) => (
                <option key={c.id} value={c.id} disabled={c.id !== student.classroom_id && c.student_count >= c.capacity}>
                  {classroomLabel(c)}
                  {c.id === student.classroom_id ? "（現在のクラス）" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="担当講師" required error={formState.errors.teacher_id?.message} hint="移動先のクラスに所属する有効な講師から選べます。">
          {(p) => (
            <Select {...p} {...register("teacher_id")} disabled={!classroomId || teachers.isLoading}>
              <option value="">{teachers.isLoading ? "読み込み中…" : "担当講師を選択してください"}</option>
              {(teachers.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name}
                  {t.id === student.teacher_id && classroomId === student.classroom_id ? "（現在の担当）" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="変更理由" required error={formState.errors.reason?.message}>
          {(p) => <Textarea {...p} {...register("reason")} placeholder="例: 配属部署の変更に伴いBクラスへ移動" />}
        </Field>
        {teachers.error ? <InlineError error={teachers.error} /> : null}
        {isVersionConflict(transfer.error) ? (
          <InlineError error={transfer.error} />
        ) : transfer.error && !fieldsFailed ? (
          <InlineError error={transfer.error} />
        ) : (
          <SaveErrorBanner error={transfer.error} onFields={fieldsFailed} />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={transfer.isPending} onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button type="submit" loading={transfer.isPending} disabled={!online || unchanged}>
            移動する
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
