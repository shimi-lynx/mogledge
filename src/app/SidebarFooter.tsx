import type { KnowledgeController } from "../lib/controller";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { useT } from "../lib/i18n";
import { ManagementSession } from "../lib/stateManagement";
import { StorageLimitsSession } from "../lib/storageLimits";
import type { HtmlAuthoringContext } from "../lib/htmlAuthoring";
import { SettingsDialog, type SettingsDialogHandle } from "./SettingsDialog";
import "./sidebar-footer.css";
import type { AppState } from "../lib/types";
import type { WindowChrome } from "./windowChrome";

export type SidebarFooterHandle = {
  openSettings: (returnFocus: HTMLElement | null, page?: "folder") => void;
};

export function SidebarFooter({
  version,
  reloadDisabled,
  onReload,
  controller,
  fallbackFocus,
  ref,
  state,
  rootContext,
  platform = /Mac/i.test(navigator.platform) ? "macos" : "other",
}: {
  version: string | null;
  reloadDisabled: boolean;
  onReload: () => void;
  controller?: KnowledgeController;
  fallbackFocus?: HTMLElement | null;
  ref?: Ref<SidebarFooterHandle>;
  state?: AppState;
  rootContext?: HtmlAuthoringContext | null;
  platform?: WindowChrome["platform"];
}) {
  const t = useT();
  const settingsButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<SettingsDialogHandle>(null);
  const [managementSession] = useState(() => new ManagementSession());
  const [limitsSession] = useState(() => new StorageLimitsSession());
  useEffect(() => {
    limitsSession.bind({
      workspaceId: state?.snapshot.workspaceId ?? null,
      viewId: state?.snapshot.viewId ?? "",
    });
  }, [limitsSession, state?.snapshot.workspaceId, state?.snapshot.viewId]);
  const [settingsOpen, setSettingsOpen] = useState<{
    returnFocus: HTMLElement | null;
    page?: "folder";
  } | null>(null);
  const openSettings = useCallback((returnFocus: HTMLElement | null, page?: "folder") => {
    if (dialog.current) {
      dialog.current.focus(page);
      return;
    }
    // A second request before React commits must retain the first origin too.
    setSettingsOpen((current) => current ?? { returnFocus, page });
  }, []);
  useImperativeHandle(ref, () => ({ openSettings }), [openSettings]);
  const settingsKey = platform === "macos" ? "Cmd+," : "Ctrl+,";
  return (
    <>
      <div className="sidebar-footer">
        {version && <span className="sidebar-version">v{version}</span>}
        <div className="sidebar-footer-actions">
          <button
            type="button"
            onClick={onReload}
            disabled={reloadDisabled}
            title={t("再走査して監視を再開")}
            aria-label={t("再走査")}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M16 8a6 6 0 1 0 .1 4M16 3v5h-5" />
            </svg>
          </button>
          <button
            ref={settingsButton}
            type="button"
            title={t("設定（{shortcut}）", { shortcut: settingsKey })}
            aria-label={t("設定")}
            aria-keyshortcuts={platform === "macos" ? "Meta+," : "Control+,"}
            aria-haspopup="dialog"
            onClick={() => openSettings(settingsButton.current)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M8 2h4l.5 2 1.5.9 2-.5 2 3.2-1.5 1.4v2l1.5 1.4-2 3.2-2-.5-1.5.9L12 18H8l-.5-2-1.5-.9-2 .5-2-3.2L3.5 11V9L2 7.6l2-3.2 2 .5 1.5-.9Z" />
              <circle cx="10" cy="10" r="3" />
            </svg>
          </button>
        </div>
      </div>
      {settingsOpen &&
        createPortal(
          <SettingsDialog
            ref={dialog}
            state={state}
            rootContext={rootContext}
            platform={platform}
            controller={controller}
            initialPage={settingsOpen.page}
            managementContext={{
              workspaceId: state?.snapshot.workspaceId ?? null,
              viewId: state?.snapshot.viewId ?? "",
            }}
            managementSession={managementSession}
            limitsSession={limitsSession}
            returnFocus={settingsOpen.returnFocus}
            fallbackFocus={fallbackFocus ?? settingsButton.current}
            onClose={() => setSettingsOpen(null)}
          />,
          document.body,
        )}
    </>
  );
}
