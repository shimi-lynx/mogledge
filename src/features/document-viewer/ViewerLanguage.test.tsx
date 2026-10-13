import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { setLanguage } from "../../lib/i18n";
import type { AppState, DocumentTab } from "../../lib/types";
import type { KnowledgeController } from "../../lib/controller";
import { DocumentViewer } from "./DocumentViewer";
import { TabStrip } from "./TabStrip";

afterEach(() => {
  cleanup();
  setLanguage("ja");
});

it("changes viewer diagnostics without translating user paths or replacing the document iframe", () => {
  const url = "http://localhost/s/" + "a".repeat(64) + "/index.html";
  const path = "日本語/$&/{path}/再読み込み.html";
  const view = render(<DocumentViewer url={url} loading={true} title={path} />);
  const frame = view.getByTitle(path);
  act(() => {
    setLanguage("en");
  });
  expect(view.getByTitle(path)).toBe(frame);
  expect(frame.getAttribute("src")).toBe(url);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(view.getByLabelText("Loading")).toBeTruthy();
  view.rerender(<DocumentViewer url={url} loading={true} />);
  expect(view.getByTitle("HTML document")).toBe(frame);
  act(() => {
    setLanguage("ja");
  });
  expect(view.getByTitle("HTMLドキュメント")).toBe(frame);
  expect(frame.getAttribute("src")).toBe(url);
});

it("translates tab menus in place while preserving raw document paths and excluding help actions", () => {
  const document: DocumentTab = {
    id: "document",
    path: "日本語/$&/{path}/再読み込み.html",
    url: "http://localhost/document",
    column: 0,
    loading: false,
    closing: false,
    dirty: true,
    missing: false,
    error: null,
  };
  const help: DocumentTab = {
    ...document,
    id: "app-help",
    kind: "help",
    path: "機能と使い方",
    url: null,
    dirty: false,
  };
  const state: AppState = {
    snapshot: {
      workspaceId: "root",
      viewId: "view",
      rootPath: "/fixture",
      revision: 1,
      nodes: [],
      watchError: null,
    },
    tabs: [document, help],
    columns: [document.id, null],
    activeColumn: 0,
    split: false,
    closed: [],
    selectedPath: document.path,
    documentUrl: document.url,
    loading: false,
    error: null,
    actionBusy: false,
    actionMessage: null,
  };
  const actions = { setActiveColumn: vi.fn(), openInColumn: vi.fn(), closeTab: vi.fn() };
  const view = render(
    <TabStrip
      state={state}
      controller={actions as unknown as KnowledgeController}
      onEmpty={vi.fn()}
    />,
  );
  const tab = view.getByRole("tab", { name: "再読み込み.html 更新あり" });
  fireEvent.contextMenu(tab);
  const menu = view.getByRole("menu", { name: document.path + "のタブ操作" });
  act(() => {
    setLanguage("en");
  });
  expect(view.getByRole("tab", { name: "再読み込み.html Updated" })).toBe(tab);
  expect(view.getByRole("menu", { name: "Tab actions for " + document.path })).toBe(menu);
  expect(tab.getAttribute("title")).toBe(document.path + " (updated)");
  fireEvent.click(view.getByRole("menuitem", { name: "Open in right column" }));
  expect(actions.openInColumn).toHaveBeenCalledExactlyOnceWith(document.path, 1);
  expect(view.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(view.getByRole("tab", { name: "Features and usage" }));
  expect(view.queryByRole("menu")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Close " + document.path }));
  expect(actions.closeTab).toHaveBeenCalledExactlyOnceWith(document.id);
});
