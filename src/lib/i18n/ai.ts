export const aiMessages: Readonly<Record<string, string>> = {
  AIにパスを渡す: "Send path to AI",
  AIに渡す: "Send to AI",
  ルートフォルダーの操作: "Root folder actions",
  "ファイル内容は添付しません。送信・実行は相手の画面で確認してください。":
    "File contents are not attached. Review the draft in the receiving app before sending or running it.",
  連携先: "Destination",
  パスを確認しています: "Checking the selected path",
  "依頼文（任意）": "Request (optional)",
  "選択パスは依頼文に自動で含まれます。空欄ならパスだけを渡します。":
    "The selected path is included automatically. Leave this blank to send only the path.",
  "フォルダーは作業ディレクトリーに指定します。本文には依頼文だけを渡し、空欄なら本文なしで開きます。コピーにはフォルダーパスも含めます。":
    "The folder is set as the working directory. Only your request goes in the draft; leave it blank to open an empty draft. Copies also include the folder path.",
  "コピーにはフォルダーパスを含めます。作業ディレクトリーは相手側で選んでください。空欄ならパスだけをコピーします。":
    "Copies include the folder path. Choose the working directory in the receiving app. Leave this blank to copy only the path.",
  "この連携先の下書き本文は{limit}文字以内です。短くするか本文をコピーしてください":
    "The draft for this destination must be within {limit} characters. Shorten it or copy the text instead.",
  "この連携先の文字数上限を超えています。依頼文を短くするか依頼文をコピーしてください。切り詰めません。":
    "This destination's character limit has been exceeded. Shorten the request or copy it instead. The text will not be truncated.",
  依頼文をコピー: "Copy request",
  "対象のパスを確認できません。項目を選び直して確認画面を開き直してください。":
    "The selected path could not be verified. Select the item again and reopen this dialog.",
  "依頼文をコピーしました。相手の入力欄に貼り付け、確認して送信してください。":
    "Request copied. Paste it into the receiving app, review it, then send it.",
  "OSに開く操作を依頼しました。相手の下書きを確認して送信してください。開かなければ依頼文をコピーしてください。受信・表示は確認できません。":
    "An open request was sent to the OS. Review the draft in the receiving app before sending. If it does not open, copy the request instead. Receipt and display cannot be verified.",
  "受け渡しできませんでした。対象の変更、連携先の導入・リンク登録、長文や特殊文字を確認してください。短くするか依頼文をコピーし、対象が変わった場合は確認画面を開き直してください。":
    "The handoff failed. Check for changes to the target, destination installation and link registration, and long text or special characters. Shorten or copy the request. If the target changed, reopen this dialog.",
  "ChatGPT / Codex アプリ": "ChatGPT / Codex app",
  "未送信の下書きを開きます。登録済みの codex リンク対応アプリを使います。":
    "Opens an unsent draft in the app registered to handle codex links.",
  "Claude Code アプリ": "Claude Code app",
  "未送信の下書きを開きます。作業フォルダーはClaude側でも確認されます。本文12,000文字まで。":
    "Opens an unsent draft. Claude also confirms the working folder. Up to 12,000 characters in the draft.",
  "Codex CLI（コピー）": "Codex CLI (copy)",
  "コピーのみです。codex を手動で起動し、依頼文を貼り付けて確認・送信してください。":
    "Copy only. Start codex manually, paste the request, review it, then send it.",
  "Claude Code CLI": "Claude Code CLI",
  "未送信の下書きをターミナルで開きます。確認後にEnterで送信します。本文5,000文字まで。初回の対話CLIで依頼文を送信した後にhandlerが登録されます。":
    "Opens an unsent draft in a terminal. Review it, then press Enter to send. Up to 5,000 characters in the draft. The handler is registered after sending a request in the first interactive CLI session.",
  "クリップボードにコピーできませんでした。入力した依頼文は保持しています。もう一度コピーしてください。":
    "The request could not be copied to the clipboard. Your input has been kept. Try copying again.",
  "クリップボードを使用できませんでした。少し待ってから、もう一度コピーしてください。":
    "The clipboard could not be accessed. Wait a moment, then try copying again.",
  "このOSでは依頼文のコピーに対応していません。": "Copying requests is not supported on this OS.",
  "対象が変更されました。入力した依頼文を控えてから、確認画面を開き直してください。":
    "The target changed. Keep a separate copy of your input before reopening this dialog.",
  "依頼文は65,536文字以内にし、不可視制御文字を除いてください。入力した依頼文は保持しています。":
    "Keep the request within 65,536 characters and remove invisible control characters. Your input has been kept.",
  "コピーの完了を確認できませんでした。入力した依頼文は保持しています。クリップボードの内容を確認し、必要ならもう一度コピーしてください。":
    "Copy completion could not be verified. Your input has been kept. Check the clipboard contents and copy again if needed.",
};
