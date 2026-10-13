// Published Native diagnostics are translated at the shell display boundary.
// The native strings, error codes and permission checks are unchanged.
export const nativeMessages: Readonly<Record<string, string>> = {
  この操作はアプリの確認画面だけで利用できます:
    "This operation is available only in the app confirmation dialog",
  対象を確認できません: "Could not verify the target",
  操作ウィンドウを確認できません: "Could not verify the operation window",
  受け渡しに失敗しました: "The handoff failed",
  文書を確認できません: "Could not verify the document",
  フォルダーを確認できません: "Could not verify the folder",
  作業セットを変更できません: "Could not change the workspace set",
  作業セットを確認できません: "Could not verify the workspace set",
  索引状態を取得できません: "Could not retrieve index status",
  検索処理に失敗しました: "Search failed",
  索引を再構築できません: "Could not rebuild the index",
  リンクを確認できません: "Could not verify the link",
  履歴を確認できません: "Could not verify document history",
  対象が見つかりません: "The target was not found",
  "knowledgeフォルダが置き換えられました。再走査してください":
    "The knowledge folder was replaced. Refresh the tree.",
  フォルダーはブラウザーで表示できません: "Folders cannot be displayed in a browser",
  親フォルダを解決できません: "Could not resolve the parent folder",
  親フォルダーを解決できません: "Could not resolve the parent folder",
  このパスの文字コードは利用できません: "The path encoding is not supported",
  OSで同じ対象を扱えないファイル名です:
    "This filename cannot identify the same target in the operating system",
  "ローカルの絶対パスが必要です。ネットワーク・不可視文字を含むパスは利用できません":
    "A local absolute path is required. Network paths and paths with invisible characters are not allowed.",
  "依頼文は65,536文字以内にし、不可視制御文字を除いてください":
    "Keep the request within 65,536 characters and remove invisible control characters",
  "Codex CLIには本文をコピーして手動で貼り付けてください":
    "Copy the request and paste it into Codex CLI manually",
  "この連携先の下書きはパス込みで{limit}文字以内です。短くするか本文をコピーしてください":
    "This destination accepts drafts up to {limit} characters including the path. Shorten the request or copy it.",
  "エンコード後のリンクが長すぎます。短くするか本文をコピーしてください":
    "The encoded link is too long. Shorten the request or copy it.",
  "対象が変更されました。確認画面を開き直してください":
    "The target changed. Reopen the confirmation dialog.",
  "名前には1〜200文字を使い、区切り・隠し名・末尾の空白やドットを避けてください":
    "Use 1–200 characters for the name. Avoid separators, hidden names, trailing spaces and trailing dots.",
  Windowsの予約名は利用できません: "Windows reserved names are not allowed",
  親フォルダーを読み取れません: "Could not read the parent folder",
  "同じ名前の項目があります（大文字・小文字を区別しません）":
    "An item with the same name already exists (case-insensitive)",
  移動対象を確認できません: "Could not verify the item to move",
  移動対象を読み取れません: "Could not read the item to move",
  この名前の文字コードは利用できません: "The name encoding is not supported",
  リンクやクラウド上の項目を含むフォルダーは移動できません:
    "Folders containing links or cloud items cannot be moved",
  "リンク/reparseや特殊ファイルを含むフォルダーは移動できません":
    "Folders containing links, reparse points or special files cannot be moved",
  安全なファイル検証を開始できません: "Could not begin safe file verification",
  保持済みクラウドフォルダー内だけに作成できます:
    "Creation requires a locally retained synchronized folder",
  同期フォルダー内では空フォルダーだけを移動できます:
    "Only empty folders can be moved inside synchronized folders",
  同期フォルダー内では位置指定の移動に対応していません:
    "Moves with a specified position are not supported inside synchronized folders",
  "同期フォルダー内ではごみ箱・並べ替えに対応していません":
    "Trash and reordering are not supported inside synchronized folders",
  "同じ親や自分自身・子孫へは移動できません":
    "Cannot move to the same parent, itself or a descendant",
  "操作対象を開けません。アクセス権・リンク・ロックを確認してください":
    "Could not open the item. Check permissions, links and locks.",
  操作対象を確認できません: "Could not verify the item",
  "操作が完了した可能性がありますが、確認を完了できませんでした。再試行や削除をせず、再読み込みで状態を確認してください":
    "The operation may have completed, but verification could not finish. Do not retry or delete items; refresh to inspect the result.",
  "ツリーが変更されました。対象を確認し直してください":
    "The tree changed. Verify the target again.",
  ごみ箱に移動する対象が見つかりません: "The item to move to the recycle bin was not found",
  "対象を開けません。アクセス権・リンク・ロックを確認してください":
    "Could not open the target. Check permissions, links and locks.",
  "対象が変更されました。確認し直してください": "The target changed. Verify it again.",
  "対象が置き換えられました。確認し直してください": "The target was replaced. Verify it again.",
  親フォルダーが見つかりません: "The parent folder was not found",
  "HTMLを作成できません。アクセス権を確認してください":
    "Could not create the HTML file. Check permissions.",
  HTMLを書き込めません: "Could not write the HTML file",
  "HTMLを公開できません。同名・アクセス権・外部変更を確認してください":
    "Could not publish the HTML file. Check name conflicts, permissions and external changes.",
  "フォルダーを作成できません。同名・アクセス権を確認してください":
    "Could not create the folder. Check name conflicts and permissions.",
  名前変更対象が見つかりません: "The item to rename was not found",
  名前変更対象のHTMLが見つかりません: "The HTML file to rename was not found",
  名前変更対象のHTML拡張子が無効です: "The HTML extension of the item to rename is invalid",
  "名前変更対象を開けません。アクセス権・リンク・ロックを確認してください":
    "Could not open the item to rename. Check permissions, links and locks.",
  "名前変更対象が変更されました。再走査してください":
    "The item to rename changed. Refresh the tree.",
  名前変更対象を確認できません: "Could not verify the item to rename",
  "大文字・小文字だけの名前変更には対応していません":
    "Renaming only the letter case is not supported",
  "名前変更できません。同名・外部変更・アクセス権・ロックを確認してください":
    "Could not rename the item. Check name conflicts, external changes, permissions and locks.",
  "名前変更は完了しましたが、旧入力状態の場所情報を更新できません。保存状態そのものは保持されています":
    "Renaming completed, but the location of previous saved input could not be updated. The saved input itself was preserved.",
  移動対象が見つかりません: "The item to move was not found",
  移動先フォルダーが見つかりません: "The destination folder was not found",
  同じ親では並べ替えを使ってください: "Use reordering for items in the same parent folder",
  自分自身や子孫へは移動できません: "An item cannot be moved into itself or its descendants",
  移動先の同じ親にある項目を指定してください:
    "Select an item in the same parent folder at the destination",
  移動先の項目が見つかりません: "The destination item was not found",
  "移動対象を開けません。アクセス権・リンク・ロックを確認してください":
    "Could not open the item to move. Check permissions, links and locks.",
  "移動できません。同名・外部変更・アクセス権・ロックを確認してください":
    "Could not move the item. Check name conflicts, external changes, permissions and locks.",
  "移動は完了しましたが、旧入力状態の場所情報を更新できません。保存状態そのものは保持されています":
    "Moving completed, but the location of previous saved input could not be updated. The saved input itself was preserved.",
  "移動は完了しましたが、{error}。自動復元せず現在のファイルを保持します":
    "Moving completed, but {error}. Current files were preserved without automatic rollback.",
  "端末設定の保存を確認できません。ファイルを保持し、自動再試行しません":
    "Could not confirm saving device preferences. Files were preserved without automatic retries.",
  "順序の保存を確認できません。ファイルを保持し、自動再試行しません":
    "Could not confirm saving display order. Files were preserved without automatic retries.",
  項目が見つかりません: "The item was not found",
  "項目が変更されました。再走査してください": "The item changed. Refresh the tree.",
  "通常のフォルダを選択してください（リンクは利用できません）":
    "Select a normal folder (links are not allowed)",
  フォルダを読み取れません: "Could not read the folder",
  フォルダを解決できません: "Could not resolve the folder",
  フォルダを開けません: "Could not open the folder",
  フォルダ情報を読み取れません: "Could not read folder information",
  無効な相対パスです: "The relative path is invalid",
  隠しファイルや親ディレクトリにはアクセスできません:
    "Hidden files and parent directories cannot be accessed",
  knowledge外にはアクセスできません: "Access outside the knowledge folder is not allowed",
  "ファイルが見つからないか、読み取れません": "The file was not found or cannot be read",
  リンク先へのアクセスは禁止されています: "Access through links is not allowed",
  ファイルを解決できません: "Could not resolve the file",
  HTML以外の検索結果は開けません: "Search results other than HTML cannot be opened",
  検索結果のファイルが変更されました: "The search result file changed",
  検索結果のファイルが見つかりません: "The search result file was not found",
  knowledgeフォルダーが置き換えられました: "The knowledge folder was replaced",
  フォルダーを開けません: "Could not open the folder",
  "フォルダーを開けません。リンクやアクセス権を確認してください":
    "Could not open the folder. Check links and permissions.",
  "フォルダーが変更されました。再走査してください": "The folder changed. Refresh the tree.",
  "knowledgeフォルダーが置き換えられました。再選択してください":
    "The knowledge folder was replaced. Select it again.",
  "knowledgeフォルダーが変更されました。再選択してください":
    "The knowledge folder changed. Select it again.",
  ルートを確認できません: "Could not verify the root folder",
  "対象が変更されました。再走査してください": "The target changed. Refresh the tree.",
  "対象を確認できません。リンクやアクセス権を確認してください":
    "Could not verify the target. Check links and permissions.",
  ファイル情報を読み取れません: "Could not read file information",
  通常のファイルのみ読み取れます: "Only normal files can be read",
  ファイルは32MB以下にしてください: "Keep the file within 32 MB",
  ファイルを読み取る権限がありません: "You do not have permission to read the file",
  ファイルが見つかりません: "The file was not found",
  "ファイルを開けないか、読み取れません": "The file cannot be opened or read",
  "knowledgeの走査に失敗しました。権限やフォルダの存在を確認してください":
    "Scanning the knowledge folder failed. Check permissions and that the folder exists.",
  順序の保存先が未初期化です: "The order storage location is not initialized",
  "順序を読み取れません。既定順で表示します":
    "Could not read the order. The default order will be used.",
  順序を読み取れません: "Could not read the order",
  順序の保存先が通常ファイルではありません: "The order storage location is not a normal file",
  "順序JSONが大きすぎます。既定順で表示します":
    "The order JSON is too large. The default order will be used.",
  "順序JSONが壊れています。既定順で表示します":
    "The order JSON is invalid. The default order will be used.",
  "順序JSONの形式が無効です。既定順で表示します":
    "The order JSON format is invalid. The default order will be used.",
  順序の保存先を作成できません: "Could not create the order storage location",
  順序を作成できません: "Could not create the order file",
  順序情報は1MiB以下にしてください: "Keep order information within 1 MiB",
  順序を保存できません: "Could not save the order",
  同じ親の別の項目を指定してください: "Select another item in the same parent folder",
  順序の項目が重複しています: "The order contains duplicate items",
  "{operation}は完了しましたが、{error}。保存済み順序で再走査しました":
    "{operation} completed, but {error}. The tree was refreshed using the saved order.",
  "{error}。並べ替えを適用せず再走査しました":
    "{error}. The tree was refreshed without applying the reorder.",
  "操作後の{error}。再走査してください": "After the operation: {error}. Refresh the tree.",
  invalid_format: "The saved input format is invalid (invalid_format)",
  unsupported_format: "The saved input format is not supported (unsupported_format)",
  invalid_source: "The saved input source is invalid (invalid_source)",
  invalid_app: "An app entry is invalid (invalid_app)",
  invalid_schema: "A schema entry is invalid (invalid_schema)",
  schema_conflict: "Saved input schemas conflict (schema_conflict)",
  transfer_limit: "The transfer size or count limit was reached (transfer_limit)",
  context_changed: "The selected root or app view changed (context_changed)",
  expired_plan: "The transfer confirmation expired (expired_plan)",
  explicit_backup_required:
    "Choose a new backup file before replacing saved input (explicit_backup_required)",
  explicit_confirmation_required:
    "Explicit confirmation is required (explicit_confirmation_required)",
  explicit_replace_confirmation_required:
    "Confirm replacing existing saved input (explicit_replace_confirmation_required)",
  explicit_stop_reload_confirmation_required:
    "Confirm stopping save access and reloading target views (explicit_stop_reload_confirmation_required)",
  invalid_active_views: "The active view selection is invalid (invalid_active_views)",
  invalid_html_target: "The HTML target is invalid (invalid_html_target)",
  invalid_selected_file_kind: "The selected file kind is invalid (invalid_selected_file_kind)",
  operation_cancelled: "The operation was cancelled (operation_cancelled)",
  plan_limit: "The transfer plan limit was reached (plan_limit)",
  plan_not_pending: "The transfer plan is no longer pending (plan_not_pending)",
  quota_exceeded: "The saved input quota was exceeded (quota_exceeded)",
  revision_limit: "The saved input revision limit was reached (revision_limit)",
  saved_state_unavailable: "Saved input is unavailable (saved_state_unavailable)",
  selected_file_changed: "The selected file changed (selected_file_changed)",
  selected_file_limit: "The selected file limit was reached (selected_file_limit)",
  selected_file_required: "Select a transfer file first (selected_file_required)",
  state_changed: "Saved input changed (state_changed)",
  state_corrupt: "Saved input could not be validated (state_corrupt)",
  state_unavailable: "Saved input is unavailable (state_unavailable)",
  target_changed: "The target changed (target_changed)",
  target_identity_changed: "The target identity changed (target_identity_changed)",
  target_quarantined_hold: "The target is held for safety checks (target_quarantined_hold)",
  target_unavailable: "The target is unavailable (target_unavailable)",
  transfer_busy: "Another transfer is in progress (transfer_busy)",
  transfer_file_changed: "The transfer file changed (transfer_file_changed)",
  unexpected_backup: "A backup file was supplied unexpectedly (unexpected_backup)",
  unknown_plan: "The transfer plan was not found (unknown_plan)",
  unsafe_profile: "The storage profile is not safe for this operation (unsafe_profile)",
  unsafe_transfer_path: "The transfer path is not safe for this operation (unsafe_transfer_path)",
  unsafe_transfer_file: "The transfer file is not safe for this operation (unsafe_transfer_file)",
  views_changed: "The target views changed (views_changed)",
  file_handle_limit: "The file handle limit was reached (file_handle_limit)",
  profile_file_forbidden:
    "An app profile file cannot be used for transfer (profile_file_forbidden)",
  transfer_file_exists: "The transfer file already exists (transfer_file_exists)",
  transfer_file_publish_failed:
    "The transfer file could not be published (transfer_file_publish_failed)",
  transfer_file_sync_failed:
    "The published transfer file could not be synced (transfer_file_sync_failed)",
  transfer_file_unavailable: "The transfer file is unavailable (transfer_file_unavailable)",
  transfer_file_write_failed: "The transfer file could not be written (transfer_file_write_failed)",
  設定保存先が未初期化です: "The settings storage location is not initialized",
  設定保存先が無効です: "The settings storage location is invalid",
  設定フォルダを作成できません: "Could not create the settings folder",
  設定を作成できません: "Could not create the settings file",
  設定を保存できません: "Could not save settings",
  設定を読み取れません: "Could not read settings",
  設定JSONが壊れています: "The settings JSON is invalid",
  設定のknowledgeRootが無効です: "The knowledgeRoot setting is invalid",
  knowledgeを選択してください: "Select a knowledge folder",
  HTMLが見つかりません: "The HTML file was not found",
  文書が置き換えられました: "The document was replaced",
  "HTMLをUTF-8で保存してください": "Save the HTML file as UTF-8",
  "名前変更は完了しましたが、{error}。保存済み順序で再走査しました":
    "Renaming completed, but {error}. The tree was refreshed using the saved order.",
  "移動は完了しましたが、{error}。保存済み順序で再走査しました":
    "Moving completed, but {error}. The tree was refreshed using the saved order.",
  "端末設定の形式が無効です。参照パスはUTF-8で4096bytes以下、お気に入りは合計50件までです":
    "The device settings format is invalid. Reference paths must be UTF-8 within 4,096 bytes, and favorites are limited to 50 in total.",
  端末設定を作成できません: "Could not create device settings",
  "端末設定は256KiB以下にしてください。保存済みの内容は保持します":
    "Keep device settings within 256 KiB. Previously saved contents were preserved.",
  端末設定の保存先が未初期化です: "The device settings storage location is not initialized",
  端末設定フォルダーを作成できません: "Could not create the device settings folder",
  端末設定フォルダーを読み取れません: "Could not read the device settings folder",
  "端末設定を読み取れません。保存済みの内容は保持します":
    "Could not read device settings. Previously saved contents were preserved.",
  端末設定が通常ファイルではありません: "Device settings are not a normal file",
  端末設定が256KiBを超えています: "Device settings exceed 256 KiB",
  "端末設定JSONが壊れています。上書きせず保持します":
    "The device settings JSON is invalid. It will be preserved without overwriting.",
  "旧端末設定が64KiBを超えています。原本を保持します":
    "Previous device settings exceed 64 KiB. The original will be preserved.",
  "旧端末設定の形式が無効です。原本を保持します":
    "The previous device settings format is invalid. The original will be preserved.",
  "端末設定の形式が無効です。原本を保持します":
    "The device settings format is invalid. The original will be preserved.",
  "未対応の端末設定です。上書きせず保持します":
    "This device settings format is not supported. It will be preserved without overwriting.",
  "端末設定の形式が無効です。上書きせず保持します":
    "The device settings format is invalid. It will be preserved without overwriting.",
  作業フォルダーの識別情報を取得できません: "Could not retrieve the root folder identity",
  "保存できない作業フォルダーが8件あります。設定の書き込み先を確認してください":
    "Eight root folders have settings that could not be saved. Check the settings storage location.",
  端末設定は読み取り専用です: "Device settings are read-only",
  端末設定を検証できません: "Could not validate device settings",
  端末設定の保存先が通常ファイルではありません:
    "The device settings storage location is not a normal file",
  端末設定の保存先を検証できません: "Could not validate the device settings storage location",
  "端末設定が外部で変更されました。上書きせず保持します。保存できない最近の記録はアプリ終了まで保持します":
    "Device settings changed externally and will be preserved without overwriting. Recent records that cannot be saved will be kept until the app exits.",
  端末設定を保存できません: "Could not save device settings",
  "端末設定を保存できません。元の保存内容は保持します":
    "Could not save device settings. Previously saved contents were preserved.",
  "作業フォルダーが置き換えられました。再走査してください":
    "The root folder was replaced. Refresh the tree.",
  フォルダーの識別情報を取得できません: "Could not retrieve the folder identity",
  "文書・フォルダーが見つかりません": "The document or folder was not found",
  "お気に入りは文書・フォルダー合計50件までです。先に解除してください":
    "Favorites are limited to 50 documents and folders in total. Remove an existing favorite first.",
  "一覧が変更されました。もう一度開いてください": "The list changed. Open it again.",
  "フォルダーが欠落・置換されたか、一時的に読み取れません。再走査後に確認してください":
    "The folder is missing, replaced or temporarily unreadable. Refresh the tree and check again.",
  "文書が欠落・置換されたか、一時的に読み取れません。再走査後に確認してください":
    "The document is missing, replaced or temporarily unreadable. Refresh the tree and check again.",
  文書の表示完了後にもう一度選択してください:
    "Select the document again after its view finishes loading",
  文書の識別情報を取得できません: "Could not retrieve the document identity",
  "この一覧の文書パスはUTF-8で4096bytes以下にしてください":
    "Document paths in this list must be UTF-8 within 4,096 bytes",
  "作業セットは10組、各30項目までです":
    "Workspace sets are limited to 10 sets with up to 30 items each",
  文書の読み込み完了後に保存してください: "Save after the document finishes loading",
  文書の識別情報がありません: "The document has no identity information",
  "文書が移動・置換されています。再走査後に確認してください":
    "The document was moved or replaced. Refresh the tree and check again.",
  保存対象の文書が変更されました: "The document to save changed",
  "セット名は160bytes以下、文書は各列で重複させず、倍率は50〜200%にしてください":
    "Keep set names within 160 bytes, avoid duplicate documents in each column, and use zoom from 50% to 200%",
  セットが変更されました: "The workspace set changed",
  セット名は空白以外で160bytes以下にしてください: "Use a non-blank set name within 160 bytes",
  フォルダーを保持できません: "Could not retain the folder handle",
  制作キットのフォルダーを作成できません: "Could not create the authoring kit folder",
  制作キットのフォルダーを確認できません: "Could not verify the authoring kit folder",
  制作キットのフォルダーは通常のローカルフォルダーである必要があります:
    "The authoring kit requires ordinary local folders",
  制作キットのフォルダーが変更されました: "The authoring kit folder changed",
  制作キットの固定パスが無効です: "The fixed authoring kit path is invalid",
  "制作キットのファイルを安全に読み取れません。元の内容を保持します":
    "Could not safely read the authoring kit file. Existing content is kept.",
  "制作キットの所有記録を読み取れません。元の内容を保持します":
    "Could not read the authoring kit ownership record. Existing content is kept.",
  "制作キットの所有記録は未対応または別のフォルダー用です。元の内容を保持します":
    "The ownership record is unsupported or belongs to another folder. Existing content is kept.",
  "制作ガイド設定を安全に読み取れません。元の設定を保持します":
    "Could not safely read the guide setting. The saved setting is kept.",
  "制作ガイド設定が未対応または破損しています。元の設定を保持します":
    "The guide setting is unsupported or damaged. The saved setting is kept.",
  制作ガイド設定が未対応または別のフォルダー用です:
    "The guide setting is unsupported or belongs to another folder",
  制作キットの保存先を確認できません: "Could not verify the authoring kit destination",
  制作キットを保存できません: "Could not save the authoring kit",
  "制作キットを保存できません。元の内容は保持します":
    "Could not save the authoring kit. Existing content is kept.",
  "制作キットの保存先が変更されたか、書き込めません。既存の内容は保持します":
    "The destination changed or could not be written. Existing content is kept.",
  "配置確認が失効しました。もう一度確認してください":
    "The setup preview expired. Preview the files again.",
  "配置確認が失効したか、読み取り専用です。もう一度確認してください":
    "The preview expired or is read-only. Preview the files again.",
  "制作キットの所有記録が変更されました。上書きしません":
    "The ownership record changed. It will not be overwritten.",
  "配置先が確認後に変更されました。上書きしません":
    "The destination changed after preview. It will not be overwritten.",
  所有記録を作成できません: "Could not create the ownership record",
  "制作ガイド設定が外部で変更されました。上書きしません":
    "The guide setting was changed externally. It will not be overwritten.",
  "制作ガイドを配置し、変更されていないことを確認してください":
    "Install the authoring guide and verify that it has not changed",
  制作ガイド設定の保存先が未初期化です: "The guide setting destination is not initialized",
  制作ガイド設定を作成できません: "Could not create the guide setting",
  制作ガイド設定を保存できません: "Could not save the guide setting",
  制作ガイド設定を検証できません: "Could not verify the guide setting",
  "制作ガイドが未配置または変更されています。設定で確認するかガイド付加を無効にしてください":
    "The guide is missing or changed. Check settings or turn off the added guide instruction.",
  この操作はアプリの設定画面だけで利用できます:
    "This operation is available only in the app settings",
  制作支援設定を確認できません: "Could not verify the authoring settings",
  制作キットの配置内容を確認できません: "Could not preview the authoring kit",
  制作キットを配置できません: "Could not install the authoring kit",
};
