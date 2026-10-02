import { Link } from "react-router";
import { EmptyState } from "../components/ui/Feedback";

export function NotFoundPage() {
  return (
    <EmptyState
      title="ページが見つかりません"
      description="URLが正しいか確認してください。メニューから目的の画面を開くこともできます。"
      action={
        <Link to="/dashboard" className="text-sm font-medium text-primary hover:underline">
          ダッシュボードへ戻る
        </Link>
      }
    />
  );
}
