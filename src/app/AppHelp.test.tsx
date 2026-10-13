import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import AppHelp from "./AppHelp";
import helpHtml from "./help/ja.html?raw";
import helpEnglishHtml from "./help/en.html?raw";
import { setLanguage } from "../lib/i18n";

afterEach(() => {
  cleanup();
  setLanguage("ja");
});

it("mounts bundled read-only HTML with no script or same-origin permission", () => {
  const view = render(<AppHelp documentOrigin="http://127.0.0.1:19190" />);
  const frame = view.getByTitle("機能と使い方");
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("src")).toBe("http://127.0.0.1:19190/__app/help/ja.html");
  expect(frame.getAttribute("srcdoc")).toBeNull();
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  const document = new DOMParser().parseFromString(helpHtml, "text/html");
  expect(document.querySelector("script, a, img, form")).toBeNull();
  expect(
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
  ).toContain("script-src 'none'");
  expect(document.querySelectorAll('input[type="radio"][name="help-section"]')).toHaveLength(3);
  for (const input of document.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
    expect(document.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    expect(document.getElementById(input.getAttribute("aria-controls")!)).not.toBeNull();
  }
  expect(document.querySelector("h1")?.textContent).toBe("機能と使い方");
});

it("explains current operations and safe usage without development status", () => {
  const view = render(<AppHelp documentOrigin="http://127.0.0.1:19190" />);
  expect(view.getByTitle("機能と使い方").getAttribute("srcdoc")).toBeNull();
  const html = helpHtml;
  const document = new DOMParser().parseFromString(html, "text/html");
  const text = document.body.textContent!;
  expect(text).toContain("Ctrl+Shift+A");
  expect(text).toContain("Cmd+Shift+A");
  expect(text).toContain("Ctrl+Shift+1〜0");
  expect(text).toContain("Cmd+Shift+1〜0");
  expect(text).toContain("0は10番目です");
  expect(text).toContain("安定したセットID");
  expect(text).toContain("Ctrl+B");
  expect(text).toContain("Ctrl+,");
  expect(text).toContain("通常のローカルフォルダー");
  expect(text).toContain("オンラインのみの項目はOS側で端末に保持");
  expect(text).toContain("保存APIに対応したHTML");
  expect(text).toContain("HTML本文や保存入力を自動で送信しません");
  expect(text).not.toMatch(/未確認|未実装|未テスト|未対応|Draft|PR\s*#|開発状況/);
});

it("switches bundled language within the same sandboxed iframe node", () => {
  const view = render(<AppHelp documentOrigin="http://127.0.0.1:19190" />);
  const frame = view.getByTitle("機能と使い方");
  act(() => {
    setLanguage("en");
  });
  expect(view.getByTitle("Features and usage")).toBe(frame);
  const english = new DOMParser().parseFromString(helpEnglishHtml, "text/html");
  expect(frame.getAttribute("src")).toBe("http://127.0.0.1:19190/__app/help/en.html");
  expect(english.documentElement.lang).toBe("en");
  expect(english.body.textContent).toContain("Ctrl+Shift+A");
  expect(english.body.textContent).toContain("Cmd+Shift+A");
  expect(english.body.textContent).toContain("Ctrl+Shift+1–0");
  expect(english.body.textContent).toContain("Cmd+Shift+1–0");
  expect(english.body.textContent?.replace(/\s+/g, " ")).toContain("retain stable set IDs");
  expect(english.body.textContent).toContain("Ctrl+B");
  expect(english.body.textContent).toContain("Ctrl+,");
  expect(english.body.textContent?.replace(/\s+/g, " ")).toContain(
    "HTML content and saved input are not sent automatically.",
  );
  expect(english.querySelector("script, form, a, img")).toBeNull();
  expect(english.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  for (const html of [helpHtml, helpEnglishHtml]) {
    const bundled = new DOMParser().parseFromString(html, "text/html");
    const aiLabel = bundled.documentElement.lang === "ja" ? "AIに渡す" : "Send to AI";
    for (const panelId of ["help-features-panel", "help-usage-panel"]) {
      const panel = bundled.getElementById(panelId)!;
      expect(panel.querySelector("h2")?.textContent).toBe(aiLabel);
      expect(panel.querySelector(".quick-steps")?.children).toHaveLength(3);
      expect(panel.querySelector("details")?.hasAttribute("open")).toBe(false);
      expect(panel.querySelector("details > summary")).not.toBeNull();
      const folderNote = panel
        .querySelector(".ai-guide > .folder-note")
        ?.textContent?.replace(/\s+/g, " ");
      expect(folderNote).toContain("OneDrive");
      expect(folderNote).toContain(
        bundled.documentElement.lang === "ja" ? "失敗する場合" : "may fail",
      );
      expect(folderNote).toContain(
        bundled.documentElement.lang === "ja" ? "同期外" : "outside OneDrive sync",
      );
    }
    expect(bundled.querySelector("tbody th")?.textContent?.trim()).toBe(aiLabel);
  }
  expect(frame.getAttribute("sandbox")).toBe("");
  act(() => {
    setLanguage("ja");
  });
  expect(view.getByTitle("機能と使い方")).toBe(frame);
});

it("waits without creating an about:blank frame until the server origin is ready", () => {
  const view = render(<AppHelp />);
  expect(view.queryByTitle("機能と使い方")).toBeNull();
  expect(view.getByRole("status").textContent).toBe("ヘルプを読み込み中");
  view.rerender(<AppHelp documentOrigin="http://127.0.0.1:19190" />);
  expect(view.getByTitle("機能と使い方").getAttribute("src")).toContain("/__app/help/ja.html");
});
