# ARMS iOS アプリ（受講者・講師）

ARMS 新入社員研修システムのネイティブ iOS アプリです。SwiftUI（iOS 17 以上）、ARMS Workers API（メール／パスワードで
`POST /auth/tokens` → Bearer 認証。外部の認証サービスは使わない）、OpenAI Realtime（ネイティブ WebRTC）で構成します。管理者は Web 管理画面を使用し、
iOS では「管理者の操作はWeb管理画面をご利用ください。」と表示してログインを拒否します。

## 構成

```text
apps/ios/
├── project.yml              XcodeGen 定義（ARMS アプリ / ARMSTests、iOS 17.0、開発言語 ja）
├── Package.resolved         リモートパッケージの固定（CI で生成プロジェクトへコピー）
├── ARMSKit/                 Linux でもビルド・テストできる中核 Swift パッケージ
│   ├── Sources/ARMSKit/
│   │   ├── JSON/            JSONValue、ISO8601（小数秒・オフセット対応）
│   │   ├── Models/          契約 DTO（Me / Progress / LessonSlot / Reservation / Material / Quiz / Notification / VoiceSession …）
│   │   ├── Networking/      APIClient（Bearer、Idempotency-Key、If-Match、429/503 再試行＋ジッター、401 再取得）、
│   │   │                    エンドポイント定義、日本語エラー（message_ja）、TokenStore、オフラインキャッシュ
│   │   ├── Formatting/      Asia/Tokyo の日付表記（「10月5日（月）」「14:00–15:30」）、日本語ラベル
│   │   ├── Domain/          進捗表示（null→「未設定」）、予約ルール（取消期限・状態文言・履歴）、空き枠・月カレンダー、
│   │   │                    ディープリンク、出欠・テスト・課題の入力
│   │   ├── Voice/           Realtime イベント解析、ツール呼び出しブリッジ、確認カード（120 秒）、会話状態、セッション制御
│   │   └── ViewModels/      @Observable ビューモデル（ログイン／ホーム／進捗／予約／教材／通知／設定 など）
│   ├── Sources/ARMSKitLinuxSupport/  Linux テスト実行専用のリンク補助（iOS アプリには含まれません）
│   └── Tests/ARMSKitTests/  XCTest
├── ARMS/                    SwiftUI アプリ
│   ├── App/                 エントリ、AppDelegate（APNs）、構成ルート、タブ・ルーター、シーン遷移
│   ├── Features/            IOS-01〜IOS-18 の各画面
│   ├── Networking/          Keychain（トークン保存）、UserDefaults
│   ├── Voice/               WebRTC トランスポート、AVAudioSession、音声画面・確認カード
│   ├── DesignSystem/        色（docs/10）・カード・ボタン・状態表示（読み込み／空／エラー／オフライン）
│   ├── Resources/           Info.plist、Assets（H&A ロゴ原本）、PrivacyInfo.xcprivacy、entitlements、文字列カタログ
│   └── Config/              xcconfig（接続先は空欄。値はリポジトリ管理外の Local.xcconfig で設定）
└── ARMSTests/               アプリ側ユニットテスト（設定読込・ルーター・リソース）
```

### 画面対応

| ID | 画面 | 実装 |
|---|---|---|
| IOS-01 | ログイン | `Features/Login`（受講者/講師、`GET /me` + `X-ARMS-Selected-Role` でロール照合、パスワード再設定） |
| IOS-02 | ホーム | `Features/Home` |
| IOS-03 | 講師ホーム | `Features/TeacherHome` |
| IOS-04 | 研修の進捗 | `Features/Progress` |
| IOS-05 | 担当受講者の進捗 | `Features/TeacherStudents` |
| IOS-06 | 受講者の詳細 | `Features/StudentDetail`（課題評価・コメント） |
| IOS-07/08 | オンライン予約・予約内容の確認 | `Features/Booking`, `Features/BookingConfirm` |
| IOS-09/10 | 自分の予約・予約の詳細 | `Features/MyReservations`, `Features/ReservationDetail` |
| IOS-11 | 本日の授業 | `Features/TodayLessons` |
| IOS-12 | 教材・確認テスト | `Features/Materials`（QuickLook / AVPlayer / Safari、受領記録、サーバー採点テスト、課題提出） |
| IOS-13/14 | AI音声アシスタント・音声で予約を確認 | `Voice/` |
| IOS-15 | お知らせ | `Features/Notifications` |
| IOS-16 | 出欠を記録 | `Features/Attendance` |
| IOS-17 | 担当授業の予約 | `Features/TeacherReservations`（承認／理由付き却下） |
| IOS-18 | 設定 | `Features/Settings`（テーマ、通知、マイク、音声利用、規約、アカウント削除申請、ログアウト） |

下タブは「ホーム / 進捗 / 予約 / AI音声」。講師も同じタブで、内容が担当範囲（担当授業・担当受講者・担当授業の予約）に切り替わります。
設定とお知らせは各タブ右上から開きます。

## 依存パッケージ（固定バージョン）

| パッケージ | バージョン | 用途 |
|---|---|---|
| [stasel/WebRTC](https://github.com/stasel/WebRTC) | 154.0.0（exact、M154 xcframework、BSD-3） | OpenAI Realtime へのネイティブ WebRTC |

ARMSKit は外部依存なしです（ログイン・トークン更新も ARMSKit の `APIAuthService` が URLSession で行う）。CI は Xcode 16.4 で検証しています。

## Xcode でのビルド

```bash
brew install xcodegen
cd apps/ios
cp ARMS/Config/Local.xcconfig.example ARMS/Config/Local.xcconfig   # 接続先を記入（コミットしない）
xcodegen generate
mkdir -p ARMS.xcodeproj/project.xcworkspace/xcshareddata/swiftpm
cp Package.resolved ARMS.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/
open ARMS.xcodeproj
```

接続設定が空のままビルドしたアプリは「アプリの接続設定が不足しています」を表示し、ログインしません（偽の接続先は使いません）。

### 設定入力（顧客提供値）

| xcconfig キー | 内容 |
|---|---|
| `API_BASE_URL` | ARMS Workers API の origin（https。パス無しなら `/api/v1` を付加）。既定値は本番 `https://arms.ayonix.com`（`Base.xcconfig`）。別環境は `Local.xcconfig` で上書き |
| `TERMS_URL` / `PRIVACY_POLICY_URL` | 設定画面の利用規約・プライバシーポリシー |
| `BUNDLE_ID` / `DEVELOPMENT_TEAM` | 顧客所有の Bundle ID と Apple Team |

xcconfig では `//` がコメントになるため、URL は `https:/$()/example.com` と書きます。OpenAI キー・APNs 秘密鍵などの秘密はアプリに含めません（Workers 側の Secret）。

## テスト

```bash
# Linux / macOS（Swift 6.1）
swift test --package-path apps/ios/ARMSKit
# macOS（Xcode、シミュレーター）
cd apps/ios && xcodegen generate && xcodebuild -project ARMS.xcodeproj -scheme ARMS \
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO build test
```

CI は `.github/workflows/ios.yml`（Ubuntu の `swift:6.1-noble` で ARMSKit、macOS 15 で XcodeGen → xcodebuild build/test）です。

### ローカル API との契約テスト（任意）

`Tests/ARMSKitTests/LiveAPITests.swift` は、実際の `APIClient`（URLSession）・DTO・ビューモデル・音声ブリッジをローカルの
API（wrangler dev）に対して実行します。`ARMS_LIVE_API=1` が無い場合はスキップされます（CI でもスキップ）。

```bash
# リポジトリ直下。Docker のローカル基盤（Postgres :55433 / S3互換ストレージ SeaweedFS :9100）を起動し、マイグレーション適用済みであること
(cd services/api && npx wrangler dev --port 8804 --inspector-port 9804 --ip 127.0.0.1)   # 別ターミナル
apps/ios/ARMSKit/Scripts/live-contract-test.sh
```

`Scripts/seed-live.mjs` が実行ごとに独立した組織（講師・受講者・クラス・公開済みプログラム・授業枠 3 件・未読のお知らせ・
音声セッション行）をローカル環境にだけ作成します（ローカル以外の接続先は拒否）。ローカルには OpenAI キーが無いため
`POST /voice/sessions` は `503 VOICE_UNAVAILABLE` になり、`/voice/tool-calls` は seed した音声セッションで prepare → 確認 → commit を検証します。

## 実装上の要点

- **認証**: `APIAuthService` が `POST /auth/tokens`（メール・パスワード）で不透明なアクセストークン（1時間）とリフレッシュトークンを取得し、
  `Authorization: Bearer` で送信（Cookie・CSRF は使用しない）。更新（`/auth/tokens/refresh`）は同時に1回だけ実行（リフレッシュトークンは毎回
  ローテーションされ、再利用はサーバーがセッション失効とみなす）。ログアウトは `/auth/tokens/revoke`。トークンは Keychain
  （`AfterFirstUnlockThisDeviceOnly`）。ロールは選択値をサーバーへ送り、`ROLE_MISMATCH` なら「このアカウントでは選択した利用区分にログインできません」
  を表示してサインアウト。管理者は Web へ案内。複数組織の場合は `X-ARMS-Org` で選択。
- **書き込み**: 操作ごとに Idempotency-Key（UUID）を 1 つ生成し、自動再試行・二重タップ・「もう一度申請する」で再利用。
  通信断で結果が不明な予約申請は `GET /reservations?idempotency_key=` で確認してから結果を表示。PATCH は `If-Match: "<row_version>"`。
  予約は 201 応答後にのみ「申請しました（承認待ち）」、「予約確定」は approved のみ。
- **オフライン**: 最後に取得した応答をアプリ領域（完全保護・バックアップ除外）に保存し、オフライン時は読み取り専用で表示、変更操作は無効化。
  サインアウト時に削除。各一覧に「最終更新 HH:mm」。
- **前景復帰**: 予約・進捗・通知などを再取得し、`/me` を再確認。バックグラウンド移行時は音声と録音を停止（バックグラウンド音声なし）。
- **音声**: `POST /voice/sessions` → WebRTC（マイクトラック + データチャネル `oai-events`）→ `POST https://api.openai.com/v1/realtime/calls`
  （短期 client secret、`application/sdp`）→ answer 適用。秘密はメモリのみ（ログ・永続化なし、`description` も伏せ字）。
  関数呼び出しは 8 ツールの許可リストと JSON スキーマで検証して `POST /voice/tool-calls` へ送り、結果を `function_call_output` と
  `response.create` で返却。同時に 1 応答のみ（二重再生なし）、割り込み時は `response.cancel` + `output_audio_buffer.clear`。
  `commit_*` は確認カード（120 秒）に対するボタン押下、または「はい、申請して」のような明確な発話の後だけ送信し、
  「はい」だけの相槌・質問・言いよどみでは送信しません。60 秒無音・サーバーの `expires_at`・電話割り込み・通信断で終了し、
  `POST /voice/sessions/{id}/end` を送信。初回に「AIが生成した音声です」の説明を表示。マイク拒否時は文字入力で利用可能。
  利用できるツールはセッション応答の `tools`（ロール別、サーバーが決定）に限定。ツール結果はサーバーの executor の形
  （`prepare_*` → `{action_token, expires_at, confirmation_ja, card, checked_at}`、`commit_*` → `{reservation, message_ja, checked_at}`）
  で解釈し、業務エラー（HTTP 200 の `success:false, data:{error_code, message_ja}`）は成功扱いせずそのままモデルと画面に伝えます。
  確認カードはサーバーの `confirmation_ja` とカード項目（日時・授業・講師・クラス・空き／現在の状態・取消期限）を表示します。
  本日の残り利用時間は `GET /voice/quota`（設定画面・音声画面）。
- **出欠（IOS-16）**: `GET /lesson-slots/{id}/attendance` の名簿（承認済み予約＋記録済み受講者、現在の記録・記録者）を表示し、
  `POST` で保存。授業開始 30 分前より前・取消済みの枠は読み取り専用（`ATTENDANCE_NOT_OPEN` / `SLOT_CANCELLED`）。
- **課題（IOS-12/06）**: ファイル添付は `POST /uploads`（purpose: assignment）→ 署名付き PUT（`required_headers` のみ送信）→
  `POST /uploads/{id}/complete` → `object_key` を付けて提出。講師は `GET /submissions?state=submitted`、
  `GET /submissions/{id}/file`（検査済みのみ）、`POST /submissions/{id}/review`（`expected_version`）で評価。
- **通知・端末**: お知らせは `status=unread` 絞り込みと「すべて既読」（`POST /notifications/read-all`）。APNs ペイロードの
  `deep_link`（`arms://reservations/<id>`・`arms://lessons/today`・`arms://lesson-slots/<id>`）で画面を開きます。ログアウト時は
  `DELETE /devices/{token_hash}`（16 進トークンの SHA-256）で端末登録を解除。
- **アクセシビリティ**: Dynamic Type、VoiceOver ラベル、44pt 以上のタップ領域、状態は色＋文字で表示、Reduce Motion で波形停止。
- **ロゴ**: `assets/reference/logo.png` を無加工でアセットに収録し、ダークモードでも白いタイル上に表示。

## Linux で検証済み / macOS・実機が必要な項目

| 項目 | 状況 |
|---|---|
| ARMSKit のビルドと XCTest（DTO・API クライアント・日付・予約/進捗ルール・音声ブリッジ・ビューモデル） | Linux で実行済み（`swift test`） |
| 実 API との契約（ローカル wrangler dev + PostgreSQL + S3互換ストレージ（SeaweedFS）に対する `LiveAPITests`。ログインは実際の `APIAuthService`：/me・予約・出欠・進捗・教材・テスト・課題アップロード・評価・通知・端末・音声ツール） | Linux で実行済み（`Scripts/live-contract-test.sh`） |
| SwiftUI アプリ本体の構文（`swiftc -parse`） | Linux で確認済み（型検査は macOS CI） |
| `APIAuthService`（ログイン・トークン更新の一本化・失効・オフライン時の保持・日本語エラー）の単体テスト | Linux で実行済み（`swift test`） |
| SwiftUI アプリ本体・WebRTC・AVAudioSession・Keychain・APNs のコンパイルとアプリ単体テスト | macOS CI（`.github/workflows/ios.yml`、Xcode 16.4・iOS Simulator）で実行 |
| マイク・WebRTC 音声・AirPods/Bluetooth 経路・電話割り込み・音声割り込み時の再生停止 | 実機での確認が必要 |
| APNs の受信・通知タップからのディープリンク | 実機 + APNs キー（Workers 側）が必要 |
| 署名・アーカイブ・TestFlight / App Store 提出 | 顧客の Apple Developer アカウントが必要 |

## TestFlight 配布手順

1. 顧客の Apple Developer アカウントで Bundle ID を作成し、Push Notifications を有効化。APNs 認証キー（.p8）は Workers の Secret に登録（アプリには含めない）。
2. `Local.xcconfig` に本番（または staging）の接続先・`BUNDLE_ID`・`DEVELOPMENT_TEAM` を設定。
3. 1024×1024 のアプリアイコン（顧客提供の高解像度ロゴ素材から作成）を `AppIcon` に追加。ロゴは再描画しない。
4. `xcodegen generate` → Xcode で Release 構成の Archive → Organizer から App Store Connect へアップロード。
5. App Store Connect でプライバシー情報（`PrivacyInfo.xcprivacy` の申告：メールアドレス・氏名・ユーザーID・音声（OpenAI でのリアルタイム処理）・
   その他ユーザーコンテンツ（課題）、トラッキングなし）、マイク利用目的、プライバシーポリシー・利用規約 URL、アカウント削除の案内、
   日本語スクリーンショット、暗号化輸出の質問（HTTPS / WebRTC の標準暗号のみ）を確認・登録。
6. staging 限定の受講者・講師の審査用アカウント（動作データ付き）を用意し、TestFlight で実機 UAT（マイク拒否、電話割り込み、AirPods、
   通信切断、429、APNs 拒否時のアプリ内通知など docs/07 のシナリオ）を実施。
