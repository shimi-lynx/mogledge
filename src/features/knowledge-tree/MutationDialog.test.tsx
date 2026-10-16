import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MutationDialog } from "./MutationDialog";
import type { TreeNode } from "../../lib/types";
import { setLanguage } from "../../lib/i18n";

const folder = (path: string, children: TreeNode[] = []): TreeNode => ({
  name: path.split("/").at(-1)!,
  relativePath: path,
  kind: "folder",
  children,
});
const nodes = [
  folder("日本語", [folder("日本語/共通")]),
  folder("資料", [folder("資料/共通")]),
  folder("Source", [folder("Source/child")]),
  folder("Source2"),
];
const descriptors = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
};
beforeEach(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      },
    },
    close: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute("open");
      },
    },
  });
});
afterEach(() => {
  cleanup();
  for (const name of ["showModal", "close"] as const) {
    if (descriptors[name])
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptors[name]!);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});

it("selects a verified creation folder by relative path, preserves IME and treats arbitrary text only as a filter", async () => {
  const onSubmit = vi.fn(async () => null),
    onClose = vi.fn();
  const view = render(
    <MutationDialog
      rootPath="/fixture/knowledge"
      intent={{ kind: "createFolder", parent: "日本語" }}
      nodes={nodes}
      busy={false}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );
  const picker = view.getByRole("combobox", { name: "作成先" });
  expect((picker as HTMLInputElement).value).toBe("日本語");
  expect(document.activeElement).toBe(view.getByRole("textbox", { name: "名前" }));
  fireEvent.click(picker);
  fireEvent.change(picker, { target: { value: "共通" } });
  expect(view.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "日本語/共通",
    "資料/共通",
  ]);
  fireEvent.compositionStart(picker);
  fireEvent.keyDown(picker, { key: "Enter", isComposing: true });
  fireEvent.compositionEnd(picker);
  fireEvent.keyDown(picker, { key: "Enter", keyCode: 229 });
  expect(view.getByRole("listbox")).toBeDefined();
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(picker, { key: "ArrowDown" });
  fireEvent.keyDown(picker, { key: "Enter" });
  expect((picker as HTMLInputElement).value).toBe("資料/共通");
  fireEvent.click(picker);
  fireEvent.change(picker, { target: { value: "../../unverified" } });
  expect(view.queryAllByRole("option")).toHaveLength(0);
  expect(view.getByRole("status").textContent).toContain("該当するフォルダーがありません");
  fireEvent.keyDown(picker, { key: "Enter" });
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(picker, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.change(view.getByRole("textbox", { name: "名前" }), { target: { value: "新規" } });
  fireEvent.click(view.getByRole("button", { name: "作成する" }));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "createFolder",
      parent: "資料/共通",
      name: "新規",
    }),
  );
});

it("excludes a move's source and descendants, keeps sibling prefixes and clears anchors for a new parent", async () => {
  const onSubmit = vi.fn(async () => null);
  const view = render(
    <MutationDialog
      rootPath="/fixture/knowledge"
      intent={{ kind: "move", source: "Source", parent: "", anchor: "資料", after: true }}
      nodes={nodes}
      busy={false}
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
  );
  const picker = view.getByRole("combobox", { name: "移動先" });
  expect(document.activeElement).toBe(picker);
  fireEvent.click(picker);
  expect(view.queryByRole("option", { name: "Source" })).toBeNull();
  expect(view.queryByRole("option", { name: "Source/child" })).toBeNull();
  fireEvent.click(view.getByRole("option", { name: "Source2" }));
  fireEvent.click(view.getByRole("button", { name: "移動する" }));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "move",
      source: "Source",
      parent: "Source2",
      anchor: undefined,
      after: true,
    }),
  );
});

it("rejects a disappeared destination, locks pending edits and resets selection on cancellation and remount", async () => {
  const onSubmit = vi.fn(async () => "Native guard rejected"),
    onClose = vi.fn();
  const props = {
    rootPath: "/fixture/knowledge",
    intent: { kind: "createFolder" as const, parent: "日本語" },
    nodes,
    busy: false,
    onSubmit,
    onClose,
  };
  const view = render(<MutationDialog {...props} />);
  const picker = view.getByRole("combobox", { name: "作成先" });
  fireEvent.change(view.getByRole("textbox", { name: "名前" }), { target: { value: "新規" } });
  view.rerender(<MutationDialog {...props} nodes={nodes.slice(1)} />);
  expect(view.getByRole("button", { name: "作成する" }).hasAttribute("disabled")).toBe(true);
  expect(view.getByRole("alert").textContent).toContain("選び直してください");
  fireEvent.submit(view.container.querySelector("form")!);
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.click(picker);
  fireEvent.click(view.getByRole("option", { name: "knowledge（ルート）" }));
  view.rerender(<MutationDialog {...props} nodes={nodes.slice(1)} busy />);
  fireEvent.change(picker, { target: { value: "資料" } });
  expect(picker.getAttribute("aria-disabled")).toBe("true");
  expect(view.queryByRole("listbox")).toBeNull();
  view.rerender(<MutationDialog {...props} nodes={nodes.slice(1)} />);
  fireEvent.click(view.getByRole("button", { name: "作成する" }));
  await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Native guard rejected"));
  fireEvent.click(view.getByRole("button", { name: "キャンセル" }));
  view.unmount();
  const fresh = render(<MutationDialog {...props} />);
  expect((fresh.getByRole("combobox", { name: "作成先" }) as HTMLInputElement).value).toBe(
    "日本語",
  );
  expect((fresh.getByRole("textbox", { name: "名前" }) as HTMLInputElement).value).toBe("");
});

it("bounds folder candidates and includes the initial selection beyond the first page", () => {
  const many = Array.from({ length: 500 }, (_, index) => folder("folder-" + index));
  const view = render(
    <MutationDialog
      rootPath="/fixture/knowledge"
      intent={{ kind: "createFolder", parent: "folder-499" }}
      nodes={many}
      busy={false}
      onSubmit={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const picker = view.getByRole("combobox");
  expect(view.queryByRole("listbox")).toBeNull();
  fireEvent.click(picker);
  expect(view.getAllByRole("option")).toHaveLength(50);
  expect(view.getByRole("option", { name: "folder-499" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(picker.getAttribute("aria-activedescendant")).toBe(
    view.getByRole("option", { name: "folder-499" }).id,
  );
});

it("updates the actual root name and language, distinguishes a same-named child and submits the unchanged root path", async () => {
  const name = "日本語 <img onerror=fail>&$1{root}";
  const onSubmit = vi.fn(async () => null);
  const props = {
    intent: { kind: "createFolder" as const, parent: "" },
    nodes: [folder(name)],
    rootPath: "/fixture/Old root/",
    busy: false,
    onSubmit,
    onClose: vi.fn(),
  };
  const view = render(<MutationDialog {...props} />);
  const picker = view.getByRole("combobox", { name: "作成先" });
  expect((picker as HTMLInputElement).value).toBe("Old root（ルート）");
  view.rerender(<MutationDialog {...props} rootPath={"C:\\fixture\\" + name + "\\"} />);
  expect((picker as HTMLInputElement).value).toBe(name + "（ルート）");
  expect(picker.getAttribute("title")).toBe(name + "（ルート）");
  fireEvent.keyDown(picker, { key: "ArrowDown" });
  expect(view.getAllByRole("option").map((option) => option.textContent)).toEqual([
    name + "（ルート）",
    name,
  ]);
  expect(view.container.querySelector("img")).toBeNull();
  await act(() => setLanguage("en"));
  expect(view.getAllByRole("option").map((option) => option.textContent)).toEqual([
    name + " (root)",
    name,
  ]);
  expect(view.queryByText("Old root（ルート）")).toBeNull();
  fireEvent.keyDown(picker, { key: "Enter" });
  fireEvent.change(view.getByRole("textbox", { name: "Name" }), { target: { value: "Created" } });
  fireEvent.click(view.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "createFolder",
      parent: "",
      name: "Created",
    }),
  );
});
