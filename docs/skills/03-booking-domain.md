# 予約実装ガイド
DB関数とdocs/04を読む。pending席保持、slot行ロック、冪等キー、unique/exclusion、期限切れ、actor/担当権限を同一transactionで実装。削除はremoved、before/after監査とoutbox。APIが失敗した時にfake confirmationを表示しない。残席1並行テスト、期限境界、二重再送、承認後取消で検証。
