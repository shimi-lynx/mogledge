import { beforeEach, expect, it, vi } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { searchBridge } from "./bridge";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
beforeEach(() => {
  vi.mocked(invoke).mockClear();
});

it("passes a literal folder and its current view as an optional scope", async () => {
  const scope = { relativePath: "資料/100%_計画", viewId: "view" };
  await searchBridge.search("workspace", "京 rust", 20, 0, "or", scope);
  expect(invoke).toHaveBeenCalledWith("search_documents", {
    workspaceId: "workspace",
    query: "京 rust",
    limit: 20,
    offset: 0,
    mode: "or",
    scope,
  });
});

it("uses only the scoped native search commands and camelCase arguments", async () => {
  await searchBridge.getStatus("workspace");
  await searchBridge.search("workspace", "日本語", 20, 40);
  await searchBridge.rebuild("workspace");
  expect(invoke).toHaveBeenNthCalledWith(1, "get_index_status", { workspaceId: "workspace" });
  expect(invoke).toHaveBeenNthCalledWith(2, "search_documents", {
    workspaceId: "workspace",
    query: "日本語",
    limit: 20,
    offset: 40,
    mode: "and",
  });
  expect(invoke).toHaveBeenNthCalledWith(3, "rebuild_search_index", { workspaceId: "workspace" });
});

it("passes OR as a typed option without changing the IPC command", async () => {
  await searchBridge.search("workspace", "京 rust", 20, 0, "or");
  expect(invoke).toHaveBeenCalledWith("search_documents", {
    workspaceId: "workspace",
    query: "京 rust",
    limit: 20,
    offset: 0,
    mode: "or",
  });
});
