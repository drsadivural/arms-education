import { NavLink, Link } from "react-router";
import { ROLE_LABELS } from "@arms/contracts";
import { useCurrentUser } from "../../lib/session";
import { cn } from "../ui/cn";
import { Brand } from "./Brand";
import { NAV_ITEMS } from "./nav";

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const user = useCurrentUser();
  return (
    <div className="flex h-full flex-col px-4 py-5">
      <Link to="/dashboard" onClick={onNavigate} className="mb-6 px-2" aria-label="ARMS ダッシュボードへ">
        <Brand />
      </Link>
      <nav aria-label="メインメニュー">
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    "flex min-h-11 items-center gap-3 rounded-[10px] px-3 text-[13px] whitespace-nowrap transition-colors",
                    isActive ? "bg-primary-soft font-bold text-primary" : "text-muted hover:bg-surface-2 hover:text-fg",
                  )
                }
              >
                <item.icon className="size-[18px] shrink-0" aria-hidden />
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-auto border-t border-line pt-5">
        <div className="rounded-xl bg-primary-soft p-4">
          <p className="text-sm font-bold">AI音声アシスタント</p>
          <p className="mt-1 text-[11px] text-muted">声で授業・進捗・予約を確認</p>
          <Link to="/voice" onClick={onNavigate} className="mt-2 inline-block text-sm font-medium text-primary hover:underline">
            音声画面を見る →
          </Link>
        </div>
        <p className="mt-4 px-1 text-[11px] text-muted">{user.organizationName}</p>
        <p className="px-1 text-[11px] text-muted">{ROLE_LABELS[user.role]}としてログイン</p>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 border-r border-line bg-surface lg:block">
      <SidebarContent />
    </aside>
  );
}
