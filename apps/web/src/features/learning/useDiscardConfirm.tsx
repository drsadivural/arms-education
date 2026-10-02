import { useState } from "react";
import { ConfirmDialog } from "../../components/ui/Dialog";

/**
 * Dirty-close confirmation for forms shown in dialogs: closing (Esc, ×, キャンセル) with unsaved input asks first.
 * Route changes are covered separately by UnsavedChangesGuard on full-page forms.
 */
export function useDiscardConfirm(dirty: boolean, close: () => void) {
  const [asking, setAsking] = useState(false);
  const requestClose = () => (dirty ? setAsking(true) : close());
  const element = (
    <ConfirmDialog
      open={asking}
      onOpenChange={setAsking}
      title="入力内容を破棄しますか？"
      description="保存していない入力内容は失われます。"
      confirmLabel="破棄して閉じる"
      onConfirm={() => {
        setAsking(false);
        close();
      }}
    />
  );
  return { requestClose, element };
}
