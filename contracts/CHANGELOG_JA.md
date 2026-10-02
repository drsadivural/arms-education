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

## 50-imports.json（データ移植）
| 対象 | 種別 | 理由 |
|---|---|---|
