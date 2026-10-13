import { useLanguage, useT } from "../lib/i18n";
import "./app-help.css";

export default function AppHelp({ documentOrigin }: { documentOrigin?: string }) {
  const language = useLanguage();
  const t = useT();
  // Native permits only fixed built-in URLs; about:srcdoc is outside that boundary.
  if (!documentOrigin)
    return (
      <div className="document-empty" role="status">
        {t("ヘルプを読み込み中")}
      </div>
    );
  return (
    <iframe
      className="app-help-frame"
      src={`${documentOrigin}/__app/help/${language}.html`}
      sandbox=""
      referrerPolicy="no-referrer"
      title={t("機能と使い方")}
    />
  );
}
