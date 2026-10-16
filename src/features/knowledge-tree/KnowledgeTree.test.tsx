import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { KnowledgeTree } from "./KnowledgeTree";
import type { TreeNode } from "../../lib/types";
import { setLanguage } from "../../lib/i18n";

const nodes: TreeNode[] = [
  { name: "folder.html", relativePath: "folder.html", kind: "folder", children: [] },
  {
    name: "長い日本語の文書.HtM",
    relativePath: "長い日本語の文書.HtM",
    kind: "html",
    children: [],
  },
];
let dialogDescriptors: Record<"showModal" | "close", PropertyDescriptor | undefined>;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  dialogDescriptors = {
    showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
    close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
  };
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      writable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      }),
    },
    close: {
      configurable: true,
      writable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      }),
    },
  });
});
afterEach(() => {
  cleanup();
  for (const name of ["showModal", "close"] as const) {
    const descriptor = dialogDescriptors[name];
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("creates in the displayed child by default while keeping the explicit registered-root action", async () => {
  setLanguage("ja");
  const onMutation = vi.fn(async () => null);
  const view = render(
    <KnowledgeTree
      nodes={[{ name: "child", relativePath: "parent/child", kind: "folder", children: [] }]}
      workspaceId="registered-parent"
      rootPath="/fixture/registered"
      displayFolder="parent/child"
      selected={null}
      onSelect={vi.fn()}
      onMutation={onMutation}
    />,
  );
  const createFolder = view.getByRole("button", { name: "フォルダーを作成" });
  expect(createFolder.getAttribute("aria-description")).toContain("表示フォルダーparent/child");
  fireEvent.click(createFolder);
  expect((view.getByRole("combobox", { name: "作成先" }) as HTMLInputElement).value).toBe(
    "parent/child",
  );
  fireEvent.change(view.getByRole("textbox", { name: "名前" }), { target: { value: "tool" } });
  fireEvent.click(view.getByRole("button", { name: "作成する" }));
  await waitFor(() =>
    expect(onMutation).toHaveBeenCalledWith({
      kind: "createFolder",
      parent: "parent/child",
      name: "tool",
    }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  fireEvent.click(view.getByRole("button", { name: "ルートにフォルダーを作成" }));
  expect((view.getByRole("combobox", { name: "作成先" }) as HTMLInputElement).value).toBe(
    "registered（ルート）",
  );
  fireEvent.change(view.getByRole("textbox", { name: "名前" }), { target: { value: "new-child" } });
  fireEvent.click(view.getByRole("button", { name: "作成する" }));
  await waitFor(() =>
    expect(onMutation).toHaveBeenCalledWith({
      kind: "createFolder",
      parent: "",
      name: "new-child",
    }),
  );
});

it("offers AI path handoff for files and folders without changing the selected document", () => {
  const onSelect = vi.fn();
  const onAiHandoff = vi.fn();
  const view = render(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="workspace"
      selected={null}
      onSelect={onSelect}
      onAiHandoff={onAiHandoff}
    />,
  );
  for (const name of ["folder.html", "長い日本語の文書 HTML"]) {
    fireEvent.contextMenu(view.getByRole("treeitem", { name }), { clientX: 10, clientY: 10 });
    fireEvent.click(view.getByRole("menuitem", { name: "AIに渡す" }));
  }
  expect(onAiHandoff.mock.calls.map(([path]) => path)).toEqual([
    "folder.html",
    "長い日本語の文書.HtM",
  ]);
  expect(onSelect).not.toHaveBeenCalled();
});

it("uses basename labels, original path tooltips, and hidden inline SVG icons", () => {
  const onSelect = vi.fn();
  const view = render(
    <KnowledgeTree nodes={nodes} workspaceId="workspace" selected={null} onSelect={onSelect} />,
  );
  const file = view.getByRole("treeitem", { name: "長い日本語の文書 HTML" });
  expect(file.title).toBe("長い日本語の文書.HtM");
  expect(file.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(file.querySelector(".html-label")).toBeNull();
  expect(file.querySelector(".filename")?.textContent).toBe("長い日本語の文書");
  expect(view.getByRole("treeitem", { name: /folder.html/ })).toBeDefined();
  fireEvent.click(file);
  expect(onSelect).toHaveBeenCalledWith("長い日本語の文書.HtM");
});

it("offers folder search by pointer and keyboard without opening HTML or restoring tree focus", () => {
  const onSearchFolder = vi.fn();
  const onSelect = vi.fn();
  const view = render(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="workspace"
      selected={null}
      onSelect={onSelect}
      onSearchFolder={onSearchFolder}
    />,
  );
  const tree = view.getByRole("tree");
  const folder = view.getByRole("treeitem", { name: /folder.html/ });
  fireEvent.contextMenu(folder);
  fireEvent.click(view.getByRole("menuitem", { name: "このフォルダー内を検索" }));
  expect(onSearchFolder).toHaveBeenCalledWith("folder.html");
  expect(onSelect).not.toHaveBeenCalled();
  expect(view.queryByRole("menu")).toBeNull();
  expect(document.activeElement).not.toBe(tree);
  tree.focus();
  fireEvent.keyDown(tree, { key: "F10", shiftKey: true });
  expect(view.getByRole("menuitem", { name: "このフォルダー内を検索" })).toBeDefined();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  fireEvent.contextMenu(view.getByRole("treeitem", { name: "長い日本語の文書 HTML" }));
  expect(view.queryByRole("menu")).toBeNull();
});

it("opens only the context target in the requested column and restores keyboard focus", () => {
  const onSelect = vi.fn();
  const onOpenColumn = vi.fn();
  const view = render(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="workspace"
      selected="a.html"
      onSelect={onSelect}
      onOpenColumn={onOpenColumn}
    />,
  );
  const tree = view.getByRole("tree");
  fireEvent.contextMenu(view.getByRole("treeitem", { name: "長い日本語の文書 HTML" }), {
    clientX: 20,
    clientY: 40,
  });
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement?.textContent).toBe("右の列で開く");
  fireEvent.click(view.getByRole("menuitem", { name: "右の列で開く" }));
  expect(onOpenColumn).toHaveBeenCalledWith("長い日本語の文書.HtM", 1);
  expect(document.activeElement).toBe(tree);
  fireEvent.keyDown(tree, { key: "F10", shiftKey: true });
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(view.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(tree);
  fireEvent.contextMenu(view.getByRole("treeitem", { name: /folder.html/ }));
  expect(view.queryByRole("menu")).toBeNull();
});

it("renames focused HTML by platform key and cancels without submitting", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  const onMutation = vi.fn(async () => null);
  const onSelect = vi.fn();
  const view = render(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="workspace"
      selected={null}
      onSelect={onSelect}
      onMutation={onMutation}
    />,
  );
  const tree = view.getByRole("tree");
  tree.focus();
  fireEvent.keyDown(tree, { key: "ArrowDown" });
  fireEvent.keyDown(tree, { key: "F2" });
  const input = view.getByRole("textbox") as HTMLInputElement;
  expect(input.value).toBe("長い日本語の文書");
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  fireEvent.keyDown(input, { key: "F2" });
  expect(view.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.change(input, { target: { value: "new name" } });
  fireEvent(view.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  await waitFor(() => expect(document.activeElement).toBe(tree));
  expect(view.queryByRole("dialog")).toBeNull();
  expect(onMutation).not.toHaveBeenCalled();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  fireEvent.keyDown(tree, { key: "Enter", isComposing: true });
  expect(view.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(tree, { key: "Enter" });
  expect(view.getByRole("dialog")).toBeDefined();
  expect(onSelect).not.toHaveBeenCalled();
});

it("guards IME and duplicate submit, clears errors after editing, and keeps retry focus", async () => {
  let resolve!: (error: string | null) => void;
  const onMutation = vi.fn(
    () =>
      new Promise<string | null>((done) => {
        resolve = done;
      }),
  );
  const view = render(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="workspace"
      selected={null}
      onSelect={vi.fn()}
      onMutation={onMutation}
    />,
  );
  fireEvent.contextMenu(view.getByRole("treeitem", { name: "長い日本語の文書 HTML" }));
  fireEvent.click(view.getByRole("menuitem", { name: "名前を変更" }));
  const input = view.getByRole("textbox") as HTMLInputElement;
  const form = input.closest("form")!;
  fireEvent.compositionStart(input);
  fireEvent.submit(form);
  expect(onMutation).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(false);
  expect(onMutation).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "新しい名前" } });
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(onMutation).toHaveBeenCalledTimes(1);
  expect(onMutation).toHaveBeenCalledWith({
    kind: "renameHtml",
    source: "長い日本語の文書.HtM",
    name: "新しい名前",
  });
  expect(input.readOnly).toBe(true);
  fireEvent(view.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(view.getByRole("dialog")).toBeDefined();
  await act(async () => {
    resolve("同じ名前の項目があります");
  });
  expect(view.getByRole("alert").textContent).toContain("同じ名前");
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "別の名前" } });
  expect(view.queryByRole("alert")).toBeNull();
});

it("offers recovery only for the context HTML, respects busy state, and restores focus", () => {
  const onRecoverState = vi.fn();
  const onSelect = vi.fn();
  const props = { nodes, workspaceId: "workspace", selected: null, onSelect, onRecoverState };
  const view = render(<KnowledgeTree {...props} />);
  const tree = view.getByRole("tree");
  fireEvent.contextMenu(view.getByRole("treeitem", { name: /folder.html/ }));
  expect(view.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(view.getByRole("treeitem", { name: "長い日本語の文書 HTML" }));
  const recovery = view.getByRole("menuitem", { name: "以前の入力状態を引き継ぐ" });
  view.rerender(<KnowledgeTree {...props} actionBusy />);
  expect((recovery as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(recovery);
  expect(onRecoverState).not.toHaveBeenCalled();
  view.rerender(<KnowledgeTree {...props} />);
  fireEvent.click(recovery);
  expect(onRecoverState).toHaveBeenCalledWith("長い日本語の文書.HtM");
  expect(onSelect).not.toHaveBeenCalled();
  expect(view.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(tree);
  fireEvent.keyDown(tree, { key: "F10", shiftKey: true });
  expect(view.getByRole("menuitem", { name: "以前の入力状態を引き継ぐ" })).toBeDefined();
});

it("removes HTML creation from icons, menus and shortcuts while keeping folder creation and AI handoff", async () => {
  setLanguage("ja");
  const onMutation = vi.fn(async () => null);
  const onAiHandoff = vi.fn();
  const view = render(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="workspace"
      selected={null}
      onSelect={vi.fn()}
      onMutation={onMutation}
      onAiHandoff={onAiHandoff}
    />,
  );
  expect(view.queryByRole("button", { name: "HTMLを作成" })).toBeNull();
  const tree = view.getByRole("tree");
  tree.focus();
  fireEvent.keyDown(tree, { key: "n", ctrlKey: true });
  fireEvent.keyDown(tree, { key: "n", metaKey: true });
  expect(view.queryByRole("dialog")).toBeNull();
  expect(onMutation).not.toHaveBeenCalled();
  for (const row of view.getAllByRole("treeitem")) {
    fireEvent.contextMenu(row);
    expect(view.queryByRole("menuitem", { name: "HTMLを作成" })).toBeNull();
    expect(view.getByRole("menuitem", { name: "フォルダーを作成" })).toBeTruthy();
    fireEvent.click(view.getByRole("menuitem", { name: "AIに渡す" }));
  }
  expect(onAiHandoff).toHaveBeenCalledTimes(2);
  tree.focus();
  fireEvent.keyDown(tree, { key: "n", ctrlKey: true, shiftKey: true });
  expect(view.getByRole("dialog")).toBeTruthy();
  fireEvent.change(view.getByRole("textbox", { name: "名前" }), { target: { value: "child" } });
  fireEvent.click(view.getByRole("button", { name: "作成する" }));
  await waitFor(() =>
    expect(onMutation).toHaveBeenCalledWith({ kind: "createFolder", parent: "", name: "child" }),
  );
});

it("names folder icon controls and explains unavailable creation without dispatching mutations", () => {
  const onMutation = vi.fn(async () => null);
  const props = { nodes, selected: null, onSelect: vi.fn(), onMutation };
  const view = render(<KnowledgeTree {...props} workspaceId="workspace" />);
  const names = ["フォルダーを作成", "ルートにフォルダーを作成"];
  for (const name of names) {
    const button = view.getByRole("button", { name });
    expect(button.textContent).toBe("");
    expect(button.title).toContain(name);
    expect(button.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    expect(button.hasAttribute("disabled")).toBe(false);
  }
  for (const [workspaceId, actionBusy, reason] of [
    ["workspace", true, "操作中のため作成できません"],
    [null, false, "作業フォルダーを選択してください"],
  ] as const) {
    view.rerender(<KnowledgeTree {...props} workspaceId={workspaceId} actionBusy={actionBusy} />);
    for (const name of names) {
      const button = view.getByRole("button", { name });
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(button.title).toContain(reason);
      expect(button.getAttribute("aria-description")).toBe(reason);
      fireEvent.click(button);
    }
    expect(view.queryByRole("dialog")).toBeNull();
  }
  expect(onMutation).not.toHaveBeenCalled();
});

it("creates explicitly at root while a child is focused and cancels empty-root creation", async () => {
  const onMutation = vi.fn(async () => null);
  const view = render(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="workspace"
      rootPath="/fixture/knowledge"
      selected={null}
      onSelect={vi.fn()}
      onMutation={onMutation}
    />,
  );
  fireEvent.click(view.getByRole("treeitem", { name: /folder.html/ }));
  fireEvent.click(view.getByRole("button", { name: "ルートにフォルダーを作成" }));
  expect((view.getByRole("combobox", { name: "作成先" }) as HTMLInputElement).value).toBe(
    "knowledge（ルート）",
  );
  fireEvent.change(view.getByRole("textbox"), { target: { value: "日本語 folder" } });
  fireEvent.click(view.getByRole("button", { name: "作成する" }));
  await waitFor(() =>
    expect(onMutation).toHaveBeenCalledWith({
      kind: "createFolder",
      parent: "",
      name: "日本語 folder",
    }),
  );
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  view.rerender(
    <KnowledgeTree
      nodes={[]}
      workspaceId="workspace"
      selected={null}
      onSelect={vi.fn()}
      onMutation={onMutation}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "ルートにフォルダーを作成" }));
  fireEvent.click(view.getByRole("button", { name: "キャンセル" }));
  expect(onMutation).toHaveBeenCalledTimes(1);
});

it("uses the current root name in creation tooltips and accessible descriptions", async () => {
  const props = {
    nodes,
    workspaceId: "workspace",
    selected: null,
    onSelect: vi.fn(),
    onMutation: vi.fn(async () => null),
  };
  const view = render(<KnowledgeTree {...props} rootPath="C:\\資料 root\\" />);
  const root = view.getByRole("button", { name: "ルートにフォルダーを作成" });
  expect(root.title).toContain("資料 root（ルート）");
  expect(root.getAttribute("aria-description")).toContain("資料 root（ルート）");
  view.rerender(<KnowledgeTree {...props} rootPath="/Volumes/New root/" />);
  await act(() => setLanguage("en"));
  expect(root.title).toContain("New root (root)");
  expect(root.title).not.toContain("資料 root");
  expect(
    view.getByRole("button", { name: "Create folder" }).getAttribute("aria-description"),
  ).toContain("New root (root)");
});

it("dismisses a filtered destination dialog when the root changes without dispatching a mutation", () => {
  const onMutation = vi.fn(async () => null);
  const view = render(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="one"
      selected={null}
      onSelect={vi.fn()}
      onMutation={onMutation}
    />,
  );
  fireEvent.click(view.getByRole("treeitem", { name: /folder.html/ }));
  fireEvent.click(view.getByRole("button", { name: "フォルダーを作成" }));
  const picker = view.getByRole("combobox", { name: "作成先" });
  expect((picker as HTMLInputElement).value).toBe("folder.html");
  fireEvent.click(picker);
  fireEvent.change(picker, { target: { value: "folder" } });
  view.rerender(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="two"
      selected={null}
      onSelect={vi.fn()}
      onMutation={onMutation}
    />,
  );
  expect(view.queryByRole("dialog")).toBeNull();
  expect(view.queryByRole("listbox")).toBeNull();
  expect(onMutation).not.toHaveBeenCalled();
});

it("folder menu copies/opens the context folder itself and omits HTML actions", () => {
  const onFileAction = vi.fn();
  const view = render(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="workspace"
      selected={null}
      onSelect={vi.fn()}
      onFileAction={onFileAction}
    />,
  );
  const folder = view.getByRole("treeitem", { name: /folder.html/ });
  fireEvent.contextMenu(folder);
  expect(view.queryByRole("menuitem", { name: "既定ブラウザーで表示" })).toBeNull();
  fireEvent.click(view.getByRole("menuitem", { name: "フルパスをコピー" }));
  expect(onFileAction).toHaveBeenLastCalledWith("folder.html", "copyPath");
  fireEvent.keyDown(view.getByRole("tree"), { key: "F10", shiftKey: true });
  fireEvent.click(view.getByRole("menuitem", { name: "フォルダーを開く" }));
  expect(onFileAction).toHaveBeenLastCalledWith("folder.html", "openFolder");
});

it("trash confirms only the context item, explains recursion, defaults to cancel and retries errors", async () => {
  const onTrash = vi
    .fn()
    .mockResolvedValueOnce("ごみ箱を利用できません")
    .mockResolvedValueOnce(null);
  const view = render(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="workspace"
      revision={7}
      selected="長い日本語の文書.HtM"
      onSelect={vi.fn()}
      onTrash={onTrash}
    />,
  );
  fireEvent.contextMenu(view.getByRole("treeitem", { name: /folder.html/ }));
  fireEvent.click(view.getByRole("menuitem", { name: "ごみ箱に移動" }));
  expect(document.activeElement).toBe(view.getByRole("button", { name: "キャンセル" }));
  expect(view.getByRole("dialog").textContent).toContain("配下すべて");
  expect(view.getByRole("dialog").textContent).toContain("未保存");
  expect(onTrash).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "ごみ箱に移動する" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain("ごみ箱を利用できません"),
  );
  fireEvent.click(view.getByRole("button", { name: "ごみ箱に移動する" }));
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  expect(onTrash).toHaveBeenNthCalledWith(1, "folder.html", 7);
  expect(onTrash).toHaveBeenCalledTimes(2);
});

it("trash keys are scoped to focused tree, use platform modifiers, and ignore repeats and IME", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  const onTrash = vi.fn(async () => null);
  const props = { nodes, workspaceId: "workspace", selected: null, onSelect: vi.fn(), onTrash };
  const view = render(<KnowledgeTree {...props} />);
  const tree = view.getByRole("tree");
  tree.focus();
  fireEvent.keyDown(tree, { key: "Delete" });
  expect(view.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(tree, { key: "ArrowDown" });
  for (const extras of [
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
  ]) {
    fireEvent.keyDown(tree, { key: "Delete", ...extras });
    expect(view.queryByRole("dialog")).toBeNull();
  }
  fireEvent.keyDown(view.getByRole("treeitem", { name: /folder.html/ }), { key: "Backspace" });
  expect(view.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(tree, { key: "Backspace" });
  expect(view.getByRole("dialog")).toBeDefined();
  fireEvent.click(view.getByRole("button", { name: "キャンセル" }));
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  tree.focus();
  for (const key of ["Delete", "Backspace"]) {
    fireEvent.keyDown(tree, { key });
    expect(view.queryByRole("dialog")).toBeNull();
  }
  fireEvent.keyDown(tree, { key: "Backspace", metaKey: true });
  expect(view.getByRole("dialog")).toBeDefined();
  expect(onTrash).not.toHaveBeenCalled();
});

it("stale trash confirmation is disabled and root change cancels it", () => {
  const onTrash = vi.fn(async () => null);
  const props = {
    nodes,
    workspaceId: "workspace",
    revision: 5,
    selected: null,
    onSelect: vi.fn(),
    onTrash,
  };
  const view = render(<KnowledgeTree {...props} />);
  fireEvent.contextMenu(view.getByRole("treeitem", { name: /folder.html/ }));
  fireEvent.click(view.getByRole("menuitem", { name: "ごみ箱に移動" }));
  view.rerender(<KnowledgeTree {...props} revision={6} />);
  expect(
    (view.getByRole("button", { name: "ごみ箱に移動する" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.submit(view.getByRole("dialog").querySelector("form")!);
  expect(onTrash).not.toHaveBeenCalled();
  view.rerender(<KnowledgeTree {...props} workspaceId="other" />);
  expect(view.queryByRole("dialog")).toBeNull();
});

it("inline favorites and AI actions preserve the row state, keyboard scope, and exact target", () => {
  const onSelect = vi.fn();
  const onFavorite = vi.fn();
  const onAiHandoff = vi.fn();
  const onMutation = vi.fn(async () => null);
  const props = {
    nodes,
    workspaceId: "workspace",
    selected: null,
    onSelect,
    onFavorite,
    onAiHandoff,
    onMutation,
  };
  const view = render(<KnowledgeTree {...props} favoritePaths={["長い日本語の文書.HtM"]} />);
  const folder = view.getByRole("treeitem", { name: "folder.html" });
  const file = view.getByRole("treeitem", { name: "長い日本語の文書 HTML" });
  const folderFavorite = folder.querySelector<HTMLButtonElement>(
    '[aria-label="お気に入りに追加"]',
  )!;
  const fileFavorite = file.querySelector<HTMLButtonElement>('[aria-label="お気に入りから解除"]')!;
  const folderAi = folder.querySelector<HTMLButtonElement>('[aria-label="AIに渡す"]')!;
  expect(folderFavorite.tabIndex).toBe(0);
  expect(fileFavorite.tabIndex).toBe(-1);
  expect(fileFavorite.getAttribute("aria-pressed")).toBe("true");
  expect(fileFavorite.title).toBe("お気に入りから解除");
  expect(fireEvent.pointerDown(folderFavorite)).toBe(false);
  fireEvent.click(folderFavorite);
  expect(onFavorite).toHaveBeenCalledWith("folder.html", true);
  expect(folder.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(fileFavorite);
  expect(onFavorite).toHaveBeenCalledWith("長い日本語の文書.HtM", false);
  fireEvent.click(folderAi);
  expect(onAiHandoff).toHaveBeenCalledWith("folder.html", folderAi);
  fireEvent.keyDown(folderAi, { key: "Enter" });
  fireEvent.keyDown(folderAi, { key: " " });
  fireEvent.keyDown(folderAi, { key: "ArrowRight" });
  fireEvent.keyDown(folderAi, { key: "n", ctrlKey: true });
  expect(folder.getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByRole("dialog")).toBeNull();
  expect(fireEvent.dragStart(folderAi)).toBe(false);
  expect(folder.className).not.toContain("dragged");
  expect(onMutation).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
  view.rerender(<KnowledgeTree {...props} actionBusy />);
  for (const button of view.getAllByRole("button", { name: /お気に入り|AIに渡す/ })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(onFavorite).toHaveBeenCalledTimes(2);
  expect(onAiHandoff).toHaveBeenCalledTimes(1);
});

it("folder focus requests expand ancestors without selecting HTML or accepting a missing target", () => {
  const nestedNodes: TreeNode[] = [
    {
      name: "parent",
      relativePath: "parent",
      kind: "folder",
      children: [
        {
          name: "child",
          relativePath: "parent/child",
          kind: "folder",
          children: [
            { name: "app.html", relativePath: "parent/child/app.html", kind: "html", children: [] },
          ],
        },
      ],
    },
  ];
  const onSelect = vi.fn();
  const props = {
    nodes: nestedNodes,
    workspaceId: "workspace",
    viewId: "view",
    revision: 7,
    selected: "other.html",
    onSelect,
  };
  const view = render(
    <KnowledgeTree
      {...props}
      focusRequest={{
        path: "parent/child",
        id: 1,
        workspaceId: "workspace",
        viewId: "view",
        revision: 7,
      }}
    />,
  );
  const tree = view.getByRole("tree");
  expect(tree.getAttribute("aria-activedescendant")).toBe(
    "tree-" + encodeURIComponent("parent/child"),
  );
  expect(view.getByRole("treeitem", { name: "child" }).getAttribute("aria-expanded")).toBe("true");
  expect(view.getByRole("treeitem", { name: "app HTML" })).toBeDefined();
  expect(document.activeElement).toBe(tree);
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.keyDown(tree, { key: "ArrowLeft" });
  expect(view.queryByRole("treeitem", { name: "app HTML" })).toBeNull();
  view.rerender(
    <KnowledgeTree
      {...props}
      focusRequest={{
        path: "parent/child",
        id: 1,
        workspaceId: "workspace",
        viewId: "view",
        revision: 7,
      }}
    />,
  );
  expect(view.queryByRole("treeitem", { name: "app HTML" })).toBeNull();
  view.rerender(
    <KnowledgeTree
      {...props}
      focusRequest={{
        path: "parent/child",
        id: 2,
        workspaceId: "workspace",
        viewId: "view",
        revision: 7,
      }}
    />,
  );
  expect(view.getByRole("treeitem", { name: "app HTML" })).toBeDefined();
  view.rerender(
    <KnowledgeTree
      {...props}
      focusRequest={{
        path: "parent/child/app.html",
        id: 3,
        workspaceId: "workspace",
        viewId: "view",
        revision: 7,
      }}
    />,
  );
  expect(tree.getAttribute("aria-activedescendant")).toBe(
    "tree-" + encodeURIComponent("parent/child"),
  );
  view.rerender(
    <KnowledgeTree
      {...props}
      focusRequest={{
        path: "missing",
        id: 4,
        workspaceId: "workspace",
        viewId: "view",
        revision: 7,
      }}
    />,
  );
  expect(tree.getAttribute("aria-activedescendant")).toBe(
    "tree-" + encodeURIComponent("parent/child"),
  );
  fireEvent.keyDown(tree, { key: "ArrowLeft" });
  view.rerender(
    <KnowledgeTree
      {...props}
      focusRequest={{
        path: "parent/child",
        id: 6,
        workspaceId: "workspace",
        viewId: "stale-view",
        revision: 7,
      }}
    />,
  );
  expect(view.queryByRole("treeitem", { name: "app HTML" })).toBeNull();
  view.rerender(
    <KnowledgeTree
      {...props}
      focusRequest={{
        path: "parent/child",
        id: 7,
        workspaceId: "workspace",
        viewId: "view",
        revision: 6,
      }}
    />,
  );
  expect(view.queryByRole("treeitem", { name: "app HTML" })).toBeNull();
  view.rerender(
    <KnowledgeTree
      {...props}
      focusRequest={{
        path: "parent/child",
        id: 8,
        workspaceId: "workspace",
        viewId: "view",
        revision: 7,
      }}
    />,
  );
  expect(view.getByRole("treeitem", { name: "app HTML" })).toBeDefined();
  view.rerender(
    <KnowledgeTree
      {...props}
      workspaceId="new-workspace"
      focusRequest={{
        path: "parent/child",
        id: 5,
        workspaceId: "workspace",
        viewId: "view",
        revision: 7,
      }}
    />,
  );
  expect(tree.getAttribute("aria-activedescendant")).toBeNull();
  expect(view.queryByRole("treeitem", { name: "child" })).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
});

it("does not move focus when the tree revision changes before the requested virtual row is exposed", () => {
  const onSelect = vi.fn();
  function RefreshingView() {
    const [revision, setRevision] = useState(7);
    useLayoutEffect(() => setRevision(8), []);
    return (
      <>
        <input autoFocus aria-label="current input" />
        <KnowledgeTree
          nodes={nodes}
          workspaceId="workspace"
          viewId="view"
          revision={revision}
          selected={null}
          onSelect={onSelect}
          focusRequest={{
            path: "folder.html",
            id: 1,
            workspaceId: "workspace",
            viewId: "view",
            revision: 7,
          }}
        />
      </>
    );
  }
  const view = render(<RefreshingView />);
  expect(document.activeElement).toBe(view.getByRole("textbox", { name: "current input" }));
  expect(view.getByRole("tree").getAttribute("aria-activedescendant")).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
});
