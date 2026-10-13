export const storageTransitionMessages: Readonly<Record<string, string>> = {
  保存IDの確認ツール: "Storage identity confirmation tool",
  "バックアップは確定済みの保存入力と端末設定が対象です。HTML・未保存の入力・実行状態・検索索引は含みません。":
    "The backup covers committed saved input and device settings. It excludes HTML, unsaved input, runtime state and the search index.",
  "旧版はこの保存形式を開けなくなります。旧設定は保持します。":
    "Older apps will reject this storage format. Legacy preferences are retained.",
  "現在の保存形式をバックアップで置き換えます。現在のデータも別のバックアップに保持します。":
    "The backup will replace the current storage format. Current data is retained in a separate backup.",
  "Mogledgeを終了した状態で使います。保存値は表示しません。HTML原本は変更しません。":
    "Use this tool while Mogledge is stopped. Saved values are never displayed. HTML originals are unchanged.",
  対象フォルダー: "Knowledge folder",
  バックアップ親フォルダー: "Backup parent folder",
  選択: "Choose",
  点検セッションを開く: "Open inspection session",
  点検し直す: "Inspect again",
  確認中: "Working",
  中止を要求: "Request cancellation",
  "中止要求だけでは、完了・未変更は確定しません。進行中の処理の応答を待ち、結果が不明なら照会してください。":
    "A cancellation request does not establish completion or unchanged data. Wait for the in-flight operation response; check its result if the outcome is unknown.",
  "中止要求を送りました。操作結果の確定応答を待っています。":
    "Cancellation was requested. Waiting for the operation's definitive response.",
  "中止要求の応答を確認できませんでした。進行中の操作結果はまだ不明です。":
    "The cancellation response could not be verified. The in-flight operation outcome is still unknown.",
  "応答を確認できませんでした。変更の再実行には新しいプレビューが必要です。":
    "The response could not be verified. A new preview is required before retrying a change.",
  "操作結果が不明です。再実行せず、結果を照会してください。":
    "The operation outcome is unknown. Check its result before taking any further action.",
  操作結果を照会: "Check operation result",
  確認した操作が完了しました: "The reviewed operation committed",
  "ロールバックが完了しました。ツールを終了して再起動してください。":
    "Rollback completed. Quit the tool and restart the app.",
  "設定の公開状態も確認してください。": "Also verify settings publication status.",
  バックアップ作成を伴うプレビューを準備することを確認しました:
    "I agree to prepare a preview, including creating a backup",
  フォルダー確認のプレビューを準備: "Prepare root confirmation preview",
  "文書の確認には、先にこのフォルダーの確認が必要です。":
    "Confirm this root before confirming a document.",
  保存入力のメタデータ: "Saved input metadata",
  "パスは候補の手掛かりだけです。保存入力の所有者は未確認です。":
    "Paths are hints only. Ownership of saved input is unverified.",
  新規の空データとして確認する: "Explicitly confirm empty data",
  前のページ: "Previous page",
  次のページ: "Next page",
  対象HTMLの相対パス: "Target HTML relative path",
  文書確認のプレビューを準備: "Prepare document confirmation preview",
  設定移行元のフォルダーID: "Source root identity for preferences",
  設定移行のプレビューを準備: "Prepare preferences transition preview",
  ロールバック用バックアップ名: "Rollback backup directory name",
  ロールバックのプレビューを準備: "Prepare rollback preview",
  操作プレビュー: "Operation preview",
  "対象・所有者・旧版の拒否・バックアップ範囲と期限を確認しました":
    "I reviewed the target, ownership, older-app rejection, backup scope and expiry",
  "対象・所有者・旧版の拒否・バックアップ範囲と期限を確認しました。既存の移行先を上書きせず、未確認の文書・フォルダー参照は旧参照のまま保持します":
    "I reviewed the target, ownership, older-app rejection, backup scope and expiry. Existing targets will not be overwritten; unconfirmed document and folder references retain their legacy references",
  "対象・所有者・旧版の拒否・バックアップ範囲と期限を確認しました。移行後の設定コピーは非アクティブのまま保持し、元の設定が変更されている場合はロールバックしません":
    "I reviewed the target, ownership, older-app rejection, backup scope and expiry. Transitioned preference copies remain inactive; rollback is rejected if original preferences have changed",
  確認した操作を実行: "Run reviewed operation",
  プレビューを取り消す: "Cancel preview",
  "期限切れまたは無効です。新しいプレビューを準備してください。":
    "This preview expired or is invalid. Prepare a new preview.",
  ツールを終了: "Quit tool",
  不明: "Unknown",
};
