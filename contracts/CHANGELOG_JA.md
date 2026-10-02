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

## 40-voice.json（音声）
| 対象 | 種別 | 理由 |
|---|---|---|

## 50-imports.json（データ移植）
| 対象 | 種別 | 理由 |
|---|---|---|
