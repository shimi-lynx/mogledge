import { StartupRecoveryNotice } from "./StartupRecoveryNotice";
import { StorageIdentityAction } from "./StorageIdentityAction";
import { useT, useLanguage, translateUiMessage } from "../lib/i18n";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { KnowledgeController } from "../lib/controller";
import { installUiCsp } from "../lib/ui-csp";
import { aiHandoffApi, bridge } from "../lib/bridge";
import type { AiHandoffContext } from "../lib/aiHandoff";
import { KnowledgeTree } from "../features/knowledge-tree/KnowledgeTree";
import { FolderIcon } from "../features/knowledge-tree/FolderIcon";
import { DocumentDeck } from "../features/document-viewer/DocumentDeck";
import { SearchPanel } from "../features/document-search/SearchPanel";
import { QuickOpen } from "../features/quick-open/QuickOpen";
import { WorkspaceLists } from "../features/workspace-lists/WorkspaceLists";
import { FavoritesSidebar } from "../features/workspace-lists/FavoritesSidebar";
import type { DocumentSelection } from "../lib/types";
import { rootFolderName } from "../lib/rootDisplay";
import { reconcileSearchScope, type SelectedSearchScope } from "../features/document-search/scope";
import { TitleBar } from "./TitleBar";
import { SidebarFooter, type SidebarFooterHandle } from "./SidebarFooter";
import { useResident } from "./useResident";
import { RootAiHandoffMenu } from "./RootAiHandoffMenu";
import { SidebarSeparator, useSidebarWidth } from "./SidebarSeparator";
import {
  acceptsWindowCommand,
  shortcutScope,
  useWindowChrome,
  type WindowCommand,
} from "./windowChrome";

const StateTransferDialog = lazy(() => import("./StateTransferDialog"));
const AiHandoffDialog = lazy(() => import("./AiHandoffDialog"));

export function App() {
  const t = useT();
  const language = useLanguage();
  const helpButton = useRef<HTMLButtonElement>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const versionRequest = useRef<Promise<string> | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarView, setSidebarView] = useState<"files" | "search">("files");
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const [selectedSearchScope, setSelectedSearchScope] = useState<SelectedSearchScope | null>(null);
  const [draggedTab, setDraggedTab] = useState<string | null>(null);
  const sidebar = useSidebarWidth();
  const searchButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const settingsFooter = useRef<SidebarFooterHandle>(null);
  const openSettings = useCallback((returnFocus?: HTMLElement) => {
    const target =
      returnFocus ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    settingsFooter.current?.openSettings(target);
  }, []);
  const [controller] = useState(() => new KnowledgeController(bridge));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useResident(controller);
  const [aiHandoff, setAiHandoff] = useState<{
    context: AiHandoffContext;
    returnFocus: HTMLElement | null;
  } | null>(null);
  const aiHandoffValid =
    aiHandoff &&
    aiHandoff.context.workspaceId === state.snapshot.workspaceId &&
    aiHandoff.context.viewId === state.snapshot.viewId;
  useEffect(() => {
    if (aiHandoff && !aiHandoffValid) setAiHandoff(null);
  }, [aiHandoff, aiHandoffValid]);
  const [quickOpen, setQuickOpen] = useState<{
    workspaceId: string;
    viewId: string;
    returnFocus: Element | null;
  } | null>(null);
  const shellComposing = useRef(false);
  const [treeFocusRequest, setTreeFocusRequest] = useState<
    { path: string; id: number; workspaceId: string; viewId: string; revision: number } | undefined
  >();
  const treeFocusSerial = useRef(0);
  const [workspaceLists, setWorkspaceLists] = useState<{
    workspaceId: string;
    viewId: string;
    returnFocus: Element | null;
  } | null>(null);
  const closeWorkspaceLists = useCallback(() => {
    controller.cancelWorkspaceSelection();
    const target = workspaceLists?.returnFocus;
    setWorkspaceLists(null);
    queueMicrotask(() => {
      if (
        target instanceof HTMLElement &&
        target.isConnected &&
        !target.closest("[hidden], [inert]")
      )
        target.focus();
      else menuButton.current?.focus();
    });
  }, [workspaceLists, controller]);
  const workspaceListsValid =
    workspaceLists &&
    workspaceLists.workspaceId === state.snapshot.workspaceId &&
    workspaceLists.viewId === state.snapshot.viewId;
  useEffect(() => {
    if (workspaceLists && !workspaceListsValid) closeWorkspaceLists();
  }, [workspaceLists, workspaceListsValid, closeWorkspaceLists]);
  const searchScope = useMemo(
    () => reconcileSearchScope(selectedSearchScope, state.snapshot),
    [selectedSearchScope, state.snapshot],
  );
  useEffect(() => {
    if (searchScope !== selectedSearchScope) setSelectedSearchScope(searchScope);
  }, [searchScope, selectedSearchScope]);
  useEffect(() => {
    setDraggedTab(null);
    setTreeFocusRequest(undefined);
  }, [state.snapshot.workspaceId]);
  const focusDocument = useCallback(() => {
    const element = document.activeElement;
    if (element instanceof HTMLIFrameElement) {
      const panel = element.closest<HTMLElement>(".document-pane:not([hidden])");
      if (panel?.id.startsWith("panel-")) controller.focusTab(panel.id.slice(6));
    }
  }, [controller]);
  const toggleSidebar = useCallback(() => {
    const focused = document.activeElement;
    if (sidebarVisible && focused instanceof HTMLElement && focused.closest("#knowledge-sidebar"))
      menuButton.current?.focus();
    setSidebarVisible((visible) => !visible);
  }, [sidebarVisible]);
  const lastSidebarShortcut = useRef(-Infinity);
  const requestSidebarToggle = useCallback(() => {
    const now = performance.now();
    // Collapse rapid keys and focused-frame proposals without a timer.
    if (now - lastSidebarShortcut.current < 120) return;
    lastSidebarShortcut.current = now;
    toggleSidebar();
  }, [toggleSidebar]);
  const openSearch = useCallback(() => {
    setSidebarVisible(true);
    setSidebarView("search");
    setSearchFocusRequest((value) => value + 1);
  }, []);
  const [filesFocusRequest, setFilesFocusRequest] = useState(0);
  const showFiles = useCallback(() => {
    setSidebarVisible(true);
    setSidebarView("files");
    setFilesFocusRequest((request) => request + 1);
  }, []);
  useLayoutEffect(() => {
    if (!filesFocusRequest) return;
    const tree = document.querySelector<HTMLElement>('#knowledge-files [role="tree"]');
    (
      tree ??
      document.querySelector<HTMLElement>('.titlebar button[aria-controls="knowledge-files"]')
    )?.focus();
  }, [filesFocusRequest]);
  const openQuickOpen = useCallback(() => {
    const current = controller.getSnapshot();
    if (
      current.loading ||
      current.actionBusy ||
      !current.snapshot.workspaceId ||
      shortcutScope() !== "app"
    )
      return;
    focusDocument();
    setQuickOpen({
      workspaceId: current.snapshot.workspaceId,
      viewId: current.snapshot.viewId,
      returnFocus: document.activeElement,
    });
  }, [controller, focusDocument]);
  const openAiHandoffForTab = useCallback(
    (tabId?: string) => {
      const current = controller.getSnapshot();
      if (
        current.loading ||
        current.actionBusy ||
        !current.snapshot.workspaceId ||
        shortcutScope() !== "app"
      )
        return;
      const tab = current.tabs.find(
        (candidate) => candidate.id === (tabId ?? current.columns[current.activeColumn]),
      );
      if (!tab || tab.kind === "help" || !tab.url || tab.loading || tab.closing || tab.deferred)
        return;
      controller.focusTab(tab.id);
      setAiHandoff({
        context: {
          workspaceId: current.snapshot.workspaceId,
          viewId: current.snapshot.viewId,
          relativePath: tab.path,
        },
        returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      });
    },
    [controller],
  );
  const closeQuickOpen = useCallback(() => {
    const target = quickOpen?.returnFocus;
    setQuickOpen(null);
    queueMicrotask(() => {
      if (
        target instanceof HTMLElement &&
        target.isConnected &&
        !target.closest("[hidden], [inert]")
      ) {
        target.focus();
        if (target instanceof HTMLIFrameElement) target.contentWindow?.focus();
      } else menuButton.current?.focus();
    });
  }, [quickOpen]);
  const quickOpenValid =
    quickOpen &&
    quickOpen.workspaceId === state.snapshot.workspaceId &&
    quickOpen.viewId === state.snapshot.viewId;
  useEffect(() => {
    if (quickOpen && !quickOpenValid) closeQuickOpen();
  }, [quickOpen, quickOpenValid, closeQuickOpen]);
  useEffect(() => {
    const startComposition = () => {
      shellComposing.current = true;
    };
    const endComposition = () => {
      shellComposing.current = false;
    };
    const shortcut = (event: KeyboardEvent) => {
      const primary = /Mac/i.test(navigator.platform)
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (
        !primary ||
        event.altKey ||
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        shellComposing.current ||
        event.defaultPrevented ||
        !(
          ((event.key.toLowerCase() === "p" ||
            event.key.toLowerCase() === "b" ||
            event.key === ",") &&
            !event.shiftKey) ||
          (["a", "e"].includes(event.key.toLowerCase()) && event.shiftKey)
        ) ||
        shortcutScope() !== "app"
      )
        return;
      if (event.key.toLowerCase() === "e") {
        if (document.activeElement instanceof HTMLIFrameElement) return;
        event.preventDefault();
        showFiles();
        return;
      }
      if (event.key === ",") {
        if (document.activeElement instanceof HTMLIFrameElement) return;
        event.preventDefault();
        openSettings();
        return;
      }
      if (event.key.toLowerCase() === "b") {
        if (document.activeElement instanceof HTMLIFrameElement) return;
        event.preventDefault();
        requestSidebarToggle();
        return;
      }
      const current = controller.getSnapshot();
      if (!current.snapshot.workspaceId || current.loading || current.actionBusy) return;
      event.preventDefault();
      if (event.shiftKey) openAiHandoffForTab();
      else openQuickOpen();
    };
    document.addEventListener("compositionstart", startComposition);
    document.addEventListener("compositionend", endComposition);
    window.addEventListener("keydown", shortcut);
    return () => {
      document.removeEventListener("compositionstart", startComposition);
      document.removeEventListener("compositionend", endComposition);
      window.removeEventListener("keydown", shortcut);
    };
  }, [
    controller,
    openQuickOpen,
    openAiHandoffForTab,
    requestSidebarToggle,
    openSettings,
    showFiles,
  ]);
  const searchFolder = (relativePath: string) => {
    const { workspaceId, viewId, revision } = state.snapshot;
    if (!workspaceId) return;
    setSelectedSearchScope({ relativePath, workspaceId, viewId, revision });
    openSearch();
  };
  const runWindowCommand = useCallback(
    (command: WindowCommand) => {
      focusDocument();
      if (command === "focus-search") openSearch();
      else if (command === "reopen-closed-tab") void controller.reopen();
      else {
        const current = controller.getSnapshot();
        const tab = current.columns[current.activeColumn];
        if (tab) controller.moveTab(tab, command === "move-tab-left" ? 0 : 1);
      }
    },
    [controller, focusDocument, openSearch],
  );
  const chrome = useWindowChrome(runWindowCommand);
  useEffect(() => {
    let stopped = false;
    // Metadata is immutable for this process; reuse the request on StrictMode's effect restart.
    versionRequest.current ??= getVersion();
    void versionRequest.current.then(
      (version) => {
        if (!stopped) setAppVersion(version);
      },
      () => {},
    );
    return () => {
      stopped = true;
    };
  }, []);
  useEffect(() => {
    const preventShellRefresh = (event: KeyboardEvent) => {
      // Capture before dialogs/menus stop propagation. Frame events stay in
      // their own document; Windows also disables only the browser R action.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", preventShellRefresh, true);
    return () => window.removeEventListener("keydown", preventShellRefresh, true);
  }, []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey
      )
        return;
      const command: WindowCommand | null =
        event.key.toLowerCase() === "f"
          ? "focus-search"
          : event.key.toLowerCase() === "t"
            ? "reopen-closed-tab"
            : event.key === "ArrowLeft"
              ? "move-tab-left"
              : event.key === "ArrowRight"
                ? "move-tab-right"
                : null;
      if (!command || !acceptsWindowCommand(command)) return;
      event.preventDefault();
      runWindowCommand(command);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [runWindowCommand]);
  useLayoutEffect(() => {
    if (state.snapshot.documentOrigin) installUiCsp(state.snapshot.documentOrigin);
  }, [state.snapshot.documentOrigin]);
  useEffect(() => {
    void controller.start();
    return () => controller.stop();
  }, [controller]);
  useEffect(() => {
    // Focus inside an opaque iframe does not bubble into the parent document.
    // Track its activeElement while focus is within a child browsing context.
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const blur = () => {
      stop();
      queueMicrotask(focusDocument);
      timer = setInterval(focusDocument, 100);
    };
    const focus = () => {
      // Returning to a toolbar button can precede the first timer tick. Resolve
      // the child that held focus before stopping the tracker.
      focusDocument();
      stop();
    };
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    return () => {
      stop();
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
    };
  }, [focusDocument]);
  useEffect(() => {
    if (
      state.snapshot.workspaceId &&
      !performance.getEntriesByName("knowledge-tree-ready").length
    ) {
      performance.mark("knowledge-tree-ready");
    }
  }, [state.snapshot.workspaceId]);
  const focusFavoriteFolder = useCallback(
    (selection: DocumentSelection) => {
      const current = controller.getSnapshot();
      if (
        current.loading ||
        current.actionBusy ||
        selection.workspaceId !== current.snapshot.workspaceId ||
        selection.viewId !== current.snapshot.viewId ||
        selection.revision !== current.snapshot.revision
      )
        return false;
      setSidebarVisible(true);
      setSidebarView("files");
      setTreeFocusRequest({
        path: selection.relativePath,
        id: ++treeFocusSerial.current,
        workspaceId: selection.workspaceId,
        viewId: selection.viewId,
        revision: selection.revision,
      });
      return true;
    },
    [controller],
  );
  const focusMenu = useCallback(() => menuButton.current?.focus(), []);
  const rootName = rootFolderName(state.snapshot.rootPath) ?? t("ルート");
  const rawFeedback = state.error ?? state.snapshot.watchError;
  const feedback = rawFeedback ? translateUiMessage(rawFeedback, language) : null;
  return (
    <main
      className="app"
      data-menu-open={sidebarVisible}
      data-resizing={sidebar.resizing}
      onPointerDownCapture={focusDocument}
      onKeyDownCapture={focusDocument}
    >
      <TitleBar
        onTabDrag={setDraggedTab}
        draggedTab={draggedTab}
        chrome={chrome}
        sidebarVisible={sidebarVisible}
        sidebarWidth={sidebar.width}
        sidebarView={sidebarView}
        state={state}
        controller={controller}
        menuButton={menuButton}
        searchButton={searchButton}
        onToggle={toggleSidebar}
        onFiles={showFiles}
        onSearch={openSearch}
        onWorkspaceLists={() => {
          if (state.snapshot.workspaceId)
            setWorkspaceLists({
              workspaceId: state.snapshot.workspaceId,
              viewId: state.snapshot.viewId,
              returnFocus: document.activeElement,
            });
        }}
        onEmpty={focusMenu}
        feedback={feedback}
        helpButton={helpButton}
        onHelp={() => controller.openHelp()}
      />
      <div className="workspace-layout">
        <aside
          id="knowledge-sidebar"
          className="sidebar"
          aria-label={t("左メニュー")}
          hidden={!sidebarVisible}
          style={{ width: sidebar.width }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (sidebarView === "search") {
                setSidebarView("files");
                searchButton.current?.focus();
                return;
              }
              setSidebarVisible(false);
              menuButton.current?.focus();
            }
          }}
        >
          <div className="sidebar-toolbar">
            <RootAiHandoffMenu
              disabled={!state.snapshot.workspaceId || state.loading || state.actionBusy}
              contextKey={JSON.stringify([state.snapshot.workspaceId, state.snapshot.viewId])}
              onRootAction={(action) => void controller.performRootAction(action)}
              onAiHandoff={(returnFocus) => {
                const current = controller.getSnapshot();
                if (!current.snapshot.workspaceId || current.loading || current.actionBusy) return;
                setAiHandoff({
                  context: {
                    workspaceId: current.snapshot.workspaceId,
                    viewId: current.snapshot.viewId,
                    target: "root",
                  },
                  returnFocus,
                });
              }}
            >
              <button
                className="workspace-button"
                onClick={() => void controller.choose()}
                disabled={state.loading}
                title={state.snapshot.rootPath ?? t("knowledgeフォルダを選択")}
              >
                <FolderIcon className="file-icon folder workspace-icon" />
                <span className="workspace-name">
                  {state.snapshot.workspaceId ? rootName : t("フォルダを選択")}
                </span>
                <svg
                  aria-hidden="true"
                  className="workspace-chevron"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </RootAiHandoffMenu>
          </div>
          <div
            id="knowledge-files"
            className="sidebar-files"
            aria-busy={state.actionBusy || state.loading}
          >
            <KnowledgeTree
              nodes={state.snapshot.nodes}
              rootPath={state.snapshot.rootPath}
              workspaceId={state.snapshot.workspaceId}
              viewId={state.snapshot.viewId}
              selected={state.selectedPath}
              hideFiles={sidebarView !== "files"}
              headerContent={
                <>
                  <FavoritesSidebar
                    state={state}
                    controller={controller}
                    active={sidebarVisible}
                    onFolderSelect={focusFavoriteFolder}
                  />
                  <SearchPanel
                    active={sidebarVisible && sidebarView === "search"}
                    focusRequest={searchFocusRequest}
                    workspaceId={state.snapshot.workspaceId}
                    viewId={state.snapshot.viewId}
                    scope={
                      searchScope
                        ? { relativePath: searchScope.relativePath, viewId: searchScope.viewId }
                        : undefined
                    }
                    nodes={state.snapshot.nodes}
                    scopeLocked={state.loading || state.actionBusy}
                    onChangeScope={(path) => {
                      const current = controller.getSnapshot();
                      if (
                        current.loading ||
                        current.actionBusy ||
                        !current.snapshot.workspaceId ||
                        current.snapshot.workspaceId !== state.snapshot.workspaceId ||
                        current.snapshot.viewId !== state.snapshot.viewId
                      )
                        return;
                      if (!path) {
                        setSelectedSearchScope(null);
                        return;
                      }
                      const candidate = reconcileSearchScope(
                        {
                          relativePath: path,
                          workspaceId: current.snapshot.workspaceId,
                          viewId: current.snapshot.viewId,
                          revision: current.snapshot.revision,
                        },
                        current.snapshot,
                      );
                      if (candidate) setSelectedSearchScope(candidate);
                    }}
                    onResetScope={() => setSelectedSearchScope(null)}
                    revision={state.snapshot.revision}
                    onSelect={(path) => void controller.select(path)}
                  />
                </>
              }
              onSelect={(path) => void controller.select(path)}
              onOpenColumn={(path, column) => void controller.openInColumn(path, column)}
              favoritePaths={
                state.workspaceLists
                  ? [
                      ...state.workspaceLists.favorites,
                      ...(state.workspaceLists.folderFavorites ?? []),
                    ].map((entry) => entry.relativePath)
                  : undefined
              }
              focusRequest={treeFocusRequest}
              onFavorite={(path, add) => void controller.setFavorite(path, add)}
              onFileAction={(path, action) => void controller.performFileAction(path, action)}
              onSearchFolder={searchFolder}
              onStateTransfer={(path, kind) => controller.beginStateTransfer(path, kind)}
              onAiHandoff={(relativePath, returnFocus) => {
                if (state.snapshot.workspaceId)
                  setAiHandoff({
                    context: {
                      workspaceId: state.snapshot.workspaceId,
                      viewId: state.snapshot.viewId,
                      relativePath,
                    },
                    returnFocus,
                  });
              }}
              onRecoverState={(path) =>
                void controller.recoverDocumentState(path, (candidate) =>
                  window.confirm(
                    path +
                      "\n\n" +
                      t(
                        "置換後のHTMLに以前の入力状態を渡します。信頼できるHTMLの場合だけ引き継いでください。\n保存された{count}件の入力状態を引き継ぎます。続けますか？",
                        { count: candidate.appCount },
                      ),
                  ),
                )
              }
              actionBusy={state.actionBusy}
              onMutation={(mutation) => controller.mutateTree(mutation)}
              pathMoves={state.snapshot.pathMoves}
              revision={state.snapshot.revision}
              onTrash={(source, revision) =>
                controller.mutateTree({ kind: "trash", source, revision })
              }
            />
            {!state.snapshot.workspaceId && sidebarView === "files" && (
              <div className="onboarding">
                <p>{t("AIやエディタで作成したHTMLを、ひとつの場所に。")}</p>
                <button
                  className="primary-button"
                  onClick={() => void controller.choose()}
                  disabled={state.loading}
                >
                  {t("knowledgeを開く")}
                </button>
                <p className="hint">{t("ファイルは元の場所に保存されます。")}</p>
                {!state.snapshot.startupRecovery && (
                  <StorageIdentityAction platform={chrome.platform} />
                )}
              </div>
            )}
          </div>
          {state.snapshot.startupRecovery && !state.snapshot.workspaceId && (
            <StartupRecoveryNotice
              recovery={state.snapshot.startupRecovery}
              loading={state.loading}
              onRetry={() => void controller.retrySavedRoot()}
              onChoose={() => void controller.choose()}
              platform={chrome.platform}
            />
          )}
          {(state.error || state.snapshot.watchError) && (
            <div className="workspace-feedback">
              {state.error && <p role="alert">{translateUiMessage(state.error, language)}</p>}
              {state.snapshot.watchError && (
                <p role="status">{translateUiMessage(state.snapshot.watchError, language)}</p>
              )}
              <button
                disabled={state.loading || !state.snapshot.workspaceId}
                onClick={() => void controller.refresh()}
              >
                {t("再走査")}
              </button>
            </div>
          )}
          <SidebarFooter
            ref={settingsFooter}
            fallbackFocus={menuButton.current}
            state={state}
            rootContext={
              state.snapshot.workspaceId
                ? {
                    workspaceId: state.snapshot.workspaceId,
                    viewId: state.snapshot.viewId,
                    revision: state.snapshot.revision,
                  }
                : null
            }
            version={appVersion}
            platform={chrome.platform}
            reloadDisabled={!state.snapshot.workspaceId || state.loading}
            onReload={() => void controller.refresh()}
          />
        </aside>
        {sidebarVisible && (
          <SidebarSeparator
            width={sidebar.width}
            viewport={sidebar.viewport}
            onWidth={sidebar.setWidth}
            onResizing={sidebar.setResizing}
          />
        )}
        <section className="content">
          <div className="viewer-content">
            <DocumentDeck
              state={state}
              controller={controller}
              draggedTab={draggedTab}
              onDragDone={() => setDraggedTab(null)}
              onQuickOpen={openQuickOpen}
              onAiHandoff={openAiHandoffForTab}
              onToggleSidebar={requestSidebarToggle}
              onShowFiles={showFiles}
              onOpenSettings={openSettings}
            />
          </div>
        </section>
        {!sidebarVisible && feedback && (
          <span
            id="workspace-feedback-summary"
            className="visually-hidden"
            role={state.error ? "alert" : "status"}
          >
            {t("{feedback}。左メニューで詳細と再走査を確認できます。", { feedback })}
          </span>
        )}
      </div>
      {quickOpenValid && (
        <QuickOpen
          snapshot={state.snapshot}
          onClose={closeQuickOpen}
          onSelect={(selection) => {
            if (controller.selectFromSnapshot(selection)) closeQuickOpen();
          }}
        />
      )}
      {workspaceListsValid && (
        <WorkspaceLists state={state} controller={controller} onClose={closeWorkspaceLists} />
      )}
      {state.stateTransfer && (
        <Suspense fallback={<span role="status">{t("入力転送の確認を開いています")}</span>}>
          <StateTransferDialog view={state.stateTransfer} controller={controller} />
        </Suspense>
      )}
      {aiHandoffValid && (
        <Suspense fallback={<span role="status">{t("AIへの受け渡し確認を開いています")}</span>}>
          <AiHandoffDialog
            context={aiHandoff.context}
            returnFocus={aiHandoff.returnFocus}
            api={aiHandoffApi}
            onClose={() => setAiHandoff(null)}
          />
        </Suspense>
      )}
    </main>
  );
}
