export const transferMessages: Readonly<Record<string, string>> = {
  "DBの技術上限またはdiskの容量制約に達しました。既存の保存値と入力を保持します":
    "A database technical limit or disk capacity constraint was reached. Existing saved values and input are retained.",
  "処理に必要なメモリなどの資源を確保できません。既存の保存値と入力を保持します":
    "Resources such as memory could not be allocated for this operation. Existing saved values and input are retained.",
  "転送の詳細を確認できません。処理結果を照会してください":
    "Transfer details could not be verified. Check the operation result.",
  保存済み入力を取り込む: "Import saved input",
  保存済み入力を書き出す: "Export saved input",
  入力転送の確認: "Review saved input transfer",
  "信頼できるHTMLと保存ファイルだけを選んでください。対象は確定済みの保存状態です。入力欄・Canvas・JavaScriptの全状態や未確認writeを保全する機能ではありません。保存ack・未保存入力の有無は不明です。":
    "Choose only trusted HTML and saved files. This transfers confirmed saved input, not every input field, canvas, JavaScript state or unconfirmed write. Save acknowledgements and unsaved input are unknown.",
  "書き出しとbackupは平文JSONです。個人情報を含むことがあるため保管先を確認してください。HTML原本は変更しません。":
    "Exports and backups are unencrypted JSON and may contain personal information. Check where you save them. The original HTML is unchanged.",
  "選択ファイル: {name}": "Selected file: {name}",
  "新しいbackup先: {name}": "New backup file: {name}",
  "Native画面で選択・対象確認中です。": "Selecting and confirming the target in the system dialog.",
  新しいbackup先を選ぶ: "Choose a new backup file",
  転送する保存状態: "Saved input to transfer",
  "{bytes} bytes・{count} appId": "{bytes} bytes · {count} app IDs",
  "書出元の相対パス: {path}・保存revision {revision}（来歴のみで、取り込み先の権限ではありません）":
    "Source relative path: {path} · saved revision {revision} (provenance only; this grants no access to the import target)",
  "{appId}（schema {version}）": "{appId} (schema {version})",
  "実表示view: 表示中{active}件／非表示{hidden}件、外部browser grant {grants}件、進行中open {opening}件。保存ackはすべて不明です。":
    "Live views: {active} active / {hidden} hidden, {grants} external browser grants, {opening} pending opens. All save acknowledgements are unknown.",
  "既存の全appIdの保存状態を置換し、新しい平文backupへ保全することを確認しました（{count} appId）。":
    "I confirm replacing saved input for all existing app IDs and preserving it in a new unencrypted backup ({count} app IDs).",
  "別の確認: 対象の表示中・非表示・外部browserの保存権限を停止し、同identityの実表示タブを再読み込みします。未保存入力・Canvas・JS実行状態を失う可能性を了承しました。未表示の作業セットは読み込みません。":
    "Separate confirmation: revoke save access from active, hidden and external browser views of the target, then reload live tabs with the same identity. I accept that unsaved input, canvas and JavaScript state may be lost. Workspace sets not yet displayed will not be loaded.",
  選択ファイルと現在値を照合: "Compare selected file with current values",
  確認した内容で取り込む: "Import as reviewed",
  確認した内容で書き出す: "Export as reviewed",
  "処理中です。取消要求の後にもcommitが完了することがあります。":
    "Working. The operation may commit even after a cancellation request.",
  "処理結果は不明です。自動再実行しません。照会で完了・取消・失敗を確認してください。アプリ終了後は再選択による現在値照合が必要で、過去の実行を証明するものではありません。":
    "The result is unknown. The operation will not run again automatically. Check whether it completed, was cancelled or failed. After the app exits, reselect the file to compare current values; this does not prove a past operation.",
  処理結果を照会: "Check operation result",
  "結果不明のまま閉じることを理解しました。取消要求を送り、表示タブは自動復旧しません。":
    "I understand that I am closing with an unknown result. A cancellation request will be sent, and visible tabs will not recover automatically.",
  結果不明のまま閉じる: "Close with unknown result",
};
