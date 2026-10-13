import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { shortcutScope } from "../../app/windowChrome";
import { useT } from "../../lib/i18n";
import type { AppState } from "../../lib/types";
import type { KnowledgeController } from "../../lib/controller";
import {
  artifactBytes,
  artifactError,
  artifactErrorCode,
  artifactExportApi,
  artifactProposal,
  type ArtifactContext,
  type ArtifactExportApi,
  type ArtifactProposal,
  type ArtifactReceipt,
} from "../../lib/artifactExport";
import "./document-exports.css";

type Proposal = ArtifactProposal & {
  id: string;
  tabId: string;
  url: string;
  frame: HTMLIFrameElement;
  context: ArtifactContext;
};
const sameContext = (first: ArtifactContext | null, second: ArtifactContext) =>
  first !== null &&
  Object.entries(second).every(([key, value]) => first[key as keyof ArtifactContext] === value);

export function DocumentExports({
  stage,
  state,
  controller,
  api = artifactExportApi,
}: {
  stage: RefObject<HTMLDivElement | null>;
  state: AppState;
  controller: KnowledgeController;
  api?: ArtifactExportApi;
}) {
  const t = useT();
  const latest = useRef(state);
  latest.current = state;
  const pending = useRef<Proposal | null>(null);
  const last = useRef(-Infinity);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const composing = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const reply = (item: Proposal, result: ArtifactReceipt | { error: string }) => {
    // Replies disclose no Native path, file contents or OS exception text.
    if (item.frame.isConnected && item.frame.src === item.url)
      item.frame.contentWindow?.postMessage(
        { type: "my-knowledge-artifact-result-v1", token: item.context.token, id: item.id, result },
        "*",
      );
  };
  const current = (item: Proposal) =>
    item.frame.isConnected &&
    stage.current?.contains(item.frame) &&
    item.frame.src === item.url &&
    !item.frame.closest("[hidden], [inert]") &&
    sameContext(controller.artifactContext(item.tabId, item.url), item.context);
  const close = () => {
    if (submitting.current) return;
    const item = pending.current;
    if (item) reply(item, { status: "cancelled" });
    pending.current = null;
    setProposal(null);
    setError(null);
  };
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frame = document.activeElement;
      const value: unknown = event.data;
      if (
        event.origin !== "null" ||
        !(frame instanceof HTMLIFrameElement) ||
        !stage.current?.contains(frame) ||
        event.source !== frame.contentWindow ||
        !document.hasFocus() ||
        shortcutScope() !== "app" ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
      )
        return;
      const message = value as Record<string, unknown>;
      if (
        Object.keys(message).sort().join() !== "data,format,id,name,token,type" ||
        message.type !== "my-knowledge-artifact-export-v1" ||
        typeof message.id !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(message.id)
      )
        return;
      const pane = frame.closest<HTMLElement>(".document-pane");
      const tab = latest.current.tabs.find((item) => pane?.id === "panel-" + item.id);
      if (!tab || pane?.hidden || frame.closest("[hidden], [inert]")) return;
      const context = controller.artifactContext(tab.id, frame.src);
      if (!context || context.token !== message.token) return;
      const base = { id: message.id, tabId: tab.id, url: frame.src, frame, context };
      const reject = (code: string) =>
        frame.contentWindow?.postMessage(
          {
            type: "my-knowledge-artifact-result-v1",
            token: context.token,
            id: message.id,
            result: { error: code },
          },
          "*",
        );
      if (pending.current) {
        reject("ArtifactBusy");
        return;
      }
      if (performance.now() - last.current < 1000) {
        reject("ArtifactCooldown");
        return;
      }
      last.current = performance.now();
      const payload = artifactProposal(message);
      if (!payload) {
        reject("ArtifactTooLargeOrInvalid");
        return;
      }
      const item = { ...base, ...payload };
      pending.current = item;
      setError(null);
      setProposal(item);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      if (pending.current) reply(pending.current, { error: "ArtifactResultUnknown" });
      pending.current = null;
    };
  }, [controller, stage]);
  useEffect(() => {
    const item = pending.current;
    if (item && !submitting.current && !current(item)) {
      reply(item, { error: "ArtifactSourceChanged" });
      pending.current = null;
      setProposal(null);
    }
  }, [state, controller, stage]);
  useLayoutEffect(() => {
    if (!proposal) return;
    const element = dialog.current!;
    element.showModal();
    element.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      element.close();
      if (proposal.frame.isConnected && !proposal.frame.closest("[hidden], [inert]")) {
        proposal.frame.focus();
        proposal.frame.contentWindow?.focus();
      }
    };
  }, [proposal]);
  useEffect(() => {
    if (!proposal) return;
    const timer = setTimeout(() => {
      if (!submitting.current && pending.current === proposal) {
        reply(proposal, { error: "ArtifactResultUnknown" });
        pending.current = null;
        setError(artifactError("ArtifactResultUnknown"));
      }
    }, 300000);
    return () => clearTimeout(timer);
  }, [proposal]);
  const save = async () => {
    const item = pending.current;
    if (
      !item ||
      submitting.current ||
      composing.current ||
      !navigator.userActivation?.isActive ||
      !document.hasFocus()
    )
      return;
    if (!current(item)) {
      reply(item, { error: "ArtifactSourceChanged" });
      pending.current = null;
      setError(artifactError("ArtifactSourceChanged"));
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      const result = await api({
        context: item.context,
        format: item.format,
        name: item.name,
        data: item.data,
      });
      const valid =
        (result?.status === "cancelled" && Object.keys(result).join() === "status") ||
        (result?.status === "saved" &&
          Object.keys(result).sort().join() === "bytes,name,status" &&
          typeof result.name === "string" &&
          result.name.length > 0 &&
          result.name.length <= 1024 &&
          !/[\\/]/.test(result.name) &&
          Number.isSafeInteger(result.bytes) &&
          result.bytes === artifactBytes(item.data));
      if (!valid) throw "ArtifactResultUnknown";
      reply(item, result);
      pending.current = null;
      setProposal(null);
    } catch (failure) {
      const code = artifactErrorCode(failure);
      reply(item, { error: code });
      pending.current = null;
      // No retry button and no browser download after an uncertain or rejected Native save.
      setError(artifactError(code));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  if (!proposal) return null;
  return createPortal(
    <dialog
      ref={dialog}
      className="app-surface document-export-dialog"
      aria-labelledby="document-export-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!composing.current) close();
      }}
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          event.key === "Enter" &&
          (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        )
          event.preventDefault();
      }}
    >
      <h2 id="document-export-title">{t("生成ファイルを書き出す")}</h2>
      <p>
        {t(
          "入力状態のバックアップではありません。保存先を選び、新規ファイルとして保存します。既存ファイルは上書きしません。",
        )}
      </p>
      <dl>
        <dt>{t("文書")}</dt>
        <dd>{state.tabs.find((tab) => tab.id === proposal.tabId)?.path ?? ""}</dd>
        <dt>{t("候補名")}</dt>
        <dd>{proposal.name}</dd>
        <dt>{t("形式")}</dt>
        <dd>{proposal.format.toUpperCase()}</dd>
        <dt>{t("容量")}</dt>
        <dd>
          {artifactBytes(proposal.data).toLocaleString()} {t("バイト")}
        </dd>
      </dl>
      <p>
        {t(
          "名前は安全なファイル名に調整し、形式に対応する拡張子を付けます。保存後に自動で開きません。",
        )}
      </p>
      <p>{t("画像は署名の確認のみです。画像内容の完全な安全性を保証するものではありません。")}</p>
      {busy && <p role="status">{t("保存先の選択と保存の完了を待っています")}</p>}
      {error && <p role="alert">{t(error)}</p>}
      <div className="document-export-buttons">
        <button disabled={busy} onClick={close}>
          {t("閉じる")}
        </button>
        <button disabled={busy || !!error} onClick={() => void save()}>
          {t("保存先を選ぶ")}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
