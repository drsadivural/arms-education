# デザインシステム

ロゴ: 添付H&Aを原本のまま表示し隣にARMS、サブテキスト「新入社員研修システム」。白いlogo tileでダークテーマでも原本視認性を保持。ロゴをARMSロゴとして再描画しない。
主色 #0076D1、濃紺 #15365D、背景 #F4F7FB、surface #FFFFFF、text #16324F、muted #64748B、border #DFE7F1。success #0B7B61、warning #9A6700、danger #C93843。ダーク背景 #101D30、surface #192A42、text #EDF4FF、border #2B405E。
Web: 248px sidebar、64px topbar、32px content padding、16px cards、12px control、8px spacing grid。見出し28px/700、本文14px、ラベル12px。tableは表示倍率に追従、長文ellipsis+detail。進捗バー・タグに文字を添える。情報を詰め込むより主要操作を右上に固定。
iOS: safe area、標準NavigationStack/TabView、44pt action、16pt余白、角丸20pt card、Dynamic Type。下タブはホーム/進捗/予約/AI音声、設定はプロフィールから。講師でも同じタブを担当範囲に変更。
日本語フォント: Web見本はNoto Sans CJK JP（同梱）、本番はサブセット化して最適化。iOSはシステム日本語フォント。iconは同一library、意味のない絵文字を主要業務iconに使用しない。
レスポンシブ: 1440 desktop、1024 tablet、390 mobile。Web narrowはsidebar drawerとカード化、進捗tableは横スクロール。dark/light/systemをユーザー毎に保存。
すべての追加/編集form: 必須・field error・保存中・成功通知・保存失敗保持・dirty確認・重複送信防止。危険操作だけ内容/対象を明示。読み込み時はskeleton、ゼロ時は次の具体操作。UIは日本語。
