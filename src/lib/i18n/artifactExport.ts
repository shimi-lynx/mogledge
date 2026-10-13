export const artifactExportMessages: Readonly<Record<string, string>> = {
  文書: "Document",
  生成ファイルを書き出す: "Export generated file",
  "入力状態のバックアップではありません。保存先を選び、新規ファイルとして保存します。既存ファイルは上書きしません。":
    "This does not back up input state. Choose a destination and save a new file. Existing files will not be overwritten.",
  候補名: "Suggested name",
  形式: "Format",
  容量: "Size",
  バイト: "bytes",
  "名前は安全なファイル名に調整し、形式に対応する拡張子を付けます。保存後に自動で開きません。":
    "The name will be adjusted and given the extension for its format. The saved file will not open automatically.",
  "画像は署名の確認のみです。画像内容の完全な安全性を保証するものではありません。":
    "Images are checked by signature only. This does not guarantee that their contents are safe.",
  保存先の選択と保存の完了を待っています: "Waiting for destination selection and saving to finish",
  保存先を選ぶ: "Choose destination",
  "保存結果を確認できません。自動で再試行せず、選んだ保存先を確認してください。":
    "The save result could not be confirmed. Check the chosen destination before trying again.",
  "文書が変わったため保存できません。現在の文書から操作し直してください。":
    "The document changed. Start again from the current document.",
  "別の書き出し処理中、または操作間隔が短すぎます。少し待ってください。":
    "Another export is running or requests are too close together. Please wait.",
  "ファイルを書き出せませんでした。形式、容量、名前、保存先を確認してください。ブラウザー保存には切り替えません。":
    "The file could not be exported. Check the format, size, name and destination. Browser download will not be used.",
};
