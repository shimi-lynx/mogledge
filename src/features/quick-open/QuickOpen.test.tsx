import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { QuickOpen } from "./QuickOpen";
import { setLanguage } from "../../lib/i18n";
import type { Snapshot } from "../../lib/types";

const snapshot: Snapshot = {
  workspaceId: "root",
  viewId: "view",
  rootPath: "/fixture",
  revision: 1,
  watchError: null,
  nodes: [
    { name: "{count}.html", relativePath: "日本語/$&/{count}.html", kind: "html", children: [] },
  ],
};
beforeEach(() => {
  setLanguage("ja");
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  setLanguage("ja");
});

test("language changes preserve the same query, focus, Japanese path and IME guard", () => {
  const onSelect = vi.fn();
  render(<QuickOpen snapshot={snapshot} onSelect={onSelect} onClose={vi.fn()} />);
  const input = screen.getByRole<HTMLInputElement>("combobox", { name: "ファイル名・相対パス" });
  fireEvent.change(input, { target: { value: "{count}" } });
  fireEvent.compositionStart(input);
  act(() => {
    setLanguage("en");
  });
  const english = screen.getByRole<HTMLInputElement>("combobox", {
    name: "Filename or relative path",
  });
  expect(english).toBe(input);
  expect(english.value).toBe("{count}");
  expect(document.activeElement).toBe(input);
  expect(screen.getByRole("dialog", { name: "Quick open" })).toBeTruthy();
  expect(screen.getByRole("listbox", { name: "HTML candidates" })).toBeTruthy();
  expect(screen.getByTitle("日本語/$&/{count}.html").textContent).toContain(
    "日本語/$&/{count}.html",
  );
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSelect).toHaveBeenCalledWith({
    relativePath: "日本語/$&/{count}.html",
    workspaceId: "root",
    viewId: "view",
    revision: 1,
  });
});
test("English no-match status and close action retain their existing behavior", () => {
  const onClose = vi.fn();
  act(() => {
    setLanguage("en");
  });
  render(<QuickOpen snapshot={snapshot} onSelect={vi.fn()} onClose={onClose} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "no-match" } });
  expect(screen.getByRole("status").textContent).toBe("No matching HTML files");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
