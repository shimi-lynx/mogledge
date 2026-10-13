export const searchMessages: Readonly<Record<string, string>> = {
  検索の詳細設定: "Search options",
  "AND（すべての語）": "AND (all terms)",
  "OR（いずれかの語）": "OR (any term)",
  ルート全体: "Entire root",
  検索するフォルダー: "Folder to search",
  "選択したフォルダーと、その配下すべてを検索します。":
    "Search the selected folder and all its descendants.",
  検索条件をリセット: "Reset search conditions",
  "保存した検索設定を読み取れません。元の設定を保持し、今回の変更は保存しません。":
    "Saved search options cannot be read. The original is kept; changes in this session will not be saved.",
  "検索設定を保存できません。今回の操作は使えますが、再起動後に戻る場合があります。":
    "Search options could not be saved. They work in this session but may revert after restart.",
  "保存した検索範囲が見つからないため、ルート全体を検索します。":
    "The saved search folder was not found. Searching the entire root instead.",
  文書検索: "Document search",
  文書を検索: "Search documents",
  検索条件: "Search condition",
  "空白区切りの語: AND はすべて、OR はいずれかに一致":
    "Space-separated terms: AND matches all; OR matches any",
  "入力して検索を開始…": "Type to start searching…",
  検索を取り消す: "Cancel search",
  検索範囲: "Search scope",
  検索範囲を解除: "Clear search scope",
  全体を検索: "Search all documents",
  "索引の状態・再構築": "Index status and rebuild",
  "索引の件数・再構築は選択したルート全体が対象です。":
    "Index counts and rebuilding apply to the entire selected root.",
  "空白区切りで8語まで。AND はすべて、OR はいずれかの語に一致します。入力中の AND・OR・引用符は文字列として検索します。":
    "Use up to 8 space-separated terms. AND matches all terms; OR matches any. Typed AND, OR and quotation marks are searched literally.",
  フォルダを選択すると検索できます: "Select a folder to search",
  索引を再構築しています: "Rebuilding the index",
  索引を確認しています: "Checking the index",
  索引の更新待ち: "Waiting to update the index",
  索引を作成しています: "Building the index",
  索引の作成に失敗しました: "Index building failed",
  "索引の上限に達しました。一部の文書は検索できません":
    "The index limit was reached. Some documents cannot be searched.",
  一部の文書が未索引です: "Some documents are not indexed",
  索引を再作成しました: "Index rebuilt",
  索引を再構築: "Rebuild index",
  "索引の作成に失敗しました。索引の状態を確認してください":
    "Index building failed. Check the index status.",
  "索引を更新しています。検索結果は不完全です":
    "Updating the index. Search results are incomplete.",
  "一部の文書は検索できません。索引の状態を確認してください":
    "Some documents cannot be searched. Check the index status.",
  検索語は8個以内にしてください: "Use no more than 8 search terms",
  検索しています: "Searching",
  検索結果: "Search results",
  本文の一部を検索: "Part of the text was searched",
  現在の索引には一致する文書がありません: "No matching documents in the current index",
  一致する文書がありません: "No matching documents",
  前の20件: "Previous 20",
  次の20件: "Next 20",
  "検索範囲の上限に達しました。検索語を追加して結果を絞り込んでください":
    "The search range limit was reached. Add search terms to narrow the results.",
  検索対象が変わりました: "The search target changed",
  "範囲: {path}": "Scope: {path}",
  "{count}件を検索できます": "{count} searchable documents",
  "未索引 {count}件": "Not indexed: {count}",
  "未取得・利用不可 {count}件": "Not fetched or unavailable: {count}",
  "読み取り失敗 {count}件": "Read failures: {count}",
  "本文を省略した文書 {count}件": "Documents with truncated text: {count}",
};
