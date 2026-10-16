import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { AppState, DocumentTab } from "../../lib/types";
import type { KnowledgeController } from "../../lib/controller";
import { TabStrip } from "./TabStrip";
import { DocumentDeck } from "./DocumentDeck";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const tab = (id: string, column: 0 | 1 = 0): DocumentTab => ({
  id,
  path: `Examples/${id}.html`,
  column,
  url: `http://127.0.0.1/s/${id}/index.html`,
  loading: false,
  closing: false,
  dirty: false,
  missing: false,
  error: null,
});
const state = (tabs = [tab("a"), tab("b")]): AppState => ({
  snapshot: {
    workspaceId: "test",
    rootPath: "/knowledge",
    revision: 1,
    nodes: [],
    watchError: null,
    viewId: "test-view",
  },
  tabs,
  columns: ["a", null],
  activeColumn: 0,
  split: false,
  closed: [],
  selectedPath: "Examples/a.html",
  documentUrl: tabs[0]?.url ?? null,
  loading: false,
  error: null,
  actionBusy: false,
  actionMessage: null,
});
const controller = () => {
  const actions = {
    activate: vi.fn(),
    setActiveColumn: vi.fn(),
    closeTab: vi.fn(),
    closeTabsToRight: vi.fn(),
    reorderTab: vi.fn(),
    moveTab: vi.fn(),
    openInColumn: vi.fn(),
    reload: vi.fn(),
    reopen: vi.fn(),
    zoomTab: vi.fn(),
    focusTab: vi.fn(),
  };
  return { actions, api: actions as unknown as KnowledgeController };
};
const transfer = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });

it("shortens only visible terminal HTML extensions and preserves tab paths and accessible names", () => {
  const { actions, api } = controller();
  const names: Array<[string, string]> = [
    ["日本語.名前.HtMl", "日本語.名前"],
    ["guide.HTM", "guide"],
    ["nested.html.part.HTML", "nested.html.part"],
    [".html", ".html"],
    ["document.xhtml", "document.xhtml"],
    ["document.html.txt", "document.html.txt"],
  ];
  const tabs = names.map(([name], index) => ({ ...tab(String(index)), path: "Folder/" + name }));
  const current = state(tabs);
  const before = JSON.stringify(current);
  const view = render(<TabStrip state={current} controller={api} onEmpty={vi.fn()} />);
  for (const [index, [name, label]] of names.entries()) {
    const button = view.getByRole("tab", { name });
    expect(button.querySelector(".tab-title")?.textContent).toBe(label);
    expect(button.getAttribute("title")).toBe("Folder/" + name);
    expect(button.getAttribute("aria-description")).toBe("Folder/" + name);
    fireEvent.click(button);
    expect(actions.activate).toHaveBeenLastCalledWith(String(index), 0);
  }
  expect(JSON.stringify(current)).toBe(before);
});

it("distinguishes equal labels by full path and keeps lazy split tabs and status accessible", () => {
  const { actions, api } = controller();
  const left = { ...tab("a"), path: "Left/同じ.html", zoom: 125, dirty: true };
  const right = { ...tab("b", 1), path: "Right/同じ.html", deferred: true, url: null };
  const current = { ...state([left, right]), split: true, columns: ["a", "b"] as [string, string] };
  const view = render(<TabStrip state={current} controller={api} onEmpty={vi.fn()} />);
  const buttons = view.getAllByRole("tab");
  expect(buttons.map((button) => button.querySelector(".tab-title")?.textContent)).toEqual([
    "同じ",
    "同じ",
  ]);
  expect(buttons[0]!.getAttribute("aria-label")).toBe("同じ.html 125% 更新あり");
  expect(buttons[1]!.getAttribute("title")).toBe("Right/同じ.html（選択時に読み込み）");
  expect(buttons.map((button) => button.getAttribute("aria-description"))).toEqual([
    left.path,
    right.path,
  ]);
  expect(buttons[1]!.getAttribute("aria-controls")).toBe("panel-b");
  fireEvent.click(buttons[1]!);
  expect(actions.activate).toHaveBeenCalledExactlyOnceWith("b", 1);
  expect(actions.openInColumn).not.toHaveBeenCalled();
  expect(actions.reload).not.toHaveBeenCalled();
  expect(current.tabs[1]).toBe(right);
  expect(right).toMatchObject({ path: "Right/同じ.html", deferred: true, url: null });
});

it("admits quick-open only from a focused live frame with an exact scoped payload", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { actions, api } = controller();
  const open = vi.fn();
  const a = { ...tab("a"), url: `http://127.0.0.1/s/${"a".repeat(64)}/index.html` };
  const view = render(<DocumentDeck state={state([a])} controller={api} onQuickOpen={open} />);
  const frame = view.container.querySelector("iframe")!;
  frame.focus();
  const data = { type: "my-knowledge-quick-open-v1", token: "a".repeat(64) };
  const send = (payload: unknown = data, source = frame.contentWindow, origin = "null") =>
    fireEvent(window, new MessageEvent("message", { source, data: payload, origin }));
  send({ ...data, token: "b".repeat(64) });
  send({ ...data, command: "open" });
  send(data, window);
  send(data, frame.contentWindow, "http://foreign");
  const modal = document.createElement("dialog");
  modal.open = true;
  document.body.append(modal);
  send();
  modal.remove();
  expect(open).not.toHaveBeenCalled();
  send();
  expect(open).toHaveBeenCalledOnce();
  expect(actions.focusTab).toHaveBeenCalledExactlyOnceWith("a");
  view.rerender(
    <DocumentDeck
      state={{ ...state([a]), tabs: [{ ...a, closing: true }] }}
      controller={api}
      onQuickOpen={open}
    />,
  );
  frame.focus();
  send();
  expect(open).toHaveBeenCalledOnce();
});

it("admits sidebar toggle only from an exact focused current opaque document", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { actions, api } = controller();
  const toggle = vi.fn();
  const a = { ...tab("a"), url: `http://127.0.0.1/s/${"a".repeat(64)}/index.html` };
  const current = state([a]);
  const view = render(<DocumentDeck state={current} controller={api} onToggleSidebar={toggle} />);
  const frame = view.container.querySelector("iframe")!;
  const data = { type: "my-knowledge-sidebar-toggle-v1", token: "a".repeat(64) };
  const send = (payload: unknown = data, source = frame.contentWindow, origin = "null") =>
    fireEvent(window, new MessageEvent("message", { source, data: payload, origin }));
  frame.focus();
  send({ ...data, token: "b".repeat(64) });
  send({ ...data, command: "toggle" });
  send(data, window);
  send(data, frame.contentWindow, "http://foreign");
  const modal = document.createElement("dialog");
  modal.open = true;
  document.body.append(modal);
  send();
  modal.remove();
  expect(toggle).not.toHaveBeenCalled();
  send();
  expect(toggle).toHaveBeenCalledOnce();
  expect(actions.focusTab).toHaveBeenCalledExactlyOnceWith("a");
  for (const patch of [
    { tabs: [{ ...a, closing: true }] },
    { tabs: [{ ...a, kind: "help" as const }] },
    { columns: [null, null] as [null, null] },
  ]) {
    view.rerender(
      <DocumentDeck state={{ ...current, ...patch }} controller={api} onToggleSidebar={toggle} />,
    );
    view.container.querySelector("iframe")?.focus();
    send();
  }
  expect(toggle).toHaveBeenCalledOnce();
});

it("admits settings only from an exact focused current frame and returns that DOM origin", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { actions, api } = controller();
  const open = vi.fn();
  const a = { ...tab("a"), url: `http://127.0.0.1/s/${"a".repeat(64)}/index.html` };
  const current = state([a]);
  const view = render(<DocumentDeck state={current} controller={api} onOpenSettings={open} />);
  let frame = view.container.querySelector("iframe")!;
  frame.focus();
  const data = { type: "my-knowledge-settings-open-v1", token: "a".repeat(64) };
  const send = (payload: unknown = data, source = frame.contentWindow, origin = "null") =>
    fireEvent(window, new MessageEvent("message", { data: payload, source, origin }));
  send({ ...data, token: "b".repeat(64) });
  send({ ...data, path: "other" });
  send(data, window);
  send(data, frame.contentWindow, "https://foreign");
  const modal = document.createElement("dialog");
  modal.open = true;
  document.body.append(modal);
  send();
  modal.remove();
  expect(open).not.toHaveBeenCalled();
  send();
  expect(open).toHaveBeenCalledExactlyOnceWith(frame);
  expect(actions.focusTab).toHaveBeenCalledExactlyOnceWith("a");
  for (const patch of [
    { loading: true },
    { actionBusy: true },
    { tabs: [{ ...a, loading: true }] },
    { tabs: [{ ...a, deferred: true }] },
    { tabs: [{ ...a, closing: true }] },
    { tabs: [{ ...a, kind: "help" as const }] },
    { columns: [null, null] as [null, null] },
  ]) {
    view.rerender(
      <DocumentDeck state={{ ...current, ...patch }} controller={api} onOpenSettings={open} />,
    );
    frame.focus();
    send();
  }
  view.rerender(<DocumentDeck state={current} controller={api} onOpenSettings={open} />);
  frame = view.container.querySelector("iframe")!;
  frame.focus();
  frame.closest<HTMLElement>(".document-pane")!.hidden = true;
  send();
  expect(open).toHaveBeenCalledOnce();
});

it("admits AI confirmation only from the exact focused live HTML and rejects stale or busy proposals", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { actions, api } = controller();
  const open = vi.fn();
  const a = { ...tab("a"), url: `http://127.0.0.1/s/${"a".repeat(64)}/index.html` };
  const current = state([a]);
  const view = render(<DocumentDeck state={current} controller={api} onAiHandoff={open} />);
  const frame = view.container.querySelector("iframe")!;
  frame.focus();
  const data = { type: "my-knowledge-ai-handoff-v1", token: "a".repeat(64) };
  const send = (payload: unknown = data, source = frame.contentWindow, origin = "null") =>
    fireEvent(window, new MessageEvent("message", { source, data: payload, origin }));
  send({ ...data, token: "b".repeat(64) });
  send({ ...data, relativePath: "other.html" });
  send(data, window);
  send(data, frame.contentWindow, "http://foreign");
  const modal = document.createElement("dialog");
  modal.open = true;
  document.body.append(modal);
  send();
  modal.remove();
  expect(open).not.toHaveBeenCalled();
  send();
  expect(open).toHaveBeenCalledExactlyOnceWith("a");
  expect(actions.focusTab).toHaveBeenCalledExactlyOnceWith("a");
  for (const tabs of [
    [{ ...a, closing: true }],
    [{ ...a, loading: true }],
    [{ ...a, deferred: true }],
    [{ ...a, kind: "help" as const }],
  ]) {
    view.rerender(
      <DocumentDeck state={{ ...current, tabs }} controller={api} onAiHandoff={open} />,
    );
    view.container.querySelector("iframe")?.focus();
    send();
  }
  view.rerender(
    <DocumentDeck state={{ ...current, actionBusy: true }} controller={api} onAiHandoff={open} />,
  );
  view.container.querySelector("iframe")?.focus();
  send();
  expect(open).toHaveBeenCalledOnce();
});

it("zooms only the focused visible frame and rejects stale, foreign and modal proposals", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { actions, api } = controller();
  const a = { ...tab("a"), url: `http://127.0.0.1/s/${"a".repeat(64)}/index.html` };
  const b = { ...tab("b", 1), url: `http://127.0.0.1/s/${"b".repeat(64)}/index.html` };
  const current = { ...state([a, b]), split: true, columns: ["a", "b"] as [string, string] };
  const view = render(<DocumentDeck state={current} controller={api} />);
  const frames = Array.from(view.container.querySelectorAll("iframe"));
  frames[1]!.focus();
  const data = { type: "my-knowledge-document-zoom-v1", token: "b".repeat(64), change: "in" };
  const send = (source: Window | null, payload: unknown = data, origin = "null") =>
    fireEvent(window, new MessageEvent("message", { source, data: payload, origin }));
  send(frames[0]!.contentWindow);
  send(frames[1]!.contentWindow, { ...data, token: "a".repeat(64) });
  send(frames[1]!.contentWindow, { ...data, change: "close" });
  send(frames[1]!.contentWindow, { ...data, direction: 0 });
  send(frames[1]!.contentWindow, data, "http://foreign.example");
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.append(dialog);
  send(frames[1]!.contentWindow);
  dialog.remove();
  expect(actions.zoomTab).not.toHaveBeenCalled();
  send(frames[1]!.contentWindow);
  expect(actions.zoomTab).toHaveBeenCalledExactlyOnceWith("b", "in");
  send(frames[1]!.contentWindow);
  expect(actions.zoomTab).toHaveBeenCalledTimes(2);
  send(frames[1]!.contentWindow, { ...data, change: "reset" });
  expect(actions.zoomTab).toHaveBeenLastCalledWith("b", "reset");
  view.rerender(
    <DocumentDeck state={{ ...current, split: false, columns: ["a", null] }} controller={api} />,
  );
  frames[1]!.focus();
  send(frames[1]!.contentWindow, { ...data, change: "reset" });
  expect(actions.zoomTab).toHaveBeenCalledTimes(3);
  frames[0]!.focus();
  send(frames[0]!.contentWindow, { ...data, token: "a".repeat(64) });
  expect(actions.zoomTab).toHaveBeenLastCalledWith("a", "in");
  expect(actions.moveTab).not.toHaveBeenCalled();
});
it("bounds pinch proposals and keeps their token, source, focus and visible-view gate", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { actions, api } = controller();
  const a = { ...tab("a"), url: `http://127.0.0.1/s/${"a".repeat(64)}/index.html` };
  const b = { ...tab("b", 1), url: `http://127.0.0.1/s/${"b".repeat(64)}/index.html` };
  const current = { ...state([a, b]), split: true, columns: ["a", "b"] as [string, string] };
  const view = render(<DocumentDeck state={current} controller={api} />);
  const frames = Array.from(view.container.querySelectorAll("iframe"));
  frames[1]!.focus();
  const data = {
    type: "my-knowledge-document-pinch-v1",
    token: "b".repeat(64),
    factor: 1.0137,
    x: 0.3,
    y: 0.7,
  };
  const send = (payload: unknown = data, source = frames[1]!.contentWindow, origin = "null") =>
    fireEvent(window, new MessageEvent("message", { source, data: payload, origin }));
  for (const factor of [NaN, Infinity, -1, 0, 11, "1.1"]) send({ ...data, factor });
  for (const anchor of [{ x: -1 }, { y: 2 }, { x: NaN }, { y: Infinity }])
    send({ ...data, ...anchor });
  send({ ...data, extra: true });
  send({ ...data, token: "a".repeat(64) });
  send(data, frames[0]!.contentWindow);
  send(data, frames[1]!.contentWindow, "http://foreign.example");
  expect(actions.zoomTab).not.toHaveBeenCalled();
  send();
  expect(actions.zoomTab).toHaveBeenCalledExactlyOnceWith("b", { factor: 1.0137, x: 0.3, y: 0.7 });
  view.rerender(
    <DocumentDeck state={{ ...current, split: false, columns: ["a", null] }} controller={api} />,
  );
  frames[1]!.focus();
  send();
  expect(actions.zoomTab).toHaveBeenCalledTimes(1);
});
const drag = (
  target: Element,
  type: string,
  dataTransfer: ReturnType<typeof transfer>,
  clientX = 10,
) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  fireEvent(target, event);
};

it("opens the menu target in a requested column without activating it when the menu opens", () => {
  const { actions, api } = controller();
  const view = render(<TabStrip state={state()} controller={api} onEmpty={vi.fn()} />);
  const inactive = view.getByRole("tab", { name: "b.html" });
  fireEvent.mouseDown(inactive, { button: 2 });
  fireEvent.contextMenu(inactive, { clientX: 20, clientY: 40 });
  expect(actions.activate).not.toHaveBeenCalled();
  expect(actions.setActiveColumn).not.toHaveBeenCalled();
  expect(inactive.getAttribute("aria-selected")).toBe("false");
  fireEvent.click(view.getByRole("menuitem", { name: "右の列で開く" }));
  expect(actions.openInColumn).toHaveBeenCalledWith("Examples/b.html", 1);
  expect(view.queryByRole("menu")).toBeNull();
});

it("closes to the right of the inactive context tab and disables column ends and closing anchors", () => {
  const { actions, api } = controller();
  const current = {
    ...state([tab("a"), tab("x", 1), tab("b"), tab("y", 1), tab("c")]),
    split: true,
    columns: ["c", "y"] as [string, string],
  };
  const view = render(<TabStrip state={current} controller={api} onEmpty={vi.fn()} />);
  const anchor = view.getByRole("tab", { name: "a.html" });
  fireEvent.contextMenu(anchor);
  const item = view.getByRole("menuitem", { name: "右側のタブを全て閉じる" });
  expect(item.hasAttribute("disabled")).toBe(false);
  expect(item.querySelector("kbd")).toBeNull();
  fireEvent.click(item);
  expect(actions.closeTabsToRight).toHaveBeenCalledExactlyOnceWith("a");
  expect(actions.activate).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(anchor);
  fireEvent.contextMenu(view.getByRole("tab", { name: "y.html" }));
  expect(
    view.getByRole("menuitem", { name: "右側のタブを全て閉じる" }).hasAttribute("disabled"),
  ).toBe(true);
  view.rerender(
    <TabStrip
      state={{
        ...current,
        tabs: current.tabs.map((tab) => (tab.id === "a" ? { ...tab, closing: true } : tab)),
      }}
      controller={api}
      onEmpty={vi.fn()}
    />,
  );
  fireEvent.contextMenu(anchor);
  expect(
    view.getByRole("menuitem", { name: "右側のタブを全て閉じる" }).hasAttribute("disabled"),
  ).toBe(true);
});

it("provides explicit reset and closed-tab actions from a keyboard menu", () => {
  const { actions, api } = controller();
  const current = { ...state(), closed: [{ path: "Examples/closed.html", column: 1 as const }] };
  const view = render(<TabStrip state={current} controller={api} onEmpty={vi.fn()} />);
  const active = view.getByRole("tab", { name: "a.html" });
  fireEvent.keyDown(active, { key: "F10", shiftKey: true });
  fireEvent.click(view.getByRole("menuitem", { name: "状態をリセットして再読み込み" }));
  expect(actions.reload).toHaveBeenCalledWith("a", "user-reload");
  fireEvent.keyDown(active, { key: "ContextMenu" });
  fireEvent.click(view.getByRole("menuitem", { name: "閉じたタブを開き直す" }));
  expect(actions.reopen).toHaveBeenCalledOnce();
  expect(view.container.querySelector(".tab-move")).toBeNull();
});

it.each(["Win32", "MacIntel"])(
  "moves the context target with truthful shortcut labels on %s",
  (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const { actions, api } = controller();
    const view = render(<TabStrip state={state()} controller={api} onEmpty={vi.fn()} />);
    const inactive = view.getByRole("tab", { name: "b.html" });
    fireEvent.contextMenu(inactive, { clientX: 20, clientY: 40 });
    expect(actions.activate).not.toHaveBeenCalled();
    const left = view.getByRole("menuitem", { name: "左の列へ移動" });
    const right = view.getByRole("menuitem", { name: "右の列へ移動" });
    const modifier = platform === "MacIntel" ? "⌘" : "Ctrl";
    expect(left.querySelector("kbd")?.textContent).toBe(modifier + "+Shift+←");
    expect(right.querySelector("kbd")?.textContent).toBe(modifier + "+Shift+→");
    expect(left.hasAttribute("disabled")).toBe(true);
    expect(right.hasAttribute("disabled")).toBe(false);
    for (const label of ["左の列で開く", "右の列で開く"])
      expect(view.getByRole("menuitem", { name: label }).querySelector("kbd")).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(right);
    fireEvent.click(right);
    expect(actions.moveTab).toHaveBeenCalledExactlyOnceWith("b", 1, undefined, false);
    expect(actions.openInColumn).not.toHaveBeenCalled();
    expect(actions.reload).not.toHaveBeenCalled();
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(inactive);
  },
);

it("disables column moves for closing tabs and the tab's current right column", () => {
  const { api } = controller();
  const right = { ...state([tab("a"), tab("b", 1)]), split: true };
  const view = render(<TabStrip state={right} controller={api} onEmpty={vi.fn()} />);
  fireEvent.contextMenu(view.getByRole("tab", { name: "b.html" }));
  expect(view.getByRole("menuitem", { name: "右の列へ移動" }).hasAttribute("disabled")).toBe(true);
  expect(view.getByRole("menuitem", { name: "左の列へ移動" }).hasAttribute("disabled")).toBe(false);
  view.rerender(
    <TabStrip
      state={{ ...right, tabs: [tab("a"), { ...tab("b", 1), closing: true }] }}
      controller={api}
      onEmpty={vi.fn()}
    />,
  );
  expect(view.getByRole("menuitem", { name: "左の列へ移動" }).hasAttribute("disabled")).toBe(true);
});

it("moves a focused tab between columns with command-shift arrows and leaves IME untouched", () => {
  const { actions, api } = controller();
  const outer = vi.fn();
  const view = render(
    <div onKeyDown={outer}>
      <TabStrip state={state()} controller={api} onEmpty={vi.fn()} />
    </div>,
  );
  const active = view.getByRole("tab", { name: "a.html" });
  fireEvent.keyDown(active, { key: "ArrowRight", ctrlKey: true, shiftKey: true });
  expect(actions.moveTab).toHaveBeenCalledWith("a", 1, undefined, false);
  expect(actions.reorderTab).not.toHaveBeenCalled();
  expect(outer).not.toHaveBeenCalled();
  fireEvent.keyDown(active, { key: "ArrowLeft", metaKey: true, shiftKey: true, isComposing: true });
  expect(actions.moveTab).toHaveBeenCalledOnce();
  fireEvent.keyDown(view.getByRole("button", { name: "Examples/a.htmlを閉じる" }), {
    key: "ArrowLeft",
    metaKey: true,
    shiftKey: true,
  });
  expect(actions.moveTab).toHaveBeenLastCalledWith("a", 0, undefined, false);
  expect(actions.moveTab).toHaveBeenCalledTimes(2);
  expect(outer).toHaveBeenCalledOnce();
});

it("keeps same-column drag reordering and moves cross-column tabs using the target anchor", () => {
  const { actions, api } = controller();
  const current = {
    ...state([tab("a"), tab("b"), tab("c", 1)]),
    split: true,
    columns: ["a", "c"] as [string, string],
  };
  const view = render(<TabStrip state={current} controller={api} onEmpty={vi.fn()} />);
  const source = view.getByRole("tab", { name: "a.html" }).closest(".tab-item")!;
  const sibling = view.getByRole("tab", { name: "b.html" }).closest(".tab-item")!;
  const destination = view.getByRole("tab", { name: "c.html" }).closest(".tab-item")!;
  const dataTransfer = transfer();
  drag(source, "dragstart", dataTransfer);
  drag(sibling, "dragover", dataTransfer);
  drag(sibling, "drop", dataTransfer);
  expect(actions.reorderTab).toHaveBeenCalledWith("a", "b", true);
  drag(source, "dragstart", dataTransfer);
  drag(destination, "dragover", dataTransfer);
  drag(destination, "drop", dataTransfer);
  expect(actions.moveTab).toHaveBeenCalledWith("a", 1, "c", true);
});

it("accepts an empty column and exposes a labeled right-column target only during a local drag", () => {
  const { actions, api } = controller();
  const view = render(<TabStrip state={state()} controller={api} onEmpty={vi.fn()} />);
  expect(view.container.querySelector(".tab-split-drop-target")).toBeNull();
  const dataTransfer = transfer();
  drag(view.getByRole("tab", { name: "a.html" }).closest(".tab-item")!, "dragstart", dataTransfer);
  const splitTarget = view.getByLabelText("右の列へ移動");
  drag(splitTarget, "dragover", dataTransfer);
  drag(splitTarget, "drop", dataTransfer);
  expect(actions.moveTab).toHaveBeenCalledWith("a", 1, undefined, false);
  expect(view.container.querySelector(".tab-split-drop-target")).toBeNull();
  view.rerender(
    <TabStrip state={{ ...state(), split: true }} controller={api} onEmpty={vi.fn()} />,
  );
  drag(view.getByRole("tab", { name: "b.html" }).closest(".tab-item")!, "dragstart", dataTransfer);
  drag(view.getByLabelText("右の列へ移動"), "drop", dataTransfer);
  expect(actions.moveTab).toHaveBeenLastCalledWith("b", 1, undefined, false);
});

it("retains iframe nodes, their parent, and DOM order when tabs reorder or cross columns", () => {
  const { api } = controller();
  const initial = state();
  const view = render(<DocumentDeck state={initial} controller={api} />);
  const frames = Array.from(view.container.querySelectorAll("iframe"));
  const parents = frames.map((frame) => frame.parentElement);
  view.rerender(
    <DocumentDeck
      state={{ ...initial, tabs: [initial.tabs[1], initial.tabs[0]] }}
      controller={api}
    />,
  );
  expect(Array.from(view.container.querySelectorAll("iframe"))).toEqual(frames);
  view.rerender(
    <DocumentDeck
      state={{
        ...initial,
        tabs: [tab("b"), tab("a", 1)],
        split: true,
        columns: ["b", "a"],
        activeColumn: 1,
      }}
      controller={api}
    />,
  );
  expect(Array.from(view.container.querySelectorAll("iframe"))).toEqual(frames);
  expect(frames.map((frame) => frame.parentElement)).toEqual(parents);
  expect(view.container.querySelector("#panel-a")?.getAttribute("style")).toContain(
    "grid-column: 2",
  );
  view.rerender(
    <DocumentDeck
      state={{ ...initial, tabs: [tab("a")], columns: ["a", null] }}
      controller={api}
    />,
  );
  expect(view.container.querySelector("iframe")).toBe(frames[0]);
  expect(view.container.querySelector(".column-controls")).toBeNull();
});

it("keeps scrollbar input outside window dragging while blank space stays draggable after column collapse", () => {
  const { api } = controller();
  const initial = {
    ...state([tab("a"), tab("b", 1)]),
    split: true,
    columns: ["a", "b"] as [string, string],
  };
  const view = render(<TabStrip state={initial} controller={api} onEmpty={vi.fn()} />);
  for (const group of view.container.querySelectorAll(".tab-group"))
    expect(group.getAttribute("data-tauri-drag-region")).toBe("false");
  for (const blank of view.container.querySelectorAll(".tab-group-drop-target"))
    expect(blank.hasAttribute("data-tauri-drag-region")).toBe(true);
  expect(view.getByRole("tab", { name: "a.html" }).hasAttribute("data-tauri-drag-region")).toBe(
    false,
  );
  const dataTransfer = transfer();
  drag(view.getByRole("tab", { name: "a.html" }).closest(".tab-item")!, "dragstart", dataTransfer);
  for (const group of view.container.querySelectorAll(".tab-group"))
    expect(group.getAttribute("data-tauri-drag-region")).toBe("false");
  for (const blank of view.container.querySelectorAll(".tab-group-drop-target"))
    expect(blank.hasAttribute("data-tauri-drag-region")).toBe(false);
  for (const remaining of [tab("b"), tab("a")]) {
    view.rerender(
      <TabStrip
        state={state([remaining])}
        controller={api}
        onEmpty={vi.fn()}
        activeDragId={null}
      />,
    );
    expect(
      view.container
        .querySelector(".tab-group-drop-target")
        ?.hasAttribute("data-tauri-drag-region"),
    ).toBe(true);
  }
});

it("accepts only the focused live visible frame's scoped column move and rejects stale/foreign messages", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { actions, api } = controller();
  const a = { ...tab("a"), url: `http://127.0.0.1/s/${"a".repeat(64)}/index.html` };
  const b = { ...tab("b", 1), url: `http://127.0.0.1/s/${"b".repeat(64)}/index.html` };
  const current = { ...state([a, b]), split: true, columns: ["a", "b"] as [string, string] };
  const view = render(<DocumentDeck state={current} controller={api} />);
  const frames = Array.from(view.container.querySelectorAll("iframe"));
  frames[1].focus();
  const data = { type: "my-knowledge-move-tab-v1", token: "b".repeat(64), direction: 0 };
  const send = (source: Window | null, payload: unknown = data, origin = "null") =>
    fireEvent(window, new MessageEvent("message", { source, data: payload, origin }));
  send(frames[0].contentWindow);
  send(frames[1].contentWindow, { ...data, token: "a".repeat(64) });
  send(frames[1].contentWindow, { ...data, direction: 2 });
  send(frames[1].contentWindow, { ...data, command: "perform_window_action" });
  send(frames[1].contentWindow, data, "http://evil.example");
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  document.body.append(dialog);
  send(frames[1].contentWindow);
  dialog.remove();
  expect(actions.moveTab).not.toHaveBeenCalled();
  view.rerender(
    <DocumentDeck state={{ ...current, tabs: [a, { ...b, closing: true }] }} controller={api} />,
  );
  frames[1].focus();
  send(frames[1].contentWindow);
  view.rerender(
    <DocumentDeck state={{ ...current, split: false, columns: ["a", null] }} controller={api} />,
  );
  frames[1].focus();
  send(frames[1].contentWindow);
  expect(actions.moveTab).not.toHaveBeenCalled();
  view.rerender(<DocumentDeck state={current} controller={api} />);
  frames[1].focus();
  send(frames[1].contentWindow);
  expect(actions.moveTab).toHaveBeenCalledExactlyOnceWith("b", 0);
  send(frames[1].contentWindow);
  expect(actions.moveTab).toHaveBeenCalledOnce();
  view.rerender(
    <DocumentDeck
      state={{ ...current, tabs: [a], split: false, columns: ["a", null] }}
      controller={api}
    />,
  );
  send(frames[1].contentWindow);
  expect(actions.moveTab).toHaveBeenCalledOnce();
  expect(view.container.querySelector("iframe")).toBe(frames[0]);
});

it.each([
  ["Win32", "ctrlKey", "metaKey"],
  ["MacIntel", "metaKey", "ctrlKey"],
] as const)("zooms only the focused tab's own view with %s keys", (platform, modifier, other) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  const { actions, api } = controller();
  const tabs = [tab("a"), tab("b", 1)].map((tab) => ({ ...tab, path: "Examples/shared.html" }));
  const current = { ...state(tabs), split: true, columns: ["a", "b"] as [string, string] };
  const view = render(<TabStrip state={current} controller={api} onEmpty={vi.fn()} />);
  const focused = view.getAllByRole("tab")[1]!;
  focused.focus();
  for (const fields of [
    { key: "=" },
    { key: "+", shiftKey: true, code: "Semicolon" },
    { key: "+", code: "NumpadAdd" },
    { key: "-" },
    { key: "-", code: "NumpadSubtract" },
    { key: "0" },
  ])
    fireEvent.keyDown(focused, { ...fields, [modifier]: true });
  expect(actions.zoomTab.mock.calls).toEqual([
    ["b", "in"],
    ["b", "in"],
    ["b", "in"],
    ["b", "out"],
    ["b", "out"],
    ["b", "reset"],
  ]);
  for (const fields of [
    { key: "+", [other]: true },
    { key: "+", ctrlKey: true, metaKey: true },
    { key: "0", shiftKey: true, [modifier]: true },
    { key: ";", code: "Semicolon", [modifier]: true },
  ])
    fireEvent.keyDown(focused, fields);
  expect(actions.zoomTab).toHaveBeenCalledTimes(6);
  expect(actions.activate).not.toHaveBeenCalled();
  expect(actions.moveTab).not.toHaveBeenCalled();
  expect(actions.openInColumn).not.toHaveBeenCalled();
});

it("protects editing, IME, cancellation, modals and unavailable tabs from tab zoom keys", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const { actions, api } = controller();
  const view = render(<TabStrip state={state()} controller={api} onEmpty={vi.fn()} />);
  const focused = view.getByRole("tab", { name: "a.html" });
  focused.focus();
  for (const fields of [{ isComposing: true }, { altKey: true }])
    fireEvent.keyDown(focused, { key: "+", metaKey: true, ...fields });
  const canceled = new KeyboardEvent("keydown", {
    key: "+",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  canceled.preventDefault();
  fireEvent(focused, canceled);
  for (const modal of [document.createElement("dialog"), document.createElement("div")]) {
    if (modal.tagName === "DIALOG") modal.setAttribute("open", "");
    else {
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
    }
    document.body.append(modal);
    fireEvent.keyDown(focused, { key: "+", metaKey: true });
    modal.remove();
  }
  const closeButton = view.getByRole("button", { name: "Examples/a.htmlを閉じる" });
  closeButton.focus();
  fireEvent.keyDown(closeButton, { key: "+", metaKey: true });
  const editor = document.createElement("input");
  focused.closest(".tab-item")!.append(editor);
  editor.focus();
  fireEvent.keyDown(editor, { key: "+", metaKey: true });
  editor.remove();
  for (const unavailable of [{ missing: true }, { closing: true }, { url: null }]) {
    view.rerender(
      <TabStrip
        state={state([{ ...tab("a"), ...unavailable }])}
        controller={api}
        onEmpty={vi.fn()}
      />,
    );
    const target = view.getByRole("tab", { name: "a.html" });
    target.focus();
    fireEvent.keyDown(target, { key: "+", metaKey: true });
  }
  expect(actions.zoomTab).not.toHaveBeenCalled();
});

it("resumes Command zoom on the menu target after keyboard dismissal restores tab focus", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const { actions, api } = controller();
  const view = render(<TabStrip state={state()} controller={api} onEmpty={vi.fn()} />);
  const target = view.getByRole("tab", { name: "b.html" });
  target.focus();
  fireEvent.keyDown(target, { key: "F10", shiftKey: true });
  fireEvent.keyDown(document.activeElement!, { key: "+", metaKey: true });
  expect(actions.zoomTab).not.toHaveBeenCalled();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(document.activeElement).toBe(target);
  fireEvent.keyDown(target, { key: "=", metaKey: true });
  expect(actions.zoomTab).toHaveBeenCalledExactlyOnceWith("b", "in");
});

it("zooms the menu target without opening or activating another view, and disables boundary actions", () => {
  const { actions, api } = controller();
  const tabs = [tab("a"), { ...tab("b"), zoom: 200 }];
  const view = render(<TabStrip state={state(tabs)} controller={api} onEmpty={vi.fn()} />);
  const inactive = view.getByRole("tab", { name: /b.html.*200%/ });
  fireEvent.contextMenu(inactive, { clientX: 20, clientY: 40 });
  expect(view.getByText("文書表示: 200%")).toBeTruthy();
  expect(view.getByRole("menuitem", { name: "文書を拡大" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(view.getByRole("menuitem", { name: "文書を縮小" }));
  expect(actions.zoomTab).toHaveBeenCalledWith("b", "out");
  expect(actions.openInColumn).not.toHaveBeenCalled();
  expect(actions.activate).not.toHaveBeenCalled();
});

it("admits Show Files only from an exact focused current opaque document", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const { api, actions } = controller();
  const show = vi.fn();
  const a = { ...tab("a"), url: `http://127.0.0.1/s/${"a".repeat(64)}/index.html` };
  const view = render(<DocumentDeck state={state([a])} controller={api} onShowFiles={show} />);
  const frame = view.container.querySelector("iframe")!;
  frame.focus();
  const data = { type: "my-knowledge-files-show-v1", token: "a".repeat(64) };
  const send = (payload: unknown = data, source = frame.contentWindow, origin = "null") =>
    fireEvent(window, new MessageEvent("message", { data: payload, source, origin }));
  send({ ...data, token: "b".repeat(64) });
  send({ ...data, path: "outside" });
  send(data, window);
  send(data, frame.contentWindow, "https://foreign");
  expect(show).not.toHaveBeenCalled();
  send();
  expect(show).toHaveBeenCalledOnce();
  expect(actions.focusTab).toHaveBeenCalledExactlyOnceWith("a");
  view.rerender(
    <DocumentDeck
      state={{ ...state([a]), tabs: [{ ...a, closing: true }] }}
      controller={api}
      onShowFiles={show}
    />,
  );
  frame.focus();
  send();
  expect(show).toHaveBeenCalledOnce();
});
