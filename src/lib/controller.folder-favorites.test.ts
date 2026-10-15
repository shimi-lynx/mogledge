import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { KnowledgeController } from "./controller";
import type { Bridge, Snapshot, WorkspaceLists } from "./types";

const folder = { relativePath: "日本語資料", identity: "f".repeat(64) };
const lists: WorkspaceLists = {
  favorites: [],
  folderFavorites: [{ ...folder, status: "available" }],
  recent: [],
  error: null,
  readOnly: false,
};
const controllers: KnowledgeController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
});
function setup() {
  let snapshot: Snapshot = {
    workspaceId: "root-one",
    viewId: "view-one",
    rootPath: "/fixture",
    revision: 1,
    watchError: null,
    nodes: [
      {
        name: folder.relativePath,
        relativePath: folder.relativePath,
        kind: "folder",
        children: [],
      },
      { name: "a.html", relativePath: "a.html", kind: "html", children: [] },
      { name: "b.html", relativePath: "b.html", kind: "html", children: [] },
    ],
  };
  let nativeCount = 0;
  const paths = new Map<string, string>();
  const api: Bridge = {
    beginView: vi.fn(async () => snapshot),
    getTree: vi.fn(async () => snapshot),
    chooseRoot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    mutateTree: vi.fn(async () => ({ snapshot, createdPath: null, moves: [], warning: null })),
    performFileAction: vi.fn(async () => {}),
    createTab: vi.fn(async (_workspace, _view, path) => {
      const id = `native-${++nativeCount}`;
      paths.set(id, path);
      return id;
    }),
    closeTab: vi.fn(async () => {}),
    openDocument: vi.fn(
      async (_workspace, _view, id, request) => `http://fixture/${paths.get(id)}?r=${request}`,
    ),
    listen: vi.fn(async () => vi.fn()),
    getWorkspaceLists: vi.fn(async () => lists),
    validateWorkspaceFolder: vi.fn(async () => folder.relativePath),
    setDocumentFavorite: vi.fn(async () => lists),
  };
  const controller = new KnowledgeController(api);
  controllers.push(controller);
  return {
    api,
    controller,
    update: (patch: Partial<Snapshot>) => {
      snapshot = { ...snapshot, ...patch };
    },
  };
}

describe("folder favorites", () => {
  it("returns a verified tree selection and keeps the active document and Native grants intact", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.select("a.html");
    controller.zoomTab(controller.getSnapshot().tabs[0].id, "in");
    const before = controller.getSnapshot();
    expect(await controller.selectWorkspaceFolder(folder)).toEqual({
      relativePath: folder.relativePath,
      workspaceId: "root-one",
      viewId: "view-one",
      revision: 1,
    });
    expect(api.validateWorkspaceFolder).toHaveBeenCalledWith("root-one", "view-one", folder);
    expect(controller.getSnapshot().tabs).toEqual(before.tabs);
    expect(controller.getSnapshot().columns).toEqual(before.columns);
    expect(controller.getSnapshot().selectedPath).toBe("a.html");
    expect(api.createTab).toHaveBeenCalledTimes(1);
    expect(api.openDocument).toHaveBeenCalledTimes(1);
  });
  it("discards cancellation and late responses after another list selection", async () => {
    const { api, controller } = setup();
    await controller.start();
    const responses: ((path: string) => void)[] = [];
    api.validateWorkspaceFolder = vi.fn(
      () => new Promise<string>((resolve) => responses.push(resolve)),
    );
    const first = controller.selectWorkspaceFolder(folder);
    const second = controller.selectWorkspaceFolder(folder);
    responses[1](folder.relativePath);
    expect(await second).not.toBeNull();
    responses[0](folder.relativePath);
    expect(await first).toBeNull();
    const cancelled = controller.selectWorkspaceFolder(folder);
    controller.cancelWorkspaceSelection();
    responses[2](folder.relativePath);
    expect(await cancelled).toBeNull();
    expect(api.createTab).not.toHaveBeenCalled();
    expect(api.openDocument).not.toHaveBeenCalled();
  });
  it("rejects delayed folder responses after tree revision or root changes", async () => {
    const { api, controller, update } = setup();
    await controller.start();
    let respond!: (path: string) => void;
    api.validateWorkspaceFolder = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          respond = resolve;
        }),
    );
    const staleTree = controller.selectWorkspaceFolder(folder);
    update({ revision: 2 });
    await controller.refresh();
    respond(folder.relativePath);
    expect(await staleTree).toBeNull();
    const staleRoot = controller.selectWorkspaceFolder(folder);
    update({ workspaceId: "root-two", viewId: "view-two", rootPath: "/other-fixture" });
    await controller.registerRoot();
    respond(folder.relativePath);
    expect(await staleRoot).toBeNull();
    expect(api.createTab).not.toHaveBeenCalled();
  });
  it("rejects document, changed path, unavailable Native and failed validation without creating tabs", async () => {
    const { api, controller } = setup();
    await controller.start();
    api.validateWorkspaceFolder = vi.fn(async () => "a.html");
    expect(
      await controller.selectWorkspaceFolder({ relativePath: "a.html", identity: folder.identity }),
    ).toBeNull();
    expect(await controller.selectWorkspaceFolder(folder)).toBeNull();
    api.validateWorkspaceFolder = vi.fn(async () => {
      throw new Error("replaced");
    });
    expect(await controller.selectWorkspaceFolder(folder)).toBeNull();
    expect(controller.getSnapshot().error).toContain("replaced");
    api.validateWorkspaceFolder = undefined;
    expect(await controller.selectWorkspaceFolder(folder)).toBeNull();
    expect(api.createTab).not.toHaveBeenCalled();
    expect(api.openDocument).not.toHaveBeenCalled();
  });
  it("cancels pending history before folder validation so late ready and fragment ACK cannot change the document", async () => {
    const { api, controller } = setup();
    api.validateDocumentNavigation = vi.fn(async (_workspace, _view, path) => ({
      relativePath: path,
      identity: "a".repeat(64),
    }));
    api.recordDocumentDisplay = vi.fn(async () => {});
    await controller.start();
    await controller.select("a.html");
    const a = controller.getSnapshot().tabs[0];
    controller.documentReady(a.id, a.url!);
    await controller.followDocumentLink(a.id, a.url!, { kind: "page", fragment: "#chapter" });
    const initialAnchor = controller.getSnapshot().tabs.find((tab) => tab.id === a.id)!.navigation!;
    controller.documentAnchorResult(a.id, a.url!, initialAnchor.request, true);
    await controller.select("b.html");
    const b = controller.getSnapshot().tabs.find((tab) => tab.path === "b.html")!;
    controller.documentReady(b.id, b.url!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.navigateHistory("back");
    const oldRequest = controller.getSnapshot().tabs.find((tab) => tab.id === a.id)!
      .navigation!.request;
    const before = controller.getSnapshot();
    const cursor = before.navigationHistory![0].cursor;
    let complete!: (path: string) => void;
    api.validateWorkspaceFolder = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    vi.mocked(api.recordDocumentDisplay).mockClear();
    const selecting = controller.selectWorkspaceFolder(folder);
    controller.documentAnchorResult(a.id, a.url!, oldRequest, true);
    controller.documentReady(a.id, a.url!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getSnapshot().columns).toEqual(before.columns);
    expect(controller.getSnapshot().selectedPath).toBe("b.html");
    expect(controller.getSnapshot().navigationHistory![0].cursor).toBe(cursor);
    expect(api.recordDocumentDisplay).not.toHaveBeenCalled();
    complete(folder.relativePath);
    expect(await selecting).not.toBeNull();
    expect(controller.getSnapshot().selectedPath).toBe("b.html");
  });
  it("uses the existing favorite write boundary and retains folder list on write failure", async () => {
    const { api, controller } = setup();
    await controller.start();
    await controller.refreshWorkspaceLists();
    await controller.setFavorite(folder.relativePath, true);
    expect(api.setDocumentFavorite).toHaveBeenCalledWith(
      "root-one",
      "view-one",
      folder.relativePath,
      true,
    );
    api.setDocumentFavorite = vi.fn(async () => {
      throw new Error("save failed");
    });
    await controller.setFavorite(folder.relativePath, false);
    expect(controller.getSnapshot().workspaceLists?.folderFavorites).toEqual(lists.folderFavorites);
    expect(controller.getSnapshot().actionBusy).toBe(false);
    expect(controller.getSnapshot().error).toContain("save failed");
  });
});
