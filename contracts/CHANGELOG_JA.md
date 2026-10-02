# API契約の変更記録

`contracts/openapi.json` はハンドオフ時点の原本として変更しない。実装で必要になった追加・修正は
`contracts/extensions/*.json` に記述し、`pnpm gen:contracts` で `packages/contracts/openapi.json`
（実装が準拠する有効な契約）と `packages/contracts/src/openapi.d.ts`（型）を生成する。
拡張は同一 path+method / schema を置換または追加する。各変更の理由を以下に記録する。

## 00-core.json（認証・共通DTO）
| 対象 | 種別 | 理由 |
|---|---|---|
| POST /auth/password-reset | 追加 | WEB-01/IOS-01「ログイン失敗・reset」。Auth providerの再設定メールを送信。列挙防止のため常に同じ応答。 |
| POST /auth/mfa/enroll, /auth/mfa/verify | 追加 | WEB-01/WEB-18「管理者MFA」。BFF方式のためサーバー経由でTOTP登録・検証する。 |
| POST /auth/login, LoginInput | 修正 | securityを空に（公開）。応答SessionInfoにmfa_required等を追加。複数組織所属者向けに任意の organization_id を追加。 |
| GET /me | 修正 | 応答をUserからMe（組織・個人設定・受講者所属・MFA状態）へ拡張。iOSの利用区分照合用ヘッダー X-ARMS-Selected-Role、複数組織用 X-ARMS-Org を追加。 |
| User | 修正 | invitation_state, created_at（任意）を追加。ユーザー管理画面の招待状態表示に使用。 |
| SessionInfo | 修正 | organization_name, mfa_required, mfa_enrolled を追加。 |
| Error | 修正 | 任意の details（例: 期限切れ時の最新状態）を追加。 |
| LessonSlot | 修正 | 原本は meeting_url と unit_id を必須の文字列としていたが、API_NOTES「受講者用lesson DTOからmeeting_urlを除く」と矛盾するため null 許容に変更。has_meeting_url, pending_count, approved_count, my_reservation（任意）を追加。 |
| Reservation | 修正 | 一覧・詳細表示に必要な氏名・授業名・講師・クラス・承認済み時のみの meeting_url・取消期限・履歴（任意）を追加。reason を null 許容に。 |

## 10-admin.json（講師・新入社員・クラス・設定・ユーザー・ログ・ダッシュボード）
| 対象 | 種別 | 理由 |
|---|---|---|
| POST /teachers, POST /students | 修正 | 原本の応答は一覧（TeacherPage/StudentPage）で誤り。作成した1件と招待結果を返す `{data, invitation: InviteResult, checked_at}`（TeacherCreateResponse / StudentCreateResponse）に変更。招待はAuth provider作成→DBプロフィール→招待メールのsaga（invitation_jobs）。同じIdempotency-Keyの再送は同じジョブを再開し、Authユーザーを二重作成しない。メール送信失敗時もプロフィールは作成済みで invitation.state=failed（送信失敗・再送可能）。 |
| Teacher | 修正 | 編集画面の初期値に必要な kana・availability、担当クラス名表示用の classrooms（id/name/is_primary）、招待状態 invitation_state を追加。classroom_ids は未アーカイブの担当クラス。student_count は担当講師として割り当てられた在籍中受講者数（SQL集計）。 |
| TeacherInput | 修正 | availability を任意のオブジェクトから「稼働曜日 weekdays（0=日〜6=土）・start_time・end_time（HH:MM）」に限定（WEB-04 稼働時間）。各文字列に最大長を明記。email は登録後変更不可（Auth providerのログインIDのため。変更要求は422）。 |
| Student | 修正 | 一覧表示用の classroom_name・teacher_name、招待状態 invitation_state を追加。progress_percent は app.enrollment_progress の受講者内平均（四捨五入、enrollmentなしはnull）。active は在籍状態（定員集計対象）。 |
| Classroom | 修正 | 一覧・詳細表示用の primary_teacher_name、programs（版のid/program_id/name/version_number）、average_progress_percent を追加。student_count は毎回DB集計。 |
| SettingsInput | 修正 | require_admin_mfa・default_theme・departments（部署リスト）・business_hours（営業時間: weekdays/start_time/end_time）を追加し、各数値の上限を明記。省略項目は変更しない。予約設定の変更は新規の授業枠・申請にのみ適用し既存予約は変更しない。 |
| Settings（新規）, SettingsResponse | 追加/修正 | 原本の応答dataはSettingsInput（任意項目）だったため、既定値を解決した全項目＋timezone（読み取り専用）を返す Settings に変更。row_version は organizations.row_version（If-Match用、ETagにも設定）。 |
| GET /dashboard | 修正 | WEB-02「部署・クラス絞込み」のため department / classroom_id クエリを追加。講師は担当範囲（担当受講者・自分の授業枠）のみ。progress_trend の算出式は services/api/src/routes/admin/dashboard.ts に記載（各月末時点で完了済みの必須単元重み÷必須単元重み×100を受講者ごと→受講者間で平均、四捨五入）。 |
| GET /events, AuditEvent | 修正 | 検索条件を event_type（前方一致）・actor_id・entity_id・from/to（JSTの日付）・q（種別/操作者名）に整理。AuditEvent に actor_id を追加し、システム処理・対象なしのイベントがあるため actor_id / entity_id を null 許容に変更。details は秘密情報キー（token/secret/password/meeting_url/answer_key/transcript等）を除去。 |
| GET /events/deliveries, POST /events/deliveries/{id}/retry, Delivery, DeliveryPage | 追加 | WEB-19「通知失敗/再送」。outboxの配信状況（読み取り専用）と、failedの配信を送信待ちに戻す手動再送（監査記録）。配信処理そのものは通知モジュールの責務。 |
| GET /settings/users | 修正 | クエリを q（氏名・メール）・role・status（active/inactive/invite_failed）に整理。 |
| GET /teachers, GET /students, GET /classrooms, GET /classrooms/{id}/students, GET /classrooms/{id}/teachers | 修正 | 原本は全一覧に共通の汎用クエリ（month/from/to/student_id等）を列挙していたため、実装する絞込みのみに整理（講師: q/department/status/classroom_id、新入社員: q/classroom_id/teacher_id/department/status、クラス: q/teacher_id/status=active\|archived）。/classrooms/{id}/teachers は1クラス最大51名のため全件返却（next_cursor=null）。講師scopeを説明に明記。 |
| POST /settings/users/invite | 修正 | 管理者アカウントのみ招待する。講師・受講者はプロフィール（講師番号／社員番号・クラス・担当講師）が必須のため講師管理・新入社員管理から登録（role=teacher/studentは422で案内）。 |
| POST /settings/users/{id}/enable | 追加 | WEB-18 停止の取り消し（membership有効化＋Auth providerのログイン停止解除）。停止と対称のため追加。 |
| GET /settings/account-deletion-requests, POST /settings/account-deletion-requests/{id}/complete, AccountDeletionRequest(Page) | 追加 | WEB-18「本人削除申請」。POST /me/account-deletion の申請一覧と対応完了（アカウント停止・監査記録。研修記録は保持）。 |

## 20-learning.json（プログラム・教材・進捗・出力）
| 対象 | 種別 | 理由 |
|---|---|---|
| GET /programs/{id}/versions, ProgramVersionPage | 追加 | WEB-10「公開version」。下書き/公開中/公開終了の履歴を新しい順に表示する。 |
| ProgramVersion | 修正 | 「バージョンとポリシー取得」に必要な policy（受験回数上限・最高点/最新点）、published_at、created_at、source_version_id、単元数・教材数・必須weight合計（DB集計）を追加。 |
| Program | 修正 | latest_version（番号・状態）、draft_version_id、created_at を追加。unit_count/material_count は公開中（なければ最新）バージョン、student_count は割当済みの有効受講者のDB集計。 |
| Unit | 修正 | pass_score を null 許容に（DBの units.pass_score は null 可）。null の合格条件は100点（全問正解）。material_count を追加。 |
| Material, MaterialInput | 修正 | description（課題・テストの説明）、external_url（リンク教材のみ）、upload_id/filename/content_type、question_count、受講者本人のみの learner_status（確認日時・受験回数・評価点・提出状態・講師コメント）を追加。object_key は POST /uploads が返したキーを指定する（pdf/video/image で必須、最終保存先のキーはAPIに出さない）。 |
| GET /materials/{id} | 追加 | IOS-12 の深いリンク用の教材詳細。受講者は割当済み・公開・検査済みの教材のみ（それ以外は404）。 |
| GET /materials/{id}/quiz-definition, QuizDefinition | 追加 | WEB-10 のテスト編集画面用。正答を含むため admin/teacher のみ。 |
| PUT /materials/{id}/quiz-definition | 修正 | 原本に無かった X-CSRF-Token（cookie認証時）を追加。 |
| Quiz, QuizResult | 修正 | max_attempts・score_policy・total_points・effective_score・passed、採点結果の正答数/問題数・残り回数を追加。正答そのものは返さない。 |
| GET /submissions, SubmissionPage | 追加 | IOS-03/06「評価待ち」キュー。講師は担当受講者のみ。受講者×課題の最新提出を返す。 |
| GET /submissions/{id}/file | 追加 | 提出ファイルの5分署名URL（admin・担当講師・提出者本人、検査済みのみ）。 |
| Submission | 修正 | 一覧・評価画面用に氏名・教材/単元名・ファイル有無・評価日時・評価者を追加。scan_state を enum に。 |
| Enrollment | 修正 | program_id・program_name・version_number・created_at を追加。 |
| POST /classrooms/{id}/enrollments, ClassroomEnrollmentInput | 追加 | クラス在籍者への明示的な一括受講割当（自動割当はしない）。同じプログラムを受講中の受講者はスキップ。 |
| Progress, UnitProgress, EnrollmentProgress | 修正 | 割当（enrollments）ごとの進捗・期限超過、単元ごとの完了条件の内訳（教材確認数、テスト合否、提出状態、出席要否/充足、完了日時）を追加。 |
| ProgressRecord | 修正 | overdue（JSTの今日と終了予定日から導出）、社員番号、クラス、created_at/updated_at を追加。旧列（終了予定日・社員名・教育担当部署・教育担当者・内容）はそのまま。 |
| PATCH /progress-records/{id}, ProgressRecordUpdateInput | 修正 | 訂正理由 correction_reason を追加（値を変える場合は必須）。変更前後・理由・実施者・日時を履歴に記録。 |
| GET /progress-records/{id}, ProgressRecordDetail, ProgressRecordHistoryEntry | 追加 | WEB-12「詳細・訂正理由・履歴」。 |
| ExportInput | 修正 | 一覧と同じ絞込み（status［overdue含む］、q）を追加。 |
| Export | 修正 | state に expired（保存期限24時間経過）を追加。format・created_at・row_count・filename・error_code を追加。 |
| GET /uploads/{id}, UploadStatus | 追加 | 検疫・検査状態（WEB-10「検疫状態」）をアップロードした本人/管理者が確認する。 |
| POST /uploads/{id}/scan-result, ScanCallbackInput | 追加 | ファイル検査サービスの非同期結果通知。ユーザー認証ではなく HMAC-SHA256 署名（X-ARMS-Scan-Timestamp / X-ARMS-Scan-Signature）で認証。routes/index.ts の認証除外に `POST /api/v1/uploads/<uuid>/scan-result` のパターン一致（PUBLIC_ENDPOINTS は完全一致の Set のため動的パスに一致しない）を追加する必要がある（未追加の間は cron のポーリングで判定）。 |

## 30-booking.json（授業枠・予約・出欠・通知）
| 対象 | 種別 | 理由 |
|---|---|---|
| GET /lesson-slots/{id} | 追加 | WEB-15編集フォーム・IOS-08確認画面・IOS-10詳細で単一枠を取得する。範囲外は404、ETag=row_version、meeting_urlは管理者・担当講師・承認済み本人のみ。 |
| POST /lesson-slots/{id}/cancel | 修正 | 原本のtagが materials、X-CSRF-Token 未記載だったため lesson-slots に修正しCSRFヘッダーを追加。枠取消と同時にactive予約を理由付きで取消済みへ遷移し、受講者通知outboxを記録する動作を明記（docs/04「管理者が取消通知を実行してから新枠を作る」）。 |
| GET /lesson-slots/{id}/attendance | 追加 | IOS-16「出欠を記録」に名簿（承認済み予約＋既存記録）と現在の出欠・記録者が必要。 |
| AttendanceRosterItem / AttendanceRoster / AttendanceRosterResponse | 追加 | 上記名簿の応答DTO。editable は授業開始30分前以降かつ未取消。 |
| SlotInput | 修正 | state（open/closed）を任意項目として追加（受付終了の切替。取消は専用API）。title・capacity・meeting_url・cancel_before_seconds に上限を明記。PATCHは全項目置換（unit_id・meeting_url省略時null、cancel_before_seconds・state省略時は現在値）。 |
| GET /reservations | 修正 | WEB-13の授業別一覧・IOS-17に slot_id、並び順 sort（starts_at / -starts_at / -created_at）を追加。status はカンマ区切り、removed は明示時のみ、保持期限切れpendingは expired として返すことを明記。404/409は一覧では発生しないため削除。 |
| GET /notifications | 修正 | 汎用フィルタ群を本人通知に必要な cursor・limit・status（all/unread/read）に整理。 |
| POST /notifications/read-all | 追加 | IOS-15のお知らせ一覧「すべて既読」。 |
| DELETE /devices/{token_hash} | 追加 | IOS-18ログアウト時に端末のAPNs登録を解除する。端末登録はバージョン管理対象外のため If-Match 不要（冪等）。 |
| エラーコード ALREADY_RESERVED / ATTENDANCE_NOT_OPEN / SLOT_CANCELLED / PROGRAM_NOT_ASSIGNED | 追加 | 同一枠への重複申請（「この授業は既に申請済みです。」）、授業開始30分前より前の出欠記録、取消済み枠の編集・出欠、単元付き授業で教育プログラム未割当の受講者の申請（docs/04「教材プログラム紐付け確認」）を区別して表示するため。 |

## 40-voice.json（音声）
| 対象 | 種別 | 理由 |
|---|---|---|
| POST /voice/sessions | 修正 | 原本にrequestBody・応答の詳細がなかったため、quota超過(429)・音声停止(503)を明記。応答 VoiceSession に client_secret_expires_at, max_seconds, tools, quota_remaining_seconds（任意）を追加。短期秘密は冪等ストアに保存しない。 |
| POST /voice/sessions/{id}/end | 修正 | 本人のみ・冪等を明記。 |
| POST /voice/tool-calls | 修正 | 業務エラーを success:false + data.error_code/message_ja で返すこと、action tokenの扱いを明記。 |
| GET /voice/quota | 追加 | IOS-18/IOS-13で本日の残り利用時間を表示するため。 |
| VoiceQuota, VoiceQuotaResponse | 追加 | 同上。 |

## 50-imports.json（データ移植）
| 対象 | 種別 | 理由 |
|---|---|---|
| POST /imports | 修正 | 説明のみ。upload_id は本人の purpose=import で state=clean（ファイル検査済み）のアップロードに限定。未完了・検査中は409 IMPORT_UPLOAD_NOT_READY（検査サービス未設定時は details.scanner_configured=false と設定が必要な旨）、検出・内容不一致は409 IMPORT_UPLOAD_REJECTED、期限切れは409 UPLOAD_EXPIRED。生ファイルはアップロードのキーで非公開保持しURLを返さない。 |
| ImportMapping | 修正 | columns を {CSVの見出し → 取り込み先項目}（1〜100列）と明記。取り込み先項目・必須・空欄の意味は entity ごとに `IMPORT_FIELDS`（packages/contracts labels.ts）で定義し、未知の項目・重複・必須未対応は422 IMPORT_MAPPING_INVALID（field_errors は `mapping.<項目>`）。 |
| GET /imports | 追加 | WEB-17 のジョブ履歴（新しい順、entity 絞込み、カーソルページング）。 |
| GET /imports/{id} | 修正 | 集計（新規・更新・変更なし・エラー・警告・空行）、列ごとの対応と空欄の意味・空欄数・エラー数（docs/08「空値/NULLの意味をmapping画面で表示」）、文字コード判定、確定・取り消し結果、招待メール送信状況、失敗したバッチの行範囲を返す。行エラーは errors_cursor / errors_limit でページング。 |
| PATCH /imports/{id} | 追加 | 「項目の対応を修正」（If-Match）。確定前のジョブのみ。ドライラン結果を破棄して uploaded に戻す。ファイルは変更不可。 |
| POST /imports/{id}/validate | 修正 | 説明のみ。ファイルを ObjectStorage から読み、UTF-8 / BOM / CP932 を判定（指定との食い違いは422 IMPORT_ENCODING_MISMATCH）、RFC 4180 で解析（10MB・10,000行）。全行の計画と日本語行エラーを import_items に保存（再実行で置換）。業務データは変更しない。 |
| POST /imports/{id}/commit | 修正 | 本文 ImportCommitInput（backup_confirmed=true 必須、send_invitations 任意）を追加。エラー行が1件でもあれば409 IMPORT_HAS_ERRORS（エラー行だけ除外して確定する指定は設けない：元データの修正後にドライランをやり直す）。200行ずつのtransactionで反映し再送で続きから再開、ドライラン後に変更された行は上書きせず conflict。講師・新入社員は管理者招待saga経由で作成し、招待メールは send_invitations=true のときだけ送信。 |
| POST /imports/{id}/rollback | 修正 | 説明のみ。committed_version と現在の row_version を比較し、移行後に編集された行は manual（手動照合が必要）。作成した進捗・クラスは削除、更新は元に戻す。講師・新入社員のアカウントは削除せず停止。 |
| GET /imports/{id}/items | 追加 | ドライランの計画値・更新前の値・変更項目・エラー/警告と確定/取り消し結果の行一覧（status 絞込み、カーソルページング）。 |
| GET /imports/{id}/errors.csv | 追加 | 結果明細CSV（エラー・警告・確定時の競合・手動照合）。UTF-8 BOM付き、全セル引用、= + - @ TAB CR 始まりのセルは ' を前置（CSV formula injection 対策）。 |
| ImportJob | 修正 | 原本の id/state/total_rows/valid_rows/error_rows/errors/row_version に、entity・source_system・encoding・detected_encoding・encoding_mismatch・upload_id・filename・mapping・headers・columns・各件数・options・invitations・failure・errors_next_cursor・作成者・各日時・rollback_started を追加。errors の各要素に label_ja・header を追加。 |
| ImportColumn, ImportItem, ImportItemPage, ImportCommitInput | 追加 | 上記の列対応、行一覧、確定入力のDTO。 |
| エラーコード IMPORT_UPLOAD_NOT_READY / IMPORT_UPLOAD_REJECTED / IMPORT_FILE_MISSING / IMPORT_ENCODING_MISMATCH / IMPORT_ENCODING_UNSUPPORTED / IMPORT_CSV_INVALID / IMPORT_TOO_MANY_ROWS / IMPORT_EMPTY / IMPORT_MAPPING_INVALID / IMPORT_HAS_ERRORS / IMPORT_IN_PROGRESS | 追加 | ファイルの検査状態、文字コード、CSV構文、上限、対応付け、確定条件、処理中の競合を日本語で区別して表示するため。 |

移植の動作仕様（API実装 services/api/src/domain/imports）:
- 照合：講師は講師番号、新入社員は社員番号、教育進捗は（移行元システム名, source_record_id）、クラスはクラスの移行で記録したクラス番号（app.import_classroom_keys）。氏名だけでは照合せず、同姓同名は警告のうえ別人として登録。既存アカウントのメールアドレスとは自動で結合しない（エラー）。参照先（講師・クラス・社員）は登録済みであること（講師→クラス→新入社員→教育進捗の順に移行）。
- 日付は YYYY-MM-DD・YYYY/M/D・2019年8月31日（曜日付きは曜日も照合）を厳密に解釈し、元の年をそのまま保持（2019年を置換しない）。存在しない日付はエラー。学習完了状態が空欄・未対応なら「未確認」で移行し完了とは推定しない。
- 再移行：変更のない行は「変更なし」、差分は「更新」（前回の移行後にARMSで編集されていれば警告）。登録済みの人のメール・有効状態・クラス/担当講師は移行では変更しない（エラーで案内）。
- 取り消し（講師・新入社員）：アカウントはログイン済みの可能性があるため削除しない。移行で作成したアカウントは停止（membership無効化・Webセッション失効・認証サービスのログイン停止、受講者は在籍終了）。予約・主担当クラス・今後の授業枠があり停止できない場合は「手動照合が必要」。パスワードは移行しない。
