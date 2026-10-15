import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AiHandoffApi } from "./aiHandoff";
import type {
  Bridge,
  WorkspaceDocument,
  Change,
  DocumentLinkTarget,
  RecoveryCandidate,
  Snapshot,
  WorkspaceLists,
  WorkspaceSets,
  ResolvedWorkspaceSet,
} from "./types";

export const aiHandoffApi: AiHandoffApi = {
  prepare: (context) => invoke("prepare_ai_handoff", { context }),
  perform: (request) => invoke("perform_ai_handoff", { request }),
};

export const bridge: Bridge = {
  chooseStateTransferFile: (context, kind) =>
    invoke("choose_state_transfer_file", { context, kind }),
  prepareStateTransfer: (request) => invoke("prepare_state_transfer", { request }),
  confirmStateTransfer: (confirmation) => invoke("confirm_state_transfer", { confirmation }),
  cancelStateTransfer: (context, planId) => invoke("cancel_state_transfer", { context, planId }),
  verifyStateTransfer: (request) => invoke("verify_state_transfer", { request }),
  validateDocumentNavigation: (workspaceId, viewId, relativePath, fragment, tabId) =>
    invoke<WorkspaceDocument>("validate_document_navigation", {
      workspaceId,
      viewId,
      relativePath,
      fragment,
      tabId,
    }),
  listenSessionFlush: async (flush, failed) => {
    const unlisten = await listen<{ request: string }>(
      "tab-session-flush-request",
      async ({ payload }) => {
        const success = await flush().catch(() => false);
        await invoke("confirm_tab_session_flush", { request: payload.request, success }).catch(
          () => {},
        );
      },
    );
    try {
      const unlistenFailed = await listen("tab-session-flush-failed", failed);
      return () => {
        unlisten();
        unlistenFailed();
      };
    } catch (error) {
      unlisten();
      throw error;
    }
  },
  getTabSession: (workspaceId, viewId) => invoke("get_tab_session", { workspaceId, viewId }),
  captureTabSession: (workspaceId, viewId, items, active, activeColumn, split, help) =>
    invoke("capture_tab_session", {
      workspaceId,
      viewId,
      session: { items, active, activeColumn, split, help: help ?? null },
    }),
  getWorkspaceSets: (workspaceId, viewId) =>
    invoke<WorkspaceSets>("get_workspace_sets", { workspaceId, viewId }),
  captureWorkspaceSet: (workspaceId, viewId, name, items, active, activeColumn) =>
    invoke<WorkspaceSets>("capture_workspace_set", {
      workspaceId,
      viewId,
      name,
      items,
      active,
      activeColumn,
    }),
  editWorkspaceSet: (workspaceId, viewId, id, name) =>
    invoke<WorkspaceSets>("edit_workspace_set", { workspaceId, viewId, id, name }),
  resolveWorkspaceSet: (workspaceId, viewId, id, shortcutSlot) =>
    invoke<ResolvedWorkspaceSet>("resolve_workspace_set", {
      workspaceId,
      viewId,
      id,
      ...(shortcutSlot === undefined ? {} : { shortcutSlot }),
    }),
  assignWorkspaceSetShortcut: (workspaceId, viewId, id, slot) =>
    invoke<WorkspaceSets>("assign_workspace_set_shortcut", { workspaceId, viewId, id, slot }),
  getWorkspaceLists: (workspaceId, viewId, resolveMoves) =>
    invoke<WorkspaceLists>("get_workspace_lists", { workspaceId, viewId, resolveMoves }),
  setDocumentFavorite: (workspaceId, viewId, relativePath, add) =>
    invoke<WorkspaceLists>("set_document_favorite", { workspaceId, viewId, relativePath, add }),
  validateWorkspaceDocument: (workspaceId, viewId, document, tabId) =>
    invoke<string>("validate_workspace_document", { workspaceId, viewId, document, tabId }),
  validateWorkspaceFolder: (workspaceId, viewId, folder) =>
    invoke<string>("validate_workspace_folder", { workspaceId, viewId, folder }),
  recordDocumentDisplay: (workspaceId, viewId, tabId, sourceUrl) =>
    invoke<void>("record_document_display", { workspaceId, viewId, tabId, sourceUrl }),
  resolveDocumentLink: (workspaceId, viewId, sourceUrl, href) =>
    invoke<DocumentLinkTarget>("resolve_document_link", { workspaceId, viewId, sourceUrl, href }),
  openExternalDocumentLink: (workspaceId, viewId, sourceUrl, href) =>
    invoke<void>("open_external_document_link", { workspaceId, viewId, sourceUrl, href }),
  getDocumentStateRecovery: (workspaceId, viewId, relativePath) =>
    invoke<RecoveryCandidate | null>("get_document_state_recovery", {
      workspaceId,
      viewId,
      relativePath,
    }),
  getDocumentStorageHold: (workspaceId, viewId, tabId, requestId) =>
    invoke("get_document_storage_hold", { workspaceId, viewId, tabId, requestId }),
  recoverDocumentState: (workspaceId, viewId, relativePath, candidate) =>
    invoke<void>("recover_document_state", { workspaceId, viewId, relativePath, candidate }),
  mutateTree: (workspaceId, viewId, mutation) =>
    invoke("mutate_tree", { workspaceId, viewId, mutation }),
  performFileAction: (workspaceId, viewId, relativePath, action) =>
    invoke<void>("perform_file_action", { workspaceId, viewId, relativePath, action }),
  beginView: () => invoke<Snapshot>("begin_document_view"),
  createTab: (workspaceId, viewId, relativePath, expectedIdentity) =>
    invoke<string>("create_document_tab", { workspaceId, viewId, relativePath, expectedIdentity }),
  closeTab: (workspaceId, viewId, tabId) =>
    invoke<void>("close_document_tab", { workspaceId, viewId, tabId }),
  getTree: () => invoke<Snapshot>("get_knowledge_tree"),
  chooseRoot: () => invoke<Snapshot | null>("choose_knowledge_root"),
  chooseDisplayFolder: (workspaceId, viewId) =>
    invoke<Snapshot | null>("choose_display_folder", { workspaceId, viewId }),
  setDisplayFolder: (workspaceId, viewId, relativePath, expectedDisplayRevision) =>
    invoke<Snapshot>("set_display_folder", {
      workspaceId,
      viewId,
      relativePath,
      expectedDisplayRevision,
    }),
  refresh: () => invoke<Snapshot>("refresh_knowledge"),
  retrySavedRoot: (viewId) => invoke<Snapshot>("retry_saved_root", { viewId }),
  openDocument: (workspaceId, viewId, tabId, requestId) =>
    invoke<string>("open_document", { workspaceId, viewId, tabId, requestId }),
  listen: (callback) => listen<Change>("knowledge-changed", ({ payload }) => callback(payload)),
};
