import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { KnowledgeTree } from "./KnowledgeTree";
import type { TreeNode } from "../../lib/types";
import { TREE_EXPANSION_KEY } from "./expansion";

const folder = (path: string, children: TreeNode[] = []): TreeNode => ({
  name: path.split("/").at(-1)!,
  relativePath: path,
  kind: "folder",
  children,
});
const nodes = [folder("a", [folder("a/nested")]), folder("b")];
const props = {
  nodes,
  rootPath: "/fixture/one",
  workspaceId: "session-1",
  selected: null,
  onSelect: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("restores expanded folders after remount with a new workspace token", () => {
  let view = render(<KnowledgeTree {...props} />);
  fireEvent.click(view.getByRole("treeitem", { name: "a" }));
  fireEvent.click(view.getByRole("treeitem", { name: "nested" }));
  view.unmount();
  view = render(<KnowledgeTree {...props} workspaceId="session-2" />);
  expect(view.getByRole("treeitem", { name: "a" }).getAttribute("aria-expanded")).toBe("true");
  expect(view.getByRole("treeitem", { name: "nested" }).getAttribute("aria-expanded")).toBe("true");
});

it("isolates registered roots and preserves expansion across display navigation", () => {
  const view = render(<KnowledgeTree {...props} />);
  fireEvent.click(view.getByRole("treeitem", { name: "a" }));
  view.rerender(<KnowledgeTree {...props} rootPath="/fixture/two" workspaceId="other" />);
  expect(view.getByRole("treeitem", { name: "a" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(view.getByRole("treeitem", { name: "b" }));
  view.rerender(<KnowledgeTree {...props} workspaceId="returned" />);
  expect(view.getByRole("treeitem", { name: "a" }).getAttribute("aria-expanded")).toBe("true");
  expect(view.getByRole("treeitem", { name: "b" }).getAttribute("aria-expanded")).toBe("false");
  view.rerender(<KnowledgeTree {...props} workspaceId="returned" displayFolder="a" />);
  view.rerender(<KnowledgeTree {...props} workspaceId="returned" />);
  expect(view.getByRole("treeitem", { name: "a" }).getAttribute("aria-expanded")).toBe("true");
});

it("discards deleted or externally moved folders when a complete tree arrives", () => {
  let view = render(<KnowledgeTree {...props} />);
  fireEvent.click(view.getByRole("treeitem", { name: "a" }));
  view.unmount();
  view = render(<KnowledgeTree {...props} nodes={[folder("moved")]} />);
  expect(view.getByRole("treeitem", { name: "moved" }).getAttribute("aria-expanded")).toBe("false");
  view.rerender(<KnowledgeTree {...props} />);
  expect(view.getByRole("treeitem", { name: "a" }).getAttribute("aria-expanded")).toBe("false");
});

it("does not overwrite saved expansion with the initial empty loading tree", () => {
  const key = TREE_EXPANSION_KEY + props.rootPath;
  const raw = JSON.stringify({ version: 1, paths: ["a", "a/nested", "deleted"] });
  localStorage.setItem(key, raw);
  const view = render(<KnowledgeTree {...props} nodes={[]} treeReady={false} />);
  window.dispatchEvent(new Event("beforeunload"));
  expect(localStorage.getItem(key)).toBe(raw);
  view.rerender(<KnowledgeTree {...props} treeReady />);
  expect(view.getByRole("treeitem", { name: "nested" }).getAttribute("aria-expanded")).toBe("true");
  window.dispatchEvent(new Event("beforeunload"));
  expect(JSON.parse(localStorage.getItem(key)!).paths).toEqual(["a", "a/nested"]);
});

it("maps confirmed in-app folder moves before dropping obsolete paths", () => {
  const view = render(<KnowledgeTree {...props} />);
  fireEvent.click(view.getByRole("treeitem", { name: "a" }));
  fireEvent.click(view.getByRole("treeitem", { name: "nested" }));
  view.rerender(
    <KnowledgeTree
      {...props}
      nodes={[folder("moved", [folder("moved/nested")])]}
      pathMoves={[{ from: "a", to: "moved", revision: 2 }]}
      revision={2}
    />,
  );
  expect(view.getByRole("treeitem", { name: "moved" }).getAttribute("aria-expanded")).toBe("true");
  expect(view.getByRole("treeitem", { name: "nested" }).getAttribute("aria-expanded")).toBe("true");
});

it("keeps corrupt and future preferences untouched while toggles still work", () => {
  for (const raw of [
    "{",
    JSON.stringify({ version: 2, paths: ["a"] }),
    JSON.stringify({ version: 1, paths: ["../a"] }),
  ]) {
    const key = TREE_EXPANSION_KEY + props.rootPath;
    localStorage.setItem(key, raw);
    const view = render(<KnowledgeTree {...props} />);
    fireEvent.click(view.getByRole("treeitem", { name: "a" }));
    expect(view.getByRole("treeitem", { name: "a" }).getAttribute("aria-expanded")).toBe("true");
    view.unmount();
    expect(localStorage.getItem(key)).toBe(raw);
  }
});

it("coalesces rapid toggles without reading folder children again", () => {
  vi.useFakeTimers();
  try {
    const childRead = vi.fn(() => [] as TreeNode[]);
    const measured = {
      ...folder("measured"),
      get children() {
        return childRead();
      },
    };
    const view = render(<KnowledgeTree {...props} nodes={[folder("toggle"), measured]} />);
    const save = vi.spyOn(Storage.prototype, "setItem");
    childRead.mockClear();
    const row = view.getByRole("treeitem", { name: "toggle" });
    fireEvent.click(row);
    fireEvent.click(row);
    fireEvent.click(row);
    // A collapsed sibling is not revisited by validation while another folder is toggled.
    expect(childRead).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(save).toHaveBeenCalledTimes(1);
    expect(JSON.parse(save.mock.calls[0][1]).paths).toEqual(["toggle"]);
  } finally {
    vi.useRealTimers();
  }
});

it("retains failed writes across root switches and retries the latest state", () => {
  const key = TREE_EXPANSION_KEY + props.rootPath;
  const saved = JSON.stringify({ version: 1, paths: ["b"] });
  localStorage.setItem(key, saved);
  const write = localStorage.setItem.bind(localStorage);
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation((name, value) => {
    if (name === key) throw new DOMException("Full", "QuotaExceededError");
    write(name, value);
  });
  const view = render(<KnowledgeTree {...props} />);
  fireEvent.click(view.getByRole("treeitem", { name: "a" }));
  window.dispatchEvent(new Event("beforeunload"));
  expect(localStorage.getItem(key)).toBe(saved);

  view.rerender(<KnowledgeTree {...props} rootPath="/fixture/two" workspaceId="other" />);
  expect(view.getByRole("treeitem", { name: "a" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(view.getByRole("treeitem", { name: "b" }));
  window.dispatchEvent(new Event("beforeunload"));
  view.rerender(<KnowledgeTree {...props} workspaceId="returned" />);
  expect(view.getByRole("treeitem", { name: "a" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(view.getByRole("treeitem", { name: "b" }));
  window.dispatchEvent(new Event("beforeunload"));
  expect(localStorage.getItem(key)).toBe(saved);

  save.mockImplementation(write);
  window.dispatchEvent(new Event("beforeunload"));
  expect(JSON.parse(localStorage.getItem(key)!).paths).toEqual(["a"]);
  save.mockClear();
  window.dispatchEvent(new Event("beforeunload"));
  expect(save).not.toHaveBeenCalled();
  view.rerender(<KnowledgeTree {...props} rootPath="/fixture/two" workspaceId="other-again" />);
  expect(view.getByRole("treeitem", { name: "a" }).getAttribute("aria-expanded")).toBe("false");
  expect(view.getByRole("treeitem", { name: "b" }).getAttribute("aria-expanded")).toBe("true");
});

it.each(["corrupt", "future", "unavailable"] as const)(
  "keeps %s preferences read-only while session choices survive root switches",
  (mode) => {
    const key = TREE_EXPANSION_KEY + props.rootPath;
    const saved =
      mode === "corrupt" ? "{" : JSON.stringify({ version: mode === "future" ? 2 : 1, paths: [] });
    localStorage.setItem(key, saved);
    const read = localStorage.getItem.bind(localStorage);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation((name) => {
      if (mode === "unavailable" && name === key)
        throw new DOMException("Unavailable", "SecurityError");
      return read(name);
    });
    const save = vi.spyOn(Storage.prototype, "setItem");
    const view = render(<KnowledgeTree {...props} />);
    fireEvent.click(view.getByRole("treeitem", { name: "a" }));
    view.rerender(<KnowledgeTree {...props} rootPath="/fixture/two" workspaceId="other" />);
    view.rerender(<KnowledgeTree {...props} workspaceId="returned" />);
    expect(view.getByRole("treeitem", { name: "a" }).getAttribute("aria-expanded")).toBe("true");
    window.dispatchEvent(new Event("beforeunload"));
    expect(save).not.toHaveBeenCalled();
    expect(read(key)).toBe(saved);
  },
);

it("retries a failed coalesced write only on a later flush", () => {
  vi.useFakeTimers();
  try {
    const view = render(<KnowledgeTree {...props} />);
    const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    fireEvent.click(view.getByRole("treeitem", { name: "a" }));
    vi.advanceTimersByTime(250);
    expect(save).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(save).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("beforeunload"));
    expect(save).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
