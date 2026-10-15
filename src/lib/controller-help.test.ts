import { expect, it, vi } from "vite-plus/test";
import { KnowledgeController } from "./controller";
import type { Bridge, Change, Snapshot, WorkspaceSets } from "./types";

function setup() {
  let snapshot: Snapshot = {
    workspaceId: "workspace",
    viewId: "view",
    rootPath: "/fixture",
    revision: 1,
    nodes: ["a.html", "b.html"].map((name) => ({
      relativePath: name,
      name,
      kind: "html",
      children: [],
    })),
    watchError: null,
  };
  let listener: (change: Change) => void = () => {};
  let next = 0;
  const api: Bridge = {
    beginView: vi.fn(async () => snapshot),
    getTree: vi.fn(async () => snapshot),
    chooseRoot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    listen: vi.fn(async (callback) => {
      listener = callback;
      return () => {};
    }),
    createTab: vi.fn(async () => `native-${++next}`),
    closeTab: vi.fn(async () => {}),
    openDocument: vi.fn(async (_workspace, _view, id) => `http://fixture/${id}`),
    mutateTree: vi.fn(async () => ({ snapshot, createdPath: null, moves: [], warning: null })),
    performFileAction: vi.fn(async () => {}),
    captureWorkspaceSet: vi.fn(async (): Promise<WorkspaceSets> => ({
      sets: [],
      setShortcuts: [null, null, null, null, null, null, null, null, null, null],
      error: null,
      readOnly: false,
    })),
  };
  const controller = new KnowledgeController(api);
  return {
    api,
    controller,
    emit: (change: Change) => listener(change),
    update: (value: Snapshot) => {
      snapshot = value;
    },
  };
}

it("opens one help tab without a root or Native document and closes without recent history", async () => {
  const { api, controller } = setup();
  const id = controller.openHelp()!;
  expect(controller.openHelp()).toBe(id);
  expect(controller.getSnapshot().tabs).toHaveLength(1);
  expect(controller.getSnapshot().tabs[0].kind).toBe("help");
  expect(controller.getSnapshot().selectedPath).toBeNull();
  expect(controller.getSnapshot().documentUrl).toBeNull();
  await controller.start();
  expect(controller.getSnapshot().tabs[0].id).toBe(id);
  await controller.closeTab(id);
  expect(controller.getSnapshot().tabs).toHaveLength(0);
  expect(controller.getSnapshot().closed).toHaveLength(0);
  expect(api.createTab).not.toHaveBeenCalled();
  expect(api.openDocument).not.toHaveBeenCalled();
  expect(api.closeTab).not.toHaveBeenCalled();
  controller.stop();
});

it("retains document views and help across columns, rescans and workspace changes", async () => {
  const { api, controller, emit, update } = setup();
  await controller.start();
  await controller.select("a.html");
  const document = controller.getSnapshot().tabs[0];
  const help = controller.openHelp()!;
  controller.moveTab(help, 1);
  expect(controller.openHelp()).toBe(help);
  expect(controller.getSnapshot().tabs).toHaveLength(2);
  expect(controller.getSnapshot().tabs.find((tab) => tab.id === document.id)?.url).toBe(
    document.url,
  );
  emit({
    workspaceId: "workspace",
    revision: 2,
    changedPaths: ["shared.css"],
    structureChanged: false,
    watchError: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(controller.getSnapshot().tabs.find((tab) => tab.id === help)).toMatchObject({
    missing: false,
    dirty: false,
    url: null,
  });
  update({
    ...controller.getSnapshot().snapshot,
    workspaceId: "other",
    viewId: "other-view",
    nodes: [],
    revision: 1,
  });
  await controller.registerRoot();
  expect(controller.getSnapshot().tabs).toEqual([
    expect.objectContaining({ id: help, kind: "help", column: 0 }),
  ]);
  expect(api.createTab).toHaveBeenCalledTimes(1);
  expect(api.closeTab).toHaveBeenCalledExactlyOnceWith("workspace", "view", "native-1");
  controller.stop();
});

it("excludes help from saved workspaces and selects a document when help owns the active slot", async () => {
  const { api, controller } = setup();
  await controller.start();
  controller.openHelp();
  expect(await controller.saveWorkspaceSet("help only")).toBe(false);
  expect(api.captureWorkspaceSet).not.toHaveBeenCalled();
  await controller.select("a.html");
  await controller.select("b.html", 1);
  const help = controller.openHelp()!;
  expect(controller.getSnapshot().activeColumn).toBe(0);
  controller.moveTab(help, 1);
  expect(await controller.saveWorkspaceSet("documents")).toBe(true);
  expect(api.captureWorkspaceSet).toHaveBeenCalledExactlyOnceWith(
    "workspace",
    "view",
    "documents",
    [
      { tabId: "native-1", column: 0, zoom: 100 },
      { tabId: "native-2", column: 1, zoom: 100 },
    ],
    [0, 1],
    1,
  );
  await controller.closeTab(help);
  expect(controller.getSnapshot().columns[1]).toBe(controller.getSnapshot().tabs[1].id);
  expect(controller.getSnapshot().closed).toHaveLength(0);
  controller.stop();
});

it("claims help and lazy documents before a bulk close exposes any replacement", async () => {
  const { api, controller } = setup();
  const items = ["a.html", "b.html"].map((relativePath, index) => ({
    document: { relativePath, identity: String(index).repeat(64) },
    column: 0 as const,
    zoom: 100,
    status: "available" as const,
    reusableTabs: [],
  }));
  api.resolveWorkspaceSet = vi.fn(async () => ({
    set: {
      id: "set",
      name: "documents",
      items,
      active: [0, null] as [number | null, number | null],
      activeColumn: 0 as const,
    },
    items,
  }));
  await controller.start();
  expect(await controller.restoreWorkspaceSet("set")).toBe(true);
  await vi.waitFor(() => expect(controller.getSnapshot().tabs[0].url).not.toBeNull());
  const [anchor, lazy] = controller.getSnapshot().tabs;
  expect(lazy.deferred).toBe(true);
  controller.openHelp();
  vi.mocked(api.createTab).mockClear();
  vi.mocked(api.openDocument).mockClear();
  await controller.closeTabsToRight(anchor.id);
  expect(controller.getSnapshot().tabs).toEqual([
    expect.objectContaining({ id: anchor.id, url: anchor.url }),
  ]);
  expect(controller.getSnapshot().columns).toEqual([anchor.id, null]);
  expect(controller.getSnapshot().closed).toEqual([{ path: "b.html", column: 0 }]);
  expect(api.createTab).not.toHaveBeenCalled();
  expect(api.openDocument).not.toHaveBeenCalled();
  expect(api.closeTab).not.toHaveBeenCalled();
  controller.stop();
});

it("keeps a failed document close retryable while help closes without history or Native calls", async () => {
  const { api, controller } = setup();
  await controller.start();
  await controller.select("a.html");
  await controller.select("b.html");
  const [anchor, document] = controller.getSnapshot().tabs;
  controller.openHelp();
  vi.mocked(api.closeTab).mockRejectedValueOnce(new Error("close failed"));
  await controller.closeTabsToRight(anchor.id);
  expect(controller.getSnapshot().tabs.map((tab) => tab.id)).toEqual([anchor.id, document.id]);
  expect(controller.getSnapshot().tabs[1]).toMatchObject({
    closing: false,
    error: "Error: close failed",
  });
  expect(controller.getSnapshot().error).toContain("close failed");
  expect(controller.getSnapshot().closed).toEqual([]);
  expect(api.closeTab).toHaveBeenCalledExactlyOnceWith("workspace", "view", "native-2");
  expect(api.createTab).toHaveBeenCalledTimes(2);
  expect(api.openDocument).toHaveBeenCalledTimes(2);
  await controller.closeTabsToRight(anchor.id);
  expect(controller.getSnapshot().tabs[0].url).toBe(anchor.url);
  expect(controller.getSnapshot().closed).toEqual([{ path: "b.html", column: 0 }]);
  expect(controller.getSnapshot().error).toBeNull();
  controller.stop();
});
