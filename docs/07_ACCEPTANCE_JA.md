# 受入と検証

## E2E必須シナリオ
1. 管理者ログイン→講師招待→クラス作成→受講者登録→クラス/講師選択→画面の人数が増える。クラス外講師を選んだAPIが422。
2. 教材PDFを検疫アップロード→実スキャン→公開→必須単元/テスト/課題を割当→iOSで閲覧/提出→講師承認→Web/iOS/音声の進捗が一致。
3. iOS受講者が枠選択→申請→pending→Webオンライン予約に表示→講師承認→iOS approved→音声「承認済み」→今日の授業へ表示。
4. Web却下には理由必須、iOS通知と理由表示。Web削除はremovedで監査に残る。受講者取消後に残席が復元。
5. 残席1に100並行要求、成功は1件。二重タップ/Idempotency再送は1予約。同じキーの異なる枠は409。時間重複は409。
6. pending期限切れ後に承認すると409/expired。残席解放・監査・outbox記録。授業枠の変更はactive予約があると409。
7. 受講者は他人の進捗/予約/教材リンク拒否。講師は担当外拒否。org切替偽装、失効/停止ユーザー、JWT署名改変が401/403。
8. 音声「来週月曜午後」から候補を示し確認。「はい」の前に予約0件、確認後1件。期限切れ/他ユーザーaction token拒否。再接続で重複しない。
9. マイク拒否、電話割込み、AirPods、通信切断、429で画面操作へ戻れる。アプリ背景録音なし。AI発話割込みで重ねて再生しない。
10. CSV移行dry run→エラー明細→commit→元の28件サンプル等の件数/期日/担当が照合可能。失敗時rollback。2回同じsource keyで移行して増殖しない。
11. 通知障害で予約は成功、outbox再試行で1回の意味上通知。APNs権限拒否でもアプリ内通知あり。通知から予約詳細のdeep linkへ。
12. 未割当/単元0/削除済教材/過去研修/未来入社/講師退職/クラス満員のUIが破綻しない。

## パイプライン
Web: typecheck・lint・unit/integration・production build・Playwright(Chromium/WebKit/Firefox)・axe。
DB: clean DB migration・down/restore strategy・RLS role tests・FK/unique/check/exclusion・予約競合・migration rollback。
iOS: xcodebuild simulator test→実機確認→archive署名→TestFlight。ビルド成功だけでマイク/Pushの実機合格にしない。
API: OpenAPI contract→全endpointの401/403/200/4xx→負荷→秘密/PIIログ検査。

## 証拠
tests/results/にコマンド/日時/Git SHA/OS/端末/結果/スクリーンショット/失敗修正を保存。受入CSVは仕様と期待結果を定義するもので、未実装機能の合格実績ではない。
本パッケージの検証はverification/REPORT_JA.md。本番機能の検証は開発後に別実施。
