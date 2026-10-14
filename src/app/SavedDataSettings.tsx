import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLanguage, useT } from "../lib/i18n";
import { formatBytes } from "../lib/byteUnits";
import {
  ManagementSession,
  managementError,
  managementMessages,
  type ManagementContext,
  type RecoveryEntry,
  type SavedEntry,
} from "../lib/stateManagement";
import "./saved-data-settings.css";
import { StorageLimitsSession } from "../lib/storageLimits";
import { SavedDataLimits } from "./SavedDataLimits";

export function SavedDataSettings({
  context,
  session,
  limitsSession,
}: {
  context: ManagementContext;
  session: ManagementSession;
  limitsSession?: StorageLimitsSession;
}) {
  const t = useT();
  const language = useLanguage();
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [localLimitsSession] = useState(() => new StorageLimitsSession());
  const [accepted, setAccepted] = useState(false);
  const [unknownAccepted, setUnknownAccepted] = useState(false);
  const [query, setQuery] = useState("");
  const preview = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (view.plan) preview.current?.focus();
  }, [view.plan?.planId, view.phase]);
  useEffect(() => {
    session.bind(context);
    const current = session.getSnapshot();
    if (!current.page && !current.plan && !current.busy) void session.load();
  }, [session, context.workspaceId, context.viewId]);
  useEffect(() => {
    setAccepted(false);
    setUnknownAccepted(false);
  }, [view.plan?.planId]);
  useEffect(() => setQuery(view.query), [view.query, context.workspaceId, context.viewId]);
  const amount = (value: number | null | undefined) =>
    value === null || value === undefined ? t("不明") : value.toLocaleString(language);
  const bytes = (value: number | null | undefined) =>
    value === null || value === undefined ? t("不明") : formatBytes(value, language);
  const diagnostic = (code: string) => t(managementMessages[managementError(code)]);
  const usage = view.page?.usage;
  const plan = view.plan;
  const frozen = view.busy || !!plan;
  const entries = view.page?.entries ?? [];
  const selected = entries.find(
    (entry) =>
      ("recoveryId" in entry ? entry.recoveryId : entry.documentIdentity) === view.selected,
  );
  const holdReason = (entry: SavedEntry | RecoveryEntry) =>
    "status" in entry && entry.status === "restored"
      ? t("復元済みの回復コピーを保持しています")
      : entry.holdReason
        ? diagnostic(entry.holdReason)
        : "sourceAvailability" in entry
          ? diagnostic(entry.sourceAvailability)
          : entry.status === "restored"
            ? t("復元済みの回復コピーを保持しています")
            : t("復元可能な隔離");
  const operationName = (operation: string) =>
    t(
      operation === "upgrade"
        ? "回復可能な形式を準備"
        : operation === "quarantine"
          ? "選択した保存済み入力を削除（復旧可能）"
          : "隔離した保存済み入力を復元",
    );
  return (
    <div className="saved-data-settings">
      <h2>{t("保存データ")}</h2>
      <SavedDataLimits context={context} session={limitsSession ?? localLimitsSession} />
      <p>
        {t(
          "HTML原本は変更しません。対象は確定済みの保存入力です。未保存の入力やCanvas・JavaScriptの実行状態は含みません。",
        )}
      </p>
      <p>
        {t(
          "一覧を開いただけでは整理しません。原本不明・一時offline・未使用期間だけを理由に整理しません。",
        )}
      </p>
      {view.busy && (
        <p role="status">
          {t(view.phase === "processing" ? "確認した操作を処理中" : "保存データを確認中")}
        </p>
      )}
      {view.error && <p role="alert">{diagnostic(view.error)}</p>}
      {usage && (
        <dl className="saved-data-usage" aria-label={t("保存データの使用量")}>
          <div>
            <dt>{t("保存入力の論理容量")}</dt>
            <dd>
              {bytes(usage.logicalBytes)} / {amount(usage.records)} {t("件")}
            </dd>
          </div>
          <div>
            <dt>{t("回復領域の論理容量")}</dt>
            <dd>
              {bytes(usage.recoveryLogicalBytes)} / {amount(usage.recoveryRecords)} {t("件")}
            </dd>
          </div>
          <div>
            <dt>{t("DBのディスク容量")}</dt>
            <dd>{bytes(usage.databaseBytes)}</dd>
          </div>
          <div>
            <dt>{t("journalのディスク容量")}</dt>
            <dd>{bytes(usage.journalBytes)}</dd>
          </div>
          <div>
            <dt>{t("回復領域だけのディスク容量")}</dt>
            <dd>{t("不明（同じDB内で共有）")}</dd>
          </div>
          <div>
            <dt>{t("DB内の空きページ")}</dt>
            <dd>{bytes(usage.freeDatabasePageBytes)}</dd>
          </div>
        </dl>
      )}
      <p>
        {t(
          "論理quotaとdisk使用量は別です。隔離してもDBのdisk容量は減りません。回復コピーも容量を使い、独立backupや暗号化ではありません。",
        )}
      </p>
      {!plan && (
        <>
          <div className="saved-data-actions">
            <button
              type="button"
              disabled={frozen}
              aria-pressed={view.kind === "active"}
              onClick={() => void session.load("active")}
            >
              {t("保存入力一覧")}
            </button>
            <button
              type="button"
              disabled={frozen}
              aria-pressed={view.kind === "recovery"}
              onClick={() => void session.load("recovery")}
            >
              {t("隔離と回復の一覧")}
            </button>
            <button type="button" disabled={frozen} onClick={() => void session.load()}>
              {t("点検し直す")}
            </button>
          </div>
          {view.kind === "active" && (
            <form
              className="saved-data-search"
              onSubmit={(event) => {
                event.preventDefault();
                void session.load("active", 0, query.trim());
              }}
            >
              <label>
                {t("HTMLのファイル名・相対パスを検索")}
                <input
                  type="search"
                  value={query}
                  disabled={frozen}
                  maxLength={1024}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <button type="submit" disabled={frozen}>
                {t("全件から検索")}
              </button>
              <button
                type="button"
                disabled={frozen || (!query && !view.query)}
                onClick={() => {
                  setQuery("");
                  void session.load("active", 0, "");
                }}
              >
                {t("検索を解除")}
              </button>
            </form>
          )}
          {view.page && (
            <>
              <fieldset className="saved-data-list" disabled={view.busy}>
                <legend>
                  {t(
                    view.kind === "active"
                      ? "削除する保存入力を選択（複数可）"
                      : "復元する回復コピーを一つ選択",
                  )}
                </legend>
                {entries.length === 0 && <p>{t("この一覧に保存入力はありません")}</p>}
                {entries.map((entry) => {
                  const recovery = "recoveryId" in entry;
                  const id = recovery ? entry.recoveryId : entry.documentIdentity;
                  const enabled = recovery ? entry.restorable : entry.eligible;
                  return (
                    <div className="saved-data-row" key={id}>
                      <label>
                        <input
                          type={recovery ? "radio" : "checkbox"}
                          name="saved-data-selection"
                          checked={recovery ? view.selected === id : view.selectedIds.includes(id)}
                          disabled={!enabled || view.busy}
                          onChange={() => (recovery ? session.select(id) : session.toggle(id))}
                        />
                        <span className="saved-data-path">
                          <strong>
                            {entry.relativePath?.split(/[\\/]/).at(-1) ?? t("原本の場所は未確認")}
                          </strong>
                          {entry.relativePath && <small>{entry.relativePath}</small>}
                        </span>
                      </label>
                      <p>
                        {bytes(entry.logicalBytes)} ·{" "}
                        {t("保存revision {revision}", {
                          revision: recovery ? entry.sourceRevision : entry.revision,
                        })}
                      </p>
                      <p>{t("最終利用: 不明（未収集）")}</p>
                      <p>{holdReason(entry)}</p>
                      {recovery && entry.restoredRevision !== null && (
                        <p>
                          {t("復元後revision {revision}", { revision: entry.restoredRevision })}
                        </p>
                      )}
                      <small>
                        {t("識別情報 {identity}", {
                          identity: entry.documentIdentity.slice(0, 12),
                        })}
                      </small>
                    </div>
                  );
                })}
              </fieldset>
              <div className="saved-data-actions" aria-label={t("一覧のページ")}>
                <button
                  type="button"
                  disabled={frozen || view.page.offset === 0}
                  onClick={() => void session.load(view.kind, Math.max(0, view.page!.offset - 20))}
                >
                  {t("前の20件")}
                </button>
                <span>{t("{offset}件目から最大20件", { offset: view.page.offset + 1 })}</span>
                <button
                  type="button"
                  disabled={frozen || !view.page.hasMore}
                  onClick={() => void session.load(view.kind, view.page!.offset + 20)}
                >
                  {t("次の20件")}
                </button>
              </div>
              {view.page.databaseSchemaVersion === 1 ? (
                <button
                  type="button"
                  disabled={frozen}
                  onClick={() => void session.prepare("upgrade")}
                >
                  {t("回復可能な形式への変更を確認")}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={frozen || !selected}
                  onClick={() =>
                    void session.prepare(view.kind === "active" ? "quarantine" : "restore")
                  }
                >
                  {view.kind === "active"
                    ? t("選択した{count}件の削除を確認", { count: view.selectedIds.length })
                    : t("選択した対象の影響を確認")}
                </button>
              )}
            </>
          )}
        </>
      )}
      {plan && (
        <div
          ref={preview}
          tabIndex={-1}
          className="saved-data-preview"
          aria-label={t("選択した操作の確認")}
        >
          <h3>{operationName(plan.operation)}</h3>
          {plan.operation === "quarantine" && (
            <p>{t("選択したHTML: {count}件", { count: plan.documentCount ?? 1 })}</p>
          )}
          {plan.entries && plan.entries.length > 1 && (
            <ul>
              {plan.entries.map((entry) => (
                <li className="saved-data-path" key={entry.documentIdentity}>
                  {entry.relativePath ?? t("原本の場所は未確認")}
                </li>
              ))}
            </ul>
          )}
          {plan.relativePath !== null && <p className="saved-data-path">{plan.relativePath}</p>}
          {plan.operation === "upgrade" ? (
            <p>
              {t(
                "回復用schema v2へ変更します。保存入力は変更しませんが、v2非対応の旧版は起動できません。アプリ全体のbackupと復帰方法を先に確認してください。",
              )}
            </p>
          ) : (
            <p>
              {t("対象の確定済み入力: {count} appId、{size}", {
                count: amount(plan.appCount),
                size: bytes(plan.logicalBytes),
              })}
            </p>
          )}
          {plan.operation === "quarantine" && (
            <p>
              {t(
                "選択したHTMLの保存入力を削除し、回復コピーを残します。HTMLファイル本体は変更しません。古い画面からの保存読込・再保存は停止されます。復旧するまで入力は戻りません。",
              )}
            </p>
          )}
          {plan.operation === "restore" && (
            <p>
              {t(
                "同じ物理root・原本識別情報へ保存入力を復元します。復元先に値があれば上書きしません。回復コピーは復元後も保持します。",
              )}
            </p>
          )}
          <p>
            {t(
              "永久削除は行いません。独立backupが必要なら、この操作の前に別の安全な場所へ保全してください。個別の入力は既存の書き出し機能を利用できます。",
            )}
          </p>
          <p>
            {t(
              "表示中・非表示・外部ブラウザー・進行中open/saveの対象は保留します。原本や保存値が変わると確認は失効し、5分以内でも再選択が必要です。",
            )}
          </p>
          {!session.isCurrentPlan() && (
            <p role="alert">
              {t("ルートまたは表示世代が変わったため、この確認では実行できません")}
            </p>
          )}
          {plan.blockedReason && <p role="alert">{diagnostic(plan.blockedReason)}</p>}
          {view.phase === "preview" && (
            <>
              <label className="saved-data-consent">
                <input
                  type="checkbox"
                  checked={accepted}
                  disabled={view.busy}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                {t("対象・保存入力への影響・復元条件とbackupを確認しました")}
              </label>
              <div className="saved-data-actions">
                <button
                  type="button"
                  disabled={view.busy || !accepted || !plan.canConfirm || !session.isCurrentPlan()}
                  onClick={() => void session.confirm()}
                >
                  {t("確認した内容で実行")}
                </button>
                <button type="button" disabled={view.busy} onClick={() => void session.cancel()}>
                  {t("この確認を取り消す")}
                </button>
              </div>
            </>
          )}
          {view.phase === "unknown" && (
            <>
              <p role="status">
                {t("結果は不明です。自動再実行しません。取消要求だけでは未実行を保証しません。")}
              </p>
              <div className="saved-data-actions">
                <button type="button" disabled={view.busy} onClick={() => void session.verify()}>
                  {t("処理結果を照会")}
                </button>
                <button type="button" disabled={view.busy} onClick={() => void session.cancel()}>
                  {t("取消を要求")}
                </button>
              </div>
              <label className="saved-data-consent">
                <input
                  type="checkbox"
                  checked={unknownAccepted}
                  disabled={view.busy}
                  onChange={(event) => setUnknownAccepted(event.target.checked)}
                />
                {t("結果不明のまま戻ります。新しい点検は過去の操作結果の証明ではありません")}
              </label>
              <button
                type="button"
                disabled={view.busy || !unknownAccepted}
                onClick={() => session.finish(true)}
              >
                {t("結果不明のまま一覧へ戻る")}
              </button>
            </>
          )}
          {["completed", "cancelled", "failed"].includes(view.phase) && (
            <>
              <p role="status">
                {t(
                  view.phase === "completed"
                    ? "確認した操作は完了しました"
                    : view.phase === "cancelled"
                      ? "操作の取消を確認しました"
                      : "操作の失敗を確認しました",
                )}
              </p>
              <button type="button" disabled={view.busy} onClick={() => session.finish()}>
                {t("一覧へ戻る")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
