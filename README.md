# ARMS — 新入社員研修システム

Web・iOS対応の企業向け新入社員教育・研修管理プラットフォーム。
ハンドオフ開発パッケージ（2026-10-02、`docs/HANDOFF_README_JA.md`）を実装したモノレポです。

| 構成要素 | 技術 | 場所 |
|---|---|---|
| Web管理画面（管理者・講師） | React 19 / TypeScript / Vite / Tailwind v4 / Radix / TanStack Query・Table | `apps/web` |
| API・BFF・定期処理・通知キュー | Cloudflare Workers / Hono / Zod / pg（Hyperdrive経由） | `services/api` |
| データベース | PostgreSQL（Supabase）/ RLS / 予約トランザクション関数 | `db/` |
| 認証 | Supabase Auth（招待制、管理者TOTP MFA、非対称JWT） | `services/api/src/auth` |
| iOSアプリ（受講者・講師） | SwiftUI / ARMSKit（Swift Package）/ WebRTC / APNs | `apps/ios` |
| 契約 | OpenAPI 3.1（原本 + 拡張）/ 共有Zodスキーマ / 日本語エラー | `contracts/`, `packages/contracts` |

## 最初に読む
- 要件・仕様: `docs/01〜10_*_JA.md`（原本）、開発規約: `docs/dev/CONVENTIONS.md`、エージェント規約: `AGENTS.md`
- API契約の変更記録: `contracts/CHANGELOG_JA.md`
- 外部サービス等の未確定値・未検証範囲: `docs/BLOCKERS_JA.md`
- 検証結果の記録: `tests/results/README.md`

## ローカル開発

前提: Node.js 22+、pnpm 11、Docker。

```bash
pnpm install
node infra/local/setup.mjs
```

```bash
docker compose -f infra/local/compose.yaml up -d
```

```bash
node infra/local/bootstrap.mjs admin@arms.local 'ローカル用の管理者パスワード'
```

```bash
pnpm dev:api
```

```bash
pnpm dev:web
```

- Web: http://localhost:5188 （Viteが `/api` を Wrangler dev :8787 へプロキシ）
- Supabase Auth（GoTrue）: http://localhost:9999 、送信メールの確認（Mailpit）: http://localhost:8025
- MinIO（R2のS3互換API代替）: http://localhost:9101
- `setup.mjs` はローカル専用の鍵（GoTrue ES256署名鍵、セッション暗号鍵など）を `infra/local/.env.local` と `services/api/.dev.vars` に生成します。これらはGit管理外です。

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

- APIテストは実行ごとに新しいPostgreSQLデータベースを作成し、本番と同じ **NOSUPERUSER / NOBYPASSRLS** の実行ロールで、全レスポンスをOpenAPI契約と照合します（`TEST_DATABASE_ADMIN_URL` で接続先を変更可能）。
- `pnpm check:package` はハンドオフ原本の契約・SQL検証（PGlite）を再実行します。
- iOS: `apps/ios/README.md` を参照（ARMSKitはLinux/macOSで `swift test`、アプリ本体はmacOS CIでビルド）。

## デプロイ
`docs/09_DEPLOYMENT_JA.md` の手順に従い、`services/api/wrangler.jsonc` の staging / production 環境へ `pnpm --filter @arms/api deploy:staging` 等でデプロイします。Hyperdrive ID・R2・Queue・Secrets は環境ごとに作成・登録が必要です（`docs/BLOCKERS_JA.md`）。
