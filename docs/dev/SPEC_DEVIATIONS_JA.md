# 仕様（ハンドオフ原本）との差分

AGENTS.md「仕様が衝突したらユーザーの明示指示を優先し差分を記録する」に基づく記録。ハンドオフ原本
（`docs/01〜10_*_JA.md`、`templates/`、`prompts/`、`contracts/openapi.json`、`db/001〜003`）は変更せず、差分をここに残す。

## 1. Supabase を使わず PostgreSQL と ARMS 自前の認証にする（ユーザー指示 2026-10-03）

**指示**: 「do not use supabase. Use PostgreSQL instead.」

**原本の前提**: `docs/02_ARCHITECTURE_JA.md`・`docs/09_DEPLOYMENT_JA.md`・`templates/config-inputs.json` は、DBとして
Supabase PostgreSQL、認証として Supabase Auth（招待メール、パスワード、管理者TOTP、iOSはSupabaseのJWT）を前提にしている。

**実装（差分）**

| 項目 | 原本 | 実装 |
|---|---|---|
| データベース | Supabase PostgreSQL | 任意の PostgreSQL（17で検証。15以上を推奨）。Workers からは Cloudflare Hyperdrive 経由。RLS・実行ロール（NOSUPERUSER NOBYPASSRLS）・マイグレーションは従来どおり `db/` |
| パスワード | Supabase Auth | `app.user_credentials` に scrypt（N=2^14, r=8, p=5、16バイトsalt、NFKC正規化）。連続10回失敗で15分ロック（429）。未登録アドレスも同じ計算量で同じ応答（列挙防止） |
| Webログイン | BFFがSupabaseのトークンを暗号化保持 | BFFは従来どおり HttpOnly Cookie＋CSRF。セッション行（`app.web_sessions`）がそのまま認証情報（プロバイダーのトークンは無い） |
| 管理者MFA | Supabase の TOTP factor | RFC 6238（SHA-1・6桁・30秒、±1ステップ、同じコードの再利用不可）。シークレットは AES-256-GCM（`WEB_SESSION_ENCRYPTION_KEY`、AAD=`totp:<user id>`）で保存。QRコードはAPIがSVGで生成。紛失時は別の管理者が「二段階認証をリセット」（`POST /settings/users/{id}/mfa-reset`） |
| iOSの認証 | supabase-swift で Supabase Auth に直接ログインし JWT を API に送る | `POST /auth/tokens` で不透明なアクセストークン（1時間）とリフレッシュトークン（毎回ローテーション、最終利用から30日・最長90日、再利用検知でセッション失効）。Keychain に保存。supabase-swift 依存を削除 |
| 招待・パスワード再設定メール | Supabase Auth の SMTP とメールテンプレート | APIが一回限りのリンク（招待24時間・再設定1時間、DBにはSHA-256のみ）を作成し、既存のメール送信サービス（Resend互換API）で日本語メールを送る。リンクは `/auth/callback#token=…&type=invite|recovery` |
| アカウント停止 | DBのmembership＋Supabaseのban | DBのmembershipのみ（全リクエストで検証）。停止時はその組織のWebセッションと、そのユーザーのiOSセッションを同じトランザクションで失効 |
| 必要な設定値 | `SUPABASE_URL` `SUPABASE_PUBLISHABLE_KEY` `SUPABASE_AUTH_ISSUER` `SUPABASE_AUTH_AUDIENCE` `SUPABASE_ADMIN_SECRET`（`templates/config-inputs.json`） | いずれも不要。代わりに PostgreSQL の接続先（Hyperdrive）と、招待・再設定に必須となるメール送信設定（`MAIL_PROVIDER_URL` `MAIL_PROVIDER_API_KEY` `MAIL_FROM`） |
| ローカル環境 | Supabase Auth（GoTrue）コンテナ | 削除。メールは Resend互換リレー（`infra/mail-relay`）→ Mailpit |

**契約（API）の変更**: `contracts/CHANGELOG_JA.md` の「00-core.json」「10-admin.json」に記録
（`POST /auth/tokens`・`/auth/tokens/refresh`・`/auth/tokens/revoke` の追加、`PasswordSetInput.access_token` → `token`、
`POST /settings/users/{id}/mfa-reset` の追加、アカウント停止応答から `provider_synced` を削除）。

**DB**: `db/100_auth.sql`（`app.user_credentials`・`app.auth_link_tokens`・`app.bearer_sessions`、`web_sessions` の列名変更と旧セッションの失効）。

**運用上の影響**
- Worker はログインごとに約170msのCPUを使う（scrypt）。Cloudflare Workers の有料プラン（CPU上限）が必要。
- メール送信サービスが未設定だと、招待・パスワード再設定はできない（`NOT_CONFIGURED`。招待は「送信失敗（再送可能）」として記録）。
- `WEB_SESSION_ENCRYPTION_KEY` を変更すると、保存済みのTOTPシークレットを復号できなくなる（全管理者の二段階認証リセットが必要）。手順は `docs/dev/OPERATIONS_JA.md`。
- Supabase で作成済みの利用者は存在しない（未デプロイ）ため、データ移行は不要。既存DBに適用した場合、旧Webセッションは失効し、利用者はパスワード再設定メールからパスワードを設定する。

**検証**: APIテスト（ログイン・ロック・MFA・トークンのローテーションと再利用検知・リンクの一回性と期限・招待saga・停止時の失効）、
Web E2E（招待メール→リンク→パスワード設定→ログイン、「パスワードをお忘れですか？」→再設定）、
iOS ARMSKit（`APIAuthService` の単体テストと、ローカルAPIに対するライブ契約試験）。
