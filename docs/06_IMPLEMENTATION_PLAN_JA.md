# 実装計画

1. 要件: 全画面とAPI/SQLを読み、traceability.csvの項目をタスク化。外部サービス・本番値はconfig-inputsで確認。工程見積は2名で8〜12週間を初期仮定、Apple審査と顧客のデータ清掃は別。
2. 基盤: pnpm workspace、React/Vite、Hono/Workers、SwiftUI、typed OpenAPI client、PostgreSQL migration、lockfiles、共通日本語messages、UI tokens、認証・組織権限・ログ。Web/admin/teacher/studentのAPI access拒否テストが通るまで先へ進めない。
3. 管理機能: 講師招待/編集/停止、受講者招待/クラス/講師選択、クラス定員・人数集計。FK/RLS/並行追加制約と一覧の空/検索/エラーを検証。
4. 教材: バージョン付きプログラム、単元、PDF/動画/テスト/課題、private R2、実マルウェア検査、公開、受講割当、進捗算出・履歴・講師評価。
5. 予約: 授業枠、クラス/講師時間制約、pending席保持、承認/却下/取消/soft delete、期限切れworker、outbox、Web承認画面。重複/残席1並行テストとiOS契約テストを先に通す。
6. iOS: Student/Teacher login、ホーム、今日の授業、教材、進捗、予約・申請・状態、講師担当者詳細と出欠/評価、通知、設定。Keychain、深いリンク、前景再取得、オフライン、Dynamic Type。
7. 音声: session発行、WebRTC、transcript、tools、prepare/commit action token、quota、接続終了。日本語実機試験、二重実行、権限偽装、旧action token再送を検証。
8. データ移行: CP932/UTF-8 BOM CSV、マッピング、dry run、重複/日付/講師/クラスのエラー明細、確認、バックアップ、commit、rollback。原本の終了予定日等を保持。
9. 総合検証: 全ブラウザ/端末/テーマ/権限、負荷、秘密漏洩、依存脆弱性、予約E2E、実OpenAI、APNs/メール、教材スキャナ、復元。
10. デプロイ: staging→UAT→本番。Cloudflare Workers+assets、Hyperdrive、DB・R2・Queue、監視、Apple署名・TestFlight・App Store。機能未検証を完了報告に含めない。

各工程の成果物は実コード・データmigration・意味のあるテスト・実行ログ・更新README。スクリーンショット再現だけで機能完了にしない。外部blockerのない範囲は自律的に完了し、blocker一覧と影響だけを具体的に示す。
