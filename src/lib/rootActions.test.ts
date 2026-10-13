import { afterEach, expect, test, vi } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { KnowledgeController } from "./controller";
import { rootActionsApi } from "./rootActions";
import { translateUiMessage } from "./i18n";
import type { Bridge, Snapshot } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => vi.mocked(invoke).mockReset());

function fixture(selected = true) {
  let snapshot: Snapshot = {
    workspaceId: selected ? "workspace" : null,
    viewId: "view",
    rootPath: selected ? "/日本語 空白 root" : null,
    revision: 1,
    nodes: [],
    watchError: null,
  };
  const api: Bridge = {
    mutateTree: vi.fn(async () => ({ snapshot, createdPath: null, moves: [], warning: null })),
    performFileAction: vi.fn(async () => {}),
    beginView: vi.fn(async () => snapshot),
    getTree: vi.fn(async () => snapshot),
    chooseRoot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    createTab: vi.fn(async () => "tab"),
    closeTab: vi.fn(async () => {}),
    openDocument: vi.fn(async () => "http://fixture"),
    listen: vi.fn(async () => () => {}),
  };
  const controller = new KnowledgeController(api);
  return {
    controller,
    api,
    select: (value: Snapshot) => {
      snapshot = value;
    },
    snapshot,
  };
}

test("root action IPC carries root context and action without caller-selected paths", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  await rootActionsApi.perform({ workspaceId: "w", viewId: "v", target: "root" }, "openFolder");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("perform_root_action", {
    context: { workspaceId: "w", viewId: "v", target: "root" },
    action: "openFolder",
  });
});

test("root action controller prevents duplicates and preserves native failure diagnostics", async () => {
  const { controller, api } = fixture();
  await controller.start();
  let reject!: (reason: string) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  const action = controller.performRootAction("copyPath");
  expect(controller.getSnapshot().actionBusy).toBe(true);
  await controller.performRootAction("openFolder");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(api.performFileAction).not.toHaveBeenCalled();
  reject("permission denied: 日本語 空白 root");
  await action;
  expect(controller.getSnapshot().actionBusy).toBe(false);
  expect(translateUiMessage(controller.getSnapshot().error!, "en")).toContain(
    "permission denied: 日本語 空白 root",
  );
  vi.mocked(invoke).mockResolvedValue(undefined);
  await controller.performRootAction("openFolder");
  expect(controller.getSnapshot().actionMessage).toBe("OSへフォルダーの表示を依頼しました");
  expect(controller.getSnapshot().error).toBeNull();
  await controller.performRootAction("copyPath");
  expect(controller.getSnapshot().actionMessage).toBe("フルパスをコピーしました");
  controller.stop();
});

test("empty root and stopped controllers do not dispatch; stale results cannot report another root", async () => {
  const empty = fixture(false);
  await empty.controller.start();
  await empty.controller.performRootAction("copyPath");
  expect(invoke).not.toHaveBeenCalled();
  empty.controller.stop();
  const { controller, select, snapshot } = fixture();
  await controller.start();
  let resolve!: () => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const action = controller.performRootAction("copyPath");
  select({ ...snapshot, workspaceId: "other", viewId: "other-view", rootPath: "/other" });
  await controller.choose();
  resolve();
  await action;
  expect(controller.getSnapshot().actionMessage).toBeNull();
  expect(controller.getSnapshot().actionBusy).toBe(false);
  controller.stop();
  await controller.performRootAction("openFolder");
  expect(invoke).toHaveBeenCalledTimes(1);
});
