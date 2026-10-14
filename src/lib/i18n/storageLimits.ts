export const storageLimitsMessages: Readonly<Record<string, string>> = {
  "全体上限は保存入力のJSONに適用します。回復コピーは別枠536.870912 MBで、DB・journal・backupのdisk容量とは異なります。HTML原本・media・生成ファイルの書き出し上限も別です。":
    "The total limit covers saved-input JSON. Recovery copies have a separate 536.870912 MB budget. Database, journal and backup disk usage is different. HTML source, media and generated-file export limits are separate too.",
  "1.048576 MBの整数倍になる容量を指定してください。最小値は1.048576 MBで、全体は文書以上です":
    "Enter an exact multiple of 1.048576 MB, with total at least the document limit.",
  "同じ保存先profileの全ルートに適用します。既定値は文書5.24288 MB・全体536.870912 MBです。":
    "Applies to all roots in the same storage profile. Defaults are 5.24288 MB per document and 536.870912 MB in total.",
  "文書{document}・全体{total}": "{document} per document · {total} total",
  "1 KB = 1,000 B、1 MB = 1,000 KB、1 GB = 1,000 MBです。従来の保存形式を保つため、1.048576 MB（1 MiB）の整数倍で指定してください。丸めは行いません。全体は文書以上です。":
    "1 KB = 1,000 B, 1 MB = 1,000 KB and 1 GB = 1,000 MB. Use exact multiples of 1.048576 MB (1 MiB) to preserve the existing saved format. Values are never rounded. Total must be at least the document limit.",
  文書上限: "Document limit",
  全体上限: "Total limit",
  文書上限の単位: "Document limit unit",
  全体上限の単位: "Total limit unit",
  "DBの技術上限またはdiskの容量制約に達しました。既存の保存値と入力を保持します":
    "A database technical limit or disk capacity constraint was reached. Existing saved values and input are retained.",
  "処理に必要なメモリなどの資源を確保できません。既存の保存値と入力を保持します":
    "Resources such as memory could not be allocated for this operation. Existing saved values and input are retained.",
  "正確に扱える範囲の1以上の整数MiBを指定し、全体を文書以上にしてください":
    "Use whole MiB values of at least 1 within the exactly representable range, with total at least the document limit.",
  "保存データまたは上限が変わりました。現在値を確認してから適用してください":
    "Saved data or limits changed. Review the current values before applying.",
  "現在の保存量や文書・回復コピーの最大容量を下回る上限にはできません":
    "Limits cannot be below current usage or the largest saved document or recovery copy.",
  旧版との互換性とbackupを確認してください:
    "Review compatibility with older versions and your backup.",
  "ルートまたは表示世代が変わりました。適用値を確認してください":
    "The root or view changed. Check the effective limits.",
  "保存データは使用中です。処理が終わってから現在値を確認してください":
    "Saved data is busy. Check current values after processing ends.",
  "保存データの整合性を確認できません。入力と設定を保持します":
    "Saved-data integrity could not be verified. Inputs and preferences are retained.",
  "保存上限を確認できません。入力と設定を保持します":
    "Storage limits could not be verified. Inputs and preferences are retained.",
  "有限の点検範囲を超えたため、上限の変更を保留します":
    "Limit changes are held because the bounded inspection limit was exceeded.",
  保存上限はアプリの設定画面で変更してください: "Change storage limits in the app's settings.",
  保存入力の容量上限: "Saved-input storage limits",
  "同じ保存先profileの全ルートに適用します。既定値は文書5MiB・全体512MiBです。":
    "Applies to all roots in the same storage profile. Defaults are 5 MiB per document and 512 MiB in total.",
  現在の上限: "Effective limits",
  最後に確認した上限: "Last verified limits",
  "文書{document}MiB・全体{total}MiB": "{document} MiB per document · {total} MiB total",
  全ルートの保存入力: "Saved input across all roots",
  保存文書の最大容量: "Largest saved document",
  回復コピーの合計: "Recovery copies in total",
  回復コピーの最大容量: "Largest recovery copy",
  "1以上の整数MiBで、全体は文書以上です。1MiBは1,048,576 bytesです。":
    "Use whole MiB values of at least 1, with total at least the document limit. 1 MiB is 1,048,576 bytes.",
  文書保存の技術上限: "Technical document capacity",
  保存通信の技術上限: "Technical save-request capacity",
  DBの技術上限: "Technical database capacity",
  回復コピーの別枠容量: "Separate recovery budget",
  "技術上限は設定値とは別です。文書の付随情報やDBの管理領域、空きdiskにも制約があり、設定値まで保存できる保証はありません。":
    "Technical capacities are separate from your limits. Document metadata, database overhead and free disk space also constrain saving. The configured capacity is not guaranteed.",
  "大きい上限ではメモリ・処理時間・空きdiskが多く必要になる場合があります。容量の確保や動作を保証するものではありません。":
    "Larger limits may require more memory, processing time and free disk space. They do not guarantee available capacity or performance.",
  "設定値が文書またはDBの技術上限を超えています。設定は適用できますが、実際の保存には技術上限が適用されます。":
    "Your limits exceed a technical document or database capacity. You can apply them, but actual saves remain subject to technical capacities.",
  "全体上限はactiveの保存JSONです。回復コピーは別枠512MiBで、DB・journal・backupのdisk容量とは異なります。HTML原本・media・生成ファイルの書き出し上限も別です。":
    "The total limit covers active saved JSON. Recovery copies have a separate 512 MiB budget. Database, journal and backup disk usage is different. HTML source, media and generated-file export limits are separate too.",
  古いHTMLの保存処理は更新が必要な場合があります: "Older HTML save code may need updating.",
  保存上限の応答を待っています: "Waiting for the storage-limit response",
  保存上限を確認中: "Checking storage limits",
  "保存上限の変更結果は不明です。自動再保存せず、適用値を確認してください。":
    "The limit-change outcome is unknown. Do not save again automatically; check the effective limits.",
  "保存上限を適用しました。次の保存から有効です。":
    "Storage limits applied. They take effect for the next save.",
  "現在の適用値を確認しました。過去の変更要求の成功を証明するものではありません。":
    "Current effective limits checked. This does not prove that a past change request completed.",
  保存上限を編集: "Edit storage limits",
  適用値を確認: "Check effective limits",
  変更する保存上限: "Storage limits to change",
  "文書上限（MiB）": "Document limit (MiB)",
  "全体上限（MiB）": "Total limit (MiB)",
  "保存形式の更新後は旧版アプリが起動できない場合があります。互換性と停止中profileのbackupを確認しました":
    "Updating the saved format may prevent older apps from starting. I reviewed compatibility and a backup of the stopped profile.",
  既定値を入力: "Fill in defaults",
  上限の編集を取り消す: "Cancel limit edits",
  保存上限を適用: "Apply storage limits",
};
