import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { translateUiMessage, useLanguage, useT } from "../lib/i18n";

export function StorageIdentityAction({
  platform = /Mac/i.test(navigator.platform) ? "macos" : "other",
}: {
  platform?: string;
}) {
  const t = useT();
  const language = useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  if (platform !== "macos") return null;
  const open = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await invoke<boolean>("open_storage_identity_transition", { language });
    } catch (error) {
      setError(typeof error === "string" ? error : "StorageUnavailable");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div>
      <p>
        {t(
          "Macの保存データは、独立したバックアップ後にフォルダーとHTMLごとの確認が必要です。未保存の入力を保存してから、確認ツールを開いてください。",
        )}
      </p>
      <button type="button" disabled={busy} onClick={() => void open()}>
        {t("保存データの確認ツールを開く")}
      </button>
      {error && <p role="alert">{translateUiMessage(error, language)}</p>}
    </div>
  );
}
