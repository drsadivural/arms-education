import * as RadixDialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import { Bell, LogOut, Menu, Monitor, Moon, Search, Sun, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ROLE_LABELS, type Notification, type Page } from "@arms/contracts";
import { api } from "../../lib/api";
import { useCurrentUser, useSession } from "../../lib/session";
import { useTheme, type ThemePreference } from "../../lib/theme";
import { useMe, useSavePreferences } from "../../lib/preferences";
import { SidebarContent } from "./Sidebar";
import { Brand } from "./Brand";

const THEMES: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "ライト", icon: Sun },
  { value: "dark", label: "ダーク", icon: Moon },
  { value: "system", label: "システム設定に合わせる", icon: Monitor },
];

function useUnreadCount() {
  return useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: () => api.get<Page<Notification>>("/notifications", { query: { status: "unread", limit: 100 } }),
    select: (p) => p.items.length,
    refetchInterval: 60_000,
  });
}

export function Topbar() {
  const user = useCurrentUser();
  const { logout } = useSession();
  const { preference, setPreference } = useTheme();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [q, setQ] = useState("");
  const unread = useUnreadCount();
  const me = useMe();
  const savePreferences = useSavePreferences();
  const changeTheme = (value: ThemePreference) => {
    setPreference(value);
    savePreferences.mutate({ theme: value, notifications_enabled: me.data?.data.preferences.notifications_enabled ?? true });
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) navigate(`/students?q=${encodeURIComponent(term)}`);
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-surface px-4 lg:px-8">
      <RadixDialog.Root open={drawer} onOpenChange={setDrawer}>
        <RadixDialog.Trigger asChild>
          <button type="button" className="rounded-md p-2 text-fg hover:bg-surface-2 lg:hidden" aria-label="メニューを開く">
            <Menu className="size-5" aria-hidden />
          </button>
        </RadixDialog.Trigger>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="fixed inset-0 z-40 bg-[#0b1421]/50 lg:hidden" />
          <RadixDialog.Content className="fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] overflow-y-auto bg-surface lg:hidden">
            <RadixDialog.Title className="sr-only">メインメニュー</RadixDialog.Title>
            <RadixDialog.Close className="absolute top-4 right-3 rounded-md p-1 text-muted" aria-label="メニューを閉じる">
              <X className="size-5" aria-hidden />
            </RadixDialog.Close>
            <SidebarContent onNavigate={() => setDrawer(false)} />
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>

      <Link to="/dashboard" className="sm:hidden" aria-label="ARMS ダッシュボードへ">
        <Brand compact />
      </Link>
      <form role="search" onSubmit={onSearch} className="relative mr-auto hidden w-[330px] max-w-full sm:block">
        <label htmlFor="global-search" className="sr-only">
          社員名で検索
        </label>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input
          id="global-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="検索：社員名・社員番号・メール"
          className="h-10 w-full rounded-[9px] border border-line bg-bg pr-3 pl-9 text-sm placeholder:text-muted"
        />
      </form>
      <div className="ml-auto flex items-center gap-2 sm:ml-0">
        <span className="hidden text-sm text-primary md:inline" lang="ja">
          日本語
        </span>
        <Link to="/notifications" className="relative inline-flex items-center gap-1 rounded-md p-2 text-sm text-primary hover:bg-surface-2" aria-label={`通知 ${unread.data ?? 0}件未読`}>
          <Bell className="size-5" aria-hidden />
          <span className="hidden md:inline">通知</span>
          {unread.data ? <span className="rounded-full bg-danger px-1.5 text-[10px] font-bold text-white">{unread.data}</span> : null}
        </Link>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="flex items-center gap-2 rounded-md p-1 text-left hover:bg-surface-2" aria-label="アカウントメニュー">
              <span className="inline-flex size-9 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary" aria-hidden>
                {user.display_name.slice(0, 1)}
              </span>
              <span className="hidden flex-col leading-tight md:flex">
                <span className="text-xs font-bold">{user.display_name}</span>
                <span className="text-[11px] text-muted">{ROLE_LABELS[user.role]}</span>
              </span>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-[220px] rounded-[var(--radius-control)] border border-line bg-surface p-1 shadow-lg">
              <DropdownMenu.Label className="px-3 py-2 text-[11px] text-muted">表示テーマ</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={preference} onValueChange={(v) => changeTheme(v as ThemePreference)}>
                {THEMES.map((t) => (
                  <DropdownMenu.RadioItem
                    key={t.value}
                    value={t.value}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2 data-[state=checked]:font-bold data-[state=checked]:text-primary"
                  >
                    <t.icon className="size-4" aria-hidden />
                    {t.label}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item
                onSelect={() => void logout()}
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-danger outline-none data-[highlighted]:bg-danger-soft"
              >
                <LogOut className="size-4" aria-hidden />
                ログアウト
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
  );
}
