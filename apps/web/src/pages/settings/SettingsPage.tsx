import { useState, type ReactNode } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { Plus } from "lucide-react";
import { PageHeader } from "../../components/ui/PageHeader";
import { Button } from "../../components/ui/Button";
import { Tabs } from "../../components/ui/Tabs";
import { useOnline } from "../../lib/online";
import { useCurrentUser } from "../../lib/session";
import { SystemSettingsTab } from "./SystemSettingsTab";
import { UsersTab } from "./UsersTab";
import { EventsTab } from "./EventsTab";
import { PersonalSettingsTab } from "./PersonalSettingsTab";
import { ImportPanel } from "../../features/imports/ImportPanel";

interface SettingsTab {
  value: string;
  label: string;
  /** Page title shown while the tab is open (WEB-16 設定 / WEB-18 ユーザー管理 / WEB-19 ログ・イベント). */
  title: string;
  content: ReactNode;
}

/**
 * 設定 (WEB-16/18/19) with URL tabs /settings/:tab. Administrators: システム設定・ユーザー管理・ログ・イベント・個人設定.
 * Teachers only have 個人設定 (theme and notifications). 「データ移植」 (WEB-17) follows システム設定.
 */
export function SettingsPage() {
  const user = useCurrentUser();
  const { tab } = useParams();
  const navigate = useNavigate();
  const online = useOnline();
  const [inviteOpen, setInviteOpen] = useState(false);

  const tabs: SettingsTab[] = user.isAdmin
    ? [
        { value: "system", label: "システム設定", title: "設定", content: <SystemSettingsTab /> },
        { value: "import", label: "データ移植", title: "既存システムからのデータ移植", content: <ImportPanel /> },
        { value: "users", label: "ユーザー管理", title: "ユーザー管理", content: <UsersTab inviteOpen={inviteOpen} onInviteOpenChange={setInviteOpen} /> },
        { value: "events", label: "ログ・イベント", title: "ログ・イベント", content: <EventsTab /> },
        { value: "personal", label: "個人設定", title: "個人設定", content: <PersonalSettingsTab /> },
      ]
    : [{ value: "personal", label: "個人設定", title: "個人設定", content: <PersonalSettingsTab /> }];

  const current = tabs.find((t) => t.value === tab);
  if (!current) return <Navigate to={`/settings/${tabs[0]?.value ?? "personal"}`} replace />;

  return (
    <div>
      <PageHeader
        title={current.title}
        crumbs={current.title === "設定" ? [{ label: "設定" }] : [{ label: "設定", to: "/settings" }, { label: current.title }]}
        actions={
          current.value === "users" ? (
            <Button icon={<Plus className="size-4" aria-hidden />} disabled={!online} onClick={() => setInviteOpen(true)}>
              管理者を招待
            </Button>
          ) : null
        }
      />
      <Tabs label="設定の項目" value={current.value} onValueChange={(v) => navigate(`/settings/${v}`)} items={tabs.map(({ value, label, content }) => ({ value, label, content }))} />
    </div>
  );
}
