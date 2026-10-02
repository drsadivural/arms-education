import { useEffect } from "react";
import { useBlocker } from "react-router";
import { ConfirmDialog } from "../ui/Dialog";

/** Confirms before leaving a form with unsaved edits (in-app navigation and tab close/reload). */
export function UnsavedChangesGuard({ when }: { when: boolean }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [when]);
  return (
    <ConfirmDialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => !open && blocker.state === "blocked" && blocker.reset()}
      title="保存されていない変更があります"
      description="入力中の内容は保存されていません。破棄してこのページを離れますか？"
      confirmLabel="破棄して移動"
      onConfirm={() => blocker.state === "blocked" && blocker.proceed()}
    />
  );
}
