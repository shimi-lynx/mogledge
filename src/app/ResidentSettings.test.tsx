import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { setLanguage } from "../lib/i18n";
import {
  residentDiagnostic,
  residentShortcutFromKey,
  type ResidentApi,
  type ResidentStatus,
  type ResidentCustomShortcut,
} from "../lib/resident";
import { ResidentSettings } from "./ResidentSettings";
import type { AppState } from "../lib/types";
const initial: ResidentStatus = {
  enabled: false,
  trayAvailable: false,
  startupEnabled: false,
  startupRegistered: false,
  target: { kind: "current" },
  shortcut: { kind: "standard" },
  monitorStatus: "off",
  supported: true,
  readOnly: false,
  error: null,
};
beforeEach(() => setLanguage("en"));
afterEach(() => {
  cleanup();
  setLanguage("ja");
});
function api(status: ResidentStatus = initial): ResidentApi {
  return {
    status: vi.fn(async () => status),
    update: vi.fn<ResidentApi["update"]>(async (action) =>
      action.kind === "enabled"
        ? {
            ...status,
            enabled: action.enabled,
            trayAvailable: action.enabled,
            monitorStatus: "permission-required",
          }
        : status,
    ),
    resolve: vi.fn(),
  };
}
test("autostart displays the actual OS state and preserves an explicit unknown state", async () => {
  const native = api({ ...initial, startupRegistered: true });
  native.update = vi.fn(async () => ({
    ...initial,
    startupRegistered: null,
    error: "ResidentStartupRollbackUnavailable",
  }));
  render(<ResidentSettings api={native} />);
  const toggle = await screen.findByRole<HTMLInputElement>("checkbox", {
    name: "Start the app when signing in to the OS",
  });
  await waitFor(() => expect(toggle.checked).toBe(true));
  expect(native.update).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  await screen.findByText("The OS autostart registration state is unknown");
  expect((await screen.findByRole("alert")).textContent).toContain("Could not restore");
});
test("reading the resident page never enables registration; manual permission settings require a click", async () => {
  const native = api();
  render(<ResidentSettings api={native} />);
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Keep the app running" }).disabled,
    ).toBe(false),
  );
  expect(native.status).toHaveBeenCalledOnce();
  expect(native.update).not.toHaveBeenCalled();
  expect(
    screen.getByRole<HTMLInputElement>("checkbox", { name: "Keep the app running" }).checked,
  ).toBe(false);
  expect(
    screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Start the app when signing in to the OS",
    }).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Keep the app running" }));
  await screen.findByRole("button", { name: "Open Input Monitoring settings" });
  expect(native.update).toHaveBeenCalledExactlyOnceWith({ kind: "enabled", enabled: true });
  fireEvent.click(screen.getByRole("button", { name: "Open Input Monitoring settings" }));
  await waitFor(() =>
    expect(native.update).toHaveBeenLastCalledWith({ kind: "openPermissionSettings" }),
  );
  expect(native.resolve).not.toHaveBeenCalled();
});
test("permission settings failure retains manual guidance and recheck refreshes the monitor", async () => {
  const waiting: ResidentStatus = {
    ...initial,
    enabled: true,
    trayAvailable: true,
    monitorStatus: "permission-required",
  };
  const native = api(waiting);
  native.update = vi.fn<ResidentApi["update"]>(async (action) => {
    if (action.kind === "openPermissionSettings") throw "ResidentPermissionSettingsUnavailable";
    return { ...waiting, monitorStatus: "active", error: null };
  });
  render(<ResidentSettings api={native} />);
  const open = await screen.findByRole("button", { name: "Open Input Monitoring settings" });
  expect(native.update).not.toHaveBeenCalled();
  fireEvent.click(open);
  expect((await screen.findByRole("alert")).textContent).toContain("Cannot open Input Monitoring");
  expect(screen.getByText(/Security & Privacy on older versions/).textContent).toContain(
    "Then return here",
  );
  await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Check after granting permission" }));
  await screen.findByText("Waiting for the modifier sequence");
  expect(screen.queryByRole("button", { name: "Open Input Monitoring settings" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(native.update).toHaveBeenCalledTimes(2);
  expect(native.update).toHaveBeenLastCalledWith({ kind: "checkPermission" });
});

test("pinning uses the displayed HTML and the exact current workspace generation, with no tree option list", async () => {
  const native = api();
  const state = {
    selectedPath: "日本語の長い文書.html",
    loading: false,
    actionBusy: false,
    snapshot: { workspaceId: "root", viewId: "view", revision: 7, nodes: [] },
  } as unknown as AppState;
  render(<ResidentSettings state={state} api={native} />);
  const pin = await screen.findByRole("button", { name: "Pin this HTML" });
  await waitFor(() => expect((pin as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(pin);
  await waitFor(() =>
    expect(native.update).toHaveBeenCalledExactlyOnceWith({
      kind: "pin",
      workspaceId: "root",
      viewId: "view",
      revision: 7,
      relativePath: state.selectedPath,
    }),
  );
  expect(screen.queryByRole("combobox")).toBeNull();
});
test("unpinning keeps the current view and input conflicts do not start another monitor on mount", async () => {
  const native = api({
    ...initial,
    enabled: true,
    trayAvailable: true,
    monitorStatus: "unavailable",
    error: "ResidentInputConflict",
    target: {
      kind: "pinned",
      rootIdentity: "root",
      document: { identity: "document", relativePath: "pinned.html" },
    },
  });
  render(<ResidentSettings api={native} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Another input monitor");
  expect(screen.getByRole("heading", { name: "Recall with a key sequence" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "View on recall" })).toBeTruthy();
  expect(screen.getByText("Pinned HTML: pinned.html")).toBeTruthy();
  expect(native.update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Unpin" }));
  await waitFor(() => expect(native.update).toHaveBeenCalledExactlyOnceWith({ kind: "current" }));
  expect(native.resolve).not.toHaveBeenCalled();
});
test("native registration errors remain visible and language changes immediately", async () => {
  const native = api();
  native.update = vi.fn(async () => {
    throw "ResidentStartupRequiresInstalledApp";
  });
  render(<ResidentSettings api={native} />);
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Start the app when signing in to the OS",
      }).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Start the app when signing in to the OS" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("installed distribution app");
  setLanguage("ja");
  await screen.findByText("自動起動の登録と解除は正式な配布アプリで行ってください");
});

test("unknown IPC diagnostics never render private paths while known preferences failures remain visible", async () => {
  const privatePath = "private-origin/private-profile/private-file";
  const native = api({ ...initial, error: `internal IO failure: ${privatePath}` });
  native.update = vi.fn(async () => {
    throw `IPC update error: ${privatePath}`;
  });
  render(<ResidentSettings api={native} />);
  expect((await screen.findByRole("alert")).textContent).toBe("Cannot update resident preferences");
  expect(document.body.textContent).not.toContain(privatePath);
  fireEvent.click(screen.getByRole("checkbox", { name: "Keep the app running" }));
  await waitFor(() => expect(native.update).toHaveBeenCalledOnce());
  expect(screen.getByRole("alert").textContent).toBe("Cannot update resident preferences");
  expect(document.body.textContent).not.toContain(privatePath);
  native.update = vi.fn(async () => {
    throw "常駐設定が外部で変更されました。再起動して確認してください";
  });
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Keep the app running" }).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Keep the app running" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Restart to inspect them");
  expect(residentDiagnostic("constructor")).toBe("常駐設定を更新できません");
  expect(residentDiagnostic("__proto__")).toBe("常駐設定を更新できません");
  expect(residentDiagnostic("常駐設定を読み取れません")).toBe("常駐設定を読み取れません");
});

const custom: ResidentCustomShortcut = {
  kind: "custom",
  control: true,
  alt: true,
  shift: false,
  meta: false,
  key: "KeyM",
};

async function recordCustomShortcut() {
  const mode = await screen.findByRole<HTMLInputElement>("radio", {
    name: "Custom simultaneous shortcut",
  });
  await waitFor(() => expect(mode.disabled).toBe(false));
  fireEvent.click(mode);
  const record = screen.getByRole("button", { name: "Record recall shortcut" });
  fireEvent.click(record);
  fireEvent.keyDown(record, { key: "m", code: "KeyM", ctrlKey: true, altKey: true });
  await screen.findByText("Shortcut to apply: Ctrl + Alt + M");
}

test("record click acquires focus before capturing distinct Cmd and Ctrl shortcuts", async () => {
  const native = api();
  render(<ResidentSettings api={native} />);
  const mode = await screen.findByRole<HTMLInputElement>("radio", {
    name: "Custom simultaneous shortcut",
  });
  await waitFor(() => expect(mode.disabled).toBe(false));
  mode.focus();
  fireEvent.click(mode);
  const record = screen.getByRole("button", { name: "Record recall shortcut" });
  // fireEvent.click, like a macOS WebKit pointer click, does not focus the button.
  fireEvent.click(record);
  expect(document.activeElement).toBe(record);
  fireEvent.keyDown(document.activeElement!, { key: "m", code: "KeyM", metaKey: true });
  await screen.findByText("Shortcut to apply: Cmd/Win + M");
  fireEvent.click(record);
  fireEvent.keyDown(document.activeElement!, { key: "m", code: "KeyM", ctrlKey: true });
  await screen.findByText("Shortcut to apply: Ctrl + M");
  expect(native.update).not.toHaveBeenCalled();
});

test("custom capture is explicit, local and unapplied until confirmation; standard can be restored", async () => {
  const native = api();
  native.update = vi.fn(async (action) => ({
    ...initial,
    shortcut: action.kind === "shortcut" ? action.shortcut : initial.shortcut,
  }));
  render(<ResidentSettings api={native} />);
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>("radio", {
        name: "Standard modifier sequence",
      }).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Custom simultaneous shortcut" }));
  const record = screen.getByRole("button", { name: "Record recall shortcut" });
  fireEvent.keyDown(record, { key: "m", code: "KeyM", ctrlKey: true, altKey: true });
  expect(screen.getByText("No shortcut recorded")).toBeTruthy();
  fireEvent.click(record);
  fireEvent.keyDown(record, { key: "a", code: "KeyA", shiftKey: true });
  expect(screen.getByRole("alert").textContent).toContain("Combine an ordinary key");
  fireEvent.keyDown(record, { key: "m", code: "KeyM", ctrlKey: true, altKey: true, repeat: true });
  fireEvent.keyDown(record, {
    key: "m",
    code: "KeyM",
    ctrlKey: true,
    altKey: true,
    isComposing: true,
  });
  expect(screen.getByText("No shortcut recorded")).toBeTruthy();
  fireEvent.keyDown(record, { key: "m", code: "KeyM", ctrlKey: true, altKey: true });
  await screen.findByText("Shortcut to apply: Ctrl + Alt + M");
  expect(native.update).not.toHaveBeenCalled();
  expect(screen.getByText("Effective shortcut: standard modifier sequence")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Apply recall shortcut" }));
  await screen.findByText("Effective shortcut: Ctrl + Alt + M");
  expect(native.update).toHaveBeenLastCalledWith({ kind: "shortcut", shortcut: custom });
  fireEvent.click(screen.getByRole("radio", { name: "Standard modifier sequence" }));
  expect(native.update).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Restore standard sequence" }));
  await screen.findByText("Effective shortcut: standard modifier sequence");
  expect(native.update).toHaveBeenLastCalledWith({
    kind: "shortcut",
    shortcut: { kind: "standard" },
  });
});

test("failed custom registration retains the effective setting and candidate for retry", async () => {
  const native = api({ ...initial, enabled: true, trayAvailable: true, monitorStatus: "active" });
  native.update = vi.fn<ResidentApi["update"]>(async () => ({
    ...initial,
    enabled: true,
    trayAvailable: true,
    monitorStatus: "active",
    error: "ResidentShortcutUnavailable",
  }));
  render(<ResidentSettings api={native} />);
  await recordCustomShortcut();
  fireEvent.click(screen.getByRole("button", { name: "Apply recall shortcut" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Choose a different combination",
  );
  expect(screen.getByText("Effective shortcut: standard modifier sequence")).toBeTruthy();
  expect(screen.getByText("Shortcut to apply: Ctrl + Alt + M")).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Apply recall shortcut",
      }).disabled,
    ).toBe(false),
  );
  native.update = vi.fn(async () => ({ ...initial, shortcut: custom }));
  fireEvent.click(screen.getByRole("button", { name: "Apply recall shortcut" }));
  await screen.findByText("Effective shortcut: Ctrl + Alt + M");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("saved custom selection is restored on mount and recording cancels on Escape or focus exit", async () => {
  const native = api({ ...initial, shortcut: custom });
  render(<ResidentSettings api={native} />);
  await screen.findByText("Effective shortcut: Ctrl + Alt + M");
  expect(
    screen.getByRole<HTMLInputElement>("radio", { name: "Custom simultaneous shortcut" }).checked,
  ).toBe(true);
  const record = screen.getByRole("button", { name: "Record recall shortcut" });
  fireEvent.click(record);
  fireEvent.keyDown(record, { key: "Escape", code: "Escape" });
  expect(screen.getByRole("button", { name: "Record recall shortcut" })).toBeTruthy();
  fireEvent.click(record);
  fireEvent.blur(record);
  fireEvent.keyDown(record, { key: "n", code: "KeyN", ctrlKey: true });
  expect(screen.queryByText("Shortcut to apply: Ctrl + N")).toBeNull();
  expect(native.update).not.toHaveBeenCalled();
});

test("shortcut capture rejects plain text, unsupported codes, composition and repeats", () => {
  const event = {
    code: "KeyM",
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
  };
  expect(residentShortcutFromKey({ ...event, ctrlKey: false })).toBeNull();
  expect(residentShortcutFromKey({ ...event, ctrlKey: false, shiftKey: true })).toBeNull();
  expect(residentShortcutFromKey({ ...event, code: "IntlYen" })).toBeNull();
  expect(residentShortcutFromKey({ ...event, code: "F25" })).toBeNull();
  expect(residentShortcutFromKey({ ...event, repeat: true })).toBeNull();
  expect(residentShortcutFromKey({ ...event, isComposing: true })).toBeNull();
  for (const code of ["KeyZ", "Digit0", "F1", "F24", "ArrowLeft", "Space", "Tab"])
    expect(residentShortcutFromKey({ ...event, code })?.key).toBe(code);
});
