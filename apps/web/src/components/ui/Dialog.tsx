import * as RadixDialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { cn } from "./cn";

const overlay = "fixed inset-0 z-40 bg-[#0b1421]/50";
const panel =
  "fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[var(--radius-card)] border border-line bg-surface p-6 shadow-xl";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={overlay} />
        <RadixDialog.Content className={cn(panel, wide && "w-[min(860px,calc(100vw-32px))]")} aria-describedby={description ? undefined : undefined}>
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <RadixDialog.Title className="text-lg font-bold">{title}</RadixDialog.Title>
              {description ? <RadixDialog.Description className="mt-1 text-xs text-muted">{description}</RadixDialog.Description> : null}
            </div>
            <RadixDialog.Close asChild>
              <button type="button" aria-label="閉じる" className="rounded-md p-1 text-muted hover:bg-surface-2">
                <X className="size-5" aria-hidden />
              </button>
            </RadixDialog.Close>
          </div>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/**
 * Confirmation for destructive/irreversible operations. States the target and the result explicitly
 * (e.g. 「予約を削除し、履歴を保持します」), and keeps the dialog open with the error if the request fails.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = "danger",
  loading,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  loading?: boolean;
  onConfirm(): void;
  children?: ReactNode;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={overlay} />
        <AlertDialog.Content className={panel}>
          <AlertDialog.Title className="text-lg font-bold">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 text-sm text-fg">{description}</div>
          </AlertDialog.Description>
          {children ? <div className="mt-4">{children}</div> : null}
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" disabled={loading}>
                キャンセル
              </Button>
            </AlertDialog.Cancel>
            <Button variant={tone === "danger" ? "danger" : "primary"} loading={loading} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
