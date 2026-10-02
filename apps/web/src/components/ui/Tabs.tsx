import * as RadixTabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
}

/** Underlined tabs (WEB-13 予約申請 / 授業カレンダー / 空き枠管理 / 履歴, 設定 tabs). Controlled by the URL when `value` is given. */
export function Tabs({ items, value, onValueChange, label }: { items: TabItem[]; value: string; onValueChange(v: string): void; label: string }) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange}>
      <RadixTabs.List aria-label={label} className="mb-6 flex gap-6 overflow-x-auto border-b border-line">
        {items.map((t) => (
          <RadixTabs.Trigger
            key={t.value}
            value={t.value}
            className="-mb-px border-b-2 border-transparent px-1 pb-3 text-sm whitespace-nowrap text-muted data-[state=active]:border-primary data-[state=active]:font-bold data-[state=active]:text-primary"
          >
            {t.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((t) => (
        <RadixTabs.Content key={t.value} value={t.value} className="outline-none">
          {t.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
