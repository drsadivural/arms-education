# デプロイ手順（実装固有の補足）

`docs/09_DEPLOYMENT_JA.md` の手順に加え、この実装で必要な作業。値は `templates/config-inputs.json` と
`docs/BLOCKERS_JA.md` を参照し、Secretは `wrangler secret put <NAME> --env <staging|production>` で登録する。

1. **DB**: マイグレーション用ロールで `DATABASE_ADMIN_URL=… RUNTIME_DB_ROLE=arms_app node scripts/db/migrate.mjs`。
   実行ロールは `CREATE ROLE arms_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`。
   Supabaseの「Exposed schemas」に `app` を含めない。
2. **Hyperdrive**: `wrangler hyperdrive create arms-<env> --connection-string="postgres://arms_app:…@<host>:5432/postgres" --caching-disabled`
   → `services/api/wrangler.jsonc` の該当環境の `id` を置換。
3. **R2**: `wrangler r2 bucket create arms-materials-<env>`、S3互換APIトークン（対象バケットのObject Read & Write）を作成し
   `R2_S3_ENDPOINT`（`https://<account>.r2.cloudflarestorage.com`）/`R2_BUCKET_NAME`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` を設定。
   バケットCORSで `APP_ORIGIN` からの `PUT`（`Content-Type` ヘッダー）と `GET` を許可する。
4. **PDF出力用フォント**（日本語PDFに必須。未配置ならPDF出力は `PDF_FONT_UNAVAILABLE` で失敗する）:
   `wrangler r2 object put arms-materials-<env>/system/fonts/NotoSansJP-Regular-CP932.ttf --file services/api/assets/fonts/NotoSansJP-Regular-CP932.ttf --content-type font/ttf --remote`
5. **Queue**: `wrangler queues create arms-notifications-<env>` と `…-dlq`。
6. **Secrets**: `SUPABASE_ADMIN_SECRET`, `WEB_SESSION_ENCRYPTION_KEY`（32バイトbase64）, `DEVICE_TOKEN_ENCRYPTION_KEY`（32バイトbase64）,
   `OPENAI_API_KEY`, `MAIL_PROVIDER_API_KEY`, `MALWARE_SCAN_API_KEY`, `APNS_PRIVATE_KEY`, `R2_SECRET_ACCESS_KEY`。
   Vars: `APP_ORIGIN`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_AUTH_ISSUER`, `SUPABASE_AUTH_AUDIENCE`, `MAIL_PROVIDER_URL`,
   `MAIL_FROM`, `MALWARE_SCAN_URL`, `APNS_TEAM_ID`, `APNS_KEY_ID`, `IOS_BUNDLE_ID`, `R2_*`。
7. **スキャナーのコールバック**: スキャンサービスに `POST https://<APP_ORIGIN>/api/v1/uploads/{id}/scan-result?org=<org>` を
   `X-ARMS-Scan-Timestamp` と `X-ARMS-Scan-Signature: v1=hex(HMAC-SHA256(MALWARE_SCAN_API_KEY, ts + "." + body))` 付きで呼ばせる
   （コールバックが使えない場合も1分ごとのポーリングで判定を取得する）。
8. **ビルドとデプロイ**: `pnpm build` → `pnpm --filter @arms/api deploy:staging`。ステージングで受入（docs/07）後に production。
9. **初期管理者**: Supabase Authで招待 → `app.users`/`app.memberships(role=admin)` を作成（`infra/local/bootstrap.mjs` の処理を参照）。
   初回ログイン時に管理者MFA（TOTP）登録が求められる。
