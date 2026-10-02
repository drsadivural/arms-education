/**
 * WEB-15 授業・予約枠を追加 / 編集 (/bookings/slots/new, /bookings/slots/:id). Shared add/edit form:
 * classroom → its teachers (a teacher can only choose themself) → optional unit, JST date + start/end time,
 * capacity, booking deadline, cancel deadline, private https meeting URL, 受付状態. PATCH sends If-Match with the
 * version the form was loaded from. Edit mode adds the reservation summary, 「授業を取消」 and 出欠.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type { UseFormRegisterReturn } from "react-hook-form";
import { ZodError } from "zod";
import { SLOT_STATE_LABELS, type LessonSlot, type SlotInputT } from "@arms/contracts";
import { ApiError, api, errorMessage } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { useCurrentUser } from "../../lib/session";
import { useApiForm } from "../../components/forms/useApiForm";
import { UnsavedChangesGuard } from "../../components/forms/UnsavedChangesGuard";
import { SlotStateBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { ErrorState, LastFetched, LoadingRows, Notice } from "../../components/ui/Feedback";
import { Field, Input, Select } from "../../components/ui/Field";
import { PageHeader } from "../../components/ui/PageHeader";
import { useToast } from "../../components/ui/Toast";
import {
  bookingKeys,
  invalidateBooking,
  useClassroom,
  useClassroomOptions,
  useClassroomTeachers,
  useOrgSettings,
  useSlot,
  useUnitOptions,
  type DataEnvelope,
} from "../../features/booking/api";
import { AttendanceSection } from "../../features/booking/AttendanceSection";
import { CANCEL_BEFORE_PRESETS, cancelBeforeLabel, dateTimeFull, slotRangeFull } from "../../features/booking/format";
import { SlotCancelDialog } from "../../features/booking/SlotCancelDialog";
import { DANGER_TEXT, dangerSoftButton } from "../../features/booking/tone";
import { canManageSlot } from "../../features/booking/SlotTabs";
import {
  EMPTY_SLOT_FORM,
  SlotFormSchema,
  defaultDeadline,
  formValuesToInput,
  mapServerFieldErrors,
  slotToFormValues,
  type SlotFormValues,
} from "../../features/booking/slotForm";

const LIST_PATH = "/bookings?tab=slots";

export function SlotFormPage() {
  const { id } = useParams();
  const user = useCurrentUser();
  const slotQuery = useSlot(id);
  if (!id) return <SlotEditor slot={null} />;
  const slot = slotQuery.data?.data;
  if (!slot) {
    return (
      <>
        <PageHeader title="授業・予約枠" crumbs={[{ label: "オンライン予約システム", to: LIST_PATH }, { label: "授業・予約枠" }]} />
        {slotQuery.isLoading ? (
          <LoadingRows rows={8} label="授業枠を読み込み中です" />
        ) : (
          <Card>
            <ErrorState error={slotQuery.error} onRetry={() => void slotQuery.refetch()} />
          </Card>
        )}
      </>
    );
  }
  if (!canManageSlot(slot, user)) return <SlotReadOnly slot={slot} checkedAt={slotQuery.data?.checked_at} />;
  return <SlotEditor key={slot.id} slot={slot} />;
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line py-3 last:border-b-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-right text-sm font-bold break-words">{children}</dd>
    </div>
  );
}

/** Cancelled slots, and slots of another teacher in the teacher's classroom, are shown read-only. */
function SlotReadOnly({ slot, checkedAt }: { slot: LessonSlot; checkedAt?: string }) {
  return (
    <>
      <PageHeader title="授業・予約枠の詳細" crumbs={[{ label: "オンライン予約システム", to: LIST_PATH }, { label: "授業・予約枠の詳細" }]} />
      <div className="flex flex-col gap-5">
        {slot.state === "cancelled" ? (
          <Notice tone="warning">この授業枠は取り消されています。予約は取消済みになり、受講者に通知されました。</Notice>
        ) : (
          <Notice>この授業枠は担当講師または管理者だけが編集できます。</Notice>
        )}
        <Card>
          <CardHeader title="授業情報" actions={<LastFetched checkedAt={checkedAt} />} />
          <dl>
            <InfoRow label="授業名">{slot.title}</InfoRow>
            <InfoRow label="クラス">{slot.classroom_name}</InfoRow>
            <InfoRow label="担当講師">{slot.teacher_name}</InfoRow>
            <InfoRow label="日時">{slotRangeFull(slot.starts_at, slot.ends_at)}</InfoRow>
            <InfoRow label="定員">{slot.capacity}名</InfoRow>
            {slot.state !== "cancelled" ? <InfoRow label="残席">{slot.remaining}名</InfoRow> : null}
            <InfoRow label="予約締切">{dateTimeFull(slot.booking_closes_at)}</InfoRow>
            <InfoRow label="取消期限">{cancelBeforeLabel(slot.cancel_before_seconds)}</InfoRow>
            <InfoRow label="状態">
              <SlotStateBadge state={slot.state} />
            </InfoRow>
          </dl>
          <p className="mt-4 text-xs">
            <Link to={`/bookings?slot=${slot.id}&period=all`} className="text-primary underline-offset-2 hover:underline">
              この授業の予約を見る
            </Link>
          </p>
        </Card>
      </div>
    </>
  );
}

const ACTIVE_RESERVATIONS_HELP =
  "有効な予約（承認待ち・承認済み）がある間は、日時・講師・クラスの変更と定員の削減はできません。授業名・URL・締切・受付状態は変更できます。日時を変える場合は「授業を取消」で受講者へ通知してから、新しい枠を作成してください。";

function ErrorBanner({ error, onReload }: { error: unknown; onReload(): void }) {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : null;
  const requestId = error instanceof ApiError ? error.requestId : null;
  let help: ReactNode = null;
  if (code === "VERSION_CONFLICT") {
    help = (
      <>
        <p className="mt-1">ほかの人がこの授業枠を更新しました。最新の内容を読み込んでから、もう一度変更してください（入力中の変更は破棄されます）。</p>
        <Button size="sm" variant="secondary" className="mt-2" onClick={onReload}>
          最新の内容を読み込む
        </Button>
      </>
    );
  } else if (code === "ACTIVE_RESERVATIONS") help = <p className="mt-1">{ACTIVE_RESERVATIONS_HELP}</p>;
  else if (code === "SLOT_TIME_CONFLICT") help = <p className="mt-1">同じ講師またはクラスの別の授業と時間が重なっています。日付・時刻を変更してください。</p>;
  else if (code === "VALIDATION_FAILED") help = <p className="mt-1">赤字の項目を修正してください。</p>;
  return (
    <div role="alert" className={`rounded-[var(--radius-control)] border border-danger/40 bg-danger-soft px-4 py-3 text-xs ${DANGER_TEXT}`}>
      <p className="font-bold">{errorMessage(error)}</p>
      {help}
      {requestId && error instanceof ApiError && error.status >= 500 ? <p className="mt-1 opacity-80">問い合わせ番号: {requestId}</p> : null}
    </div>
  );
}

function SlotEditor({ slot }: { slot: LessonSlot | null }) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const online = useOnline();
  const isNew = !slot;
  const activeCount = slot ? (slot.pending_count ?? 0) + (slot.approved_count ?? 0) : 0;
  const locked = !isNew && activeCount > 0;

  const [baseVersion, setBaseVersion] = useState(slot?.row_version ?? 0);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [banner, setBanner] = useState<unknown>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const defaults: SlotFormValues = slot ? slotToFormValues(slot) : { ...EMPTY_SLOT_FORM, teacher_id: user.isTeacher ? user.id : "" };
  const form = useApiForm(SlotFormSchema, defaults);
  const {
    register,
    handleSubmit,
    setValue,
    setError,
    getValues,
    getFieldState,
    reset,
    watch,
    formState: { errors, isDirty, isSubmitting },
  } = form;

  const classroomId = watch("classroom_id");
  const classrooms = useClassroomOptions(true);
  const classroom = useClassroom(classroomId);
  const teachers = useClassroomTeachers(user.isAdmin ? classroomId : "");
  const programs = useMemo(() => classroom.data?.data.programs ?? [], [classroom.data]);
  const units = useUnitOptions(programs);
  const settings = useOrgSettings(user.isAdmin && isNew);

  // Admins: default to the classroom's primary teacher (the API lists it first) when none is chosen.
  useEffect(() => {
    if (!user.isAdmin || !teachers.data) return;
    const current = getValues("teacher_id");
    if (current && teachers.data.items.some((t) => t.id === current)) return;
    if (current && slot && current === slot.teacher_id) return;
    setValue("teacher_id", teachers.data.items[0]?.id ?? "", { shouldDirty: true, shouldValidate: !!current });
  }, [teachers.data, user.isAdmin, getValues, setValue, slot]);

  // After a successful create, leave once the form is no longer guarded.
  useEffect(() => {
    if (createdId) navigate(`/bookings/slots/${createdId}`, { replace: true });
  }, [createdId, navigate]);

  const autoDeadline = () => {
    if (!isNew || getFieldState("deadline_date").isDirty || getFieldState("deadline_time").isDirty) return;
    const d = defaultDeadline(getValues("date"), getValues("start_time"));
    if (d) {
      setValue("deadline_date", d.deadline_date);
      setValue("deadline_time", d.deadline_time);
    }
  };

  const create = useIdempotentMutation<DataEnvelope<LessonSlot>, SlotInputT>((input, key) => api.post<DataEnvelope<LessonSlot>>("/lesson-slots", input, { idempotencyKey: key }));
  const update = useMutation({
    mutationFn: (v: { input: SlotInputT; version: number }) => api.patch<DataEnvelope<LessonSlot>>(`/lesson-slots/${encodeURIComponent(slot?.id ?? "")}`, v.input, { ifMatch: v.version }),
  });

  const reloadLatest = async () => {
    if (!slot) return;
    const res = await qc.fetchQuery({ queryKey: bookingKeys.slot(slot.id), queryFn: () => api.get<DataEnvelope<LessonSlot>>(`/lesson-slots/${encodeURIComponent(slot.id)}`), staleTime: 0 });
    reset(slotToFormValues(res.data));
    setBaseVersion(res.data.row_version);
    setBanner(null);
  };

  const onSubmit = handleSubmit(async (values) => {
    setBanner(null);
    if (locked && slot && Number(values.capacity) < slot.capacity) {
      setError("capacity", { type: "manual", message: `有効な予約があるため、定員は${slot.capacity}名未満に減らせません。` });
      return;
    }
    let input: SlotInputT;
    try {
      input = formValuesToInput(values);
    } catch (e) {
      if (e instanceof ZodError) {
        const fe = Object.fromEntries(e.issues.map((i) => [String(i.path[0] ?? ""), i.message]));
        for (const { field, message } of mapServerFieldErrors(fe)) setError(field, { type: "manual", message });
        return;
      }
      throw e;
    }
    try {
      if (isNew) {
        const res = await create.mutateAsync(input);
        toast.success("授業・予約枠を登録しました", `${res.data.title} ${fmt.slotRange(res.data.starts_at, res.data.ends_at)}`);
        void invalidateBooking(qc);
        setCreatedId(res.data.id);
      } else {
        const res = await update.mutateAsync({ input, version: baseVersion });
        qc.setQueryData(bookingKeys.slot(res.data.id), res);
        setBaseVersion(res.data.row_version);
        reset(slotToFormValues(res.data));
        void invalidateBooking(qc);
        toast.success("授業・予約枠を保存しました", `${res.data.title} ${fmt.slotRange(res.data.starts_at, res.data.ends_at)}`);
      }
    } catch (e) {
      if (e instanceof ApiError) {
        for (const { field, message } of mapServerFieldErrors(e.fieldErrors)) setError(field, { type: "server", message });
        if (e.code === "SLOT_TIME_CONFLICT") setError("start_time", { type: "server", message: e.messageJa });
      }
      setBanner(e);
    }
  });

  const saving = isSubmitting || create.isPending || update.isPending;
  const title = isNew ? "授業・予約枠を追加" : "授業・予約枠を編集";
  const teacherName = slot?.teacher_name ?? user.display_name;
  const classroomName = slot?.classroom_name ?? "";
  const orgDefault = settings.data ? cancelBeforeLabel(settings.data.data.booking_cancel_before_seconds) : null;
  const cancelOptions: number[] = [...CANCEL_BEFORE_PRESETS];
  if (slot && !cancelOptions.includes(slot.cancel_before_seconds)) cancelOptions.unshift(slot.cancel_before_seconds);

  return (
    <>
      <PageHeader title={title} crumbs={[{ label: "オンライン予約システム", to: LIST_PATH }, { label: title }]} description={isNew ? "受講者が予約できる授業の日時と定員を登録します。" : undefined} />
      <UnsavedChangesGuard when={isDirty && !createdId} />
      <div className="flex flex-col gap-5">
        {slot ? <ReservationSummaryCard slot={slot} onCancel={() => setCancelOpen(true)} /> : null}
        {locked ? <Notice tone="warning">{ACTIVE_RESERVATIONS_HELP}</Notice> : null}
        <form onSubmit={(e) => void onSubmit(e)} noValidate aria-label={title} className="flex flex-col gap-5">
          <Card>
            <CardHeader title="授業情報" description="日時はすべて日本時間（JST）で入力します。" />
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field label="授業名" required error={errors.title?.message}>
                {(p) => <Input {...p} {...register("title")} maxLength={200} autoComplete="off" />}
              </Field>
              {locked ? (
                <Field label="クラス" required hint="有効な予約があるため変更できません。">
                  {(p) => <Input {...p} readOnly value={classroomName} />}
                </Field>
              ) : (
                <Field label="クラス" required error={errors.classroom_id?.message} hint={classrooms.error ? "クラスの一覧を取得できませんでした。再読み込みしてください。" : undefined}>
                  {(p) => (
                    <Select
                      {...p}
                      {...register("classroom_id", {
                        onChange: () => {
                          setValue("unit_id", "");
                          if (user.isAdmin) setValue("teacher_id", "");
                        },
                      })}
                      aria-busy={classrooms.isLoading || undefined}
                    >
                      <option value="">選択してください</option>
                      {classrooms.data?.items.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                      {slot && classrooms.data && !classrooms.data.items.some((c) => c.id === slot.classroom_id) ? (
                        <option value={slot.classroom_id}>{slot.classroom_name}</option>
                      ) : null}
                    </Select>
                  )}
                </Field>
              )}
              {user.isAdmin && !locked ? (
                <Field
                  label="担当講師"
                  required
                  error={errors.teacher_id?.message}
                  hint={!classroomId ? "先にクラスを選択してください。" : teachers.data?.items.length === 0 ? "このクラスに担当講師が登録されていません。クラスルーム管理で講師を割り当ててください。" : "クラスの担当講師から選択します。"}
                >
                  {(p) => (
                    <Select {...p} {...register("teacher_id")} disabled={!classroomId} aria-busy={teachers.isLoading || undefined}>
                      <option value="">{classroomId ? "選択してください" : "クラスを選択してください"}</option>
                      {teachers.data?.items.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.display_name}
                        </option>
                      ))}
                      {slot && teachers.data && !teachers.data.items.some((t) => t.id === slot.teacher_id) && classroomId === slot.classroom_id ? (
                        <option value={slot.teacher_id}>{slot.teacher_name}（現在の担当）</option>
                      ) : null}
                    </Select>
                  )}
                </Field>
              ) : (
                <Field label="担当講師" required hint={locked ? "有効な予約があるため変更できません。" : "講師は自分が担当する授業枠のみ登録できます。"} error={errors.teacher_id?.message}>
                  {(p) => <Input {...p} readOnly value={teacherName} />}
                </Field>
              )}
              <UnitField
                register={register("unit_id")}
                error={errors.unit_id?.message}
                classroomSelected={!!classroomId}
                hasPrograms={programs.length > 0}
                programsLoading={classroom.isLoading}
                units={units.data}
                unitsLoading={units.isLoading && programs.length > 0}
                unitsFailed={!!units.error}
                currentUnitId={slot?.unit_id ?? null}
              />
              {locked ? (
                <Field label="授業日時" required hint="有効な予約があるため変更できません。">
                  {(p) => <Input {...p} readOnly value={slot ? slotRangeFull(slot.starts_at, slot.ends_at) : ""} />}
                </Field>
              ) : (
                <>
                  <Field label="授業日" required error={errors.date?.message}>
                    {(p) => <Input {...p} type="date" {...register("date", { onChange: autoDeadline })} />}
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="開始時刻" required error={errors.start_time?.message}>
                      {(p) => <Input {...p} type="time" step={300} {...register("start_time", { onChange: autoDeadline })} />}
                    </Field>
                    <Field label="終了時刻" required error={errors.end_time?.message}>
                      {(p) => <Input {...p} type="time" step={300} {...register("end_time")} />}
                    </Field>
                  </div>
                </>
              )}
              <Field label="定員" required error={errors.capacity?.message} hint={locked && slot ? `有効な予約があるため${slot.capacity}名未満には減らせません。` : "1〜1,000名"}>
                {(p) => <Input {...p} type="number" inputMode="numeric" min={locked && slot ? slot.capacity : 1} max={1000} step={1} {...register("capacity")} />}
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="予約締切日" required error={errors.deadline_date?.message} hint={isNew ? "初期値は授業開始の1日前です。" : undefined}>
                  {(p) => <Input {...p} type="date" {...register("deadline_date")} />}
                </Field>
                <Field label="予約締切時刻" required error={errors.deadline_time?.message}>
                  {(p) => <Input {...p} type="time" step={300} {...register("deadline_time")} />}
                </Field>
              </div>
              <Field label="オンライン授業URL" error={errors.meeting_url?.message} hint="https:// から始まるURL。承認済みの受講者・担当講師・管理者だけに表示されます。">
                {(p) => <Input {...p} type="url" inputMode="url" placeholder="https://" autoComplete="off" {...register("meeting_url")} />}
              </Field>
              <Field label="取消期限" error={errors.cancel_before?.message} hint="受講者が自分で予約を取り消せる期限です。">
                {(p) => (
                  <Select {...p} {...register("cancel_before")}>
                    {isNew ? <option value="">{orgDefault ? `組織の既定（${orgDefault}）` : "組織の既定値"}</option> : null}
                    {cancelOptions.map((s) => (
                      <option key={s} value={String(s)}>
                        {cancelBeforeLabel(s)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="受付状態" required error={errors.state?.message} hint="受付終了にすると新しい予約申請を受け付けません（既存の予約はそのままです）。">
                {(p) => (
                  <Select {...p} {...register("state")}>
                    <option value="open">{SLOT_STATE_LABELS.open}</option>
                    <option value="closed">{SLOT_STATE_LABELS.closed}</option>
                  </Select>
                )}
              </Field>
            </div>
          </Card>
          <Notice>講師・クラスの時間重複を検査します。承認済み受講者だけに授業URLを表示します。</Notice>
          <ErrorBanner error={banner} onReload={() => void reloadLatest()} />
          {!online ? <p className="text-xs text-warning">オフラインのため保存できません。接続が戻ってから保存してください。</p> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => navigate(LIST_PATH)} disabled={saving}>
              キャンセル
            </Button>
            <Button type="submit" loading={saving} disabled={!online}>
              {isNew ? "枠を登録" : "変更を保存"}
            </Button>
          </div>
        </form>
        {slot && slot.state !== "cancelled" ? <AttendanceSection slotId={slot.id} /> : null}
      </div>
      {slot ? <SlotCancelDialog slot={slot} open={cancelOpen} onOpenChange={setCancelOpen} /> : null}
    </>
  );
}

function UnitField({
  register,
  error,
  classroomSelected,
  hasPrograms,
  programsLoading,
  units,
  unitsLoading,
  unitsFailed,
  currentUnitId,
}: {
  register: UseFormRegisterReturn<"unit_id">;
  error?: string;
  classroomSelected: boolean;
  hasPrograms: boolean;
  programsLoading: boolean;
  units: { unit: { id: string }; label: string }[] | undefined;
  unitsLoading: boolean;
  unitsFailed: boolean;
  currentUnitId: string | null;
}) {
  const hint = !classroomSelected
    ? "クラスを選択すると、そのクラスの教育プログラムの単元を選べます。"
    : programsLoading
      ? undefined
      : !hasPrograms
        ? "このクラスには教育プログラムが割り当てられていません（単元なしで登録できます）。"
        : unitsFailed
          ? "単元の一覧を取得できませんでした。単元を指定せずに登録できます。"
          : "任意。単元を指定すると、その教育プログラムを割り当てられた受講者だけが申請できます。";
  const showCurrent = !!currentUnitId && !(units ?? []).some((u) => u.unit.id === currentUnitId);
  return (
    <Field label="教育単元" error={error} hint={hint}>
      {(p) => (
        <Select {...p} {...register} disabled={!classroomSelected} aria-busy={unitsLoading || undefined}>
          <option value="">指定しない</option>
          {showCurrent ? <option value={currentUnitId ?? ""}>現在の単元（変更しない）</option> : null}
          {(units ?? []).map((u) => (
            <option key={u.unit.id} value={u.unit.id}>
              {u.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function ReservationSummaryCard({ slot, onCancel }: { slot: LessonSlot; onCancel(): void }) {
  const online = useOnline();
  return (
    <Card>
      <CardHeader
        title="予約状況"
        description={`${slotRangeFull(slot.starts_at, slot.ends_at)}・${slot.classroom_name}`}
        actions={<SlotStateBadge state={slot.state} />}
      />
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["承認待ち", `${slot.pending_count ?? 0}件`],
          ["承認済み", `${slot.approved_count ?? 0}件`],
          ["残席", `${slot.remaining}名`],
          ["定員", `${slot.capacity}名`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[var(--radius-control)] bg-surface-2 p-3">
            <dt className="text-[11px] text-muted">{label}</dt>
            <dd className="mt-1 text-lg font-bold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Link to={`/bookings?slot=${slot.id}&period=all`} className="text-sm text-primary underline-offset-2 hover:underline">
          この授業の予約を見る
        </Link>
        <button type="button" className={dangerSoftButton} disabled={!online} onClick={onCancel}>
          授業を取消
        </button>
      </div>
    </Card>
  );
}
