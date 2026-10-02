# 予約と進捗の業務ルール

## 予約の状態
|DB|日本語|席保持|許可遷移|
|---|---|---|---|
|pending|承認待ち|保持期限まで|approved/rejected/cancelled/expired/removed|
|approved|承認済み|保持|cancelled/removed|
|rejected|却下|なし|removed|
|cancelled|取消済み|なし|removed|
|expired|申請期限切れ|なし|removed|
|removed|削除済み|なし|なし|

申請はログインした受講者本人だけ。管理者の代理予約は別の監査付きUI/APIを実装しない限り行わない。講師は本人を受講者として偽装して申請できない。講師は担当授業の予約を承認/却下/削除、管理者は組織内全予約を判断可能。

pendingの保持期限はmin(申請から24時間、授業開始時刻)。設定変更は新規申請に適用し、既存expires_atは勝手に変更しない。期限切れcron1分＋申請/判断時のlazy expiryで判定。却下には理由1〜1,000文字。削除は管理者/担当講師のみ、理由必須、soft deleteとしてremovedへ遷移。履歴と監査は残し、通常一覧から隠す。確認ダイアログは明確に「予約を削除し、履歴を保持します」。受講者は取消のみ。取消締切は授業開始24時間前を初期値、管理者の締切後操作は理由付き別操作にする。

APIはIdempotency-Key UUIDを必須化。DB unique(org_id,student_id,idempotency_key)。同じキー+同じ内容なら既存結果、違う内容なら409。二重タップ・音声再送・ネット復旧で同じキーを使用。requestの失敗応答だけで「未登録」と判断せず、キー検索→既存結果の確認。UIの楽観更新は予約成功の証拠にしない。

transaction: membership/本人検証→lesson_slot FOR UPDATE→対象pendingの期限切れを更新（監査/outboxも）→可予約状態/締切/クラス/在籍/教材プログラム紐付け確認→残席と時間重複→INSERT→監査/outbox→COMMIT。定員超過は409 SLOT_FULL。時間重複はDB exclusion constraintで409 TIME_CONFLICT。SQLSTATEを日本語エラーへ変換し、内部SQLメッセージを返さない。
授業の講師・時刻・クラスの変更はactive予約がある間は禁止。管理者が取消通知を実行してから新枠を作る。複数講師を跨ぐ重複をアプリだけで検査しない。取得時のremainingはlive pending＋approvedの集計。

## 進捗の計算
プログラム公開バージョンと単元重みをenrollmentへ固定。完了単元weight合計 / assigned weight合計 ×100。画面は四捨五入整数、DBに表示率を手入力しない。単元ゼロなら「未設定」かつprogress_percent=null、0除算なし。任意単元は全体進捗の分母から除外する。完了は必須教材の確認＋テスト合格＋必須課題講師承認＋必要出席の全条件。すべての必須単元完了で研修完了。
テスト採点はサーバー、正答を受講者APIで返さない。動画視聴自己申告のみでは完了にせず必要なチェック/テストを併用。再受験回数・最高点/最新点ポリシーをバージョンに固定。教材の開封と理解を同一視しない。
未着手/受講中/確認待ち/完了/期限超過を日本語表示。期限超過は予定日と組織JST当日＋未完了から導出。終了予定日をtimestampのUTC日切りで判定しない。講師訂正はbefore/after・理由・actor・時刻を履歴に記録。管理者が重みを変えて過去成績が変わらないようバージョン分離する。

## 画面間整合
Web/iOS/AIは同じprogress serviceを呼ぶ。予約の「申請済み」「承認済み」を区別し、「予約確定」はapprovedに限定。AIはAPIのchecked_atを使い、「現時点で承認待ちです」と返す。残席や進捗をモデル推測で補完しない。
