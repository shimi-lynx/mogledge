import { expect, it, vi } from "vite-plus/test";
import type { TransferPreview, TransferReceipt } from "./stateTransfer";
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
    recordDocumentDisplay: vi.fn(async () => {}),
    chooseStateTransferFile: vi.fn(async (_context, kind) => ({
      fileId: "file",
      name: "state.json",
      kind,
    })),
    prepareStateTransfer: vi.fn(),
    confirmStateTransfer: vi.fn(),
    cancelStateTransfer: vi.fn(async () => ({ status: "cancelled" as const })),
    verifyStateTransfer: vi.fn(),
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
    mutateTree: vi.fn(async () => ({ snapshot, moves: [], createdPath: null, warning: null })),
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

const preview: TransferPreview = {
  context: { workspaceId: "root", viewId: "view" },
  planId: "plan",
  operation: "import",
  documentIdentity: "0".repeat(64),
  logicalBytes: 10,
  incomingApps: [],
  replacesExisting: false,
  backupRequired: false,
  stopReloadRequired: true,
  affectedViews: ["native-1", "native-2"].map((tabId) => ({
    tabId,
    documentIdentity: "0".repeat(64),
    matchesTargetIdentity: true,
    visibility: "active",
    saveAcknowledgement: "unknown",
  })),
  browserGrants: 1,
  openingRequests: 0,
  unflushedInput: "unknown",
};
const receipt: TransferReceipt = {
  context: preview.context,
  operation: "import",
  operationId: "plan",
  documentIdentity: preview.documentIdentity,
  reloadTabIds: ["native-1", "native-2", "browser", "placeholder"],
  revokedBrowserGrants: 1,
};
async function prepared() {
  const fixture = setup(workingSet(3));
  const { api, controller } = fixture;
  vi.mocked(api.prepareStateTransfer!).mockResolvedValue(structuredClone(preview));
  vi.mocked(api.confirmStateTransfer!).mockResolvedValue(structuredClone(receipt));
  await controller.start();
  await controller.restoreWorkspaceSet("set");
  await flush();
  const ready = () => {
    for (const tab of controller.getSnapshot().tabs)
      if (tab.url) controller.documentReady(tab.id, tab.url);
  };
  ready();
  await controller.openInColumn("0.html", 1);
  ready();
  await flush();
  return { ...fixture, ready };
}
it("reloads only receipt-matched real views with Native expected identity, keeping placeholders, zoom, columns, history and recent unchanged", async () => {
  const { api, controller, ready } = await prepared();
  const before = controller.getSnapshot();
  const columns = [...before.columns];
  const histories = before.navigationHistory;
  const visits = vi.mocked(api.recordDocumentDisplay!).mock.calls.length;
  const opens = vi.mocked(api.openDocument).mock.calls.length;
  controller.beginStateTransfer("0.html", "import");
  controller.beginStateTransfer("0.html", "import");
  await flush();
  expect(api.chooseStateTransferFile).toHaveBeenCalledOnce();
  expect(api.prepareStateTransfer).toHaveBeenCalledWith(
    expect.objectContaining({ activeTabIds: ["native-1", "native-2"] }),
  );
  await controller.confirmStateTransfer(false, true);
  ready();
  await flush();
  expect(vi.mocked(api.openDocument).mock.calls.length).toBe(opens + 2);
  expect(api.createTab).toHaveBeenLastCalledWith(
    "root",
    "view",
    "0.html",
    preview.documentIdentity,
  );
  expect(controller.getSnapshot().tabs.filter((tab) => tab.deferred)).toHaveLength(2);
  expect(controller.getSnapshot().columns).toEqual(columns);
  expect(controller.getSnapshot().tabs[0].zoom).toBe(125);
  expect(controller.getSnapshot().navigationHistory?.map((h) => h.entries)).toEqual(
    histories?.map((h) => h.entries),
  );
  expect(vi.mocked(api.recordDocumentDisplay!).mock.calls.length).toBe(visits);
  expect(controller.getSnapshot().stateTransfer?.phase).toBe("completed");
  controller.dismissStateTransfer();
  controller.stop();
});
it("skips closed, changed-URL and different-identity views at receipt time", async () => {
  for (const change of ["closed", "url", "identity"]) {
    const { api, controller, ready } = await prepared();
    if (change === "identity")
      vi.mocked(api.prepareStateTransfer!).mockResolvedValue({
        ...preview,
        affectedViews: preview.affectedViews.map((v, index) =>
          index === 0 ? { ...v, documentIdentity: "old", matchesTargetIdentity: false } : v,
        ),
      });
    let finish!: (value: TransferReceipt) => void;
    vi.mocked(api.confirmStateTransfer!).mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    controller.beginStateTransfer("0.html", "import");
    await flush();
    const pending = controller.confirmStateTransfer(false, true);
    const left = controller.getSnapshot().columns[0]!;
    if (change === "closed") await controller.closeTab(left);
    if (change === "url") {
      await controller.reload(left, "background");
      ready();
    }
    await flush();
    const count = vi.mocked(api.openDocument).mock.calls.length;
    finish(receipt);
    await pending;
    expect(vi.mocked(api.openDocument).mock.calls.length).toBe(count + 1);
    expect(controller.getSnapshot().tabs.filter((tab) => tab.deferred)).toHaveLength(
      change === "closed" ? 1 : 2,
    );
    controller.stop();
  }
});
it("does not apply a late receipt after context invalidation", async () => {
  const { api, controller, update } = await prepared();
  let finish!: (value: TransferReceipt) => void;
  vi.mocked(api.confirmStateTransfer!).mockReturnValue(
    new Promise((resolve) => (finish = resolve)),
  );
  controller.beginStateTransfer("0.html", "import");
  await flush();
  const pending = controller.confirmStateTransfer(false, true);
  update({ workspaceId: "next", viewId: "next-view" });
  await controller.choose();
  const count = vi.mocked(api.openDocument).mock.calls.length;
  finish(receipt);
  await pending;
  expect(vi.mocked(api.openDocument).mock.calls.length).toBe(count);
  expect(controller.getSnapshot().stateTransfer).toBeUndefined();
  controller.stop();
});

it("owns a recoverable new Native ID before old-close response loss or a concurrent watcher reload", async () => {
  for (const race of ["lost", "reload"]) {
    const { api, controller } = await prepared();
    const left = controller.getSnapshot().columns[0]!;
    const live = new Set(["native-1", "native-2"]);
    vi.mocked(api.createTab).mockImplementation(async () => {
      const id = "replacement-" + live.size;
      live.add(id);
      return id;
    });
    vi.mocked(api.openDocument).mockImplementation(async (_w, _v, id, request) => {
      if (!live.has(id)) throw new Error("TabClosed");
      return `http://fixture/s/${id}/0.html?r=${request}`;
    });
    let resolveClose!: () => void;
    vi.mocked(api.closeTab).mockImplementation(async (_w, _v, id) => {
      live.delete(id);
      if (id !== "native-1") return;
      if (race === "lost") throw new Error("IPC lost after close");
      await new Promise<void>((resolve) => (resolveClose = resolve));
    });
    controller.beginStateTransfer("0.html", "import");
    await flush();
    const pending = controller.confirmStateTransfer(false, true);
    await flush();
    if (race === "reload") {
      await controller.reload(left, "background");
      resolveClose();
    }
    await pending;
    await controller.reload(left, "user-reload");
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === left)?.error).toBeNull();
    expect(controller.getSnapshot().tabs.find((tab) => tab.id === left)?.url).toContain(
      "replacement-",
    );
    expect(controller.getSnapshot().stateTransfer?.phase).toBe("completed");
    if (race === "lost")
      expect(controller.getSnapshot().stateTransfer?.message).toContain("旧view解除");
    controller.stop();
  }
});
