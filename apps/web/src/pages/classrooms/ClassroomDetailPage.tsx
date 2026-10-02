import { useMemo, useState } from "react";
import { Controller } from "react-hook-form";
import { Link, useParams } from "react-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { CLASSROOM_STATUS_LABELS, zonedDateString } from "@arms/contracts";
import { PageHeader } from "../../components/ui/PageHeader";
import { Card, StatCard } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { DataTable, type ColumnDef } from "../../components/ui/DataTable";
import { ErrorState, InlineError, LastFetched, LoadingRows, Notice } from "../../components/ui/Feedback";
import { Field, Input, Select } from "../../components/ui/Field";
import { MultiSelect, type MultiSelectOption } from "../../components/ui/MultiSelect";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { useToast } from "../../components/ui/Toast";
import { UnsavedChangesGuard } from "../../components/forms/UnsavedChangesGuard";
import { useApiForm } from "../../components/forms/useApiForm";
import { api } from "../../lib/api";
import { fmt, ORG_TZ } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { useCurrentUser } from "../../lib/session";
import { adminKeys } from "../../features/admin/keys";
import { useCursorList, useNavigateAfterSave, useTeacherOptions } from "../../features/admin/hooks";
import { FormSection, ListCount, PersonCell, SaveErrorBanner, VersionConflictNotice } from "../../features/admin/components";
import { applyApiErrors, conflictDetail, isVersionConflict } from "../../features/admin/errors";
import { ClassroomForm, classroomDefaults, type ClassroomFormValues } from "../../features/admin/forms";
import { trainingStatus } from "../../features/admin/labels";
import { secondaryLinkClass } from "../../features/admin/styles";
import type { ActionResult, Classroom, Dashboard, DataResponse, Page, Program, ProgramVersion, Student } from "../../features/admin/types";

/** WEB-08 クラスの詳細（クラス追加・編集の共通フォーム、主担当/補助講師、教育プログラム、在籍一覧）。 */
export function ClassroomDetailPage() {
  const { id } = useParams();
  const isNew = !id;
  const classroom = useQuery({
    queryKey: adminKeys.classroom(id ?? "new"),
    queryFn: ({ signal }) => api.get<DataResponse<Classroom>>(`/classrooms/${id}`, { signal }),
    enabled: !isNew,
  });
  if (!isNew && !classroom.data) {
    return (
      <div>
        <PageHeader title="クラスの詳細" crumbs={[{ label: "クラスルーム管理", to: "/classrooms" }, { label: "クラスの詳細" }]} />
        <Card>{classroom.error ? <ErrorState error={classroom.error} onRetry={() => void classroom.refetch()} /> : <LoadingRows rows={8} label="クラスを読み込み中です" />}</Card>
      </div>
    );
  }
  return (
    <ClassroomView
      key={id ?? "new"}
      classroom={classroom.data?.data}
      checkedAt={classroom.data?.checked_at}
      reload={async () => (await classroom.refetch()).data?.data}
    />
  );
}

/**
 * Published versions offered for linking: GET /programs?status=published (one published version per program —
 * publishing archives the previous one). The version number comes from latest_version when that is the published
 * version, otherwise from GET /program-versions/{id}.
 */
function useProgramVersionOptions(enabled: boolean) {
  const programs = useQuery({
    queryKey: adminKeys.programs,
    queryFn: async ({ signal }) => {
      const out: Program[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page: Page<Program> = await api.get<Page<Program>>("/programs", { query: { status: "published", limit: 100, cursor: cursor ?? undefined }, signal });
        out.push(...page.items);
        cursor = page.next_cursor;
        if (!cursor) break;
      }
      return out;
    },
    enabled,
    staleTime: 60_000,
  });
  const published = (programs.data ?? []).filter((p) => !p.archived && p.published_version_id);
  const unknown = published.filter((p) => p.latest_version?.id !== p.published_version_id);
  const versions = useQueries({
    queries: unknown.map((p) => ({
      queryKey: adminKeys.programVersion(p.published_version_id as string),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.get<DataResponse<ProgramVersion>>(`/program-versions/${p.published_version_id}`, { signal }),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const versionNumber = new Map<string, number>();
  for (const p of published) if (p.latest_version && p.latest_version.id === p.published_version_id) versionNumber.set(p.latest_version.id, p.latest_version.version_number);
  versions.forEach((v) => {
    if (v.data) versionNumber.set(v.data.data.id, v.data.data.version_number);
  });
  return { programs, published, versionNumber };
}

function ClassroomView({ classroom, checkedAt, reload }: { classroom?: Classroom; checkedAt?: string; reload(): Promise<Classroom | undefined> }) {
  const user = useCurrentUser();
  const isNew = !classroom;
  const readOnly = !user.isAdmin || !!classroom?.archived;
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const goAfterSave = useNavigateAfterSave();
  const activeTeachers = useTeacherOptions({ status: "active" }, user.isAdmin);
  const assignedTeachers = useTeacherOptions({ classroom_id: classroom?.id }, !isNew);
  const programOptions = useProgramVersionOptions(user.isAdmin);
  const dashboard = useQuery({
    queryKey: adminKeys.dashboard({ classroom_id: classroom?.id }),
    queryFn: ({ signal }) => api.get<DataResponse<Dashboard>>("/dashboard", { query: { classroom_id: classroom?.id }, signal }),
    enabled: !isNew,
  });

  const form = useApiForm(ClassroomForm, classroomDefaults(classroom));
  const { register, control, handleSubmit, formState, watch, setValue, getValues } = form;
  const errors = formState.errors;
  const primaryId = watch("primary_teacher_id");
  const [baseVersion, setBaseVersion] = useState(classroom?.row_version ?? 0);
  const [fieldsFailed, setFieldsFailed] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: adminKeys.classrooms });
    void qc.invalidateQueries({ queryKey: adminKeys.teachers });
    void qc.invalidateQueries({ queryKey: adminKeys.dashboardAll });
  };
  const adopt = (c: Classroom) => {
    qc.setQueryData(adminKeys.classroom(c.id), { data: c, checked_at: new Date().toISOString() });
    form.reset(classroomDefaults(c));
    setBaseVersion(c.row_version);
  };

  const create = useIdempotentMutation((body: ClassroomFormValues, key: string) => api.post<DataResponse<Classroom>>("/classrooms", body, { idempotencyKey: key }), {
    onSuccess: (res) => {
      form.reset(classroomDefaults(res.data));
      invalidate();
      toast.success("クラスを追加しました", res.data.name);
      goAfterSave(`/classrooms/${res.data.id}`);
    },
    onError: (e) => setFieldsFailed(applyApiErrors(form, e)),
  });
  const update = useMutation({
    mutationFn: (body: ClassroomFormValues) => api.patch<DataResponse<Classroom>>(`/classrooms/${classroom?.id}`, body, { ifMatch: baseVersion }),
    onSuccess: (res) => {
      adopt(res.data);
      invalidate();
      toast.success("クラス設定を保存しました");
    },
    onError: (e) => setFieldsFailed(applyApiErrors(form, e)),
  });
  const archive = useMutation({
    mutationFn: () => api.delete<ActionResult>(`/classrooms/${classroom?.id}`, { ifMatch: baseVersion }),
    onSuccess: async () => {
      setArchiveOpen(false);
      invalidate();
      toast.success(`${classroom?.name}をアーカイブしました`, "一覧の「アーカイブ済み」から参照できます。");
      const fresh = await reload();
      if (fresh) adopt(fresh);
    },
  });
  const saving = create.isPending || update.isPending;
  const saveError = create.error ?? update.error;

  const onSubmit = handleSubmit((values) => {
    if (saving || readOnly) return;
    setFieldsFailed(false);
    const body: ClassroomFormValues = { ...values, assistant_teacher_ids: values.assistant_teacher_ids.filter((t) => t !== values.primary_teacher_id) };
    if (isNew) create.mutate(body);
    else update.mutate(body);
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

  // Teacher choices: active teachers + teachers already assigned (a stopped assistant may stay assigned).
  const teacherChoices = useMemo(() => {
    const map = new Map<string, { id: string; name: string; active: boolean }>();
    for (const t of assignedTeachers.data ?? []) map.set(t.id, { id: t.id, name: t.display_name, active: t.active });
    for (const t of activeTeachers.data ?? []) map.set(t.id, { id: t.id, name: t.display_name, active: true });
    if (classroom?.primary_teacher_id && !map.has(classroom.primary_teacher_id)) {
      map.set(classroom.primary_teacher_id, { id: classroom.primary_teacher_id, name: classroom.primary_teacher_name, active: true });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }, [activeTeachers.data, assignedTeachers.data, classroom]);
  const assistantOptions: MultiSelectOption[] = teacherChoices
    .filter((t) => t.id !== primaryId)
    .map((t) => ({ value: t.id, label: t.name, description: t.active ? undefined : "停止中（現在の割当のみ維持できます）", disabled: !t.active && !classroom?.assistant_teacher_ids.includes(t.id) }));

  const programChoices: MultiSelectOption[] = useMemo(() => {
    const map = new Map<string, MultiSelectOption>();
    for (const p of classroom?.programs ?? []) map.set(p.id, { value: p.id, label: `${p.name} v${p.version_number}`, description: "割当済み" });
    for (const p of programOptions.published) {
      const vid = p.published_version_id as string;
      if (map.has(vid)) continue;
      const n = programOptions.versionNumber.get(vid);
      map.set(vid, { value: vid, label: n ? `${p.name} v${n}` : p.name, description: `公開中${p.department_name ? `・対象: ${p.department_name}` : ""}` });
    }
    return [...map.values()];
  }, [classroom, programOptions.published, programOptions.versionNumber]);

  const d = dashboard.data?.data;
  const trend = d?.progress_trend ?? [];
  const last = trend[trend.length - 1]?.percent;
  const prev = trend[trend.length - 2]?.percent;
  const delta = typeof last === "number" && typeof prev === "number" ? last - prev : null;
  const title = isNew ? "クラスを追加" : `${classroom.name}の詳細`;

  return (
    <div>
      <PageHeader
        title={title}
        crumbs={[{ label: "クラスルーム管理", to: "/classrooms" }, { label: isNew ? "クラスを追加" : classroom.name }]}
        description={
          isNew ? "新規登録：クラスの名称・定員・期間・担当講師・教育プログラムを登録します。" : readOnly ? "閲覧のみ：クラス設定を表示しています。" : "編集：クラス設定を変更します。在籍人数はDBで集計した値です。"
        }
        actions={
          !isNew ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={classroom.archived ? "neutral" : "success"}>{CLASSROOM_STATUS_LABELS[classroom.archived ? "archived" : "active"]}</Badge>
              <LastFetched checkedAt={checkedAt} />
            </span>
          ) : null
        }
      />

      {!isNew ? (
        <section aria-label="クラスの指標" className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          <StatCard label="在籍受講者" value={classroom.student_count} unit="名" note={`定員${classroom.capacity}名 / 残り${Math.max(0, classroom.capacity - classroom.student_count)}名`} />
          <StatCard
            label="平均研修進捗"
            value={classroom.average_progress_percent === null ? "未設定" : classroom.average_progress_percent}
            unit={classroom.average_progress_percent === null ? undefined : "%"}
            note={classroom.average_progress_percent === null ? "教育プログラムの割当後に表示されます" : delta === null ? "前月のデータはありません" : `先月から ${delta >= 0 ? "+" : ""}${Math.round(delta)}ポイント`}
          />
          <StatCard label="承認待ち予約" value={d ? d.pending_reservation_count : "—"} unit={d ? "件" : undefined} note={dashboard.error ? "取得できませんでした" : d && d.pending_reservation_count > 0 ? "本日中の確認を推奨" : "確認が必要な申請はありません"} />
          <StatCard label="本日の授業" value={d ? d.today_lesson_count : "—"} unit={d ? "コマ" : undefined} note={dashboard.error ? "取得できませんでした" : fmt.instantDate(dashboard.data?.checked_at ?? new Date())} />
        </section>
      ) : null}

      {classroom?.archived ? (
        <div className="mb-5">
          <Notice>アーカイブ済みのクラスは編集できません。</Notice>
        </div>
      ) : null}

      <form onSubmit={onSubmit} noValidate aria-label={isNew ? "クラスを追加" : "クラス設定"}>
        <fieldset disabled={readOnly} className="min-w-0">
          <FormSection title="クラス設定">
            <Field label="クラス名" required error={errors.name?.message}>
              {(p) => <Input {...p} {...register("name")} autoComplete="off" placeholder="例: 2026年度 新入社員Aクラス" />}
            </Field>
            <Field label="定員" required error={errors.capacity?.message} hint={!isNew ? `現在の在籍 ${classroom.student_count}名より少なくはできません。` : undefined}>
              {(p) => <Input {...p} {...register("capacity", { valueAsNumber: true })} type="number" min={1} max={10000} inputMode="numeric" />}
            </Field>
            <Field label="主担当講師" required error={errors.primary_teacher_id?.message ?? (activeTeachers.error ? "講師を取得できませんでした。" : undefined)}>
              {(p) => (
                <Select
                  {...p}
                  value={primaryId}
                  disabled={readOnly || activeTeachers.isLoading}
                  onChange={(e) => {
                    const v = e.target.value;
                    setValue("primary_teacher_id", v, { shouldDirty: true, shouldValidate: formState.isSubmitted });
                    // The primary teacher cannot also be an assistant.
                    const assistants = getValues("assistant_teacher_ids");
                    if (assistants.includes(v)) setValue("assistant_teacher_ids", assistants.filter((x) => x !== v), { shouldDirty: true });
                  }}
                >
                  <option value="">{activeTeachers.isLoading ? "読み込み中…" : "主担当講師を選択してください"}</option>
                  {teacherChoices.map((t) => (
                    <option key={t.id} value={t.id} disabled={!t.active}>
                      {t.name}
                      {t.active ? "" : "（停止中）"}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="hidden md:block" aria-hidden />
            <Field label="開始日" required error={errors.starts_on?.message}>
              {(p) => <Input {...p} {...register("starts_on")} type="date" />}
            </Field>
            <Field label="終了日" required error={errors.ends_on?.message}>
              {(p) => <Input {...p} {...register("ends_on")} type="date" />}
            </Field>
            <Controller
              control={control}
              name="assistant_teacher_ids"
              render={({ field }) => (
                <MultiSelect
                  legend="補助講師"
                  options={assistantOptions}
                  value={field.value}
                  onChange={field.onChange}
                  error={errors.assistant_teacher_ids?.message}
                  hint="補助講師もこのクラスの受講者の担当講師に選べます。"
                  emptyText="選択できる講師がいません"
                  disabled={readOnly}
                />
              )}
            />
            <div className="flex flex-col gap-2">
              <Controller
                control={control}
                name="program_version_ids"
                render={({ field }) => (
                  <MultiSelect
                    legend="教育プログラム"
                    options={programChoices}
                    value={field.value}
                    onChange={field.onChange}
                    error={errors.program_version_ids?.message}
                    hint="公開中のバージョンを割り当てます。公開後の変更は新しいバージョンになります。"
                    emptyText={programOptions.programs.isLoading ? "読み込み中…" : programOptions.programs.error ? "教育プログラムを取得できませんでした" : "公開中の教育プログラムがありません"}
                    disabled={readOnly}
                  />
                )}
              />
              {user.isAdmin && programOptions.programs.error ? (
                <div className="flex flex-col gap-2">
                  <InlineError error={programOptions.programs.error} />
                  <p className="text-xs text-muted">教育プログラムの一覧を取得できませんでした。割当済みのプログラムはそのまま保持されます。</p>
                  <Button size="sm" variant="secondary" className="self-start" onClick={() => void programOptions.programs.refetch()}>
                    再試行
                  </Button>
                </div>
              ) : null}
            </div>
          </FormSection>
        </fieldset>

        {readOnly ? null : (
          <div className="mb-6 flex flex-col gap-3">
            {isVersionConflict(update.error) ? (
              <VersionConflictNotice onReload={() => void reloadLatest()} reloading={reloading} />
            ) : (
              <>
                <SaveErrorBanner error={saveError} onFields={fieldsFailed} />
                {conflictDetail(saveError) ? <p className="text-xs text-muted">{conflictDetail(saveError)}</p> : null}
              </>
            )}
            {!online ? <p className="text-xs text-warning">オフラインのため保存できません。</p> : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                {!isNew ? (
                  <Button variant="ghost" className="text-danger" icon={<Archive className="size-4" aria-hidden />} disabled={!online} onClick={() => (archive.reset(), setArchiveOpen(true))}>
                    クラスをアーカイブ
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Link to="/classrooms" className={secondaryLinkClass}>
                  キャンセル
                </Link>
                <Button type="submit" loading={saving} disabled={!online}>
                  {isNew ? "クラスを追加" : "変更を保存"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </form>
      <UnsavedChangesGuard when={!readOnly && formState.isDirty && !saving} />

      {!isNew ? <EnrolledStudents classroom={classroom} /> : null}

      {!isNew && !readOnly ? (
        <ConfirmDialog
          open={archiveOpen}
          onOpenChange={(open) => !archive.isPending && setArchiveOpen(open)}
          title="クラスをアーカイブしますか？"
          description={
            <p>
              <b>{classroom.name}</b>
              をアーカイブします。アーカイブしたクラスは新しい受講者の登録先や授業枠に選べなくなります。在籍中の受講者がいる場合はアーカイブできません。
            </p>
          }
          confirmLabel="アーカイブする"
          loading={archive.isPending}
          onConfirm={() => !archive.isPending && archive.mutate()}
        >
          {isVersionConflict(archive.error) ? <VersionConflictNotice onReload={() => void reloadLatest()} reloading={reloading} /> : archive.error ? <InlineError error={archive.error} /> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function EnrolledStudents({ classroom }: { classroom: Classroom }) {
  const user = useCurrentUser();
  const list = useCursorList<Student>(adminKeys.classroomStudents(classroom.id), `/classrooms/${classroom.id}/students`, { status: "active" });
  const today = list.checkedAt ? zonedDateString(list.checkedAt, ORG_TZ) : fmt.today();
  const columns = useMemo<ColumnDef<Student, unknown>[]>(
    () => [
      { id: "name", header: "社員名", cell: ({ row }) => <PersonCell name={row.original.display_name} sub={row.original.employee_number} to={`/students/${row.original.id}`} /> },
      { id: "department", header: "所属部署", cell: ({ row }) => row.original.department_name || "—" },
      { id: "teacher", header: "担当講師", cell: ({ row }) => row.original.teacher_name },
      { id: "progress", header: "進捗", cell: ({ row }) => <ProgressBar value={row.original.progress_percent} label={`${row.original.display_name}の進捗`} /> },
      {
        id: "status",
        header: "状態",
        cell: ({ row }) => {
          const st = trainingStatus(row.original, today);
          return <Badge tone={st.tone}>{st.label}</Badge>;
        },
      },
    ],
    [today],
  );
  return (
    <Card aria-labelledby="enrolled-title">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id="enrolled-title" className="text-base font-bold">
          所属する新入社員
        </h2>
        <div className="flex items-center gap-3">
          <ListCount count={list.items?.length} hasMore={list.hasMore} unit="名" />
          <LastFetched checkedAt={list.checkedAt} />
        </div>
      </div>
      <DataTable
        caption={`${classroom.name}に所属する新入社員`}
        columns={columns}
        data={list.items}
        getRowId={(s) => s.id}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={list.refetch}
        hasMore={list.hasMore}
        loadingMore={list.loadingMore}
        onLoadMore={list.loadMore}
        empty={{
          title: "在籍中の新入社員はいません",
          description: user.isAdmin && !classroom.archived ? "新入社員管理でこのクラスを所属クラスに指定して登録します。" : undefined,
          action:
            user.isAdmin && !classroom.archived ? (
              <Link to="/students/new" className={secondaryLinkClass}>
                新入社員を登録
              </Link>
            ) : null,
        }}
      />
    </Card>
  );
}
