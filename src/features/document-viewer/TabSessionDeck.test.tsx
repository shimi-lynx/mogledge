import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { KnowledgeController } from "../../lib/controller";
import { setLanguage } from "../../lib/i18n";
import type { AppState, Bridge } from "../../lib/types";
import { DocumentDeck } from "./DocumentDeck";

afterEach(() => {
  cleanup();
  setLanguage("ja");
});

it("renders only two iframes for a 101-tab restored layout and preserves them across language changes", () => {
  const tabs = Array.from({ length: 101 }, (_, index) => ({
    id: `tab-${index}`,
    column: index === 100 ? (1 as const) : (0 as const),
    path: `${index}.html`,
    url: index === 3 || index === 100 ? `http://fixture/${index}.html` : null,
    deferred: index !== 3 && index !== 100,
    zoom: 125,
    loading: false,
    closing: false,
    dirty: true,
    missing: false,
    error: null,
  }));
  const state: AppState = {
    snapshot: {
      workspaceId: "fixture",
      viewId: "view",
      rootPath: "/fixture",
      nodes: [],
      revision: 1,
      watchError: null,
    },
    tabs,
    columns: [tabs[3].id, tabs[100].id],
    split: true,
    activeColumn: 1,
    closed: [],
    selectedPath: "100.html",
    documentUrl: tabs[100].url,
    loading: false,
    error: null,
    actionBusy: false,
    actionMessage: null,
  };
  const controller = new KnowledgeController({} as Bridge);
  const view = render(<DocumentDeck state={state} controller={controller} />);
  const frames = [...view.container.querySelectorAll("iframe")];
  expect(frames).toHaveLength(2);
  expect(view.getAllByRole("tabpanel", { hidden: true })).toHaveLength(101);
  act(() => {
    setLanguage("en");
  });
  expect(view.getAllByText("Loads when selected")).toHaveLength(99);
  expect([...view.container.querySelectorAll("iframe")]).toEqual(frames);
  act(() => {
    setLanguage("ja");
  });
  expect([...view.container.querySelectorAll("iframe")]).toEqual(frames);
});
