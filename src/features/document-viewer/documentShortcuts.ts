import { useEffect, useRef, type RefObject } from "react";
import { shortcutScope } from "../../app/windowChrome";
import type {
  AppState,
  Column,
  DocumentZoomInput,
  WorkspaceSetShortcutSlot,
} from "../../lib/types";
import type { KnowledgeController } from "../../lib/controller";
import {
  workspaceSetShortcutSlot,
  workspaceSetShortcutSlots,
} from "../../lib/workspaceSetShortcuts";

type DocumentShortcut =
  | { type: "history"; direction: "back" | "forward" }
  | { type: "sidebar-toggle" }
  | { type: "files-show" }
  | { type: "quick-open" }
  | { type: "ai-handoff" }
  | { type: "settings-open" }
  | { type: "close-tab" }
  | { type: "workspace-set"; slot: WorkspaceSetShortcutSlot }
  | { type: "move"; direction: Column }
  | { type: "zoom"; change: DocumentZoomInput };

function documentShortcut(event: MessageEvent, frame: HTMLIFrameElement): DocumentShortcut | null {
  const data: unknown = event.data;
  if (
    event.origin !== "null" ||
    event.source !== frame.contentWindow ||
    document.activeElement !== frame ||
    !document.hasFocus() ||
    shortcutScope() !== "app" ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  )
    return null;
  const message = data as Record<string, unknown>;
  // Legacy messages share all source, token and payload checks.
  const messageType =
    typeof message.type === "string"
      ? message.type.replace(/^my-knowledge-/, "mogledge-")
      : message.type;
  let token: string | undefined;
  try {
    token = new URL(frame.src).pathname.match(/^\/s\/([a-f0-9]{64})\//)?.[1];
  } catch {
    return null;
  }
  if (!token || message.token !== token) return null;
  if (messageType === "mogledge-close-tab-v1" && Object.keys(message).length === 2)
    return { type: "close-tab" };
  if (messageType === "mogledge-files-show-v1" && Object.keys(message).length === 2)
    return { type: "files-show" };
  if (messageType === "mogledge-sidebar-toggle-v1" && Object.keys(message).length === 2)
    return { type: "sidebar-toggle" };
  if (messageType === "mogledge-quick-open-v1" && Object.keys(message).length === 2)
    return { type: "quick-open" };
  if (messageType === "mogledge-ai-handoff-v1" && Object.keys(message).length === 2)
    return { type: "ai-handoff" };
  if (messageType === "mogledge-settings-open-v1" && Object.keys(message).length === 2)
    return { type: "settings-open" };
  if (
    messageType === "mogledge-document-pinch-v1" &&
    Object.keys(message).length === 5 &&
    typeof message.factor === "number" &&
    Number.isFinite(message.factor) &&
    message.factor >= 0.1 &&
    message.factor <= 10 &&
    typeof message.x === "number" &&
    Number.isFinite(message.x) &&
    message.x >= 0 &&
    message.x <= 1 &&
    typeof message.y === "number" &&
    Number.isFinite(message.y) &&
    message.y >= 0 &&
    message.y <= 1
  ) {
    return { type: "zoom", change: { factor: message.factor, x: message.x, y: message.y } };
  }
  if (Object.keys(message).length !== 3) return null;
  if (messageType === "mogledge-workspace-set-v1") {
    const slot = workspaceSetShortcutSlots.find((slot) => slot === message.slot);
    return slot ? { type: "workspace-set", slot } : null;
  }
  if (
    messageType === "mogledge-history-v1" &&
    (message.direction === "back" || message.direction === "forward")
  )
    return { type: "history", direction: message.direction };
  if (
    messageType === "mogledge-move-tab-v1" &&
    (message.direction === 0 || message.direction === 1)
  )
    return { type: "move", direction: message.direction };
  if (
    messageType === "mogledge-document-zoom-v1" &&
    (message.change === "in" || message.change === "out" || message.change === "reset")
  )
    return { type: "zoom", change: message.change };
  return null;
}

export function useDocumentShortcuts(
  stage: RefObject<HTMLDivElement | null>,
  state: AppState,
  controller: KnowledgeController,
  onQuickOpen?: () => void,
  onAiHandoff?: (tabId: string) => void,
  onToggleSidebar?: () => void,
  onOpenSettings?: (returnFocus: HTMLElement) => void,
  onShowFiles?: () => void,
) {
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    let stopped = false;
    let lastMove = -Infinity;
    const closingTabs = new Set<string>();
    const closeTab = (id: string) => {
      const current = controller.getSnapshot();
      if (current.loading || current.actionBusy || closingTabs.has(id)) return;
      if (!current.tabs.some((tab) => tab.id === id && !tab.closing)) return;
      closingTabs.add(id);
      const origin = document.activeElement;
      void controller.closeTab(id).then(() => {
        closingTabs.delete(id);
        if (stopped) return;
        if (controller.getSnapshot().tabs.some((tab) => tab.id === id)) return;
        // Keep a user's newer focus choice. An unmounted frame leaves body focused.
        if (document.activeElement !== origin && document.activeElement !== document.body) return;
        const next = controller.getSnapshot();
        const selected = next.columns[next.activeColumn];
        const target = selected ? document.getElementById(`document-tab-${selected}`) : null;
        (
          target ?? document.querySelector<HTMLButtonElement>('[aria-controls="knowledge-sidebar"]')
        )?.focus();
      });
    };
    const receive = (event: MessageEvent) => {
      const frame = document.activeElement;
      if (!(frame instanceof HTMLIFrameElement) || !stage.current?.contains(frame)) return;
      const shortcut = documentShortcut(event, frame);
      if (!shortcut) return;
      const current = latest.current;
      const pane = frame.closest<HTMLElement>(".document-pane");
      const tab = current.tabs.find((tab) => pane?.id === `panel-${tab.id}`);
      if (
        !tab ||
        tab.kind === "help" ||
        tab.closing ||
        !tab.url ||
        frame.src !== tab.url ||
        !current.columns.some((id, column) => id === tab.id && (column === 0 || current.split)) ||
        pane?.hidden ||
        frame.closest("[hidden], [inert]")
      )
        return;
      // The source frame identifies its own tab; main's previously active column may differ.
      const now = performance.now();
      if (shortcut.type === "close-tab") {
        controller.focusTab(tab.id);
        closeTab(tab.id);
      } else if (shortcut.type === "sidebar-toggle") {
        controller.focusTab(tab.id);
        onToggleSidebar?.();
      } else if (shortcut.type === "files-show") {
        controller.focusTab(tab.id);
        onShowFiles?.();
      } else if (shortcut.type === "history") {
        void controller.navigateHistory(shortcut.direction, current.split ? (tab.column ?? 0) : 0);
      } else if (shortcut.type === "move") {
        if (now - lastMove < 120) return;
        lastMove = now;
        controller.moveTab(tab.id, shortcut.direction);
      } else if (shortcut.type === "ai-handoff") {
        if (tab.loading || tab.deferred || current.actionBusy || current.loading) return;
        controller.focusTab(tab.id);
        onAiHandoff?.(tab.id);
      } else if (shortcut.type === "quick-open") {
        controller.focusTab(tab.id);
        onQuickOpen?.();
      } else if (shortcut.type === "settings-open") {
        if (tab.loading || tab.deferred || current.actionBusy || current.loading) return;
        controller.focusTab(tab.id);
        onOpenSettings?.(frame);
      } else if (shortcut.type === "workspace-set") {
        if (tab.loading || tab.deferred || current.actionBusy || current.loading) return;
        void controller.restoreWorkspaceSetShortcut(shortcut.slot);
      } else {
        controller.zoomTab(tab.id, shortcut.change);
      }
    };
    let composing = false;
    const start = () => {
      composing = true;
    };
    const end = () => {
      composing = false;
    };
    const shellKey = (event: KeyboardEvent) => {
      const primary = /Mac/i.test(navigator.platform)
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "w") {
        const cancelled = event.defaultPrevented;
        // Reserve the chord even on repeats, an empty app, or paused editors.
        event.preventDefault();
        if (
          cancelled ||
          event.repeat ||
          event.isComposing ||
          event.keyCode === 229 ||
          composing ||
          shortcutScope() !== "app" ||
          document.activeElement instanceof HTMLIFrameElement
        )
          return;
        const current = controller.getSnapshot();
        const id = current.columns[current.activeColumn];
        if (id) closeTab(id);
        return;
      }
      const slot = workspaceSetShortcutSlot(event);
      if (slot) {
        if (
          event.repeat ||
          event.isComposing ||
          event.keyCode === 229 ||
          event.defaultPrevented ||
          composing ||
          !document.hasFocus() ||
          shortcutScope() !== "app" ||
          document.activeElement instanceof HTMLIFrameElement
        )
          return;
        const current = controller.getSnapshot();
        if (current.loading || current.actionBusy || !current.workspaceSets?.setShortcuts[slot - 1])
          return;
        event.preventDefault();
        void controller.restoreWorkspaceSetShortcut(slot);
        return;
      }
      const direction = /Mac/i.test(navigator.platform)
        ? event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          (event.key === "[" ? "back" : event.key === "]" ? "forward" : null)
        : event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          (event.key === "ArrowLeft" ? "back" : event.key === "ArrowRight" ? "forward" : null);
      if (
        !direction ||
        event.shiftKey ||
        event.repeat ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.defaultPrevented ||
        composing ||
        shortcutScope() !== "app" ||
        document.activeElement instanceof HTMLIFrameElement
      )
        return;
      event.preventDefault();
      void controller.navigateHistory(direction);
    };
    document.addEventListener("compositionstart", start);
    document.addEventListener("compositionend", end);
    window.addEventListener("keydown", shellKey);
    window.addEventListener("message", receive);
    return () => {
      stopped = true;
      window.removeEventListener("message", receive);
      window.removeEventListener("keydown", shellKey);
      document.removeEventListener("compositionstart", start);
      document.removeEventListener("compositionend", end);
    };
  }, [controller, stage, onQuickOpen, onAiHandoff, onToggleSidebar, onOpenSettings, onShowFiles]);
}
