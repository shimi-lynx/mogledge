import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useLanguage } from "../lib/i18n";
import { residentApi } from "../lib/resident";
import type { KnowledgeController } from "../lib/controller";

export function useResident(controller: KnowledgeController) {
  const language = useLanguage();
  useEffect(() => {
    if (!isTauri()) return;
    void residentApi.update({ kind: "language", language }).catch(() => {});
  }, [language]);
  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false;
    let unlisten: UnlistenFn | undefined;
    void listen("resident-call", () => {
      // Keep an in-progress confirmation/input dialog intact when restoring.
      if (!stopped && !document.querySelector("dialog[open]"))
        void controller.selectResidentDocument(residentApi.resolve);
    })
      .then((cleanup) => {
        if (stopped) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {});
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [controller]);
}
