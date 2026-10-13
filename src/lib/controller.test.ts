import { describe, expect, it, vi } from "vite-plus/test";
import { KnowledgeController } from "./controller";
import type {
  Bridge,
  Change,
  DocumentLinkTarget,
  RecoveryCandidate,
  Snapshot,
  WorkspaceLists,
  WorkspaceDocument,
} from "./types";

const snapshot: Snapshot = {
  workspaceId: "one",
  viewId: "view-one",
  rootPath: "/knowledge",
  revision: 1,
  watchError: null,
  nodes: ["a.html", "b.html", "c.html"].map((name) => ({
    name,
    relativePath: name,
    kind: "html",
    children: [],
  })),
};
function setup() {
  let listener: (event: Change) => void = () => {};
  let current = structuredClone(snapshot);
  let count = 0;
  const paths = new Map<string, string>();
  const api: Bridge = {
    mutateTree: vi.fn(async () => ({
      snapshot: current,
      createdPath: null,
      moves: [],
      warning: null,
    })),
    performFileAction: vi.fn(async () => {}),
    beginView: vi.fn(async () => current),
    getTree: vi.fn(async () => current),
    chooseRoot: vi.fn(async () => current),
    refresh: vi.fn(async () => current),
    createTab: vi.fn(async (_workspace, _view, path) => {
      const id = `native-${++count}`;
      paths.set(id, path);
      return id;
    }),
    closeTab: vi.fn(async () => {}),
    openDocument: vi.fn(
      async (_workspace, _view, tab, request) =>
        `http://local/${paths.get(tab)}?request=${request}`,
    ),
    listen: vi.fn(async (callback) => {
      listener = callback;
      return vi.fn();
    }),
  };
  const controller = new KnowledgeController(api);
  return {
    api,
    controller,
    emit: (change: Change) => listener(change),
    update: (value: Snapshot) => {
      current = value;
    },
    moveNative: (from: string, to: string) => {
      for (const [id, path] of paths)
        paths.set(
          id,
          path === from ? to : path.startsWith(from + "/") ? to + path.slice(from.length) : path,
        );
    },
  };
}
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const change = (revision: number, paths: string[], structureChanged = false): Change => ({
  workspaceId: "one",
  revision,
  changedPaths: paths,
  structureChanged,
  watchError: null,
});

describe("root-local favorites and user display success", () => {
  const emptyLists: WorkspaceLists = { favorites: [], recent: [], error: null, readOnly: false };
  const entry = { relativePath: "a.html", identity: "a".repeat(64), status: "available" as const };
  it("keeps write success and failure authoritative over overlapping list reads", async () => {
    const { api, controller } = setup();
    api.getWorkspaceLists = vi.fn(async () => ({ ...emptyLists, favorites: [entry] }));
    await controller.start();
    await flush();
    let read!: (value: typeof emptyLists) => void;
    api.getWorkspaceLists = vi.fn(
      () =>
        new Promise<WorkspaceLists>((resolve) => {
          read = resolve;
        }),
    );
    const staleRead = controller.refreshWorkspaceLists();
    await flush();
    let write!: (value: typeof emptyLists) => void;
    api.setDocumentFavorite = vi.fn(
      () =>
        new Promise<WorkspaceLists>((resolve) => {
          write = resolve;
        }),
    );
    const saving = controller.setFavorite("a.html", false);
    await controller.refreshWorkspaceLists();
    expect(api.getWorkspaceLists).toHaveBeenCalledTimes(1);
    read({ ...emptyLists, error: "stale read" });
    await staleRead;
    write(emptyLists);
    await saving;
    expect(controller.getSnapshot().workspaceLists).toEqual(emptyLists);
    api.setDocumentFavorite = vi.fn(async () => {
      await flush();
      throw new Error("write failed");
    });
    const failed = controller.setFavorite("a.html", true);
    await controller.refreshWorkspaceLists();
    await failed;
    expect(controller.getSnapshot().error).toContain("write failed");
    expect(controller.getSnapshot().actionBusy).toBe(false);
  });
  it("retries a stale initial read cheaply and coalesces concurrent metadata scans", async () => {
    const { api, controller, emit } = setup();
    const responses: ((value: WorkspaceLists) => void)[] = [];
    api.getWorkspaceLists = vi.fn(
      () => new Promise<WorkspaceLists>((resolve) => responses.push(resolve)),
    );
    await controller.start();
    await flush();
    expect(api.getWorkspaceLists).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().workspaceLists).toBeUndefined();
    emit(change(2, ["a.html"]));
    responses[0]({ ...emptyLists, error: "old revision" });
    await flush();
    expect(api.getWorkspaceLists).toHaveBeenCalledTimes(2);
    expect(api.getWorkspaceLists).toHaveBeenLastCalledWith("one", "view-one", false);
    responses[1](emptyLists);
    await flush();
    expect(controller.getSnapshot().workspaceLists).toEqual(emptyLists);
    const scans = [controller.refreshWorkspaceLists(true)];
    await flush();
    scans.push(controller.refreshWorkspaceLists(true), controller.refreshWorkspaceLists(true));
    expect(api.getWorkspaceLists).toHaveBeenCalledTimes(3);
    responses[2](emptyLists);
    await flush();
    expect(api.getWorkspaceLists).toHaveBeenCalledTimes(4);
    responses[3](emptyLists);
    await Promise.all(scans);
    expect(api.getWorkspaceLists).toHaveBeenCalledTimes(4);
    controller.stop();
  });
  it("only commits the latest list intent and cancellation, and forwards saved identity to Native admission", async () => {
    const { api, controller } = setup();
    const responses = new Map<string, (value: string) => void>();
    api.validateWorkspaceDocument = vi.fn(
      (_workspace: string, _view: string, document: WorkspaceDocument) =>
        new Promise<string>((resolve) => {
          responses.set(document.relativePath, resolve);
        }),
    );
    await controller.start();
    const first = controller.selectWorkspaceDocument(entry);
    const second = controller.selectWorkspaceDocument({
      relativePath: "b.html",
      identity: "b".repeat(64),
    });
    responses.get("b.html")!("b.html");
    expect(await second).toBe(true);
    responses.get("a.html")!("a.html");
    expect(await first).toBe(false);
    await flush();
    expect(api.createTab).toHaveBeenCalledWith("one", "view-one", "b.html", "b".repeat(64));
    const cancelled = controller.selectWorkspaceDocument(entry);
    controller.cancelWorkspaceSelection();
    responses.get("a.html")!("a.html");
    expect(await cancelled).toBe(false);
    expect(api.createTab).toHaveBeenCalledTimes(1);
  });
  it("waits for current ready and excludes background reload and stale notifications", async () => {
    const { api, controller } = setup();
    api.getWorkspaceLists = vi.fn(async () => emptyLists);
    api.recordDocumentDisplay = vi.fn(async () => {});
    await controller.start();
    await controller.select("a.html");
    const first = controller.getSnapshot().tabs[0];
    expect(api.recordDocumentDisplay).not.toHaveBeenCalled();
    controller.documentReady(first.id, "stale-url");
    await flush();
    expect(api.recordDocumentDisplay).not.toHaveBeenCalled();
    controller.documentReady(first.id, first.url!);
    await flush();
    expect(api.recordDocumentDisplay).toHaveBeenCalledTimes(1);
    await controller.reload(first.id);
    controller.documentReady(first.id, first.url!);
    await flush();
    controller.documentReady(first.id, controller.getSnapshot().tabs[0].url!);
    await flush();
    expect(api.recordDocumentDisplay).toHaveBeenCalledTimes(1);
    controller.activate(first.id);
    await flush();
    expect(api.recordDocumentDisplay).toHaveBeenCalledTimes(2);
    controller.stop();
    controller.documentReady(first.id, first.url!);
    await flush();
    expect(api.recordDocumentDisplay).toHaveBeenCalledTimes(2);
  });
  it("records a hidden pending document only when the user returns to its ready frame", async () => {
    const { api, controller } = setup();
    api.recordDocumentDisplay = vi.fn(async () => {});
    await controller.start();
    await controller.select("a.html");
    await controller.select("b.html");
    const [first, second] = controller.getSnapshot().tabs;
    controller.documentReady(first.id, first.url!);
    await flush();
    expect(api.recordDocumentDisplay).not.toHaveBeenCalled();
    controller.documentReady(second.id, second.url!);
    await flush();
    expect(api.recordDocumentDisplay).toHaveBeenCalledTimes(1);
    controller.activate(first.id);
    await flush();
    expect(api.recordDocumentDisplay).toHaveBeenLastCalledWith(
      "one",
      "view-one",
      "native-1",
      first.url,
    );
    expect(api.openDocument).toHaveBeenCalledTimes(2);
  });
  it("rejects old root list responses and list selections after the snapshot changes", async () => {
    const { api, controller, update } = setup();
    let respond!: (lists: typeof emptyLists) => void;
    api.getWorkspaceLists = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceLists>((resolve) => {
            respond = resolve;
          }),
      )
      .mockResolvedValue(emptyLists);
    api.validateWorkspaceDocument = vi.fn(async () => "a.html");
    await controller.start();
    update({ ...snapshot, workspaceId: "two", viewId: "view-two" });
    await controller.choose();
    await flush();
    respond({ ...emptyLists, error: "old root" });
    await flush();
    expect(controller.getSnapshot().workspaceLists?.error).toBeNull();
    let validate!: (path: string) => void;
    api.validateWorkspaceDocument = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          validate = resolve;
        }),
    );
    const selected = controller.selectWorkspaceDocument(entry);
    update({ ...controller.getSnapshot().snapshot, revision: 2 });
    await controller.refresh();
    validate("a.html");
    expect(await selected).toBe(false);
    expect(api.createTab).not.toHaveBeenCalled();
  });
  it("uses the snapshot open path to reuse a live tab and preserves favorites on write failure", async () => {
    const { api, controller } = setup();
    api.getWorkspaceLists = vi.fn(async () => ({ ...emptyLists, favorites: [entry] }));
    api.validateWorkspaceDocument = vi.fn(async () => "a.html");
    api.setDocumentFavorite = vi.fn(async () => {
      throw new Error("write failed");
    });
    await controller.start();
    await flush();
    await controller.select("a.html");
    const previous = controller.getSnapshot().tabs[0];
    expect(await controller.selectWorkspaceDocument(entry)).toBe(true);
    expect(controller.getSnapshot().tabs[0]).toEqual(previous);
    expect(api.createTab).toHaveBeenCalledTimes(1);
    expect(api.openDocument).toHaveBeenCalledTimes(1);
    await controller.setFavorite("a.html", false);
    expect(controller.getSnapshot().workspaceLists?.favorites).toEqual([entry]);
    expect(controller.getSnapshot().actionBusy).toBe(false);
    expect(controller.getSnapshot().error).toContain("write failed");
  });
});

describe("independent document views and column layout", () => {
  it("revalidates snapshot selections and reuses only the active column's live view", async () => {
    const { api, controller, update } = setup();
    const selection = {
      relativePath: "a.html",
      workspaceId: "one",
      viewId: "view-one",
      revision: 1,
    };
    expect(controller.selectFromSnapshot(selection)).toBe(false);
    await controller.start();
    await controller.select("a.html");
    await controller.select("b.html");
    const original = controller.getSnapshot().tabs[0];
    controller.zoomTab(original.id, "in");
    expect(controller.selectFromSnapshot(selection)).toBe(true);
    expect(controller.getSnapshot().tabs[0]).toMatchObject({
      id: original.id,
      url: original.url,
      zoom: 125,
    });
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    await controller.openInColumn("b.html", 1);
    expect(controller.selectFromSnapshot(selection)).toBe(true);
    await flush();
    expect(controller.getSnapshot().tabs.filter((tab) => tab.path === "a.html")).toHaveLength(2);
    expect(controller.getSnapshot().activeColumn).toBe(1);
    for (const patch of [
      { workspaceId: "other" },
      { viewId: "old-view" },
      { revision: 0 },
      { relativePath: "gone.html" },
    ])
      expect(controller.selectFromSnapshot({ ...selection, ...patch })).toBe(false);
    update({
      ...snapshot,
      revision: 2,
      nodes: snapshot.nodes.filter((node) => node.name !== "a.html"),
    });
    await controller.refresh();
    expect(controller.selectFromSnapshot(selection)).toBe(false);
    expect(controller.selectFromSnapshot({ ...selection, revision: 2 })).toBe(false);
    controller.stop();
    expect(controller.selectFromSnapshot(selection)).toBe(false);
  });
  it("ignores late open success after a root change and opens around a pending-close view", async () => {
    const { api, controller, update } = setup();
    await controller.start();
    await controller.select("a.html");
    let release!: () => void;
    vi.mocked(api.closeTab).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const closing = controller.closeTab(controller.getSnapshot().tabs[0].id);
    const selection = {
      relativePath: "a.html",
      workspaceId: "one",
      viewId: "view-one",
      revision: 1,
    };
    expect(controller.selectFromSnapshot(selection)).toBe(true);
    await flush();
    expect(controller.getSnapshot().tabs).toHaveLength(2);
    expect(
      controller.getSnapshot().tabs.find((tab) => tab.id === controller.getSnapshot().columns[0])
        ?.closing,
    ).toBe(false);
    release();
    await closing;
    let resolveOpen!: (url: string) => void;
    vi.mocked(api.openDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );
    expect(controller.selectFromSnapshot({ ...selection, relativePath: "c.html" })).toBe(true);
    await flush();
    update({ ...snapshot, workspaceId: "new-root", viewId: "new-view" });
    await controller.choose();
    resolveOpen("http://local/old-root/c.html");
    await flush();
    expect(controller.getSnapshot().tabs).toHaveLength(0);
    expect(controller.getSnapshot().documentUrl).toBeNull();
    controller.stop();
  });
  it("keeps continuous pinch local and follows it with fixed key/menu steps", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.openInColumn("a.html", 1);
    const [left, right] = controller.getSnapshot().tabs;
    controller.zoomTab(right.id, { factor: 1.137, x: 0.3, y: 0.7 });
    expect(controller.getSnapshot().tabs[0].zoom ?? 100).toBe(100);
    expect(controller.getSnapshot().tabs[1]).toMatchObject({
      zoom: 113.7,
      zoomAnchor: { x: 0.3, y: 0.7 },
      url: right.url,
    });
    controller.zoomTab(right.id, "in");
    expect(controller.getSnapshot().tabs[1].zoom).toBe(125);
    expect(controller.getSnapshot().tabs[1].zoomAnchor).toBeUndefined();
    controller.zoomTab(right.id, { factor: 0.91, x: 0.3, y: 0.7 });
    controller.zoomTab(right.id, "out");
    expect(controller.getSnapshot().tabs[1].zoom).toBe(100);
    const request = controller.getSnapshot().tabs[1].zoomRequest!;
    controller.zoomTab(right.id, "reset");
    expect(controller.getSnapshot().tabs[1].zoomRequest).toBe(request + 1);
    for (const factor of [NaN, Infinity, 0, -1, 11])
      controller.zoomTab(left.id, { factor, x: 0.5, y: 0.5 });
    controller.zoomTab(left.id, { factor: 2, x: -1, y: 0.5 });
    expect(controller.getSnapshot().tabs[0].zoom ?? 100).toBe(100);
    controller.zoomTab(right.id, { factor: 10, x: 0.5, y: 0.5 });
    expect(controller.getSnapshot().tabs[1].zoom).toBe(200);
    controller.zoomTab(right.id, { factor: 0.1, x: 0.5, y: 0.5 });
    expect(controller.getSnapshot().tabs[1].zoom).toBe(50);
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    expect(api.createTab).toHaveBeenCalledTimes(2);
    controller.stop();
  });
  it("keeps zoom per live view across reload and moves, without Native work or reopened-view inheritance", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.openInColumn("a.html", 1);
    const [left, right] = controller.getSnapshot().tabs;
    const before = controller.getSnapshot();
    for (let i = 0; i < 6; i++) controller.zoomTab(left.id, "in");
    expect(controller.getSnapshot().tabs.map((tab) => tab.zoom ?? 100)).toEqual([200, 100]);
    expect(controller.getSnapshot().columns).toEqual(before.columns);
    expect(controller.getSnapshot().activeColumn).toBe(before.activeColumn);
    expect(controller.getSnapshot().tabs.map((tab) => tab.url)).toEqual([left.url, right.url]);
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    expect(api.createTab).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 8; i++) controller.zoomTab(left.id, "out");
    expect(controller.getSnapshot().tabs[0].zoom).toBe(50);
    controller.zoomTab(left.id, "reset");
    controller.zoomTab(left.id, "in");
    await controller.reload(left.id);
    controller.moveTab(left.id, 1);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === left.id)?.zoom).toBe(125);
    controller.zoomTab(right.id, "in");
    await controller.closeTab(left.id);
    await controller.closeTab(right.id);
    await controller.reopen();
    const reopened = controller.getSnapshot().tabs[0];
    expect(reopened).toBeDefined();
    expect([left.id, right.id]).not.toContain(reopened.id);
    expect(reopened.zoom ?? 100).toBe(100);
    controller.stop();
  });
  it("reuses the source column's existing link target and preserves its URL", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.select("b.html");
    const [a, b] = controller.getSnapshot().tabs;
    controller.activate(a.id);
    api.resolveDocumentLink = vi.fn(async (): Promise<DocumentLinkTarget> => ({
      kind: "document",
      relativePath: "b.html",
      fragment: "#section",
    }));
    const target = await controller.resolveDocumentLink(
      a.id,
      a.url!,
      "http://local/b.html#section",
    );
    expect(target?.kind).toBe("document");
    await controller.followDocumentLink(a.id, a.url!, {
      kind: "document",
      relativePath: "b.html",
      fragment: "#section",
    });
    expect(controller.getSnapshot().columns[0]).toBe(b.id);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === b.id)).toMatchObject({
      url: b.url,
      navigation: { fragment: "#section", request: 1 },
    });
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    expect(api.createTab).toHaveBeenCalledTimes(2);
    controller.stop();
  });
  it("drops stale link resolution and never dispatches from resolution alone", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    const a = controller.getSnapshot().tabs[0];
    let finish!: (target: { kind: "external"; url: string }) => void;
    api.resolveDocumentLink = vi.fn(
      () =>
        new Promise<DocumentLinkTarget>((resolve) => {
          finish = resolve;
        }),
    );
    api.openExternalDocumentLink = vi.fn(async () => {});
    const pending = controller.resolveDocumentLink(a.id, a.url!, "https://example.com/");
    await controller.reload(a.id);
    finish({ kind: "external", url: "https://example.com/" });
    expect(await pending).toBeNull();
    expect(api.openExternalDocumentLink).not.toHaveBeenCalled();
    expect(await controller.openExternalDocumentLink(a.id, a.url!, "https://example.com/")).toBe(
      false,
    );
    expect(api.openExternalDocumentLink).not.toHaveBeenCalled();
    controller.stop();
  });
  it("reuses a path within each column and independently reloads and closes the same HTML", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.openInColumn("a.html", 1);
    const [left, right] = controller.getSnapshot().tabs;
    expect(left.id).not.toBe(right.id);
    expect(controller.getSnapshot().columns).toEqual([left.id, right.id]);
    await controller.select("a.html", 0);
    await controller.select("a.html", 1);
    expect(api.createTab).toHaveBeenCalledTimes(2);
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    await controller.reload(left.id);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === right.id)?.url).toBe(right.url);
    expect(api.openDocument).toHaveBeenLastCalledWith("one", "view-one", "native-1", 2);
    await controller.closeTab(left.id);
    expect(api.closeTab).toHaveBeenCalledWith("one", "view-one", "native-1");
    expect(controller.getSnapshot()).toMatchObject({
      split: false,
      columns: [right.id, null],
      activeColumn: 0,
      closed: [{ path: "a.html", column: 0 }],
      tabs: [{ id: right.id, column: 0, url: right.url }],
    });
    await controller.reopen();
    expect(controller.getSnapshot().split).toBe(true);
    expect(controller.getSnapshot().columns[1]).toBe(right.id);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === right.id)?.url).toBe(right.url);
    expect(api.createTab).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot().closed).toEqual([]);
  });

  it("keeps delayed registrations and reload responses scoped to each same-path view", async () => {
    const { api, controller } = setup();
    await controller.start();
    let register!: (id: string) => void;
    vi.mocked(api.createTab).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          register = resolve;
        }),
    );
    const first = controller.select("a.html", 0);
    const left = controller.getSnapshot().tabs[0];
    await controller.select("a.html", 0);
    await controller.select("a.html", 1);
    const right = controller.getSnapshot().tabs[1];
    const closing = controller.closeTab(left.id);
    register("delayed-left");
    await Promise.all([first, closing]);
    expect(api.createTab).toHaveBeenCalledTimes(2);
    expect(api.openDocument).toHaveBeenCalledTimes(1);
    expect(api.closeTab).toHaveBeenCalledWith("one", "view-one", "delayed-left");
    expect(controller.getSnapshot().tabs).toMatchObject([{ id: right.id, url: right.url }]);
  });

  it("reloads both visible copies for HTML saves and preserves hidden dirty copies", async () => {
    const { api, controller, emit } = setup();
    await controller.start();
    await controller.select("a.html", 0);
    await controller.select("a.html", 1);
    const [left, right] = controller.getSnapshot().tabs;
    emit(change(2, ["a.html"]));
    await flush();
    expect(api.openDocument).toHaveBeenCalledTimes(4);
    await controller.select("b.html", 1);
    const savedRight = controller.getSnapshot().tabs.find((tab) => tab.id === right.id)!.url;
    emit(change(3, ["a.html"]));
    await flush();
    controller.activate(right.id);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === right.id)).toMatchObject({
      dirty: true,
      url: savedRight,
    });
    expect(api.openDocument).toHaveBeenCalledTimes(6);
    expect(controller.getSnapshot().columns[0]).toBe(left.id);
  });

  it("moves a view before and after anchors without moving or closing the target view", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html", 0);
    await controller.select("b.html", 0);
    await controller.select("c.html", 1);
    const [a, b, c] = controller.getSnapshot().tabs;
    controller.moveTab(a.id, 1, c.id);
    expect(controller.getSnapshot().tabs.map((tab) => tab.id)).toEqual([b.id, a.id, c.id]);
    expect(controller.getSnapshot().columns).toEqual([b.id, a.id]);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === c.id)).toEqual(c);
    controller.moveTab(a.id, 1, c.id, true);
    expect(controller.getSnapshot().tabs.map((tab) => tab.id)).toEqual([b.id, c.id, a.id]);
    controller.moveTab(a.id, 0, b.id, true);
    expect(controller.getSnapshot().columns).toEqual([a.id, c.id]);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === a.id)?.url).toBe(a.url);
    expect(api.createTab).toHaveBeenCalledTimes(3);
    expect(api.openDocument).toHaveBeenCalledTimes(3);
    expect(api.closeTab).not.toHaveBeenCalled();
  });

  it("retains colliding same-path views on move and reuses the selected copy", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html", 0);
    await controller.select("b.html", 0);
    await controller.select("a.html", 1);
    const [left, b, right] = controller.getSnapshot().tabs;
    controller.moveTab(left.id, 1, right.id, true);
    expect(controller.getSnapshot().columns).toEqual([b.id, left.id]);
    expect(controller.getSnapshot().tabs.filter((tab) => tab.path === "a.html")).toHaveLength(2);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === right.id)).toEqual(right);
    await controller.select("a.html", 1);
    expect(controller.getSnapshot().columns[1]).toBe(left.id);
    expect(api.createTab).toHaveBeenCalledTimes(3);
    expect(api.closeTab).not.toHaveBeenCalled();
    await controller.closeTab(left.id);
    expect(controller.getSnapshot().columns).toEqual([b.id, right.id]);
    expect(controller.getSnapshot().split).toBe(true);
  });

  it("collapses a emptied source column after moving its last view without changing URLs", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html", 0);
    await controller.select("b.html", 1);
    const [a, b] = controller.getSnapshot().tabs;
    controller.moveTab(a.id, 1);
    expect(controller.getSnapshot()).toMatchObject({
      split: false,
      columns: [a.id, null],
      activeColumn: 0,
    });
    expect(controller.getSnapshot().tabs.map((tab) => tab.column)).toEqual([0, 0]);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === b.id)?.url).toBe(b.url);
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    expect(api.closeTab).not.toHaveBeenCalled();
  });

  it("keeps a column that owns loading, error or missing tabs", async () => {
    for (const status of ["loading", "error", "missing"] as const) {
      const { api, controller, update } = setup();
      await controller.start();
      let register!: (id: string) => void;
      if (status === "loading")
        vi.mocked(api.createTab).mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              register = resolve;
            }),
        );
      if (status === "error") vi.mocked(api.createTab).mockRejectedValueOnce("read failed");
      const opening = controller.select("a.html", 0);
      if (status !== "loading") await opening;
      await controller.select("b.html", 0);
      await controller.select("c.html", 1);
      const [a, b, c] = controller.getSnapshot().tabs;
      if (status === "missing") {
        update({ ...snapshot, revision: 2, nodes: snapshot.nodes.slice(1) });
        await controller.refresh();
      }
      await controller.closeTab(b.id);
      expect(controller.getSnapshot().split).toBe(true);
      expect(controller.getSnapshot().columns).toEqual([a.id, c.id]);
      expect(controller.getSnapshot().tabs[0][status === "error" ? "error" : status]).toBeTruthy();
      if (status === "loading") {
        register("loading-a");
        await opening;
      }
      controller.stop();
    }
  });

  it("keeps the split layout and history unchanged while close waits or fails", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html", 0);
    await controller.select("b.html", 1);
    const [left, right] = controller.getSnapshot().tabs;
    let rejectClose!: (error: string) => void;
    vi.mocked(api.closeTab).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectClose = reject;
        }),
    );
    const closing = controller.closeTab(left.id);
    await flush();
    controller.moveTab(left.id, 1);
    expect(controller.getSnapshot().columns).toEqual([left.id, right.id]);
    expect(controller.getSnapshot().split).toBe(true);
    rejectClose("close failed");
    await closing;
    expect(controller.getSnapshot().split).toBe(true);
    expect(controller.getSnapshot().closed).toEqual([]);
    await controller.closeTab(left.id);
    expect(controller.getSnapshot().columns).toEqual([right.id, null]);
    expect(controller.getSnapshot().split).toBe(false);
  });

  it("restores a closed right column and preserves every surviving left view", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html", 0);
    await controller.select("b.html", 0);
    await controller.select("c.html", 1);
    const [a, b, c] = controller.getSnapshot().tabs;
    await controller.closeTab(c.id);
    expect(controller.getSnapshot().split).toBe(false);
    await controller.reopen();
    expect(controller.getSnapshot().split).toBe(true);
    expect(controller.getSnapshot().columns[0]).toBe(b.id);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === a.id)).toEqual(a);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === b.id)).toEqual(b);
    expect(api.openDocument).toHaveBeenCalledTimes(4);
  });
});

describe("closed view history", () => {
  it("retains at most ten closed views, including repeated closes of the same path", async () => {
    const { api, controller } = setup();
    await controller.start();
    for (let count = 0; count < 12; count++) {
      await controller.select("a.html");
      await controller.closeTab(controller.getSnapshot().tabs[0].id);
    }
    expect(controller.getSnapshot().closed).toEqual(
      Array.from({ length: 10 }, () => ({ path: "a.html", column: 0 })),
    );
    await controller.reopen();
    expect(controller.getSnapshot().closed).toHaveLength(9);
    await controller.reopen();
    expect(controller.getSnapshot().closed).toHaveLength(8);
    expect(controller.getSnapshot().tabs).toHaveLength(1);
    expect(api.createTab).toHaveBeenCalledTimes(13);
  });

  it("consumes missing entries before reopening the newest valid path and clears on root change", async () => {
    const { api, controller, update } = setup();
    await controller.start();
    for (const path of ["a.html", "b.html"]) {
      await controller.select(path);
      await controller.closeTab(controller.getSnapshot().tabs[0].id);
    }
    update({ ...snapshot, revision: 2, nodes: [snapshot.nodes[0], snapshot.nodes[2]] });
    await controller.refresh();
    await controller.reopen();
    expect(controller.getSnapshot().selectedPath).toBe("a.html");
    expect(controller.getSnapshot().closed).toEqual([]);
    expect(api.createTab).toHaveBeenCalledTimes(3);
    await controller.closeTab(controller.getSnapshot().tabs[0].id);
    update({ ...snapshot, workspaceId: "two", viewId: "view-two" });
    await controller.choose();
    expect(controller.getSnapshot().closed).toEqual([]);
    await controller.reopen();
    expect(controller.getSnapshot().tabs).toEqual([]);
  });

  it("records both same-path closes with their original columns during concurrent collapse", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html", 0);
    await controller.select("a.html", 1);
    const [left, right] = controller.getSnapshot().tabs;
    let finishRight!: () => void;
    vi.mocked(api.closeTab)
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRight = resolve;
          }),
      );
    const closingLeft = controller.closeTab(left.id);
    const closingRight = controller.closeTab(right.id);
    await closingLeft;
    finishRight();
    await closingRight;
    expect(controller.getSnapshot().closed).toEqual([
      { path: "a.html", column: 1 },
      { path: "a.html", column: 0 },
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      split: false,
      columns: [null, null],
      activeColumn: 0,
    });
  });

  it("follows HTML rename results for a retained view and its closed-copy history", async () => {
    const { api, controller, moveNative } = setup();
    await controller.start();
    await controller.select("a.html", 0);
    await controller.select("a.html", 1);
    const [left, right] = controller.getSnapshot().tabs;
    await controller.closeTab(left.id);
    const move = { from: "a.html", to: "renamed.html", revision: 2 };
    moveNative(move.from, move.to);
    vi.mocked(api.mutateTree).mockResolvedValueOnce({
      snapshot: {
        ...snapshot,
        revision: 2,
        pathMoves: [move],
        nodes: snapshot.nodes.map((node) =>
          node.relativePath === move.from
            ? { ...node, relativePath: move.to, name: move.to }
            : node,
        ),
      },
      createdPath: null,
      moves: [move],
      warning: null,
    });
    await controller.mutateTree({ kind: "renameHtml", source: move.from, name: move.to });
    expect(controller.getSnapshot().tabs[0]).toMatchObject({ id: right.id, path: move.to });
    expect(controller.getSnapshot().documentUrl).toContain(move.to);
    expect(controller.getSnapshot().closed).toEqual([{ path: move.to, column: 0 }]);
    expect(controller.getSnapshot().actionMessage).toContain("名前を変更しました");
    await controller.reopen();
    expect(controller.getSnapshot().columns[1]).toBe(right.id);
    expect(controller.getSnapshot().tabs.map((tab) => tab.path)).toEqual([move.to, move.to]);
  });
});

describe("retained document tabs", () => {
  it("closes only tabs after the context anchor in its own column and reopens through existing history", async () => {
    const { api, controller } = setup();
    await controller.start();
    for (const path of ["a.html", "b.html", "c.html"]) {
      await controller.select(path, 0);
      await controller.select(path, 1);
    }
    const [leftA, rightA, leftB, rightB, leftC, rightC] = controller.getSnapshot().tabs;
    const history = structuredClone(controller.getSnapshot().navigationHistory);
    await controller.closeTabsToRight(leftB.id);
    expect(controller.getSnapshot().tabs.map((tab) => tab.id)).toEqual([
      leftA.id,
      rightA.id,
      leftB.id,
      rightB.id,
      rightC.id,
    ]);
    expect(controller.getSnapshot().columns).toEqual([leftB.id, rightC.id]);
    expect(controller.getSnapshot().activeColumn).toBe(1);
    expect(controller.getSnapshot().navigationHistory).toEqual(history);
    expect(controller.getSnapshot().closed).toEqual([{ path: leftC.path, column: 0 }]);
    expect(api.closeTab).toHaveBeenCalledExactlyOnceWith("one", "view-one", "native-5");
    expect(api.createTab).toHaveBeenCalledTimes(6);
    expect(api.openDocument).toHaveBeenCalledTimes(6);
    await controller.closeTabsToRight(leftB.id);
    await controller.closeTabsToRight("missing");
    expect(api.closeTab).toHaveBeenCalledTimes(1);
    await controller.reopen();
    expect(controller.getSnapshot().tabs.at(-1)).toMatchObject({ path: leftC.path, column: 0 });
    expect(controller.getSnapshot().tabs.at(-1)?.id).not.toBe(leftC.id);
    expect(controller.getSnapshot().columns[1]).toBe(rightC.id);
    expect(controller.getSnapshot().closed).toEqual([]);
    controller.stop();
  });

  it("keeps failed right-side closes retryable and reports failure even after another close succeeds", async () => {
    const { api, controller } = setup();
    await controller.start();
    for (const path of ["a.html", "b.html", "c.html"]) await controller.select(path);
    const [a, b, c] = controller.getSnapshot().tabs;
    vi.mocked(api.closeTab).mockImplementation(async (_workspace, _view, id) => {
      if (id === "native-3") throw new Error("close failed");
    });
    await controller.closeTabsToRight(a.id);
    expect(controller.getSnapshot().tabs.map((tab) => tab.id)).toEqual([a.id, c.id]);
    expect(controller.getSnapshot().tabs[1]).toMatchObject({
      closing: false,
      error: "Error: close failed",
    });
    expect(controller.getSnapshot().error).toContain("close failed");
    expect(controller.getSnapshot().closed).toEqual([{ path: b.path, column: 0 }]);
    expect(api.openDocument).toHaveBeenCalledTimes(3);
    vi.mocked(api.closeTab).mockResolvedValue();
    await controller.closeTabsToRight(a.id);
    expect(controller.getSnapshot().tabs.map((tab) => tab.id)).toEqual([a.id]);
    expect(controller.getSnapshot().columns).toEqual([a.id, null]);
    expect(controller.getSnapshot().closed.map((tab) => tab.path)).toEqual([c.path, b.path]);
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });

  it("reorders only tab presentation and closes to an adjacent retained tab", async () => {
    const { api, controller } = setup();
    await controller.start();
    for (const path of ["a.html", "b.html", "c.html"]) await controller.select(path);
    const [a, b, c] = controller.getSnapshot().tabs;
    controller.reorderTab(a.id, c.id, true);
    expect(controller.getSnapshot().tabs.map((tab) => tab.id)).toEqual([b.id, c.id, a.id]);
    expect(controller.getSnapshot().columns[0]).toBe(c.id);
    expect(api.openDocument).toHaveBeenCalledTimes(3);
    expect(api.closeTab).not.toHaveBeenCalled();
    await controller.closeTab(c.id);
    expect(controller.getSnapshot().columns[0]).toBe(a.id);
    expect(api.openDocument).toHaveBeenCalledTimes(3);
  });

  it("retains column membership for hidden tabs and picks close neighbors in the same group", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.select("b.html");
    const [a, b] = controller.getSnapshot().tabs;
    controller.toggleSplit();
    controller.setActiveColumn(1);
    await controller.select("c.html");
    const c = controller.getSnapshot().tabs[2];
    expect(controller.getSnapshot().tabs.map((tab) => tab.column)).toEqual([1, 0, 1]);
    controller.reorderTab(c.id, b.id);
    expect(controller.getSnapshot().tabs.map((tab) => tab.id)).toEqual([a.id, b.id, c.id]);
    await controller.closeTab(c.id);
    expect(controller.getSnapshot().columns).toEqual([b.id, a.id]);
    controller.swapColumns();
    expect(controller.getSnapshot().tabs.map((tab) => tab.column)).toEqual([0, 1]);
    controller.toggleSplit();
    controller.toggleSplit();
    expect(controller.getSnapshot().columns).toEqual([a.id, b.id]);
    expect(api.openDocument).toHaveBeenCalledTimes(3);
  });

  it("normalizes former right-column close replacements and moves without swapping other views", async () => {
    const { controller } = setup();
    await controller.start();
    for (const path of ["a.html", "b.html", "c.html"]) await controller.select(path);
    const [a, b, c] = controller.getSnapshot().tabs;
    controller.toggleSplit();
    controller.toggleSplit();
    await controller.closeTab(c.id);
    expect(controller.getSnapshot().columns[0]).toBe(b.id);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === b.id)?.column).toBe(0);
    controller.toggleSplit();
    controller.moveToOtherColumn(a.id);
    expect(controller.getSnapshot().split).toBe(false);
    expect(controller.getSnapshot().columns).toEqual([a.id, null]);
    expect(controller.getSnapshot().tabs.map((tab) => tab.column)).toEqual([0, 0]);
  });

  it("reloads a moved hidden tab when closing its visible neighbor exposes it", async () => {
    const { api, controller, update, emit, moveNative } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.select("b.html");
    const [a, b] = controller.getSnapshot().tabs;
    controller.activate(a.id);
    const move = { from: "b.html", to: "Target/b.html", revision: 2 };
    update({
      ...snapshot,
      revision: 2,
      pathMoves: [move],
      nodes: [
        snapshot.nodes[0],
        snapshot.nodes[2],
        {
          name: "Target",
          relativePath: "Target",
          kind: "folder",
          children: [{ ...snapshot.nodes[1], relativePath: move.to }],
        },
      ],
    });
    moveNative(move.from, move.to);
    emit({ ...change(2, [move.from, move.to], true), moves: [move], treeOnly: true });
    await flush();
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === b.id)?.url).toBeNull();
    await controller.closeTab(a.id);
    await flush();
    expect(controller.getSnapshot().selectedPath).toBe(move.to);
    expect(controller.getSnapshot().documentUrl).toContain(move.to);
    expect(api.openDocument).toHaveBeenCalledTimes(3);
  });
  it("registers independent tabs and reuses existing documents without reopening", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.select("b.html");
    await controller.select("a.html");
    expect(controller.getSnapshot().tabs).toHaveLength(2);
    expect(controller.getSnapshot().selectedPath).toBe("a.html");
    expect(api.createTab).toHaveBeenCalledTimes(2);
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.openDocument).mock.calls.map((args) => args[3])).toEqual([1, 1]);
  });
  it("does not let an older document completion change the active tab", async () => {
    const { api, controller } = setup();
    await controller.start();
    let resolveA!: (url: string) => void;
    vi.mocked(api.openDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        }),
    );
    const pending = controller.select("a.html");
    await flush();
    await controller.select("b.html");
    resolveA("http://local/a.html");
    await pending;
    expect(controller.getSnapshot().selectedPath).toBe("b.html");
    expect(controller.getSnapshot().documentUrl).toContain("b.html");
    expect(controller.getSnapshot().tabs[0].url).toBe("http://local/a.html");
  });
  it("applies only the latest reload of each tab", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    const id = controller.getSnapshot().tabs[0].id;
    let resolveOld!: (url: string) => void;
    vi.mocked(api.openDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const old = controller.reload(id);
    await flush();
    await controller.reload(id);
    resolveOld("old");
    await old;
    expect(controller.getSnapshot().documentUrl).toContain("request=3");
  });
  it("moves, swaps and closes columns while retaining all tabs", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.select("b.html");
    const [a, b] = controller.getSnapshot().tabs;
    controller.toggleSplit();
    expect(controller.getSnapshot().columns).toEqual([b.id, a.id]);
    controller.swapColumns();
    expect(controller.getSnapshot().columns).toEqual([a.id, b.id]);
    controller.moveToOtherColumn(a.id);
    expect(controller.getSnapshot().columns).toEqual([a.id, null]);
    expect(controller.getSnapshot().split).toBe(false);
    expect(controller.getSnapshot().tabs.map((tab) => tab.column)).toEqual([0, 0]);
    controller.toggleSplit();
    expect(controller.getSnapshot().columns).toEqual([a.id, b.id]);
    controller.toggleSplit();
    expect(controller.getSnapshot().split).toBe(false);
    expect(controller.getSnapshot().tabs).toHaveLength(2);
    controller.toggleSplit();
    expect(new Set(controller.getSnapshot().columns).size).toBe(2);
    expect(api.openDocument).toHaveBeenCalledTimes(2);
  });
  it("releases closed tabs and reopens with a fresh native identity", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    const tab = controller.getSnapshot().tabs[0];
    await controller.closeTab(tab.id);
    expect(api.closeTab).toHaveBeenCalledWith("one", "view-one", "native-1");
    expect(controller.getSnapshot().tabs).toHaveLength(0);
    expect(controller.getSnapshot().columns).toEqual([null, null]);
    await controller.reopen();
    expect(controller.getSnapshot().tabs[0].id).not.toBe(tab.id);
    expect(api.createTab).toHaveBeenCalledTimes(2);
  });
  it("closes a tab while registration is pending without opening or resurrecting it", async () => {
    const { api, controller } = setup();
    await controller.start();
    let register!: (id: string) => void;
    vi.mocked(api.createTab).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          register = resolve;
        }),
    );
    const pending = controller.select("a.html");
    const closing = controller.closeTab(controller.getSnapshot().tabs[0].id);
    register("late");
    await Promise.all([pending, closing]);
    expect(api.openDocument).not.toHaveBeenCalled();
    expect(api.closeTab).toHaveBeenCalledWith("one", "view-one", "late");
    expect(controller.getSnapshot().tabs).toHaveLength(0);
  });
  it("keeps a failed-close tab available for retry", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    const id = controller.getSnapshot().tabs[0].id;
    vi.mocked(api.closeTab).mockRejectedValueOnce("接続失敗");
    await controller.closeTab(id);
    expect(controller.getSnapshot().tabs[0].closing).toBe(false);
    expect(controller.getSnapshot().error).toContain("閉じられません");
    await controller.closeTab(id);
    expect(controller.getSnapshot().tabs).toHaveLength(0);
  });
  it("can close and reopen a tab whose native registration failed", async () => {
    const { api, controller } = setup();
    await controller.start();
    vi.mocked(api.createTab).mockRejectedValueOnce("HTMLがありません");
    await controller.select("a.html");
    expect(controller.getSnapshot().tabs[0].error).toBe("HTMLがありません");
    await controller.closeTab(controller.getSnapshot().tabs[0].id);
    expect(controller.getSnapshot().tabs).toHaveLength(0);
    expect(api.closeTab).not.toHaveBeenCalled();
    await controller.reopen();
    expect(controller.getSnapshot().documentUrl).toContain("a.html");
  });
  it("retries failed registration and ignores old-root close/watch failures", async () => {
    const { api, controller, update, emit } = setup();
    await controller.start();
    vi.mocked(api.createTab).mockRejectedValueOnce("一時的な失敗");
    await controller.select("a.html");
    await controller.reload(controller.getSnapshot().tabs[0].id);
    expect(api.createTab).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().documentUrl).toContain("a.html");
    let failClose!: (reason: string) => void;
    let failWatch!: (reason: string) => void;
    vi.mocked(api.closeTab).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failClose = reject;
        }),
    );
    const closing = controller.closeTab(controller.getSnapshot().tabs[0].id);
    await flush();
    vi.mocked(api.getTree).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failWatch = reject;
        }),
    );
    emit(change(2, ["c.html"], true));
    await flush();
    update({ ...snapshot, workspaceId: "two", viewId: "view-two" });
    await controller.choose();
    failClose("旧rootの失敗");
    failWatch("旧watchの失敗");
    await closing;
    await flush();
    expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().tabs).toHaveLength(0);
  });
  it("keeps hidden state on updates and reloads both visible columns for shared assets", async () => {
    const { api, controller, emit } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.select("b.html");
    await controller.select("c.html");
    const [a, b, c] = controller.getSnapshot().tabs;
    emit(change(2, ["a.html"]));
    await flush();
    expect(controller.getSnapshot().tabs[0].dirty).toBe(true);
    controller.activate(a.id);
    expect(api.openDocument).toHaveBeenCalledTimes(3);
    controller.moveToOtherColumn(b.id);
    emit(change(3, ["style.css"]));
    await flush();
    expect(api.openDocument).toHaveBeenCalledTimes(5);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === c.id)?.dirty).toBe(true);
  });
  it("does not lose newer update paths when a structural rescan advances past its event", async () => {
    const { api, controller, emit, update } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.select("b.html");
    update({ ...snapshot, revision: 3 });
    emit(change(2, ["c.html"], true));
    await flush();
    emit(change(3, ["a.html", "b.html"]));
    await flush();
    expect(controller.getSnapshot().tabs[0].dirty).toBe(true);
    expect(controller.getSnapshot().tabs[1].url).toContain("request=2");
    expect(api.openDocument).toHaveBeenCalledTimes(3);
  });
  it("keeps the latest structural tree when a newer content event arrives before its reply", async () => {
    const { api, controller, emit } = setup();
    await controller.start();
    await controller.select("a.html");
    let scanned!: (snapshot: Snapshot) => void;
    vi.mocked(api.getTree).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          scanned = resolve;
        }),
    );
    emit(change(2, ["a.html"], true));
    await flush();
    emit(change(3, ["b.html"]));
    await flush();
    scanned({ ...snapshot, revision: 2, nodes: snapshot.nodes.slice(1) });
    await flush();
    expect(controller.getSnapshot().snapshot.revision).toBe(3);
    expect(controller.getSnapshot().snapshot.nodes.map((node) => node.relativePath)).toEqual([
      "b.html",
      "c.html",
    ]);
    expect(controller.getSnapshot().tabs[0].missing).toBe(true);
    expect(controller.getSnapshot().tabs[0].url).toBeNull();
  });
  it("ignores stale workspaces and missing files cannot receive delayed open results", async () => {
    const { api, controller, emit, update } = setup();
    await controller.start();
    let resolve!: (url: string) => void;
    vi.mocked(api.openDocument).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = controller.select("a.html");
    await flush();
    emit({ ...change(9, ["style.css"]), workspaceId: "old" });
    await flush();
    update({ ...snapshot, revision: 2, nodes: snapshot.nodes.slice(1), watchError: "監視エラー" });
    emit({ ...change(2, ["a.html"], true), watchError: "監視エラー" });
    await flush();
    resolve("late");
    await pending;
    expect(controller.getSnapshot().tabs[0].url).toBeNull();
    expect(controller.getSnapshot().tabs[0].missing).toBe(true);
    expect(controller.getSnapshot().snapshot.watchError).toBe("監視エラー");
  });
  it("drops old-root responses when choosing a new workspace", async () => {
    const { api, controller, update } = setup();
    await controller.start();
    let resolve!: (url: string) => void;
    vi.mocked(api.openDocument).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = controller.select("a.html");
    await flush();
    update({ ...snapshot, workspaceId: "two", viewId: "view-two" });
    await controller.choose();
    resolve("late");
    await pending;
    expect(controller.getSnapshot().tabs).toHaveLength(0);
    expect(controller.getSnapshot().snapshot.workspaceId).toBe("two");
  });
  it("retains tabs and URLs during refresh but clears them on renderer restart", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    const tab = controller.getSnapshot().tabs[0];
    await controller.refresh();
    expect(controller.getSnapshot().tabs[0]).toEqual(tab);
    controller.stop();
    await controller.start();
    expect(controller.getSnapshot().tabs).toHaveLength(0);
    expect(api.beginView).toHaveBeenCalledTimes(2);
  });
  it("disposes pending registration and event listeners after stop", async () => {
    const { api, controller } = setup();
    await controller.start();
    let register!: (id: string) => void;
    vi.mocked(api.createTab).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          register = resolve;
        }),
    );
    const pending = controller.select("a.html");
    controller.stop();
    register("late");
    await pending;
    await flush();
    expect(api.closeTab).toHaveBeenCalledWith("one", "view-one", "late");
    expect(api.openDocument).not.toHaveBeenCalled();
    expect(controller.getSnapshot().tabs).toHaveLength(0);
  });
});

describe("limited file actions", () => {
  it("ignores an old action failure while a new folder choice is still pending", async () => {
    const { api, controller, update } = setup();
    await controller.start();
    let reject!: (reason: string) => void;
    vi.mocked(api.performFileAction).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const pending = controller.performFileAction("a.html", "openFolder");
    let choose!: (value: Snapshot) => void;
    vi.mocked(api.chooseRoot).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    );
    const selecting = controller.choose();
    reject("old OS failure");
    await pending;
    expect(controller.getSnapshot().error).toBeNull();
    const next = { ...snapshot, workspaceId: "two", viewId: "view-two" };
    update(next);
    choose(next);
    await selecting;
    expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().actionBusy).toBe(false);
  });
  it("passes only current workspace/view/tree path and does not select or reload a document", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.performFileAction("a.html", "copyPath");
    expect(api.performFileAction).toHaveBeenCalledWith("one", "view-one", "a.html", "copyPath");
    expect(api.createTab).not.toHaveBeenCalled();
    expect(api.openDocument).not.toHaveBeenCalled();
    expect(controller.getSnapshot().actionMessage).toContain("コピーしました");
    await controller.performFileAction("../outside.html", "openBrowser");
    expect(api.performFileAction).toHaveBeenCalledTimes(1);
    controller.dismissActionMessage();
    expect(controller.getSnapshot().actionMessage).toBeNull();
  });
  it("dispatches folder copy/open for the exact Unicode target and excludes folder browser actions", async () => {
    const { api, controller, update } = setup();
    const folder = "日本語 空白 & 😀 é e\u0301";
    update({
      ...snapshot,
      nodes: [
        ...snapshot.nodes,
        { name: folder, relativePath: folder, kind: "folder", children: [] },
      ],
    });
    await controller.start();
    for (const action of ["copyPath", "openFolder"] as const) {
      await controller.performFileAction(folder, action);
      expect(api.performFileAction).toHaveBeenLastCalledWith("one", "view-one", folder, action);
    }
    await controller.performFileAction(folder, "openBrowser");
    await controller.performFileAction("missing", "copyPath");
    expect(api.performFileAction).toHaveBeenCalledTimes(2);
  });
  it("shows OS errors and permits another explicit attempt", async () => {
    const { api, controller } = setup();
    await controller.start();
    vi.mocked(api.performFileAction).mockRejectedValueOnce("既定アプリがありません");
    await controller.performFileAction("a.html", "openFolder");
    expect(controller.getSnapshot().error).toContain("既定アプリがありません");
    expect(controller.getSnapshot().actionBusy).toBe(false);
    await controller.performFileAction("a.html", "openFolder");
    expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().actionMessage).toContain("フォルダー");
  });
  it.each(["対象が見つかりません", "Native bridge通信に失敗", "クリップボードを開けません"])(
    "keeps copy failure visible without an old success message: %s",
    async (failure) => {
      const { api, controller } = setup();
      await controller.start();
      await controller.performFileAction("a.html", "copyPath");
      vi.mocked(api.performFileAction).mockRejectedValueOnce(failure);
      await controller.performFileAction("b.html", "copyPath");
      expect(controller.getSnapshot().error).toContain(failure);
      expect(controller.getSnapshot().actionMessage).toBeNull();
      expect(controller.getSnapshot().actionBusy).toBe(false);
    },
  );
  it("awaits Native acknowledgement and blocks overlapping target changes", async () => {
    const { api, controller } = setup();
    await controller.start();
    let finish!: () => void;
    vi.mocked(api.performFileAction).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = controller.performFileAction("a.html", "copyPath");
    expect(controller.getSnapshot().actionMessage).toBeNull();
    await controller.performFileAction("b.html", "copyPath");
    expect(api.performFileAction).toHaveBeenCalledTimes(1);
    finish();
    await pending;
    await controller.performFileAction("b.html", "copyPath");
    expect(api.performFileAction).toHaveBeenLastCalledWith("one", "view-one", "b.html", "copyPath");
  });
  it("does not overlap actions or show old-root failures and confirmations", async () => {
    const { api, controller, update } = setup();
    await controller.start();
    let reject!: (reason: string) => void;
    vi.mocked(api.performFileAction).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const pending = controller.performFileAction("a.html", "openBrowser");
    await controller.performFileAction("b.html", "copyPath");
    expect(api.performFileAction).toHaveBeenCalledTimes(1);
    update({ ...snapshot, workspaceId: "two", viewId: "view-two" });
    await controller.choose();
    reject("旧rootの失敗");
    await pending;
    expect(controller.getSnapshot().error).toBeNull();
    expect(controller.getSnapshot().actionBusy).toBe(false);
    expect(controller.getSnapshot().actionMessage).toBeNull();
  });
});

describe("tree mutations", () => {
  it("opens a created HTML only after accepting the Native snapshot", async () => {
    const { api, controller } = setup();
    await controller.start();
    const next = {
      ...snapshot,
      revision: 2,
      nodes: [
        ...snapshot.nodes,
        { name: "日本語.html", relativePath: "日本語.html", kind: "html" as const, children: [] },
      ],
    };
    vi.mocked(api.mutateTree).mockResolvedValueOnce({
      snapshot: next,
      createdPath: "日本語.html",
      moves: [],
      warning: null,
    });
    expect(
      await controller.mutateTree({ kind: "createHtml", parent: "", name: "日本語" }),
    ).toBeNull();
    expect(controller.getSnapshot().selectedPath).toBe("日本語.html");
    expect(api.openDocument).toHaveBeenCalledTimes(1);
    vi.mocked(api.mutateTree).mockResolvedValueOnce({
      snapshot: next,
      createdPath: null,
      moves: [],
      warning: null,
    });
    await controller.mutateTree({ kind: "createFolder", parent: "", name: "Folder" });
    expect(api.openDocument).toHaveBeenCalledTimes(1);
    controller.stop();
  });
  it("remaps hidden and visible tabs, columns and closed paths, and coalesces the response with its event", async () => {
    const { api, controller, update, emit, moveNative } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.select("b.html");
    await controller.select("c.html");
    const ids = controller.getSnapshot().tabs.map((tab) => tab.id);
    await controller.closeTab(ids[1]);
    await controller.select("a.html");
    const move = { from: "a.html", to: "Target/a.html", revision: 2 };
    const next = {
      ...snapshot,
      revision: 2,
      pathMoves: [move],
      nodes: [
        snapshot.nodes[1],
        snapshot.nodes[2],
        {
          name: "Target",
          relativePath: "Target",
          kind: "folder" as const,
          children: [{ ...snapshot.nodes[0], relativePath: "Target/a.html" }],
        },
      ],
    };
    moveNative(move.from, move.to);
    update(next);
    vi.mocked(api.mutateTree).mockImplementationOnce(async () => {
      emit({ ...change(2, [move.from, move.to], true), moves: [move], treeOnly: true });
      await flush();
      return {
        snapshot: next,
        createdPath: null,
        moves: [move],
        warning: "移動は完了、順序JSONを保存できません",
      };
    });
    await controller.mutateTree({ kind: "move", source: "a.html", parent: "Target" });
    expect(controller.getSnapshot().columns[0]).toBe(ids[0]);
    expect(controller.getSnapshot().documentUrl).toContain("Target/a.html");
    expect(controller.getSnapshot().actionMessage).toContain("順序JSON");
    expect(api.openDocument).toHaveBeenCalledTimes(4); // three opens, one move reload
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === ids[2])?.url).toContain("c.html");
    expect(controller.getSnapshot().closed).toEqual([{ path: "b.html", column: 0 }]);
    controller.stop();
  });
  it("keeps moved hidden tabs unloaded until activation, including split activation", async () => {
    const { api, controller, moveNative } = setup();
    await controller.start();
    await controller.select("a.html");
    await controller.select("b.html");
    const a = controller.getSnapshot().tabs[0];
    const move = { from: "a.html", to: "Target/a.html", revision: 2 };
    const next = {
      ...snapshot,
      revision: 2,
      pathMoves: [move],
      nodes: [
        snapshot.nodes[1],
        snapshot.nodes[2],
        {
          name: "Target",
          relativePath: "Target",
          kind: "folder" as const,
          children: [{ ...snapshot.nodes[0], relativePath: move.to }],
        },
      ],
    };
    moveNative(move.from, move.to);
    vi.mocked(api.mutateTree).mockResolvedValueOnce({
      snapshot: next,
      createdPath: null,
      moves: [move],
      warning: null,
    });
    await controller.mutateTree({ kind: "move", source: move.from, parent: "Target" });
    expect(controller.getSnapshot().tabs[0]).toMatchObject({
      id: a.id,
      path: move.to,
      url: null,
      dirty: true,
      missing: false,
    });
    expect(api.openDocument).toHaveBeenCalledTimes(2);
    controller.toggleSplit();
    await flush();
    expect(api.openDocument).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot().tabs[0].url).toContain(move.to);
    controller.stop();
  });
  it("retries a registration that loses its old path during a move", async () => {
    const { api, controller } = setup();
    await controller.start();
    let reject!: (error: string) => void;
    vi.mocked(api.createTab).mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const selecting = controller.select("a.html");
    const move = { from: "a.html", to: "Target/a.html", revision: 2 };
    const next = {
      ...snapshot,
      revision: 2,
      pathMoves: [move],
      nodes: [
        {
          name: "Target",
          relativePath: "Target",
          kind: "folder" as const,
          children: [{ ...snapshot.nodes[0], relativePath: move.to }],
        },
      ],
    };
    vi.mocked(api.mutateTree).mockResolvedValueOnce({
      snapshot: next,
      createdPath: null,
      moves: [move],
      warning: null,
    });
    const moving = controller.mutateTree({ kind: "move", source: move.from, parent: "Target" });
    await flush();
    reject("HTMLがありません");
    await Promise.all([selecting, moving]);
    expect(api.createTab).toHaveBeenLastCalledWith("one", "view-one", move.to);
    expect(controller.getSnapshot().documentUrl).toContain(move.to);
    expect(controller.getSnapshot().error).toBeNull();
    controller.stop();
  });
  it("preserves tabs after failure and ignores a late result from a previous workspace", async () => {
    const { api, controller, update } = setup();
    await controller.start();
    await controller.select("a.html");
    const original = controller.getSnapshot().tabs;
    vi.mocked(api.mutateTree).mockRejectedValueOnce("衝突");
    expect(
      await controller.mutateTree({ kind: "move", source: "a.html", parent: "Target" }),
    ).toContain("衝突");
    expect(controller.getSnapshot().tabs).toEqual(original);
    let resolve!: (result: Awaited<ReturnType<Bridge["mutateTree"]>>) => void;
    vi.mocked(api.mutateTree).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = controller.mutateTree({ kind: "createHtml", parent: "", name: "old" });
    update({ ...snapshot, workspaceId: "two", viewId: "view-two" });
    await controller.choose();
    resolve({ snapshot, createdPath: "a.html", moves: [], warning: null });
    await pending;
    expect(controller.getSnapshot().snapshot.workspaceId).toBe("two");
    expect(controller.getSnapshot().tabs).toHaveLength(0);
    expect(controller.getSnapshot().actionBusy).toBe(false);
    controller.stop();
  });
});

describe("coalesced structure and content events", () => {
  for (const moving of [false, true])
    it(`does not lose a newer content batch behind a ${moving ? "move" : "reorder"} snapshot`, async () => {
      const { api, controller, update, emit, moveNative } = setup();
      await controller.start();
      await controller.select("a.html");
      await controller.select("b.html");
      const move = { from: "a.html", to: "Target/a.html", revision: 2 };
      if (moving) moveNative(move.from, move.to);
      update(
        moving
          ? {
              ...snapshot,
              revision: 3,
              pathMoves: [move],
              nodes: [
                snapshot.nodes[1],
                snapshot.nodes[2],
                {
                  name: "Target",
                  relativePath: "Target",
                  kind: "folder",
                  children: [{ ...snapshot.nodes[0], relativePath: move.to }],
                },
              ],
            }
          : { ...snapshot, revision: 3 },
      );
      emit({ ...change(2, [], true), moves: moving ? [move] : [], treeOnly: true });
      await flush();
      expect(controller.getSnapshot().tabs[0].dirty).toBe(true); // hidden a needs explicit reload
      expect(api.openDocument).toHaveBeenCalledTimes(3); // visible b receives its coalesced save
      emit(change(3, ["b.html"]));
      await flush();
      expect(api.openDocument).toHaveBeenCalledTimes(3);
      controller.stop();
    });
});

describe("mutation completion context", () => {
  it("returns a stale context after a moved document reload finishes in a different workspace", async () => {
    const { api, controller, update } = setup();
    await controller.start();
    await controller.select("a.html");
    let finish!: (url: string) => void;
    vi.mocked(api.openDocument).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const move = { from: "a.html", to: "Target/a.html", revision: 2 };
    const next = {
      ...snapshot,
      revision: 2,
      pathMoves: [move],
      nodes: [
        {
          name: "Target",
          relativePath: "Target",
          kind: "folder" as const,
          children: [{ ...snapshot.nodes[0], relativePath: move.to }],
        },
      ],
    };
    vi.mocked(api.mutateTree).mockResolvedValueOnce({
      snapshot: next,
      createdPath: null,
      moves: [move],
      warning: null,
    });
    const pending = controller.mutateTree({ kind: "move", source: move.from, parent: "Target" });
    await flush();
    update({ ...snapshot, workspaceId: "two", viewId: "view-two" });
    await controller.choose();
    finish("old move URL");
    expect(await pending).toBe("作業フォルダーが変更されました");
    expect(controller.getSnapshot().snapshot.workspaceId).toBe("two");
    expect(controller.getSnapshot().tabs).toHaveLength(0);
    controller.stop();
  });
});

describe("folder move prefixes", () => {
  it("follows descendant hidden/closed paths and preserves the unrelated running column", async () => {
    const { api, controller, update, moveNative } = setup();
    const folder = {
      name: "Folder",
      relativePath: "Folder",
      kind: "folder" as const,
      children: snapshot.nodes
        .slice(0, 2)
        .map((node) => ({ ...node, relativePath: "Folder/" + node.name })),
    };
    update({ ...snapshot, nodes: [folder, snapshot.nodes[2]] });
    await controller.start();
    await controller.select("Folder/a.html");
    await controller.select("Folder/b.html");
    await controller.closeTab(controller.getSnapshot().tabs[1].id);
    await controller.select("c.html");
    const columns = [...controller.getSnapshot().columns];
    const other = controller.getSnapshot().documentUrl;
    const move = { from: "Folder", to: "Target/Folder", revision: 2 };
    moveNative(move.from, move.to);
    const moved = {
      ...folder,
      relativePath: move.to,
      children: folder.children.map((node) => ({
        ...node,
        relativePath: "Target/" + node.relativePath,
      })),
    };
    const next = {
      ...snapshot,
      revision: 2,
      pathMoves: [move],
      nodes: [
        snapshot.nodes[2],
        { name: "Target", relativePath: "Target", kind: "folder" as const, children: [moved] },
      ],
    };
    vi.mocked(api.mutateTree).mockResolvedValueOnce({
      snapshot: next,
      createdPath: null,
      moves: [move],
      warning: null,
    });
    await controller.mutateTree({ kind: "move", source: "Folder", parent: "Target" });
    expect(controller.getSnapshot().tabs[0]).toMatchObject({
      path: "Target/Folder/a.html",
      url: null,
      missing: false,
    });
    expect(controller.getSnapshot().closed).toEqual([{ path: "Target/Folder/b.html", column: 0 }]);
    expect(controller.getSnapshot().columns).toEqual(columns);
    expect(controller.getSnapshot().documentUrl).toBe(other);
    expect(api.openDocument).toHaveBeenCalledTimes(3);
    await controller.reopen();
    expect(controller.getSnapshot().documentUrl).toContain("Target/Folder/b.html");
    controller.stop();
  });
});

const recoveryCandidate: RecoveryCandidate = {
  currentIdentity: "current-document",
  sourceIdentity: "previous-document",
  sourceRevision: 4,
  appCount: 2,
};

describe("explicit document state recovery", () => {
  it("requires confirmation and reloads every same-path view while preserving other documents", async () => {
    const { api, controller } = setup();
    const getCandidate = vi.fn(async () => recoveryCandidate);
    const recover = vi.fn(async () => {});
    api.getDocumentStateRecovery = getCandidate;
    api.recoverDocumentState = recover;
    await controller.start();
    await controller.select("a.html", 0);
    await controller.select("a.html", 1);
    await controller.select("b.html", 1);
    const other = controller.getSnapshot().tabs.find((tab) => tab.path === "b.html")!;
    const columns = controller.getSnapshot().columns;
    const confirm = vi.fn(() => {
      expect(recover).not.toHaveBeenCalled();
      expect(controller.getSnapshot().actionBusy).toBe(true);
      return true;
    });
    await controller.recoverDocumentState("a.html", confirm);
    expect(getCandidate).toHaveBeenCalledWith("one", "view-one", "a.html");
    expect(confirm).toHaveBeenCalledWith(recoveryCandidate);
    expect(recover).toHaveBeenCalledWith("one", "view-one", "a.html", recoveryCandidate);
    expect(api.openDocument).toHaveBeenCalledTimes(5);
    for (const tab of controller.getSnapshot().tabs.filter((tab) => tab.path === "a.html"))
      expect(tab.url).toContain("request=2");
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === other.id)?.url).toBe(other.url);
    expect(controller.getSnapshot().columns).toEqual(columns);
    expect(controller.getSnapshot().actionMessage).toContain("引き継ぎました");
    expect(controller.getSnapshot().actionBusy).toBe(false);
    controller.stop();
  });

  it("does not recover or reload on cancellation or when no candidate exists", async () => {
    const { api, controller } = setup();
    const getCandidate = vi.fn(async (): Promise<RecoveryCandidate | null> => recoveryCandidate);
    const recover = vi.fn(async () => {});
    api.getDocumentStateRecovery = getCandidate;
    api.recoverDocumentState = recover;
    await controller.start();
    await controller.select("a.html");
    const confirm = vi.fn(() => false);
    await controller.recoverDocumentState("a.html", confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
    expect(api.openDocument).toHaveBeenCalledTimes(1);
    getCandidate.mockResolvedValueOnce(null);
    await controller.recoverDocumentState("a.html", confirm);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().error).toContain("以前の入力状態はありません");
    expect(controller.getSnapshot().actionBusy).toBe(false);
    controller.stop();
  });

  it("serializes actions and drops a candidate returned after a workspace change", async () => {
    const { api, controller, update } = setup();
    let resolve!: (candidate: RecoveryCandidate) => void;
    const getCandidate = vi.fn(
      () =>
        new Promise<RecoveryCandidate>((done) => {
          resolve = done;
        }),
    );
    const recover = vi.fn(async () => {});
    api.getDocumentStateRecovery = getCandidate;
    api.recoverDocumentState = recover;
    await controller.start();
    const confirm = vi.fn(() => true);
    const pending = controller.recoverDocumentState("a.html", confirm);
    await controller.recoverDocumentState("b.html", confirm);
    await controller.performFileAction("a.html", "openBrowser");
    expect(getCandidate).toHaveBeenCalledTimes(1);
    expect(api.performFileAction).not.toHaveBeenCalled();
    update({ ...snapshot, workspaceId: "two", viewId: "view-two" });
    await controller.choose();
    resolve(recoveryCandidate);
    await pending;
    expect(confirm).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(controller.getSnapshot().actionMessage).toBeNull();
    expect(controller.getSnapshot().actionBusy).toBe(false);
    controller.stop();
  });

  it("rechecks view ownership after confirmation and ignores confirmations after stop", async () => {
    for (const transition of ["view", "stop"]) {
      const { api, controller, update } = setup();
      const recover = vi.fn(async () => {});
      api.getDocumentStateRecovery = vi.fn(async () => recoveryCandidate);
      api.recoverDocumentState = recover;
      await controller.start();
      let confirm!: (accepted: boolean) => void;
      const pending = controller.recoverDocumentState(
        "a.html",
        () =>
          new Promise<boolean>((done) => {
            confirm = done;
          }),
      );
      await flush();
      if (transition === "view") {
        update({ ...snapshot, viewId: "view-two" });
        await controller.choose();
      } else controller.stop();
      confirm(true);
      await pending;
      expect(recover).not.toHaveBeenCalled();
      expect(controller.getSnapshot().actionBusy).toBe(false);
      controller.stop();
    }
  });

  it("does not confirm a removed target and clears its busy state", async () => {
    const { api, controller, update, emit } = setup();
    let resolve!: (candidate: RecoveryCandidate) => void;
    api.getDocumentStateRecovery = vi.fn(
      () =>
        new Promise<RecoveryCandidate>((done) => {
          resolve = done;
        }),
    );
    const recover = vi.fn(async () => {});
    api.recoverDocumentState = recover;
    await controller.start();
    const confirm = vi.fn(() => true);
    const pending = controller.recoverDocumentState("a.html", confirm);
    update({
      ...snapshot,
      revision: 2,
      nodes: snapshot.nodes.filter((node) => node.relativePath !== "a.html"),
    });
    emit(change(2, ["a.html"], true));
    await flush();
    resolve(recoveryCandidate);
    await pending;
    expect(confirm).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toContain("選び直してください");
    expect(controller.getSnapshot().actionBusy).toBe(false);
    controller.stop();
  });

  it("reports existing-state conflicts and changed candidates without reloading or overwriting", async () => {
    const { api, controller } = setup();
    api.getDocumentStateRecovery = vi.fn(async () => recoveryCandidate);
    const recover = vi.fn(async () => {});
    api.recoverDocumentState = recover;
    await controller.start();
    await controller.select("a.html");
    recover.mockRejectedValueOnce("StateConflict");
    await controller.recoverDocumentState("a.html", () => true);
    expect(controller.getSnapshot().error).toContain("上書きできません");
    recover.mockRejectedValueOnce("RecoveryChanged");
    await controller.recoverDocumentState("a.html", () => true);
    expect(controller.getSnapshot().error).toContain("もう一度引き継ぎ操作");
    expect(api.openDocument).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().actionMessage).toBeNull();
    expect(controller.getSnapshot().actionBusy).toBe(false);
    controller.stop();
  });

  it("keeps unsupported bridges usable and refuses paths outside the current tree", async () => {
    const { controller } = setup();
    await controller.start();
    const confirm = vi.fn(() => true);
    await controller.recoverDocumentState("../a.html", confirm);
    expect(controller.getSnapshot().actionMessage).toBeNull();
    await controller.recoverDocumentState("a.html", confirm);
    expect(controller.getSnapshot().error).toContain("利用できません");
    expect(confirm).not.toHaveBeenCalled();
    expect(controller.getSnapshot().actionBusy).toBe(false);
    controller.stop();
  });
});

it("saved-root recovery retries only the current detached view and never opens old tabs", async () => {
  const { controller, api, update } = setup();
  update({
    ...snapshot,
    workspaceId: null,
    rootPath: null,
    nodes: [],
    startupRecovery: { reason: "pathUnavailable", canRetry: true },
  });
  let release!: (value: Snapshot) => void;
  api.retrySavedRoot = vi.fn(
    () =>
      new Promise<Snapshot>((done) => {
        release = done;
      }),
  );
  await controller.start();
  expect(controller.getSnapshot().tabs).toHaveLength(0);
  const recovery = controller.retrySavedRoot();
  await controller.retrySavedRoot();
  expect(api.retrySavedRoot).toHaveBeenCalledExactlyOnceWith("view-one");
  update(snapshot);
  release(snapshot);
  await recovery;
  expect(controller.getSnapshot().snapshot.workspaceId).toBe("one");
  expect(controller.getSnapshot().tabs).toHaveLength(0);
  expect(api.createTab).not.toHaveBeenCalled();
  await controller.retrySavedRoot();
  expect(api.retrySavedRoot).toHaveBeenCalledTimes(1);
  controller.stop();
});
it("legacy confirmation does not dispatch retry and cancelling picker keeps recovery", async () => {
  const { controller, api, update } = setup();
  update({
    ...snapshot,
    workspaceId: null,
    rootPath: null,
    nodes: [],
    startupRecovery: { reason: "confirmationRequired", canRetry: false },
  });
  api.retrySavedRoot = vi.fn(async () => snapshot);
  api.chooseRoot = vi.fn(async () => null);
  await controller.start();
  await controller.retrySavedRoot();
  expect(api.retrySavedRoot).not.toHaveBeenCalled();
  await controller.choose();
  expect(controller.getSnapshot().snapshot.startupRecovery?.reason).toBe("confirmationRequired");
  controller.stop();
});
