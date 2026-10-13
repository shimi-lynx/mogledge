import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  LANGUAGE_STORAGE_KEY,
  getLanguage,
  readStoredLanguage,
  setLanguage,
  translate,
  translateUiMessage,
  useT,
} from "./i18n";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage("ja");
  localStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

test("restores only supported locale values and safely defaults missing, corrupt or denied storage", async () => {
  localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  vi.resetModules();
  const initial = await import("./i18n");
  expect(initial.getLanguage()).toBe("en");
  vi.spyOn(window.navigator, "language", "get").mockReturnValue("ja-JP");
  for (const value of [null, "", "fr", '{"language":"en"}', "EN"]) {
    expect(readStoredLanguage({ getItem: () => value })).toBe("en");
  }
  expect(readStoredLanguage({ getItem: () => "en" })).toBe("en");
  expect(readStoredLanguage({ getItem: () => "ja" })).toBe("ja");
  expect(
    readStoredLanguage({
      getItem: () => {
        throw new Error("storage blocked");
      },
    }),
  ).toBe("en");
});

test("updates translated controls immediately without replacing input or iframe state, and persists the selection", async () => {
  function Editor() {
    const t = useT();
    return (
      <>
        <button>{t("閉じる")}</button>
        <input aria-label="user instruction" defaultValue="" />
        <iframe title="user HTML" />
      </>
    );
  }
  render(<Editor />);
  const input = screen.getByRole("textbox") as HTMLInputElement;
  const frame = screen.getByTitle("user HTML");
  fireEvent.change(input, { target: { value: "日本語の依頼文 $& {path}" } });
  await act(() => setLanguage("en"));
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  expect(getLanguage()).toBe("en");
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
  expect(document.documentElement.lang).toBe("en");
  expect(screen.getByRole("textbox")).toBe(input);
  expect(screen.getByTitle("user HTML")).toBe(frame);
  expect(input.value).toBe("日本語の依頼文 $& {path}");
  await act(() => setLanguage("ja"));
  expect(screen.getByRole("button", { name: "閉じる" })).toBeTruthy();
  expect(input.value).toBe("日本語の依頼文 $& {path}");
});

test("substitutes only supplied parameters and retains unknown diagnostic causes", () => {
  expect(translate("constructor", "en")).toBe("constructor");
  expect(translate("{count}ピクセル", "en", { count: 230 })).toBe("230 pixels");
  expect(translate("{path}", "en", { path: "日本語/$&/{count}.html" })).toBe(
    "日本語/$&/{count}.html",
  );
  expect(translate("{path}", "ja")).toBe("{path}");
  expect(translateUiMessage("保存", "en")).toBe("Save");
  expect(translateUiMessage("保存: Access denied", "en")).toBe("Save: Access denied");
  expect(translateUiMessage("保存: 原因は保持される", "en")).toBe(
    "Save: Details: 原因は保持される",
  );
  expect(translateUiMessage("未知のOS原因", "en")).toBe("Details: 未知のOS原因");
  expect(translateUiMessage("Access denied", "en")).toBe("Access denied");
  expect(
    translateUiMessage(
      "この連携先の下書き本文は12,000文字以内です。短くするか本文をコピーしてください",
      "en",
    ),
  ).toBe(
    "The draft for this destination must be within 12,000 characters. Shorten it or copy the text instead.",
  );
  expect(translateUiMessage("保存: 原因は保持される", "ja")).toBe("保存: 原因は保持される");
});

test("translates controller and transfer prefixes without changing paths, codes or uncertain-result semantics", () => {
  expect(translateUiMessage("ファイル操作に失敗しました: Error: WorkspaceChanged", "en")).toBe(
    "The file operation failed: Error: The selected root changed (WorkspaceChanged)",
  );
  expect(translateUiMessage("文書を開けません: 日本語/$&/{count}.html — EACCES", "en")).toBe(
    "Could not open the document: Details: 日本語/$&/{count}.html — EACCES",
  );
  expect(
    translateUiMessage(
      "処理失敗: unknown_native_code。grant失効: あり（自動復活しません。必要なタブを明示再読み込み）。backup公開: あり。export公開: なし。",
      "en",
    ),
  ).toBe(
    "Operation failed: unknown_native_code. Browser grants revoked: yes (not restored automatically; reload the required tabs explicitly). Backup published: yes. Export published: no.",
  );
  expect(
    translateUiMessage(
      "処理状態: cancel_requested。取消要求や期限切れだけでは実行結果を断定できません。必要なら再照会してください。",
      "en",
    ),
  ).toBe(
    "Operation status: cancellation requested. A cancellation request or expiry alone does not establish the execution result. Check again if needed.",
  );
  expect(translateUiMessage("照会できません。結果は不明のままです: new_native_code", "en")).toBe(
    "The operation could not be checked. Its result is still unknown: new_native_code",
  );
  expect(
    translateUiMessage(
      "名前変更は完了しましたが、順序を保存できません。保存済み順序で再走査しました",
      "en",
    ),
  ).toBe(
    "Rename completed, but Could not save the order. The tree was refreshed using the saved order.",
  );
  expect(
    translateUiMessage(
      "この連携先の下書きはパス込みで12000文字以内です。短くするか本文をコピーしてください",
      "en",
    ),
  ).toBe(
    "This destination accepts drafts up to 12000 characters including the path. Shorten the request or copy it.",
  );
});
