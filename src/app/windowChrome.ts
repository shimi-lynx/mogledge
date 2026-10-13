import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type WindowCommand =
  | "focus-search"
  | "reopen-closed-tab"
  | "move-tab-left"
  | "move-tab-right";

export interface WindowChrome {
  platform: "windows" | "macos" | "other";
  height: number;
  leftInset: number;
  rightInset: number;
  maximized?: boolean;
}

export function shortcutScope(composing = false): "app" | "search-input" | "paused" {
  if (composing || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]'))
    return "paused";
  const active = document.activeElement;
  if (active?.id === "document-search-query") return "search-input";
  if (active instanceof HTMLElement && active.closest("input, textarea, select, [contenteditable]"))
    return "paused";
  return "app";
}

export function acceptsWindowCommand(command: WindowCommand, composing = false): boolean {
  const scope = shortcutScope(composing);
  return scope === "app" || (scope === "search-input" && command === "focus-search");
}

function validChrome(value: unknown): value is WindowChrome {
  if (!value || typeof value !== "object") return false;
  const chrome = value as Partial<WindowChrome>;
  return (
    ["windows", "macos", "other"].includes(chrome.platform ?? "") &&
    (chrome.maximized === undefined || typeof chrome.maximized === "boolean") &&
    [chrome.height, chrome.leftInset, chrome.rightInset].every(
      (size) => typeof size === "number" && Number.isFinite(size) && size >= 0 && size <= 512,
    )
  );
}

export function useWindowChrome(onCommand: (command: WindowCommand) => void) {
  const native = isTauri();
  const platform = !native
    ? "other"
    : /Mac/i.test(navigator.platform)
      ? "macos"
      : /Win/i.test(navigator.platform)
        ? "windows"
        : "other";
  const [chrome, setChrome] = useState<WindowChrome>({
    platform,
    height: 40,
    leftInset: platform === "macos" ? 80 : 0,
    rightInset: platform === "windows" ? 138 : 0,
    maximized: false,
  });
  const handler = useRef(onCommand);
  handler.current = onCommand;
  const composing = useRef(false);

  useEffect(() => {
    if (!native) return;
    let stopped = false;
    const subscriptions: UnlistenFn[] = [];
    const add = (subscription: Promise<UnlistenFn>) => {
      void subscription
        .then((unlisten) => {
          if (stopped) unlisten();
          else subscriptions.push(unlisten);
        })
        .catch(() => {});
    };
    const update = (value: unknown) => {
      if (!stopped && validChrome(value)) setChrome(value);
    };
    add(listen<unknown>("window-chrome-changed", ({ payload }) => update(payload)));
    add(
      listen<unknown>("window-command", ({ payload }) => {
        if (
          typeof payload === "string" &&
          ["focus-search", "reopen-closed-tab"].includes(payload)
        ) {
          const command = payload as WindowCommand;
          if (acceptsWindowCommand(command, composing.current)) handler.current(command);
        }
      }),
    );
    void invoke<unknown>("get_window_chrome")
      .then(update)
      .catch(() => {});
    // Fixed scope states protect shell editors and dialogs. Documents never gain
    // Native capabilities; column moves use a separate, scoped DOM message.
    let lastScope = "";
    const syncScope = () => {
      if (stopped) return;
      const scope = shortcutScope(composing.current);
      if (scope === lastScope) return;
      lastScope = scope;
      void invoke("set_window_shortcut_scope", { scope }).catch(() => {});
    };
    const startComposition = () => {
      composing.current = true;
      syncScope();
    };
    const endComposition = () => {
      composing.current = false;
      syncScope();
    };
    const focusChanged = () => queueMicrotask(syncScope);
    document.addEventListener("focusin", syncScope);
    document.addEventListener("focusout", focusChanged);
    document.addEventListener("compositionstart", startComposition);
    document.addEventListener("compositionend", endComposition);
    const dialogs = new MutationObserver(syncScope);
    dialogs.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open", "aria-modal"],
    });
    syncScope();
    return () => {
      stopped = true;
      subscriptions.forEach((unlisten) => unlisten());
      dialogs.disconnect();
      document.removeEventListener("focusin", syncScope);
      document.removeEventListener("focusout", focusChanged);
      document.removeEventListener("compositionstart", startComposition);
      document.removeEventListener("compositionend", endComposition);
    };
  }, [native]);
  return chrome;
}
