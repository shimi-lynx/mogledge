import { setLanguage, useLanguagePreference, useT } from "../lib/i18n";
import "./language-picker.css";

export function LanguagePicker({ variant = "icon" }: { variant?: "icon" | "settings" }) {
  const { language, persistenceFailed } = useLanguagePreference();
  const t = useT();
  const label = t("表示言語を選択");
  const warning = t("言語設定を保存できません。今回の起動中は選択した言語を使います。");
  return (
    <span
      className={
        variant === "settings" ? "language-picker language-picker--settings" : "language-picker"
      }
      data-save-failed={persistenceFailed || undefined}
    >
      {variant === "icon" && (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="7" />
          <ellipse cx="10" cy="10" rx="3" ry="7" />
          <path d="M3 10h14M4.5 6.5h11M4.5 13.5h11" />
        </svg>
      )}
      <select
        aria-label={label}
        title={persistenceFailed ? label + ": " + warning : label}
        aria-describedby={persistenceFailed ? "language-preference-warning" : undefined}
        value={language}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "ja" || value === "en") setLanguage(value);
        }}
      >
        <option value="ja">日本語</option>
        <option value="en">English</option>
      </select>
      {persistenceFailed && (
        <span id="language-preference-warning" className="language-picker-warning" role="status">
          {warning}
        </span>
      )}
    </span>
  );
}
