export const residentMessages: Readonly<Record<string, string>> = {
  常駐と呼び出し: "Resident mode and recall",
  常駐設定を読み込み中: "Loading resident preferences",
  常駐設定を読み取れません: "Cannot read resident preferences",
  常駐設定を更新できません: "Cannot update resident preferences",
  アプリを常駐させる: "Keep the app running",
  "有効時は閉じるボタンでトレイに隠れます。トレイの表示で戻り、終了でアプリを終了します。":
    "When enabled, closing hides the window to the tray or menu bar. Choose Show to return or Quit to exit.",
  キー操作で呼び出す: "Recall with a key sequence",
  "Windows: Shift → Ctrl → Shift、macOS: Shift → Cmd → Shift。各キーを一つずつ押して離します。同時押しではありません。":
    "Windows: Shift → Ctrl → Shift; macOS: Shift → Cmd → Shift. Press and release each key separately, in order.",
  "全キーを離してから始め、全体1.5秒以内、各押下400ms以内で操作してください。途中の通常キーや同時押しは取り消します。":
    "Release all keys before starting. Complete within 1.5 seconds, holding each key for at most 400 ms. Other keys or overlapping modifiers cancel the sequence.",
  "キー入力の内容は記録しません。": "Input contents are never recorded.",
  順次キー操作を待機しています: "Waiting for the modifier sequence",
  同時押しの呼び出しキーを待機しています: "Waiting for the custom shortcut",
  呼び出しキー: "Recall shortcut",
  呼び出しキーの方式: "Recall shortcut mode",
  標準の順次押し: "Standard modifier sequence",
  カスタムの同時押し: "Custom simultaneous shortcut",
  "有効な呼び出しキー: {shortcut}": "Effective shortcut: {shortcut}",
  "有効な呼び出しキー: 標準の順次押し": "Effective shortcut: standard modifier sequence",
  "全体1.5秒以内、各押下400ms以内。順に離してください。途中の通常キーや長い同時押しは取り消します。キー入力の内容は記録しません。":
    "Complete within 1.5 seconds, holding each key for at most 400 ms. Release them in order. Other keys or prolonged overlaps cancel the sequence. Input contents are never recorded.",
  "記録ボタンにフォーカスしたまま、Ctrl・Alt・Cmd/Winのいずれかと通常キーを同時に押してください。Shiftも追加できます。":
    "With the record button focused, press an ordinary key together with Ctrl, Alt or Cmd/Win. You can also add Shift.",
  "適用するキー: {shortcut}": "Shortcut to apply: {shortcut}",
  呼び出しキーは未記録です: "No shortcut recorded",
  呼び出しキーを記録: "Record recall shortcut",
  "記録中… Escapeで中止": "Recording… Escape to cancel",
  "Ctrl・Alt・Cmd/Winのいずれかと通常キーを組み合わせてください":
    "Combine an ordinary key with Ctrl, Alt or Cmd/Win",
  "記録しただけでは変更しません。登録に成功しても、他のアプリのすべてのショートカットとの競合がないことは保証できません。":
    "Recording does not change the effective shortcut. Successful registration does not guarantee freedom from conflicts with every other app shortcut.",
  標準の順次押しに戻す: "Restore standard sequence",
  呼び出しキーを適用: "Apply recall shortcut",
  "常駐OFFでは呼び出しキーを解除します。選んだ設定は次回起動にも引き継ぎます。":
    "Turning resident mode off unregisters the shortcut. Your chosen setting is restored at the next launch.",
  "呼び出しキーを利用できません。通常起動またはトレイから表示できます":
    "The recall shortcut is unavailable. Launch normally or choose Show from the tray or menu bar.",
  呼び出しキーを再確認: "Retry recall shortcut",
  "呼び出しキーを登録できません。別の組み合わせを選んでください":
    "Cannot register the recall shortcut. Choose a different combination.",
  "以前の呼び出しキーを復元できません。設定を再確認してください":
    "Cannot restore the previous recall shortcut. Check the settings again.",
  "呼び出しキーを解除できません。設定を再確認してください":
    "Cannot unregister the recall shortcut. Check the settings again.",
  "標準の順次押しにはmacOSの入力監視の許可が必要です。現在の呼び出しキーを保持します":
    "The standard sequence requires macOS Input Monitoring permission. Keeping the current recall shortcut.",
  順次キー操作にはmacOSの入力監視の許可が必要です:
    "macOS Input Monitoring permission is required for the sequence",
  "順次キー操作を利用できません。通常起動またはトレイから表示できます":
    "The sequence is unavailable. Launch normally or choose Show from the tray or menu bar.",
  常駐は無効です: "Resident mode is off",
  "トレイを準備できないため画面を隠しません。通常起動で設定を変更できます。":
    "The tray is unavailable, so the window stays visible. Launch normally to change preferences.",
  "「入力監視の設定を開く」から、このアプリを利用者自身で許可してください。開けない場合は、macOSのプライバシーとセキュリティ（旧版ではセキュリティとプライバシー）→ 入力監視を開いてください。アプリは自動許可しません。許可後はここに戻り、「許可後に再確認」を押してください。":
    'Use "Open Input Monitoring settings" to allow this app yourself. If it does not open, go to macOS Privacy & Security (Security & Privacy on older versions) → Input Monitoring. The app cannot grant permission itself. Then return here and select "Check after granting permission".',
  入力監視の設定を開く: "Open Input Monitoring settings",
  許可後に再確認: "Check after granting permission",
  順次キー操作を再確認: "Retry modifier sequence",
  呼び出したときの表示: "View on recall",
  "固定したHTML: {path}": "Pinned HTML: {path}",
  呼び出し時の表示を保持: "Keep the view on recall",
  固定を解除: "Unpin",
  このHTMLを固定: "Pin this HTML",
  "呼び出したときに表示するHTMLを固定します。固定しない場合は、現在の表示をそのまま使います。":
    "Pin the HTML to show on recall. Without a pin, recall keeps the current view.",
  ログイン時の起動: "Startup at sign-in",
  "指定できるのは現在のルート内のHTML1つです。移動・削除・ルート変更で確認できなければ現在の表示を保持します。開いているタブを再利用します。":
    "Pin one HTML in the current root. If it cannot be verified after a move, deletion or root change, keep the current view. Reuse an existing tab when possible.",
  OSへのログイン時にアプリを起動する: "Start the app when signing in to the OS",
  "自動起動は常駐とは別の設定で、初期値は無効です。起動時は画面を表示します。開発用アプリでは登録しません。":
    "Autostart is independent of resident mode and off by default. Startup shows the window. Development builds cannot register autostart.",
  "常駐中も開いているHTMLの処理は残ります。画面を隠すだけでCPU使用やメモリがなくなる保証はありません。":
    "Open HTML continues to exist in resident mode. Hiding the window does not guarantee that CPU or memory usage stops.",
  常駐はWindowsとmacOSのNativeアプリで利用できます:
    "Resident mode is available in the Windows and macOS native apps",
  順次キー操作の監視を開始できません: "Cannot start monitoring the modifier sequence",
  このアプリ内の別の入力監視と競合しています:
    "Another input monitor in this app conflicts with the sequence",
  macOSの入力監視を利用者自身で許可してください: "Manually grant macOS Input Monitoring permission",
  "入力監視の設定を開けません。システム設定から確認してください":
    "Cannot open Input Monitoring settings. Open System Settings manually.",
  このOSでは入力監視の追加許可は不要です:
    "This OS does not require additional Input Monitoring permission",
  "トレイを準備できません。画面は表示したままです":
    "Cannot prepare the tray. The window remains visible.",
  画面を戻せないため常駐を解除しません:
    "Cannot restore the window, so resident mode remains enabled",
  自動起動の登録と解除は正式な配布アプリで行ってください:
    "Register or remove autostart using the installed distribution app",
  自動起動の登録または解除に失敗しました: "Could not register or remove autostart",
  "旧版の自動起動登録が残っています。更新前に旧アプリで自動起動を解除し、更新後にMogledgeで有効にしてください。更新済みの場合は旧登録を確認して解除するまで変更しません。":
    "An earlier autostart registration remains. Disable autostart in the old app before updating, then enable it in Mogledge afterward. If already updated, inspect and remove the old registration yourself before changing this setting.",
  "OSの自動起動登録を元に戻せません。登録状態を再確認してください":
    "Could not restore the OS autostart registration. Check its current state again.",
  OSの自動起動登録状態は不明です: "The OS autostart registration state is unknown",
  "常駐設定は読み取り専用です。保存内容を保持します":
    "Resident preferences are read-only. Saved contents are preserved.",
  常駐設定が無効です: "Invalid resident preferences",
  "指定したHTMLを確認できません。現在の表示を保持します":
    "Cannot verify the pinned HTML. Keeping the current view.",
  "呼び出すHTMLを確認できません。現在の表示を保持します":
    "Cannot verify the HTML to recall. Keeping the current view.",
  "常駐設定が16KiBを超えています。原本を保持します":
    "Resident preferences exceed 16 KiB. The original is preserved.",
  常駐設定が上限を超えています: "Resident preferences exceed their size limit",
  常駐設定が外部で変更されました: "Resident preferences changed outside the app",
  "常駐設定が外部で変更されました。再起動して確認してください":
    "Resident preferences changed outside the app. Restart to inspect them.",
  "常駐設定が未対応または無効です。保存内容を保持します":
    "Unsupported or invalid resident preferences. Saved contents are preserved.",
  常駐設定の一時ファイルを作れません: "Cannot create a temporary resident preferences file",
  常駐設定の保存先が未初期化です: "The resident preferences directory is not ready",
  常駐設定は通常ファイルではありません: "Resident preferences are not an ordinary file",
  常駐設定を保存できません: "Cannot save resident preferences",
  "常駐設定を安全に読めません。保存内容を保持します":
    "Cannot safely read resident preferences. Saved contents are preserved.",
  常駐設定を書き込めません: "Cannot write resident preferences",
  常駐設定を検証できません: "Cannot validate resident preferences",
  常駐設定を読めません: "Cannot read resident preferences",
  "常駐設定を読めません。保存内容を上書きせず保持します":
    "Cannot read resident preferences. Saved contents will not be overwritten.",
  対象を確認できません: "Cannot verify the target",
  "対象HTMLが変更されました。再選択してください": "The target HTML changed. Select it again.",
  対象HTMLを識別できません: "Cannot identify the target HTML",
  対象のルートを識別できません: "Cannot identify the target root",
  作業フォルダーが置き換えられました: "The workspace folder was replaced",
  作業フォルダーを選択してください: "Choose a workspace folder",
};
