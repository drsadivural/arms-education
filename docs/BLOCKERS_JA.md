# 開発開始後に必要な外部値

この開発パッケージの作成を妨げるblockerはない。完成アプリのデプロイと実サービス検証には以下が必要。
- Cloudflare/Supabase/OpenAI各アカウント・利用権限とSecrets。
- 本番ドメイン・初期組織名・管理者招待先。
- Apple Developer team・Bundle ID・署名・APNs権限・配布方式。
- 実教材・スキャンサービス・メール送信ドメイン・授業URL。
- 既存システムのCSV/Excel実エクスポートとID対応。
- 顧客の予約締切・進捗判定・保持期間の最終決定。

不足値は架空値で接続成功にしない。設定inputはtemplates/config-inputs.jsonで必須/秘密/保管先を定義する。
