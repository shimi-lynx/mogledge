import { invoke } from "@tauri-apps/api/core";
import type { IndexStatus, SearchBridge, SearchPage } from "./types";

export const searchBridge: SearchBridge = {
  getStatus: (workspaceId) => invoke<IndexStatus>("get_index_status", { workspaceId }),
  search: (workspaceId, query, limit, offset, mode = "and", scope) =>
    invoke<SearchPage>("search_documents", {
      workspaceId,
      query,
      limit,
      offset,
      mode,
      ...(scope ? { scope } : {}),
    }),
  rebuild: (workspaceId) => invoke<IndexStatus>("rebuild_search_index", { workspaceId }),
};
