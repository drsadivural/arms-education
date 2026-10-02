import { useState } from "react";
import { Controller } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { THEME_LABELS } from "@arms/contracts";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { ErrorState, LastFetched, LoadingRows, Notice } from "../../components/ui/Feedback";
import { Checkbox, Field, Input, Select } from "../../components/ui/Field";
import { TagInput } from "../../components/ui/TagInput";
import { useToast } from "../../components/ui/Toast";
import { UnsavedChangesGuard } from "../../components/forms/UnsavedChangesGuard";
import { useApiForm } from "../../components/forms/useApiForm";
import { api } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { adminKeys } from "../../features/admin/keys";
import { useSettings } from "../../features/admin/hooks";
import { FormSection, SaveErrorBanner, VersionConflictNotice, WeekdayPicker } from "../../features/admin/components";
import { applyApiErrors, isVersionConflict } from "../../features/admin/errors";
import { SettingsForm, settingsDefaults, settingsFieldName, toSettingsInput } from "../../features/admin/forms";
import type { Settings, SettingsResponse } from "../../features/admin/types";

const TIMEZONE_LABELS: Record<string, string> = { "Asia/Tokyo": "日本標準時（Asia/Tokyo）" };

/** WEB-16 システム設定: 組織・予約・通知・営業時間・休日・部署・AI音声の利用上限（If-Matchで同時更新を検出）。 */
export function SystemSettingsTab() {
  const settings = useSettings();
  if (!settings.data) {
    return <Card>{settings.error ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : <LoadingRows rows={10} label="設定を読み込み中です" />}</Card>;
  }
  return <SettingsFormView settings={settings.data} reload={async () => (await settings.refetch()).data} />;
}

function UnitInput({ unit, ...props }: React.ComponentProps<typeof Input> & { unit: string }) {
  return (
    <div className="flex items-center gap-2">
      <Input {...props} className="max-w-[10rem]" />
      <span className="text-sm text-muted">{unit}</span>
    </div>
  );
}

function SettingsFormView({ settings, reload }: { settings: SettingsResponse; reload(): Promise<SettingsResponse | undefined> }) {
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const form = useApiForm(SettingsForm, settingsDefaults(settings.data));
  const { register, control, handleSubmit, formState } = form;
  const errors = formState.errors;
  const [baseVersion, setBaseVersion] = useState(settings.row_version);
  const [checkedAt, setCheckedAt] = useState(settings.checked_at);
  const [fieldsFailed, setFieldsFailed] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [holidayDraft, setHolidayDraft] = useState("");

  const adopt = (res: SettingsResponse) => {
    qc.setQueryData(adminKeys.settings, res);
    form.reset(settingsDefaults(res.data));
    setBaseVersion(res.row_version);
    setCheckedAt(res.checked_at);
  };

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof toSettingsInput>) => api.patch<SettingsResponse>("/settings", body, { ifMatch: baseVersion }),
    onSuccess: (res) => {
      adopt(res);
      void qc.invalidateQueries({ queryKey: adminKeys.eventsAll });
      toast.success("設定を保存しました", "予約の締切・保持時間の変更は、これから作成する授業枠・申請に適用されます。");
    },
    onError: (e) => setFieldsFailed(applyApiErrors(form, e, settingsFieldName)),
  });

  const onSubmit = handleSubmit((values) => {
    if (save.isPending) return;
    setFieldsFailed(false);
    save.mutate(toSettingsInput(values));
  });

  const reloadLatest = async () => {
    setReloading(true);
    try {
      const fresh = await reload();
      if (fresh) {
        adopt(fresh);
        save.reset();
      }
    } finally {
      setReloading(false);
    }
  };

  const s: Settings = settings.data;
  return (
    <form onSubmit={onSubmit} noValidate aria-label="システム設定">
      <div className="mb-4 flex justify-end">
        <LastFetched checkedAt={checkedAt} />
      </div>
      <FormSection title="組織・予約の設定">
        <Field label="組織名" required error={errors.organization_name?.message}>
          {(p) => <Input {...p} {...register("organization_name")} autoComplete="organization" />}
        </Field>
        <Field label="標準テーマ" error={errors.default_theme?.message} hint="利用者が個人設定でテーマを選んでいない場合の既定です。">
          {(p) => (
            <Select {...p} {...register("default_theme")}>
              {(["system", "light", "dark"] as const).map((t) => (
                <option key={t} value={t}>
                  {THEME_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="タイムゾーン" hint="日付・「今日」の判定に使用します（変更できません）。">
          {(p) => <Input {...p} value={TIMEZONE_LABELS[s.timezone] ?? s.timezone} readOnly className="bg-surface-2" />}
        </Field>
        <Field label="通知" error={errors.notifications_enabled?.message} hint="アプリ内通知は常に作成されます。">
          {(p) => (
            <Select {...p} {...register("notifications_enabled")}>
              <option value="true">アプリ内・メール・Push</option>
              <option value="false">アプリ内のみ</option>
            </Select>
          )}
        </Field>
        <Field label="取消期限" required error={errors.cancel_hours?.message} hint="受講者が予約を取り消せる期限（授業開始の何時間前まで）。">
          {(p) => <UnitInput {...p} {...register("cancel_hours", { valueAsNumber: true })} type="number" min={0} max={720} step="any" inputMode="decimal" unit="時間前まで" />}
        </Field>
        <Field label="承認待ちの席保持時間" required error={errors.pending_hours?.message} hint="承認されないまま経過すると申請は期限切れになり、席が解放されます。">
          {(p) => <UnitInput {...p} {...register("pending_hours", { valueAsNumber: true })} type="number" min={0} max={336} step="any" inputMode="decimal" unit="時間" />}
        </Field>
        <div className="md:col-span-2">
          <Checkbox label="管理者に二段階認証（認証アプリ）を必須にする" {...register("require_admin_mfa")} />
          <p className="text-xs text-muted">無効にすると、管理者はパスワードのみでログインできます。セキュリティのため有効を推奨します。</p>
        </div>
      </FormSection>

      <FormSection title="部署・営業日" description="部署は講師・新入社員の登録画面の選択肢と絞り込みに使用します。">
        <div className="md:col-span-2">
          <Field label="部署" error={errors.departments?.message} hint="Enterまたは「、」で追加（最大100件）。未設定の場合は各画面で自由入力になります。">
            {(p) => (
              <Controller
                control={control}
                name="departments"
                render={({ field }) => <TagInput {...p} value={field.value} onChange={field.onChange} onBlur={field.onBlur} maxTags={100} maxLength={100} placeholder="例: 開発部" />}
              />
            )}
          </Field>
        </div>
        <div className="md:col-span-2">
          <Controller control={control} name="weekdays" render={({ field }) => <WeekdayPicker legend="営業曜日" required value={field.value} onChange={field.onChange} error={errors.weekdays?.message} />} />
        </div>
        <Field label="営業開始時刻" required error={errors.start_time?.message}>
          {(p) => <Input {...p} {...register("start_time")} type="time" />}
        </Field>
        <Field label="営業終了時刻" required error={errors.end_time?.message}>
          {(p) => <Input {...p} {...register("end_time")} type="time" />}
        </Field>
        <div className="md:col-span-2">
          <Controller
            control={control}
            name="holidays"
            render={({ field }) => (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1.5 text-xs font-bold">休日</legend>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    追加する日付
                    <Input type="date" value={holidayDraft} onChange={(e) => setHolidayDraft(e.target.value)} className="w-48" />
                  </label>
                  <Button
                    variant="secondary"
                    disabled={!/^\d{4}-\d{2}-\d{2}$/.test(holidayDraft) || field.value.includes(holidayDraft)}
                    onClick={() => {
                      field.onChange([...field.value, holidayDraft].sort());
                      setHolidayDraft("");
                    }}
                  >
                    休日を追加
                  </Button>
                </div>
                {field.value.length === 0 ? (
                  <p className="text-xs text-muted">登録された休日はありません。</p>
                ) : (
                  <ul className="flex flex-wrap gap-1.5" aria-label="登録済みの休日">
                    {field.value.map((d) => (
                      <li key={d} className="inline-flex items-center gap-1 rounded-md bg-neutral-soft py-0.5 pr-1 pl-2 text-xs">
                        {fmt.date(d, true)}
                        <button
                          type="button"
                          className="rounded p-0.5 text-muted hover:text-danger"
                          aria-label={`${fmt.date(d, true)}を休日から削除`}
                          onClick={() => field.onChange(field.value.filter((x) => x !== d))}
                        >
                          <X className="size-3" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {errors.holidays?.message ? (
                  <p role="alert" className="text-xs font-medium text-danger">
                    {errors.holidays.message}
                  </p>
                ) : null}
              </fieldset>
            )}
          />
        </div>
      </FormSection>

      <FormSection title="AI音声アシスタント">
        <Field label="1回の最大利用時間" required error={errors.voice_max_minutes?.message} hint="1〜60分">
          {(p) => <UnitInput {...p} {...register("voice_max_minutes", { valueAsNumber: true })} type="number" min={1} max={60} step="any" inputMode="decimal" unit="分" />}
        </Field>
        <Field label="1人あたりの1日利用上限" required error={errors.voice_daily_minutes?.message} hint="0分にすると音声機能を利用できなくなります（画面操作は常に利用できます）。">
          {(p) => <UnitInput {...p} {...register("voice_daily_minutes", { valueAsNumber: true })} type="number" min={0} max={1440} step="any" inputMode="decimal" unit="分" />}
        </Field>
        <div className="md:col-span-2">
          <Notice>APIキーはサーバーで管理します。画面やiOSアプリには表示しません。</Notice>
        </div>
      </FormSection>

      <div className="flex flex-col gap-3">
        {isVersionConflict(save.error) ? <VersionConflictNotice onReload={() => void reloadLatest()} reloading={reloading} /> : <SaveErrorBanner error={save.error} onFields={fieldsFailed} />}
        {!online ? <p className="text-xs text-warning">オフラインのため保存できません。</p> : null}
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending} disabled={!online}>
            設定を保存
          </Button>
        </div>
      </div>
      <UnsavedChangesGuard when={formState.isDirty && !save.isPending} />
    </form>
  );
}
