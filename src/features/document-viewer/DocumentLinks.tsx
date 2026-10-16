import { useT } from "../../lib/i18n";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { AppState } from "../../lib/types";
import type { KnowledgeController } from "../../lib/controller";
import { shortcutScope } from "../../app/windowChrome";
import "./document-links.css";

type ExternalCandidate = {
  tabId: string;
  sourceUrl: string;
  path: string;
  url: string;
  workspaceId: string | null;
  viewId: string;
};

export function DocumentLinks({
  stage,
  state,
  controller,
}: {
  stage: RefObject<HTMLDivElement | null>;
  state: AppState;
  controller: KnowledgeController;
}) {
  const t = useT();
  const latest = useRef(state);
  latest.current = state;
  const [external, setExternal] = useState<ExternalCandidate | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const valid =
    external &&
    state.snapshot.workspaceId === external.workspaceId &&
    state.snapshot.viewId === external.viewId &&
    state.columns.some((id, column) => id === external.tabId && (column === 0 || state.split)) &&
    state.tabs.some(
      (tab) =>
        tab.id === external.tabId && tab.url === external.sourceUrl && !tab.closing && !tab.missing,
    );
  useEffect(() => {
    if (external && !valid) setExternal(null);
  }, [external, valid]);
  useLayoutEffect(() => {
    if (external && valid && dialog.current && !dialog.current.open) {
      dialog.current.showModal();
      cancel.current?.focus();
    }
  }, [external, valid]);
  useEffect(() => {
    let waiting = false;
    let disposed = false;
    let last = -Infinity;
    const receive = async (event: MessageEvent) => {
      const frame = document.activeElement;
      const data: unknown = event.data;
      if (
        waiting ||
        performance.now() - last < 300 ||
        event.origin !== "null" ||
        !(frame instanceof HTMLIFrameElement) ||
        event.source !== frame.contentWindow ||
        !stage.current?.contains(frame) ||
        !document.hasFocus() ||
        shortcutScope() !== "app" ||
        !data ||
        typeof data !== "object" ||
        Array.isArray(data)
      )
        return;
      const message = data as Record<string, unknown>;
      // Legacy messages share all source, token and payload checks.
      const messageType =
        typeof message.type === "string"
          ? message.type.replace(/^my-knowledge-/, "mogledge-")
          : message.type;
      if (
        Object.keys(message).length !== 3 ||
        messageType !== "mogledge-link-v1" ||
        typeof message.href !== "string" ||
        message.href.length > 8192
      )
        return;
      let token: string | undefined;
      try {
        token = new URL(frame.src).pathname.match(/^\/s\/([a-f0-9]{64})\//)?.[1];
      } catch {
        return;
      }
      if (!token || message.token !== token) return;
      const current = latest.current;
      const tab = current.tabs.find(
        (tab) => frame.closest(".document-pane")?.id === "panel-" + tab.id,
      );
      if (
        !tab?.url ||
        tab.url !== frame.src ||
        tab.closing ||
        tab.missing ||
        frame.closest("[hidden], [inert]") ||
        !current.columns.some((id, column) => id === tab.id && (column === 0 || current.split))
      )
        return;
      waiting = true;
      const previousLast = last;
      last = performance.now();
      try {
        const target = await controller.resolveDocumentLink(tab.id, tab.url, message.href);
        if (disposed || document.activeElement !== frame || shortcutScope() !== "app") return;
        if (target?.kind === "external") {
          // Source/token checks identify a document, not a human click. Main's
          // own trusted button is the sole path from proposals to OS dispatch.
          setExternal({
            tabId: tab.id,
            sourceUrl: tab.url,
            path: tab.path,
            url: target.url,
            workspaceId: current.snapshot.workspaceId,
            viewId: current.snapshot.viewId,
          });
        } else if (target) {
          // Page-local anchors previously stayed inside the frame. They must
          // not delay the next document link now that host confirms fragments.
          if (target.kind === "page") last = previousLast;
          await controller.followDocumentLink(tab.id, tab.url, target);
        }
      } finally {
        waiting = false;
      }
    };
    const handler = (event: MessageEvent) => {
      void receive(event);
    };
    window.addEventListener("message", handler);
    return () => {
      disposed = true;
      window.removeEventListener("message", handler);
    };
  }, [stage, controller]);
  if (!external || !valid) return null;
  return (
    <dialog
      ref={dialog}
      className="external-link-dialog"
      aria-labelledby="external-link-title"
      onCancel={(event) => {
        event.preventDefault();
        setExternal(null);
      }}
    >
      <h2 id="external-link-title">{t("外部リンクを開く")}</h2>
      <p>{t("「{path}」から次のURLを既定ブラウザーで開きます。", { path: external.path })}</p>
      <code>{external.url}</code>
      <div className="external-link-actions">
        <button ref={cancel} disabled={state.actionBusy} onClick={() => setExternal(null)}>
          {t("キャンセル")}
        </button>
        <button
          disabled={state.actionBusy}
          onClick={(event) => {
            if (!event.nativeEvent.isTrusted) return;
            void controller
              .openExternalDocumentLink(external.tabId, external.sourceUrl, external.url)
              .then((opened) => {
                if (opened) setExternal(null);
              });
          }}
        >
          {t("既定ブラウザーで開く")}
        </button>
      </div>
    </dialog>
  );
}
