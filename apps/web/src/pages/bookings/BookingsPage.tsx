/**
 * WEB-13 オンライン予約システム: tabs 予約申請（承認待ち件数） / 授業カレンダー / 空き枠管理 / 履歴, kept in the URL (?tab=).
 * Lists poll every 5 s while visible and refetch on focus (予約可視化5秒以内).
 */
import { Plus } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { PageHeader } from "../../components/ui/PageHeader";
import { Tabs } from "../../components/ui/Tabs";
import { usePendingCount } from "../../features/booking/api";
import { HistoryTab, RequestsTab } from "../../features/booking/ReservationTabs";
import { CalendarTab, SlotsTab } from "../../features/booking/SlotTabs";

const TABS = ["requests", "calendar", "slots", "history"] as const;
type Tab = (typeof TABS)[number];

function PendingBadge() {
  const pending = usePendingCount();
  if (!pending.data || pending.data.count === 0) return null;
  const text = `${pending.data.count}${pending.data.more ? "+" : ""}`;
  return (
    <span className="relative ml-2 inline-flex min-w-6 items-center justify-center rounded-full bg-primary-soft px-1.5 text-xs font-bold text-primary">
      <span aria-hidden>{text}</span>
      <span className="sr-only">（承認待ち {text}件）</span>
    </span>
  );
}

export function BookingsPage() {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "requests";
  // Switching tabs starts from that tab's default filters (status values differ per tab).
  const onTab = (v: string) => setSp(v === "requests" ? {} : { tab: v });
  return (
    <>
      <PageHeader
        title="オンライン予約システム"
        crumbs={[{ label: "オンライン予約システム" }]}
        actions={
          <Link
            to="/bookings/slots/new"
            className="inline-flex h-10 items-center gap-1.5 rounded-[var(--radius-control)] bg-brand px-4 text-sm font-medium whitespace-nowrap text-white shadow-sm hover:bg-primary-strong dark:text-[#0b1421]"
          >
            <Plus className="size-4" aria-hidden />
            予約枠を追加
          </Link>
        }
      />
      <Tabs
        label="予約管理の表示切替"
        value={tab}
        onValueChange={onTab}
        items={[
          {
            value: "requests",
            label: (
              <span className="inline-flex items-center">
                予約申請
                <PendingBadge />
              </span>
            ),
            content: tab === "requests" ? <RequestsTab /> : null,
          },
          { value: "calendar", label: "授業カレンダー", content: tab === "calendar" ? <CalendarTab /> : null },
          { value: "slots", label: "空き枠管理", content: tab === "slots" ? <SlotsTab /> : null },
          { value: "history", label: "履歴", content: tab === "history" ? <HistoryTab /> : null },
        ]}
      />
    </>
  );
}
