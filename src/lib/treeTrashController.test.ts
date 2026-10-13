import { expect, it, vi } from "vite-plus/test";
import { KnowledgeController } from "./controller";
import type { Bridge, Change, Snapshot } from "./types";

function fixture(failure = false, recreate = false, warning: string | null = null) {
  let snapshot: Snapshot = {
    workspaceId: "fixture",
    viewId: "view",
    rootPath: "/fixture",
    revision: 1,
    watchError: null,
    nodes: ["a.html", "b.html", "c.html"].map((name) => ({
      name,
      relativePath: name,
      kind: "html",
      children: [],
    })),
  };
  let count = 0;
  let listener: (change: Change) => void = () => {};
  const api: Bridge = {
    beginView: vi.fn(async () => snapshot),
    getTree: vi.fn(async () => snapshot),
    chooseRoot: vi.fn(async () => null),
    refresh: vi.fn(async () => snapshot),
    createTab: vi.fn(async () => "native-" + ++count),
    closeTab: vi.fn(async () => {}),
    openDocument: vi.fn(
      async (_workspace, _view, tab, request) => `http://fixture/${tab}/${request}`,
    ),
    listen: vi.fn(async (callback) => {
      listener = callback;
      return () => {
        listener = () => {};
      };
    }),
    performFileAction: vi.fn(async () => {}),
    mutateTree: vi.fn(async (_workspace, _view, mutation) => {
      if (failure) throw new Error("ごみ箱を利用できません");
      if (mutation.kind !== "trash") throw new Error("unexpected mutation");
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        nodes: recreate
          ? snapshot.nodes
          : snapshot.nodes.filter((node) => node.relativePath !== mutation.source),
      };
      return { snapshot, createdPath: null, moves: [], warning };
    }),
  };
  return {
    api,
    controller: new KnowledgeController(api),
    emit: (change: Change) => listener(change),
    update: (next: Snapshot) => {
      snapshot = next;
    },
  };
}

it("keeps a committed trash rescan warning after revoking an open victim and reloading survivors", async () => {
  const warning = "ごみ箱移動は完了しましたが、再走査に失敗しました。再走査してください";
  const { controller } = fixture(false, true, warning);
  await controller.start();
  await controller.openInColumn("a.html", 0);
  await controller.openInColumn("b.html", 1);
  expect(await controller.mutateTree({ kind: "trash", source: "a.html", revision: 1 })).toBeNull();
  const after = controller.getSnapshot();
  expect(after.tabs.find((tab) => tab.path === "a.html")).toMatchObject({
    missing: true,
    url: null,
  });
  expect(after.error).toBe(warning);
  expect(after.actionBusy).toBe(false);
  controller.stop();
});

it.each([
  { kind: "createFolder", parent: "", name: "unconfirmed" },
  { kind: "createHtml", parent: "", name: "unconfirmed" },
  { kind: "renameHtml", source: "a.html", name: "unconfirmed" },
  { kind: "move", source: "a.html", parent: "Target" },
] as const)(
  "unknown $kind keeps existing views and warning without automatic retry or open",
  async (mutation) => {
    const { api, controller } = fixture();
    await controller.start();
    await controller.select("a.html");
    const before = controller.getSnapshot();
    const opened = vi.mocked(api.openDocument).mock.calls.length;
    const warning =
      "操作が完了した可能性がありますが、確認を完了できませんでした。再試行や削除をせず、再読み込みで状態を確認してください";
    vi.mocked(api.mutateTree).mockResolvedValue({
      snapshot: { ...before.snapshot, revision: before.snapshot.revision + 1 },
      createdPath: null,
      moves: [],
      warning,
    });
    expect(await controller.mutateTree(mutation)).toBeNull();
    const after = controller.getSnapshot();
    expect(after.snapshot.nodes).toEqual(before.snapshot.nodes);
    expect(after.tabs).toEqual(before.tabs);
    expect(after.actionMessage).toBe(warning);
    expect(after.error).toBe(warning);
    expect(after.actionBusy).toBe(false);
    expect(api.mutateTree).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.openDocument).mock.calls).toHaveLength(opened);
    controller.stop();
  },
);

it("trash keeps missing tabs revoked and reloads surviving visible shared-resource consumers", async () => {
  const { api, controller } = fixture();
  await controller.start();
  await controller.select("a.html");
  await controller.select("b.html");
  await controller.select("c.html");
  const c = controller.getSnapshot().tabs.find((tab) => tab.path === "c.html")!;
  await controller.closeTab(c.id);
  await controller.select("a.html");
  const opened = vi.mocked(api.openDocument).mock.calls.length;
  expect(await controller.mutateTree({ kind: "trash", source: "b.html", revision: 1 })).toBeNull();
  const state = controller.getSnapshot();
  expect(state.tabs.find((tab) => tab.path === "b.html")).toMatchObject({
    missing: true,
    url: null,
    dirty: true,
  });
  expect(state.tabs.find((tab) => tab.path === "a.html")).toMatchObject({
    missing: false,
    dirty: false,
  });
  expect(vi.mocked(api.openDocument).mock.calls).toHaveLength(opened + 1);
  expect(state.closed).toEqual([{ path: "c.html", column: 0 }]);
  expect(state.actionMessage).toContain("ごみ箱に移動しました");
  controller.stop();
});

it("failed trash keeps tree and opened views intact, reports error and permits retry", async () => {
  const { controller } = fixture(true);
  await controller.start();
  await controller.select("a.html");
  const before = controller.getSnapshot();
  expect(await controller.mutateTree({ kind: "trash", source: "a.html", revision: 1 })).toContain(
    "ごみ箱を利用できません",
  );
  const after = controller.getSnapshot();
  expect(after.snapshot).toBe(before.snapshot);
  expect(after.tabs).toBe(before.tabs);
  expect(after.actionBusy).toBe(false);
  controller.stop();
});

it("a same-path recreation cannot resurrect the old trash tab or iframe", async () => {
  const { controller } = fixture(false, true);
  await controller.start();
  await controller.select("a.html");
  expect(await controller.mutateTree({ kind: "trash", source: "a.html", revision: 1 })).toBeNull();
  expect(controller.getSnapshot().tabs[0]).toMatchObject({ missing: true, url: null, dirty: true });
  expect(
    controller.getSnapshot().snapshot.nodes.some((node) => node.relativePath === "a.html"),
  ).toBe(true);
  controller.stop();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = async () => {
  await new Promise((done) => setTimeout(done, 0));
};

for (const order of [
  "before-response",
  "before-response-inflight",
  "after-response",
  "response-before-event-scan",
] as const) {
  it(`folder trash reloads each visible survivor once with ${order}`, async () => {
    const { api, controller, emit, update } = fixture();
    const initial = await api.getTree();
    initial.nodes.push({
      name: "Folder",
      relativePath: "Folder",
      kind: "folder",
      children: [
        { name: "child.html", relativePath: "Folder/child.html", kind: "html", children: [] },
      ],
    });
    await controller.start();
    await controller.openInColumn("a.html", 0);
    await controller.openInColumn("b.html", 1);
    await controller.openInColumn("c.html", 1);
    await controller.openInColumn("Folder/child.html", 1);
    await controller.openInColumn("b.html", 1);
    const tabs = controller.getSnapshot().tabs;
    const visible = tabs.filter((tab) => ["a.html", "b.html"].includes(tab.path));
    const hidden = tabs.find((tab) => tab.path === "c.html")!;
    const victim = tabs.find((tab) => tab.path === "Folder/child.html")!;
    const native = new Map<string, string>();
    for (const call of vi.mocked(api.createTab).mock.calls) {
      const index = vi.mocked(api.createTab).mock.calls.indexOf(call);
      native.set(call[2], await vi.mocked(api.createTab).mock.results[index].value);
    }
    const before = vi.mocked(api.openDocument).mock.calls.length;
    const next: Snapshot = {
      ...initial,
      revision: 2,
      nodes: initial.nodes.filter((node) => node.relativePath !== "Folder"),
    };
    const response = deferred<{
      snapshot: Snapshot;
      createdPath: null;
      moves: [];
      warning: null;
    }>();
    const reload = deferred<string>();
    const scan = deferred<Snapshot>();
    vi.mocked(api.mutateTree).mockImplementationOnce(async () => response.promise);
    if (order === "before-response-inflight")
      vi.mocked(api.openDocument).mockImplementation(async (_workspace, _view, tab) => {
        if (tab === native.get("a.html")) return reload.promise;
        return `http://fixture/${tab}/reloaded`;
      });
    if (order === "response-before-event-scan")
      vi.mocked(api.getTree).mockImplementationOnce(async () => scan.promise);
    const mutation = controller.mutateTree({ kind: "trash", source: "Folder", revision: 1 });
    update(next);
    const event: Change = {
      workspaceId: "fixture",
      revision: 2,
      changedPaths: ["Folder"],
      structureChanged: true,
      watchError: null,
      treeOnly: false,
    };
    if (order !== "after-response") {
      emit(event);
      await flush();
    }
    response.resolve({ snapshot: next, createdPath: null, moves: [], warning: null });
    if (order === "before-response-inflight") {
      await flush();
      expect(vi.mocked(api.openDocument).mock.calls.slice(before)).toHaveLength(2);
      reload.resolve("http://fixture/a/once");
    }
    expect(await mutation).toBeNull();
    if (order === "after-response") emit(event);
    if (order === "response-before-event-scan") scan.resolve(next);
    await flush();
    const calls = vi.mocked(api.openDocument).mock.calls.slice(before);
    expect(calls).toHaveLength(2);
    for (const tab of visible)
      expect(calls.filter((call) => call[2] === native.get(tab.path))).toHaveLength(1);
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === hidden.id)).toMatchObject({
      dirty: true,
      missing: false,
      url: hidden.url,
    });
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === victim.id)).toMatchObject({
      missing: true,
      url: null,
    });
    // A distinct later resource change must still reload both visible tabs.
    update({ ...next, revision: 3 });
    emit({ ...event, revision: 3, structureChanged: false, changedPaths: ["shared.css"] });
    await flush();
    expect(vi.mocked(api.openDocument).mock.calls.slice(before)).toHaveLength(4);
    controller.stop();
  });
}
