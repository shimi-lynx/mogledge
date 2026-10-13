// Controller state and native error codes stay unchanged. These translations
// apply only when rendering app diagnostics, including their known prefixes.
export const errorMessages: Readonly<Record<string, string>> = {
  見つかりません: "Not found",
  別の文書に置き換わっています: "Replaced with a different document",
  一時的に読み取れません: "Temporarily unreadable",
  HTMLが削除または移動されました: "The HTML file was deleted or moved",
  閲覧中のHTMLが削除または移動されました: "The open HTML file was deleted or moved",
  別の操作が完了するまでお待ちください: "Wait for the current operation to finish",
  作業フォルダーが変更されました: "The selected root folder changed",
  "ごみ箱に移動しました。復元はOSのごみ箱で行ってください":
    "Moved to the recycle bin. Restore it using your operating system's recycle bin.",
  順序を保存しました: "Order saved",
  "移動しました。相対参照は変更していません": "Moved. Relative references were preserved.",
  "名前を変更しました。相対参照は変更していません": "Renamed. Relative references were preserved.",
  作成しました: "Created",
  HTMLをOSのごみ箱へ移動しました: "The HTML file was moved to the system recycle bin",
  閲覧中のHTMLをOSのごみ箱へ移動しました: "The open HTML file was moved to the system recycle bin",
  ファイル操作に失敗しました: "The file operation failed",
  旧view解除の応答を確認できません: "Could not confirm release of the previous view",
  "対象の表示を更新できませんでした。明示再読み込みを行ってください":
    "Could not refresh the target view. Reload it explicitly.",
  この環境では入力状態の引き継ぎを利用できません:
    "Transferring saved input is not available in this environment",
  "対象のHTMLが見つかりません。ツリーから選び直してください":
    "The target HTML file was not found. Select it again in the tree.",
  このHTMLに引き継げる以前の入力状態はありません:
    "This HTML has no previous saved input to transfer",
  以前の入力状態を引き継ぎました: "Previous saved input transferred",
  "このHTMLには入力状態が既に保存されています。以前の状態は上書きできません":
    "This HTML already has saved input. Previous input cannot overwrite it.",
  "HTMLまたは以前の入力状態が変更されました。もう一度引き継ぎ操作を行ってください":
    "The HTML or previous saved input changed. Start the transfer again.",
  入力状態を引き継げません: "Could not transfer saved input",
  フルパスをコピーしました: "Full path copied",
  OSへフォルダーの表示を依頼しました: "Asked the operating system to show the folder",
  "既定ブラウザーへ表示を依頼しました。URLは作業フォルダー変更・画面再起動・アプリ終了で失効します":
    "Asked the default browser to open the document. The URL expires when the root changes, the app view restarts, or the app exits.",
  作業セットを読み取れません: "Could not read workspace sets",
  タブが変更されました: "The tab changed",
  作業セットを保存できません: "Could not save the workspace set",
  "タブの読み込み・終了後に作業セットを呼び出してください":
    "Wait for tabs to finish loading or closing before restoring a workspace set",
  "作業セットを準備しました。既存タブと現在の倍率を保持しています":
    "Workspace set prepared. Existing tabs and the current zoom were preserved.",
  作業セットを呼び出せません: "Could not restore the workspace set",
  端末設定を読み取れません: "Could not read device settings",
  お気に入りを保存できません: "Could not save favorites",
  "既存タブは別の文書です。先にそのタブを閉じてください":
    "The existing tab belongs to a different document. Close that tab first.",
  文書を開けません: "Could not open the document",
  フォルダーを開けません: "Could not open the folder",
  最近の文書を保存できません: "Could not save recent documents",
  履歴のfragmentが見つかりません: "The history fragment was not found",
  fragmentが見つかりません: "The fragment was not found",
  履歴の表示確認が完了しませんでした: "The history view could not be confirmed",
  この環境では履歴移動を利用できません: "Document history is not available in this environment",
  文書の読み込み完了後にもう一度お試しください: "Try again after the document finishes loading",
  文書を読み取れません: "Could not read the document",
  fragmentが無効です: "The fragment is invalid",
  履歴を開けません: "Could not open document history",
  この環境ではリンク移動を利用できません: "Document links are not available in this environment",
  リンクを開けません: "Could not open the link",
  この環境では外部リンクを利用できません: "External links are not available in this environment",
  既定ブラウザーへ外部リンクの表示を依頼しました:
    "Asked the default browser to open the external link",
  外部リンクを開けません: "Could not open the external link",
  タブを閉じられません: "Could not close the tab",
  WorkspaceChanged: "The selected root changed (WorkspaceChanged)",
  ViewChanged: "The app view changed (ViewChanged)",
  TabClosed: "The tab was closed (TabClosed)",
  Superseded: "A newer operation replaced this request (Superseded)",
  StorageUnavailable: "Saved storage is unavailable (StorageUnavailable)",
  DocumentChanged: "The document changed (DocumentChanged)",
  IdentityChanged: "The document identity changed (IdentityChanged)",
  RecoveryChanged: "The previous saved input changed (RecoveryChanged)",
  StateConflict: "Saved input already exists and cannot be overwritten (StateConflict)",
  ResourceBusy: "The file or folder is in use (ResourceBusy)",
  InvalidRequest: "The request is invalid (InvalidRequest)",
  QuotaExceeded: "The storage limit was reached (QuotaExceeded)",
  Revoked: "Access to this view was revoked (Revoked)",
  StorageBusy: "Saved storage is in use (StorageBusy)",
  StorageCorrupt: "Saved storage could not be validated (StorageCorrupt)",
  StorageIdentityUnavailable: "The storage identity is unavailable (StorageIdentityUnavailable)",
  Error: "Error",
  "既存の保存状態を置換するため、先に新しい平文backup先を選んでください。":
    "Choose a new unencrypted backup file before replacing existing saved input.",
  "結果を確認できません。再実行せず「処理結果を照会」を使ってください":
    "The result could not be confirmed. Use Check operation result instead of running it again",
  "応答が確認した対象と一致しません。処理結果を照会してください。":
    "The response does not match the confirmed target. Check the operation result.",
  "保存済み入力を取り込みました。対象の実表示タブを再読み込みしました。外部ブラウザーは明示的に開き直してください。":
    "Saved input imported and the target app tabs reloaded. Reopen any external browser view explicitly.",
  "確定済みの保存状態を書き出しました。未確認の入力全体が保存されたことを意味しません。":
    "Confirmed saved input exported. This does not mean that all unconfirmed input was saved.",
  "取り込みは完了しましたが、表示更新または旧view解除を確認できません":
    "Import completed, but refreshing the view or releasing the previous view could not be confirmed",
  "照会できません。結果は不明のままです":
    "The operation could not be checked. Its result is still unknown",
  "取り消しました。タブは閉じていません。": "Cancelled. Tabs were not closed.",
  "取消結果は不明です。処理結果を照会してください":
    "The cancellation result is unknown. Check the operation result",
  照合応答が対象と一致しません: "The verification response does not match the target",
  "現在の保存値は選択ファイルと一致します。過去の処理成功・取消・未保存入力の保全を証明しません。":
    "Current saved values match the selected file. This does not prove a previous operation succeeded, was cancelled, or preserved unsaved input.",
  "現在の保存値は選択ファイルと一致しません。過去の処理成功・取消・未保存入力の保全を証明しません。":
    "Current saved values do not match the selected file. This does not prove a previous operation succeeded, was cancelled, or preserved unsaved input.",
  現在値を照合できません: "Could not verify current saved values",
  あり: "yes",
  なし: "no",
  "あり（自動復活しません。必要なタブを明示再読み込み）":
    "yes (not restored automatically; reload the required tabs explicitly)",
  "処理失敗: {code}。grant失効: {revoked}。backup公開: {backup}。export公開: {exported}。":
    "Operation failed: {code}. Browser grants revoked: {revoked}. Backup published: {backup}. Export published: {exported}.",
  "処理状態: {status}。取消要求や期限切れだけでは実行結果を断定できません。必要なら再照会してください。":
    "Operation status: {status}. A cancellation request or expiry alone does not establish the execution result. Check again if needed.",
  pending: "pending",
  processing: "processing",
  cancel_requested: "cancellation requested",
  cancelled: "cancelled",
  expired: "expired",
};
