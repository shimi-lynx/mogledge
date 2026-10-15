import { describe, expect, it, vi } from "vite-plus/test";
import { KnowledgeController } from "./controller";
import type { Bridge, Change, Snapshot, WorkspaceDocument, ResolvedWorkspaceSet } from "./types";

const tree: Snapshot = {
  workspaceId: "root",
  viewId: "view",
  rootPath: "/fixture",
  revision: 1,
  watchError: null,
  nodes: ["a", "b", "c", "d"].map((name) => ({
    name,
    relativePath: name + ".html",
    kind: "html",
    children: [],
  })),
};
function setup() {
  let snapshot = structuredClone(tree),
    count = 0;
  let listener: (change: Change) => void = () => {};
  const paths = new Map<string, string>();
  const api: Bridge = {
    beginView: vi.fn(async () => snapshot),
    getTree: vi.fn(async () => snapshot),
    chooseRoot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    createTab: vi.fn(async (_w, _v, path) => {
      const id = "native-" + ++count;
      paths.set(id, path);
      return id;
    }),
    openDocument: vi.fn(
      async (_w, _v, id, request) => "http://local/" + paths.get(id) + "?r=" + request,
    ),
    closeTab: vi.fn(async () => {}),
    listen: vi.fn(async (callback) => {
      listener = callback;
      return () => {};
    }),
    mutateTree: vi.fn(async () => ({ snapshot, createdPath: null, moves: [], warning: null })),
    performFileAction: vi.fn(async () => {}),
    validateDocumentNavigation: vi.fn(async (_w, _v, path) => ({
      relativePath: path,
      identity: "a".repeat(64),
    })),
  };
  const controller = new KnowledgeController(api);
  const ready = (id: string) => {
    const tab = controller.getSnapshot().tabs.find((tab) => tab.id === id)!;
    controller.documentReady(id, tab.url!);
    return tab;
  };
  const show = async (path: string, column: 0 | 1 = 0) => {
    await controller.select(path + ".html", column);
    return ready(controller.getSnapshot().columns[column]!);
  };
  return {
    api,
    controller,
    ready,
    show,
    update: (s: Snapshot) => {
      snapshot = s;
    },
    emit: (change: Change) => listener(change),
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const history = (controller: KnowledgeController, column: 0 | 1 = 0) =>
  controller.getSnapshot().navigationHistory![column];

describe("successful per-column document navigation", () => {
  it("reuses A/B/C views, commits back/forward and cuts forward only after a successful new display", async () => {
    const { controller, api, show } = setup();
    await controller.start();
    const a = await show("a");
    await show("b");
    await show("c");
    await controller.navigateHistory("back");
    expect(controller.getSnapshot().selectedPath).toBe("b.html");
    expect(history(controller).cursor).toBe(1);
    await controller.navigateHistory("forward");
    expect(history(controller).cursor).toBe(2);
    await controller.navigateHistory("back");
    await show("d");
    expect(history(controller).entries.map((e) => e.path)).toEqual(["a.html", "b.html", "d.html"]);
    await controller.navigateHistory("back");
    await controller.navigateHistory("back");
    expect(controller.getSnapshot().tabs.find((t) => t.id === a.id)?.url).toBe(a.url);
    expect(api.openDocument).toHaveBeenCalledTimes(4);
    await controller.navigateHistory("back");
    expect(history(controller).cursor).toBe(0);
    controller.stop();
  });
  it("records ready visible user displays even when recent persistence fails; reload never records", async () => {
    const { controller, api, show, ready } = setup();
    api.recordDocumentDisplay = vi.fn(async () => {
      throw new Error("write failed");
    });
    await controller.start();
    const a = await show("a");
    await flush();
    await show("b");
    await flush();
    expect(history(controller).entries).toHaveLength(2);
    expect(controller.getSnapshot().error).toContain("最近");
    await controller.reload(a.id, "input-transfer");
    ready(a.id);
    expect(history(controller).entries).toHaveLength(2);
    controller.stop();
  });
  it("ignores unready/failed new selection and preserves forward", async () => {
    const { controller, api, show } = setup();
    await controller.start();
    await show("a");
    await show("b");
    await controller.navigateHistory("back");
    api.openDocument = vi.fn(async () => {
      throw new Error("unreadable");
    });
    await controller.select("c.html");
    expect(history(controller).entries).toHaveLength(2);
    expect(history(controller).cursor).toBe(0);
    controller.stop();
  });
  it("keeps display/cursor on transient validation failure and allows retry", async () => {
    const { controller, api, show } = setup();
    await controller.start();
    await show("a");
    const b = await show("b");
    api.validateDocumentNavigation = vi
      .fn()
      .mockRejectedValueOnce("permission")
      .mockResolvedValue({ relativePath: "a.html", identity: "a".repeat(64) });
    await controller.navigateHistory("back");
    expect(controller.getSnapshot().columns[0]).toBe(b.id);
    expect(history(controller).cursor).toBe(1);
    expect(history(controller).entries[0].missing).toBe(false);
    await controller.navigateHistory("back");
    expect(history(controller).cursor).toBe(0);
    controller.stop();
  });
  it("supersedes reverse-order validations and direction reversal without displaying stale targets", async () => {
    const { controller, api, show } = setup();
    await controller.start();
    await show("a");
    await show("b");
    const c = await show("c");
    const replies: ((document: WorkspaceDocument) => void)[] = [];
    api.validateDocumentNavigation = vi.fn(
      () => new Promise<WorkspaceDocument>((resolve) => replies.push(resolve)),
    );
    const first = controller.navigateHistory("back"),
      second = controller.navigateHistory("back");
    replies[1]({ relativePath: "a.html", identity: "a".repeat(64) });
    await second;
    expect(history(controller).cursor).toBe(0);
    replies[0]({ relativePath: "b.html", identity: "a".repeat(64) });
    await first;
    expect(controller.getSnapshot().selectedPath).toBe("a.html");
    const forward = controller.navigateHistory("forward"),
      reverse = controller.navigateHistory("back");
    replies[3]({ relativePath: "a.html", identity: "a".repeat(64) });
    await reverse;
    replies[2]({ relativePath: "b.html", identity: "a".repeat(64) });
    await forward;
    expect(history(controller).cursor).toBe(0);
    expect(controller.getSnapshot().columns[0]).not.toBe(c.id);
    controller.stop();
  });
  it("cancels stale responses on user selection and root switch", async () => {
    const { controller, api, show, update } = setup();
    await controller.start();
    await show("a");
    await show("b");
    let reply!: (document: WorkspaceDocument) => void;
    api.validateDocumentNavigation = vi.fn(
      () =>
        new Promise<WorkspaceDocument>((resolve) => {
          reply = resolve;
        }),
    );
    const pending = controller.navigateHistory("back");
    await show("c");
    reply({ relativePath: "a.html", identity: "a".repeat(64) });
    await pending;
    expect(controller.getSnapshot().selectedPath).toBe("c.html");
    const pendingRoot = controller.navigateHistory("back");
    update({ ...tree, workspaceId: "new", viewId: "new-view" });
    await controller.registerRoot();
    reply({ relativePath: "b.html", identity: "a".repeat(64) });
    await pendingRoot;
    expect(history(controller).entries).toHaveLength(0);
    expect(controller.getSnapshot().tabs).toHaveLength(0);
    controller.stop();
  });
  it("reopens a closed reference only after new iframe readiness, without restoring its old runtime", async () => {
    const { controller, api, show, ready } = setup();
    await controller.start();
    const a = await show("a");
    const b = await show("b");
    await controller.closeTab(a.id);
    await controller.navigateHistory("back");
    expect(history(controller).cursor).toBe(1);
    expect(controller.getSnapshot().columns[0]).toBe(b.id);
    const fresh = controller.getSnapshot().tabs.find((t) => t.path === "a.html")!;
    expect(fresh.id).not.toBe(a.id);
    ready(fresh.id);
    expect(history(controller).cursor).toBe(0);
    expect(api.createTab).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot().closed).toHaveLength(1);
    controller.stop();
  });
  it("failed closed-target read leaves the current view and no staging tab", async () => {
    const { controller, api, show } = setup();
    await controller.start();
    const a = await show("a");
    const b = await show("b");
    await controller.closeTab(a.id);
    api.openDocument = vi.fn(async () => {
      throw new Error("read failure");
    });
    await controller.navigateHistory("back");
    expect(controller.getSnapshot().columns[0]).toBe(b.id);
    expect(controller.getSnapshot().tabs).toHaveLength(1);
    expect(history(controller).cursor).toBe(1);
    controller.stop();
  });
  it("requires current fragment acknowledgement; missing fragment preserves cursor and forward", async () => {
    const { controller, show } = setup();
    await controller.start();
    const a = await show("a");
    await controller.followDocumentLink(a.id, a.url!, { kind: "page", fragment: "#chapter" });
    controller.documentAnchorResult(
      a.id,
      a.url!,
      controller.getSnapshot().tabs.find((t) => t.id === a.id)!.navigation!.request,
      true,
    );
    await show("b");
    await controller.navigateHistory("back");
    expect(history(controller).cursor).toBe(1);
    const request = controller.getSnapshot().tabs.find((t) => t.id === a.id)!.navigation!.request;
    controller.documentAnchorResult(a.id, a.url!, request - 1, true);
    expect(history(controller).cursor).toBe(1);
    controller.documentAnchorResult(a.id, a.url!, request, false);
    expect(history(controller).cursor).toBe(1);
    await controller.navigateHistory("back");
    const next = controller.getSnapshot().tabs.find((t) => t.id === a.id)!.navigation!.request;
    controller.documentAnchorResult(a.id, a.url!, next, true);
    expect(history(controller).cursor).toBe(0);
    expect(history(controller).entries).toHaveLength(2);
    controller.stop();
  });
  it("keeps left/right same-document views independent, transfers histories on swap and retains left on merge", async () => {
    const { controller, show } = setup();
    await controller.start();
    const left = await show("a");
    await show("b");
    const right = await show("a", 1);
    await show("c", 1);
    await controller.navigateHistory("back", 1);
    expect(controller.getSnapshot().columns[1]).toBe(right.id);
    expect(history(controller, 0).cursor).toBe(1);
    controller.swapColumns();
    expect(history(controller, 0).entries.map((e) => e.path)).toEqual(["a.html", "c.html"]);
    controller.toggleSplit();
    expect(history(controller, 1).entries).toHaveLength(0);
    expect(controller.getSnapshot().columns[0]).toBe(right.id);
    expect(controller.getSnapshot().tabs.find((t) => t.id === left.id)?.url).toBe(left.url);
    controller.stop();
  });
  it("marks confirmed deletion missing, restores candidates on tree return, and remaps confirmed moves", async () => {
    const { controller, show, update, emit } = setup();
    await controller.start();
    await show("a");
    await show("b");
    update({ ...tree, revision: 2, nodes: tree.nodes.filter((n) => n.relativePath !== "a.html") });
    emit({
      workspaceId: "root",
      revision: 2,
      changedPaths: ["a.html"],
      structureChanged: true,
      watchError: null,
    });
    await flush();
    await flush();
    expect(history(controller).entries[0].missing).toBe(true);
    await controller.navigateHistory("back");
    expect(history(controller).cursor).toBe(1);
    update({ ...tree, revision: 3 });
    emit({
      workspaceId: "root",
      revision: 3,
      changedPaths: [],
      structureChanged: true,
      watchError: null,
    });
    await flush();
    await flush();
    expect(history(controller).entries[0].missing).toBe(false);
    update({
      ...tree,
      revision: 4,
      pathMoves: [{ from: "a.html", to: "d.html", revision: 4 }],
      nodes: tree.nodes.filter((n) => n.relativePath !== "a.html"),
    });
    emit({
      workspaceId: "root",
      revision: 4,
      changedPaths: [],
      structureChanged: true,
      moves: [{ from: "a.html", to: "d.html", revision: 4 }],
      watchError: null,
    });
    await flush();
    await flush();
    expect(history(controller).entries[0].path).toBe("d.html");
    controller.stop();
  });
});

for (const success of [true, false]) {
  it(`latches fragment ${success} before new frame readiness`, async () => {
    const { controller, show, ready } = setup();
    await controller.start();
    const a = await show("a");
    await controller.followDocumentLink(a.id, a.url!, { kind: "page", fragment: "#chapter" });
    controller.documentAnchorResult(
      a.id,
      a.url!,
      controller.getSnapshot().tabs.find((t) => t.id === a.id)!.navigation!.request,
      true,
    );
    const b = await show("b");
    await controller.closeTab(a.id);
    await controller.navigateHistory("back");
    const fresh = controller.getSnapshot().tabs.find((t) => t.path === "a.html")!;
    controller.documentAnchorResult(fresh.id, fresh.url!, fresh.navigation!.request, success);
    expect(history(controller).cursor).toBe(1);
    ready(fresh.id);
    expect(history(controller).cursor).toBe(success ? 0 : 1);
    if (!success) expect(controller.getSnapshot().columns[0]).toBe(b.id);
    controller.stop();
  });
}
it("restoring existing ready set cancels validation and its timeout", async () => {
  vi.useFakeTimers();
  try {
    const { controller, api, show } = setup();
    await controller.start();
    const a = await show("a");
    await show("b");
    let reply!: (document: WorkspaceDocument) => void;
    api.validateDocumentNavigation = vi.fn(
      () =>
        new Promise<WorkspaceDocument>((resolve) => {
          reply = resolve;
        }),
    );
    api.resolveWorkspaceSet = vi.fn(async (): Promise<ResolvedWorkspaceSet> => ({
      set: { id: "set", name: "set", items: [], active: [0, null], activeColumn: 0 },
      items: [
        {
          document: { relativePath: "a.html", identity: "a".repeat(64) },
          column: 0,
          zoom: 100,
          status: "available",
          reusableTabs: ["native-1"],
        },
      ],
    }));
    const pending = controller.navigateHistory("back");
    await controller.restoreWorkspaceSet("set");
    reply({ relativePath: "a.html", identity: "a".repeat(64) });
    await pending;
    await vi.advanceTimersByTimeAsync(15001);
    expect(controller.getSnapshot().columns[0]).toBe(a.id);
    expect(controller.getSnapshot().error).toBeNull();
    expect(history(controller).pending).toBeNull();
    controller.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("failed normal fragment never poisons a later back target", async () => {
  const { controller, show } = setup();
  await controller.start();
  const a = await show("a");
  await controller.followDocumentLink(a.id, a.url!, { kind: "page", fragment: "#missing" });
  const request = controller.getSnapshot().tabs.find((t) => t.id === a.id)!.navigation!.request;
  controller.documentAnchorResult(a.id, a.url!, request, false);
  expect(history(controller).entries[0].fragment).toBe("");
  await show("b");
  await controller.navigateHistory("back");
  expect(history(controller).cursor).toBe(0);
  controller.stop();
});

it("invalidates late ordinary fragment ACK on history intent and reload", async () => {
  const { controller, show, ready } = setup();
  await controller.start();
  const a = await show("a");
  await controller.followDocumentLink(a.id, a.url!, { kind: "page", fragment: "#pending" });
  const old = controller.getSnapshot().tabs.find((t) => t.id === a.id)!.navigation!.request;
  await show("b");
  await controller.navigateHistory("back");
  controller.documentAnchorResult(a.id, a.url!, old, true);
  expect(history(controller).entries[0].fragment).toBe("");
  await controller.followDocumentLink(a.id, a.url!, { kind: "page", fragment: "#other" });
  await controller.reload(a.id);
  const fresh = ready(a.id);
  controller.documentAnchorResult(a.id, a.url!, old, true);
  controller.activate(a.id);
  expect(history(controller).entries[0].fragment).toBe("");
  expect(fresh.url).not.toBe(a.url);
  controller.stop();
});
it("times out only an owned staging view and leaves display/cursor unchanged", async () => {
  vi.useFakeTimers();
  try {
    const { controller, show } = setup();
    await controller.start();
    const a = await show("a"),
      b = await show("b");
    await controller.closeTab(a.id);
    await controller.navigateHistory("back");
    await vi.advanceTimersByTimeAsync(15001);
    expect(controller.getSnapshot().columns[0]).toBe(b.id);
    expect(controller.getSnapshot().tabs).toHaveLength(1);
    expect(history(controller).cursor).toBe(1);
    controller.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("adopts the surviving right history on close and cancels its old pane ticket", async () => {
  const { controller, api, show } = setup();
  await controller.start();
  const left = await show("a");
  await show("b", 1);
  const right = await show("c", 1);
  let reply!: (value: WorkspaceDocument) => void;
  api.validateDocumentNavigation = vi.fn(
    () =>
      new Promise<WorkspaceDocument>((resolve) => {
        reply = resolve;
      }),
  );
  const pending = controller.navigateHistory("back", 1);
  await controller.closeTab(left.id);
  reply({ relativePath: "b.html", identity: "a".repeat(64) });
  await pending;
  expect(controller.getSnapshot().split).toBe(false);
  expect(controller.getSnapshot().columns[0]).toBe(right.id);
  expect(history(controller).cursor).toBe(1);
  expect(history(controller, 1).entries).toHaveLength(0);
  controller.stop();
});
it("reads an existing lazy placeholder only after explicit validated history intent", async () => {
  const { controller, api, show, ready } = setup();
  await controller.start();
  const a = await show("a");
  await show("b");
  await controller.closeTab(a.id);
  api.resolveWorkspaceSet = vi.fn(async (): Promise<ResolvedWorkspaceSet> => ({
    set: { id: "set", name: "set", items: [], active: [1, null], activeColumn: 0 },
    items: [
      {
        document: { relativePath: "a.html", identity: "a".repeat(64) },
        column: 0,
        zoom: 100,
        status: "available",
        reusableTabs: [],
      },
      {
        document: { relativePath: "b.html", identity: "a".repeat(64) },
        column: 0,
        zoom: 100,
        status: "available",
        reusableTabs: ["native-2"],
      },
    ],
  }));
  await controller.restoreWorkspaceSet("set");
  const lazy = controller.getSnapshot().tabs.find((tab) => tab.path === "a.html")!;
  expect(lazy.deferred).toBe(true);
  expect(api.openDocument).toHaveBeenCalledTimes(2);
  await controller.navigateHistory("back");
  expect(controller.getSnapshot().columns[0]).not.toBe(lazy.id);
  ready(lazy.id);
  expect(controller.getSnapshot().columns[0]).toBe(lazy.id);
  expect(api.openDocument).toHaveBeenCalledTimes(3);
  expect(controller.getSnapshot().tabs.filter((tab) => tab.path === "a.html")).toHaveLength(1);
  controller.stop();
});
