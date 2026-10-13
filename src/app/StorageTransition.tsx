import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../lib/i18n";
import { storageTransitionMessages } from "../lib/i18n/storageTransition";
import "./saved-data-settings.css";

type JsonObject = Record<string, unknown>;
type Entry = {
  documentIdentity: string;
  rootIdentity: string;
  relativePathHint: string;
  revision: number;
  bytes: number;
};
type Inspection = {
  rootIdentity: string;
  schemaVersion: number;
  entries: Entry[];
  rootConfirmed?: boolean;
};
type Plan = {
  planId: string;
  confirmation: string;
  backupDirectory: string;
  backupManifestHash: string;
  backupScope: string;
  preview: JsonObject;
  expiresAt: number;
};
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function inspection(value: unknown): Inspection | null {
  if (
    !object(value) ||
    !text(value.rootIdentity) ||
    !count(value.schemaVersion) ||
    value.payloadsIncluded !== false ||
    !Array.isArray(value.entries) ||
    value.entries.length > 4096 ||
    !value.entries.every(
      (entry: unknown) =>
        object(entry) &&
        text(entry.documentIdentity) &&
        text(entry.rootIdentity) &&
        typeof entry.relativePathHint === "string" &&
        count(entry.revision) &&
        count(entry.bytes),
    )
  )
    return null;
  return value as Inspection;
}
function readPlan(value: unknown): Plan | null {
  if (
    !object(value) ||
    !text(value.planId) ||
    value.confirmation !== `confirm:${value.planId}` ||
    !text(value.backupDirectory) ||
    !text(value.backupManifestHash) ||
    !text(value.backupScope) ||
    !object(value.preview) ||
    !text(value.preview.operation) ||
    ![
      "acknowledge_root",
      "copy_selected_legacy",
      "confirm_empty",
      "restore_preferences",
      "rollback",
    ].includes(value.preview.operation) ||
    !count(value.expiresInMs) ||
    value.expiresInMs === 0 ||
    value.expiresInMs > 300000
  )
    return null;
  const preview = value.preview;
  if (
    preview.operation === "acknowledge_root" &&
    (!text(preview.rootIdentity) ||
      !count(preview.databaseSchemaVersion) ||
      preview.olderAppsWillReject !== true ||
      preview.legacyPreferencesRetained !== true)
  )
    return null;
  if (
    ["copy_selected_legacy", "confirm_empty"].includes(String(preview.operation)) &&
    (!text(preview.rootIdentity) ||
      !text(preview.documentIdentity) ||
      !text(preview.targetRelativePath) ||
      !text(preview.sourceOwnership))
  )
    return null;
  if (
    preview.operation === "copy_selected_legacy" &&
    (!text(preview.sourceIdentity) ||
      !count(preview.sourceRevision) ||
      !text(preview.sourcePayloadHash))
  )
    return null;
  if (
    preview.operation === "restore_preferences" &&
    (!text(preview.sourceRootIdentity) ||
      !text(preview.targetRootIdentity) ||
      !text(preview.pathOwnership) ||
      !count(preview.mappedDocumentReferences) ||
      !count(preview.unresolvedDocumentReferences) ||
      !count(preview.unresolvedFolderReferences) ||
      preview.sourceRetained !== true ||
      preview.existingTargetReplacement !== false ||
      preview.outputVersion !== 4 ||
      !Array.isArray(preview.files) ||
      preview.files.length > 4096 ||
      !preview.files.every(
        (file: unknown) =>
          object(file) && text(file.relativePath) && text(file.sha256) && count(file.bytes),
      ))
  )
    return null;
  if (
    preview.operation === "rollback" &&
    (preview.currentFormatWillBeReplaced !== true ||
      preview.keepCurrentBackup !== true ||
      preview.olderAppsMayResume !== true ||
      preview.sourceRetained !== true ||
      preview.inactivePreferenceCopiesRetained !== true ||
      preview.changedOriginalPreferencesAllowed !== false ||
      !count(preview.targetSchemaVersion) ||
      ![1, 2, 3].includes(preview.targetSchemaVersion))
  )
    return null;
  return { ...value, expiresAt: Date.now() + value.expiresInMs } as Plan;
}
// Never render arbitrary JSON: even an unexpected Native response must not expose values.
const previewFields = [
  "operation",
  "rootIdentity",
  "databaseSchemaVersion",
  "schemaVersion",
  "olderAppsWillReject",
  "legacyPreferencesRetained",
  "targetRelativePath",
  "documentIdentity",
  "sourceIdentity",
  "sourceRevision",
  "sourcePayloadHash",
  "sourceOwnership",
  "sourceRetained",
  "existingTargetReplacement",
  "sourceRootIdentity",
  "targetRootIdentity",
  "pathOwnership",
  "mappedDocumentReferences",
  "unresolvedDocumentReferences",
  "unresolvedFolderReferences",
  "outputVersion",
  "currentFormatWillBeReplaced",
  "keepCurrentBackup",
  "olderAppsMayResume",
  "inactivePreferenceCopiesRetained",
  "changedOriginalPreferencesAllowed",
  "targetSchemaVersion",
  "backupDirectory",
  "backupManifestHash",
  "backupScope",
  "settingsPublished",
  "settingsMatchRoot",
] as const;

export function StorageTransition() {
  const language = useLanguage();
  const t = (message: string) =>
    language === "en" ? (storageTransitionMessages[message] ?? message) : message;
  const [rootPath, setRootPath] = useState("");
  const [backupParent, setBackupParent] = useState("");
  const [session, setSession] = useState(false);
  const [rootConfirmed, setRootConfirmed] = useState(false);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Inspection | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [relativePath, setRelativePath] = useState("");
  const [sourceRoot, setSourceRoot] = useState("");
  const [rollbackDirectory, setRollbackDirectory] = useState("");
  const [backupAccepted, setBackupAccepted] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [invalidPlan, setInvalidPlan] = useState(false);
  const [unknownOperation, setUnknownOperation] = useState<Plan | null>(null);
  const [result, setResult] = useState<JsonObject | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancellation, setCancellation] = useState<"idle" | "sending" | "requested" | "failed">(
    "idle",
  );
  const [now, setNow] = useState(Date.now());
  // Ref closes the same-turn double-click gap before React applies disabled controls.
  const working = useRef(false);
  const cancellationRequested = useRef(false);
  const cancellationInFlight = useRef(false);
  const previewElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!plan) return;
    previewElement.current?.focus();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [plan]);
  const request = (command: string, args: JsonObject = {}) =>
    invoke<unknown>("storage_transition_request", { request: { command, ...args } });
  async function run(action: () => Promise<void>) {
    if (working.current || cancellationInFlight.current) return;
    working.current = true;
    cancellationRequested.current = false;
    setCancellation("idle");
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      const code =
        cause instanceof Error && /^native:[a-z0-9_]+$/.test(cause.message)
          ? ` (${cause.message.slice(7)})`
          : "";
      setError(
        t("応答を確認できませんでした。変更の再実行には新しいプレビューが必要です。") + code,
      );
      setInvalidPlan(true);
      setAccepted(false);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const verified = (value: unknown): JsonObject => {
    if (!object(value)) throw new Error("unverified_response");
    if (typeof value.error === "string")
      throw new Error(
        /^[a-z0-9_]+$/.test(value.error) ? `native:${value.error}` : "unverified_response",
      );
    return value;
  };
  async function requestCancellation() {
    if (!busy || cancellationRequested.current) return;
    cancellationRequested.current = true;
    cancellationInFlight.current = true;
    setCancellation("sending");
    try {
      // This out-of-band request must not queue behind run's in-flight operation.
      // Its acknowledgement says nothing about whether that operation committed.
      verified(await request("cancel"));
      setCancellation("requested");
    } catch {
      setCancellation("failed");
    } finally {
      cancellationInFlight.current = false;
    }
  }
  async function inspect() {
    const value = inspection(verified(await request("inspect")));
    if (!value) throw new Error("invalid_inspection");
    setData(value);
    setRootConfirmed(value.rootConfirmed === true);
    setPage(0);
    setSource(null);
  }
  function prepare(command: string, args: JsonObject = {}) {
    if (!session || !backupAccepted || unknownOperation || result?.status === "rolled_back") return;
    void run(async () => {
      setAccepted(false);
      setInvalidPlan(true);
      const next = readPlan(verified(await request(command, args)));
      const expected: Record<string, string[]> = {
        prepare_root: ["acknowledge_root"],
        prepare_document: [args.source_identity ? "copy_selected_legacy" : "confirm_empty"],
        prepare_preferences: ["restore_preferences"],
        prepare_rollback: ["rollback"],
      };
      if (!next || !expected[command]?.includes(String(next.preview.operation)))
        throw new Error("invalid_plan");
      setPlan(next);
      setNow(Date.now());
      setResult(null);
      setInvalidPlan(false);
    });
  }
  function committed(value: JsonObject, attempted: Plan, statusCheck = false) {
    const rollback = attempted.preview.operation === "rollback";
    if (
      value.status !== (rollback ? "rolled_back" : "committed") &&
      !(statusCheck && rollback && value.status === "committed")
    )
      return false;
    if (statusCheck) {
      if (typeof value.settingsMatchRoot !== "boolean") return false;
      if (value.operationId !== undefined && value.operationId !== attempted.planId) return false;
    } else if (
      value.operationId !== attempted.planId ||
      typeof value.settingsPublished !== "boolean" ||
      !count(value.schemaVersion)
    )
      return false;
    if (attempted.preview.operation === "acknowledge_root")
      setRootConfirmed(
        statusCheck ? value.settingsMatchRoot === true : value.settingsPublished === true,
      );
    if (rollback) setRootConfirmed(false);
    setUnknownOperation(null);
    setPlan(null);
    setAccepted(false);
    setResult(rollback ? { ...value, status: "rolled_back" } : value);
    return true;
  }
  function confirm() {
    if (!plan || !accepted || invalidPlan || Date.now() >= plan.expiresAt || unknownOperation)
      return;
    const attempted = plan;
    void run(async () => {
      // An ambiguous confirmation can never become a retry of the mutation.
      setUnknownOperation(attempted);
      setAccepted(false);
      setInvalidPlan(true);
      const raw = await request("confirm", {
        plan_id: attempted.planId,
        confirmation: attempted.confirmation,
      });
      if (
        object(raw) &&
        typeof raw.error === "string" &&
        raw.retryRequiresNewPreview === true &&
        raw.existingDataRetained === true
      ) {
        setUnknownOperation(null);
        verified(raw);
      }
      if (!committed(verified(raw), attempted)) throw new Error("unknown_outcome");
    });
  }
  const frozen =
    busy ||
    cancellation === "sending" ||
    unknownOperation !== null ||
    result?.status === "rolled_back";
  const expired = plan !== null && (invalidPlan || now >= plan.expiresAt);
  return (
    <main
      className="app-surface saved-data-settings"
      style={{ padding: 24, overflow: "auto", height: "100dvh", maxWidth: 960, margin: "0 auto" }}
    >
      <h1>{t("保存IDの確認ツール")}</h1>
      <p>{t("Mogledgeを終了した状態で使います。保存値は表示しません。HTML原本は変更しません。")}</p>
      <p>
        {t(
          "バックアップは確定済みの保存入力と端末設定が対象です。HTML・未保存の入力・実行状態・検索索引は含みません。",
        )}
      </p>
      {busy && <p role="status">{t("確認中")}</p>}
      {(busy || cancellation === "sending") && (
        <div className="saved-data-actions">
          {busy && (
            <button
              type="button"
              disabled={cancellation !== "idle"}
              onClick={() => void requestCancellation()}
            >
              {t("中止を要求")}
            </button>
          )}
          <p>
            {t(
              "中止要求だけでは、完了・未変更は確定しません。進行中の処理の応答を待ち、結果が不明なら照会してください。",
            )}
          </p>
          {cancellation === "requested" && (
            <p role="status">{t("中止要求を送りました。操作結果の確定応答を待っています。")}</p>
          )}
          {cancellation === "failed" && (
            <p role="alert">
              {t("中止要求の応答を確認できませんでした。進行中の操作結果はまだ不明です。")}
            </p>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {!session && (
        <fieldset disabled={busy || cancellation === "sending"} style={{ display: "grid", gap: 8 }}>
          <label>
            {t("対象フォルダー")}
            <input value={rootPath} onChange={(e) => setRootPath(e.target.value)} />
          </label>
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                const value = await invoke<unknown>("storage_transition_pick_directory", {
                  kind: "root",
                });
                if (value !== null && typeof value !== "string") throw new Error("invalid_picker");
                if (typeof value === "string") setRootPath(value);
              })
            }
          >
            {t("選択")} (root)
          </button>
          <label>
            {t("バックアップ親フォルダー")}
            <input value={backupParent} onChange={(e) => setBackupParent(e.target.value)} />
          </label>
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                const value = await invoke<unknown>("storage_transition_pick_directory", {
                  kind: "backup",
                });
                if (value !== null && typeof value !== "string") throw new Error("invalid_picker");
                if (typeof value === "string") setBackupParent(value);
              })
            }
          >
            {t("選択")} (backup)
          </button>
          <button
            type="button"
            disabled={!rootPath.trim() || !backupParent.trim()}
            onClick={() =>
              void run(async () => {
                verified(await request("open_session", { rootPath, backupParent }));
                setSession(true);
                await inspect();
              })
            }
          >
            {t("点検セッションを開く")}
          </button>
        </fieldset>
      )}
      {session && (
        <>
          <button type="button" disabled={frozen} onClick={() => void run(inspect)}>
            {t("点検し直す")}
          </button>
          <label className="saved-data-consent">
            <input
              type="checkbox"
              disabled={frozen}
              checked={backupAccepted}
              onChange={(e) => setBackupAccepted(e.target.checked)}
            />
            {t("バックアップ作成を伴うプレビューを準備することを確認しました")}
          </label>
          <button
            type="button"
            disabled={frozen || !backupAccepted}
            onClick={() => prepare("prepare_root")}
          >
            {t("フォルダー確認のプレビューを準備")}
          </button>
          {!rootConfirmed && <p>{t("文書の確認には、先にこのフォルダーの確認が必要です。")}</p>}
          {data && (
            <>
              <h2>{t("保存入力のメタデータ")}</h2>
              <dl className="saved-data-usage">
                <div>
                  <dt>rootIdentity</dt>
                  <dd>{data.rootIdentity}</dd>
                </div>
                <div>
                  <dt>schemaVersion</dt>
                  <dd>{data.schemaVersion}</dd>
                </div>
              </dl>
              <p>{t("パスは候補の手掛かりだけです。保存入力の所有者は未確認です。")}</p>
              <fieldset className="saved-data-list" disabled={frozen || !rootConfirmed}>
                <legend>{t("保存入力のメタデータ")}</legend>
                <label className="saved-data-consent">
                  <input
                    type="radio"
                    name="transition-source"
                    checked={source === ""}
                    onChange={() => setSource("")}
                  />
                  {t("新規の空データとして確認する")}
                </label>
                {data.entries.slice(page * 25, (page + 1) * 25).map((entry) => (
                  <div className="saved-data-row" key={entry.documentIdentity}>
                    <label>
                      <input
                        type="radio"
                        name="transition-source"
                        checked={source === entry.documentIdentity}
                        onChange={() => setSource(entry.documentIdentity)}
                      />
                      {entry.relativePathHint || entry.documentIdentity}
                    </label>
                    <p>
                      {entry.documentIdentity} / {entry.rootIdentity}
                    </p>
                    <p>
                      revision: {entry.revision} / bytes: {entry.bytes}
                    </p>
                  </div>
                ))}
              </fieldset>
              <div className="saved-data-actions">
                <button
                  type="button"
                  disabled={frozen || page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  {t("前のページ")}
                </button>
                <span>
                  {page + 1} / {Math.max(1, Math.ceil(data.entries.length / 25))}
                </span>
                <button
                  type="button"
                  disabled={frozen || (page + 1) * 25 >= data.entries.length}
                  onClick={() => setPage(page + 1)}
                >
                  {t("次のページ")}
                </button>
              </div>
            </>
          )}
          <fieldset disabled={frozen || !rootConfirmed} style={{ display: "grid", gap: 8 }}>
            <label>
              {t("対象HTMLの相対パス")}
              <input value={relativePath} onChange={(e) => setRelativePath(e.target.value)} />
            </label>
            <button
              type="button"
              disabled={!backupAccepted || source === null || !relativePath.trim()}
              onClick={() =>
                prepare("prepare_document", {
                  relative_path: relativePath,
                  ...(source ? { source_identity: source } : {}),
                })
              }
            >
              {t("文書確認のプレビューを準備")}
            </button>
          </fieldset>
          <fieldset disabled={frozen || !rootConfirmed} style={{ display: "grid", gap: 8 }}>
            <label>
              {t("設定移行元のフォルダーID")}
              <input value={sourceRoot} onChange={(e) => setSourceRoot(e.target.value)} />
            </label>
            <button
              type="button"
              disabled={!backupAccepted || !sourceRoot.trim()}
              onClick={() => prepare("prepare_preferences", { source_root_identity: sourceRoot })}
            >
              {t("設定移行のプレビューを準備")}
            </button>
          </fieldset>
          <fieldset disabled={frozen} style={{ display: "grid", gap: 8 }}>
            <label>
              {t("ロールバック用バックアップ名")}
              <input
                value={rollbackDirectory}
                onChange={(e) => setRollbackDirectory(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={!backupAccepted || !rollbackDirectory.trim()}
              onClick={() => prepare("prepare_rollback", { backup_directory: rollbackDirectory })}
            >
              {t("ロールバックのプレビューを準備")}
            </button>
          </fieldset>
        </>
      )}
      {plan && (
        <div
          className="saved-data-preview"
          ref={previewElement}
          tabIndex={-1}
          aria-label={t("操作プレビュー")}
        >
          <h2>{t("操作プレビュー")}</h2>
          {plan.preview.operation === "acknowledge_root" && (
            <p>{t("旧版はこの保存形式を開けなくなります。旧設定は保持します。")}</p>
          )}
          {plan.preview.operation === "rollback" && (
            <p>
              {t(
                "現在の保存形式をバックアップで置き換えます。現在のデータも別のバックアップに保持します。",
              )}
            </p>
          )}
          <dl className="saved-data-usage">
            {previewFields
              .filter((key) => ["string", "number", "boolean"].includes(typeof plan.preview[key]))
              .map((key) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(plan.preview[key])}</dd>
                </div>
              ))}
            <div>
              <dt>backupDirectory</dt>
              <dd>{plan.backupDirectory}</dd>
            </div>
            <div>
              <dt>backupManifestHash</dt>
              <dd>{plan.backupManifestHash}</dd>
            </div>
            <div>
              <dt>backupScope</dt>
              <dd>{plan.backupScope}</dd>
            </div>
            <div>
              <dt>expiresInMs</dt>
              <dd>{Math.max(0, plan.expiresAt - now)}</dd>
            </div>
          </dl>
          {Array.isArray(plan.preview.files) &&
            plan.preview.files.map(
              (file: unknown, index) =>
                object(file) &&
                typeof file.relativePath === "string" &&
                typeof file.sha256 === "string" &&
                count(file.bytes) && (
                  <p key={index}>
                    {file.relativePath} / SHA-256: {file.sha256} / bytes: {file.bytes}
                  </p>
                ),
            )}
          <p>{t("パスは候補の手掛かりだけです。保存入力の所有者は未確認です。")}</p>
          {expired && (
            <p role="status">{t("期限切れまたは無効です。新しいプレビューを準備してください。")}</p>
          )}
          <label className="saved-data-consent">
            <input
              type="checkbox"
              disabled={frozen || expired}
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            {t(
              plan.preview.operation === "restore_preferences"
                ? "対象・所有者・旧版の拒否・バックアップ範囲と期限を確認しました。既存の移行先を上書きせず、未確認の文書・フォルダー参照は旧参照のまま保持します"
                : plan.preview.operation === "rollback"
                  ? "対象・所有者・旧版の拒否・バックアップ範囲と期限を確認しました。移行後の設定コピーは非アクティブのまま保持し、元の設定が変更されている場合はロールバックしません"
                  : "対象・所有者・旧版の拒否・バックアップ範囲と期限を確認しました",
            )}
          </label>
          <div className="saved-data-actions">
            <button type="button" disabled={frozen || expired || !accepted} onClick={confirm}>
              {t("確認した操作を実行")}
            </button>
            <button
              type="button"
              disabled={frozen}
              onClick={() =>
                void run(async () => {
                  verified(await request("cancel"));
                  setPlan(null);
                  setAccepted(false);
                })
              }
            >
              {t("プレビューを取り消す")}
            </button>
          </div>
        </div>
      )}
      {unknownOperation && (
        <div role="alert">
          <p>{t("操作結果が不明です。再実行せず、結果を照会してください。")}</p>
          <p>{unknownOperation.planId}</p>
          <button
            type="button"
            disabled={busy || cancellation === "sending"}
            onClick={() =>
              void run(async () => {
                const value = verified(
                  await request("operation_status", { operation_id: unknownOperation.planId }),
                );
                if (!committed(value, unknownOperation, true)) throw new Error("unknown_outcome");
              })
            }
          >
            {t("操作結果を照会")}
          </button>
        </div>
      )}
      {result && (
        <div role="status">
          <p>
            {t(
              result.status === "rolled_back"
                ? "ロールバックが完了しました。ツールを終了して再起動してください。"
                : "確認した操作が完了しました",
            )}
          </p>
          <p>{t("設定の公開状態も確認してください。")}</p>
          {["settingsPublished", "settingsMatchRoot"].map(
            (key) =>
              typeof result[key] === "boolean" && (
                <p key={key}>
                  {key}: {String(result[key])}
                </p>
              ),
          )}
        </div>
      )}
      <button
        type="button"
        disabled={busy || cancellation === "sending"}
        onClick={() =>
          void run(async () => {
            verified(await request("quit"));
          })
        }
      >
        {t("ツールを終了")}
      </button>
    </main>
  );
}

export default StorageTransition;
