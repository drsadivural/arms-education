/** Small building blocks shared by the admin screens. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { RefreshCw } from "lucide-react";
import { INVITATION_STATE_LABELS, WEEKDAY_LABELS } from "@arms/contracts";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { InlineError } from "../../components/ui/Feedback";
import { Field, Input, Select } from "../../components/ui/Field";
import { cn } from "../../components/ui/cn";
import { api } from "../../lib/api";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { useToast } from "../../components/ui/Toast";
import type { InviteResult } from "./types";

/** Avatar initial + name + secondary line (社員番号・講師番号・ふりがな). */
export function PersonCell({ name, sub, to }: { name: string; sub?: ReactNode; to?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary">
        {name.slice(0, 1)}
      </span>
      <span className="flex min-w-0 flex-col">
        {to ? (
          <Link to={to} className="truncate font-bold text-fg hover:text-primary hover:underline">
            {name}
          </Link>
        ) : (
          <span className="truncate font-bold">{name}</span>
        )}
        {sub ? <span className="truncate text-[11px] text-muted">{sub}</span> : null}
      </span>
    </div>
  );
}

/** Weekday toggles (0=日〜6=土) as a labelled checkbox group. */
export function WeekdayPicker({ legend, value, onChange, error, required, disabled }: { legend: string; value: number[]; onChange(v: number[]): void; error?: string; required?: boolean; disabled?: boolean }) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-xs font-bold text-fg">
        {legend}
        {required ? (
          <span className="ml-1 text-danger" aria-hidden>
            *
          </span>
        ) : null}
        {required ? <span className="sr-only">（必須）</span> : null}
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {order.map((d) => {
          const checked = value.includes(d);
          return (
            <label
              key={d}
              className={cn(
                "inline-flex h-10 min-w-10 cursor-pointer items-center justify-center rounded-[10px] border px-3 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-[color:var(--arms-focus)]",
                checked ? "border-primary bg-primary-soft font-bold text-primary" : "border-line bg-surface text-fg",
              )}
            >
              <input
                type="checkbox"
                className="sr-only"
                aria-label={`${WEEKDAY_LABELS[d]}曜日`}
                checked={checked}
                onChange={(e) => onChange(e.target.checked ? [...value, d].sort((a, b) => a - b) : value.filter((x) => x !== d))}
              />
              <span aria-hidden>{WEEKDAY_LABELS[d]}</span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** 「12件を表示（続きあり）」 — the API does not return totals, so the count is what has been loaded. */
export function ListCount({ count, hasMore, unit = "件" }: { count: number | undefined; hasMore?: boolean; unit?: string }) {
  if (count === undefined) return null;
  return (
    <p className="text-xs text-muted" aria-live="polite">
      {count}
      {unit}を表示{hasMore ? "（続きがあります）" : ""}
    </p>
  );
}

/** Shown when a PATCH/DELETE is refused with VERSION_CONFLICT (someone else saved first). */
export function VersionConflictNotice({ onReload, reloading }: { onReload(): void; reloading?: boolean }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-warning/50 bg-warning-soft px-4 py-3 text-sm text-fg">
      <span>情報が更新されました。再読み込みしてください。（入力中の変更は保存されていません）</span>
      <Button size="sm" variant="secondary" loading={reloading} icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={onReload}>
        最新の情報を読み込む
      </Button>
    </div>
  );
}

const inviteTone: Record<InviteResult["state"], Tone> = { sent: "success", failed: "danger", pending: "warning" };
const inviteLabel: Record<InviteResult["state"], string> = { sent: "送信済み", failed: "送信失敗（再送可能）", pending: "送信待ち" };

/** Resend mutation (POST /settings/users/{id}/resend-invite, Idempotency-Key reused on retry). */
export function useResendInvite(onDone?: (result: InviteResult) => void) {
  const toast = useToast();
  return useIdempotentMutation(
    async (userId: string, key: string) => {
      const res = await api.post<{ success: boolean; data?: { invitation?: InviteResult } }>(`/settings/users/${userId}/resend-invite`, undefined, { idempotencyKey: key });
      return res.data?.invitation ?? null;
    },
    {
      onSuccess: (inv) => {
        if (!inv) return;
        if (inv.state === "sent") toast.success("招待メールを再送しました");
        else toast.error("招待メールを送信できませんでした", inv.message_ja);
        onDone?.(inv);
      },
    },
  );
}

/** Result of the invitation e-mail after registering a teacher/student/admin, with a resend action. */
export function InvitationResultCard({ invitation, onChange }: { invitation: InviteResult; onChange?(next: InviteResult): void }) {
  const [current, setCurrent] = useState(invitation);
  const online = useOnline();
  const resend = useResendInvite((next) => {
    setCurrent(next);
    onChange?.(next);
  });
  return (
    <Card className={cn("mb-6 border-l-4", current.state === "sent" ? "border-l-success" : current.state === "failed" ? "border-l-danger" : "border-l-warning")} aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
            招待メール
            <Badge tone={inviteTone[current.state]}>{inviteLabel[current.state]}</Badge>
          </p>
          <p className="mt-1 text-xs text-muted">{current.message_ja}</p>
        </div>
        {current.state !== "sent" && current.user_id ? (
          <Button size="sm" variant="secondary" loading={resend.isPending} disabled={!online} onClick={() => resend.mutate(current.user_id)}>
            招待を再送
          </Button>
        ) : null}
      </div>
      {resend.error ? (
        <div className="mt-3">
          <InlineError error={resend.error} />
        </div>
      ) : null}
    </Card>
  );
}

/** Invitation state chip for lists (null = no invitation job, e.g. migrated accounts). */
export function InvitationStateBadge({ state }: { state: keyof typeof INVITATION_STATE_LABELS | null | undefined }) {
  if (!state || state === "sent") return null;
  const tone: Tone = state === "failed" ? "danger" : "warning";
  return <Badge tone={tone}>{INVITATION_STATE_LABELS[state]}</Badge>;
}

/** Department control: a select of settings.departments when configured, otherwise free text. */
export function DepartmentInput({
  departments,
  value,
  onChange,
  includeEmpty,
  emptyLabel = "選択してください",
  ...rest
}: {
  departments: string[];
  value: string;
  onChange(v: string): void;
  includeEmpty?: boolean;
  emptyLabel?: string;
  id: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  "aria-required"?: boolean;
  onBlur?(): void;
  disabled?: boolean;
}) {
  if (departments.length === 0) return <Input {...rest} value={value} onChange={(e) => onChange(e.target.value)} placeholder="例: 開発部" />;
  const options = value && !departments.includes(value) ? [value, ...departments] : departments;
  return (
    <Select {...rest} value={value} onChange={(e) => onChange(e.target.value)}>
      {includeEmpty || !value ? <option value="">{emptyLabel}</option> : null}
      {options.map((d) => (
        <option key={d} value={d}>
          {d}
        </option>
      ))}
    </Select>
  );
}

/** Text search that commits to the URL on Enter, blur or after a short pause (keeps typing responsive). */
export function SearchField({ label, value, onCommit, placeholder }: { label: string; value: string; onCommit(v: string): void; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  // The URL can change from outside (top-bar search, back/forward): adopt it.
  if (value !== synced) {
    setSynced(value);
    setDraft(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ value, onCommit });
  latest.current = { value, onCommit };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const commit = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (v.trim() !== latest.current.value) latest.current.onCommit(v.trim());
  };
  return (
    <Field label={label} className="min-w-[220px] flex-1 sm:max-w-[280px]">
      {(p) => (
        <Input
          {...p}
          type="search"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => commit(v), 400);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(draft);
            }
          }}
          onBlur={() => commit(draft)}
        />
      )}
    </Field>
  );
}

/**
 * Save failure banner: when the API errors were placed on fields only a short pointer is shown, otherwise the
 * Japanese API message (+ request id). The entered values are kept either way.
 */
export function SaveErrorBanner({ error, onFields }: { error: unknown; onFields: boolean }) {
  if (!error) return null;
  if (onFields) {
    return (
      <div role="alert" className="rounded-[var(--radius-control)] border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
        保存できませんでした。赤字の項目を確認してください。入力内容は保持されています。
      </div>
    );
  }
  return <InlineError error={error} />;
}

/** Section card of a form with a heading (基本情報, 研修の割当 …). */
export function FormSection({ title, children, description }: { title: string; children: ReactNode; description?: ReactNode }) {
  return (
    <Card className="mb-5">
      <h2 className="mb-1 text-base font-bold">{title}</h2>
      {description ? <p className="mb-3 text-xs text-muted">{description}</p> : <div className="mb-3" />}
      <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">{children}</div>
    </Card>
  );
}

/** Department filter: select of settings.departments, or free text applied on Enter/blur when none are configured. */
export function DepartmentFilter({ id, departments, value, onChange }: { id: string; departments: string[]; value: string; onChange(v: string): void }) {
  if (departments.length) return <DepartmentInput id={id} departments={departments} value={value} onChange={onChange} includeEmpty emptyLabel="すべて" />;
  return (
    <Input
      id={id}
      type="search"
      defaultValue={value}
      key={value}
      placeholder="部署名（Enterで適用）"
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onChange(e.currentTarget.value.trim());
        }
      }}
      onBlur={(e) => {
        if (e.currentTarget.value.trim() !== value) onChange(e.currentTarget.value.trim());
      }}
    />
  );
}
