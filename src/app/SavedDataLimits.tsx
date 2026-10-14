import { useLayoutEffect, useSyncExternalStore } from "react";
import { useLanguage, useT } from "../lib/i18n";
import { byteUnits, formatBytes, type ByteUnit } from "../lib/byteUnits";
import {
  limitsDiagnostic,
  MIB,
  parseLimits,
  StorageLimitsSession,
  type LimitsContext,
} from "../lib/storageLimits";
import "./saved-data-limits.css";

export function SavedDataLimits({
  context,
  session,
}: {
  context: LimitsContext;
  session: StorageLimitsSession;
}) {
  const t = useT(),
    language = useLanguage();
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useLayoutEffect(() => {
    session.bind(context);
    const current = session.getSnapshot();
    if (!current.snapshot && !current.busy && !current.uncertain && !current.error)
      void session.load();
  }, [session, context.viewId, context.workspaceId]);
  const current = session.matches(context);
  const snapshot = current ? view.snapshot : null;
  const bytes = (value: number | null) =>
    value === null ? t("不明") : formatBytes(value, language);
  const locked = view.busy || view.uncertain || !current;
  const compatibility = snapshot?.requiresCompatibilityAcknowledgement && session.changed();
  const values = view.editing
    ? parseLimits(view.document, view.total, view.documentUnit, view.totalUnit)
    : snapshot;
  const largerThanDefaults = values && (values.documentMiB > 5 || values.totalMiB > 512);
  const exceedsTechnicalCapacity =
    values &&
    snapshot &&
    (values.documentMiB * MIB > snapshot.capabilities.maximumDocumentBytes ||
      values.totalMiB * MIB > snapshot.capabilities.maximumDatabaseBytes);
  return (
    <div className="saved-data-limits" role="group" aria-labelledby="saved-data-limits-heading">
      <h3 id="saved-data-limits-heading">{t("保存入力の容量上限")}</h3>
      <p>
        {t(
          "同じ保存先profileの全ルートに適用します。既定値は文書5.24288 MB・全体536.870912 MBです。",
        )}
      </p>
      {snapshot && (
        <dl className="saved-data-usage">
          <div>
            <dt>{t(view.uncertain ? "最後に確認した上限" : "現在の上限")}</dt>
            <dd>
              {t("文書{document}・全体{total}", {
                document: bytes(snapshot.documentMiB * MIB),
                total: bytes(snapshot.totalMiB * MIB),
              })}
            </dd>
          </div>
          <div>
            <dt>{t("全ルートの保存入力")}</dt>
            <dd>{bytes(snapshot.usageBytes)}</dd>
          </div>
          <div>
            <dt>{t("保存文書の最大容量")}</dt>
            <dd>{bytes(snapshot.largestDocumentBytes)}</dd>
          </div>
          <div>
            <dt>{t("回復コピーの合計")}</dt>
            <dd>{bytes(snapshot.recoveryBytes)}</dd>
          </div>
          <div>
            <dt>{t("回復コピーの最大容量")}</dt>
            <dd>{bytes(snapshot.largestRecoveryDocumentBytes)}</dd>
          </div>
          <div>
            <dt>{t("文書保存の技術上限")}</dt>
            <dd>{bytes(snapshot.capabilities.maximumDocumentBytes)}</dd>
          </div>
          <div>
            <dt>{t("保存通信の技術上限")}</dt>
            <dd>{bytes(snapshot.capabilities.maximumRequestBytes)}</dd>
          </div>
          <div>
            <dt>{t("DBの技術上限")}</dt>
            <dd>{bytes(snapshot.capabilities.maximumDatabaseBytes)}</dd>
          </div>
          <div>
            <dt>{t("回復コピーの別枠容量")}</dt>
            <dd>{bytes(snapshot.capabilities.recoveryBudgetBytes)}</dd>
          </div>
        </dl>
      )}
      <p>
        {t(
          "1 KB = 1,000 B、1 MB = 1,000 KB、1 GB = 1,000 MBです。小数を使えますが、1 B未満の端数は指定できません。最小値は1.048576 MBで、全体は文書以上です。",
        )}
      </p>
      <p>
        {t(
          "全体上限は保存入力のJSONに適用します。回復コピーは別枠536.870912 MBで、DB・journal・backupのdisk容量とは異なります。HTML原本・media・生成ファイルの書き出し上限も別です。",
        )}
      </p>
      <p>{t("古いHTMLの保存処理は更新が必要な場合があります")}</p>
      <p>
        {t(
          "技術上限は設定値とは別です。文書の付随情報やDBの管理領域、空きdiskにも制約があり、設定値まで保存できる保証はありません。",
        )}
      </p>
      {largerThanDefaults && (
        <p>
          {t(
            "大きい上限ではメモリ・処理時間・空きdiskが多く必要になる場合があります。容量の確保や動作を保証するものではありません。",
          )}
        </p>
      )}
      {exceedsTechnicalCapacity && (
        <p>
          {t(
            "設定値が文書またはDBの技術上限を超えています。設定は適用できますが、実際の保存には技術上限が適用されます。",
          )}
        </p>
      )}
      {view.busy && (
        <p role="status">{t(view.editing ? "保存上限の応答を待っています" : "保存上限を確認中")}</p>
      )}
      {current && view.error && <p role="alert">{t(limitsDiagnostic(view.error))}</p>}
      {view.uncertain && (
        <p role="status">
          {t("保存上限の変更結果は不明です。自動再保存せず、適用値を確認してください。")}
        </p>
      )}
      {view.notice && current && (
        <p role="status">
          {t(
            view.notice === "applied"
              ? "保存上限を適用しました。次の保存から有効です。"
              : "現在の適用値を確認しました。過去の変更要求の成功を証明するものではありません。",
          )}
        </p>
      )}
      {!view.editing ? (
        <div className="saved-data-actions">
          <button type="button" disabled={locked || !snapshot} onClick={() => session.edit()}>
            {t("保存上限を編集")}
          </button>
          <button
            type="button"
            disabled={view.busy || !context.viewId}
            onClick={() => void session.load()}
          >
            {t("適用値を確認")}
          </button>
        </div>
      ) : (
        <>
          <fieldset disabled={locked} className="saved-data-limits-fields">
            <legend>{t("変更する保存上限")}</legend>
            {(["document", "total"] as const).map((field) => (
              <div className="saved-data-limit-row" key={field}>
                <label>
                  {t(field === "document" ? "文書上限" : "全体上限")}
                  <input
                    type="text"
                    inputMode="decimal"
                    maxLength={32}
                    value={view[field]}
                    onChange={(event) => session.change(field, event.target.value)}
                  />
                </label>
                <label>
                  {t(field === "document" ? "文書上限の単位" : "全体上限の単位")}
                  <select
                    value={view[field === "document" ? "documentUnit" : "totalUnit"]}
                    onChange={(event) => session.changeUnit(field, event.target.value as ByteUnit)}
                  >
                    {byteUnits.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </fieldset>
          {!parseLimits(view.document, view.total, view.documentUnit, view.totalUnit) && (
            <p role="alert">{t(limitsDiagnostic("limits_invalid"))}</p>
          )}
          {session.belowUsage() && <p role="alert">{t(limitsDiagnostic("limits_below_usage"))}</p>}
          {compatibility && (
            <label className="saved-data-consent">
              <input
                type="checkbox"
                checked={view.accepted}
                disabled={locked}
                onChange={(event) => session.accept(event.target.checked)}
              />
              {t(
                "保存形式の更新後は旧版アプリが起動できない場合があります。互換性と停止中profileのbackupを確認しました",
              )}
            </label>
          )}
          <div className="saved-data-actions">
            <button type="button" disabled={locked} onClick={() => session.defaults()}>
              {t("既定値を入力")}
            </button>
            <button type="button" disabled={locked} onClick={() => session.cancel()}>
              {t("上限の編集を取り消す")}
            </button>
            <button
              type="button"
              disabled={!current || !session.canApply()}
              onClick={() => void session.apply()}
            >
              {t("保存上限を適用")}
            </button>
            <button
              type="button"
              disabled={view.busy || !context.viewId}
              onClick={() => void session.load(true)}
            >
              {t("適用値を確認")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
