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
