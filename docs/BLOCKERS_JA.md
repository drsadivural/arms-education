# 外部値・外部検証のブロッカー

実装はローカル環境（PostgreSQL 17、Supabase Auth＝GoTrue v2.180、MinIO、Mailpit、wrangler dev／workerd）で
動作確認している。以下は顧客・運用側の値や契約、実機が必要なため **未接続・未検証** の項目。
不足値を架空値で埋めて「接続成功」とはしていない（該当機能は `NOT_CONFIGURED` 応答または公開停止になる）。

## 1. デプロイ先の値（`templates/config-inputs.json`）
| 項目 | 保管先 | 影響 | 現状 |
|---|---|---|---|
| Cloudflareアカウント・APIトークン（最小権限） | GitHub Environment Secrets | staging/本番デプロイ | 未提供。`wrangler.jsonc` の staging/production は Hyperdrive ID が `REPLACE_WITH_*` のため、意図的にデプロイ不可。 |
| Hyperdrive（キャッシュ無効） `wrangler hyperdrive create … --caching-disabled` | wrangler.jsonc | API全体 | 未作成 |
| R2バケット（private）・S3互換アクセスキー（`R2_S3_ENDPOINT` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY`） | Workers vars / Secrets | 教材アップロード・ダウンロード（署名URL） | 未作成。ローカルはMinIOで検証 |
| Queue `arms-notifications-*` と DLQ | wrangler.jsonc | 通知の即時配送（未設定でも1分ごとのcronで配送） | 未作成 |
| 本番ドメイン・`APP_ORIGIN` | Workers vars | CSRF/Origin検証・招待メールのリンク | 未提供。既存ayonixドメインは割り当てていない |

## 2. Supabase（Auth / PostgreSQL）
| 項目 | 影響 | 現状 |
|---|---|---|
| プロジェクト（東京リージョン等、契約プランで確認） | 全機能 | 未作成 |
| 非対称JWT署名鍵（ES256）への移行、`SUPABASE_AUTH_ISSUER`/`AUDIENCE` | APIのJWT検証（HS256は拒否する設計） | ローカルGoTrueで同構成を検証済み |
| 招待制（signup無効）、日本語メールテンプレート、SMTP、Redirect URL許可リスト、TOTP MFA有効化 | 招待・パスワード再設定・管理者MFA | ローカル（Mailpit）で検証済み、本番SMTP未提供 |
| `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_ADMIN_SECRET`（sb_secret_） | ログイン・招待 | 未提供 |
| マイグレーション用ロールと実行ロール `arms_app`（NOSUPERUSER NOBYPASSRLS）、`db/grants.sql` 適用、Data API公開スキーマから `app` を除外 | DB境界 | 手順は `scripts/db/migrate.mjs`。本番未適用 |
| PITR／バックアップ・復元演習（RPO 24h / RTO 4h） | 障害復旧 | 未実施 |

## 3. その他の外部サービス
| 項目 | 影響 | 現状 |
|---|---|---|
| OpenAI APIキー（Realtime利用可否、`gpt-realtime-2.1`、voice `marin`） | AI音声 | 未提供。実通信・日本語聴感・割込み・料金は未検証 |
| マルウェアスキャンサービス（`MALWARE_SCAN_URL`/`_API_KEY`） | 教材ファイルの公開（未接続の間は公開停止） | 未提供 |
| 通知メール送信サービス（`MAIL_PROVIDER_URL`/`_API_KEY`/`MAIL_FROM`、送信ドメイン認証） | 予約通知メール（アプリ内通知は常に作成） | 未提供 |
| Apple Developer Team・Bundle ID・APNs鍵（p8）・署名・配布方式 | iOSビルド署名・TestFlight・プッシュ通知 | 未提供 |

## 4. 実機・実環境でのみ検証可能な項目（未検証）
- iOSアプリ本体のビルド・テスト（macOS/Xcodeが必要。Linuxでは `ARMSKit` のみ `swift test` 済み）、実機でのマイク・WebRTC音声・AirPods・電話割込み・Dynamic Type・VoiceOver。
- APNs（WorkersからのHTTP/2送信を含む）とプッシュからのディープリンク。
- 本番相当環境での負荷（API p95、予約変更p95、同時100利用）。ローカルの並行試験結果は `tests/results/` を参照。
- 既存システムの実CSV/Excelエクスポートによる移行リハーサル（提供された画像のみからは移行しない）。

## 5. 顧客の最終決定が必要な業務ルール
予約締切・取消期限・承認保持期限の既定値、進捗の完了判定（テスト合格点の既定、再受験ポリシー）、
監査ログ・バックアップの保持期間、音声の日次上限。いずれも設定画面または組織設定で変更可能な初期値で実装している。
