# ARMS 開発を開始する

1. ZIPを展開し、`prototype/index.html` をブラウザで開く。全画面一覧からWeb・iOSの画面を確認する。
2. 新規Gitリポジトリのルートにこのパッケージを配置する。原本画像は `assets/reference/` から変更しない。
3. Claude Code / Codex に `prompts/IMPLEMENT_ARMS_JA.md` 全文を渡す。最初に `AGENTS.md` と `docs/` を読ませる。
4. `templates/config-inputs.json` に記載した外部サービスを作成する。本番秘密はチャットやGitに貼らず、Cloudflare Secret・GitHub Environment Secrets・Apple署名管理に登録する。
5. Web/APIの基盤→管理CRUD→教材と進捗→予約→iOS→音声→移行→総合検証の順に完成させる。各工程に実データAPI・権限・エラー処理・テストを含める。
6. `docs/07_ACCEPTANCE_JA.md` の全条件に結果・証拠を記録する。iOSはmacOSのXcodeまたはGitHub macOS CIでビルド・テストする。
7. ステージングで実端末から申請し、Web承認後にiOS表示と音声回答が一致することを確認する。音声の日本語会話・割込み・重複送信・通信復旧も実機で確認する。
8. 外部値不足は `docs/BLOCKERS_JA.md` に必要な値・影響・未検証範囲を明記する。API失敗をサンプル値で成功表示しない。

初期前提: 1組織で開始可能、DBは複数組織対応。オンライン予約は研修・面談の予約であり決済は不要。オンライン授業URLは管理者がHTTPSリンクを登録し、承認済み受講者だけへ返す。Zoom等の会議作成APIは別途契約なしには作成しない。
