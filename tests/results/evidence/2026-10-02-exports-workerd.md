# 進捗出力（CSV/PDF）のWorkersランタイム実行確認 — 2026-10-02

- 環境: wrangler dev（workerd）→ PgBouncer → PostgreSQL 17、R2の代替としてMinIO（S3互換・署名URL）、Supabase Auth（GoTrue）。
- 手順: E2E組織の管理者でログイン（パスワード＋TOTP二段階認証）→ 2019年の旧形式教育記録を `POST /progress-records` で登録 →
  `POST /exports/progress`（format=pdf / csv, month=2019-08）→ 返却された5分間の署名URLからダウンロード。
- 結果:
  - PDF: `%PDF-1.7`、1ページ、pdfjsでの文字抽出結果に「社員教育進捗管理」「2019年8月」「2019年8月31日（土）」「和田 一夫」「開発部」「田中 祥司」「技術知識習得・プログラム言語習得」「期限超過（受講中）」「未設定」を確認（日本語フォントのサブセット埋め込みが workerd 上で動作）。フォントは `system/fonts/NotoSansJP-Regular-CP932.ttf` をストレージから読み込み。
  - CSV: 見出し「終了予定日,社員名,教育担当部署,教育担当者,内容,状態,期限超過,進捗率(%),社員番号,クラス,備考」、終了予定日 `2019-08-31` を原本のまま保持、全セル引用符付き・CRLF。
- 未確認: 本番R2バインディング経路（ローカルはS3 API経由）。

# 招待メールの一連の流れ（ローカル）— 2026-10-03
- GoTrue `POST /invite`（redirect_to=/auth/callback）→ Mailpitに件名「ARMSへの招待」、本文は日本語テンプレート（`infra/supabase/templates/invite.html`）
  →メール内リンク `…/verify?type=invite` → `302 Location: http://localhost:5188/auth/callback#access_token=…&type=invite`
  → Web `/auth/callback` で `POST /api/v1/auth/password`（E2E `auth-callback.spec.ts` で設定・再ログインを確認）。
- 以前のローカルE2Eで招待が「送信失敗」になったのはGoTrueのメール送信レート制限（429）によるもの。アプリは「送信失敗（再送可能）」と正しく表示。ローカルのみ上限を緩和。
