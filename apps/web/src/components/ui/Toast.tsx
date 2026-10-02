import * as RadixToast from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: "success" | "error";
}

const ToastContext = createContext<{ notify(t: Omit<ToastItem, "id">): void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const notify = useCallback((t: Omit<ToastItem, "id">) => setItems((prev) => [...prev, { ...t, id: Date.now() + Math.random() }]), []);
  return (
    <ToastContext.Provider value={{ notify }}>
      <RadixToast.Provider swipeDirection="right" duration={5000} label="通知">
        {children}
        {items.map((t) => (
          <RadixToast.Root
            key={t.id}
            onOpenChange={(open) => !open && setItems((prev) => prev.filter((x) => x.id !== t.id))}
            className="flex items-start gap-3 rounded-[var(--radius-control)] border border-line bg-surface p-4 shadow-lg"
          >
            {t.tone === "success" ? <CheckCircle2 className="size-5 text-success" aria-hidden /> : <AlertTriangle className="size-5 text-danger" aria-hidden />}
            <div>
              <RadixToast.Title className="text-sm font-bold">{t.title}</RadixToast.Title>
              {t.description ? <RadixToast.Description className="mt-1 text-xs text-muted">{t.description}</RadixToast.Description> : null}
            </div>
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport label="お知らせ ({hotkey})" className="fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return {
    success: (title: string, description?: string) => ctx.notify({ title, description, tone: "success" }),
    error: (title: string, description?: string) => ctx.notify({ title, description, tone: "error" }),
  };
}
