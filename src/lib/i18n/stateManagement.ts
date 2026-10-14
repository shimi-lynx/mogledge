export const stateManagementMessages: Readonly<Record<string, string>> = {
  "HTMLのファイル名・相対パスを検索": "Search HTML filename or relative path",
  全件から検索: "Search all saved data",
  検索を解除: "Clear search",
  "削除する保存入力を選択（複数可）": "Select saved input to remove (multiple allowed)",
  "選択した保存済み入力を削除（復旧可能）": "Remove selected saved input (recoverable)",
  "選択した{count}件の削除を確認": "Review removal of {count} selected records",
  "選択したHTML: {count}件": "Selected HTML documents: {count}",
  "対象の確定済み入力: {count} appId、{size}": "Selected committed input: {count} appIds, {size}",
  "選択したHTMLの保存入力を削除し、回復コピーを残します。HTMLファイル本体は変更しません。古い画面からの保存読込・再保存は停止されます。復旧するまで入力は戻りません。":
    "Remove saved input for the selected HTML and retain recovery copies. HTML files remain unchanged. Reads and resaves from old views are blocked; input returns only after restoration.",
  "DBの技術上限またはdiskの容量制約に達しました。既存の保存値と入力を保持します":
    "A database technical limit or disk capacity constraint was reached. Existing saved values and input are retained.",
  "処理に必要なメモリなどの資源を確保できません。既存の保存値と入力を保持します":
    "Resources such as memory could not be allocated for this operation. Existing saved values and input are retained.",
  操作の指定を確認できません: "The operation request could not be verified",
  "保存先を安全に確認できません。原本を保持します":
    "The storage location could not be safely verified. The original is preserved.",
  "ルートまたは表示世代が変わりました。点検し直してください":
    "The root or view changed. Inspect again.",
  "有限の点検範囲を超えました。対象は保留します":
    "Inspection exceeded its finite limits. The target is held.",
  実行前に対象と影響を確認してください: "Review the target and impact before proceeding",
  先に回復可能な形式への変更を確認してください: "Review the recovery format upgrade first",
  "回復可能な形式へ変更済みです。点検し直してください":
    "The recovery format is already enabled. Inspect again.",
  "確認の上限に達しました。以前の確認を取り消してください":
    "The preview limit was reached. Cancel an earlier preview.",
  "この確認は利用できません。操作結果を照会してください":
    "This preview is unavailable. Verify the operation result.",
  "この確認は処理済みまたは処理中です。結果を照会してください":
    "This preview is completed or processing. Verify the result.",
  "原本が変わりました。点検し直して選択してください":
    "The source changed. Inspect again and select a record.",
  "対象HTMLは使用中か保存権限が残っているため、いまは整理できません。外部ブラウザーの登録が残る場合はアプリを再起動してから再点検してください":
    "The HTML is in use or retains saved-state grants. If an external-browser registration remains, restart the app and inspect again.",
  "復元先の値または容量制限により復元できません。既存値を保持します":
    "Existing target values or quota limits block restoration. Existing values are preserved.",
  "回復領域の上限に達しました。既存の回復コピーを保持します":
    "The recovery area is full. Existing recovery copies are retained.",
  "確認の期限を安全に確認できません。実行せず保留します":
    "The preview lifetime could not be safely verified. The operation is held.",
  この操作はアプリの設定画面で行ってください: "Use the app's settings page for this operation",
  保存データ: "Saved data",
  不明: "Unknown",
  件: "records",
  "HTML原本は変更しません。対象は確定済みの保存入力です。未保存の入力やCanvas・JavaScriptの実行状態は含みません。":
    "HTML originals remain unchanged. This manages committed saved input, excluding unsaved input and live Canvas or JavaScript state.",
  "一覧を開いただけでは整理しません。原本不明・一時offline・未使用期間だけを理由に整理しません。":
    "Opening this list makes no changes. An unknown source, temporary offline state or time since use never authorizes cleanup.",
  確認した操作を処理中: "Processing the confirmed operation",
  保存データを確認中: "Inspecting saved data",
  保存データの使用量: "Saved data usage",
  保存入力の論理容量: "Active logical usage",
  回復領域の論理容量: "Recovery logical usage",
  DBのディスク容量: "Database disk size",
  回復領域だけのディスク容量: "Recovery-only disk size",
  "不明（同じDB内で共有）": "Unknown (shared within the same database)",
  journalのディスク容量: "Journal disk size",
  DB内の空きページ: "Free database pages",
  "論理quotaとdisk使用量は別です。隔離してもDBのdisk容量は減りません。回復コピーも容量を使い、独立backupや暗号化ではありません。":
    "Logical quota and disk use differ. Quarantine does not shrink the database. Recovery copies use space and are neither an independent backup nor encryption.",
  保存入力一覧: "Saved input list",
  隔離と回復の一覧: "Quarantine and recovery list",
  点検し直す: "Inspect again",
  整理する保存入力を一つ選択: "Select one saved input record",
  復元する回復コピーを一つ選択: "Select one recovery copy to restore",
  この一覧に保存入力はありません: "This page contains no saved input records",
  原本の場所は未確認: "Source location is unverified",
  "保存revision {revision}": "Saved revision {revision}",
  "最終利用: 不明（未収集）": "Last used: unknown (not collected)",
  "復元後revision {revision}": "Restored revision {revision}",
  "識別情報 {identity}": "Identity {identity}",
  復元済みの回復コピーを保持しています: "The restored recovery copy is retained",
  復元可能な隔離: "Recoverable quarantine",
  一覧のページ: "List pages",
  前の20件: "Previous 20",
  次の20件: "Next 20",
  "{offset}件目から最大20件": "Up to 20 records from {offset}",
  回復可能な形式への変更を確認: "Review recovery format upgrade",
  選択した対象の影響を確認: "Review impact on the selected record",
  選択した操作の確認: "Review selected operation",
  回復可能な形式を準備: "Prepare recoverable format",
  選択した保存済み入力を隔離: "Quarantine selected saved input",
  隔離した保存済み入力を復元: "Restore quarantined saved input",
  "回復用schema v2へ変更します。保存入力は変更しませんが、v2非対応の旧版は起動できません。アプリ全体のbackupと復帰方法を先に確認してください。":
    "Upgrade to recovery schema v2. Saved input is preserved, but older apps without v2 support cannot start. Check a full profile backup and rollback plan first.",
  "対象の確定済み入力: {count} appId、{bytes} bytes":
    "Selected committed input: {count} appIds, {bytes} bytes",
  "選択した原本の保存入力を一時停止し、回復コピーへ隔離します。次回の保存読込・更新は停止されます。HTML本体は残ります。":
    "Suspend saved input for the selected source and keep a recovery copy. Subsequent saved-state reads and writes are blocked. The HTML remains.",
  "同じ物理root・原本識別情報へ保存入力を復元します。復元先に値があれば上書きしません。回復コピーは復元後も保持します。":
    "Restore saved input to the same physical root and source identity. Existing values are never overwritten. The recovery copy remains after restoration.",
  "永久削除は行いません。独立backupが必要なら、この操作の前に別の安全な場所へ保全してください。個別の入力は既存の書き出し機能を利用できます。":
    "Nothing is permanently deleted. Make an independent backup in a safe location before proceeding if needed. Use the existing export feature for individual saved input.",
  "表示中・非表示・外部ブラウザー・進行中open/saveの対象は保留します。原本や保存値が変わると確認は失効し、5分以内でも再選択が必要です。":
    "Visible, hidden, external-browser and opening or saving documents are held. Changes to the source or saved values invalidate this preview, even within its five-minute lifetime.",
  "ルートまたは表示世代が変わったため、この確認では実行できません":
    "The root or view changed. This preview cannot be confirmed.",
  "対象・保存入力への影響・復元条件とbackupを確認しました":
    "I reviewed the target, input impact, restoration conditions and backup",
  確認した内容で実行: "Run the reviewed operation",
  この確認を取り消す: "Cancel this preview",
  "結果は不明です。自動再実行しません。取消要求だけでは未実行を保証しません。":
    "The result is unknown. The operation will not retry automatically. A cancellation request does not prove it did not run.",
  "結果不明のまま戻ります。新しい点検は過去の操作結果の証明ではありません":
    "Return with an unknown result. A new inspection does not prove the past operation's outcome.",
  結果不明のまま一覧へ戻る: "Return to list with an unknown result",
  処理結果を照会: "Check operation result",
  取消を要求: "Request cancellation",
  確認した操作は完了しました: "The reviewed operation completed",
  操作の取消を確認しました: "Operation cancellation was verified",
  操作の失敗を確認しました: "Operation failure was verified",
  一覧へ戻る: "Return to list",
  "保存データは使用中です。処理の終了後に再確認してください":
    "Saved data is busy. Inspect again after processing finishes.",
  "対象HTMLは使用中です。表示中・非表示のタブと外部ブラウザーを閉じてから再確認してください":
    "The HTML is in use. Close its visible and hidden tabs and external browser, then inspect again.",
  "保存データが変わりました。点検し直して選択してください":
    "Saved data changed. Inspect again and select a record.",
  対象の状態を確認できないため保留します: "Held because the target state cannot be verified",
  ルートを確認できないため保留します: "Held because the root cannot be verified",
  "確認の期限が切れました。点検し直してください": "The preview expired. Inspect again.",
  "確認した対象が変わりました。点検し直してください": "The reviewed target changed. Inspect again.",
  復元先に保存された入力があるため上書きしません:
    "The restore target has saved input. It will not be overwritten.",
  "この保存形式には対応していません。原本を保持します":
    "Unsupported saved-state format. The original is preserved.",
  "保存データの整合性を確認できません。原本を保持します":
    "Saved-state consistency cannot be verified. The original is preserved.",
  "保存データを確認できません。原本を保持します":
    "Saved data cannot be inspected. The original is preserved.",
  ルートまたは原本を確認できないため保留します:
    "Held because the root or source cannot be verified",
  一度の点検で見つからないだけでは整理しません:
    "A single scan without finding the source does not authorize cleanup",
  原本の識別情報が異なるため回復用に保持します:
    "Retained for recovery because the source identity differs",
  同じ原本を確認しました: "The same source was verified",
  同じ原本を別の場所で確認しました: "The same source was verified at another location",
  "応答が確認した操作と一致しません。処理結果を照会してください":
    "The response does not match the reviewed operation. Verify its result.",
};
