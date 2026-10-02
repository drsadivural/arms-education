import { BookOpen, CalendarDays, ChartColumn, House, Presentation, Settings, UserRound, Users, type LucideIcon } from "lucide-react";

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

/** Web top-level menu — order is fixed by docs/01 (Webメニュー — 順番固定). Do not add items here. */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: "ダッシュボード", to: "/dashboard", icon: House },
  { label: "講師管理", to: "/teachers", icon: UserRound },
  { label: "新入社員管理", to: "/students", icon: Users },
  { label: "クラスルーム管理", to: "/classrooms", icon: Presentation },
  { label: "教育プログラム管理", to: "/programs", icon: BookOpen },
  { label: "社員教育進捗管理", to: "/progress", icon: ChartColumn },
  { label: "オンライン予約システム", to: "/bookings", icon: CalendarDays },
  { label: "設定", to: "/settings", icon: Settings },
];
