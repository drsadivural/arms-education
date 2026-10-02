# ARMS — 新入社員研修システム

Web・iOS対応の企業向け新入社員教育・研修管理プラットフォーム。
ハンドオフ開発パッケージ（2026-10-02、`docs/HANDOFF_README_JA.md`）を実装したモノレポです。

| 構成要素 | 技術 | 場所 |
|---|---|---|
| Web管理画面（管理者・講師） | React 19 / TypeScript / Vite / Tailwind v4 / Radix / TanStack Query・Table | `apps/web` |
| API・BFF・定期処理・通知キュー | Cloudflare Workers / Hono / Zod / pg（Hyperdrive経由） | `services/api` |
| データベース | PostgreSQL（Hyperdrive経由）/ RLS / 予約トランザクション関数 | `db/` |
| 認証 | API自前（PostgreSQL）: 招待制・scryptパスワード・ログイン失敗ロック・管理者TOTP MFA・iOS用トークン・日本語の招待/再設定メール | `services/api/src/auth` |
| iOSアプリ（受講者・講師） | SwiftUI / ARMSKit（Swift Package）/ WebRTC / APNs | `apps/ios` |
| AI音声 | OpenAI Realtime（WebRTC・短期秘密）、サーバー側のツール実行・確認トークン | `services/api/src/domain/voice`, `apps/web/src/features/voice`, `apps/ios/ARMS/Voice` |
| 契約 | OpenAPI 3.1（原本 + 拡張）/ 共有Zodスキーマ / 日本語エラー | `contracts/`, `packages/contracts` |

## 実装範囲（要約）
- **Web（固定8メニュー）**: ダッシュボード、講師管理、新入社員管理、クラスルーム管理、教育プログラム管理（版・単元・教材・確認テスト・検疫アップロード）、
  社員教育進捗管理（旧画面の列・月移動・CSV/PDF出力・訂正履歴）、オンライン予約システム（申請一覧・承認/理由付き却下/削除・授業カレンダー・空き枠・出欠）、
  設定（システム設定・データ移植・ユーザー管理・ログ/イベント・個人設定）。ログイン（利用区分照合・管理者MFA・パスワード再設定）、招待リンクからのパスワード設定、お知らせ、AI音声（講師）。
- **iOS**: IOS-01〜18（受講者/講師ログイン、ホーム、進捗、予約申請・確認・取消、今日の授業、教材・テスト・課題、AI音声、お知らせ、出欠、担当授業の予約判断、設定）。
- **API**: 契約原本の全88操作＋拡張28操作（計116、変更記録は `contracts/CHANGELOG_JA.md`）。予約の定員・冪等・時間重複はDBで保証、全書込みに監査ログ、通知はoutbox→Queue→メール/APNs。
- **移行**: CSV（UTF-8/BOM/CP932）のマッピング・ドライラン・確定・取り消し（`docs/08`）。

## 最初に読む
- 要件・仕様: `docs/01〜10_*_JA.md`（原本）、開発規約: `docs/dev/CONVENTIONS.md`、エージェント規約: `AGENTS.md`
- デプロイ手順: `docs/09_DEPLOYMENT_JA.md` ＋ `docs/dev/DEPLOY_STEPS.md`、運用: `docs/dev/OPERATIONS_JA.md`
- 外部サービス等の未確定値・未検証範囲: `docs/BLOCKERS_JA.md`
- 受入条件の検証状況と証拠: `tests/results/evidence/ACCEPTANCE_STATUS_JA.md`（実行記録の一覧は `tests/results/README.md`）

## ローカル開発

前提: Node.js 22+、pnpm 11、Docker。

```bash
pnpm install
```

```bash
node infra/local/setup.mjs
```

```bash
docker compose -f infra/local/compose.yaml up -d
```

```bash
node infra/local/bootstrap.mjs admin@arms.local 'ローカル用の管理者パスワード1'
```

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

- Web: http://localhost:5188 （Viteが `/api` を wrangler dev :8787 へプロキシ）
- ローカルスタック: PostgreSQL :55433、PgBouncer :55434（Hyperdrive相当）、SeaweedFS（R2のS3互換API）:9100、
  ClamAV＋スキャンアダプター :9200（実マルウェア検査）、メールリレー :9025（Resend互換API）→ Mailpit :8025（送信メールの確認）
- `setup.mjs` はローカル専用の鍵（セッション暗号鍵、スキャナー鍵、メールリレー鍵など）を `infra/local/.env.local` と `services/api/.dev.vars` に生成します（Git管理外）。
- 認証は外部サービスを使わずAPIとPostgreSQLで行います（Supabaseは使用しない。`docs/dev/SPEC_DEVIATIONS_JA.md`）。
  招待・パスワード再設定のメールは Mailpit で確認でき、リンクからパスワードを設定します。
- 初回ログイン時、管理者は認証アプリ（TOTP）の登録を求められます。

## テスト・品質確認

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm build
```

```bash
cd apps/web && npx playwright test
```

- `pnpm test`: API 437件（実行ごとに新規DB、NOSUPERUSER/NOBYPASSRLSの実行ロール、全レスポンスをOpenAPIで検証。接続先は `TEST_DATABASE_ADMIN_URL`）、Web単体 113件、契約 45件。
- Playwright: 53件（ローカルスタックで実行。`E2E_ALL_BROWSERS=1` と `--project=firefox|webkit` で他エンジン。エンジンごとに別実行）。
- iOS: `cd apps/ios/ARMSKit && swift test`（183件）、ローカルAPIとのライブ契約試験 `apps/ios/ARMSKit/Scripts/live-contract-test.sh`。アプリ本体はmacOS CI（`.github/workflows/ios.yml`、Xcode・iOS Simulatorでビルドとテスト）。詳細は `apps/ios/README.md`。
- 負荷・並行: `node tests/load/reservations.mjs 100`。秘密スキャン: `pnpm secrets:scan`。ハンドオフ原本の検証: `pnpm check:package`。

## デプロイ
`docs/09_DEPLOYMENT_JA.md` と `docs/dev/DEPLOY_STEPS.md` に従い、`services/api/wrangler.jsonc` の staging / production 環境へ
`pnpm --filter @arms/api deploy:staging` 等でデプロイします。Hyperdrive ID・R2・Queue・Secrets・スキャンサービス・Apple署名は環境ごとの準備が必要です（`docs/BLOCKERS_JA.md`）。
