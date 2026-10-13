import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { LANGUAGE_STORAGE_KEY, setLanguage } from "../lib/i18n";
import { SidebarFooter } from "./SidebarFooter";
import { createRef } from "react";
import type { SidebarFooterHandle } from "./SidebarFooter";

beforeEach(() => {
  setLanguage("en");
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage("ja");
  localStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

test("keeps a single version left of reload and settings; opening settings never reloads and switching is immediate", async () => {
  const reload = vi.fn();
  const view = render(<SidebarFooter version="0.6.0" reloadDisabled={false} onReload={reload} />);
  const footer = view.container.querySelector(".sidebar-footer")!;
  expect(footer.firstElementChild?.textContent).toBe("v0.6.0");
  expect(screen.getAllByText("v0.6.0")).toHaveLength(1);
  expect(footer.textContent).not.toContain("documents");
  const settings = screen.getByRole("button", { name: "Settings" });
  settings.focus();
  fireEvent.click(settings);
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  const category = screen.getByRole("button", { name: "Choose display language" });
  expect(document.activeElement).toBe(category);
  expect(category.getAttribute("aria-current")).toBe("page");
  const select = screen.getByRole("combobox", { name: "Choose display language" });
  fireEvent.change(select, { target: { value: "ja" } });
  expect(screen.getByRole("dialog", { name: "設定" })).toBe(dialog);
  fireEvent.change(select, { target: { value: "en" } });
  expect(screen.getByRole("dialog", { name: "Settings" })).toBe(dialog);
  expect(screen.getByRole("combobox", { name: "Choose display language" })).toBe(select);
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(settings);
  fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
  expect(reload).toHaveBeenCalledOnce();
});

test("wraps keyboard focus and closes with Escape or an actual backdrop click, returning focus to settings", async () => {
  render(<SidebarFooter version={null} reloadDisabled onReload={vi.fn()} />);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Rescan" }).disabled).toBe(true);
  const settings = screen.getByRole("button", { name: "Settings" });
  fireEvent.click(settings);
  const dialog = screen.getByRole("dialog");
  const select = screen.getByRole("combobox");
  const close = screen.getByRole("button", { name: "Close" });
  select.focus();
  fireEvent.keyDown(select, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(select);
  fireEvent.keyDown(select, { key: "Escape", isComposing: true });
  expect(screen.getByRole("dialog")).toBe(dialog);
  fireEvent.keyDown(select, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(settings);
  fireEvent.click(settings);
  const reopened = screen.getByRole("dialog");
  vi.spyOn(reopened, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 10, 300, 300));
  fireEvent(reopened, new MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 20 }));
  fireEvent.click(reopened, { clientX: 20, clientY: 20 });
  expect(screen.getByRole("dialog")).toBe(reopened);
  fireEvent(reopened, new MouseEvent("pointerdown", { bubbles: true, clientX: 2, clientY: 2 }));
  fireEvent.click(reopened, { clientX: 20, clientY: 20 });
  expect(screen.getByRole("dialog")).toBe(reopened);
  fireEvent(reopened, new MouseEvent("pointerdown", { bubbles: true, clientX: 2, clientY: 2 }));
  fireEvent.click(reopened, { clientX: 2, clientY: 2 });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(settings);
  await act(() => setLanguage("ja"));
});

test("language storage failure remains visible inside settings without blocking the selected language", () => {
  render(<SidebarFooter version={null} reloadDisabled onReload={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "ja" } });
  expect(screen.getByRole("dialog", { name: "設定" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("保存できません");
  expect(screen.getByRole<HTMLSelectElement>("combobox").value).toBe("ja");
});
test("imperative settings reuse the existing dialog and first origin without resetting focus or language", () => {
  const ref = createRef<SidebarFooterHandle>();
  const origin = document.createElement("button");
  const later = document.createElement("button");
  document.body.append(origin, later);
  render(<SidebarFooter ref={ref} version={null} reloadDisabled onReload={vi.fn()} />);
  origin.focus();
  act(() => {
    ref.current!.openSettings(origin);
    ref.current!.openSettings(later);
  });
  const dialog = screen.getByRole("dialog");
  const select = screen.getByRole("combobox");
  select.focus();
  fireEvent.change(select, { target: { value: "ja" } });
  act(() => ref.current!.openSettings(later));
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(document.activeElement).toBe(select);
  expect((select as HTMLSelectElement).value).toBe("ja");
  fireEvent.keyDown(select, { key: "Escape" });
  expect(document.activeElement).toBe(origin);
  origin.remove();
  later.remove();
});
test("opens above a hidden sidebar and falls back when the shortcut origin becomes hidden", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const ref = createRef<SidebarFooterHandle>();
  const fallback = document.createElement("button");
  const origin = document.createElement("button");
  document.body.append(origin, fallback);
  const view = render(
    <aside hidden inert>
      <SidebarFooter
        ref={ref}
        fallbackFocus={fallback}
        version={null}
        reloadDisabled
        onReload={vi.fn()}
      />
    </aside>,
  );
  const button = view.container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!;
  expect(button.title).toBe("Settings (Cmd+,)");
  expect(button.getAttribute("aria-keyshortcuts")).toBe("Meta+,");
  act(() => ref.current!.openSettings(origin));
  const dialog = screen.getByRole("dialog");
  expect(dialog.closest("[hidden], [inert]")).toBeNull();
  origin.hidden = true;
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(document.activeElement).toBe(fallback);
  origin.remove();
  fallback.remove();
});

test("Mac settings use an explicit close action and restore the settings origin", () => {
  const reload = vi.fn();
  render(<SidebarFooter platform="macos" version={null} reloadDisabled onReload={reload} />);
  const settings = screen.getByRole("button", { name: "Settings" });
  expect(settings.title).toBe("Settings (Cmd+,)");
  settings.focus();
  fireEvent.click(settings);
  const dialog = screen.getByRole("dialog");
  const close = screen.getByRole("button", { name: "Close" });
  expect(close.textContent).toBe("Close");
  expect(close.closest("footer")).not.toBeNull();
  expect(dialog.querySelector("header button")).toBeNull();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "ja" } });
  expect(screen.getByRole("dialog")).toBe(dialog);
  fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(settings);
  expect(reload).not.toHaveBeenCalled();
});
