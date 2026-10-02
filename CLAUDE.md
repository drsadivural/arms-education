# ARMS開発ルール

目的は本パッケージを日本語WebとネイティブiOSの実サービスとして完成させること。README→docs/01〜10→contracts→db→designを読む。仕様が衝突したらユーザーの明示指示を優先し差分を記録する。

1. 現在のrepo/branch/依存/既存機能を確認し、既存作業を消さない。新規ならREADME記載の構成で生成する。
2. docs/skillsの該当ガイドを参照し、UI→API→DB→権限→日本語エラー→意味のあるテストまで同じ工程で完成する。サンプル画面をAPI実装と混同しない。
3. menu、logo、旧進捗列、role、予約state、program version、教材privacy、OpenAIを省略しない。TODO・mock・stub・無音音声・fake成功を納品に残さない。
4. 通常の可逆実装・不具合修正は自律的に進める。秘密・サービス契約・署名が不足なら必要項目だけBLOCKERSに記録し、依存しない作業を完了する。成功/試験結果を捏造しない。
5. 外部への権限変更/破壊/本番配信は既存のユーザー承認範囲に従う。実装前に不要な業務警告や同じ確認を繰り返さない。書込み業務のUI確認は仕様通り。
6. provider model・SDK・Apple要件・deployment syntaxは実装時の公式一次資料で確認し、lockfile/Package.resolvedを固定する。
7. ログにsecret/token/音声全量を含めない。認証roleはサーバーから決定。全DB処理にtenant context、パラメータSQL、RBAC。reservationsの定員・冪等・時間重複をDBで保証。
8. 変更後は影響範囲に応じtype/lint/build/testを実行。失敗を根本修正し再実行。iOSはmacOS CIまたはXcodeでcompile+test、archive署名と実機を区別する。
9. GitHub提出はユーザー指定remoteがある場合のみ、秘密scan後commit/push、CIが失敗すれば修正して再実行する。remote未提供なら勝手に公開repoを作らない。
10. 最終報告は実装内容・検証証拠・未検証/外部blocker・次の具体的手順。100%完了と主張するなら全受入項目の証拠が必要。
