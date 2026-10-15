import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { StrictMode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { App } from "./App";
import { aiHandoffApi, bridge } from "../lib/bridge";
import { setLanguage } from "../lib/i18n";
import type { Snapshot } from "../lib/types";

const searchMock = vi.hoisted(() => vi.fn());
const dialogDescriptors = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
};

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));

vi.mock("../features/document-search/bridge", () => ({
  searchBridge: {
    getStatus: vi.fn(async () => ({
      workspaceId: "layout",
      rootId: "layout",
      phase: "ready",
      generation: 1,
      requestRevision: 1,
      indexed: 1,
      complete: true,
    })),
    search: searchMock.mockResolvedValue({
      generation: 1,
      requestRevision: 1,
      normalizedQuery: "日本語",
      hasMore: false,
      hits: [
        { documentId: "0", relativePath: "Examples/0.html", title: "検索文書", snippet: "本文" },
      ],
    }),
    rebuild: vi.fn(),
  },
}));

vi.mock("../lib/bridge", () => {
  let serial = 0;
  return {
    aiHandoffApi: {
      prepare: vi.fn(async () => ({
        kind: "file",
        selectedPath: "/knowledge/Examples/0.html",
        workingDirectory: "/knowledge/Examples",
        revision: 1,
      })),
      perform: vi.fn(async () => {}),
    },
    bridge: {
      getDocumentStateRecovery: vi.fn(),
      getDocumentStorageHold: vi.fn(),
      recoverDocumentState: vi.fn(async () => {}),
      mutateTree: vi.fn(),
      performFileAction: vi.fn(async () => {}),
      beginView: vi.fn(),
      createTab: vi.fn(async () => String(++serial)),
      closeTab: vi.fn(async () => {}),
      getTree: vi.fn(),
      chooseRoot: vi.fn(),
      getManagedFolders: vi.fn(),
      createManagedFolder: vi.fn(),
      registerManagedFolder: vi.fn(),
      selectManagedFolder: vi.fn(),
      unregisterManagedFolder: vi.fn(),
      chooseDisplayFolder: vi.fn(),
      setDisplayFolder: vi.fn(),
      refresh: vi.fn(),
      openDocument: vi.fn(),
      listen: vi.fn(async () => () => {}),
    },
  };
});
const snapshot: Snapshot = {
  workspaceId: "layout",
  viewId: "view-layout",
  rootPath: "/knowledge",
  revision: 1,
  watchError: null,
  nodes: [
    {
      name: "Examples",
      relativePath: "Examples",
      kind: "folder",
      children: Array.from({ length: 10001 }, (_, index) => ({
        name: `${index}.html`,
        relativePath: `Examples/${index}.html`,
        kind: "html" as const,
        children: [],
      })),
    },
  ],
};
beforeEach(() => {
  localStorage.removeItem("my-knowledge.search-preferences");
  setLanguage("ja");
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.mocked(getVersion).mockRejectedValue(new Error("Application metadata unavailable"));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(bridge.getTree).mockResolvedValue(snapshot);
  vi.mocked(bridge.getManagedFolders!).mockResolvedValue({
    revision: "1",
    selectedId: "layout",
    folders: [
      {
        id: "layout",
        name: "knowledge",
        path: "/knowledge",
        status: "ready",
        kitUpdate: "current",
        error: null,
      },
    ],
  });
  vi.mocked(bridge.beginView).mockResolvedValue(snapshot);
  vi.mocked(bridge.openDocument).mockResolvedValue("http://127.0.0.1:9999/s/test/0.html");
  if (bridge.chooseDisplayFolder) vi.mocked(bridge.chooseDisplayFolder).mockResolvedValue(null);
  if (bridge.setDisplayFolder) vi.mocked(bridge.setDisplayFolder).mockResolvedValue(snapshot);
  if (bridge.getDocumentStateRecovery)
    vi.mocked(bridge.getDocumentStateRecovery).mockResolvedValue(null);
  if (bridge.getDocumentStorageHold)
    vi.mocked(bridge.getDocumentStorageHold).mockResolvedValue(null);
});

it.each(["ja", "en"] as const)(
  "empty managed-folder registry shows ordinary onboarding in %s without recovery warnings",
  async (language) => {
    setLanguage(language);
    const empty: Snapshot = {
      ...snapshot,
      workspaceId: null,
      rootPath: null,
      viewId: "empty-view",
      nodes: [],
    };
    vi.mocked(bridge.beginView).mockResolvedValue(empty);
    vi.mocked(bridge.getTree).mockResolvedValue(empty);
    vi.mocked(bridge.getManagedFolders!).mockResolvedValue({
      revision: "empty",
      selectedId: null,
      folders: [],
    });
    const view = render(<App />);
    const message =
      language === "ja"
        ? "Mogledge専用フォルダーを作成して始めましょう"
        : "Create a Mogledge folder to get started";
    expect(await view.findByText(message)).toBeTruthy();
    expect(view.container.querySelector(".workspace-feedback")).toBeNull();
    expect(
      view.queryByRole("button", {
        name: language === "ja" ? "保存フォルダーを再試行" : "Retry saved folder",
      }),
    ).toBeNull();
    fireEvent.click(
      view.getByRole("button", {
        name:
          language === "ja" ? "専用フォルダーを作成・登録" : "Create or register a Mogledge folder",
      }),
    );
    const dialog = await view.findByRole("dialog");
    expect(
      await within(dialog).findByRole("textbox", {
        name: language === "ja" ? "新しいフォルダー名" : "New folder name",
      }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", {
        name: language === "ja" ? "既存フォルダーを登録" : "Register an existing folder",
      }),
    ).toBeTruthy();
    expect(bridge.chooseRoot).not.toHaveBeenCalled();
  },
);

it("unregistering the last managed folder returns to ordinary onboarding without a retry warning", async () => {
  const empty: Snapshot = {
    ...snapshot,
    workspaceId: null,
    rootPath: null,
    viewId: "empty-view",
    nodes: [],
  };
  vi.mocked(bridge.unregisterManagedFolder!).mockImplementation(async () => {
    vi.mocked(bridge.beginView).mockResolvedValue(empty);
    vi.mocked(bridge.getTree).mockResolvedValue(empty);
    return { revision: "empty", selectedId: null, folders: [] };
  });
  const view = render(<App />);
  await view.findByRole("tree");
  fireEvent.click(view.container.querySelector(".workspace-button")!);
  const dialog = await view.findByRole("dialog");
  fireEvent.click(await within(dialog).findByRole("button", { name: "登録解除" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "この登録を解除" }));
  await within(dialog).findByText("専用フォルダーはまだありません");
  fireEvent.click(within(dialog).getByRole("button", { name: "閉じる" }));
  expect(await view.findByText("Mogledge専用フォルダーを作成して始めましょう")).toBeTruthy();
  expect(view.container.querySelector(".workspace-feedback")).toBeNull();
  expect(view.queryByRole("button", { name: "保存フォルダーを再試行" })).toBeNull();
});

it("a genuinely missing registered folder retains its recovery reason and retry action", async () => {
  const missing: Snapshot = {
    ...snapshot,
    workspaceId: null,
    rootPath: null,
    viewId: "missing-view",
    nodes: [],
    startupRecovery: { reason: "pathUnavailable", canRetry: true },
  };
  vi.mocked(bridge.beginView).mockResolvedValue(missing);
  vi.mocked(bridge.getTree).mockResolvedValue(missing);
  const view = render(<App />);
  expect(await view.findByRole("button", { name: "保存フォルダーを再試行" })).toBeTruthy();
  expect(view.container.querySelector(".workspace-feedback")?.textContent).toContain(
    "ドライブ接続",
  );
  expect(view.queryByText("Mogledge専用フォルダーを作成して始めましょう")).toBeNull();
  expect(view.queryByRole("button", { name: "専用フォルダーを作成・登録" })).toBeNull();
});

it("opens managed folder settings from the root selector without a free picker or disturbing tabs", async () => {
  const view = render(<App />);
  fireEvent.click(await view.findByRole("treeitem", { name: "Examples" }));
  fireEvent.click(await view.findByRole("treeitem", { name: "0 HTML" }));
  await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
  const frame = view.container.querySelector("iframe");
  fireEvent.click(view.container.querySelector(".workspace-button")!);
  const dialog = await view.findByRole("dialog");
  expect(await within(dialog).findByText("/knowledge")).toBeTruthy();
  expect(bridge.chooseRoot).not.toHaveBeenCalled();
  expect(bridge.chooseDisplayFolder).not.toHaveBeenCalled();
  expect(view.container.querySelector(".display-folder-actions")).toBeNull();
  expect(view.container.querySelector("iframe")).toBe(frame);
  expect(bridge.closeTab).not.toHaveBeenCalled();
});

it("keeps saved-data holds visible outside the HTML when the sidebar is hidden", async () => {
  vi.mocked(bridge.beginView).mockResolvedValue({
    ...snapshot,
    storageHold: { reason: "StorageIdentityConfirmationRequired" },
  });
  const view = render(<App />);
  await view.findByRole("tree");
  fireEvent.click(view.getByRole("button", { name: "左メニューを閉じる" }));
  const notice = view
    .getByText("保存データの利用を保留しています")
    .closest(".storage-hold-notice")!;
  expect(notice.closest("[hidden], iframe")).toBeNull();
  expect(notice.textContent).toContain("独立したバックアップ");
  expect(notice.textContent).toContain("復元・保存・削除は利用できません");
  fireEvent.click(
    within(notice as HTMLElement).getByRole("button", { name: "Mogledge 専用フォルダーを管理" }),
  );
  const dialog = await view.findByRole("dialog", { name: "設定" });
  fireEvent.click(within(dialog).getByRole("button", { name: "専用フォルダー" }));
  expect(within(dialog).getByText("/knowledge")).toBeTruthy();
  expect(within(dialog).getByText(/ガイド・テンプレート/)).toBeTruthy();
  expect(bridge.chooseRoot).not.toHaveBeenCalled();
});

it("keeps the managed folder list open when registration fails", async () => {
  vi.mocked(bridge.registerManagedFolder!).mockRejectedValue("setup conflict");
  const view = render(<App />);
  await view.findByRole("tree");
  fireEvent.click(view.container.querySelector(".workspace-button")!);
  const dialog = await view.findByRole("dialog");
  fireEvent.click(await within(dialog).findByRole("button", { name: "既存フォルダーを登録" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("setup conflict");
  expect(view.getByRole("dialog")).toBe(dialog);
  expect(bridge.chooseRoot).not.toHaveBeenCalled();
  expect(bridge.chooseDisplayFolder).not.toHaveBeenCalled();
});

it("shows a document-specific storage hold even when the registered folder is confirmed", async () => {
  vi.mocked(bridge.getDocumentStorageHold!).mockResolvedValue({
    reason: "StorageIdentityConfirmationRequired",
  });
  const view = render(<App />);
  fireEvent.click(await view.findByRole("treeitem", { name: "Examples" }));
  fireEvent.click(await view.findByRole("treeitem", { name: "0 HTML" }));
  await view.findByText("保存データの利用を保留しています");
  expect(view.container.querySelector("iframe")).not.toBeNull();
  expect(view.container.querySelector(".storage-hold-notice")?.textContent).toContain(
    "データは保持されています",
  );
  expect(bridge.chooseRoot).not.toHaveBeenCalled();
});

it("keeps an inactive visible pane's hold notice scoped to that document when the active pane is healthy", async () => {
  vi.mocked(bridge.getDocumentStorageHold!)
    .mockResolvedValueOnce({ reason: "StorageIdentityConfirmationRequired" })
    .mockResolvedValue(null);
  const view = render(<App />);
  fireEvent.click(await view.findByRole("treeitem", { name: "Examples" }));
  fireEvent.click(await view.findByRole("treeitem", { name: "0 HTML" }));
  await view.findByText("保存データの利用を保留しています");
  fireEvent.contextMenu(view.getByRole("treeitem", { name: "1 HTML" }));
  fireEvent.click(view.getByRole("menuitem", { name: "右の列で開く" }));
  await waitFor(() =>
    expect(view.container.querySelectorAll(".document-pane:not([hidden]) iframe")).toHaveLength(2),
  );
  await waitFor(() =>
    expect(view.getByRole("tab", { name: "1.html" }).getAttribute("aria-selected")).toBe("true"),
  );
  await waitFor(() => expect(bridge.getDocumentStorageHold).toHaveBeenCalledTimes(2));
  const notice = view.container.querySelector(".storage-hold-notice");
  expect(notice).not.toBeNull();
  expect(notice?.textContent).toContain("Examples/0.html");
  expect(notice?.textContent).not.toContain("Examples/1.html");
  expect(notice?.textContent).toContain("保留対象の文書");
});

it.each([
  ["Win32", "ctrlKey", "metaKey"],
  ["MacIntel", "metaKey", "ctrlKey"],
] as const)(
  "opens settings with %s comma keys while preserving editor IME modal and shell focus",
  async (platform, modifier, other) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const view = render(<App />);
    const tree = await view.findByRole("tree");
    tree.focus();
    for (const fields of [
      { [other]: true },
      { [modifier]: true, shiftKey: true },
      { [modifier]: true, altKey: true },
      { ctrlKey: true, metaKey: true },
      { [modifier]: true, isComposing: true },
      { [modifier]: true, keyCode: 229 },
      { [modifier]: true, repeat: true },
    ])
      fireEvent.keyDown(tree, { key: ",", ...fields });
    const cancelled = new KeyboardEvent("keydown", {
      key: ",",
      [modifier]: true,
      bubbles: true,
      cancelable: true,
    });
    cancelled.preventDefault();
    fireEvent(tree, cancelled);
    fireEvent.compositionStart(tree);
    fireEvent.keyDown(tree, { key: ",", [modifier]: true });
    fireEvent.compositionEnd(tree);
    const modal = document.createElement("dialog");
    modal.open = true;
    document.body.append(modal);
    fireEvent.keyDown(tree, { key: ",", [modifier]: true });
    modal.remove();
    for (const tag of ["input", "textarea", "select", "div"]) {
      const editor = document.createElement(tag);
      if (tag === "div") editor.setAttribute("contenteditable", "true");
      editor.tabIndex = 0;
      document.body.append(editor);
      editor.focus();
      fireEvent.keyDown(editor, { key: ",", [modifier]: true });
      editor.remove();
    }
    expect(view.queryByRole("dialog")).toBeNull();
    tree.focus();
    fireEvent.keyDown(tree, { key: ",", [modifier]: true });
    const dialog = await view.findByRole("dialog", { name: "設定" });
    const select = within(dialog).getByRole("combobox");
    select.focus();
    fireEvent.keyDown(select, { key: ",", [modifier]: true });
    expect(view.getAllByRole("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(select);
    fireEvent.keyDown(select, { key: "Escape" });
    expect(document.activeElement).toBe(tree);
    fireEvent.click(view.getByRole("button", { name: "左メニューを閉じる" }));
    const show = view.getByRole("button", { name: "左メニューを開く" });
    show.focus();
    fireEvent.keyDown(show, { key: ",", [modifier]: true });
    const hiddenDialog = await view.findByRole("dialog", { name: "設定" });
    expect(hiddenDialog.closest("[hidden], [inert]")).toBeNull();
    fireEvent.keyDown(hiddenDialog, { key: "Escape" });
    expect(document.activeElement).toBe(show);
    expect(bridge.openDocument).not.toHaveBeenCalled();
  },
);

it.each([
  ["Win32", "ctrlKey", "metaKey"],
  ["MacIntel", "metaKey", "ctrlKey"],
] as const)(
  "opens a bounded quick picker with %s keys, skips editors/IME/modal and returns focus",
  async (platform, modifier, other) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const view = render(<App />);
    const tree = await view.findByRole("tree");
    tree.focus();
    for (const fields of [
      { [other]: true },
      { [modifier]: true, shiftKey: true },
      { [modifier]: true, altKey: true },
      { [modifier]: true, isComposing: true },
      { [modifier]: true, repeat: true },
    ])
      fireEvent.keyDown(tree, { key: "p", ...fields });
    expect(view.queryByRole("dialog")).toBeNull();
    expect(fireEvent.keyDown(tree, { key: "p", [modifier]: true })).toBe(false);
    const picker = view.getByRole("dialog", { name: "クイックオープン" });
    const input = view.getByRole("combobox", { name: "ファイル名・相対パス" });
    expect(document.activeElement).toBe(input);
    expect(
      within(view.getByRole("dialog", { name: "クイックオープン" })).getAllByRole("option"),
    ).toHaveLength(20);
    expect(bridge.openDocument).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(picker.hasAttribute("open")).toBe(true);
    expect(
      within(view.getByRole("dialog", { name: "クイックオープン" }))
        .getAllByRole("option")[0]
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.compositionEnd(input);
    fireEvent.change(input, { target: { value: "10000" } });
    expect(
      within(view.getByRole("dialog", { name: "クイックオープン" })).getAllByRole("option"),
    ).toHaveLength(1);
    fireEvent.keyDown(input, { key: "p", [modifier]: true });
    await waitFor(() => expect(document.activeElement).toBe(tree));
    expect(view.queryByRole("dialog")).toBeNull();
    const editor = document.createElement("input");
    document.body.append(editor);
    editor.focus();
    fireEvent.keyDown(editor, { key: "p", [modifier]: true });
    expect(view.queryByRole("dialog")).toBeNull();
    editor.remove();
    tree.focus();
    fireEvent.compositionStart(tree);
    fireEvent.keyDown(tree, { key: "p", [modifier]: true });
    expect(view.queryByRole("dialog")).toBeNull();
    fireEvent.compositionEnd(tree);
    const modal = document.createElement("dialog");
    modal.open = true;
    document.body.append(modal);
    fireEvent.keyDown(tree, { key: "p", [modifier]: true });
    expect(view.queryByRole("combobox", { name: "ファイル名・相対パス" })).toBeNull();
    modal.remove();
  },
);

it.each([
  ["Win32", "ctrlKey", "metaKey"],
  ["MacIntel", "metaKey", "ctrlKey"],
] as const)(
  "toggles the sidebar with %s app keys and preserves editors, IME, modal and tree state",
  async (platform, modifier, other) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    let time = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    const view = render(<App />);
    const tree = await view.findByRole("tree");
    const sidebar = view.container.querySelector<HTMLElement>("#knowledge-sidebar")!;
    tree.focus();
    tree.scrollTop = 720;
    fireEvent.scroll(tree);
    const width = sidebar.style.width;
    const selection = tree.getAttribute("aria-activedescendant");
    for (const fields of [
      { [other]: true },
      { [modifier]: true, shiftKey: true },
      { [modifier]: true, altKey: true },
      { [modifier]: true, isComposing: true },
      { [modifier]: true, keyCode: 229 },
      { [modifier]: true, repeat: true },
    ])
      fireEvent.keyDown(tree, { key: "b", ...fields });
    expect(sidebar.hidden).toBe(false);
    const canceled = new KeyboardEvent("keydown", {
      key: "b",
      [modifier]: true,
      bubbles: true,
      cancelable: true,
    });
    canceled.preventDefault();
    fireEvent(tree, canceled);
    fireEvent.compositionStart(tree);
    fireEvent.keyDown(tree, { key: "b", [modifier]: true });
    fireEvent.compositionEnd(tree);
    const modal = document.createElement("dialog");
    modal.open = true;
    document.body.append(modal);
    fireEvent.keyDown(tree, { key: "b", [modifier]: true });
    modal.remove();
    for (const tag of ["input", "textarea", "select", "div"]) {
      const editor = document.createElement(tag);
      if (tag === "div") editor.setAttribute("contenteditable", "true");
      document.body.append(editor);
      editor.tabIndex = 0;
      editor.focus();
      expect(fireEvent.keyDown(editor, { key: "b", [modifier]: true })).toBe(true);
      editor.remove();
    }
    expect(sidebar.hidden).toBe(false);
    tree.focus();
    expect(fireEvent.keyDown(tree, { key: "b", [modifier]: true })).toBe(false);
    expect(sidebar.hidden).toBe(true);
    const show = view.getByRole("button", { name: "左メニューを開く" });
    expect(show).toBe(document.activeElement);
    expect(show.title).toContain(platform === "MacIntel" ? "Cmd+B" : "Ctrl+B");
    fireEvent.keyDown(show, { key: "b", [modifier]: true });
    expect(sidebar.hidden).toBe(true);
    time += 121;
    fireEvent.keyDown(show, { key: "b", [modifier]: true });
    expect(sidebar.hidden).toBe(false);
    expect(sidebar.style.width).toBe(width);
    expect(tree.scrollTop).toBe(720);
    expect(tree.getAttribute("aria-activedescendant")).toBe(selection);
    fireEvent.click(view.getByRole("button", { name: "文書検索" }));
    const input = await view.findByRole("searchbox");
    input.focus();
    fireEvent.keyDown(input, { key: "b", [modifier]: true });
    expect(sidebar.hidden).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "左メニューを閉じる" }));
    expect(sidebar.hidden).toBe(true);
    expect(document.activeElement).toBe(view.getByRole("button", { name: "左メニューを開く" }));
    fireEvent.click(view.getByRole("button", { name: "左メニューを開く" }));
    expect(view.getByRole("button", { name: "文書検索" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(bridge.openDocument).not.toHaveBeenCalled();
  },
);

it("quick-open keeps tree and live iframe state, handles no results and only loads the accepted document", async () => {
  const view = render(<App />);
  fireEvent.click(await view.findByRole("treeitem", { name: /Examples/ }));
  fireEvent.click(view.getByRole("treeitem", { name: /^0\s*HTML$/ }));
  await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
  const frame = view.container.querySelector("iframe");
  const tree = view.getByRole("tree");
  tree.focus();
  tree.scrollTop = 720;
  fireEvent.scroll(tree);
  fireEvent.keyDown(tree, { key: "p", ctrlKey: true });
  const input = view.getByRole("combobox", { name: "ファイル名・相対パス" });
  fireEvent.change(input, { target: { value: "not found" } });
  expect(
    within(view.getByRole("dialog", { name: "クイックオープン" })).queryAllByRole("option"),
  ).toHaveLength(0);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(bridge.openDocument).toHaveBeenCalledTimes(1);
  expect(view.getByRole("dialog")).not.toBeNull();
  fireEvent.change(input, { target: { value: "0.html" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(view.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(tree));
  expect(view.container.querySelector("iframe")).toBe(frame);
  expect(tree.scrollTop).toBe(720);
  expect(bridge.openDocument).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(tree, { key: "p", ctrlKey: true });
  fireEvent.change(view.getByRole("combobox", { name: "ファイル名・相対パス" }), {
    target: { value: "10000" },
  });
  expect(bridge.openDocument).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(view.getByRole("combobox", { name: "ファイル名・相対パス" }), { key: "Enter" });
  await waitFor(() => expect(bridge.openDocument).toHaveBeenCalledTimes(2));
  expect(view.container.querySelectorAll("iframe")[0]).toBe(frame);
});

it("invalidates an open picker when root or renderer view changes", async () => {
  const view = render(<App />);
  const tree = await view.findByRole("tree");
  tree.focus();
  fireEvent.keyDown(tree, { key: "p", ctrlKey: true });
  const listener = vi.mocked(bridge.listen).mock.calls[0][0];
  const replaced = {
    ...snapshot,
    workspaceId: "new-root",
    viewId: "new-view",
    revision: 2,
    nodes: [],
  };
  vi.mocked(bridge.getTree).mockResolvedValue(replaced);
  await act(async () =>
    listener({
      workspaceId: "layout",
      revision: 2,
      changedPaths: [],
      structureChanged: true,
      watchError: null,
    }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(bridge.createTab).not.toHaveBeenCalled();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of ["showModal", "close"] as const) {
    const descriptor = dialogDescriptors[name];
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
it("shows runtime version in the existing footer and retains it across sidebar toggles", async () => {
  vi.mocked(getVersion).mockResolvedValue("9.8.7-test");
  const view = render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  const version = await view.findByText("v9.8.7-test");
  const footer = view.container.querySelector(".sidebar-footer")!;
  const sidebar = view.container.querySelector<HTMLElement>("#knowledge-sidebar")!;
  expect(footer.contains(version)).toBe(true);
  expect(footer.children).toHaveLength(2);
  expect(footer.textContent).not.toContain("documents");
  expect(footer.firstElementChild).toBe(version);
  expect(view.getByRole("button", { name: "設定" })).toBeTruthy();
  expect(getVersion).toHaveBeenCalledOnce();
  fireEvent.click(view.getByRole("button", { name: "左メニューを閉じる" }));
  expect(sidebar.hidden).toBe(true);
  expect(view.container.querySelector(".content .sidebar-version")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "左メニューを開く" }));
  expect(view.getByText("v9.8.7-test")).toBe(version);
  expect(getVersion).toHaveBeenCalledOnce();
});
it("omits the version when runtime metadata is unavailable without a fallback or error notice", async () => {
  const view = render(<App />);
  await view.findByRole("tree");
  expect(view.container.querySelector(".sidebar-version")).toBeNull();
  expect(view.queryByText("Application metadata unavailable")).toBeNull();
  expect(getVersion).toHaveBeenCalledOnce();
});
it("opens one bundled help tab on request and preserves live frames without Native reads", async () => {
  const view = render(<App />);
  fireEvent.click(await view.findByRole("treeitem", { name: /Examples/ }));
  fireEvent.click(view.getByRole("treeitem", { name: /^0\s*HTML$/ }));
  await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
  const frame = view.container.querySelector('iframe[title="Examples/0.html"]');
  const tree = view.getByRole("tree");
  tree.scrollTop = 720;
  fireEvent.scroll(tree);
  const help = view.getByRole("button", { name: "機能と使い方" });
  expect(view.queryByRole("tab", { name: "機能と使い方" })).toBeNull();
  const opens = vi.mocked(bridge.openDocument).mock.calls.length;
  const scans = vi.mocked(bridge.getTree).mock.calls.length;
  const closes = vi.mocked(bridge.closeTab).mock.calls.length;
  for (let attempt = 0; attempt < 3; attempt++) fireEvent.click(help);
  const helpTab = await view.findByRole("tab", { name: "機能と使い方" });
  expect(view.getAllByRole("tab", { name: "機能と使い方" })).toHaveLength(1);
  expect(view.queryByRole("dialog")).toBeNull();
  expect(view.container.querySelector('iframe[title="Examples/0.html"]')).toBe(frame);
  fireEvent.keyDown(helpTab, { key: "w", ctrlKey: true });
  await waitFor(() => expect(view.queryByRole("tab", { name: "機能と使い方" })).toBeNull());
  expect(view.container.querySelector('iframe[title="Examples/0.html"]')).toBe(frame);
  expect(view.getByRole("tree")).toBe(tree);
  expect(tree.scrollTop).toBe(720);
  expect(bridge.openDocument).toHaveBeenCalledTimes(opens);
  expect(bridge.getTree).toHaveBeenCalledTimes(scans);
  expect(bridge.closeTab).toHaveBeenCalledTimes(closes);
});

it("opens AI confirmation for the loaded active HTML with Ctrl+Shift+A without dispatching", async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
  const view = render(<App />);
  fireEvent.click(await view.findByRole("treeitem", { name: /Examples/ }));
  fireEvent.click(view.getByRole("treeitem", { name: /^0\s*HTML$/ }));
  await waitFor(() =>
    expect(view.getByRole("tab", { name: "0.html" }).getAttribute("aria-selected")).toBe("true"),
  );
  await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
  const toolbar = view.getByRole("button", { name: "機能と使い方" });
  toolbar.focus();
  const search = view.container.querySelector<HTMLInputElement>("#document-search-query")!;
  search.focus();
  fireEvent.keyDown(search, { key: "a", ctrlKey: true, shiftKey: true });
  toolbar.focus();
  fireEvent(window, new Event("compositionstart", { bubbles: true }));
  fireEvent.keyDown(window, { key: "a", ctrlKey: true, shiftKey: true });
  fireEvent(window, new Event("compositionend", { bubbles: true }));
  for (const change of [
    { metaKey: true },
    { altKey: true },
    { repeat: true },
    { keyCode: 229 },
    { shiftKey: false },
  ])
    fireEvent.keyDown(window, { key: "a", ctrlKey: true, shiftKey: true, ...change });
  expect(aiHandoffApi.prepare).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "a", ctrlKey: true, shiftKey: true });
  await view.findByRole("dialog", { name: "AIに渡す" });
  expect(aiHandoffApi.prepare).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "layout",
    viewId: "view-layout",
    relativePath: "Examples/0.html",
  });
  expect(aiHandoffApi.perform).not.toHaveBeenCalled();
});

it("suppresses shell refresh keys while preserving the live tab", async () => {
  const view = render(<App />);
  fireEvent.click(await view.findByRole("treeitem", { name: /Examples/ }));
  fireEvent.click(view.getByRole("treeitem", { name: /^0\s*HTML$/ }));
  await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
  const frame = view.container.querySelector("iframe");
  const input = view.container.querySelector<HTMLInputElement>("#document-search-query")!;
  for (const target of [window, input])
    for (const shiftKey of [false, true]) {
      expect(fireEvent.keyDown(target, { key: "r", ctrlKey: true, shiftKey })).toBe(false);
      expect(view.container.querySelector("iframe")).toBe(frame);
    }
  expect(fireEvent.keyDown(window, { key: "r" })).toBe(true);
  expect(fireEvent.keyDown(window, { key: "r", ctrlKey: true, altKey: true })).toBe(true);
});
it("keeps the expanded, selected, scrolled tree and document when toggling the menu", async () => {
  const view = render(<App />);
  const folder = await view.findByRole("treeitem", { name: /Examples/ });
  fireEvent.click(folder);
  fireEvent.click(view.getByRole("treeitem", { name: /^0\s*HTML$/ }));
  await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
  const frame = view.container.querySelector("iframe");
  const tree = view.getByRole("tree");
  tree.scrollTop = 720;
  fireEvent.scroll(tree);
  const calls = vi.mocked(bridge.getTree).mock.calls.length;
  for (let index = 0; index < 3; index++) {
    fireEvent.click(view.getByRole("button", { name: "左メニューを閉じる" }));
    expect(view.queryByRole("tree")).toBeNull();
    const show = view.getByRole("button", { name: "左メニューを開く" });
    expect(show.getAttribute("aria-expanded")).toBe("false");
    expect(show.getAttribute("aria-controls")).toBe("knowledge-sidebar");
    fireEvent.click(show);
    expect(view.getByRole("tree")).toBe(tree);
    expect(tree.scrollTop).toBe(720);
    expect(view.container.querySelector("iframe")).toBe(frame);
  }
  tree.scrollTop = 0;
  fireEvent.scroll(tree);
  expect(folder.getAttribute("aria-expanded")).toBe("true");
  expect(view.getByRole("treeitem", { name: /^0\s*HTML$/ }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(bridge.getTree).toHaveBeenCalledTimes(calls);
  expect(bridge.openDocument).toHaveBeenCalledTimes(1);
  expect(bridge.refresh).not.toHaveBeenCalled();
});
it("returns focus on Escape and keeps failure feedback accessible without a viewer banner", async () => {
  vi.mocked(bridge.getTree).mockResolvedValue({ ...snapshot, watchError: "監視が停止しました" });
  vi.mocked(bridge.beginView).mockResolvedValue({ ...snapshot, watchError: "監視が停止しました" });
  vi.mocked(bridge.openDocument).mockRejectedValue("文書を開けません");
  const view = render(<App />);
  fireEvent.click(await view.findByRole("treeitem", { name: /Examples/ }));
  fireEvent.click(view.getByRole("treeitem", { name: /^0\s*HTML$/ }));
  await view.findByRole("alert");
  const tree = view.getByRole("tree");
  tree.focus();
  fireEvent.keyDown(tree, { key: "Escape" });
  const show = view.getByRole("button", { name: "左メニューを開く" });
  expect(document.activeElement).toBe(show);
  expect(view.getByRole("alert").textContent).toContain("文書を開けません");
  expect(view.container.querySelector('.viewer-content [role="alert"]')).toBeNull();
  expect(show.getAttribute("data-has-issue")).toBe("true");
  fireEvent.click(show);
  expect(
    view.container.querySelector('.workspace-feedback [role="status"]')?.textContent,
  ).toContain("監視が停止しました");
  expect(view.getAllByRole("button", { name: "再走査" }).length).toBeGreaterThan(0);
});

it("switches a compact search view while retaining the tree, query and document frame", async () => {
  const view = render(<App />);
  fireEvent.click(await view.findByRole("treeitem", { name: /Examples/ }));
  fireEvent.click(view.getByRole("treeitem", { name: /^0\s*HTML$/ }));
  await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
  const frame = view.container.querySelector("iframe");
  const tree = view.getByRole("tree");
  tree.scrollTop = 720;
  fireEvent.scroll(tree);
  expect(view.queryByRole("searchbox")).toBeNull();
  const showSearch = view.getByRole("button", { name: "文書検索" });
  fireEvent.click(showSearch);
  const input = view.getByRole("searchbox");
  expect(document.activeElement).toBe(input);
  expect(view.queryByRole("tree")).toBeNull();
  expect(view.container.querySelector("details")?.hasAttribute("open")).toBe(false);
  fireEvent.change(input, { target: { value: "日本語" } });
  // Allow the debounced search to settle alongside this large tree fixture.
  fireEvent.click(await view.findByRole("button", { name: /検索文書/ }, { timeout: 5_000 }));
  expect(view.container.querySelector("iframe")).toBe(frame);
  expect(bridge.openDocument).toHaveBeenCalledTimes(1);
  fireEvent.click(view.getByRole("button", { name: /ファイル/ }));
  expect(view.getByRole("tree")).toBe(tree);
  expect(tree.scrollTop).toBe(720);
  fireEvent.click(showSearch);
  expect((view.getByRole("searchbox") as HTMLInputElement).value).toBe("日本語");
  fireEvent.keyDown(input, { key: "Escape" });
  expect((input as HTMLInputElement).value).toBe("");
  expect(view.getByRole("searchbox")).toBe(input);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(view.queryByRole("searchbox")).toBeNull();
  expect(view.getByRole("tree")).toBe(tree);
  expect(document.activeElement).toBe(showSearch);
  expect(view.container.querySelector("iframe")).toBe(frame);
});

it("skips a pending-close tab during keyboard navigation", async () => {
  let release!: () => void;
  vi.mocked(bridge.closeTab).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const view = render(<App />);
  fireEvent.click(await view.findByRole("treeitem", { name: /Examples/ }));
  for (const index of [0, 1, 2]) {
    fireEvent.click(view.getByRole("treeitem", { name: new RegExp(`^${index}\\s*HTML$`) }));
    await waitFor(() => expect(view.container.querySelectorAll("iframe")).toHaveLength(index + 1));
  }
  fireEvent.click(view.getByRole("button", { name: "Examples/1.htmlを閉じる" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  const zero = view.getByRole("tab", { name: "0.html" });
  const two = view.getByRole("tab", { name: "2.html" });
  zero.focus();
  fireEvent.keyDown(zero, { key: "ArrowRight" });
  expect(document.activeElement).toBe(two);
  fireEvent.keyDown(two, { key: "Tab", ctrlKey: true });
  expect(document.activeElement).toBe(zero);
  fireEvent.keyDown(zero, { key: "End" });
  expect(document.activeElement).toBe(two);
  fireEvent.keyDown(two, { key: "Home" });
  expect(document.activeElement).toBe(zero);
  await act(async () => release());
  expect(view.queryByRole("tab", { name: "1.html" })).toBeNull();
});

it("focuses retained search with the shortcut repeatedly without duplicate searches", async () => {
  const view = render(<App />);
  await view.findByRole("tree");
  fireEvent.keyDown(window, { key: "f", ctrlKey: true, shiftKey: true });
  const input = view.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "日本語" } });
  await view.findByRole("button", { name: /検索文書/ });
  const calls = searchMock.mock.calls.length;
  view.getByRole("button", { name: "文書検索" }).focus();
  fireEvent.keyDown(window, { key: "f", ctrlKey: true, shiftKey: true });
  expect(document.activeElement).toBe(input);
  expect((input as HTMLInputElement).value).toBe("日本語");
  expect(searchMock).toHaveBeenCalledTimes(calls);
  expect(view.container.querySelector("header.toolbar")).toBeNull();
  expect(view.container.querySelector(".toolbar-status")).toBeNull();
  expect(
    view.container
      .querySelector(".titlebar")
      ?.contains(view.getByRole("button", { name: "左メニューを閉じる" })),
  ).toBe(true);
});

it("opens a folder-scoped search and clears its scope while preserving the query", async () => {
  const view = render(<App />);
  const folder = await view.findByRole("treeitem", { name: /Examples/ });
  fireEvent.contextMenu(folder);
  fireEvent.click(view.getByRole("menuitem", { name: "このフォルダー内を検索" }));
  const input = view.getByRole("searchbox");
  expect(document.activeElement).toBe(input);
  expect(view.getByLabelText("検索範囲").textContent).toContain("範囲: Examples");
  fireEvent.change(input, { target: { value: "日本語" } });
  await waitFor(() =>
    expect(searchMock).toHaveBeenLastCalledWith("layout", "日本語", 20, 0, "and", {
      relativePath: "Examples",
      viewId: "view-layout",
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "ファイル" }));
  fireEvent.click(view.getByRole("button", { name: "文書検索" }));
  expect(view.getByLabelText("検索範囲")).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "検索範囲を解除" }));
  expect(document.activeElement).toBe(input);
  expect(view.queryByLabelText("検索範囲")).toBeNull();
  expect((input as HTMLInputElement).value).toBe("日本語");
  await waitFor(() =>
    expect(searchMock).toHaveBeenLastCalledWith("layout", "日本語", 20, 0, "and"),
  );
});

it("asks whether the replacement HTML is trusted before recovering its previous input state", async () => {
  const getCandidate = bridge.getDocumentStateRecovery;
  const recover = bridge.recoverDocumentState;
  if (!getCandidate || !recover)
    throw new Error("Recovery bridge is missing from the test fixture");
  const candidate = {
    currentIdentity: "replacement",
    sourceIdentity: "previous",
    sourceRevision: 2,
    appCount: 3,
  };
  vi.mocked(getCandidate).mockResolvedValue(candidate);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const view = render(<App />);
  fireEvent.click(await view.findByRole("treeitem", { name: /Examples/ }));
  const html = view.getByRole("treeitem", { name: /^0\s*HTML$/ });
  fireEvent.contextMenu(html);
  fireEvent.click(view.getByRole("menuitem", { name: "以前の入力状態を引き継ぐ" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(confirm.mock.calls[0][0]).toContain("Examples/0.html");
  expect(confirm.mock.calls[0][0]).toContain("信頼できるHTMLの場合だけ");
  expect(confirm.mock.calls[0][0]).toContain("3件");
  expect(recover).not.toHaveBeenCalled();
  await waitFor(() => expect(view.queryByText("ファイル操作中")).toBeNull());
  confirm.mockReturnValue(true);
  fireEvent.contextMenu(html);
  fireEvent.click(view.getByRole("menuitem", { name: "以前の入力状態を引き継ぐ" }));
  await waitFor(() =>
    expect(recover).toHaveBeenCalledWith("layout", "view-layout", "Examples/0.html", candidate),
  );
  expect(view.queryByText("以前の入力状態を引き継ぎました")).toBeNull();
  expect(view.container.querySelector(".viewer-content .notice")).toBeNull();
});

it.each([
  ["Win32", "ctrlKey", "metaKey"],
  ["MacIntel", "metaKey", "ctrlKey"],
] as const)(
  "shows Files with %s primary Shift+E and keeps search state while respecting editors and IME",
  async (platform, primary, other) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const view = render(<App />);
    const tree = await view.findByRole("tree");
    fireEvent.click(view.getByRole("button", { name: "文書検索" }));
    const input = view.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "日本語" } });
    expect(fireEvent.keyDown(input, { key: "e", shiftKey: true, [primary]: true })).toBe(true);
    const search = view.getByRole("button", { name: "文書検索" });
    search.focus();
    for (const fields of [
      { [other]: true, shiftKey: true },
      { [primary]: true },
      { [primary]: true, shiftKey: true, isComposing: true },
      { [primary]: true, shiftKey: true, repeat: true },
      { [primary]: true, shiftKey: true, altKey: true },
    ])
      fireEvent.keyDown(search, { key: "e", ...fields });
    expect(input.closest("[hidden]")).toBeNull();
    fireEvent.compositionStart(search);
    fireEvent.keyDown(search, { key: "e", shiftKey: true, [primary]: true });
    fireEvent.compositionEnd(search);
    expect(input.closest("[hidden]")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "左メニューを閉じる" }));
    const reopen = view.getByRole("button", { name: "左メニューを開く" });
    reopen.focus();
    fireEvent.keyDown(reopen, { key: "E", shiftKey: true, [primary]: true });
    expect(view.container.querySelector<HTMLElement>("#knowledge-sidebar")!.hidden).toBe(false);
    expect(document.activeElement).toBe(tree);
    expect(view.getByRole("button", { name: "ファイル" }).title).toContain(
      platform === "MacIntel" ? "Cmd+Shift+E" : "Ctrl+Shift+E",
    );
    fireEvent.click(search);
    expect((view.getByRole("searchbox") as HTMLInputElement).value).toBe("日本語");
  },
);
