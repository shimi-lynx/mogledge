export const appUpdaterMessages: Readonly<Record<string, string>> = {
  アプリの更新: "App updates",
  "設定画面から手動で確認します。起動時や常駐中に自動確認しません。":
    "Check manually from Settings. The app does not check at startup or while resident.",
  "現在のバージョン: {version}": "Current version: {version}",
  更新の設定を読み込み中: "Loading update settings",
  更新を確認中: "Checking for updates",
  ダウンロードと署名検証中: "Downloading and verifying the signature",
  "署名検証が完了しました。再起動して更新を適用できます。":
    "Signature verified. Restart to apply the update.",
  更新を適用して再起動中: "Applying the update and restarting",
  利用できる更新はありません: "No update is available",
  "更新を取り消しました。アプリは変更されていません。":
    "Update cancelled. The app has not been changed.",
  "配布URLまたは更新用公開鍵が未設定のため、アプリ内更新は無効です。配布元の案内を確認してください。":
    "In-app updates are disabled because the distribution URL or update public key is not configured. See the distributor's instructions.",
  アプリ内更新はWindowsとmacOSの対応配布版で利用できます:
    "In-app updates are available in supported Windows and macOS distributions",
  "この単体アプリは更新対象ではありません。配布元の手動更新手順を利用してください。":
    "This standalone app is not enrolled in updates. Follow the distributor's manual update instructions.",
  "このビルドではアプリ内更新を利用できません。独自ビルドは自動で配布版へ置換しません。ソースまたは配布元の手動更新手順を利用してください。":
    "In-app updates are disabled in this build. Custom builds are not automatically replaced by a distribution build. Follow the source or distributor's manual update instructions.",
  "更新バージョン: {version}": "Update version: {version}",
  更新内容: "Release notes",
  更新内容は配布元から提供されていません: "The distributor did not provide release notes",
  ダウンロード進捗: "Download progress",
  "{downloaded} / {total} MiB": "{downloaded} / {total} MiB",
  "{downloaded} MiB ダウンロード済み（総容量は不明）":
    "{downloaded} MiB downloaded (total size unknown)",
  "再起動で開いているHTMLの未保存入力やCanvas・実行状態は失われます。各HTMLの保存操作を完了してから進めてください。アプリは未保存内容を自動判定・保存できません。":
    "Restarting loses unsaved HTML inputs, Canvas and running state. Finish saving in each HTML app before continuing. Mogledge cannot automatically detect or save unsaved content.",
  "必要な入力を保存し、アプリを終了して更新することを確認しました":
    "I have saved the inputs I need and confirm closing the app to update",
  "Windowsはインストーラーでアプリを終了・更新して再起動します。macOSはアプリを置換して再起動します。適用開始後は取り消せません。":
    "On Windows the installer closes, updates and restarts the app. On macOS the app is replaced and restarted. Applying an update cannot be cancelled once it starts.",
  更新を確認: "Check for updates",
  ダウンロードして更新: "Download update",
  再起動して更新を適用: "Restart and apply update",
  更新を取り消す: "Cancel update",
  "ダウンロード後も再起動を選ぶまでアプリは変更しません。設定を閉じても処理は続き、開き直すと状態を確認できます。取消は適用開始前に行ってください。":
    "Downloading does not change the app until you choose to restart. Closing Settings keeps the operation running; reopen it to see the status. Cancel before applying the update.",
  このビルドではアプリ内更新を利用できません: "In-app updates are disabled in this build",
  更新処理が進行中です: "An update operation is in progress",
  "更新を確認できません。ネットワークと配布元を確認し、再試行してください。":
    "Could not check for updates. Check the network and distributor, then try again.",
  "ダウンロードに失敗しました。アプリは変更されていません。更新を再確認してください。":
    "Download failed. The app has not been changed. Check for updates again.",
  "更新の署名を検証できません。安全のため適用しません。配布元に確認してください。":
    "Could not verify the update signature. The update will not be applied. Contact the distributor.",
  "更新が256MiBの上限を超えています。手動更新の案内を確認してください。":
    "The update exceeds the 256 MiB limit. See the manual update instructions.",
  HTMLの入力を保存してから確認してください: "Save your HTML inputs before confirming",
  "アプリの設定を保存できないため更新を中止しました。設定を確認し、更新を再確認してください。":
    "The update stopped because app settings could not be saved. Check the settings and check for updates again.",
  "更新を適用できません。現在のアプリと配布元の手動復旧手順を確認してください。":
    "Could not apply the update. Check the current app and the distributor's manual recovery instructions.",
  "更新の状態を確認できません。Nativeアプリで設定を開き直してください。":
    "Could not read the update status. Reopen Settings in the Native app.",
};
