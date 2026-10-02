# 予約の負荷・並行試験（ローカル）— 2026-10-02

- コマンド: `node tests/load/reservations.mjs 100`（Git SHA は JSON の `git_sha`）
- 環境: Linux 4 vCPU（他の開発プロセスと共有）、wrangler dev（workerd 単一プロセス）→ PgBouncer（transaction mode、Hyperdrive相当）→ PostgreSQL 17、Supabase Auth（GoTrue）でのBearer認証。API実行ロールは NOSUPERUSER/NOBYPASSRLS。
- 結果ファイル: `2026-10-02-load-reservations-local.json`

| 項目 | 結果 | 目標 | 判定 |
|---|---|---|---|
| 残席1に100人が同時申請 | 成功1件・`SLOT_FULL` 99件・DB上の有効予約1件・エラー0 | 成功1・超過0 | 合格 |
| 100人同時の申請（席に余裕あり） | 100件すべて201 | 全件成功 | 合格 |
| 承認（逐次30件） | p50 38ms / p95 50ms | p95 ≤ 1s | 合格 |
| 認証付き読み取り（逐次、単一クライアント） | p50 15–17ms / p95 18–21ms（`/me`, `/lesson-slots`, `/reservations`） | p95 ≤ 500ms | 合格（ローカル） |
| 100人が2秒以内に開始し各5回読み取り（500件） | p50 653ms / p95 865ms、エラー0 | p95 ≤ 500ms | ローカル単一プロセスでは未達。本番相当（同一リージョンのstaging、複数isolate＋Hyperdrive）で要再測定 |
| 100件同時バースト申請 | p50 1.6s / p95 2.5s | p95 ≤ 1s | 同上（単一workerdプロセスのCPU飽和。1件あたりの処理時間は数十ms） |

補足: PgBouncerなしでは wrangler dev がリクエストごとに直接DB接続を開くため、PostgreSQLの `max_connections=100` を超えて `DB_UNAVAILABLE`（503、「変更は保存されていません」）が返った。誤った成功表示はなかった。本番はHyperdriveが接続をプールする。
