# ARMS — 新入社員研修システム 開発パッケージ

日本語Web管理アプリと、日本語iOS受講者・講師アプリを開発するための仕様・デザイン・契約・実装指示書。添付H&Aロゴをそのまま使用。作成日 2026-10-02。

## 最初に読む
1. `START_HERE_JA.md` — 開発開始手順と納品境界。
2. `docs/01_REQUIREMENTS_JA.md` — 要件・権限・業務ルール。
3. `docs/02_ARCHITECTURE_JA.md` — 技術構成とセキュリティ。
4. `docs/03_SCREEN_SPEC_JA.md` — 全画面・操作・入力検証。
5. `docs/04_RESERVATION_PROGRESS_JA.md` — 予約と進捗の正規ルール。
6. `docs/05_OPENAI_VOICE_JA.md` — 日本語音声・ツール実行・確認。
7. `docs/06_IMPLEMENTATION_PLAN_JA.md` — 順番・依存関係・完了条件。
8. `docs/07_ACCEPTANCE_JA.md` — Web/iOS横断テスト。
9. `docs/08_MIGRATION_JA.md` — 既存画面の項目対応と移行。
10. `docs/09_DEPLOYMENT_JA.md` — Cloudflare・DB・TestFlight・運用。

## 提供物
`design/web/` と `design/ios/` は各画面PNG。`prototype/index.html` は画面切替・テーマ切替ができるローカルデザイン見本。実際の予約・認証・音声・教材処理は実装対象であり、デザイン見本に業務バックエンドは含まれない。画面の氏名・人数・日程・成績は架空のサンプル。

`contracts/openapi.json` は全APIの契約。`contracts/voice-tools.json` は音声ツール定義。`db/001_schema.sql` はPostgreSQL初期スキーマ。`db/002_reservations.sql` は予約作成・判断・取消・削除のトランザクション関数。`templates/` は環境入力仕様。`migration/` は日本語CSV入力見本。`AGENTS.md` と `CLAUDE.md` は開発エージェントへの指示。`docs/skills/` は機能別実装ガイド。

## 開発後のリポジトリ構成
```text
apps/web/src/{pages,components,features,lib}
apps/ios/ARMS/{App,Features,Networking,Voice,DesignSystem,Resources}
services/api/src/{routes,auth,domain,repositories,voice,notifications}
packages/contracts/src
packages/ui/src
db/
infra/cloudflare/
tests/{unit,integration,e2e,security,load}
docs/
.github/workflows/
```

本パッケージは完成アプリやApp Store提出済みバイナリではなく、実装を開始するための開発用納品物。サービス契約・本番値・Apple署名・実機音声検証は開発工程で実施する。検証済みの範囲は `verification/REPORT_JA.md` を参照。

## この開発パッケージの再検証
以下は納品物の契約・SQL・画面見本の検証ツールです。業務アプリの起動コマンドではありません。
```bash
npm ci
npm run check
npx playwright install chromium
npm run mockups
```

READMEに記載した実アプリの構成と工程は開発開始プロンプトで生成します。npm run checkの成功は、iOSビルドやOpenAIの実通信を検証したという意味ではありません。
