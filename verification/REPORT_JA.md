# ARMS開発パッケージ 検証結果

検証日: 2026-10-02

## 確認済み
- Web19画面 / iOS18画面をブラウザでレンダリング。代表ダーク版2枚を含む個別PNG39枚。全PNGの存在・幅、日本語フォント読込、画面名を確認。
- 添付H&Aロゴと旧進捗画面を原本のまま同梱。ロゴ再描画なし。
- galleryの画面切替・テーマ切替、単独HTMLのフォント/画面切替を検証。JavaScriptエラー0件。
- OpenAPI 3.1をSwagger Parserで検証: 88操作 / 109schemas。参照解決成功。音声tool定義8件。
- PostgreSQL互換PGlite(WASM)+btree_gistで3つのschema migrationを適用。予約・再送・定員・承認/却下/取消/削除・監査/outbox・進捗・公開単元guard・組織RLS・クラス定員/在籍者制約等、24チェック合格。
- npm run checkの実行結果を確認。
- 開発スキルのfrontmatter検証・保存結果を確認。

## 証拠ファイル
render-checks.json / standalone-checks.json / contract-checks.json / db-tests.json。traceability.csvはAPI受入対象一覧で、実装後のAPI合格証拠ではない。

## 未実行（アプリ開発工程の受入対象）
Web/API本体の実装・実認証・実PostgreSQL複数接続による同時100予約・Hyperdrive接続・実R2/scanner/SMTP/APNs・OpenAI音声通信・iOSコンパイル/署名/実機・App Store提出は本パッケージ作成では実行していません。完成アプリとは区別してください。

## 原本ハッシュ
```text
logo.png SHA-256 d2a230f6bda30961fc488c4c1ef0c23334263ffe9f33b7b88073cb82364327c8
legacy-progress.png SHA-256 477c22a7dd77f3f9446fdb5bb0814c0ec463a5a4ee653e5ded42e8c62db87b0a
```
