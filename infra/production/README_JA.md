# ARMS 本番環境（arms.ayonix.com）

ユーザー指定（2026-10-03）の構成: Web・API は Cloudflare Workers（`arms-production`、カスタムドメイン `arms.ayonix.com`）、
データベースとマルウェア検査は ARMS ホスト（Tencent Cloud VM・シンガポール）上で動かし、Cloudflare Tunnel 経由でのみ到達させる。

```
ブラウザ / iOS ─▶ Cloudflare（arms.ayonix.com: Worker arms-production）
                     ├─ Hyperdrive「arms-production」─▶ Workers VPC「arms-production-db」─▶ Tunnel「arms-production」─▶ PostgreSQL 127.0.0.1:55532
                     ├─ https://arms-scan.ayonix.com ─▶ Tunnel ─▶ スキャナー 127.0.0.1:9201 ─▶ ClamAV
                     ├─ R2 arms-materials-production（教材・課題・出力。CORS: arms.ayonix.com）
                     └─ Resend（招待・パスワード再設定・通知メール）
```

## 構成要素（ホスト上）
| 項目 | 場所 |
|---|---|
| Docker Compose（project `arms-prod`: postgres / clamav / scanner） | `/opt/arms-production/compose.yaml`（原本 `infra/production/compose.yaml`） |
| 秘密（PostgreSQL・実行ロール `arms_app`・スキャナー鍵） | `/opt/arms-production/.env`（600、Git管理外） |
| PostgreSQL のTLS証明書 | `/opt/arms-production/pg-tls/`（Let's Encrypt `arms-db.ayonix.com`。更新は certbot の deploy hook `pg-cert-deploy.sh`） |
| Tunnel | `/etc/cloudflared/arms-production.yml`・`.json`、systemd `cloudflared-arms-production.service` |
| バックアップ | 毎日 03:30 JST `backup.sh`（cron, ubuntu）→ R2 `arms-backups-production/db/`（30日で自動削除）、ローカル7日 |

Cloudflare 側: Worker `arms-production`、Hyperdrive `arms-production`（`b25480f13d16428cbad8fee3af1a7e76`、キャッシュ無効）、Workers VPC サービス `arms-production-db`（TCP 127.0.0.1:55532）
（`01a0fef6-cb6e-7340-9a2b-23a5bd11d494`）、Tunnel `arms-production`（`acb306ce-3f90-44ee-a2be-79a96dd35190`）、
R2 `arms-materials-production`（CORS `infra/cloudflare/r2-cors.production.json`、PDFフォント配置済み）・`arms-backups-production`、
Queue `arms-notifications-production`(+`-dlq`)、Secrets `WEB_SESSION_ENCRYPTION_KEY` `DEVICE_TOKEN_ENCRYPTION_KEY` `MALWARE_SCAN_API_KEY`。

## 残りの作業（2026-10-03 時点）
1. ~~PostgreSQL の公開CA証明書~~ **完了**（2026-10-03。Hyperdrive 接続・`/api/v1/health` の `database: ok` を確認）。
   Hyperdrive は Workers VPC 経由でも DB の証明書を公開CAで検証する（自己署名・独自CAは不可）ため、Let's Encrypt の
   `arms-db.ayonix.com` 証明書を PostgreSQL に使う。新しいホストで構築し直す場合の手順:
   ```bash
   sudo install -m 755 -o root -g root infra/production/pg-cert-deploy.sh /opt/arms-production/pg-cert-deploy.sh
   sudo certbot certonly --standalone --preferred-challenges http --http-01-port 8089 -d arms-db.ayonix.com --non-interactive --agree-tos --register-unsafely-without-email --deploy-hook /opt/arms-production/pg-cert-deploy.sh
   echo "127.0.0.1 arms-db.ayonix.com" | sudo tee -a /etc/hosts
   ```
   `arms-db.ayonix.com` は Tunnel 上で ACME の検証パス（`/.well-known/acme-challenge/`）だけを公開し、DB自体は公開しない。
   その後: `wrangler hyperdrive create arms-production --service-id <VPCサービスID> --database arms --user arms_app --password … --caching-disabled`
   → `services/api/wrangler.jsonc` の production の `hyperdrive` を新しいIDにする → デプロイ。
2. **Resend**: アカウント作成 → ドメイン `ayonix.com` を追加し、表示されるDNSレコード（TXT/MX）を Cloudflare に追加 → APIキー作成 →
   `npx wrangler secret put MAIL_PROVIDER_API_KEY --env production`（`services/api` で実行）。送信元は `noreply@ayonix.com`（`MAIL_FROM`）。
3. **R2 の S3 APIキー**: Cloudflare ダッシュボード → R2 → 「Manage API tokens」→ Object Read & Write（対象 `arms-materials-production` のみ）→
   `npx wrangler secret put R2_ACCESS_KEY_ID --env production` と `R2_SECRET_ACCESS_KEY`。
4. （AI音声を使う場合）`npx wrangler secret put OPENAI_API_KEY --env production`。
5. **デプロイ**（リポジトリ直下）: `pnpm build` → `pnpm --filter @arms/api deploy:production`。確認: `https://arms.ayonix.com/api/v1/health` が 200（`database: ok`）。
6. **初期管理者**: `sadi@ayonix.com`（組織「H&A研修センター」）作成済み。メール設定後、ログイン画面「パスワードをお忘れですか？」→ メールのリンクでパスワード設定 →
   認証アプリ（TOTP）登録。

## デモアカウント（2026-10-03 作成、`scripts/admin/seed-demo.mjs`）
組織「H&A研修センター」に、講師 `sadi+teacher@ayonix.com`（デモ 講師）・受講者 `sadi+student@ayonix.com`（デモ 受講者）、
【デモ】クラス・【デモ】教育プログラム（リンク・確認テスト・課題）・授業枠3件を作成。管理者 `sadi@ayonix.com` と同じ初期パスワードを設定
（パスワードはリポジトリに記録しない。本番運用前に各自パスワード再設定で変更すること）。不要になったら「ユーザー管理」で停止する。
iOS は講師・受講者のみログインできる（管理者は Web）。

## 運用
- 状態確認: `cd /opt/arms-production && docker compose ps`、`systemctl status cloudflared-arms-production`、`curl https://arms-scan.ayonix.com/health`。
- 再起動: `docker compose restart <service>`（データは名前付きボリューム `arms-prod_arms-prod-pg` に保持）。
- マイグレーション（新しい `db/*.sql` を含むリリース時、デプロイ前に）:
  `set -a; . /opt/arms-production/.env; set +a; DATABASE_ADMIN_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:55532/arms?sslmode=no-verify" RUNTIME_DB_ROLE=arms_app node scripts/db/migrate.mjs`
- 復元演習（毎月）: R2 からダンプを取得し、別DBへ `pg_restore` して件数を確認（本番へ直接戻さない）:
  `npx wrangler r2 object get arms-backups-production/db/<file>.dump --file /tmp/r.dump --remote` →
  `docker compose exec -T postgres createdb -U postgres arms_restore_check` → `docker compose exec -T postgres pg_restore -U postgres -d arms_restore_check < /tmp/r.dump`。
- 証明書: certbot の systemd タイマーが自動更新し、deploy hook が PostgreSQL に再読み込みさせる。
- 制約: 単一ホスト構成（冗長化なし）。ホスト障害時は R2 のバックアップから別ホストへ復元する（RPO 24時間）。
