import { useCallback, useEffect, useRef, useState } from "react";
import { translateUiMessage, useLanguage, useT } from "../lib/i18n";
import { htmlAuthoringApi } from "../lib/htmlAuthoring";
import type {
  HtmlAuthoringApi,
  HtmlAuthoringContext,
  HtmlAuthoringPreview,
  HtmlAuthoringStatus,
} from "../lib/htmlAuthoring";

export function HtmlAuthoringSettings({
  context,
  api = htmlAuthoringApi,
}: {
  context: HtmlAuthoringContext | null;
  api?: HtmlAuthoringApi;
}) {
  const t = useT();
  const language = useLanguage();
  const [status, setStatus] = useState<HtmlAuthoringStatus | null>(null);
  const [preview, setPreview] = useState<HtmlAuthoringPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ count: number; skipped: number } | null>(null);
  const generation = useRef(0);
  const plan = useRef<{ context: HtmlAuthoringContext; id: string } | null>(null);
  const operation = useRef(false);
  const cancelPlan = useCallback(() => {
    const previous = plan.current;
    plan.current = null;
    if (previous) void api.cancel(previous.context, previous.id).catch(() => {});
  }, [api]);
  useEffect(() => {
    const request = ++generation.current;
    setStatus(null);
    setPreview(null);
    setError(null);
    setResult(null);
    setBusy(!!context);
    operation.current = !!context;
    if (context)
      void api
        .status(context)
        .then(
          (value) => {
            if (request === generation.current) setStatus(value);
          },
          (failure) => {
            if (request === generation.current) setError(String(failure));
          },
        )
        .finally(() => {
          if (request === generation.current) {
            setBusy(false);
            operation.current = false;
          }
        });
    return () => {
      generation.current++;
      cancelPlan();
    };
  }, [api, cancelPlan, context?.workspaceId, context?.viewId, context?.revision]);
  const inspect = async () => {
    if (!context || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    cancelPlan();
    setPreview(null);
    const request = generation.current;
    try {
      const value = await api.preview(context);
      if (request !== generation.current) {
        void api.cancel(context, value.planId).catch(() => {});
        return;
      }
      plan.current = { context, id: value.planId };
      setPreview(value);
    } catch (failure) {
      if (request === generation.current) setError(String(failure));
    } finally {
      if (request === generation.current) {
        setBusy(false);
        operation.current = false;
      }
    }
  };
  const install = async () => {
    if (!context || !preview || preview.readOnly || operation.current) return;
    const request = generation.current;
    const selected = plan.current;
    if (!selected) return;
    plan.current = null;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = await api.install(context, selected.id);
      if (request !== generation.current) return;
      setPreview(null);
      setResult({ count: value.written.length, skipped: value.skipped.length });
      if (value.error) setError(value.error);
      const next = await api.status(context);
      if (request === generation.current) setStatus(next);
    } catch (failure) {
      if (request === generation.current) {
        setPreview(null);
        setError(String(failure));
      }
    } finally {
      if (request === generation.current) {
        setBusy(false);
        operation.current = false;
      }
    }
  };
  return (
    <section id="settings-html-authoring-panel" aria-labelledby="settings-html-authoring-heading">
      <h2 id="settings-html-authoring-heading">{t("AIによるHTML制作")}</h2>
      {!context ? (
        <p>{t("作業フォルダーを選択してください")}</p>
      ) : (
        <>
          <p>
            {t(
              "専用フォルダーには、保存 API のガイド・HTML テンプレート・Codex / Claude Skills が必要です。配置内容を確認できます。",
            )}
          </p>
          <p>{t("既存のAGENTS.md・CLAUDE.mdや利用者が変更したファイルは上書きしません。")}</p>
          <button type="button" disabled={busy} onClick={() => void inspect()}>
            {t("配置内容を確認")}
          </button>
          {preview && (
            <div className="html-authoring-preview" role="region" aria-label={t("配置内容")}>
              <ul>
                {preview.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>{" "}
                    <span>
                      {t(
                        (
                          {
                            create: "新規作成",
                            current: "配置済み",
                            conflict: "既存の内容を保持",
                          } as const
                        )[file.action],
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {preview.error && <p role="alert">{translateUiMessage(preview.error, language)}</p>}
              <button
                type="button"
                disabled={
                  busy ||
                  preview.readOnly ||
                  !preview.files.some((file) => file.action === "create")
                }
                onClick={() => void install()}
              >
                {t("確認した内容を配置")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  cancelPlan();
                  setPreview(null);
                }}
              >
                {t("キャンセル")}
              </button>
            </div>
          )}
          <p>{t("AI に渡す依頼には、専用フォルダーの制作ガイドを読む指示を必ず付けます。")}</p>
          {status?.error && status.error !== preview?.error && (
            <p role="alert">{translateUiMessage(status.error, language)}</p>
          )}
        </>
      )}
      {busy && <p role="status">{t("確認しています")}</p>}
      {result && <p role="status">{t("{count}件を配置し、{skipped}件を保持しました", result)}</p>}
      {error && <p role="alert">{translateUiMessage(error, language)}</p>}
    </section>
  );
}
