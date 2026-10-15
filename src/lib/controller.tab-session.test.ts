import { describe, expect, it, vi } from "vite-plus/test";
import { KnowledgeController } from "./controller";
import type { Bridge, Snapshot, TabSession } from "./types";
import { translateUiMessage } from "./i18n";

const item = (index: number, column: 0 | 1 = 0) => ({
  document: { relativePath: `${index}.html`, identity: String(index).padStart(64, "0") },
  column,
  zoom: 125,
});
const session = (): TabSession => ({
  items: [...Array.from({ length: 100 }, (_, index) => item(index)), item(0, 1)],
  active: [3, 100],
  activeColumn: 1,
  split: true,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 220));
function fixture(saved: TabSession | null = session()) {
  let snapshot: Snapshot = {
    workspaceId: "root",
    viewId: "view",
    rootPath: "/fixture",
    revision: 1,
    nodes: Array.from({ length: 100 }, (_, index) => ({
      relativePath: `${index}.html`,
      name: `${index}.html`,
      kind: "html",
      children: [],
    })),
    watchError: null,
  };
  let serial = 0;
  const paths = new Map<string, string>();
  const api: Bridge = {
    beginView: vi.fn(async () => snapshot),
    getTree: vi.fn(async () => snapshot),
    chooseRoot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    listen: vi.fn(async () => () => {}),
    createTab: vi.fn(async (_workspace, _view, path) => {
      const id = `native-${++serial}`;
      paths.set(id, path);
      return id;
    }),
    openDocument: vi.fn(async (_workspace, _view, id) => `http://fixture/s/${id}/${paths.get(id)}`),
    closeTab: vi.fn(async () => {}),
    getTabSession: vi.fn(async () => saved),
    captureTabSession: vi.fn(async () => {}),
    mutateTree: vi.fn(async () => ({ snapshot, moves: [], createdPath: null, warning: null })),
    performFileAction: vi.fn(async () => {}),
  };
  return {
    api,
    controller: new KnowledgeController(api),
    change: (next: Partial<Snapshot>) => {
      snapshot = { ...snapshot, ...next };
    },
  };
}
describe("automatic tab session", () => {
  it.each(["read", "registration"])(
    "does not let a never-admitted %s error tab block Quit or root switching",
    async (failure) => {
      const { controller, api } = fixture(null);
      const create = api.createTab;
      api.createTab = vi.fn(async (workspace, view, path) => {
        if (failure === "registration" && path === "1.html") throw new Error("InvalidUtf8");
        return create(workspace, view, path);
      });
      api.openDocument = vi.fn(async (_workspace, _view, id) => {
        if (id === "native-2") throw new Error("InvalidUtf8");
        return `http://fixture/s/${id}/0.html`;
      });
      api.captureTabSession = vi.fn<NonNullable<Bridge["captureTabSession"]>>(
        async (_workspace, _view, items) => {
          if (items.some((item) => item.tabId === "native-2")) throw new Error("TabSessionInvalid");
        },
      );
      await controller.start();
      await controller.select("0.html");
      await controller.select("1.html");
      expect(controller.getSnapshot().tabs[1].error).toContain("InvalidUtf8");
      expect(await controller.flushTabSession()).toBe(true);
      const capture = vi.mocked(api.captureTabSession!).mock.calls.at(-1)!;
      expect(capture[2]).toEqual([{ tabId: "native-1", column: 0, zoom: 100 }]);
      expect(capture[3]).toEqual([0, null]);
      controller.openHelp();
      expect(await controller.flushTabSession()).toBe(true);
      expect(vi.mocked(api.captureTabSession!).mock.calls.at(-1)![6]).toEqual({
        index: 1,
        column: 0,
        zoom: 100,
        active: true,
      });
      await controller.registerRoot();
      expect(api.chooseRoot).toHaveBeenCalledTimes(1);
      controller.stop();
    },
  );
  it("includes an initially failed tab after a successful retry and retains it after later failures", async () => {
    const { controller, api } = fixture(null);
    api.openDocument = vi
      .fn()
      .mockRejectedValueOnce("InvalidUtf8")
      .mockResolvedValueOnce("http://fixture/s/native-1/0.html")
      .mockRejectedValueOnce("MissingFile");
    await controller.start();
    await controller.select("0.html");
    expect(await controller.flushTabSession()).toBe(true);
    expect(vi.mocked(api.captureTabSession!).mock.calls.at(-1)![2]).toEqual([]);
    const tab = controller.getSnapshot().tabs[0];
    await controller.reload(tab.id);
    expect(await controller.flushTabSession()).toBe(true);
    expect(vi.mocked(api.captureTabSession!).mock.calls.at(-1)![2][0].tabId).toBe("native-1");
    await controller.reload(tab.id);
    controller.zoomTab(tab.id, "in");
    expect(await controller.flushTabSession()).toBe(true);
    expect(vi.mocked(api.captureTabSession!).mock.calls.at(-1)![2][0].tabId).toBe("native-1");
    controller.stop();
  });
  it("restores 101 ordered tabs, independent duplicate panes, zoom and active column with only two grants", async () => {
    const { controller, api } = fixture();
    await controller.start();
    await flush();
    const state = controller.getSnapshot();
    expect(state.tabs).toHaveLength(101);
    expect(state.tabs.map((tab) => tab.path)).toEqual(
      session().items.map((item) => item.document.relativePath),
    );
    expect(state.columns).toEqual([state.tabs[3].id, state.tabs[100].id]);
    expect(state.activeColumn).toBe(1);
    expect(state.split).toBe(true);
    expect(state.tabs.every((tab) => tab.zoom === 125)).toBe(true);
    expect(api.createTab).toHaveBeenCalledTimes(2);
    expect(state.tabs.filter((tab) => tab.deferred)).toHaveLength(99);
    controller.activate(state.tabs[99].id);
    await flush();
    expect(api.createTab).toHaveBeenCalledTimes(3);
    controller.stop();
  });
  it("keeps missing tabs as placeholders without preventing the other visible pane from loading", async () => {
    const saved = session();
    saved.items[3] = item(999);
    const { controller, api } = fixture(saved);
    await controller.start();
    await flush();
    expect(controller.getSnapshot().tabs[3].missing).toBe(true);
    expect(api.createTab).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().loading).toBe(false);
    controller.stop();
  });
  it("restores the help tab at its original position and focus", async () => {
    const saved = session();
    saved.help = { index: 2, column: 0, zoom: 100, active: true };
    const { controller, api } = fixture(saved);
    await controller.start();
    await flush();
    expect(controller.getSnapshot().tabs[2].kind).toBe("help");
    expect(controller.getSnapshot().columns[0]).toBe("app-help");
    expect(api.createTab).toHaveBeenCalledTimes(1);
    controller.stop();
  });
  it("never overwrites a failed read or saves the empty stop layout", async () => {
    const { controller, api } = fixture();
    api.getTabSession = vi.fn(async () => {
      throw new Error("blocked");
    });
    await controller.start();
    await controller.select("0.html");
    await flush();
    expect(api.captureTabSession).not.toHaveBeenCalled();
    controller.stop();
    await flush();
    expect(api.captureTabSession).not.toHaveBeenCalled();
  });
  it("coalesces layout changes and saves an explicitly emptied session", async () => {
    const saved = {
      ...session(),
      items: [item(0)],
      active: [0, null] as [number, null],
      split: false,
      activeColumn: 0 as const,
    };
    const { controller, api } = fixture(saved);
    await controller.start();
    await flush();
    vi.mocked(api.captureTabSession!).mockClear();
    const id = controller.getSnapshot().tabs[0].id;
    controller.zoomTab(id, "in");
    controller.zoomTab(id, "in");
    await flush();
    expect(api.captureTabSession).toHaveBeenCalledTimes(1);
    await controller.closeTab(id);
    await flush();
    expect(api.captureTabSession).toHaveBeenLastCalledWith(
      "root",
      "view",
      [],
      [null, null],
      0,
      false,
      null,
    );
    const count = vi.mocked(api.captureTabSession!).mock.calls.length;
    controller.stop();
    await flush();
    expect(api.captureTabSession).toHaveBeenCalledTimes(count);
  });
  it("ignores a stale root session response", async () => {
    const { controller, api, change } = fixture();
    let respond!: (value: TabSession) => void;
    api.getTabSession = vi.fn((_workspace) =>
      _workspace === "root"
        ? new Promise<TabSession>((resolve) => {
            respond = resolve;
          })
        : Promise.resolve(null),
    );
    await controller.start();
    change({ workspaceId: "other", viewId: "other-view", rootPath: "/other" });
    controller.stop();
    await controller.start();
    respond(session());
    await flush();
    expect(controller.getSnapshot().tabs).toEqual([]);
    expect(api.createTab).not.toHaveBeenCalled();
    controller.stop();
  });
  it("shows session failures in English and Japanese", () => {
    expect(translateUiMessage("前回のタブを復元できません: TabSessionReadFailed", "en")).toBe(
      "Could not restore the previous tabs: Could not read the tab layout",
    );
    expect(translateUiMessage("タブの状態を保存できません: TabSessionSaveFailed", "ja")).toBe(
      "タブの状態を保存できません: TabSessionSaveFailed",
    );
  });
  it("preserves right-pane assignments and duplicate identities while split is collapsed", async () => {
    const { controller, api } = fixture();
    await controller.start();
    await flush();
    controller.toggleSplit();
    await flush();
    const call = vi.mocked(api.captureTabSession!).mock.calls.at(-1)!;
    expect(call[2][100].column).toBe(1);
    expect(call[3][1]).toBeNull();
    expect(call[5]).toBe(false);
    controller.stop();
  });
  it("preserves independent duplicate views moved into the same pane", async () => {
    const { controller, api } = fixture();
    await controller.start();
    await flush();
    controller.moveTab(controller.getSnapshot().tabs[100].id, 0);
    await flush();
    const items = vi.mocked(api.captureTabSession!).mock.calls.at(-1)![2];
    expect(items[0].column).toBe(0);
    expect(items[100].column).toBe(0);
    expect(controller.getSnapshot().tabs).toHaveLength(101);
    controller.stop();
  });
  it("waits for an in-flight capture before switching roots", async () => {
    const { controller, api } = fixture(null);
    let finish!: () => void;
    api.captureTabSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await controller.start();
    await controller.select("0.html");
    await flush();
    const switching = controller.registerRoot();
    await flush();
    expect(api.chooseRoot).not.toHaveBeenCalled();
    finish();
    await switching;
    expect(api.chooseRoot).toHaveBeenCalledTimes(1);
    controller.stop();
  });
  it("retains a new renderer's queued layout after an old capture rejects", async () => {
    const { controller, api, change } = fixture(null);
    let reject!: (error: Error) => void;
    api.captureTabSession = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    await controller.start();
    await controller.select("0.html");
    await flush();
    controller.stop();
    change({ workspaceId: "other", viewId: "new-view" });
    await controller.start();
    await controller.select("1.html");
    await flush();
    reject(new Error("old view"));
    await flush();
    await flush();
    expect(api.captureTabSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.captureTabSession!).mock.calls[1][0]).toBe("other");
    controller.stop();
  });
  it("bounds a never-resolving capture and does not switch roots on failed flush", async () => {
    const { controller, api } = fixture(null);
    api.captureTabSession = vi.fn(() => new Promise<void>(() => {}));
    await controller.start();
    await controller.select("0.html");
    await flush();
    vi.useFakeTimers();
    try {
      const switching = controller.registerRoot();
      await vi.advanceTimersByTimeAsync(2500);
      await switching;
      expect(api.chooseRoot).not.toHaveBeenCalled();
      expect(controller.getSnapshot().error).toContain("TabSessionSaveFailed");
    } finally {
      vi.useRealTimers();
      controller.stop();
    }
  });
  it("waits for a newly opened document before flushing its admitted reference", async () => {
    const { controller, api } = fixture(null);
    let finish!: (url: string) => void;
    api.openDocument = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    await controller.start();
    const opening = controller.select("0.html");
    await flush();
    let completed = false;
    const saving = controller.flushTabSession().then((success) => {
      completed = true;
      return success;
    });
    await flush();
    expect(completed).toBe(false);
    finish("http://fixture/s/native-1/0.html");
    await opening;
    expect(await saving).toBe(true);
    expect(api.captureTabSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.captureTabSession!).mock.calls[0][2][0].tabId).toBe("native-1");
    controller.stop();
  });
  it("debounces distinct rapid layout events and bypasses the delay for explicit flushing", async () => {
    const saved = {
      ...session(),
      items: [item(0)],
      active: [0, null] as [number, null],
      split: false,
      activeColumn: 0 as const,
    };
    const { controller, api } = fixture(saved);
    await controller.start();
    await flush();
    vi.mocked(api.captureTabSession!).mockClear();
    const tab = controller.getSnapshot().tabs[0];
    vi.useFakeTimers();
    try {
      controller.zoomTab(tab.id, "in");
      await vi.advanceTimersByTimeAsync(100);
      controller.zoomTab(tab.id, "in");
      await vi.advanceTimersByTimeAsync(199);
      expect(api.captureTabSession).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(api.captureTabSession).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.captureTabSession!).mock.calls[0][2][0].zoom).toBe(
        controller.getSnapshot().tabs[0].zoom,
      );
      vi.mocked(api.captureTabSession!).mockClear();
      controller.documentReady(tab.id, tab.url!);
      document.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(500);
      expect(api.captureTabSession).not.toHaveBeenCalled();
      controller.zoomTab(tab.id, "out");
      expect(await controller.flushTabSession()).toBe(true);
      expect(api.captureTabSession).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      controller.stop();
    }
  });
});
