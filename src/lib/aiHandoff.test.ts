import { expect, test } from "vite-plus/test";
import { aiCopyFailureMessage } from "./aiHandoff";

const clipboardFailure =
  "クリップボードにコピーできませんでした。入力した依頼文は保持しています。もう一度コピーしてください。";
const unknownFailure =
  "コピーの完了を確認できませんでした。入力した依頼文は保持しています。クリップボードの内容を確認し、必要ならもう一度コピーしてください。";

test.each([
  ["パスをコピーできません", clipboardFailure],
  [new Error("パスをコピーできません"), clipboardFailure],
  [
    "クリップボードを開けません。再試行してください",
    "クリップボードを使用できませんでした。少し待ってから、もう一度コピーしてください。",
  ],
  ["このOSのクリップボード操作は未対応です", "このOSでは依頼文のコピーに対応していません。"],
  [
    "対象が変更されました。確認画面を開き直してください",
    "対象が変更されました。入力した依頼文を控えてから、確認画面を開き直してください。",
  ],
  [
    "依頼文は65,536文字以内にし、不可視制御文字を除いてください",
    "依頼文は65,536文字以内にし、不可視制御文字を除いてください。入力した依頼文は保持しています。",
  ],
])("projects only exact known copy diagnostics: %s", (failure, expected) => {
  expect(aiCopyFailureMessage(failure)).toBe(expected);
});

test.each([
  "codex://new?prompt=fixture-private",
  new Error("/fixture/private/path: transport reply lost"),
  "パスをコピーできません /fixture/private",
  { message: "パスをコピーできません", path: "/fixture/private" },
  "__proto__",
  null,
  undefined,
])("unknown failures do not expose private diagnostics or assert copy failure: %s", (failure) => {
  expect(aiCopyFailureMessage(failure)).toBe(unknownFailure);
});
