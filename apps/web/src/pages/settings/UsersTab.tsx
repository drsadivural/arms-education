import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ACCOUNT_DELETION_STATE_LABELS, ROLE_LABELS } from "@arms/contracts";
import { Card } from "../../components/ui/Card";
import { ActiveBadge, Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { DataTable, type ColumnDef } from "../../components/ui/DataTable";
import { ConfirmDialog, Dialog } from "../../components/ui/Dialog";
import { InlineError, LastFetched, Notice } from "../../components/ui/Feedback";
import { Field, Input, Select } from "../../components/ui/Field";
import { FilterBar, FilterItem } from "../../components/ui/FilterBar";
import { useToast } from "../../components/ui/Toast";
import { useApiForm } from "../../components/forms/useApiForm";
import { api } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { useIdempotentMutation } from "../../lib/query";
import { useCurrentUser } from "../../lib/session";
import { adminKeys } from "../../features/admin/keys";
import { statusQuery, useCursorList, useUrlFilters } from "../../features/admin/hooks";
import { InvitationResultCard, InvitationStateBadge, ListCount, SaveErrorBanner, SearchField, useResendInvite } from "../../features/admin/components";
import { applyApiErrors, conflictDetail } from "../../features/admin/errors";
import { InviteForm, type InviteFormValues } from "../../features/admin/forms";
import { smallLinkClass } from "../../features/admin/styles";
import type { AccountDeletionRequest, ActionResult, DataResponse, InviteResult, User } from "../../features/admin/types";

const FILTER_KEYS = ["q", "role", "status"] as const;
const roleTone: Record<User["role"], Tone> = { admin: "info", teacher: "success", student: "neutral" };

/** WEB-18 ユーザー管理: アカウント一覧・管理者招待・停止/再開・招待再送・管理者の二段階認証リセット・本人削除申請の対応。 */
export function UsersTab({ inviteOpen, onInviteOpenChange }: { inviteOpen: boolean; onInviteOpenChange(open: boolean): void }) {
  const me = useCurrentUser();
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const [filters, setFilters] = useUrlFilters(FILTER_KEYS);
  const query = { q: filters.q, role: filters.role, status: statusQuery(filters.status, "active") };
  const list = useCursorList<User>(adminKeys.userList(query), "/settings/users", query);
  const [target, setTarget] = useState<{ user: User; action: "disable" | "enable" } | null>(null);

  const toggle = useMutation({
    mutationFn: ({ user, action }: { user: User; action: "disable" | "enable" }) => api.post<ActionResult>(`/settings/users/${user.id}/${action}`),
    onSuccess: (_res, { user, action }) => {
      setTarget(null);
      void qc.invalidateQueries({ queryKey: adminKeys.users });
      void qc.invalidateQueries({ queryKey: adminKeys.teachers });
      void qc.invalidateQueries({ queryKey: adminKeys.students });
      if (action === "disable") toast.success(`${user.display_name}さんのアカウントを停止しました`, "ログイン中のセッション（Web・iOS）も無効になりました。");
      else toast.success(`${user.display_name}さんのアカウントを再開しました`);
    },
  });
  // 管理者が認証アプリを紛失した場合: 別の管理者がTOTP登録を削除し、次回ログイン時に登録し直してもらう。
  const [mfaTarget, setMfaTarget] = useState<User | null>(null);
  const mfaReset = useMutation({
    mutationFn: (user: User) => api.post<ActionResult>(`/settings/users/${user.id}/mfa-reset`),
    onSuccess: (res, user) => {
      setMfaTarget(null);
      const msg = typeof res.data?.message_ja === "string" ? res.data.message_ja : undefined;
      toast.success(`${user.display_name}さんの二段階認証をリセットしました`, msg);
    },
  });
  const resend = useResendInvite(() => void qc.invalidateQueries({ queryKey: adminKeys.users }));

  const columns = useMemo<ColumnDef<User, unknown>[]>(
    () => [
      { id: "name", header: "氏名", cell: ({ row }) => <span className="font-medium">{row.original.display_name}</span> },
      { id: "email", header: "メール", cell: ({ row }) => <span title={row.original.email}>{row.original.email}</span> },
      { id: "role", header: "ロール", cell: ({ row }) => <Badge tone={roleTone[row.original.role]}>{ROLE_LABELS[row.original.role]}</Badge> },
      {
        id: "status",
        header: "状態",
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            <ActiveBadge active={row.original.active} />
            <InvitationStateBadge state={row.original.invitation_state} />
          </span>
        ),
      },
      { id: "created", header: "登録日時", cell: ({ row }) => <span className="text-xs tabular-nums">{fmt.dateTime(row.original.created_at)}</span> },
      {
        id: "actions",
        header: "操作",
        cell: ({ row }) => {
          const u = row.original;
          const detail = u.role === "teacher" ? `/teachers/${u.id}` : u.role === "student" ? `/students/${u.id}` : null;
          const canResend = u.active && (u.invitation_state === "failed" || u.invitation_state === "profile_created");
          return (
            <span className="flex flex-wrap items-center gap-1.5">
              {detail ? (
                <Link to={detail} className={smallLinkClass} aria-label={`${u.display_name}さんの詳細`}>
                  詳細
                </Link>
              ) : null}
              {canResend ? (
                <Button size="sm" variant="secondary" disabled={!online} loading={resend.isPending && resend.variables === u.id} onClick={() => resend.mutate(u.id)} aria-label={`${u.display_name}さんに招待を再送`}>
                  招待を再送
                </Button>
              ) : null}
              {u.role === "admin" && u.active && u.id !== me.id ? (
                <Button size="sm" variant="ghost" disabled={!online} onClick={() => (mfaReset.reset(), setMfaTarget(u))} aria-label={`${u.display_name}さんの二段階認証をリセット`}>
                  二段階認証をリセット
                </Button>
              ) : null}
              {u.id === me.id ? (
                <span className="text-[11px] text-muted">（自分）</span>
              ) : u.active ? (
                <Button size="sm" variant="ghost" className="text-danger" disabled={!online} onClick={() => (toggle.reset(), setTarget({ user: u, action: "disable" }))} aria-label={`${u.display_name}さんを停止`}>
                  停止
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled={!online} onClick={() => (toggle.reset(), setTarget({ user: u, action: "enable" }))} aria-label={`${u.display_name}さんを再開`}>
                  再開
                </Button>
              )}
            </span>
          );
        },
      },
    ],
    [me.id, online, resend, toggle, mfaReset],
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <FilterBar label="アカウントの絞り込み">
          <SearchField label="検索" value={filters.q} onCommit={(q) => setFilters({ q })} placeholder="氏名・メールで検索" />
          <FilterItem label="ロール">
            {(id) => (
              <Select id={id} value={filters.role} onChange={(e) => setFilters({ role: e.target.value })}>
                <option value="">すべて</option>
                <option value="admin">管理者</option>
                <option value="teacher">講師</option>
                <option value="student">受講者</option>
              </Select>
            )}
          </FilterItem>
          <FilterItem label="状態">
            {(id) => (
              <Select id={id} value={filters.status || "active"} onChange={(e) => setFilters({ status: e.target.value === "active" ? "" : e.target.value })}>
                <option value="active">有効</option>
                <option value="inactive">停止中</option>
                <option value="invite_failed">招待メール送信失敗</option>
                <option value="all">すべて</option>
              </Select>
            )}
          </FilterItem>
        </FilterBar>
        <Card aria-labelledby="account-list-title">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 id="account-list-title" className="text-base font-bold">
              アカウント一覧
            </h2>
            <div className="flex items-center gap-3">
              <ListCount count={list.items?.length} hasMore={list.hasMore} unit="件" />
              <LastFetched checkedAt={list.checkedAt} />
            </div>
          </div>
          <DataTable
            caption="アカウント一覧"
            columns={columns}
            data={list.items}
            getRowId={(u) => u.id}
            isLoading={list.isLoading}
            error={list.error}
            onRetry={list.refetch}
            hasMore={list.hasMore}
            loadingMore={list.loadingMore}
            onLoadMore={list.loadMore}
            empty={{ title: "条件に一致するアカウントはありません", description: "講師・新入社員は各管理画面から、管理者は「管理者を招待」から登録します。" }}
          />
          {resend.error ? (
            <div className="mt-3">
              <InlineError error={resend.error} />
            </div>
          ) : null}
        </Card>
      </div>

      <Notice>受講者・講師の選択だけでは権限は変わりません。ロールは管理者が登録したアカウントに従います。講師・新入社員の登録は「講師管理」「新入社員管理」から行います。</Notice>

      <DeletionRequests />

      <InviteDialog open={inviteOpen} onOpenChange={onInviteOpenChange} />

      <ConfirmDialog
        open={!!target}
        onOpenChange={(open) => !open && !toggle.isPending && setTarget(null)}
        title={target?.action === "disable" ? "アカウントを停止しますか？" : "アカウントを再開しますか？"}
        description={
          target ? (
            target.action === "disable" ? (
              <p>
                <b>
                  {target.user.display_name}（{ROLE_LABELS[target.user.role]}・{target.user.email}）
                </b>
                のアカウントを停止します。ログイン中のセッションは無効になり、APIも利用できなくなります。研修記録は保持されます。
              </p>
            ) : (
              <p>
                <b>
                  {target.user.display_name}（{ROLE_LABELS[target.user.role]}）
                </b>
                のアカウントを再開し、再びログインできるようにします。
              </p>
            )
          ) : (
            ""
          )
        }
        confirmLabel={target?.action === "disable" ? "停止する" : "再開する"}
        tone={target?.action === "disable" ? "danger" : "primary"}
        loading={toggle.isPending}
        onConfirm={() => target && !toggle.isPending && toggle.mutate(target)}
      >
        {toggle.error ? (
          <div className="flex flex-col gap-1">
            <InlineError error={toggle.error} />
            {conflictDetail(toggle.error) ? <p className="text-xs text-muted">{conflictDetail(toggle.error)}</p> : null}
          </div>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={!!mfaTarget}
        onOpenChange={(open) => !open && !mfaReset.isPending && setMfaTarget(null)}
        title="二段階認証をリセットしますか？"
        description={
          mfaTarget ? (
            <p>
              <b>
                {mfaTarget.display_name}（{mfaTarget.email}）
              </b>
              の認証アプリの登録を削除し、ログイン中のセッションをすべて解除します。本人確認のうえ実行してください。次回ログイン時に認証アプリを登録し直す必要があります。
            </p>
          ) : (
            ""
          )
        }
        confirmLabel="リセットする"
        tone="danger"
        loading={mfaReset.isPending}
        onConfirm={() => mfaTarget && !mfaReset.isPending && mfaReset.mutate(mfaTarget)}
      >
        {mfaReset.error ? <InlineError error={mfaReset.error} /> : null}
      </ConfirmDialog>
    </div>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const form = useApiForm(InviteForm, { display_name: "", email: "" });
  const { register, handleSubmit, formState } = form;
  const [fieldsFailed, setFieldsFailed] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);
  const invite = useIdempotentMutation(
    (body: InviteFormValues, key: string) => api.post<DataResponse<InviteResult>>("/settings/users/invite", { ...body, role: "admin" }, { idempotencyKey: key }),
    {
      onSuccess: (res) => {
        setResult(res.data);
        form.reset({ display_name: "", email: "" });
        void qc.invalidateQueries({ queryKey: adminKeys.users });
        if (res.data.state === "sent") toast.success("管理者を招待しました", "招待メールを送信しました。");
        else toast.error("招待メールを送信できませんでした", res.data.message_ja);
      },
      onError: (e) => setFieldsFailed(applyApiErrors(form, e)),
    },
  );
  const close = (o: boolean) => {
    if (invite.isPending) return;
    onOpenChange(o);
    if (!o) {
      setResult(null);
      invite.reset();
      form.reset({ display_name: "", email: "" });
    }
  };
  return (
    <Dialog open={open} onOpenChange={close} title="管理者を招待" description="管理者アカウントを作成し、招待メールを送信します。講師・新入社員は各管理画面から登録してください。">
      {result ? (
        <div className="flex flex-col gap-4">
          <InvitationResultCard invitation={result} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setResult(null)}>
              続けて招待
            </Button>
            <Button onClick={() => close(false)}>閉じる</Button>
          </div>
        </div>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={handleSubmit((v) => {
            if (invite.isPending) return;
            setFieldsFailed(false);
            invite.mutate(v);
          })}
        >
          <Field label="氏名" required error={formState.errors.display_name?.message}>
            {(p) => <Input {...p} {...register("display_name")} autoComplete="off" />}
          </Field>
          <Field label="メールアドレス" required error={formState.errors.email?.message} hint="ログインIDになります。管理者は初回ログイン時に二段階認証を設定します。">
            {(p) => <Input {...p} {...register("email")} type="email" autoComplete="off" />}
          </Field>
          <SaveErrorBanner error={invite.error} onFields={fieldsFailed} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={invite.isPending} onClick={() => close(false)}>
              キャンセル
            </Button>
            <Button type="submit" loading={invite.isPending} disabled={!online}>
              招待を送信
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function DeletionRequests() {
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const list = useCursorList<AccountDeletionRequest>(adminKeys.deletionRequests, "/settings/account-deletion-requests", {});
  const [target, setTarget] = useState<AccountDeletionRequest | null>(null);
  const complete = useMutation({
    mutationFn: (r: AccountDeletionRequest) => api.post<ActionResult>(`/settings/account-deletion-requests/${r.id}/complete`),
    onSuccess: (res, r) => {
      setTarget(null);
      void qc.invalidateQueries({ queryKey: adminKeys.users });
      toast.success(`${r.display_name}さんの削除申請を対応完了にしました`, "アカウントは停止され、研修記録は保持されます。");
    },
  });
  const columns = useMemo<ColumnDef<AccountDeletionRequest, unknown>[]>(
    () => [
      {
        id: "user",
        header: "申請者",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="font-medium">{row.original.display_name}</span>
            <span className="text-[11px] text-muted">{row.original.email}</span>
          </span>
        ),
      },
      { id: "role", header: "ロール", cell: ({ row }) => ROLE_LABELS[row.original.role] },
      { id: "reason", header: "理由", cell: ({ row }) => <span title={row.original.reason}>{row.original.reason || "（記載なし）"}</span> },
      { id: "created", header: "申請日時", cell: ({ row }) => <span className="text-xs tabular-nums">{fmt.dateTime(row.original.created_at)}</span> },
      {
        id: "state",
        header: "状態",
        cell: ({ row }) => (
          <span className="flex flex-wrap gap-1">
            <Badge tone={row.original.state === "completed" ? "success" : "warning"}>{ACCOUNT_DELETION_STATE_LABELS[row.original.state]}</Badge>
            {!row.original.user_active ? <Badge tone="neutral">停止済み</Badge> : null}
          </span>
        ),
      },
      {
        id: "actions",
        header: "操作",
        cell: ({ row }) =>
          row.original.state === "completed" ? (
            <span className="text-xs text-muted">—</span>
          ) : (
            <Button size="sm" variant="secondary" disabled={!online} onClick={() => (complete.reset(), setTarget(row.original))} aria-label={`${row.original.display_name}さんの削除申請を対応完了にする`}>
              対応完了にする
            </Button>
          ),
      },
    ],
    [online, complete],
  );
  return (
    <Card aria-labelledby="deletion-title">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="deletion-title" className="text-base font-bold">
            アカウント削除の申請
          </h2>
          <p className="mt-1 text-xs text-muted">利用者本人がアプリから申請したアカウント削除です。対応完了にするとアカウントを停止します。</p>
        </div>
        <LastFetched checkedAt={list.checkedAt} />
      </div>
      <DataTable
        caption="アカウント削除の申請"
        columns={columns}
        data={list.items}
        getRowId={(r) => r.id}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={list.refetch}
        hasMore={list.hasMore}
        loadingMore={list.loadingMore}
        onLoadMore={list.loadMore}
        empty={{ title: "削除の申請はありません", description: "利用者がアカウント削除を申請すると、ここに表示されます。" }}
      />
      <ConfirmDialog
        open={!!target}
        onOpenChange={(open) => !open && !complete.isPending && setTarget(null)}
        title="削除申請を対応完了にしますか？"
        description={
          target ? (
            <p>
              <b>
                {target.display_name}（{ROLE_LABELS[target.role]}・{target.email}）
              </b>
              のアカウントを停止し、申請を対応完了にします。研修記録は組織の記録として保持されます。
            </p>
          ) : (
            ""
          )
        }
        confirmLabel="対応完了にする"
        loading={complete.isPending}
        onConfirm={() => target && !complete.isPending && complete.mutate(target)}
      >
        {complete.error ? (
          <div className="flex flex-col gap-1">
            <InlineError error={complete.error} />
            {conflictDetail(complete.error) ? <p className="text-xs text-muted">{conflictDetail(complete.error)}</p> : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}
