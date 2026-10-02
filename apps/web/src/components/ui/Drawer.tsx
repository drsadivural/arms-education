import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/** Side panel for details (modal: focus is trapped and returned to the trigger; Esc closes). */
export function Drawer({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange(open: boolean): void; title: string; description?: string; children: ReactNode }) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-[#0b1421]/50" />
        <RadixDialog.Content
          className="fixed inset-y-0 right-0 z-50 flex w-[min(520px,100vw)] flex-col border-l border-line bg-surface shadow-xl"
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line p-5">
            <div className="min-w-0">
              <RadixDialog.Title className="text-lg font-bold break-words">{title}</RadixDialog.Title>
              {description ? <RadixDialog.Description className="mt-1 text-xs text-muted">{description}</RadixDialog.Description> : null}
            </div>
            <RadixDialog.Close asChild>
              <button type="button" aria-label="閉じる" className="rounded-md p-1 text-muted hover:bg-surface-2">
                <X className="size-5" aria-hidden />
              </button>
            </RadixDialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
