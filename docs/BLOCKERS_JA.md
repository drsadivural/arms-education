# 外部値・外部検証のブロッカー

実装はローカル環境（PostgreSQL 17、PgBouncer、S3互換ストレージ（SeaweedFS。MinIOの公開イメージ配布終了により2026-10-03に置換）、ClamAV、
メールリレー＋Mailpit、wrangler dev／workerd）で
動作確認している（検証状況は `tests/results/evidence/ACCEPTANCE_STATUS_JA.md`）。以下は顧客・運用側の値や契約、実機が必要なため **未接続・未検証** の項目。
不足値を架空値で埋めて「接続成功」とはしていない（該当機能は `NOT_CONFIGURED` 応答または公開停止になる）。

認証は Supabase を使わず API と PostgreSQL で行う（ユーザー指示 2026-10-03、`docs/dev/SPEC_DEVIATIONS_JA.md`）。
`templates/config-inputs.json` の `SUPABASE_*` は不要。

## 1. デプロイ先の値（`templates/config-inputs.json`）
| 項目 | 保管先 | 影響 | 現状 |
|---|---|---|---|
| Cloudflareアカウント・APIトークン（最小権限） | GitHub Environment Secrets | staging/本番デプロイ | アカウント「Ayonix official account」（ayonix.comゾーン）を使用。CI用の最小権限トークンは未提供。staging は Hyperdrive ID が `REPLACE_WITH_*` のため意図的にデプロイ不可。 |
| Hyperdrive（キャッシュ無効） `wrangler hyperdrive create … --caching-disabled` | wrangler.jsonc | API全体 | 未作成（接続先のPostgreSQLが未提供）。production は作成後に `hyperdrive` バインディングを追加する（`wrangler.jsonc` のコメント参照）。それまでAPIは503 `NOT_CONFIGURED`、定期処理はスキップ |
| R2バケット（private）・S3互換アクセスキー（`R2_S3_ENDPOINT` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY`）・バケットCORS（APP_ORIGINからのPUT/GET） | Workers vars / Secrets | 教材・課題・移行ファイルのアップロード、出力ファイルのダウンロード（署名URL） | `arms-materials-production` 作成・CORS・PDFフォント配置済み、エンドポイント設定済み。**S3 APIキー（ダッシュボードで作成）が未了**。ローカルはS3互換ストレージ（SeaweedFS、置換前はMinIO）で検証。PDF出力用フォントの配置が必要（`docs/dev/DEPLOY_STEPS.md`） |
| Queue `arms-notifications-*` と DLQ | wrangler.jsonc | 通知の即時配送（未設定でも1分ごとのcronで配送） | 未作成 |
| 本番ドメイン・`APP_ORIGIN` | wrangler.jsonc（production） | CSRF/Origin検証・招待メールのリンク | `https://arms.ayonix.com`（Workers Custom Domain、ユーザー指定 2026-10-03）。設定済み・**初回デプロイはユーザー実行待ち**（`docs/dev/DEPLOY_STEPS.md` の「arms.ayonix.com の初回公開」） |

## 2. PostgreSQL（データベース・認証情報）
| 項目 | 影響 | 現状 |
|---|---|---|
| PostgreSQL 15以上のホスト | 全機能（ログインを含む） | ユーザー指定（2026-10-03）により ARMS ホスト上の PostgreSQL 17 を Cloudflare Tunnel＋Workers VPC 経由で使用（`infra/production/README_JA.md`）。DB・ロール・マイグレーション・初期管理者・バックアップ・Hyperdrive 接続まで完了（2026-10-03、本番 `/api/v1/health` が `database: ok`） |
| マイグレーション用ロールと実行ロール `arms_app`（NOSUPERUSER NOBYPASSRLS）、`db/grants.sql` 適用 | DB境界 | 手順は `scripts/db/migrate.mjs`。本番未適用 |
| 初期管理者 | 最初のログイン | `sadi@ayonix.com`（組織「H&A研修センター」）を本番DBに作成済み。メール設定後に「パスワードをお忘れですか？」でパスワード設定 |
| バックアップ・復元演習（RPO 24h / RTO 4h） | 障害復旧 | 毎日03:30 JSTに R2 `arms-backups-production` へ pg_dump（30日保持、初回取得を確認済み）。復元演習は未実施 |
| Cloudflare Workers 有料プラン（ログイン1回あたり約170msのCPU: scrypt） | ログイン・パスワード設定 | アカウントのプラン未確認 |

## 3. その他の外部サービス
| 項目 | 影響 | 現状 |
|---|---|---|
| OpenAI APIキー（Realtime利用可否、`gpt-realtime-2.1`、voice `marin`） | AI音声 | 未提供。実通信・日本語聴感・割込み・料金は未検証 |
| マルウェアスキャンサービス（`MALWARE_SCAN_URL`/`_API_KEY`） | 教材ファイルの公開・課題ファイル・CSV移行 | ARMS ホスト上の ClamAV＋アダプターを `https://arms-scan.ayonix.com`（Tunnel・Bearer鍵）で稼働・設定済み |
| メール送信サービス（Resend互換API: `MAIL_PROVIDER_URL`/`_API_KEY`/`MAIL_FROM`、送信ドメイン認証） | **招待・パスワード再設定（必須）**、予約通知メール（アプリ内通知は常に作成） | Resend に決定（URL・送信元は設定済み）。**APIキーとドメイン認証（DNS）が未了**。未設定の間は招待が「送信失敗（再送可能）」、再設定は503 `NOT_CONFIGURED`。ローカルはリレー（`infra/mail-relay`）→ Mailpit で検証済み |
| Apple Developer Team・Bundle ID・APNs鍵（p8）・署名・配布方式 | iOSビルド署名・TestFlight・プッシュ通知 | 未提供 |

## 4. 実機・実環境でのみ検証可能な項目（未検証）
- iOSアプリ本体（SwiftUI）: macOS CI（`.github/workflows/ios.yml`、Xcode 16.4）でビルドとSimulator上のアプリ単体テスト8件・ARMSKit 183件が合格済み（2026-10-03、Supabase廃止後）。未検証なのは archive署名・TestFlight と、実機でのマイク・WebRTC音声・AirPods・電話割込み・Dynamic Type・VoiceOver、ファイル選択・アップロード。
- APNs（WorkersからのHTTP/2送信を含む）とプッシュからのディープリンク。
- 本番相当環境での負荷（API p95、予約変更p95、同時100利用）。ローカルの並行試験結果は `tests/results/` を参照。
- 既存システムの実CSV/Excelエクスポートによる移行リハーサル（提供された画像のみからは移行しない）。

## 5. 顧客の最終決定が必要な業務ルール
予約締切・取消期限・承認保持期限の既定値、進捗の完了判定（テスト合格点の既定、再受験ポリシー）、
監査ログ・バックアップの保持期間、音声の日次上限。いずれも設定画面または組織設定で変更可能な初期値で実装している。
