export const shellMessages: Readonly<Record<string, string>> = {
  登録フォルダー: "Registered folder",
  登録フォルダーを選択: "Choose a registered folder",
  フォルダーを登録: "Register a folder",
  登録フォルダーを変更: "Change registered folder",
  登録フォルダーを管理: "Manage registered folder",
  フォルダーは未登録です: "No folder is registered",
  登録フォルダーを復元できません: "The registered folder could not be restored",
  "登録フォルダーが別の物理フォルダーに置き換わっています。保存先は変更していません。設定の「登録フォルダー」で確認してください。":
    "The registered folder was replaced by a different physical folder. The storage destination has not changed. Review the registered folder in Settings.",
  表示フォルダー: "Displayed folder",
  "登録フォルダー：{name}": "Registered folder: {name}",
  "表示フォルダーを切り替え：{path}": "Switch displayed folder: {path}",
  登録範囲をすべて表示: "Show the entire registered folder",
  "表示範囲が変更されました。現在の表示フォルダーから選び直してください。登録先と保存先は変更していません。":
    "The displayed scope changed. Select a folder again from the current displayed folder. The registered folder and storage destination have not changed.",
  "選択フォルダー内／HTMLの親、未選択時は表示フォルダー{folder}に作成します":
    "Create in the selected folder or the HTML's parent; without a selection, create in the displayed folder {folder}.",
  "登録フォルダーを復元できません。保存フォルダーを再試行するか、設定の「登録フォルダー」で登録先を明示的に管理してください。":
    "The registered folder could not be restored. Retry the saved folder, or manage the registered folder explicitly in Settings.",
  "登録フォルダーは保存データの基準です。通常の表示切替では、このフォルダー内だけを表示し、保存先は変えません。":
    "The registered folder is the basis for saved data. Switching the displayed folder stays within it and keeps the same storage destination.",
  "登録先を変更しても既存の保存データは削除・移行・統合されません。新しい登録先との対応が未確認なら、保存データの利用を保留します。":
    "Changing the registered folder does not delete, transfer or combine existing saved data. Saved data remains on hold when its relationship to the new folder is unconfirmed.",
  "登録先を変更すると現在の文書タブが切り替わり、開いているHTMLの未保存入力・実行状態は保持されません。変更前に各HTMLの保存操作で入力を保存してください。保存できない入力は別に控えてください。表示フォルダーだけの切替では、開いているタブは保持されます。":
    "Changing the registered folder replaces the current document tabs and does not retain their unsaved input or running state. Save input using each HTML app's own save action before changing it. If saving is unavailable, keep a separate copy of the input. Switching only the displayed folder keeps open tabs.",
  保存データの利用を保留しています: "Saved data is on hold",
  "保留対象の文書は閲覧できます。対応を確認するまで、これらの文書の保存データの復元・保存・削除は利用できません。入力を続ける前に確認してください。":
    "You can view the listed documents. Restoring, saving and deleting saved data for these documents are unavailable until their identity is confirmed. Review this before continuing input in them.",
  "既存の保存データとの対応が未確認です。データは保持されています。独立したバックアップを取ってから確認ツールを利用してください。":
    "The relationship to existing saved data is unconfirmed. Your data is retained. Back it up independently before using the confirmation tool.",
  "保存データを読み取れません。空のデータとして扱っていません。アクセス状態を確認してください。":
    "Saved data could not be read. It has not been treated as empty. Check its availability and access permissions.",
  "保存データの整合性を確認できません。空のデータとして扱っていません。データを保護し、独立したバックアップを確認してください。":
    "Saved data could not be validated. It has not been treated as empty. Preserve it and review an independent backup before recovery.",
  "登録範囲外のフォルダーです。登録先を変更する場合は、設定の「登録フォルダー」を開いてください。":
    "That folder is outside the registered folder. Use Settings > Registered folder to change the registered folder explicitly.",
  "同じ表示フォルダーであることを確認できません。登録範囲全体を表示しています。範囲内のフォルダーを選び直してください。":
    "The displayed folder could not be confirmed as the same physical folder. The registered folder is shown instead. Select a folder within it again.",
  "フォルダーは閲覧できます。既存データの対応を確認するまで、保存データの復元・保存・削除は利用できません。HTMLの入力を続ける前に確認してください。":
    "You can browse the folder. Restoring, saving and deleting saved data are unavailable until its identity is confirmed. Review this before continuing input in the HTML app.",
  StorageIdentityConfirmationRequired:
    "The relationship to existing saved data is unconfirmed. Your data is retained. Back it up independently before using the confirmation tool.",
  DisplayFolderOutsideRegisteredRoot:
    "That folder is outside the registered folder. Use Settings > Registered folder to change the registered folder explicitly.",
  DisplayFolderIdentityChanged:
    "The displayed folder could not be confirmed as the same physical folder. The registered folder is shown instead. Select a folder within it again.",
  StorageCorrupt:
    "Saved data could not be validated. It has not been treated as empty. Preserve it and review an independent backup before recovery.",
  "保存データの識別方式を確認する必要があります。データは保持されています。アプリを終了し、保存データの移行手順を確認してください。":
    "The saved-data identity format needs confirmation. Your data is retained. Quit the app and review the saved-data transition procedure.",
  "保存フォルダーの確認が必要です。選び直してください。":
    "Confirm the saved folder by selecting it again.",
  "保存フォルダーにアクセスできません。名前・場所やドライブ接続を確認してください。":
    "The saved folder is unavailable. Check its name, location or drive connection.",
  "保存フォルダーを読み取る権限がありません。アクセス権を確認してください。":
    "Permission to read the saved folder was denied. Check its access permissions.",
  "保存フォルダーの同期サービスを利用できません。接続・同期状態を確認してください。":
    "The saved folder's sync service is unavailable. Check its connection and sync status.",
  "保存フォルダーは安全に開けません。通常のフォルダーを選び直してください。":
    "The saved folder cannot be opened safely. Select a regular folder again.",
  "保存フォルダーが別のフォルダーに置き換わっています。選び直してください。":
    "The saved folder was replaced by a different folder. Select it again.",
  "保存フォルダーを開けません。接続・アクセス状態を確認するか、選び直してください。":
    "The saved folder could not be opened. Check its connection or access, or select a folder again.",
  保存フォルダーを再試行: "Retry saved folder",
  フォルダーを選び直す: "Select another folder",
  左メニュー: "Sidebar",
  knowledgeフォルダを選択: "Choose a knowledge folder",
  フォルダを選択: "Choose a folder",
  "AIやエディタで作成したHTMLを、ひとつの場所に。":
    "Keep the HTML apps you create with AI or an editor in one place.",
  knowledgeを開く: "Open knowledge",
  "ファイルは元の場所に保存されます。": "Your files stay in their original location.",
  再走査: "Rescan",
  再走査して監視を再開: "Rescan and resume watching",
  設定: "Settings",
  "設定（{shortcut}）": "Settings ({shortcut})",
  設定項目: "Settings categories",
  左メニューを閉じる: "Hide sidebar",
  左メニューを開く: "Show sidebar",
  左メニューの表示: "Sidebar view",
  ファイル: "Files",
  ファイルを表示: "Show files",
  文書検索: "Document search",
  "文書検索（Ctrl/Cmd+Shift+F）": "Search documents (Ctrl/Cmd+Shift+F)",
  機能と使い方: "Features and usage",
  お気に入りと最近の文書: "Favorites and recent documents",
  ウィンドウ操作: "Window controls",
  最小化: "Minimize",
  元のサイズに戻す: "Restore window",
  最大化: "Maximize",
  閉じる: "Close",
  左メニューの幅: "Sidebar width",
  "{width}ピクセル": "{width} pixels",
  入力転送の確認を開いています: "Opening input transfer confirmation",
  AIへの受け渡し確認を開いています: "Opening AI handoff confirmation",
  "{feedback}。左メニューで詳細と再走査を確認できます。":
    "{feedback}. Open the sidebar for details and rescan.",
  "置換後のHTMLに以前の入力状態を渡します。信頼できるHTMLの場合だけ引き継いでください。\n保存された{count}件の入力状態を引き継ぎます。続けますか？":
    "Pass the previous saved inputs to the replacement HTML. Continue only if you trust the HTML.\nTransfer {count} saved input entries. Continue?",
  AIによるHTML制作: "HTML authoring with AI",
  "現在の作業フォルダーに、保存APIの説明とHTMLひな形、Codex・Claudeの制作Skillを任意で配置します。":
    "Optionally add the storage API guide, a ready-to-use HTML template, and Codex/Claude authoring skills to the current folder.",
  "既存のAGENTS.md・CLAUDE.mdや利用者が変更したファイルは上書きしません。":
    "Existing AGENTS.md, CLAUDE.md, and files you have changed are kept.",
  配置内容を確認: "Preview setup",
  配置内容: "Setup preview",
  新規作成: "Create new file",
  配置済み: "Already installed",
  既存の内容を保持: "Keep existing content",
  確認した内容を配置: "Install the reviewed files",
  "AIに渡す依頼文に、制作ガイドを読む指示を付加":
    "Add an instruction to read the authoring guide to AI handoffs",
  "初期値はオフです。利用者の依頼文を保持し、このフォルダーでのAI受け渡しだけに適用します。":
    "Off by default. Your request is preserved; this applies only to AI handoffs from this folder.",
  確認しています: "Checking",
  "{count}件を配置し、{skipped}件を保持しました":
    "Installed {count} files and kept {skipped} files",
  "この作業フォルダーの設定に従い、制作ガイドを読む指示を追加します。入力した依頼文は保持します。":
    "This folder is set to add an instruction to read the authoring guide. Your request text is preserved.",
};
