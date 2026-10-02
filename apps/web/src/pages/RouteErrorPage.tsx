import { isRouteErrorResponse, useRouteError } from "react-router";
import { Button } from "../components/ui/Button";
import { Brand } from "../components/layout/Brand";

/**
 * Route-level error screen (Japanese). Typical causes: a page module that failed to load after a new deployment
 * (stale chunk) or an unexpected rendering error. Details are never shown to the user; reloading fetches the
 * current version of the app.
 */
export function RouteErrorPage() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const chunk = error instanceof Error && /dynamically imported module|Importing a module script failed|does not provide an export/i.test(error.message);
  return (
    <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
      <Brand compact />
      <h1 className="text-xl font-bold">{notFound ? "ページが見つかりません" : "画面を表示できませんでした"}</h1>
      <p className="max-w-md text-sm text-muted">
        {notFound
          ? "URLが正しいか確認してください。"
          : chunk
            ? "アプリが更新された可能性があります。再読み込みすると最新の画面が表示されます。"
            : "時間をおいて再読み込みしてください。解決しない場合は管理者にお問い合わせください。"}
      </p>
      <div className="flex gap-2">
        <Button onClick={() => window.location.reload()}>再読み込み</Button>
        <Button variant="secondary" onClick={() => window.location.assign("/dashboard")}>
          ダッシュボードへ
        </Button>
      </div>
    </div>
  );
}
