import { useEffect, useRef, useState } from "react";
import { translateUiMessage, useLanguage, useT } from "../lib/i18n";
import type { Bridge, DocumentIdentityAction, DocumentIdentityStatus } from "../lib/types";

export const documentIdentityHoldMessages: Readonly<Record<string, string>> = {
  DocumentIdentityMissing:
    "文書 ID がありません。HTML は閲覧できますが、保存データの利用は保留中です。",
  DocumentIdentityInvalid: "文書 ID が不正または複数あります。HTML の文書 ID を修正してください。",
  DocumentIdentityDuplicate:
    "同じ文書 ID の HTML があります。保存データを共有するか、別の文書として扱うか選んでください。",
};

export function DocumentIdentityControls({
  api,
  workspaceId,
  viewId,
  relativePath,
  onConfigured,
}: {
  api: Bridge;
  workspaceId: string;
  viewId: string;
  relativePath: string;
  onConfigured: () => Promise<void>;
}) {
  const t = useT();
  const language = useLanguage();
  const [status, setStatus] = useState<DocumentIdentityStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const configure = (action: DocumentIdentityAction) =>
    void run(async () => {
      if (!api.configureDocumentIdentity) throw new Error("文書 ID を設定できません");
      await api.configureDocumentIdentity(workspaceId, viewId, relativePath, action);
      if (!mounted.current) return;
      setStatus(null);
      await onConfigured();
    });
  return (
    <div className="document-identity-controls" aria-busy={busy}>
      <button
        type="button"
        disabled={busy || !api.getDocumentIdentityStatus}
        onClick={() =>
          void run(async () => {
            const next = await api.getDocumentIdentityStatus!(workspaceId, viewId, relativePath);
            if (mounted.current) {
              setStatus(next);
            }
          })
        }
      >
        {t("文書 ID を確認")}
      </button>
      {status && (
        <>
          {status.uuid && (
            <p>
              {t("文書 ID")}: {status.uuid}
            </p>
          )}
          <p>
            {t(
              status.status === "ready"
                ? "文書 ID を確認できました。再読み込みで保存データの利用を再開します。"
                : documentIdentityHoldMessages[
                    {
                      missing: "DocumentIdentityMissing",
                      invalid: "DocumentIdentityInvalid",
                      duplicate: "DocumentIdentityDuplicate",
                    }[status.status]
                  ]!,
            )}
          </p>
          {status.status !== "ready" && status.status !== "invalid" && (
            <p>
              {t(
                "以下の操作は HTML を書き換えます。新しい ID は別の保存データを使い、共有は同じ ID の保存データを使います。",
              )}
            </p>
          )}
          <div className="document-identity-actions">
            {status.status === "missing" && status.canAssign && (
              <button type="button" disabled={busy} onClick={() => configure("add")}>
                {t("HTML に文書 ID を追加")}
              </button>
            )}
            {status.status === "duplicate" && status.canAssign && (
              <button type="button" disabled={busy} onClick={() => configure("new")}>
                {t("新しい ID で別の文書にする")}
              </button>
            )}
            {status.status === "duplicate" && status.canShare && (
              <button type="button" disabled={busy} onClick={() => configure("share")}>
                {t("同じ ID の保存データを共有")}
              </button>
            )}
            {status.status === "ready" && (
              <button type="button" disabled={busy} onClick={() => void run(onConfigured)}>
                {t("文書を再読み込み")}
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => setStatus(null)}>
              {t("閉じる")}
            </button>
          </div>
        </>
      )}
      {error && <p role="alert">{translateUiMessage(error, language)}</p>}
    </div>
  );
}
