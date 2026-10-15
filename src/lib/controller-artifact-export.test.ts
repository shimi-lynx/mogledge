import { expect, it, vi } from "vite-plus/test";
import { KnowledgeController } from "./controller";
import type { Bridge, Change, Snapshot } from "./types";
it("derives Native tab/request from main records, rejects hidden/help/stale URLs, and invalidates reload/root changes", async () => {
  const token = (request: number) => request.toString(16).padStart(64, "0");
  let snapshot: Snapshot = {
    workspaceId: "workspace",
    viewId: "view",
    rootPath: "/fixture",
    revision: 1,
    nodes: ["a.html", "b.html"].map((name) => ({
      name,
      relativePath: name,
      kind: "html",
      children: [],
    })),
    watchError: null,
  };
  let change: (value: Change) => void = () => {};
  let next = 0;
  const api: Bridge = {
    beginView: vi.fn(async () => snapshot),
    getTree: vi.fn(async () => snapshot),
    chooseRoot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    listen: vi.fn(async (callback) => {
      change = callback;
      return () => {};
    }),
    createTab: vi.fn(async () => `native-${++next}`),
    closeTab: vi.fn(async () => {}),
    openDocument: vi.fn(
      async (_workspace, _view, id, request) => `http://127.0.0.1/s/${token(request)}/${id}.html`,
    ),
    mutateTree: vi.fn(async () => ({ snapshot, createdPath: null, moves: [], warning: null })),
    performFileAction: vi.fn(async () => {}),
  };
  const controller = new KnowledgeController(api);
  await controller.start();
  await controller.select("a.html");
  const first = controller.getSnapshot().tabs[0];
  expect(controller.artifactContext(first.id, first.url!)).toEqual({
    workspaceId: "workspace",
    viewId: "view",
    tabId: "native-1",
    request: 1,
    revision: 1,
    token: token(1),
  });
  expect(controller.artifactContext("native-1", first.url!)).toBeNull();
  expect(controller.artifactContext(first.id, first.url! + "?forged")).toBeNull();
  await controller.select("b.html");
  expect(controller.artifactContext(first.id, first.url!)).toBeNull();
  controller.activate(first.id);
  await controller.reload(first.id);
  expect(controller.artifactContext(first.id, first.url!)).toBeNull();
  const reloaded = controller.getSnapshot().tabs.find((tab) => tab.id === first.id)!;
  expect(controller.artifactContext(first.id, reloaded.url!)?.request).toBe(2);
  change({
    workspaceId: "workspace",
    revision: 2,
    changedPaths: [],
    structureChanged: false,
    watchError: null,
  });
  expect(controller.artifactContext(first.id, reloaded.url!)?.revision).toBe(2);
  const help = controller.openHelp()!;
  expect(controller.artifactContext(help, reloaded.url!)).toBeNull();
  snapshot = { ...snapshot, workspaceId: "other", viewId: "other-view", nodes: [] };
  await controller.registerRoot();
  expect(controller.artifactContext(first.id, reloaded.url!)).toBeNull();
  controller.stop();
});
