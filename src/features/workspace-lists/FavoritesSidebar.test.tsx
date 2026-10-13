import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { KnowledgeController } from "../../lib/controller";
import type { AppState, Bridge, DocumentSelection } from "../../lib/types";
import { setLanguage } from "../../lib/i18n";
import { FavoritesSidebar } from "./FavoritesSidebar";
const file = {
  relativePath: "日本語/資料.html",
  identity: "f".repeat(64),
  status: "available" as const,
};
const folder = {
  relativePath: "日本語フォルダー",
  identity: "d".repeat(64),
  status: "available" as const,
};
beforeEach(() => setLanguage("ja"));
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
    watchError: null,
    nodes: [
      {
        name: file.relativePath,
        relativePath: file.relativePath,
        kind: "html" as const,
        children: [],
      },
      {
        name: folder.relativePath,
        relativePath: folder.relativePath,
        kind: "folder" as const,
        children: [],
      },
    ],
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
  let state: AppState = {
    ...controller.getSnapshot(),
    snapshot,
    loading: false,
    workspaceLists: {
      favorites: [file],
      folderFavorites: [folder],
      recent: [{ ...file, relativePath: "最近.html" }],
      error: null,
      readOnly: false,
    },
  };
  vi.spyOn(controller, "getSnapshot").mockImplementation(() => state);
  const refresh = vi.spyOn(controller, "refreshWorkspaceLists").mockResolvedValue(undefined);
  const cancel = vi.spyOn(controller, "cancelWorkspaceSelection");
  const selectDocument = vi.spyOn(controller, "selectWorkspaceDocument").mockResolvedValue(true);
  const selectFolder = vi.spyOn(controller, "selectWorkspaceFolder").mockResolvedValue({
    relativePath: folder.relativePath,
    workspaceId: "root",
    viewId: "view",
    revision: 1,
  });
  const favorite = vi.spyOn(controller, "setFavorite").mockResolvedValue(undefined);
  const onFolderSelect = vi.fn(() => true);
  return {
    controller,
    state,
    refresh,
    cancel,
    selectDocument,
    selectFolder,
    favorite,
    onFolderSelect,
    update: (next: AppState) => {
      state = next;
    },
  };
}
test("favorites combine file and folder safe selections; recent reuses the same compact surface without removing records", async () => {
  const context = setup();
  render(<FavoritesSidebar {...context} active />);
  fireEvent.click(screen.getByRole("button", { name: "お気に入り" }));
  fireEvent.click(screen.getByRole("button", { name: "日本語/資料.htmlを開く" }));
  expect(context.selectDocument).toHaveBeenCalledWith(file, expect.any(AbortSignal));
  fireEvent.click(screen.getByRole("button", { name: "日本語フォルダーのフォルダーを表示" }));
  await waitFor(() => expect(context.onFolderSelect).toHaveBeenCalled());
  expect(context.selectFolder).toHaveBeenCalledWith(folder, expect.any(AbortSignal));
  const surface = screen.getByRole("region", { name: "お気に入り" });
  fireEvent.click(screen.getByRole("button", { name: "最近の文書を表示" }));
  expect(screen.getByRole("region", { name: "お気に入り" })).toBe(surface);
  fireEvent.click(screen.getByRole("button", { name: "最近.htmlを開く" }));
  expect(context.selectDocument).toHaveBeenLastCalledWith(
    expect.objectContaining({ relativePath: "最近.html" }),
    expect.any(AbortSignal),
  );
  expect(screen.queryByRole("button", { name: /お気に入りから解除/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "お気に入りを表示" }));
  expect(context.state.workspaceLists?.recent).toHaveLength(1);
});
test("the collapsed row defers scans and preserves entries, language and root boundaries", async () => {
  const context = setup();
  const view = render(<FavoritesSidebar {...context} active />);
  const disclosure = screen.getByRole("button", { name: "お気に入り" });
  const contentId = disclosure.getAttribute("aria-controls")!;
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById(contentId)?.hidden).toBe(true);
  expect(screen.queryByRole("list")).toBeNull();
  expect(context.refresh).not.toHaveBeenCalled();
  fireEvent.click(disclosure);
  await waitFor(() => expect(context.refresh).toHaveBeenCalledOnce());
  expect(screen.getByRole("list")).toBeTruthy();
  fireEvent.click(disclosure);
  expect(screen.queryByRole("list")).toBeNull();
  expect(context.favorite).not.toHaveBeenCalled();
  expect(context.state.workspaceLists!.favorites).toEqual([file]);
  fireEvent.click(disclosure);
  act(() => {
    setLanguage("en");
  });
  expect(screen.getByRole("button", { name: "Favorites" })).toBe(disclosure);
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  const next = { ...context.state, snapshot: { ...context.state.snapshot, viewId: "next" } };
  context.update(next);
  view.rerender(<FavoritesSidebar {...context} state={next} active />);
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();
  expect(context.favorite).not.toHaveBeenCalled();
});
test("collapsing cancels a pending folder selection without moving the tree", async () => {
  const context = setup();
  let finish!: (value: DocumentSelection) => void;
  context.selectFolder.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<FavoritesSidebar {...context} active />);
  const disclosure = screen.getByRole("button", { name: "お気に入り" });
  fireEvent.click(disclosure);
  fireEvent.click(screen.getByRole("button", { name: "日本語フォルダーのフォルダーを表示" }));
  const signal = context.selectFolder.mock.calls[0][1]!;
  fireEvent.click(disclosure);
  expect(signal.aborted).toBe(true);
  await act(async () =>
    finish({ relativePath: folder.relativePath, workspaceId: "root", viewId: "view", revision: 1 }),
  );
  expect(context.onFolderSelect).not.toHaveBeenCalled();
  expect(context.cancel).not.toHaveBeenCalled();
});
test("stale root closures cannot open or remove a current root's same-path favorite", async () => {
  const context = setup();
  render(<FavoritesSidebar {...context} active />);
  fireEvent.click(screen.getByRole("button", { name: "お気に入り" }));
  context.update({
    ...context.state,
    snapshot: { ...context.state.snapshot, workspaceId: "other" },
  });
  fireEvent.click(screen.getByRole("button", { name: "日本語/資料.htmlを開く" }));
  fireEvent.click(screen.getByRole("button", { name: "日本語/資料.htmlをお気に入りから解除" }));
  expect(context.selectDocument).not.toHaveBeenCalled();
  expect(context.favorite).not.toHaveBeenCalled();
});
test("unmount and hiding abort only the sidebar's own pending selection, never unrelated operations", async () => {
  const context = setup();
  let complete!: (value: DocumentSelection) => void;
  context.selectFolder.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const view = render(<FavoritesSidebar {...context} active />);
  fireEvent.click(screen.getByRole("button", { name: "お気に入り" }));
  fireEvent.click(screen.getByRole("button", { name: "日本語フォルダーのフォルダーを表示" }));
  const signal = context.selectFolder.mock.calls[0][1]!;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () =>
    complete({
      relativePath: folder.relativePath,
      workspaceId: "root",
      viewId: "view",
      revision: 1,
    }),
  );
  expect(context.onFolderSelect).not.toHaveBeenCalled();
  expect(context.cancel).not.toHaveBeenCalled();
  const inactive = setup();
  inactive.state.workspaceLists = undefined;
  const hidden = render(<FavoritesSidebar {...inactive} active={false} />);
  const loaded = { ...inactive.state, workspaceLists: context.state.workspaceLists };
  inactive.update(loaded);
  hidden.rerender(<FavoritesSidebar {...inactive} state={loaded} active={false} />);
  expect(inactive.cancel).not.toHaveBeenCalled();
  expect(inactive.refresh).not.toHaveBeenCalled();
});
test("metadata scans coalesce repeated refresh and ignore their own list response and document-only revisions", async () => {
  const context = setup();
  let finish!: () => void;
  context.refresh.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<FavoritesSidebar {...context} active />);
  fireEvent.click(screen.getByRole("button", { name: "お気に入り" }));
  expect(context.refresh).toHaveBeenCalledTimes(1);
  const button = screen.getByRole("button", { name: "お気に入りと最近の文書を更新" });
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.click(button);
  expect(context.refresh).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(context.refresh).toHaveBeenCalledTimes(2);
  const next = {
    ...context.state,
    snapshot: { ...context.state.snapshot, revision: 2 },
    workspaceLists: {
      ...context.state.workspaceLists!,
      favorites: [...context.state.workspaceLists!.favorites],
    },
  };
  context.update(next);
  view.rerender(<FavoritesSidebar {...context} state={next} active />);
  expect(context.refresh).toHaveBeenCalledTimes(2);
});
test("busy defers one metadata scan then retries once, and readonly preserves removal boundaries", async () => {
  const context = setup();
  const busy = { ...context.state, actionBusy: true };
  context.update(busy);
  const view = render(<FavoritesSidebar {...context} state={busy} active />);
  fireEvent.click(screen.getByRole("button", { name: "お気に入り" }));
  expect(context.refresh).not.toHaveBeenCalled();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "日本語/資料.htmlを開く" }).disabled,
  ).toBe(true);
  context.update(context.state);
  view.rerender(<FavoritesSidebar {...context} active />);
  await waitFor(() => expect(context.refresh).toHaveBeenCalledTimes(1));
  const readonly = {
    ...context.state,
    workspaceLists: {
      ...context.state.workspaceLists!,
      readOnly: true,
      error: "端末設定は読み取り専用です",
    },
  };
  context.update(readonly);
  view.rerender(<FavoritesSidebar {...context} state={readonly} active />);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "日本語/資料.htmlをお気に入りから解除" })
      .disabled,
  ).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("読み取り専用");
});
test("unavailable entries retain a keyboard removal button and language switches preserve raw paths", () => {
  const context = setup();
  context.state.workspaceLists!.favorites = [{ ...file, status: "missing" }];
  const view = render(<FavoritesSidebar {...context} active />);
  fireEvent.click(screen.getByRole("button", { name: "お気に入り" }));
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "日本語/資料.htmlを開く" }).disabled,
  ).toBe(true);
  const remove = screen.getByRole<HTMLButtonElement>("button", {
    name: "日本語/資料.htmlをお気に入りから解除",
  });
  remove.focus();
  expect(document.activeElement).toBe(remove);
  act(() => {
    setLanguage("en");
  });
  expect(screen.getByRole("region", { name: "Favorites" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove 日本語/資料.html from favorites" })).toBe(
    remove,
  );
  expect(document.activeElement).toBe(remove);
  fireEvent.click(remove);
  expect(context.favorite).toHaveBeenCalledWith(file.relativePath, false);
  view.unmount();
  const empty = {
    ...context.state,
    snapshot: { ...context.state.snapshot, workspaceId: null },
    workspaceLists: undefined,
  };
  context.update(empty);
  render(<FavoritesSidebar {...context} state={empty} active />);
  fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
  expect(screen.getByRole("region", { name: "Favorites" })).toBeTruthy();
  expect(screen.getByText("Choose a workspace folder")).toBeTruthy();
});
