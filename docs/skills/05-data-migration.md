# 移行実装ガイド
原本画像とdocs/08、migration CSVを読む。画面画像は列参照のみ。実CSVをencoding検出、社員番号・source keyで照合、dry run/差分/error report後にcommit。import item before/afterとversionを保存、編集済み行のrollbackを拒否。期日/担当/内容/総件数を照合、2019年を変更しない。formula injectionと同姓同名を試験。
