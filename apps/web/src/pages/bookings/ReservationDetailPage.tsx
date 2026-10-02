/**
 * WEB-14 予約申請の確認 (/bookings/reservations/:id): details, seat hold expiry with a countdown, cancel deadline,
 * private lesson URL only when the API discloses it (approved + authorised), history timeline and the
 * 承認 / 理由付き却下 / 削除（履歴を保持） actions. Polls every 5 s so decisions made on iOS appear here.
 */
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { RESERVATION_STATUS_LABELS, isValidDecisionReason, type Reservation } from "@arms/contracts";
import { ApiError } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { ErrorState, LastFetched, LoadingRows, Notice } from "../../components/ui/Feedback";
import { PageHeader } from "../../components/ui/PageHeader";
import { BookingStatusBadge, dangerSoftButton } from "../../features/booking/tone";
import { useToast } from "../../components/ui/Toast";
import { useReservation } from "../../features/booking/api";
import { DecisionError, REASON_ERROR, ReasonField, RemoveDialog, decisionErrorMessage, reservationCaption, useApproveAction, useReservationDecision } from "../../features/booking/decisions";
import { dateTimeFull, historyEventLabel, holdRemaining, slotRangeFull, statusLabel } from "../../features/booking/format";

const crumbs = [{ label: "オンライン予約システム", to: "/bookings" }, { label: "予約申請の確認" }];

/** Re-renders every `ms` so countdowns stay current. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line py-3 last:border-b-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-right text-sm font-bold break-words">{children}</dd>
    </div>
  );
}

function Details({ r, now }: { r: Reservation; now: number }) {
  const remaining = r.status === "pending" ? holdRemaining(r.expires_at, now) : null;
  return (
    <dl>
      <Row label="受講者">
        {r.student_name ?? "—"}
        {r.employee_number ? <span className="ml-1 text-xs font-normal text-muted">（社員番号 {r.employee_number}）</span> : null}
      </Row>
      <Row label="所属クラス">{r.classroom_name ?? "—"}</Row>
      <Row label="授業">{r.slot_title ?? "—"}</Row>
      <Row label="担当講師">{r.teacher_name ?? "—"}</Row>
      <Row label="希望日時">{slotRangeFull(r.starts_at, r.ends_at)}</Row>
      <Row label="現在の状態">
        <BookingStatusBadge status={r.status} />
      </Row>
      <Row label="申請日時">{dateTimeFull(r.created_at)}</Row>
      {r.status === "pending" ? (
        <Row label="席の保持期限">
          {dateTimeFull(r.expires_at)}
          <span className="mt-0.5 block text-xs font-medium text-warning">{remaining ? `${remaining}（期限までに判断がないと申請期限切れになります）` : "保持期限を過ぎました"}</span>
        </Row>
      ) : null}
      <Row label="受講者の取消期限">{dateTimeFull(r.cancel_deadline)}</Row>
      {r.meeting_url ? (
        <Row label="オンライン授業URL">
          <a href={r.meeting_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-primary underline-offset-2 hover:underline">
            {r.meeting_url}
            <ExternalLink className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">（新しいタブで開きます）</span>
          </a>
        </Row>
      ) : null}
      {r.reason?.trim() ? (
        <Row label={r.status === "removed" ? "削除の理由" : r.status === "cancelled" ? "取消の理由" : "理由"}>
          <span className="font-normal whitespace-pre-wrap">{r.reason}</span>
        </Row>
      ) : null}
    </dl>
  );
}

function DecisionPanel({ r }: { r: Reservation }) {
  const toast = useToast();
  const online = useOnline();
  const { approve, isPending } = useApproveAction();
  const reject = useReservationDecision("reject");
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [removeOpen, setRemoveOpen] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const pending = r.status === "pending";

  const requireReason = (): boolean => {
    if (isValidDecisionReason(reason)) {
      setFieldError(undefined);
      return true;
    }
    setFieldError(REASON_ERROR);
    reasonRef.current?.focus();
    return false;
  };
  const onReject = async () => {
    if (reject.isPending || !requireReason()) return;
    try {
      await reject.mutateAsync({ id: r.id, expected_version: r.row_version, reason: reason.trim() });
      toast.success("予約申請を却下しました", reservationCaption(r));
      setReason("");
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.reason) setFieldError(err.fieldErrors.reason);
      toast.error("却下できませんでした", decisionErrorMessage(err));
    }
  };

  if (r.status === "removed") {
    return (
      <Card>
        <CardHeader title="判断と理由" />
        <Notice>この予約は削除済みです。通常の一覧には表示されず、操作履歴と理由は保持されています。</Notice>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="判断と理由" />
      <div className="flex flex-col gap-4">
        {pending ? (
          <Notice>承認すると、受講者のiOSアプリと通知に反映されます。</Notice>
        ) : (
          <Notice>
            この予約は「{RESERVATION_STATUS_LABELS[r.status]}」です。承認・却下は承認待ちの申請にのみ行えます。
          </Notice>
        )}
        <ReasonField
          label={pending ? "却下・削除の理由" : "削除の理由"}
          value={reason}
          onChange={(v) => {
            setReason(v);
            if (fieldError && isValidDecisionReason(v)) setFieldError(undefined);
          }}
          error={fieldError}
          textareaRef={reasonRef}
        />
        {pending ? (
          <>
            <DecisionError error={reject.error} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button loading={isPending(r.id)} disabled={!online || reject.isPending} onClick={() => void approve(r)}>
                承認する
              </Button>
              <Button variant="secondary" loading={reject.isPending} disabled={!online || isPending(r.id)} onClick={() => void onReject()}>
                却下する
              </Button>
            </div>
          </>
        ) : null}
        <div className="border-t border-line pt-4">
          <h3 className="text-sm font-bold">予約を削除</h3>
          <p className="mt-1 text-xs text-muted">通常一覧から非表示にします。操作履歴は保持します。</p>
          <button
            type="button"
            className={`mt-3 ${dangerSoftButton}`}
            disabled={!online}
            onClick={() => {
              if (requireReason()) setRemoveOpen(true);
            }}
          >
            削除する
          </button>
        </div>
        {!online ? <p className="text-xs text-warning">オフラインのため操作できません。</p> : null}
      </div>
      <RemoveDialog reservation={r} open={removeOpen} onOpenChange={setRemoveOpen} initialReason={reason} onRemoved={() => setReason("")} />
    </Card>
  );
}

function History({ items }: { items: NonNullable<Reservation["history"]> }) {
  if (items.length === 0) return <p className="text-xs text-muted">履歴はまだありません。</p>;
  return (
    <ol className="flex flex-col gap-4">
      {items.map((h, i) => (
        <li key={`${h.created_at}-${i}`} className="border-l-2 border-primary pl-4">
          <p className="text-sm font-bold">
            <time dateTime={h.created_at}>{fmt.dateTime(h.created_at)}</time>
            <span className="ml-3">{h.actor_name ?? "システム（自動処理）"}</span>
          </p>
          <p className="mt-1 text-xs text-muted">
            {historyEventLabel(h.event_type)}
            {statusLabel(h.status) ? ` · ${statusLabel(h.status)}` : ""}
          </p>
          {h.reason?.trim() ? <p className="mt-1 text-xs break-words whitespace-pre-wrap">理由：{h.reason}</p> : null}
        </li>
      ))}
    </ol>
  );
}

export function ReservationDetailPage() {
  const { id = "" } = useParams();
  const query = useReservation(id);
  const now = useNow(30_000);
  const r = query.data;
  return (
    <>
      <PageHeader
        title="予約申請の確認"
        crumbs={crumbs}
        actions={
          <Link to="/bookings" className="text-sm text-primary underline-offset-2 hover:underline">
            予約申請の一覧へ戻る
          </Link>
        }
      />
      {query.isLoading && !r ? (
        <LoadingRows rows={8} label="予約の内容を読み込み中です" />
      ) : !r ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {query.error ? <ErrorState compact error={query.error} onRetry={() => void query.refetch()} /> : null}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader title="申請内容" actions={<LastFetched checkedAt={r.checked_at} />} />
              <Details r={r} now={now} />
            </Card>
            <DecisionPanel key={r.id} r={r} />
          </div>
          <Card>
            <CardHeader title="予約履歴" />
            <History items={r.history ?? []} />
            {r.slot_id ? (
              <p className="mt-4 text-xs">
                <Link to={`/bookings/slots/${r.slot_id}`} className="text-primary underline-offset-2 hover:underline">
                  この授業枠を開く
                </Link>
              </p>
            ) : null}
          </Card>
        </div>
      )}
    </>
  );
}
