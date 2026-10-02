import { useState } from "react";
import { Controller } from "react-hook-form";
import { Link, useLocation, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "../../components/ui/PageHeader";
import { Card } from "../../components/ui/Card";
import { ActiveBadge, Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ErrorState, LastFetched, LoadingRows, Notice } from "../../components/ui/Feedback";
import { Checkbox, Field, Input } from "../../components/ui/Field";
import { TagInput } from "../../components/ui/TagInput";
import { useToast } from "../../components/ui/Toast";
import { UnsavedChangesGuard } from "../../components/forms/UnsavedChangesGuard";
import { useApiForm } from "../../components/forms/useApiForm";
import { api } from "../../lib/api";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { useCurrentUser } from "../../lib/session";
import { adminKeys } from "../../features/admin/keys";
import { useDepartments, useNavigateAfterSave } from "../../features/admin/hooks";
import { DepartmentInput, FormSection, InvitationResultCard, InvitationStateBadge, SaveErrorBanner, VersionConflictNotice, WeekdayPicker } from "../../features/admin/components";
import { applyApiErrors, isVersionConflict } from "../../features/admin/errors";
import { TeacherForm, teacherDefaults, toTeacherInput } from "../../features/admin/forms";
import { secondaryLinkClass } from "../../features/admin/styles";
import type { CreatedState, DataResponse, Teacher, TeacherCreateResponse } from "../../features/admin/types";

/** WEB-04 講師を登録 / 講師情報の編集（追加・編集で共通のフォーム）。講師ロールは閲覧のみ。 */
export function TeacherFormPage() {
  const { id } = useParams();
  const isNew = !id;
  const teacher = useQuery({
    queryKey: adminKeys.teacher(id ?? "new"),
    queryFn: ({ signal }) => api.get<DataResponse<Teacher>>(`/teachers/${id}`, { signal }),
    enabled: !isNew,
  });

  if (!isNew && !teacher.data) {
    return (
      <div>
        <PageHeader title="講師情報" crumbs={[{ label: "講師管理", to: "/teachers" }, { label: "講師情報" }]} />
        <Card>{teacher.error ? <ErrorState error={teacher.error} onRetry={() => void teacher.refetch()} /> : <LoadingRows rows={8} label="講師情報を読み込み中です" />}</Card>
      </div>
    );
  }
  return <TeacherFormView key={id ?? "new"} teacher={teacher.data?.data} checkedAt={teacher.data?.checked_at} reload={async () => (await teacher.refetch()).data?.data} />;
}

function TeacherFormView({ teacher, checkedAt, reload }: { teacher?: Teacher; checkedAt?: string; reload(): Promise<Teacher | undefined> }) {
  const user = useCurrentUser();
  const readOnly = !user.isAdmin;
  const isNew = !teacher;
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const location = useLocation();
  const goAfterSave = useNavigateAfterSave();
  const { departments } = useDepartments();
  const created = (location.state as CreatedState | null)?.invitation;

  const form = useApiForm(TeacherForm, teacherDefaults(teacher));
  const { register, control, handleSubmit, formState } = form;
  const errors = formState.errors;
  const [baseVersion, setBaseVersion] = useState(teacher?.row_version ?? 0);
  const [fieldsFailed, setFieldsFailed] = useState(false);
  const [reloading, setReloading] = useState(false);

  const create = useIdempotentMutation((body: ReturnType<typeof toTeacherInput>, key: string) => api.post<TeacherCreateResponse>("/teachers", body, { idempotencyKey: key }), {
    onSuccess: (res) => {
      form.reset(teacherDefaults(res.data));
      void qc.invalidateQueries({ queryKey: adminKeys.teachers });
      void qc.invalidateQueries({ queryKey: adminKeys.users });
      toast.success("講師を登録しました", res.invitation.state === "sent" ? "招待メールを送信しました。" : "招待メールの状態を確認してください。");
      goAfterSave(`/teachers/${res.data.id}`, { invitation: res.invitation } satisfies CreatedState);
    },
    onError: (e) => setFieldsFailed(applyApiErrors(form, e)),
  });
  const update = useMutation({
    mutationFn: (body: ReturnType<typeof toTeacherInput>) => api.patch<DataResponse<Teacher>>(`/teachers/${teacher?.id}`, body, { ifMatch: baseVersion }),
    onSuccess: (res) => {
      qc.setQueryData(adminKeys.teacher(res.data.id), res);
      void qc.invalidateQueries({ queryKey: adminKeys.teachers });
      void qc.invalidateQueries({ queryKey: adminKeys.users });
      form.reset(teacherDefaults(res.data));
      setBaseVersion(res.data.row_version);
      toast.success("講師情報を保存しました");
    },
    onError: (e) => setFieldsFailed(applyApiErrors(form, e)),
  });
  const saving = create.isPending || update.isPending;
  const saveError = create.error ?? update.error;

  const onSubmit = handleSubmit((values) => {
    if (saving || readOnly) return;
    setFieldsFailed(false);
    const body = toTeacherInput(values);
    if (isNew) create.mutate(body);
    else update.mutate(body);
  });

  const reloadLatest = async () => {
    setReloading(true);
    try {
      const fresh = await reload();
      if (fresh) {
        form.reset(teacherDefaults(fresh));
        setBaseVersion(fresh.row_version);
        update.reset();
      }
    } finally {
      setReloading(false);
    }
  };

  const title = isNew ? "講師を登録" : readOnly ? `${teacher.display_name}さんの講師情報` : "講師情報の編集";
  return (
    <div>
      <PageHeader
        title={title}
        crumbs={[{ label: "講師管理", to: "/teachers" }, { label: isNew ? "講師を登録" : teacher.display_name }]}
        description={
          isNew
            ? "新規登録：講師アカウントを作成し、招待メールを送信します。"
            : readOnly
              ? "閲覧のみ：講師情報の変更は管理者が行います。"
              : "編集：登録済みの講師情報を変更します。メールアドレスはログインIDのため変更できません。"
        }
        actions={
          !isNew ? (
            <span className="flex flex-wrap items-center gap-2">
              <ActiveBadge active={teacher.active} />
              <InvitationStateBadge state={teacher.invitation_state} />
              <LastFetched checkedAt={checkedAt} />
            </span>
          ) : null
        }
      />
      {created ? <InvitationResultCard invitation={created} onChange={() => void qc.invalidateQueries({ queryKey: adminKeys.teachers })} /> : null}
      {isNew ? (
        <div className="mb-5">
          <Notice>招待後、講師が初回ログインしてパスワードを設定します。</Notice>
        </div>
      ) : null}

      <form onSubmit={onSubmit} noValidate aria-label={title}>
        <fieldset disabled={readOnly} className="min-w-0">
          <FormSection title="基本情報">
            <Field label="講師番号" required error={errors.teacher_number?.message}>
              {(p) => <Input {...p} {...register("teacher_number")} autoComplete="off" placeholder="例: T005" />}
            </Field>
            <Field label="氏名" required error={errors.display_name?.message}>
              {(p) => <Input {...p} {...register("display_name")} autoComplete="off" placeholder="例: 佐藤 直子" />}
            </Field>
            <Field label="ふりがな" error={errors.kana?.message}>
              {(p) => <Input {...p} {...register("kana")} autoComplete="off" placeholder="例: さとう なおこ" />}
            </Field>
            <Field
              label="メールアドレス"
              required
              error={errors.email?.message}
              hint={isNew ? "招待メールの送信先で、ログインIDになります。" : "ログインIDのため変更できません。別のアドレスを使う場合は新しいアカウントとして招待してください。"}
            >
              {(p) => <Input {...p} {...register("email")} type="email" autoComplete="off" readOnly={!isNew} className={!isNew ? "bg-surface-2" : undefined} />}
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
            <Field label="専門分野" error={errors.specialties?.message} hint="Enterまたは「、」で追加（最大20件）">
              {(p) => (
                <Controller
                  control={control}
                  name="specialties"
                  render={({ field }) => <TagInput {...p} value={field.value} onChange={field.onChange} onBlur={field.onBlur} placeholder="例: IT基礎" disabled={readOnly} />}
                />
              )}
            </Field>
          </FormSection>

          <FormSection title="担当と稼働時間" description="担当クラスは「クラスルーム管理」のクラス設定で割り当てます。">
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <p className="text-xs font-bold">担当クラス</p>
              {isNew || teacher.classrooms.length === 0 ? (
                <p className="text-sm text-muted">{isNew ? "登録後、クラス設定で主担当・補助講師に割り当てられます。" : "担当しているクラスはありません。"}</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {teacher.classrooms.map((c) => (
                    <li key={c.id}>
                      <Link to={`/classrooms/${c.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface-2">
                        {c.name}
                        <Badge tone={c.is_primary ? "info" : "neutral"}>{c.is_primary ? "主担当" : "補助"}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {!isNew ? <p className="text-xs text-muted">担当受講者: {teacher.student_count}名</p> : null}
            </div>
            <div className="md:col-span-2">
              <Controller
                control={control}
                name="weekdays"
                render={({ field }) => <WeekdayPicker legend="稼働曜日" value={field.value} onChange={field.onChange} error={errors.weekdays?.message} disabled={readOnly} />}
              />
            </div>
            <Field label="開始時刻" error={errors.start_time?.message}>
              {(p) => <Input {...p} {...register("start_time")} type="time" />}
            </Field>
            <Field label="終了時刻" error={errors.end_time?.message}>
              {(p) => <Input {...p} {...register("end_time")} type="time" />}
            </Field>
            <div className="md:col-span-2">
              <Checkbox label="有効（ログインと担当割当を許可する）" {...register("active")} />
              <p className="text-xs text-muted">無効にすると講師はログインできなくなります。主担当のクラスや今後の授業枠がある場合は無効にできません。</p>
            </div>
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
            <div className="flex flex-wrap justify-end gap-2">
              <Link to="/teachers" className={secondaryLinkClass}>
                キャンセル
              </Link>
              <Button type="submit" loading={saving} disabled={!online}>
                {isNew ? "登録して招待" : "変更を保存"}
              </Button>
            </div>
          </div>
        )}
      </form>
      <UnsavedChangesGuard when={!readOnly && formState.isDirty && !saving} />
    </div>
  );
}

