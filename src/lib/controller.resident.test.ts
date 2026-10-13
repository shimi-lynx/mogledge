import { afterEach, expect, test, vi } from "vite-plus/test";
import { KnowledgeController } from "./controller";
import type { Bridge, Snapshot } from "./types";
import type { ResidentSelection } from "./resident";

const controllers: KnowledgeController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
});
async function setup() {
  let snapshot: Snapshot = {
    workspaceId: "root",
    rootPath: "/fixture",
    viewId: "view",
    revision: 1,
    nodes: ["a.html", "b.html"].map((relativePath) => ({
      relativePath,
      name: relativePath,
      kind: "html",
      children: [],
    })),
    watchError: null,
  };
  let serial = 0;
  const bridge: Bridge = {
    beginView: vi.fn(async () => snapshot),
    getTree: vi.fn(async () => snapshot),
    chooseRoot: vi.fn(async () => snapshot),
    refresh: vi.fn(async () => snapshot),
    createTab: vi.fn(async () => `native-${++serial}`),
    closeTab: vi.fn(async () => {}),
    openDocument: vi.fn(async (_, __, id) => `http://fixture/${id}`),
    listen: vi.fn(async () => vi.fn()),
    performFileAction: vi.fn(async () => {}),
    mutateTree: vi.fn(async () => ({ snapshot, createdPath: null, moves: [], warning: null })),
    validateDocumentNavigation: vi.fn(async (_, __, path) => ({
      relativePath: path,
      identity: "a".repeat(64),
    })),
  };
  const controller = new KnowledgeController(bridge);
  controllers.push(controller);
  await controller.start();
  return {
    controller,
    bridge,
    update: (patch: Partial<Snapshot>) => {
      snapshot = { ...snapshot, ...patch };
    },
  };
}
const selected: ResidentSelection = {
  workspaceId: "root",
  viewId: "view",
  revision: 1,
  document: { relativePath: "a.html", identity: "a".repeat(64) },
  fallback: false,
};

test("reuses a verified tab in the other column without creating or reloading an iframe", async () => {
  const { controller, bridge } = await setup();
  await controller.select("a.html", 0);
  const tab = controller.getSnapshot().tabs[0];
  await controller.select("b.html", 1);
  const calls = vi.mocked(bridge.openDocument).mock.calls.length;
  const resolve = vi.fn(async () => selected);
  expect(await controller.selectResidentDocument(resolve)).toBe(true);
  expect(controller.getSnapshot().tabs).toHaveLength(2);
  expect(controller.getSnapshot().columns[0]).toBe(tab.id);
  expect(controller.getSnapshot().activeColumn).toBe(0);
  expect(resolve.mock.calls).toEqual([[], ["native-1"]]);
  expect(bridge.createTab).toHaveBeenCalledTimes(2);
  expect(bridge.openDocument).toHaveBeenCalledTimes(calls);
});
test("stale root responses and unavailable targets keep the existing display", async () => {
  const { controller, bridge, update } = await setup();
  await controller.select("b.html");
  const before = controller.getSnapshot().tabs[0];
  expect(
    await controller.selectResidentDocument(async () => ({
      ...selected,
      document: null,
      fallback: true,
    })),
  ).toBe(true);
  expect(controller.getSnapshot().tabs[0]).toBe(before);
  expect(controller.getSnapshot().actionMessage).toContain("現在の表示");
  let finish: (selection: ResidentSelection) => void = () => {};
  const pending = controller.selectResidentDocument(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  update({ workspaceId: "another-root" });
  await controller.refresh();
  finish(selected);
  expect(await pending).toBe(false);
  expect(bridge.createTab).toHaveBeenCalledTimes(1);
});
test("a second native validation failure cannot activate or replace an existing tab", async () => {
  const { controller, bridge } = await setup();
  await controller.select("a.html", 0);
  await controller.select("b.html", 1);
  const before = controller.getSnapshot();
  const resolve = vi
    .fn()
    .mockResolvedValueOnce(selected)
    .mockResolvedValueOnce({ ...selected, document: null, fallback: true });
  expect(await controller.selectResidentDocument(resolve)).toBe(false);
  expect(controller.getSnapshot().activeColumn).toBe(before.activeColumn);
  expect(controller.getSnapshot().tabs).toBe(before.tabs);
  expect(bridge.createTab).toHaveBeenCalledTimes(2);
});
for (const closeTarget of [false, true]) {
  test(`resident intent cancels pending history before a late fragment ACK/readiness (closed target: ${closeTarget})`, async () => {
    const { controller, bridge } = await setup();
    await controller.select("a.html");
    const a = controller.getSnapshot().tabs[0];
    controller.documentReady(a.id, a.url!);
    await controller.followDocumentLink(a.id, a.url!, { kind: "page", fragment: "#chapter" });
    const initialRequest = controller.getSnapshot().tabs[0].navigation!.request;
    controller.documentAnchorResult(a.id, a.url!, initialRequest, true);
    await controller.select("b.html");
    const b = controller.getSnapshot().tabs.find((tab) => tab.path === "b.html")!;
    controller.documentReady(b.id, b.url!);
    if (closeTarget) await controller.closeTab(a.id);
    await controller.navigateHistory("back");
    const pending = controller.getSnapshot().tabs.find((tab) => tab.path === "a.html")!;
    const anchorRequest = pending.navigation!.request;
    let finish!: (value: ResidentSelection) => void;
    const resident = controller.selectResidentDocument(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    controller.documentAnchorResult(pending.id, pending.url!, anchorRequest, true);
    controller.documentReady(pending.id, pending.url!);
    expect(controller.getSnapshot().columns[0]).toBe(b.id);
    expect(controller.getSnapshot().navigationHistory![0].cursor).toBe(1);
    finish({ ...selected, document: null, fallback: false });
    expect(await resident).toBe(true);
    expect(controller.getSnapshot().columns[0]).toBe(b.id);
    expect(bridge.openDocument).toHaveBeenCalledTimes(closeTarget ? 3 : 2);
  });
}
