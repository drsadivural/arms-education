# OpenAI日本語音声アシスタント

## 接続
公式Realtime WebRTCを採用。確認日の公式例はgpt-realtime-2.1。モデルはOPENAI_REALTIME_MODELから設定し、プロジェクトでの利用可否を起動チェックする。勝手に他社エンジンへ切替しない。声は公式対応voiceから実機で日本語聴感を確認して設定、初期候補marin。固定料金の断定はしない。
Web/iOS→認証済みPOST /voice/sessions→WorkersがOpenAI POST /v1/realtime/client_secretsを呼び短期資格情報を発行→クライアントがPOST /v1/realtime/callsでSDP交換→WebRTC音声+data channel。恒久OPENAI_API_KEYはWorkers Secretのみ。短期秘密はメモリのみ、ログ/永続保存/分析へ送らない。旧 /v1/realtime/sessions のmint手順やGAに不要なBetaヘッダーを採用しない。
クライアントはfunction call引数完成イベントを検証し、API /voice/tool-callsへ送信。APIはactor/session/call IDを照合、ツール名allowlistとJSON schemaを検証、サーバー側権限・期限・本人範囲を適用し、JSON結果をfunction_call_outputへ渡して応答再開する。クライアント提供org_id/user_id/roleを無視する。
この構成ではクライアント経由ツールイベント自体を信頼せず通常APIと同じ認可を行う。モデルやUIがsession設定を変えても権限を増やせない。call_id冪等性とaction tokenをサーバーで管理する。

## 音声で実行できる業務
|発話例|ツール|動作|
|---|---|---|
|今日の授業を教えて|today_lessons|JST当日、受講者本人または講師担当授業|
|私の進捗は何パーセント？|get_progress|本人進捗、講師は担当者指定が必要|
|月曜午後の空き枠を探して|search_slots|JST日付を絶対日付へ確認、不明なら質問|
|10月5日14時を予約したい|prepare_reservation|候補枠をIDで特定し確認カードを返す|
|その内容で申請して|commit_reservation|サーバー確認token検証後pending作成|
|予約できている？|get_reservations|DBから申請/承認/却下/期限切れを説明|
|予約を取消して|prepare_cancellation / commit_cancellation|対象を確認し期限検査後取消|

講師の音声は担当者進捗、担当授業、予約状況確認まで。承認/却下/削除はWebまたはiOS講師の明示UIで行う。管理者設定、ユーザー権限、CSV移行は音声ツールに公開しない。

## 書き込み確認
prepareはDB変更を行わない。org/user/session/対象slot/時刻/説明/期限/nonce/idempotency_keyに紐付いたaction draftをサーバーDBへ作成、action tokenは256bitランダムでhashのみ保存、有効120秒。画面カードと読み上げで「10月5日（月）14時から、田中講師のIT基礎を予約申請します。申請してよろしいですか？」と提示。ユーザーが「はい、申請して」またはボタンを押した時のみcommit。内容変更時は再prepare。曖昧な相槌や授業説明内の命令ではcommitしない。
commitはtokenを本人/session/intentと照合しFOR UPDATE、未使用・未失効を検査、予約サービスtransaction内で再度空き枠確認し消費。再送は記録したreservation_idを返す。tokenをモデルが捏造しても成立しない。モデルがユーザー意思を誤解する可能性をゼロとせず、確認カードを常時表示し取消手段を提供する。音声は生体認証ではなくログイン権限に従う。

## 音声UXとiOS
アイドル/接続中/聞いています/確認中/話しています/再接続/エラーを日本語表示。リアルタイム文字表示、ミュート、終了、押して話す、テキスト入力を用意。発話割込みは応答キャンセルと再生済み位置に整合するtruncate、二重音声再生を防止。AVAudioSession playAndRecord + voiceChat、Bluetooth/イヤホン/電話割込み/ルート変更を扱い、バックグラウンド移行時に録音停止しセッション終了。前景復帰は新セッション、未確定書き込みを再実行しない。
Microphone利用説明: 「予約や研修内容を日本語で音声操作するためにマイクを使用します。」マイク拒否でもテキスト/画面操作可。初回に「AIが生成した音声です」と表示。既定は音声録音/全文transcript保存なし。業務監査にはtool名・actor・対象・結果・request IDだけ、必要な同意がある場合のみ別設定で保存期間を制限する。

## コストと障害
初期セッション最大10分、無発話60秒で終了、ユーザー日次15分を既定設定。サーバーquota消費は音声session発行・終了を照合、期限切れ分も最大時間で計上して過小計上を防ぐ。UIタイマーだけに頼らない。provider使用量と集計照合し予算閾値で新セッション拒否。429/接続失敗時「現在、音声機能を利用できません。画面から操作してください」。OpenAI障害でも通常予約/進捗APIは継続。

## 公式仕様
- https://developers.openai.com/api/docs/guides/realtime
- https://developers.openai.com/api/docs/guides/voice-webrtc
- https://developers.openai.com/api/docs/guides/voice-server-controls
公式のRealtime event名・session schemaを実装時に固定versionで確認する。ネイティブWebRTCの配布物/ライセンス・アーキテクチャ対応も確認し、iOS音声をWebViewだけで代替しない。
