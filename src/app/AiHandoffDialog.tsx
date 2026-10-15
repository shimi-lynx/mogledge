import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { aiCopyFailureMessage, aiDestinations, aiDraft, aiDraftLimit } from "../lib/aiHandoff";
import { useT } from "../lib/i18n";
import type {
  AiDestination,
  AiHandoffApi,
  AiHandoffContext,
  AiHandoffPreview,
} from "../lib/aiHandoff";
import "./ai-handoff.css";

export default function AiHandoffDialog({
  context,
  api,
  onClose,
  returnFocus,
}: {
  context: AiHandoffContext;
  api: AiHandoffApi;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<AiHandoffPreview | null>(null);
  const [preparing, setPreparing] = useState(true);
  const [instruction, setInstruction] = useState("");
  const [destination, setDestination] = useState<AiDestination>("codexApp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const submitting = useRef(false);
  const composing = useRef(false);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = returnFocus ?? document.activeElement;
    element.showModal();
    element.querySelector<HTMLElement>("select")?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreparing(true);
    void api.prepare(context).then(
      (value) => {
        if (active) {
          setPreview(value);
          setPreparing(false);
        }
      },
      () => {
        if (active) {
          setPreparing(false);
          setError("対象のパスを確認できません。項目を選び直して確認画面を開き直してください。");
        }
      },
    );
    return () => {
      active = false;
    };
  }, [api, context]);
  const draft = preview ? aiDraft(preview, instruction) : "";
  const tooLong = draft.length > aiDraftLimit(destination);
  const instructionHint =
    destination === "codexCli"
      ? "コピーには作業ルートと対象を含めます。相手側で作業ルートを選び、AIの入力欄に貼り付けてください。"
      : "専用ルートを作業ディレクトリーにします。子フォルダー・ファイルは対象パスとして依頼文に含めます。依頼文が空でも対象と制作ガイドの案内を渡します。";
  const perform = async (copy: boolean) => {
    if (!preview || busy || submitting.current || composing.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await api.perform({ context, preview, instruction, destination, copy });
      setStatus(
        copy
          ? "依頼文をコピーしました。相手の入力欄に貼り付け、確認して送信してください。"
          : "OSに開く操作を依頼しました。相手の下書きを確認して送信してください。開かなければ依頼文をコピーしてください。受信・表示は確認できません。",
      );
    } catch (failure) {
      // Do not echo OS/IPC exception text: it could include a prompt URL.
      setError(
        copy
          ? aiCopyFailureMessage(failure)
          : "受け渡しできませんでした。対象の変更、連携先の導入・リンク登録、長文や特殊文字を確認してください。短くするか依頼文をコピーし、対象が変わった場合は確認画面を開き直してください。",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="app-surface ai-handoff-dialog"
      aria-labelledby="ai-handoff-title"
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy && !submitting.current && !composing.current) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          event.key === "Enter" &&
          (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current)
        )
          event.preventDefault();
      }}
    >
      <h2 id="ai-handoff-title">{t("AIに渡す")}</h2>
      <p>{t("ファイル内容は添付しません。送信・実行は相手の画面で確認してください。")}</p>
      <label>
        {t("連携先")}
        <select
          value={destination}
          disabled={busy}
          onChange={(event) => {
            const selected = aiDestinations.find((entry) => entry.value === event.target.value);
            if (selected) setDestination(selected.value);
            setStatus(null);
            setError(null);
          }}
        >
          {aiDestinations.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {t(entry.label)}
            </option>
          ))}
        </select>
      </label>
      <p className="ai-handoff-hint">
        {t(aiDestinations.find((entry) => entry.value === destination)?.hint ?? "")}
      </p>
      {preparing && <p role="status">{t("パスを確認しています")}</p>}
      <label>
        {t("依頼文（任意）")}
        <textarea
          value={instruction}
          readOnly={busy}
          rows={10}
          aria-describedby="ai-handoff-instruction-hint"
          onChange={(event) => {
            setInstruction(event.target.value);
            setStatus(null);
            setError(null);
          }}
        />
      </label>
      <p className="ai-handoff-hint" id="ai-handoff-instruction-hint">
        {t(instructionHint)}
        {preview?.guideInstruction && (
          <span>
            {" "}
            {t(
              "この作業フォルダーの設定に従い、制作ガイドを読む指示を追加します。入力した依頼文は保持します。",
            )}
          </span>
        )}
      </p>
      {tooLong && (
        <p role="alert">
          {t(
            "この連携先の文字数上限を超えています。依頼文を短くするか依頼文をコピーしてください。切り詰めません。",
          )}
        </p>
      )}
      {error && <p role="alert">{t(error)}</p>}
      {status && <p role="status">{t(status)}</p>}
      <div className="ai-handoff-buttons">
        <button type="button" disabled={busy} onClick={onClose}>
          {t("閉じる")}
        </button>
        <button
          type="button"
          disabled={busy || !preview || instruction.length > 65_536}
          onClick={() => void perform(true)}
        >
          {t("依頼文をコピー")}
        </button>
        {destination !== "codexCli" && (
          <button
            type="button"
            disabled={busy || !preview || tooLong}
            onClick={() => void perform(false)}
          >
            {t("AIに渡す")}
          </button>
        )}
      </div>
    </dialog>
  );
}
