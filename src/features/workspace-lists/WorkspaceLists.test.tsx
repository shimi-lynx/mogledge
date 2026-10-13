import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { KnowledgeController } from "../../lib/controller";
import type { AppState, Bridge, WorkspaceSet } from "../../lib/types";
import { WorkspaceLists } from "./WorkspaceLists";
import { setLanguage } from "../../lib/i18n";
beforeEach(() => {
  setLanguage("ja");
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  setLanguage("ja");
});
function setup() {
  const snapshot = {
    workspaceId: "root",
    viewId: "view",
    rootPath: "/fixture",
    revision: 1,
    nodes: [],
    watchError: null,
  };
  const api: Bridge = {
    beginView: vi.fn(async () => snapshot),
    getTree: vi.fn(async () => snapshot),
    chooseRoot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    createTab: vi.fn(async () => "tab"),
    closeTab: vi.fn(async () => {}),
    openDocument: vi.fn(async () => "http://fixture"),
    listen: vi.fn(async () => vi.fn()),
    mutateTree: vi.fn(async () => ({ snapshot, createdPath: null, moves: [], warning: null })),
    performFileAction: vi.fn(async () => {}),
  };
  const controller = new KnowledgeController(api);
  const readLists = vi.spyOn(controller, "refreshWorkspaceLists").mockResolvedValue(undefined);
  vi.spyOn(controller, "refreshWorkspaceSets").mockResolvedValue(undefined);
  const save = vi.spyOn(controller, "saveWorkspaceSet").mockResolvedValue(true);
  const state: AppState = {
    ...controller.getSnapshot(),
    snapshot,
    loading: false,
    workspaceLists: {
      favorites: [{ relativePath: "資料.html", identity: "f", status: "available" }],
      recent: [],
      error: null,
      readOnly: false,
    },
    workspaceSets: {
      sets: [],
      setShortcuts: [null, null, null, null, null, null, null, null, null, null],
      error: null,
      readOnly: false,
    },
  };
  const onClose = vi.fn();
  return { controller, state, onClose, readLists, save };
}
test("dialog is workspace sets only and does not load or duplicate favorite/recent controls", () => {
  const context = setup();
  render(<WorkspaceLists {...context} />);
  expect(screen.getByRole("dialog", { name: "作業セット" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "お気に入り" })).toBeNull();
  expect(screen.queryByRole("region", { name: "最近の文書" })).toBeNull();
  expect(context.readLists).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
  expect(context.onClose).toHaveBeenCalledOnce();
});
test("help alone cannot be saved and language changes preserve the same set-name input", () => {
  const context = setup();
  context.state.tabs = [
    {
      kind: "help",
      id: "help",
      path: "機能と使い方",
      url: null,
      loading: false,
      closing: false,
      dirty: false,
      missing: false,
      error: null,
    },
  ];
  context.state.workspaceSets!.error = "作業セットを保存できません: 原因は保持される";
  render(<WorkspaceLists {...context} />);
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: "新しい作業セット名" });
  fireEvent.change(input, { target: { value: "日本語 $& {count}" } });
  input.focus();
  act(() => {
    setLanguage("en");
  });
  expect(screen.getByRole("dialog", { name: "Workspace sets" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "New workspace set name" })).toBe(input);
  expect(input.value).toBe("日本語 $& {count}");
  expect(document.activeElement).toBe(input);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Save current layout" }).disabled,
  ).toBe(true);
  expect(screen.getByRole("alert").textContent).toBe(
    "Could not save the workspace set: Details: 原因は保持される",
  );
});
test("assigns stable IDs, disables occupied slots and retains the selector on language changes", () => {
  const context = setup();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  const makeSet = (id: string, name: string): WorkspaceSet => ({
    id,
    name,
    items: [{ document: { relativePath: "a.html", identity: "f" }, column: 0, zoom: 100 }],
    active: [0, null],
    activeColumn: 0,
  });
  context.state.workspaceSets!.sets = [makeSet("a", "A"), makeSet("b", "B")];
  context.state.workspaceSets!.setShortcuts[0] = "a";
  const assign = vi.spyOn(context.controller, "assignWorkspaceSetShortcut").mockResolvedValue(true);
  const restore = vi.spyOn(context.controller, "restoreWorkspaceSet");
  const view = render(<WorkspaceLists {...context} />);
  const a = screen.getByRole<HTMLSelectElement>("combobox", { name: "Aのショートカット" });
  const b = screen.getByRole<HTMLSelectElement>("combobox", { name: "Bのショートカット" });
  expect(a.value).toBe("1");
  expect(b.value).toBe("");
  expect(b.options.length).toBe(11);
  expect(b.options[1]!.disabled).toBe(true);
  expect(b.options[10]!.textContent).toBe("Ctrl+Shift+0");
  fireEvent.change(b, { target: { value: "10" } });
  expect(assign).toHaveBeenLastCalledWith("b", 10);
  fireEvent.change(a, { target: { value: "" } });
  expect(assign).toHaveBeenLastCalledWith("a", null);
  expect(restore).not.toHaveBeenCalled();
  b.focus();
  act(() => {
    setLanguage("en");
  });
  expect(screen.getByRole("combobox", { name: "Shortcut for B" })).toBe(b);
  expect(document.activeElement).toBe(b);
  expect(b.options[0]!.textContent).toBe("Unassigned");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  view.rerender(<WorkspaceLists {...context} state={{ ...context.state, actionBusy: true }} />);
  expect(b.options[10]!.textContent).toBe("Cmd+Shift+0");
  expect(b.disabled).toBe(true);
  view.rerender(
    <WorkspaceLists
      {...context}
      state={{
        ...context.state,
        workspaceSets: { ...context.state.workspaceSets!, readOnly: true },
      }}
    />,
  );
  expect(a.disabled).toBe(true);
});
