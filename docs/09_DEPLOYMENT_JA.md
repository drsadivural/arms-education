# デプロイ・運用

1. staging/prodを別Workers・DB・R2・Queue・Authプロジェクトにする。日本向けDBリージョンは契約プランの実選択肢で確認する。Cloudflare利用だけで全データの国内保管を保証しない。
2. Supabase Auth非対称署名、invite-only、メールテンプレート日本語、SMTP、redirect allowlist、admin MFAを設定。API専用DB roleを作りapp schema以外への権限とBYPASSRLSを付けない。public Data APIからapp schemaを除外。
3. db/001_schema.sql→002_reservations.sql→003_supporting_workflows.sqlを一度clean staging DBに適用し、制約・RLS・複数組織・並行予約・復元を検証する。schema migration roleとruntime roleを分離。
4. Hyperdrive接続を作り予約・進捗整合読み取りのquery cachingを無効化。R2 private、CORSは必要originだけ、署名URL短期、検疫scannerと通知Queue/DLQを接続。
5. `templates/config-inputs.json` の本番値をWrangler/Secretsへ反映。OpenAIキー、Auth admin key、APNs private key、SMTP key、DB credentialをクライアントbundleへ出さない。VITE_接頭辞に秘密を置かない。
6. GitHub CIでtype/lint/build/test/security/DB/iOSを実行。保護branch・本番environmentにdeploy権限を限定、最小scope Cloudflare token。lockfile固定、未修正critical脆弱性を出荷しない。
7. Web assets/APIをCloudflare Workersへデプロイ、任意の所有ドメインへ紐付け。CSP、HSTS、no-store認証レスポンス、CORS/CSRF、rate limit、robots noindexを研修管理画面に適用。実ドメインが未提供のためayonixの既存サービスドメインを勝手に割り当てない。
8. iOS Bundle ID・Apple team・APNs key・provisioningを所有者アカウントで作成。PrivacyInfo.xcprivacyのRequired Reason API宣言は利用SDKの実使用から確認し、架空reason codeを書かない。マイク説明/アカウント削除窓口/プライバシーpolicy/利用規約/日本語screenshotsを登録。
9. App Store ConnectへTestFlight配布し実機UAT。受講者・講師の審査用アカウントはstaging限定・動作データ付き、架空秘密を文書で生成しない。enterprise配布/Custom Apps/公開App Storeの方式は顧客契約に合わせ確定。適用するApple最新要件を公式資料で確認する。
10. API error rate/latency、DB connection/slow query、pending expiry lag、outbox backlog/DLQ、教材scanner、Auth拒否、AI使用量を監視。ログはrequest IDで相関、秘密はredact。障害時runbookと当番を設定。
11. DB PITR/backupプランを確認、教材backupとversioning、目標RPO24時間/RTO4時間を初期設定して復元演習。バックアップ保持30日、監査365日を初期の組織方針として設定可能にし契約で確定。
12. 本番切替前に旧システムbackup→最終dry run→差分移行→件数照合→UAT→切替。rollbackではDB破壊migrationを逆実行せずbackup復元＋書込み停止＋差分調整を実施する。

## コスト
Cloudflare・DB/Auth・メール・ファイルスキャン・OpenAI音声・Apple Developer契約の合計。ユーザー数/教材GB/音声分/月/通知数からestimateを実測作成する。音声は15分/人/日既定上限、管理者が減額可能。固定の月額保証は行わない。
