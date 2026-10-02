# 画面仕様

Web 19画面・iOS 18画面。画面見本の架空データは本番seedにしない。画像の番号はmanifestと一致。PNGはlight版、代表2画面はdark版も提供。フォームは追加/編集で部品共有し操作モードを明示する。

## Web管理画面

|ID|画面|必須動作|
|---|---|---|
|WEB-01|ログイン|メール認証、利用区分照合、MFA、ログイン失敗・reset。|
|WEB-02|ダッシュボード|在籍・平均進捗・承認待ち・今日の授業、部署・クラス絞込み。|
|WEB-03|講師管理|追加・編集・招待再送・停止、担当クラス・担当人数。|
|WEB-04|講師を登録|必須・メール重複・専門分野・稼働時間・有効状態。|
|WEB-05|新入社員管理|登録・編集・クラス所属・担当講師・CSV招待。|
|WEB-06|新入社員を登録|社員番号・メール重複、講師候補連動、定員、研修期間。|
|WEB-07|クラスルーム管理|クラス追加、在籍/定員・主担当・期間を表示。人数はDB集計。|
|WEB-08|Aクラスの詳細|クラス追加/編集共通form、主/補助講師、プログラム、在籍一覧。|
|WEB-09|教育プログラム管理|プログラム登録・単元/教材数・対象・公開状態・version。|
|WEB-10|教育プログラム・教材を編集|教材upload・検疫状態、リンク/テスト/課題、順序・重み・公開version。|
|WEB-11|社員教育進捗管理|添付の旧列保持・月移動・部署/講師/クラスfilter・CSV/PDF。|
|WEB-12|和田 一夫さんの教育進捗|詳細・教材/点数/評価・訂正理由・履歴・講師権限。|
|WEB-13|オンライン予約システム|申請一覧、承認/理由付き却下/削除、枠作成、履歴。|
|WEB-14|予約申請の確認|担当権限、保持期限、承認、理由却下、soft delete確認。|
|WEB-15|授業・予約枠を追加|授業枠日程・講師/クラス重複・定員・締切・private meeting URL。|
|WEB-16|設定|組織・休日・予約締切・通知・テーマ・音声利用上限。|
|WEB-17|既存システムからのデータ移植|CSV/Excel、encoding、mapping、dry run、errors、commit、rollback。|
|WEB-18|ユーザー管理|招待・再送・停止・管理者MFA・本人削除申請。|
|WEB-19|ログ・イベント|監査・検索・業務ログ・通知失敗/再送、秘密redaction。|
## iOSアプリ

|ID|画面|必須動作|
|---|---|---|
|IOS-01|ログイン|受講者/講師login、password reset、認証・ロール照合。|
|IOS-02|ホーム|本人進捗・今日の承認済授業・通知・音声導線。|
|IOS-03|講師ホーム|担当授業・評価待ち・担当者・承認待ち、teacher scope。|
|IOS-04|研修の進捗|本人の全体/単元進捗・点数・完了条件・last update。|
|IOS-05|担当受講者の進捗|teacher担当者一覧・class filter・詳細・担当外拒否。|
|IOS-06|受講者の詳細|講師担当詳細・課題確認/評価・コメント・履歴。|
|IOS-07|オンライン予約|所属クラスの空き枠・JST日付・remaining・teacher。|
|IOS-08|予約内容の確認|内容確認・pendingとして申請、二重タップ冪等。|
|IOS-09|自分の予約|pending/approved/rejected/cancelled/expired一覧と理由。|
|IOS-10|予約の詳細|承認済meeting導線・取消期限・確認・履歴。|
|IOS-11|本日の授業|JST今日の承認済授業、private参加URL、教材。|
|IOS-12|教材・確認テスト|private PDF/動画/quiz/assignment・サーバー採点、確認記録。|
|IOS-13|AI音声アシスタント|日本語音声・transcript・状態・mute/end/text・リアルDB回答。|
|IOS-14|音声で予約を確認|prepare/commit確認card、期限120秒、曖昧発話では書かない。|
|IOS-15|お知らせ|本人アプリ内通知・既読・deep link、APNs拒否可。|
|IOS-16|出欠を記録|講師担当授業attendance、actor・理由・進捗算出へ連携。|
|IOS-17|担当授業の予約|講師scope申請一覧・明示UI承認/理由却下、Webへ同期。|
|IOS-18|設定|theme light/dark/system、通知・マイク・quota・規約・logout。|

## 全画面共通
全一覧にloading/empty/error/retry、filter状態保持、ページング、最終取得日時。追加/編集に必須field error、保存中、二重送信防止、入力保持、保存成功。削除/取消/却下は対象と結果を明示。権限のない操作はUI非表示かつAPI拒否。空き枠/meeting link/本人progressを同じAPIから取得。

## 添付参照
assets/reference/logo.png は原本。assets/reference/legacy-progress.png の旧進捗列はWeb進捗画面に保持。

## デザイン原本
prototypeはコードによる正確な日本語見本。design/conceptsの生成画像は全体の視覚案であり、日付/文字/数値の仕様ではない。実装時はdocsとprototypeを優先。
