# 既存システムのデータ移植

## 添付画面の項目対応
|既存|ARMS|扱い|
|---|---|---|
|終了予定日|progress_records.due_date|元の年月日保持、2019年を2026年に置換しない|
|社員名|student profile / learner ID|同姓同名は社員番号で照合、名前だけ自動mergeしない|
|教育担当部署|progress_records.department_name|旧名称をsnapshot保持|
|教育担当者|teacher user ID + name snapshot|講師管理からmap、未解決はエラー|
|内容|progress_records.content|原文保持、プログラム/単元への紐付けは確認|
|今月/来月の教育|月フィルター|JSTの日付による|
|営業部/開発部/サポート部|部署フィルター|組織設定の部署へmapping|

スクリーンショット画像だけからDBを復元しない。CSV/Excelの実エクスポートを受け取り、元データ件数とIDが必要。画像は列定義の参照のみ。

## 手順
アップロード→文字コード判定/プレビュー→列mapping→社員/講師/クラス対応→dry run→行ごとの日本語エラー→合計/新規/更新/skip確認→バックアップ→管理者commit→監査/結果CSV→件数照合。
UTF-8/BOM/CP932をサポート、.xlsxは数式実行しない。CSV 10MB/10,000行初期上限、サーバーでstream/分割transaction。元の生ファイルをprivate隔離、データは組織境界。CSV formula injection (=,+,-,@,TAB,CR先頭)をエクスポート時escape。数式/HTMLを実行しない。
必須: source_record_id、社員番号、終了予定日、教育担当部署、教育担当者、内容。終了予定日はYYYY-MM-DDまたは日本の年月日を厳密parse、存在しない日はエラー。空値/NULLの意味をmapping画面で表示。学習完了状態が元データにない場合は「未確認」で移行し、完了と推定しない。
source_system+source_record_id+org_id unique。再移行はdry run差分。上書きはrow_versionで競合検査。ジョブをresume可能にし、失敗transactionの範囲を表示。rollbackはimport_itemsのbefore/after/versionを比較し、移行後のユーザー編集を上書きしない。変更済み行はmanual reconciliationへ。
パスワードは旧DBからコピーしない。招待/初回reset。既存auth IDはverified mappingし、emailを他組織のaccountへ勝手に結合しない。

## 本パッケージ
`migration/students.csv`, `teachers.csv`, `classrooms.csv`, `progress.csv` は架空例1〜3行の見本。原本社員を含まない。既存28件表示の全レコード抽出は提供画像のみからは行っていない。
