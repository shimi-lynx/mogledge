import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setLanguage, useT } from "../../lib/i18n";
import type { TreeNode } from "../../lib/types";
import { KnowledgeTree } from "./KnowledgeTree";
import { FolderPicker } from "./FolderPicker";
import { MutationDialog } from "./MutationDialog";
import { TrashDialog } from "./TrashDialog";

let dialogDescriptors: Record<"showModal" | "close", PropertyDescriptor | undefined>;
beforeEach(() => {
  setLanguage("ja");
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
    const descriptor = dialogDescriptors[name];
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setLanguage("ja");
});

it("switches tree and menu labels without replacing rows, focus, paths, or action targets", () => {
  const path = "日本語 $& {count}.HtM";
  const nodes: TreeNode[] = [{ name: path, relativePath: path, kind: "html", children: [] }];
  const onFavorite = vi.fn();
  const onAiHandoff = vi.fn();
  const onSelect = vi.fn();
  const view = render(
    <KnowledgeTree
      nodes={nodes}
      workspaceId="workspace"
      selected={path}
      favoritePaths={[path]}
      onSelect={onSelect}
      onFavorite={onFavorite}
      onAiHandoff={onAiHandoff}
      onFileAction={vi.fn()}
      onMutation={vi.fn(async () => null)}
    />,
  );
  const row = view.getByRole("treeitem", { name: "日本語 $& {count} HTML" });
  const filename = row.querySelector(".filename");
  const favorite = within(row).getByRole("button", { name: "お気に入りから解除" });
  fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
  const menu = view.getByRole("menu", { name: path + "のファイル操作" });
  const ai = within(menu).getByRole("menuitem", { name: "AIに渡す" });
  const copy = within(menu).getByRole("menuitem", { name: "フルパスをコピー" });
  copy.focus();
  act(() => {
    setLanguage("en");
  });
  expect(view.getByRole("tree", { name: "knowledge file tree" })).toBeTruthy();
  expect(view.getByRole("treeitem", { name: "日本語 $& {count} HTML" })).toBe(row);
  expect(row.querySelector(".filename")).toBe(filename);
  expect(filename?.textContent).toBe("日本語 $& {count}");
  expect(row.title).toBe(path);
  expect(within(row).getByRole("button", { name: "Remove from favorites" })).toBe(favorite);
  expect(favorite.title).toBe("Remove from favorites");
  expect(view.getByRole("menu", { name: "File actions for " + path })).toBe(menu);
  expect(within(menu).getByRole("menuitem", { name: "Send to AI" })).toBe(ai);
  expect(document.activeElement).toBe(copy);
  expect(copy.textContent).toBe("Copy full path");
  fireEvent.click(ai);
  expect(onAiHandoff).toHaveBeenCalledWith(path, view.getByRole("tree"));
  fireEvent.click(favorite);
  expect(onFavorite).toHaveBeenCalledWith(path, false);
  expect(onSelect).not.toHaveBeenCalled();
  act(() => {
    setLanguage("ja");
  });
  expect(within(row).getByRole("button", { name: "お気に入りから解除" })).toBe(favorite);
  expect(row.querySelector(".filename")).toBe(filename);
});

it("retains an open folder picker's typed query, target, and DOM across a language change", () => {
  const onChange = vi.fn();
  const folders = [{ path: "日本語 $& {label}", label: "日本語 $& {label}" }];
  function Picker() {
    const t = useT();
    return (
      <FolderPicker
        folders={folders}
        value={folders[0].path}
        label={t("作成先")}
        locked={false}
        onChange={onChange}
      />
    );
  }
  const view = render(<Picker />);
  const input = view.getByRole("combobox", { name: "作成先" }) as HTMLInputElement;
  fireEvent.click(input);
  fireEvent.change(input, { target: { value: "日本語" } });
  const option = view.getByRole("option", { name: folders[0].label });
  act(() => {
    setLanguage("en");
  });
  expect(view.getByRole("combobox", { name: "Create in" })).toBe(input);
  expect(input.value).toBe("日本語");
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(view.getByRole("option", { name: folders[0].label })).toBe(option);
  expect(view.getByRole("listbox", { name: "Options for Create in" })).toBeTruthy();
  fireEvent.click(option);
  expect(onChange).toHaveBeenCalledWith("日本語 $& {label}");
  expect(input.value).toBe("日本語 $& {label}");
  fireEvent.click(input);
  fireEvent.change(input, { target: { value: "該当しない入力" } });
  expect(view.getByRole("status").textContent).toBe("No matching folders");
  act(() => {
    setLanguage("ja");
  });
  expect(input.value).toBe("該当しない入力");
  expect(view.getByRole("status").textContent).toBe("該当するフォルダーがありません");
});

it("preserves a rename dialog's input and suffix while translating review and action text", () => {
  const onSubmit = vi.fn(async () => null);
  const view = render(
    <MutationDialog
      intent={{
        kind: "renameHtml",
        source: "日本語 $& {extension}.HtM",
        name: "日本語 $& {extension}",
      }}
      nodes={[]}
      busy={false}
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
  );
  const dialog = view.getByRole("dialog");
  const input = view.getByRole("textbox", { name: "名前" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "新しい日本語 $& {name}" } });
  input.focus();
  act(() => {
    setLanguage("en");
  });
  expect(view.getByRole("dialog")).toBe(dialog);
  expect(view.getByRole("textbox", { name: "Name" })).toBe(input);
  expect(input.value).toBe("新しい日本語 $& {name}");
  expect(document.activeElement).toBe(input);
  expect(dialog.textContent).toContain("The .HtM extension is preserved.");
  expect(dialog.textContent).toContain("日本語 $& {extension}.HtM");
  fireEvent.click(view.getByRole("button", { name: "Apply" }));
  expect(onSubmit).toHaveBeenCalledWith({
    kind: "renameHtml",
    source: "日本語 $& {extension}.HtM",
    name: "新しい日本語 $& {name}",
  });
});

it("translates folder trash confirmation while preserving the original target and cancel focus", () => {
  const path = "日本語 $& {path}";
  const view = render(
    <TrashDialog
      node={{ name: path, relativePath: path, kind: "folder", children: [] }}
      busy={false}
      stale
      onSubmit={vi.fn(async () => null)}
      onClose={vi.fn()}
    />,
  );
  const dialog = view.getByRole("dialog");
  const cancel = view.getByRole("button", { name: "キャンセル" });
  act(() => {
    setLanguage("en");
  });
  expect(view.getByRole("dialog")).toBe(dialog);
  expect(view.getByRole("button", { name: "Cancel" })).toBe(cancel);
  expect(document.activeElement).toBe(cancel);
  expect(dialog.textContent).toContain(path);
  expect(dialog.textContent).toContain("including hidden files and non-HTML documents");
  expect(view.getByRole("alert").textContent).toBe(
    "The tree has changed. Cancel and check the target again.",
  );
  expect((view.getByRole("button", { name: "Move to trash" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
