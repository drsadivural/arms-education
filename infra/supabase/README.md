# Supabase Auth 設定（本番・ステージング）

- **メールテンプレート**: Dashboard > Authentication > Email Templates に `templates/invite.html`（Invite user）と
  `templates/recovery.html`（Reset password）を貼り付ける。件名: 「ARMSへの招待」「ARMSパスワード再設定のご案内」。
- **Redirect URLs**: `https://<APP_ORIGIN>/auth/callback` を許可リストに追加（`AUTH_REDIRECT_URL`）。
- **Sign-ups**: 無効（招待制）。**MFA**: TOTP を有効化。**JWT**: 非対称署名鍵（ES256）へ移行し、旧HS256はverify専用で段階的に失効。
- **SMTP**: 自社の送信ドメインのSMTPを設定（SPF/DKIM/DMARC）。メール送信のレート制限は運用規模に合わせて設定。
- ローカル開発では `infra/local/compose.yaml` のGoTrueが同じテンプレートを内部のテンプレートサーバーから読み込む。
