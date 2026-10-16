import { useEffect, useRef, type RefObject } from "react";
import type { AppState } from "../../lib/types";
import type { KnowledgeController } from "../../lib/controller";

export function useDocumentReady(
  stage: RefObject<HTMLDivElement | null>,
  state: AppState,
  controller: KnowledgeController,
) {
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (event.origin !== "null" || !data || typeof data !== "object" || Array.isArray(data))
        return;
      const message = data as Record<string, unknown>;
      // Legacy messages share all source, token and payload checks.
      const messageType =
        typeof message.type === "string"
          ? message.type.replace(/^my-knowledge-/, "mogledge-")
          : message.type;
      const ready =
        messageType === "mogledge-document-ready-v1" && Object.keys(message).length === 2;
      const storage =
        messageType === "mogledge-storage-request-v1" && Object.keys(message).length === 2;
      const anchor =
        messageType === "mogledge-anchor-result-v1" &&
        Object.keys(message).length === 4 &&
        Number.isSafeInteger(message.request) &&
        typeof message.success === "boolean";
      if (!ready && !anchor && !storage) return;
      for (const frame of stage.current?.querySelectorAll("iframe") ?? []) {
        if (frame.contentWindow !== event.source) continue;
        const tab = latest.current.tabs.find(
          (tab) => frame.closest(".document-pane")?.id === `panel-${tab.id}`,
        );
        if (!tab || tab.closing || !tab.url || frame.src !== tab.url) return;
        const token = new URL(tab.url).pathname.match(/^\/s\/([a-f0-9]{64})\//)?.[1];
        if (token && message.token === token) {
          if (ready) controller.documentReady(tab.id, tab.url);
          else if (storage) controller.documentStorageRequested(tab.id, tab.url);
          else
            controller.documentAnchorResult(
              tab.id,
              tab.url,
              message.request as number,
              message.success as boolean,
            );
        }
        return;
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [controller, stage]);
}
