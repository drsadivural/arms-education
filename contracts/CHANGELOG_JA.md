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
| POST /uploads/{id}/scan-result, ScanCallbackInput | 追加 | ファイル検査サービスの非同期結果通知。ユーザー認証ではなく HMAC-SHA256 署名（X-ARMS-Scan-Timestamp / X-ARMS-Scan-Signature）で認証。routes/index.ts の PUBLIC_ENDPOINTS への追加が必要（未追加の間は cron のポーリングで判定）。 |

## 30-booking.json（授業枠・予約・出欠・通知）
| 対象 | 種別 | 理由 |
|---|---|---|

## 40-voice.json（音声）
| 対象 | 種別 | 理由 |
|---|---|---|

## 50-imports.json（データ移植）
| 対象 | 種別 | 理由 |
|---|---|---|
