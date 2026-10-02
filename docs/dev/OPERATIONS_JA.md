# 運用手順（Runbook）

docs/09 の 10〜12 項に対応する、この実装での監視・障害対応・定期作業。ログはすべて構造化JSON（`request_id` で相関）で、
秘密・トークン・Cookie・音声・文字起こし・教材本文は出力しない。

## 1. 監視項目と初期しきい値
| 対象 | 取得元 | 警告の目安 | 主な原因 |
|---|---|---|---|
| APIエラー率 | Workers Observability（`msg:"request"` の `status`） | 5分間で5xxが1%超 | DB接続、外部サービス障害、デプロイ不具合 |
| API遅延 | 同上 `duration_ms` | 読み取りp95 > 500ms、予約変更p95 > 1s | DB負荷、Hyperdrive設定、スロークエリ |
| DB接続失敗 | `code:"DB_UNAVAILABLE"` | 1分間に10件以上 | DB停止、接続上限、Hyperdrive障害 |
| 承認待ちの期限切れ遅延 | SQL: `SELECT count(*) FROM app.reservations WHERE status='pending' AND expires_at < now() - interval '5 minutes'` | 1件以上 | Cron停止 |
| 通知の滞留 | SQL: `app.outbox` の `state IN ('pending','processing')` かつ `created_at < now() - interval '10 minutes'` | 10件以上 | Queue/Cron停止、メール・APNs障害 |
| 通知の失敗 | `app.outbox` `state='failed'`、`app.notification_deliveries` | 新規発生 | 送信先・認証情報の誤り（Web「ログ・イベント > 通知配信」から再送可能） |
| ファイル検査待ち | `app.upload_jobs` の `state='scanning'` が30分超 | 1件以上 | スキャナー障害・未設定（公開は自動的に停止される） |
| 認証拒否 | `UNAUTHENTICATED` / `CSRF_FAILED` / `ORIGIN_REJECTED` / `RATE_LIMITED` | 急増 | 攻撃、設定変更、時計ずれ |
| 音声利用量 | `app.voice_sessions`（日別合計）とOpenAIの使用量ダッシュボード | 予算の80% | 想定外の利用。組織設定の日次上限で抑制 |
| 監査ログの出力 | `audit.exported` | 想定外の実行 | 情報持ち出しの確認 |

## 2. 障害時の対応
- **DB障害**: APIは変更を成功表示せず `DB_UNAVAILABLE`（「変更は保存されていません」）を返す。復旧後、承認待ちの期限切れはCron（1分ごと）と各操作時の遅延判定で自動整合。復旧確認は `GET /api/v1/health`。
- **OpenAI障害・上限**: 音声は `VOICE_UNAVAILABLE`（「現在、音声機能を利用できません。画面から操作してください」）。予約・進捗の通常操作には影響しない。必要なら組織設定の音声日次上限を0にして新規セッションを止める。
- **メール・APNs障害**: 予約は確定済みのまま、outboxが指数バックオフで再試行（最大10回）。上限後は `failed`。原因解消後に「通知配信」から再送。アプリ内通知は常に作成される。
- **スキャナー障害**: 新しい教材ファイルは「検査待ち」のまま公開できない（安全側）。復旧後、Cronのポーリングで判定を取得。
- **不正アクセスの疑い**: 対象ユーザーを「ユーザー管理」で停止（全Webセッション失効＋Auth側のサインイン停止）。必要に応じ下記の鍵ローテーション。

## 3. 鍵・秘密のローテーション
| 秘密 | 手順 | 影響 |
|---|---|---|
| `WEB_SESSION_ENCRYPTION_KEY` | 新しい32バイト値を `wrangler secret put` → デプロイ | 既存Webセッションは復号できず全員再ログイン（安全側） |
| `DEVICE_TOKEN_ENCRYPTION_KEY` | 新しい値を設定 → デプロイ | 既存端末トークンは復号不可。アプリ起動時の再登録で回復（それまでプッシュ未達、アプリ内通知は有効） |
| `SUPABASE_ADMIN_SECRET` / `OPENAI_API_KEY` / `MAIL_PROVIDER_API_KEY` / `MALWARE_SCAN_API_KEY` / `APNS_PRIVATE_KEY` / R2キー | 提供元で新キー発行 → `wrangler secret put` → デプロイ → 旧キー失効 | なし（短時間の二重有効期間を設ける） |
| Supabase JWT署名鍵 | Supabaseの鍵ローテーション機能（新鍵をスタンバイ→切替） | APIはJWKSを10分キャッシュ。旧鍵の失効は切替から十分後に行う |

## 4. 定期作業
- **毎分（Cron）**: 承認待ちの期限切れ、通知配信の再試行、アップロード期限切れ・検査ポーリング、出力ファイル生成・24時間後削除、音声セッションの期限切れ精算、期限切れWebセッション・冪等キーの削除。
- **毎月**: バックアップからの復元演習（下記）、依存パッケージの脆弱性確認（CIの `pnpm audit`）、管理者アカウントとMFAの棚卸し。
- **随時**: 予約設定・音声上限・祝日の見直し（設定画面）。

## 5. バックアップと復元演習（RPO 24時間 / RTO 4時間の初期目標）
1. SupabaseのPITR/日次バックアップから検証用プロジェクトへ復元する（本番へ直接戻さない）。
2. `scripts/db/migrate.mjs` で未適用マイグレーションがないことを確認し、`db/grants.sql` を再適用。
3. 検証用Workers環境（staging相当）を復元DBへ向け、`GET /health`、管理者ログイン、予約一覧、進捗出力を確認。
4. R2はオブジェクトのバージョニング/複製設定を確認し、教材ファイルの抜き取り復元を確認。
5. 所要時間と欠損範囲を記録（`tests/results/evidence/`）。本番切り戻しは「書込み停止 → バックアップ復元 → 差分調整」で行い、破壊的マイグレーションの逆実行はしない。
