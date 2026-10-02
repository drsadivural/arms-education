import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ROLE_LABELS, THEME_LABELS } from "@arms/contracts";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { ErrorState, InlineError, LastFetched, LoadingRows } from "../../components/ui/Feedback";
import { Checkbox } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { UnsavedChangesGuard } from "../../components/forms/UnsavedChangesGuard";
import { useOnline } from "../../lib/online";
import { meQueryKey, useMe, useSavePreferences } from "../../lib/preferences";
import { useTheme, type ThemePreference } from "../../lib/theme";
import { isVersionConflict } from "../../features/admin/errors";
import { VersionConflictNotice } from "../../features/admin/components";

const THEMES: ThemePreference[] = ["light", "dark", "system"];

/** 個人設定: 表示テーマと通知（PATCH /me/preferences、If-Match）。講師・管理者とも利用できる。 */
export function PersonalSettingsTab() {
  const me = useMe();
  if (!me.data) return <Card>{me.error ? <ErrorState error={me.error} onRetry={() => void me.refetch()} /> : <LoadingRows rows={4} label="個人設定を読み込み中です" />}</Card>;
  const p = me.data.data.preferences;
  return <PreferencesForm key={p.row_version} initialTheme={p.theme} initialNotifications={p.notifications_enabled} checkedAt={me.data.checked_at} />;
}

function PreferencesForm({ initialTheme, initialNotifications, checkedAt }: { initialTheme: ThemePreference; initialNotifications: boolean; checkedAt: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const online = useOnline();
  const toast = useToast();
  const { setPreference } = useTheme();
  const save = useSavePreferences();
  const [theme, setTheme] = useState<ThemePreference>(initialTheme);
  const [notifications, setNotifications] = useState(initialNotifications);
  const dirty = theme !== initialTheme || notifications !== initialNotifications;
  const user = me.data?.data;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    save.mutate(
      { theme, notifications_enabled: notifications },
      {
        onSuccess: () => {
          setPreference(theme);
          toast.success("個人設定を保存しました");
        },
      },
    );
  };

  return (
    <form onSubmit={onSubmit} noValidate aria-label="個人設定">
      <Card className="mb-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-base font-bold">表示と通知</h2>
            {user ? (
              <p className="mt-1 text-xs text-muted">
                {user.display_name}（{ROLE_LABELS[user.role]}・{user.email}）の設定です。他の端末にも反映されます。
              </p>
            ) : null}
          </div>
          <LastFetched checkedAt={checkedAt} />
        </div>
        <fieldset className="mb-5">
          <legend className="mb-2 text-xs font-bold">表示テーマ</legend>
          <div className="flex flex-wrap gap-2">
            {THEMES.map((t) => (
              <label
                key={t}
                className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border border-line px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:checked]:font-bold has-[:checked]:text-primary"
              >
                <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => setTheme(t)} className="accent-[var(--arms-primary)]" />
                {THEME_LABELS[t]}
              </label>
            ))}
          </div>
        </fieldset>
        <Checkbox label="メール・Push通知を受け取る（アプリ内通知は常に届きます）" checked={notifications} onChange={(e) => setNotifications(e.target.checked)} />
      </Card>
      <div className="flex flex-col gap-3">
        {isVersionConflict(save.error) ? (
          <VersionConflictNotice
            onReload={() => {
              save.reset();
              void qc.invalidateQueries({ queryKey: meQueryKey });
            }}
          />
        ) : save.error ? (
          <InlineError error={save.error} />
        ) : null}
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending} disabled={!online || !dirty}>
            設定を保存
          </Button>
        </div>
      </div>
      <UnsavedChangesGuard when={dirty && !save.isPending} />
    </form>
  );
}
