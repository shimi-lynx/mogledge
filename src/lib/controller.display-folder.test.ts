import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { KnowledgeController } from "./controller";
import type { Bridge, Change, Snapshot, TabSession } from "./types";

const controllers: KnowledgeController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
});

function fixture() {
  let snapshot: Snapshot = {
    workspaceId: "registered-root",
    viewId: "view-one",
    rootPath: "/knowledge",
    revision: 1,
    displayRevision: 0,
    watchError: null,
    nodes: [
      {
        relativePath: "child",
        name: "child",
        kind: "folder",
        children: [
          { relativePath: "child/tool.html", name: "tool.html", kind: "html", children: [] },
        ],
      },
      { relativePath: "other.html", name: "other.html", kind: "html", children: [] },
    ],
  };
  let serial = 0;
  let saved: TabSession | null = null;
  let listener: (change: Change) => void = () => {};
  const paths = new Map<string, string>();
  const chooseDisplayFolder = vi.fn(async () => snapshot);
  const api: Bridge = {
    beginView: vi.fn(async () => snapshot),
    getTree: vi.fn(async () => snapshot),
    chooseRoot: vi.fn(async () => snapshot),
    chooseDisplayFolder,
    setDisplayFolder: vi.fn(async (_workspace, _view, relativePath) => {
      snapshot = {
        ...snapshot,
        displayFolder: relativePath ? { relativePath, identity: "f".repeat(64) } : undefined,
        displayRevision: (snapshot.displayRevision ?? 0) + 1,
      };
      return snapshot;
    }),
    refresh: vi.fn(async () => snapshot),
    createTab: vi.fn(async (_workspace, _view, path) => {
      const id = `native-${++serial}`;
      paths.set(id, path);
      return id;
    }),
    openDocument: vi.fn(
      async (_workspace, _view, tab, request) => `http://fixture/${paths.get(tab)}?r=${request}`,
    ),
    closeTab: vi.fn(async () => {}),
    listen: vi.fn(async (callback) => {
      listener = callback;
      return () => {};
    }),
    getTabSession: vi.fn(async () => saved),
    captureTabSession: vi.fn<NonNullable<Bridge["captureTabSession"]>>(
      async (_workspace, _view, items, active, activeColumn, split, help) => {
        saved = {
          items: items.map((item) => ({
            document: item.document ?? {
              relativePath: paths.get(item.tabId!)!,
              identity: "d".repeat(64),
            },
            column: item.column,
            zoom: item.zoom,
          })),
          active,
          activeColumn,
          split,
          help,
        };
      },
    ),
    validateWorkspaceDocument: vi.fn(async (_workspace, _view, document) => document.relativePath),
    mutateTree: vi.fn(async () => ({ snapshot, moves: [], warning: null })),
    performFileAction: vi.fn(async () => {}),
  };
  const controller = new KnowledgeController(api);
  controllers.push(controller);
  return {
    api,
    controller,
    update: (patch: Partial<Snapshot>) => {
      snapshot = { ...snapshot, ...patch };
    },
    emit: (change: Change) => listener(change),
  };
}

describe("registered root and display folder", () => {
  it("managed folder selection flushes the session and replaces the workspace through its controller boundary", async () => {
    const { api, controller, update } = fixture();
    await controller.start();
    await controller.select("child/tool.html");
    const before = controller.getSnapshot();
    api.selectManagedFolder = vi.fn(async () => {
      expect(api.captureTabSession).toHaveBeenCalled();
      update({ workspaceId: "other", viewId: "other-view", rootPath: "/other", nodes: [] });
      return api.getTree();
    });
    await controller.selectManagedFolder("other", "revision-one");
    expect(api.selectManagedFolder).toHaveBeenCalledWith("other", "revision-one");
    expect(controller.getSnapshot().snapshot.workspaceId).toBe("other");
    expect(controller.getSnapshot().tabs).not.toContainEqual(before.tabs[0]);
    expect(api.chooseRoot).not.toHaveBeenCalled();
  });

  it("managed folder selection failure remains observable to its dialog without changing the current root", async () => {
    const { api, controller } = fixture();
    await controller.start();
    const before = controller.getSnapshot().snapshot;
    api.selectManagedFolder = vi.fn(async () => {
      throw new Error("folder missing");
    });
    await expect(controller.selectManagedFolder("missing", "revision-one")).rejects.toThrow(
      "folder missing",
    );
    expect(controller.getSnapshot().snapshot).toBe(before);
  });

  it("managed folder unregistration flushes before mutation and reads a fresh view after removal", async () => {
    const { api, controller, update } = fixture();
    await controller.start();
    await controller.select("child/tool.html");
    api.unregisterManagedFolder = vi.fn(async () => {
      expect(api.captureTabSession).toHaveBeenCalled();
      update({ workspaceId: null, viewId: "empty-view", rootPath: null, nodes: [] });
      return { revision: "two", folders: [], selectedId: null };
    });
    const result = await controller.unregisterManagedFolder("current", "one");
    expect(api.unregisterManagedFolder).toHaveBeenCalledWith("current", "one");
    expect(api.beginView).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ revision: "two", folders: [], selectedId: null });
    expect(controller.getSnapshot().snapshot.workspaceId).toBeNull();
    expect(controller.getSnapshot().tabs).toEqual([]);
  });
  it("ordinary folder dialog preserves the registered root, active HTML and Native grants", async () => {
    const { api, controller } = fixture();
    await controller.start();
    await controller.select("child/tool.html");
    const before = controller.getSnapshot();
    await controller.choose();
    expect(api.chooseDisplayFolder).toHaveBeenCalledWith("registered-root", "view-one");
    expect(api.chooseRoot).not.toHaveBeenCalled();
    expect(controller.getSnapshot().snapshot.rootPath).toBe("/knowledge");
    expect(controller.getSnapshot().tabs).toEqual(before.tabs);
    expect(controller.getSnapshot().columns).toEqual(before.columns);
    expect(api.closeTab).not.toHaveBeenCalled();
    expect(api.createTab).toHaveBeenCalledTimes(1);
    expect(api.openDocument).toHaveBeenCalledTimes(1);
  });
  it("keeps parent-child-parent navigation and restart restoration relative to the registered root", async () => {
    const { api, controller } = fixture();
    await controller.start();
    await controller.select("child/tool.html");
    const tab = controller.getSnapshot().tabs[0];
    controller.documentReady(tab.id, tab.url!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const history = controller.getSnapshot().navigationHistory;
    expect(await controller.switchDisplayFolder("child")).toBe(true);
    expect(api.setDisplayFolder).toHaveBeenLastCalledWith(
      "registered-root",
      "view-one",
      "child",
      0,
    );
    expect(controller.getSnapshot().snapshot.displayFolder?.relativePath).toBe("child");
    expect(await controller.switchDisplayFolder("")).toBe(true);
    expect(api.setDisplayFolder).toHaveBeenLastCalledWith("registered-root", "view-one", "", 1);
    expect(controller.getSnapshot().snapshot.displayFolder).toBeUndefined();
    expect(controller.getSnapshot().tabs).toEqual([tab]);
    expect(controller.getSnapshot().navigationHistory).toEqual(history);
    expect(await controller.switchDisplayFolder("child")).toBe(true);
    expect(await controller.flushTabSession()).toBe(true);
    expect(api.captureTabSession).toHaveBeenLastCalledWith(
      "registered-root",
      "view-one",
      [{ tabId: "native-1", column: 0, zoom: 100 }],
      [0, null],
      0,
      false,
      null,
    );
    controller.stop();
    const restarted = new KnowledgeController(api);
    controllers.push(restarted);
    await restarted.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restarted.getSnapshot().snapshot.rootPath).toBe("/knowledge");
    expect(restarted.getSnapshot().snapshot.displayFolder?.relativePath).toBe("child");
    expect(restarted.getSnapshot().tabs[0].path).toBe("child/tool.html");
    expect(api.chooseRoot).not.toHaveBeenCalled();
    expect(api.createTab).toHaveBeenLastCalledWith(
      "registered-root",
      "view-one",
      "child/tool.html",
      "d".repeat(64),
    );
  });
  it("retains multiple live tabs for the same HTML across display changes", async () => {
    const { api, controller } = fixture();
    await controller.start();
    await controller.select("child/tool.html", 0);
    await controller.select("child/tool.html", 1);
    const before = controller.getSnapshot();
    expect(before.tabs).toHaveLength(2);
    expect(await controller.switchDisplayFolder("child")).toBe(true);
    expect(await controller.switchDisplayFolder("")).toBe(true);
    expect(controller.getSnapshot().tabs).toEqual(before.tabs);
    expect(controller.getSnapshot().columns).toEqual(before.columns);
    expect(api.createTab).toHaveBeenCalledTimes(2);
    expect(api.closeTab).not.toHaveBeenCalled();
  });
  it("an already admitted delayed document response keeps its original tab and root", async () => {
    const { api, controller } = fixture();
    await controller.start();
    let complete!: (url: string) => void;
    api.openDocument = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    const opening = controller.select("child/tool.html");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await controller.switchDisplayFolder("child")).toBe(true);
    complete("http://fixture/child/tool.html?original-grant");
    await opening;
    expect(controller.getSnapshot().tabs[0]).toMatchObject({
      path: "child/tool.html",
      url: "http://fixture/child/tool.html?original-grant",
      loading: false,
    });
    expect(api.createTab).toHaveBeenCalledTimes(1);
    expect(api.openDocument).toHaveBeenCalledWith("registered-root", "view-one", "native-1", 1);
    expect(api.closeTab).not.toHaveBeenCalled();
  });
  it("does not treat outside-scope errors, cancellation or malformed responses as registration", async () => {
    const { api, controller } = fixture();
    await controller.start();
    await controller.select("child/tool.html");
    const before = controller.getSnapshot();
    api.chooseDisplayFolder = vi.fn(async () => {
      throw new Error("DisplayFolderOutsideRegisteredRoot");
    });
    await controller.choose();
    expect(controller.getSnapshot().error).toContain("DisplayFolderOutsideRegisteredRoot");
    expect(controller.getSnapshot().snapshot).toEqual(before.snapshot);
    expect(controller.getSnapshot().tabs).toEqual(before.tabs);
    api.chooseDisplayFolder = vi.fn(async () => null);
    await controller.choose();
    api.chooseDisplayFolder = vi.fn(async () => ({
      ...before.snapshot,
      rootPath: "/parent",
      workspaceId: "other-root",
    }));
    await controller.choose();
    expect(controller.getSnapshot().error).toBe("DisplayFolderOutsideRegisteredRoot");
    expect(controller.getSnapshot().snapshot).toEqual(before.snapshot);
    expect(api.chooseRoot).not.toHaveBeenCalled();
    expect(api.closeTab).not.toHaveBeenCalled();
  });
  it("discards a late display response after explicit root management", async () => {
    const { api, controller, update } = fixture();
    await controller.start();
    let complete!: (snapshot: Snapshot) => void;
    api.chooseDisplayFolder = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          complete = resolve;
        }),
    );
    const before = controller.getSnapshot().snapshot;
    const choosing = controller.choose();
    update({ rootPath: "/replacement", workspaceId: "replacement-root", viewId: "view-two" });
    await controller.registerRoot();
    complete({
      ...before,
      displayRevision: 1,
      displayFolder: { relativePath: "child", identity: "f".repeat(64) },
    });
    await choosing;
    expect(controller.getSnapshot().snapshot.rootPath).toBe("/replacement");
    expect(controller.getSnapshot().snapshot.displayFolder).toBeUndefined();
    expect(controller.getSnapshot().actionBusy).toBe(false);
  });
  it("accepts display navigation without replacing a newer watcher revision", async () => {
    const { api, controller, emit } = fixture();
    await controller.start();
    let complete!: (snapshot: Snapshot) => void;
    api.chooseDisplayFolder = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          complete = resolve;
        }),
    );
    const before = controller.getSnapshot().snapshot;
    const choosing = controller.choose();
    emit({
      workspaceId: "registered-root",
      revision: 2,
      changedPaths: [],
      structureChanged: false,
      watchError: null,
    });
    complete({
      ...before,
      displayRevision: 1,
      displayFolder: { relativePath: "child", identity: "f".repeat(64) },
    });
    await choosing;
    expect(controller.getSnapshot().snapshot.displayFolder?.relativePath).toBe("child");
    expect(controller.getSnapshot().snapshot.revision).toBe(2);
    expect(controller.getSnapshot().snapshot.rootPath).toBe("/knowledge");
  });
  it("first registration is explicit and missing display IPC never falls back to a root change", async () => {
    const { api, controller, update } = fixture();
    update({ rootPath: null, workspaceId: null, nodes: [] });
    await controller.start();
    update({ rootPath: "/knowledge", workspaceId: "registered-root" });
    await controller.choose();
    expect(api.chooseRoot).toHaveBeenCalledTimes(1);
    api.chooseDisplayFolder = undefined;
    await controller.choose();
    expect(controller.getSnapshot().error).toBe("DisplayFolderSelectionUnavailable");
    expect(api.chooseRoot).toHaveBeenCalledTimes(1);
  });
  it("ordinary selection cannot replace a registered root awaiting startup recovery", async () => {
    const { api, controller, update } = fixture();
    update({
      rootPath: null,
      workspaceId: null,
      nodes: [],
      startupRecovery: { reason: "pathUnavailable", canRetry: true },
    });
    await controller.start();
    await controller.choose();
    expect(controller.getSnapshot().error).toBe("RegisteredRootRecoveryRequired");
    expect(api.chooseRoot).not.toHaveBeenCalled();
    await controller.registerRoot();
    expect(api.chooseRoot).toHaveBeenCalledTimes(1);
  });
  it("exposes held document storage outside the HTML without preventing browsing", async () => {
    const { api, controller, update } = fixture();
    update({ storageHold: { reason: "StorageIdentityConfirmationRequired" } });
    api.getDocumentStorageHold = vi.fn(async () => ({
      reason: "StorageIdentityConfirmationRequired",
    }));
    await controller.start();
    await controller.select("child/tool.html");
    const tab = controller.getSnapshot().tabs[0];
    expect(tab.url).toContain("child/tool.html");
    expect(tab.error).toBeNull();
    expect(tab.storageHold?.reason).toContain("StorageIdentityConfirmationRequired");
    expect(await controller.switchDisplayFolder("child")).toBe(true);
    expect(controller.getSnapshot().snapshot.storageHold?.reason).toBe(
      "StorageIdentityConfirmationRequired",
    );
    expect(controller.getSnapshot().tabs[0].storageHold).toEqual(tab.storageHold);
  });
  it("discards a delayed storage probe after reload has admitted a newer grant", async () => {
    const { api, controller } = fixture();
    let rejectOld!: (error: Error) => void;
    api.getDocumentStorageHold = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValue(null);
    await controller.start();
    await controller.select("child/tool.html");
    const id = controller.getSnapshot().tabs[0].id;
    await controller.reload(id);
    rejectOld(new Error("StorageIdentityConfirmationRequired"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getSnapshot().tabs[0].storageHold).toBeUndefined();
    expect(controller.getSnapshot().tabs[0].url).toContain("r=2");
    expect(api.getDocumentStorageHold).toHaveBeenCalledTimes(2);
  });
  it("does not restore a stale display selection after a structural fallback removed its folder", async () => {
    const { api, controller, update, emit } = fixture();
    await controller.start();
    let complete!: (snapshot: Snapshot) => void;
    api.chooseDisplayFolder = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          complete = resolve;
        }),
    );
    const before = controller.getSnapshot().snapshot;
    const choosing = controller.choose();
    update({ revision: 2, displayRevision: 2, displayFolder: undefined, nodes: [before.nodes[1]] });
    emit({
      workspaceId: "registered-root",
      revision: 2,
      changedPaths: [],
      structureChanged: true,
      watchError: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    complete({
      ...before,
      displayRevision: 1,
      displayFolder: { relativePath: "child", identity: "f".repeat(64) },
    });
    await choosing;
    expect(controller.getSnapshot().snapshot.displayFolder).toBeUndefined();
    expect(controller.getSnapshot().snapshot.displayRevision).toBe(2);
    expect(controller.getSnapshot().snapshot.nodes).toEqual([before.nodes[1]]);
  });
  it("does not let a pre-navigation same-revision tree read reset the newer display scope", async () => {
    const { api, controller, emit } = fixture();
    await controller.start();
    await controller.select("child/tool.html");
    const tabs = controller.getSnapshot().tabs;
    const old = controller.getSnapshot().snapshot;
    let complete!: (snapshot: Snapshot) => void;
    vi.mocked(api.getTree).mockImplementationOnce(
      () =>
        new Promise<Snapshot>((resolve) => {
          complete = resolve;
        }),
    );
    emit({
      workspaceId: "registered-root",
      revision: 2,
      changedPaths: [],
      structureChanged: true,
      watchError: null,
    });
    expect(await controller.switchDisplayFolder("child")).toBe(true);
    complete(old);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getSnapshot().snapshot.displayFolder?.relativePath).toBe("child");
    expect(controller.getSnapshot().snapshot.displayRevision).toBe(1);
    expect(controller.getSnapshot().tabs).toEqual(tabs);
    expect(api.openDocument).toHaveBeenCalledTimes(1);
  });
  it("keeps an admitted grant hold visible after the current database becomes confirmed", async () => {
    const { api, controller } = fixture();
    let databaseConfirmed = false;
    api.getDocumentStorageHold = vi.fn(async () => ({ reason: "StorageBusy" }));
    const currentDatabase = vi.fn(async () => {
      if (!databaseConfirmed) throw new Error("StorageIdentityConfirmationRequired");
      return null;
    });
    api.getDocumentStateRecovery = currentDatabase;
    await controller.start();
    await controller.select("child/tool.html");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getSnapshot().tabs[0].storageHold).toEqual({ reason: "StorageBusy" });
    expect(api.getDocumentStorageHold).toHaveBeenCalledWith(
      "registered-root",
      "view-one",
      "native-1",
      1,
    );
    expect(api.getDocumentStateRecovery).not.toHaveBeenCalled();
    databaseConfirmed = true;
    expect(await currentDatabase()).toBeNull();
    expect(await controller.switchDisplayFolder("child")).toBe(true);
    expect(controller.getSnapshot().tabs[0].storageHold).toEqual({ reason: "StorageBusy" });
  });
  it("surfaces a server-rejected stale display intent without changing admitted tabs", async () => {
    const { api, controller } = fixture();
    await controller.start();
    await controller.select("child/tool.html");
    const before = controller.getSnapshot();
    api.setDisplayFolder = vi.fn(async () => {
      throw new Error("DisplayFolderChanged");
    });
    expect(await controller.switchDisplayFolder("child")).toBe(false);
    expect(api.setDisplayFolder).toHaveBeenCalledWith("registered-root", "view-one", "child", 0);
    expect(controller.getSnapshot().error).toBe("DisplayFolderChanged");
    expect(controller.getSnapshot().snapshot).toEqual(before.snapshot);
    expect(controller.getSnapshot().tabs).toEqual(before.tabs);
    expect(api.closeTab).not.toHaveBeenCalled();
    expect(api.openDocument).toHaveBeenCalledTimes(1);
  });
});
