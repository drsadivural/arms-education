# 受入条件（docs/07）の検証状況 — 2026-10-03

凡例: **検証済み**＝自動テストまたは実行記録で確認（ローカル環境）／**一部**＝API・Web等で確認、残りは実機・外部サービスが必要／**未検証**＝外部値・実機がないため未実施。
ローカル環境: PostgreSQL 17（実行ロール NOSUPERUSER/NOBYPASSRLS）、PgBouncer（Hyperdrive相当）、
S3互換ストレージ（R2の代替）、ClamAV（実マルウェアスキャン）、メールリレー＋Mailpit、wrangler dev（workerd）。本番・ステージングでの実施ではない。
2026-10-03 のユーザー指示により Supabase を廃止し、認証は API と PostgreSQL で行う（`docs/dev/SPEC_DEVIATIONS_JA.md`）。
それ以前の記録（`2026-10-02-*.md`）の認証部分は Supabase Auth（GoTrue）での実施で、下表の認証関連の証拠は新方式で再実行したもの。
S3互換ストレージは2026-10-02の検証時はMinIO。MinIOの公開イメージ配布終了に伴い2026-10-03にSeaweedFS 4.48へ置換し、署名URLのストレージ試験（3件）、Web E2E 53件（Chromium）、iOSライブ契約試験5件を再実行して合格。

## E2E必須シナリオ
| # | シナリオ | 状況 | 証拠 |
|---|---|---|---|
| 1 | 管理者ログイン→講師招待→クラス作成→受講者登録→クラス/講師選択→人数増加。クラス外講師は422 | 検証済み | Web E2E `admin-teachers/classrooms/students.spec.ts`、API `test/admin/**`（TEACHER_CLASSROOM_MISMATCH 422、人数はDB集計）、招待メール（Mailpit）→`/auth/callback`→パスワード設定→講師ログイン、「パスワードをお忘れですか？」→再設定（Web E2E `auth-callback.spec.ts`、API `test/auth-password.test.ts`） |
| 2 | 教材PDFを検疫アップロード→実スキャン→公開→必須単元/テスト/課題→iOSで閲覧/提出→講師承認→Web/iOS/音声の進捗一致 | 一部 | Web E2E `learning-programs.spec.ts`（ClamAVで検査済み→教材・版の公開）、API `test/learning/**`（進捗計算・テスト採点・課題評価・版の分離）、iOS ARMSKitライブ契約試験（教材・受験・課題アップロード・評価）、音声 `get_progress` とRESTの一致（`test/voice`）。iOSアプリ画面は未実行（macOS必要） |
| 3 | iOS受講者が申請→pending→Web一覧に表示→講師承認→iOS approved→音声「承認済み」→今日の授業 | 一部 | Web E2E `booking-screens.spec.ts`（APIで作成した受講者申請が5秒以内に一覧へ表示→承認）、iOSライブ契約試験（申請・承認・今日の授業）、音声 `get_reservations` の status_ja。iOS実機画面は未実行 |
| 4 | 却下は理由必須・iOS通知と理由表示、削除はremovedで監査に残る、受講者取消で残席復元 | 検証済み（iOS表示は契約試験まで） | Web E2E（理由必須・削除確認文・履歴タブ）、API `test/booking/**`（通知作成・席の復元・監査） |
| 5 | 残席1に100並行で成功1件、二重タップ/再送で1予約、同キー別枠409、時間重複409 | 検証済み | API `test/booking/concurrency.test.ts`、負荷スクリプト `2026-10-02-load-reservations-local.md`（100並行で成功1・SLOT_FULL 99・DB上1件） |
| 6 | 期限切れ後の承認は409 expired・席解放・監査/outbox、有効予約がある授業枠の変更は409 | 検証済み | API `test/booking/reservations.test.ts`、`slots.test.ts`、`test/integration-fixes.test.ts` |
| 7 | 他人・担当外の拒否、組織偽装、停止ユーザー、JWT改ざんで401/403 | 検証済み | API `test/auth.test.ts`（不透明トークン: 未知・失効・期限切れ・リフレッシュトークンの誤用は401、リフレッシュの再利用でセッション失効、10回失敗で15分ロック、管理者TOTPの再利用拒否）、各領域の401/403/範囲外テスト、セキュリティレビュー（`2026-10-02-security-review.md`） |
| 8 | 音声「来週月曜午後」→候補→「はい」前は0件・後は1件、期限切れ/他人のトークン拒否、再接続で重複なし | 一部 | API `test/voice/voice.test.ts`（prepare→commit、偽造/期限切れ/他ユーザー/他セッション拒否、再送で1件）、iOSライブ契約試験のツールブリッジ。実OpenAIでの日本語会話・自然文からのツール呼び出しは未検証（APIキー未提供） |
| 9 | マイク拒否・電話割込み・AirPods・通信切断・429で画面操作へ、背景録音なし、二重再生なし | 未検証（実装済み） | iOS `Voice/`（AVAudioSession playAndRecord/voiceChat、割込み・経路変更、背景で終了）、Webはタブ非表示で終了・マイクなしでテキスト入力。`VOICE_UNAVAILABLE` 時の日本語案内はAPI/Webで確認。実機が必要 |
| 10 | CSV移行 dry run→エラー明細→commit→件数照合、失敗時rollback、同じsource keyで増殖しない | 検証済み（見本・生成データ） | API `test/imports/**`（CP932/BOM、行エラー、再移行、rollback、編集済み行の手動照合）、Web E2E `admin-import.spec.ts`（実スキャン→対応付け→ドライラン→バックアップ確認→確定）。顧客の実エクスポートでは未実施 |
| 11 | 通知障害でも予約成功、outbox再試行で1回、APNs拒否でもアプリ内通知、ディープリンク | 一部 | API `test/booking/notifications.test.ts`・`jobs.test.ts`（メール失敗→再試行→1回、二重処理でも1件）。実メール送信・APNs実配信は未検証 |
| 12 | 未割当・単元0・削除済み教材・過去研修・未来入社・講師退職・満員のUIが破綻しない | 一部 | 進捗「未設定」、CLASSROOM_FULL、講師停止（TEACHER_IS_PRIMARY）、過去日付（2019年）の表示はE2E/単体で確認。全組合せの網羅は未実施 |

## パイプライン
| 項目 | 状況 | 内容 |
|---|---|---|
| Web: typecheck・lint・unit・build・Playwright（Chromium/WebKit/Firefox）・axe | 検証済み | 単体113件、E2E 53件×3エンジン（各エンジン別実行、WebKitは公式Playwrightイメージ）、全画面でaxe（WCAG 2.2 AA自動チェック、ダーク・390px含む）。GitHub Actions（commit `2c3e2e4`、run 37048827603）でも3エンジンとも53件合格・再試行なし |
| DB: clean migration・RLSロール・制約・予約競合 | 検証済み | APIテストは実行ごとに新規DBへ全マイグレーション適用、実行ロールで437件。down migrationは採用せず「バックアップ復元＋差分調整」（`docs/dev/OPERATIONS_JA.md`） |
| API: 契約→全endpointの401/403/200/4xx→負荷→秘密/PII | 検証済み（負荷はローカル） | 全レスポンスをOpenAPI（Ajv）で検証、秘密スキャン、ログのredaction。負荷のp95目標はステージングで再測定が必要 |
| iOS: xcodebuild simulator test→実機→archive→TestFlight | 一部（simulatorまで） | GitHub Actions `ios.yml`（run 37046165229、macOS・Xcode 16.4）でSwiftUIアプリのビルド成功・アプリ単体テスト9件合格（iOS Simulator）、ARMSKit 176件合格（ライブ5件はスキップ）。Linuxでもライブ契約5件合格。実機・archive署名・TestFlightは未検証（Apple署名情報未提供） |

## 再実行方法
`README.md` の「テスト・品質確認」と `apps/web/playwright.config.ts`、`apps/ios/ARMSKit/Scripts/live-contract-test.sh`、`tests/load/reservations.mjs` を参照。
