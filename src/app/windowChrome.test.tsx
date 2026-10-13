import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { acceptsWindowCommand, shortcutScope, useWindowChrome } from "./windowChrome";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const unlisten = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  vi.mocked(listen).mockImplementation(async (name, callback) => {
    listeners.set(name, callback as (event: { payload: unknown }) => void);
    return unlisten;
  });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "get_window_chrome"
      ? { platform: "windows", height: 40, leftInset: 0, rightInset: 138, maximized: false }
      : undefined,
  );
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

it("accepts integrated Windows controls and Mac overlay metrics, rejects malformed sizes, and removes subscriptions", async () => {
  const { result, unmount } = renderHook(() => useWindowChrome(vi.fn()));
  await waitFor(() => expect(result.current.platform).toBe("windows"));
  expect(result.current.rightInset).toBe(138);
  act(() =>
    listeners.get("window-chrome-changed")?.({
      payload: { platform: "macos", height: 40, leftInset: 82, rightInset: 0 },
    }),
  );
  expect(result.current.leftInset).toBe(82);
  act(() =>
    listeners.get("window-chrome-changed")?.({
      payload: { platform: "windows", height: 40, leftInset: 0, rightInset: Number.NaN },
    }),
  );
  expect(result.current.platform).toBe("macos");
  expect(result.current.leftInset).toBe(82);
  unmount();
  expect(unlisten).toHaveBeenCalledTimes(2);
});

it("dispatches only fixed commands and protects shell editors, composition and dialogs", async () => {
  const handler = vi.fn();
  renderHook(() => useWindowChrome(handler));
  await waitFor(() => expect(listeners.has("window-command")).toBe(true));
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_window_shortcut_scope", { scope: "paused" }),
  );
  act(() => listeners.get("window-command")?.({ payload: "reopen-closed-tab" }));
  expect(handler).not.toHaveBeenCalled();
  input.id = "document-search-query";
  expect(shortcutScope()).toBe("search-input");
  act(() => listeners.get("window-command")?.({ payload: "focus-search" }));
  expect(handler).toHaveBeenCalledExactlyOnceWith("focus-search");
  expect(acceptsWindowCommand("move-tab-right")).toBe(false);
  expect(acceptsWindowCommand("focus-search", true)).toBe(false);
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.append(dialog);
  expect(acceptsWindowCommand("focus-search")).toBe(false);
  act(() => listeners.get("window-command")?.({ payload: "open-anything" }));
  act(() => listeners.get("window-command")?.({ payload: "move-tab-right" }));
  expect(handler).toHaveBeenCalledTimes(1);
});
