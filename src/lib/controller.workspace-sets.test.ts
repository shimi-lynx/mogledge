import { describe, expect, it, vi } from "vite-plus/test";
import { KnowledgeController } from "./controller";
import type {
  Bridge,
  Change,
  ResolvedWorkspaceSet,
  Snapshot,
  WorkspaceSet,
  WorkspaceSets,
} from "./types";

const entry = (index: number, column: 0 | 1 = 0) => ({
  document: { relativePath: `${index}.html`, identity: String(index).padStart(64, "0") },
  column,
  zoom: 125,
});
const workingSet = (count = 30): WorkspaceSet => ({
  id: "a".repeat(64),
  name: "資料",
  items: Array.from({ length: count }, (_, index) => entry(index)),
  active: [0, null],
  activeColumn: 0,
});
function setup(set = workingSet()) {
  let snapshot: Snapshot = {
    workspaceId: "root",
    viewId: "view",
    rootPath: "/fixture",
    revision: 1,
    watchError: null,
    nodes: Array.from({ length: 31 }, (_, index) => ({
      relativePath: `${index}.html`,
      name: `${index}.html`,
      kind: "html" as const,
      children: [],
    })),
  };
  let listener: (change: Change) => void = () => {};
  let count = 0;
  const paths = new Map<string, string>();
  let sets: WorkspaceSets = {
    sets: [set],
    setShortcuts: [null, null, null, null, null, null, null, null, null, null],
    readOnly: false,
    error: null,
  };
  let resolved: ResolvedWorkspaceSet = {
    set,
    items: set.items.map((item) => ({ ...item, status: "available", reusableTabs: [] })),
  };
  const api: Bridge = {
    beginView: vi.fn(async () => snapshot),
    getTree: vi.fn(async () => snapshot),
    chooseRoot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    createTab: vi.fn(async (_root, _view, path) => {
      const id = `native-${++count}`;
      paths.set(id, path);
      return id;
    }),
    openDocument: vi.fn(async (_root, _view, id) => `http://fixture/s/${id}/${paths.get(id)}`),
    closeTab: vi.fn(async () => {}),
    listen: vi.fn(async (callback) => {
      listener = callback;
      return () => {};
    }),
    mutateTree: vi.fn(async () => ({ snapshot, moves: [], warning: null })),
    performFileAction: vi.fn(async () => {}),
    getWorkspaceSets: vi.fn(async () => sets),
    resolveWorkspaceSet: vi.fn(async () => resolved),
    captureWorkspaceSet: vi.fn(async () => sets),
    editWorkspaceSet: vi.fn(async () => sets),
    validateWorkspaceDocument: vi.fn(async (_root, _view, document) => document.relativePath),
  };
  return {
    api,
    controller: new KnowledgeController(api),
    resolve: (value: ResolvedWorkspaceSet) => {
      resolved = value;
    },
    resolved: () => resolved,
    update: (value: Partial<Snapshot>) => {
      snapshot = { ...snapshot, ...value };
    },
    sets: (value: WorkspaceSets) => {
      sets = value;
    },
    emit: (change: Change) => listener(change),
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("workspace sets and lazy tab lifecycle", () => {
  it("uses explicit shortcut IDs and ignores an unassigned slot without resolving or registering tabs", async () => {
    const fixture = setup(workingSet(1));
    await fixture.controller.start();
    await flush();
    expect(await fixture.controller.restoreWorkspaceSetShortcut(1)).toBe(false);
    expect(fixture.api.resolveWorkspaceSet).not.toHaveBeenCalled();
    expect(fixture.api.createTab).not.toHaveBeenCalled();
    fixture.sets({
      sets: [workingSet(1)],
      setShortcuts: [null, null, null, null, null, null, null, null, null, "a".repeat(64)],
      error: null,
      readOnly: false,
    });
    await fixture.controller.refreshWorkspaceSets();
    expect(await fixture.controller.restoreWorkspaceSetShortcut(10)).toBe(true);
    expect(fixture.api.resolveWorkspaceSet).toHaveBeenCalledExactlyOnceWith(
      "root",
      "view",
      "a".repeat(64),
      10,
    );
    fixture.controller.stop();
  });
  it("discards a pending shortcut restore after assignment changes and reports Native revalidation failure", async () => {
    const fixture = setup(workingSet(1));
    const { controller, api } = fixture;
    const assigned = {
      sets: [workingSet(1)],
      setShortcuts: [
        "a".repeat(64),
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ] as WorkspaceSets["setShortcuts"],
      error: null,
      readOnly: false,
    };
    fixture.sets(assigned);
    await controller.start();
    await flush();
    let respond!: (value: ResolvedWorkspaceSet) => void;
    api.resolveWorkspaceSet = vi.fn(
      () =>
        new Promise<ResolvedWorkspaceSet>((resolve) => {
          respond = resolve;
        }),
    );
    const restoring = controller.restoreWorkspaceSetShortcut(1);
    fixture.sets({
      ...assigned,
      setShortcuts: [null, null, null, null, null, null, null, null, null, null],
    });
    await controller.refreshWorkspaceSets();
    respond(fixture.resolved());
    expect(await restoring).toBe(false);
    expect(api.createTab).not.toHaveBeenCalled();
    fixture.sets(assigned);
    await controller.refreshWorkspaceSets();
    api.resolveWorkspaceSet = vi.fn(async () => {
      throw new Error("割当が変更されています");
    });
    expect(await controller.restoreWorkspaceSetShortcut(1)).toBe(false);
    expect(controller.getSnapshot().error).toContain("割当が変更されています");
    expect(api.createTab).not.toHaveBeenCalled();
    controller.stop();
  });
  it("assigns through the existing scoped action and retains the old snapshot after a failed write", async () => {
    const fixture = setup(workingSet(1));
    const { controller, api } = fixture;
    await controller.start();
    await flush();
    const before = controller.getSnapshot().workspaceSets;
    api.assignWorkspaceSetShortcut = vi.fn(async () => {
      throw new Error("write failed");
    });
    expect(await controller.assignWorkspaceSetShortcut("a".repeat(64), 10)).toBe(false);
    expect(controller.getSnapshot().workspaceSets).toBe(before);
    expect(controller.getSnapshot().actionBusy).toBe(false);
    api.assignWorkspaceSetShortcut = vi.fn(async (): Promise<WorkspaceSets> => ({
      ...before!,
      setShortcuts: [null, null, null, null, null, null, null, null, null, "a".repeat(64)],
    }));
    expect(await controller.assignWorkspaceSetShortcut("a".repeat(64), 10)).toBe(true);
    expect(api.assignWorkspaceSetShortcut).toHaveBeenCalledExactlyOnceWith(
      "root",
      "view",
      "a".repeat(64),
      10,
    );
    expect(controller.getSnapshot().workspaceSets?.setShortcuts[9]).toBe("a".repeat(64));
    controller.stop();
  });
  it("aborting an older sidebar selection cannot cancel a newer workspace-set restore", async () => {
    const { api, controller, resolved } = setup(workingSet(1));
    await controller.start();
    let folderResponse!: (value: string) => void;
    api.validateWorkspaceFolder = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          folderResponse = resolve;
        }),
    );
    const owned = new AbortController();
    const sidebarSelection = controller.selectWorkspaceFolder(
      { relativePath: "folder", identity: "f".repeat(64) },
      owned.signal,
    );
    let restoreResponse!: (value: ResolvedWorkspaceSet) => void;
    api.resolveWorkspaceSet = vi.fn(
      () =>
        new Promise<ResolvedWorkspaceSet>((resolve) => {
          restoreResponse = resolve;
        }),
    );
    const restore = controller.restoreWorkspaceSet("set");
    owned.abort();
    restoreResponse(resolved());
    expect(await restore).toBe(true);
    await flush();
    folderResponse("folder");
    expect(await sidebarSelection).toBeNull();
    expect(controller.getSnapshot().tabs.map((tab) => tab.path)).toEqual(["0.html"]);
    expect(api.createTab).toHaveBeenCalledExactlyOnceWith("root", "view", "0.html", "0".repeat(64));
    controller.stop();
  });
  it("closes right-side placeholders without loading doomed replacements or rewriting a saved set", async () => {
    const set = { ...workingSet(), active: [15, null] as [number, null] };
    const { api, controller } = setup(set);
    await controller.start();
    await controller.restoreWorkspaceSet("set");
    await flush();
    const before = structuredClone(controller.getSnapshot().workspaceSets);
    const anchor = controller.getSnapshot().tabs[2];
    await controller.closeTabsToRight(anchor.id);
    await flush();
    expect(controller.getSnapshot().tabs.map((tab) => tab.path)).toEqual([
      "0.html",
      "1.html",
      "2.html",
    ]);
    expect(controller.getSnapshot().columns).toEqual([anchor.id, null]);
    expect(controller.getSnapshot().tabs.filter((tab) => tab.deferred)).toHaveLength(2);
    expect(vi.mocked(api.createTab).mock.calls.map((call) => call[2])).toEqual([
      "15.html",
      "2.html",
    ]);
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    expect(api.closeTab).toHaveBeenCalledExactlyOnceWith("root", "view", "native-1");
    expect(controller.getSnapshot().closed).toHaveLength(10);
    expect(controller.getSnapshot().workspaceSets).toEqual(before);
    expect(api.captureWorkspaceSet).not.toHaveBeenCalled();
    expect(api.editWorkspaceSet).not.toHaveBeenCalled();
    const lastClosed = controller.getSnapshot().closed[0];
    await controller.reopen();
    expect(controller.getSnapshot().tabs.at(-1)?.path).toBe(lastClosed.path);
    expect(api.createTab).toHaveBeenCalledTimes(3);
    controller.stop();
  });

  it("prepares 30 items with only the active grant, admits a hidden item once and closes unregistered items locally", async () => {
    const { api, controller } = setup();
    await controller.start();
    expect(await controller.restoreWorkspaceSet("set")).toBe(true);
    await flush();
    expect(controller.getSnapshot().tabs).toHaveLength(30);
    expect(controller.getSnapshot().tabs.filter((tab) => tab.deferred)).toHaveLength(29);
    expect(api.createTab).toHaveBeenCalledTimes(1);
    expect(api.openDocument).toHaveBeenCalledTimes(1);
    const hidden = controller.getSnapshot().tabs[29];
    await controller.reload(hidden.id);
    expect(api.openDocument).toHaveBeenCalledTimes(1);
    controller.activate(hidden.id);
    controller.activate(hidden.id);
    await flush();
    expect(api.createTab).toHaveBeenCalledTimes(2);
    expect(api.createTab).toHaveBeenLastCalledWith(
      "root",
      "view",
      "29.html",
      entry(29).document.identity,
    );
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    await controller.closeTab(controller.getSnapshot().tabs[10].id);
    expect(api.closeTab).not.toHaveBeenCalled();
    controller.stop();
    await flush();
    expect(api.closeTab).toHaveBeenCalledTimes(2);
  });
  it("reuses live same-column views, retains current zoom and extra tabs without reread", async () => {
    const fixture = setup(workingSet(2));
    const { api, controller } = fixture;
    await controller.start();
    await controller.select("0.html");
    controller.zoomTab(controller.getSnapshot().tabs[0].id, "out");
    await controller.select("30.html");
    const original = controller.getSnapshot().tabs[0];
    fixture.resolve({
      ...fixture.resolved(),
      items: fixture
        .resolved()
        .items.map((item, index) => ({ ...item, reusableTabs: index === 0 ? ["native-1"] : [] })),
    });
    await controller.restoreWorkspaceSet("set");
    await flush();
    expect(controller.getSnapshot().tabs[0]).toBe(original);
    expect(controller.getSnapshot().tabs.map((tab) => tab.path)).toEqual([
      "0.html",
      "1.html",
      "30.html",
    ]);
    expect(controller.getSnapshot().tabs[0].zoom).toBe(75);
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    await controller.restoreWorkspaceSet("set");
    expect(controller.getSnapshot().tabs).toHaveLength(3);
    expect(api.createTab).toHaveBeenCalledTimes(2);
  });
  it("restores the same document independently in both columns with saved zoom and active order", async () => {
    const set = {
      ...workingSet(1),
      items: [entry(0), entry(1), entry(0, 1)],
      active: [1, 2] as [number, number],
      activeColumn: 1 as const,
    };
    const { api, controller } = setup(set);
    await controller.start();
    await controller.restoreWorkspaceSet("set");
    await flush();
    expect(api.createTab).toHaveBeenCalledTimes(2);
    expect(
      controller
        .getSnapshot()
        .columns.map((id) => controller.getSnapshot().tabs.find((tab) => tab.id === id)?.path),
    ).toEqual(["1.html", "0.html"]);
    expect(controller.getSnapshot().tabs.map((tab) => tab.zoom)).toEqual([125, 125, 125]);
    expect(controller.getSnapshot().activeColumn).toBe(1);
  });
  it("recovers a missing placeholder on repeated restore and retries read failure only on explicit restore", async () => {
    const fixture = setup(workingSet(2));
    const { controller, api } = fixture;
    fixture.resolve({
      ...fixture.resolved(),
      items: fixture.resolved().items.map((item) => ({ ...item, status: "missing" })),
    });
    await controller.start();
    await controller.restoreWorkspaceSet("set");
    const originalIds = controller.getSnapshot().tabs.map((tab) => tab.id);
    expect(api.createTab).not.toHaveBeenCalled();
    fixture.resolve({
      ...fixture.resolved(),
      items: fixture.resolved().items.map((item) => ({ ...item, status: "available" })),
    });
    api.openDocument = vi
      .fn()
      .mockRejectedValueOnce("read failed")
      .mockResolvedValue("http://fixture/s/native-1/0.html");
    await controller.restoreWorkspaceSet("set");
    await flush();
    expect(controller.getSnapshot().tabs.map((tab) => tab.id)).toEqual(originalIds);
    expect(controller.getSnapshot().tabs[0].error).toBe("read failed");
    await controller.restoreWorkspaceSet("set");
    await flush();
    expect(api.createTab).toHaveBeenCalledTimes(1);
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().tabs[0].error).toBeNull();
  });
  it("validates saved list references without a fake Native ID and rejects identity collisions", async () => {
    const { controller, api } = setup(workingSet(2));
    await controller.start();
    await controller.restoreWorkspaceSet("set");
    await flush();
    expect(await controller.selectWorkspaceDocument(entry(1).document)).toBe(true);
    await flush();
    expect(api.validateWorkspaceDocument).toHaveBeenLastCalledWith(
      "root",
      "view",
      entry(1).document,
      undefined,
    );
    expect(api.createTab).toHaveBeenCalledTimes(2);
    const other = setup(workingSet(2));
    await other.controller.start();
    await other.controller.restoreWorkspaceSet("set");
    await flush();
    expect(
      await other.controller.selectWorkspaceDocument({
        ...entry(1).document,
        identity: "f".repeat(64),
      }),
    ).toBe(false);
    expect(other.api.createTab).toHaveBeenCalledTimes(1);
  });
  it("records only restored visible live documents as user display success", async () => {
    const fixture = setup(workingSet(2));
    const { controller, api } = fixture;
    api.recordDocumentDisplay = vi.fn(async () => {});
    await controller.start();
    await controller.select("0.html");
    const a = controller.getSnapshot().tabs[0];
    controller.documentReady(a.id, a.url!);
    await flush();
    await controller.select("1.html");
    const b = controller.getSnapshot().tabs[1];
    controller.documentReady(b.id, b.url!);
    await flush();
    vi.mocked(api.recordDocumentDisplay).mockClear();
    fixture.resolve({
      ...fixture.resolved(),
      items: fixture
        .resolved()
        .items.map((item, index) => ({ ...item, reusableTabs: [`native-${index + 1}`] })),
    });
    await controller.restoreWorkspaceSet("set");
    await flush();
    expect(api.recordDocumentDisplay).toHaveBeenCalledTimes(1);
    expect(api.recordDocumentDisplay).toHaveBeenCalledWith("root", "view", "native-1", a.url);
  });
  it("captures hidden references and current live views without opening HTML", async () => {
    const { controller, api } = setup(workingSet(2));
    await controller.start();
    await controller.restoreWorkspaceSet("set");
    await flush();
    expect(await controller.saveWorkspaceSet("コピー")).toBe(true);
    expect(api.captureWorkspaceSet).toHaveBeenCalledWith(
      "root",
      "view",
      "コピー",
      [
        { tabId: "native-1", column: 0, zoom: 125 },
        { document: entry(1).document, column: 0, zoom: 125 },
      ],
      [0, null],
      0,
    );
    expect(api.openDocument).toHaveBeenCalledTimes(1);
  });
  it("discards restore completed after root switch, tree revision, dialog cancel or a newer selection", async () => {
    for (const action of ["root", "revision", "cancel", "select"] as const) {
      const fixture = setup();
      const { controller, api } = fixture;
      await controller.start();
      let finish!: (value: ResolvedWorkspaceSet) => void;
      api.resolveWorkspaceSet = vi.fn(
        () =>
          new Promise<ResolvedWorkspaceSet>((resolve) => {
            finish = resolve;
          }),
      );
      const restoring = controller.restoreWorkspaceSet("set");
      if (action === "root") {
        fixture.update({ workspaceId: "other", viewId: "other-view" });
        await controller.registerRoot();
      } else if (action === "revision") {
        fixture.emit({
          workspaceId: "root",
          revision: 2,
          changedPaths: ["1.html"],
          structureChanged: false,
          watchError: null,
        });
      } else if (action === "select") await controller.select("30.html");
      else controller.cancelWorkspaceSelection();
      finish(fixture.resolved());
      expect(await restoring).toBe(false);
      expect(controller.getSnapshot().tabs).toHaveLength(action === "select" ? 1 : 0);
    }
  });
  it("refuses loading restores and invalidates Native reuse hints if a live grant changes in flight", async () => {
    const fixture = setup(workingSet(1));
    const { controller, api } = fixture;
    await controller.start();
    let open!: (value: string) => void;
    api.openDocument = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          open = resolve;
        }),
    );
    const selected = controller.select("0.html");
    await flush();
    expect(await controller.restoreWorkspaceSet("set")).toBe(false);
    expect(api.resolveWorkspaceSet).not.toHaveBeenCalled();
    open("http://fixture/s/native-1/0.html");
    await selected;
    let resolve!: (value: ResolvedWorkspaceSet) => void;
    api.resolveWorkspaceSet = vi.fn(
      () =>
        new Promise<ResolvedWorkspaceSet>((finish) => {
          resolve = finish;
        }),
    );
    const restoring = controller.restoreWorkspaceSet("set");
    const reloading = controller.reload(controller.getSnapshot().tabs[0].id);
    await flush();
    resolve(fixture.resolved());
    expect(await restoring).toBe(false);
    open("http://fixture/s/new/0.html");
    await reloading;
    expect(controller.getSnapshot().tabs).toHaveLength(1);
    expect(api.createTab).toHaveBeenCalledTimes(1);
  });
  it("follows internal moves on a hidden placeholder without reading it", async () => {
    const fixture = setup(workingSet(2));
    const { controller, api } = fixture;
    await controller.start();
    await controller.restoreWorkspaceSet("set");
    await flush();
    fixture.update({
      revision: 2,
      pathMoves: [{ from: "1.html", to: "renamed.html", revision: 2 }],
      nodes: [
        { name: "0.html", relativePath: "0.html", kind: "html", children: [] },
        { name: "renamed.html", relativePath: "renamed.html", kind: "html", children: [] },
      ],
    });
    await controller.refresh();
    expect(api.openDocument).toHaveBeenCalledTimes(1);
    controller.activate(controller.getSnapshot().tabs[1].id);
    await flush();
    expect(api.createTab).toHaveBeenLastCalledWith(
      "root",
      "view",
      "renamed.html",
      entry(1).document.identity,
    );
    expect(api.openDocument).toHaveBeenCalledTimes(2);
  });
});
