import { useT, useLanguage, translateUiMessage } from "../lib/i18n";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppState } from "../lib/types";
import type { KnowledgeController } from "../lib/controller";
import type { WindowChrome } from "./windowChrome";
import { TabStrip } from "../features/document-viewer/TabStrip";
import { SIDEBAR_OVERLAY_WIDTH, SIDEBAR_SEPARATOR_WIDTH } from "./SidebarSeparator";

export function TitleBar({
  chrome,
  sidebarVisible,
  sidebarWidth,
  sidebarView,
  state,
  controller,
  menuButton,
  searchButton,
  onToggle,
  onFiles,
  onSearch,
  onWorkspaceLists,
  onEmpty,
  onTabDrag,
  draggedTab,
  feedback,
  helpButton,
  onHelp,
}: {
  chrome: WindowChrome;
  sidebarVisible: boolean;
  sidebarWidth: number;
  sidebarView: "files" | "search";
  state: AppState;
  controller: KnowledgeController;
  menuButton: RefObject<HTMLButtonElement | null>;
  searchButton: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  onFiles: () => void;
  onSearch: () => void;
  onWorkspaceLists?: () => void;
  onEmpty: () => void;
  onTabDrag?: (id: string | null) => void;
  draggedTab?: string | null;
  feedback?: string | null;
  helpButton: RefObject<HTMLButtonElement | null>;
  onHelp: () => void;
}) {
  const language = useLanguage();
  const t = useT();
  const header = useRef<HTMLElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const [windowError, setWindowError] = useState<string | null>(null);
  useLayoutEffect(() => {
    const element = header.current;
    const toolbar = controls.current;
    if (!element || !toolbar) return;
    const alignColumns = () => {
      // Compact controls occupy part of the left document column, not half of both columns.
      const compact = !sidebarVisible || window.innerWidth <= SIDEBAR_OVERLAY_WIDTH;
      element.style.setProperty(
        "--tab-column-offset",
        `${((compact ? toolbar.getBoundingClientRect().width : 0) - chrome.rightInset) / 2}px`,
      );
    };
    alignColumns();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(alignColumns);
    observer?.observe(toolbar);
    window.addEventListener("resize", alignColumns);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", alignColumns);
    };
  }, [sidebarVisible, chrome.rightInset]);
  const windowAction = (action: "minimize" | "toggle-maximize" | "close") => {
    setWindowError(null);
    void invoke("perform_window_action", { action }).catch((error) =>
      setWindowError(String(error)),
    );
  };
  return (
    <header
      ref={header}
      className="titlebar"
      data-tauri-drag-region
      data-platform={chrome.platform}
      style={{
        height: chrome.height,
        paddingRight: chrome.rightInset,
      }}
    >
      <div
        ref={controls}
        className="titlebar-controls"
        data-tauri-drag-region
        style={{
          width: sidebarVisible ? sidebarWidth + SIDEBAR_SEPARATOR_WIDTH : undefined,
          paddingLeft: chrome.leftInset + 8,
        }}
      >
        <button
          ref={menuButton}
          className="menu-toggle"
          aria-controls="knowledge-sidebar"
          aria-expanded={sidebarVisible}
          aria-label={sidebarVisible ? t("左メニューを閉じる") : t("左メニューを開く")}
          title={
            (feedback ?? (sidebarVisible ? t("左メニューを閉じる") : t("左メニューを開く"))) +
            ` (${chrome.platform === "macos" || /Mac/i.test(navigator.platform) ? "Cmd" : "Ctrl"}+B)`
          }
          aria-keyshortcuts={
            chrome.platform === "macos" || /Mac/i.test(navigator.platform) ? "Meta+B" : "Control+B"
          }
          aria-describedby={!sidebarVisible && feedback ? "workspace-feedback-summary" : undefined}
          data-has-issue={Boolean(feedback)}
          onClick={onToggle}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="3" y="4" width="14" height="12" rx="1" />
            <path d="M8 4v12" />
          </svg>
          {feedback && <span className="workspace-issue-dot" aria-hidden="true" />}
        </button>
        <nav className="titlebar-views" aria-label={t("左メニューの表示")} data-tauri-drag-region>
          <button
            type="button"
            aria-pressed={sidebarVisible && sidebarView === "files"}
            aria-label={t("ファイル")}
            title={
              t("ファイルを表示") +
              ` (${chrome.platform === "macos" || /Mac/i.test(navigator.platform) ? "Cmd" : "Ctrl"}+Shift+E)`
            }
            aria-keyshortcuts={
              chrome.platform === "macos" || /Mac/i.test(navigator.platform)
                ? "Meta+Shift+E"
                : "Control+Shift+E"
            }
            aria-controls="knowledge-files"
            onClick={onFiles}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 6h5l2-2h7v12H3z" />
            </svg>
          </button>
          <button
            ref={searchButton}
            type="button"
            aria-pressed={sidebarVisible && sidebarView === "search"}
            aria-controls="knowledge-search"
            aria-label={t("文書検索")}
            title={t("文書検索（Ctrl/Cmd+Shift+F）")}
            onClick={onSearch}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="8" cy="8" r="5" />
              <path d="m12 12 5 5" />
            </svg>
          </button>
          {onWorkspaceLists && (
            <button
              type="button"
              className="menu-toggle"
              aria-label={t("作業セット")}
              title={t("作業セット")}
              disabled={!state.snapshot.workspaceId || state.loading || state.actionBusy}
              onClick={onWorkspaceLists}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <rect x="3" y="6" width="11" height="11" rx="1" />
                <path d="M6 6V3h11v11h-3M3 10h11" />
              </svg>
            </button>
          )}
          <button
            ref={helpButton}
            type="button"
            aria-label={t("機能と使い方")}
            title={t("機能と使い方")}
            onClick={onHelp}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="7" />
              <path d="M8 7.5a2 2 0 1 1 3 1.7c-1 .6-1 1-1 2M10 13.5v.5" />
            </svg>
          </button>
        </nav>
      </div>
      <TabStrip
        state={state}
        controller={controller}
        onEmpty={onEmpty}
        onTabDrag={onTabDrag}
        activeDragId={draggedTab}
      />
      <div
        className="window-drag-region"
        style={{ right: chrome.rightInset }}
        data-tauri-drag-region
        aria-hidden="true"
      />
      {chrome.platform === "windows" && (
        <div className="window-controls" aria-label={t("ウィンドウ操作")}>
          <button
            type="button"
            aria-label={t("最小化")}
            title={t("最小化")}
            onClick={() => windowAction("minimize")}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 10h10" />
            </svg>
          </button>
          <button
            type="button"
            aria-label={chrome.maximized ? t("元のサイズに戻す") : t("最大化")}
            title={chrome.maximized ? t("元のサイズに戻す") : t("最大化")}
            onClick={() => windowAction("toggle-maximize")}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              {chrome.maximized ? (
                <>
                  <path d="M7 5h8v8" />
                  <rect x="5" y="7" width="8" height="8" />
                </>
              ) : (
                <rect x="5" y="5" width="10" height="10" />
              )}
            </svg>
          </button>
          <button
            type="button"
            className="window-close"
            aria-label={t("閉じる")}
            title={t("閉じる")}
            onClick={() => windowAction("close")}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </div>
      )}
      {windowError && (
        <span className="window-action-error" role="alert">
          {translateUiMessage(windowError, language)}
        </span>
      )}
    </header>
  );
}
