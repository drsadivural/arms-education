# 実装開始プロンプト

このフォルダのARMS開発パッケージを、実際に稼働する日本語Web新入社員研修システムとネイティブiOSアプリに実装してください。AGENTS.md、README、docs、contracts、db、design、assets/referenceを読み、機能を省略せず、実コードとAPI接続を最後まで完成させてください。

Webのトップメニューはダッシュボード、講師管理、新入社員管理、クラスルーム管理、教育プログラム管理、社員教育進捗管理、オンライン予約システム、設定です。新入社員の所属クラスと担当講師の選択、クラス人数のDB集計、教材登録・公開、既存進捗項目、予約承認/却下/削除、移行/ユーザー/ログ/システム設定を実装してください。

iOSは受講者/講師login、本人または担当者の進捗、オンライン予約、今日の授業、教材、通知、講師出欠/評価、設定、日本語OpenAI音声を実装してください。受講者申請がWebで可視化され、Web判断がiOSと音声へ反映される同一DBとAPIを使用してください。

音声はOpenAI Realtime WebRTC、APIキーを端末へ置かず、短期秘密をサーバー発行。予約はprepare確認→commit、DB真実に基づく進捗/授業/予約確認。ツール権限と冪等性はサーバーで強制してください。

技術基盤はReact/TypeScript、Cloudflare Workers/Hono、Supabase PostgreSQL/Auth、Hyperdrive、private R2、outbox+Queue、SwiftUIです。指定順に段階実装し、各段階で意味のある試験を通してください。production-ready code、完全なerror/empty/loading/offline、日本語、日本語日付、light/dark、accessible responsive UIを実装してください。全画面画像はデザイン参考であり業務APIの代用ではありません。

テスト/ビルドが失敗したらroot causeを修正し再実行してください。iOSはmacOSでcompile/test、音声とPushは実機、予約残席1の並行試験、他人/担当外/組織境界、CSVdry run/rollback、進捗version、教材privacyを検証してください。完了と未検証を区別し証拠を残してください。外部値不足はdocs/BLOCKERS_JA.mdへ書き、他の実装を止めないでください。
