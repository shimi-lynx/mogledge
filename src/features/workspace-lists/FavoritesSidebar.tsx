import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KnowledgeController } from "../../lib/controller";
import type { AppState, DocumentSelection, WorkspaceListEntry } from "../../lib/types";
import { translateUiMessage, useLanguage, useT } from "../../lib/i18n";
import { FolderIcon } from "../knowledge-tree/FolderIcon";
import { Chevron } from "../knowledge-tree/Chevron";
import "./favorites-sidebar.css";

const statusLabels = {
  missing: "見つかりません",
  unavailable: "一時的に読み取れません",
  replaced: "別の文書に置き換わっています",
  available: "",
};
export function FavoritesSidebar({
  state,
  controller,
  active,
  onFolderSelect,
}: {
  state: AppState;
  controller: KnowledgeController;
  active: boolean;
  onFolderSelect: (selection: DocumentSelection) => boolean;
}) {
  const t = useT();
  const language = useLanguage();
  const contentId = useId();
  const context = JSON.stringify([state.snapshot.workspaceId, state.snapshot.viewId]);
  // Keep the file tree available until this root's list is explicitly expanded.
  const [expandedContext, setExpandedContext] = useState<string | null>(null);
  const expanded = expandedContext === context;
  const visible = active && expanded;
  const [recent, setRecent] = useState(false);
  const mounted = useRef(false);
  const selection = useRef(0);
  const selectionAbort = useRef<AbortController | null>(null);
  const selectionContext = useRef("");
  const cancelSelection = useCallback(() => {
    selection.current++;
    selectionAbort.current?.abort();
    selectionAbort.current = null;
  }, []);
  const latest = useRef({ state, active: visible });
  latest.current = { state, active: visible };
  const refreshing = useRef(false);
  const refreshPending = useRef(false);
  const metadataEvent = useRef<{
    workspaceId: string | null;
    viewId: string;
    nodes: AppState["snapshot"]["nodes"];
    active: boolean;
    initialized: boolean;
  } | null>(null);
  const flushRefresh = useCallback(async (): Promise<void> => {
    const { state: current, active: visible } = latest.current;
    if (
      !mounted.current ||
      refreshing.current ||
      !refreshPending.current ||
      !visible ||
      !current.snapshot.workspaceId ||
      current.loading ||
      current.actionBusy
    )
      return;
    refreshing.current = true;
    refreshPending.current = false;
    try {
      await controller.refreshWorkspaceLists(true);
    } finally {
      refreshing.current = false;
      if (mounted.current && refreshPending.current) void flushRefresh();
    }
  }, [controller]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelSelection();
      refreshPending.current = false;
    };
  }, [cancelSelection]);
  useEffect(() => {
    const context = JSON.stringify([state.snapshot.workspaceId, state.snapshot.viewId]);
    if (context !== selectionContext.current) {
      selectionContext.current = context;
      setRecent(false);
      setExpandedContext(null);
    }
    cancelSelection();
  }, [cancelSelection, state.snapshot.workspaceId, state.snapshot.viewId, state.snapshot.revision]);
  useEffect(() => {
    const previous = metadataEvent.current;
    const { workspaceId, viewId, nodes } = state.snapshot;
    const contextChanged = workspaceId !== previous?.workspaceId || viewId !== previous?.viewId;
    if (contextChanged) refreshPending.current = false;
    const initialized = !!state.workspaceLists;
    const hasEntries = !!(
      state.workspaceLists &&
      (state.workspaceLists.favorites.length ||
        state.workspaceLists.folderFavorites?.length ||
        state.workspaceLists.recent.length)
    );
    // Resolve only when this surface first has saved refs, returns to view, or
    // the tree structure changes. Ordinary document revisions and our own list
    // response do not trigger another scan. At most one flight and one retry.
    if (
      initialized &&
      hasEntries &&
      (contextChanged ||
        !previous?.initialized ||
        (visible && !previous?.active) ||
        nodes !== previous?.nodes)
    )
      refreshPending.current = true;
    metadataEvent.current = { workspaceId, viewId, nodes, active: visible, initialized };
    if (!visible && previous?.active) cancelSelection();
    void flushRefresh();
  }, [
    visible,
    cancelSelection,
    flushRefresh,
    state.snapshot.workspaceId,
    state.snapshot.viewId,
    state.snapshot.nodes,
    !!state.workspaceLists,
    state.loading,
    state.actionBusy,
  ]);
  const currentContext = () => {
    const current = controller.getSnapshot();
    return (
      mounted.current &&
      latest.current.active &&
      !current.loading &&
      !current.actionBusy &&
      state.snapshot.workspaceId === current.snapshot.workspaceId &&
      state.snapshot.viewId === current.snapshot.viewId &&
      state.snapshot.revision === current.snapshot.revision
    );
  };
  const open = async (entry: WorkspaceListEntry, folder: boolean) => {
    if (!currentContext() || entry.status !== "available") return;
    cancelSelection();
    const request = selection.current;
    const abort = new AbortController();
    selectionAbort.current = abort;
    try {
      if (!folder) {
        await controller.selectWorkspaceDocument(entry, abort.signal);
        return;
      }
      const target = await controller.selectWorkspaceFolder(entry, abort.signal);
      if (target && request === selection.current && currentContext()) onFolderSelect(target);
    } finally {
      if (selectionAbort.current === abort) selectionAbort.current = null;
    }
  };
  const lists = state.workspaceLists;
  const entries = recent
    ? (lists?.recent ?? []).map((entry) => ({ entry, folder: false }))
    : [
        ...(lists?.favorites ?? []).map((entry) => ({ entry, folder: false })),
        ...(lists?.folderFavorites ?? []).map((entry) => ({ entry, folder: true })),
      ];
  return (
    <section className="favorites-sidebar" aria-label={t("お気に入り")}>
      <div className="favorites-sidebar-header">
        <h2>
          <button
            type="button"
            className="favorites-disclosure"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => {
              cancelSelection();
              setExpandedContext(expanded ? null : context);
            }}
          >
            <Chevron expanded={expanded} />
            <svg className="favorites-star" viewBox="0 0 20 20" aria-hidden="true">
              <path d="m10 2 2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9L7.5 7z" />
            </svg>
            <span className="favorites-title">{t("お気に入り")}</span>
          </button>
        </h2>
        {expanded && recent && <span className="favorites-mode">{t("最近")}</span>}
        <button
          type="button"
          hidden={!expanded}
          aria-pressed={recent}
          aria-label={t(recent ? "お気に入りを表示" : "最近の文書を表示")}
          title={t(recent ? "お気に入りを表示" : "最近の文書を表示")}
          disabled={!state.snapshot.workspaceId || state.loading || state.actionBusy}
          onClick={() => {
            if (!currentContext()) return;
            cancelSelection();
            setRecent((value) => !value);
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="6.5" />
            <path d="M10 6v4l3 2" />
          </svg>
        </button>
        <button
          type="button"
          hidden={!expanded}
          aria-label={t("お気に入りと最近の文書を更新")}
          title={t("お気に入りと最近の文書を更新")}
          disabled={!state.snapshot.workspaceId || state.loading || state.actionBusy}
          onClick={() => {
            if (!currentContext()) return;
            refreshPending.current = true;
            void flushRefresh();
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M16 7a6 6 0 1 0 .2 5M16 3v4h-4" />
          </svg>
        </button>
      </div>
      <div id={contentId} hidden={!expanded}>
        {entries.length ? (
          <ul
            className="favorites-sidebar-list"
            aria-label={t(recent ? "最近の文書" : "お気に入りの項目")}
          >
            {entries.map(({ entry, folder }) => {
              const status =
                folder && entry.status === "replaced"
                  ? "別のフォルダーに置き換わっています"
                  : statusLabels[entry.status];
              const label = t(folder ? "{path}のフォルダーを表示" : "{path}を開く", {
                path: entry.relativePath,
              });
              return (
                <li key={`${folder ? "folder" : "file"}:${entry.identity}`}>
                  <button
                    type="button"
                    className="favorite-open"
                    disabled={state.loading || state.actionBusy || entry.status !== "available"}
                    aria-label={label}
                    aria-description={status ? t(status) : undefined}
                    title={entry.relativePath + (status ? "\n" + t(status) : "")}
                    onClick={() => void open(entry, folder)}
                  >
                    {folder ? (
                      <FolderIcon className="favorite-kind" />
                    ) : (
                      <svg className="favorite-kind" viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M5 2h7l3 3v13H5zM12 2v4h3M7 10h6M7 13h6" />
                      </svg>
                    )}
                    <span>{entry.relativePath.split("/").pop()}</span>
                  </button>
                  {!recent && (
                    <button
                      type="button"
                      className="favorite-remove"
                      disabled={state.loading || state.actionBusy || lists?.readOnly}
                      aria-label={t("{path}をお気に入りから解除", { path: entry.relativePath })}
                      title={t("お気に入りから解除")}
                      onClick={() => {
                        if (currentContext())
                          void controller.setFavorite(entry.relativePath, false);
                      }}
                    >
                      ×
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="favorites-empty">
            {t(
              !state.snapshot.workspaceId
                ? "作業フォルダーを選択してください"
                : !lists
                  ? "読み込み中"
                  : recent
                    ? "最近の文書はまだありません"
                    : "お気に入りはまだありません",
            )}
          </p>
        )}
        {lists?.error && (
          <p
            role="alert"
            className="favorites-error"
            title={translateUiMessage(lists.error, language)}
          >
            {translateUiMessage(lists.error, language)}
          </p>
        )}
      </div>
    </section>
  );
}
