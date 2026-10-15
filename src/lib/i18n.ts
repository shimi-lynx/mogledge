import { artifactExportMessages } from "./i18n/artifactExport";
import { appUpdaterMessages } from "./i18n/appUpdater";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { commonMessages } from "./i18n/common";
import { managedFolderMessages } from "./i18n/managedFolders";
import { errorMessages } from "./i18n/errors";
import { aiMessages } from "./i18n/ai";
import { searchMessages } from "./i18n/search";
import { transferMessages } from "./i18n/stateTransfer";
import { shellMessages } from "./i18n/shell";
import { treeMessages } from "./i18n/tree";
import { viewerMessages } from "./i18n/viewer";
import { workspaceMessages } from "./i18n/workspace";
import { nativeMessages } from "./i18n/native";
import { nativePlatformMessages } from "./i18n/nativePlatform";
import { residentMessages } from "./i18n/resident";
import { stateManagementMessages } from "./i18n/stateManagement";
import { storageLimitsMessages } from "./i18n/storageLimits";

export type Language = "ja" | "en";
// Preserve the existing key so the app rename keeps each user's language choice.
export const LANGUAGE_STORAGE_KEY = "my-knowledge.ui-language";

export const messages: Readonly<Record<string, string>> = {
  ...commonMessages,
  ...managedFolderMessages,
  ...appUpdaterMessages,
  ...artifactExportMessages,
  ...errorMessages,
  ...aiMessages,
  ...searchMessages,
  ...transferMessages,
  ...shellMessages,
  ...treeMessages,
  ...viewerMessages,
  ...workspaceMessages,
  ...nativeMessages,
  ...nativePlatformMessages,
  ...residentMessages,
  ...stateManagementMessages,
  ...storageLimitsMessages,
};
type TextParameters = Readonly<Record<string, string | number>>;
type LanguagePreference = Readonly<{ language: Language; persistenceFailed: boolean }>;

export function isLanguage(value: unknown): value is Language {
  return value === "ja" || value === "en";
}

export function readStoredLanguage(storage?: Pick<Storage, "getItem">): Language {
  try {
    const value = (storage ?? window.localStorage).getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(value) ? value : "en";
  } catch {
    return "en";
  }
}

let preference: LanguagePreference = {
  language: readStoredLanguage(),
  persistenceFailed: false,
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => preference;
const serverSnapshot: LanguagePreference = { language: "en", persistenceFailed: false };

export function getLanguage(): Language {
  return preference.language;
}

export function setLanguage(language: Language): boolean {
  if (!isLanguage(language)) return false;
  let persistenceFailed = false;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    persistenceFailed = true;
  }
  if (typeof document !== "undefined") document.documentElement.lang = language;
  if (preference.language !== language || preference.persistenceFailed !== persistenceFailed) {
    preference = { language, persistenceFailed };
    listeners.forEach((listener) => listener());
  }
  return !persistenceFailed;
}

export function useLanguagePreference(): LanguagePreference {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
  useEffect(() => {
    document.documentElement.lang = snapshot.language;
  }, [snapshot.language]);
  return snapshot;
}

export function useLanguage(): Language {
  return useLanguagePreference().language;
}

export function translate(
  message: string,
  language: Language,
  parameters: TextParameters = {},
): string {
  const template =
    language === "en" && Object.hasOwn(messages, message) ? messages[message] : message;
  // A replacement callback preserves literal $, braces, names and paths.
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (placeholder, name: string) =>
    Object.hasOwn(parameters, name) ? String(parameters[name]) : placeholder,
  );
}

export function useT() {
  const language = useLanguage();
  return useCallback(
    (message: string, parameters?: TextParameters) => translate(message, language, parameters),
    [language],
  );
}

// Only app-owned diagnostics pass this boundary. Known messages and contextual
// prefixes are translated; an unknown native/OS cause remains visible verbatim.
export function translateUiMessage(message: string, language: Language = getLanguage()): string {
  if (language === "ja" || !message) return message;
  if (Object.hasOwn(messages, message)) return messages[message];
  const destinationDraftLimit = message.match(
    /^この連携先の下書き本文は([0-9,]+)文字以内です。短くするか本文をコピーしてください$/u,
  );
  if (destinationDraftLimit) {
    return translate(
      "この連携先の下書き本文は{limit}文字以内です。短くするか本文をコピーしてください",
      language,
      { limit: destinationDraftLimit[1] },
    );
  }
  const draftLimit = message.match(
    /^この連携先の下書きはパス込みで([0-9,]+)文字以内です。短くするか本文をコピーしてください$/u,
  );
  if (draftLimit) {
    return translate(
      "この連携先の下書きはパス込みで{limit}文字以内です。短くするか本文をコピーしてください",
      language,
      { limit: draftLimit[1] },
    );
  }
  const mutationWarning = message.match(
    /^(名前変更|移動)は完了しましたが、([\s\S]+)。保存済み順序で再走査しました$/u,
  );
  if (mutationWarning) {
    return translate(
      "{operation}は完了しましたが、{error}。保存済み順序で再走査しました",
      language,
      {
        operation: translate(mutationWarning[1], language),
        error: translateUiMessage(mutationWarning[2], language),
      },
    );
  }
  const reorderWarning = message.match(/^([\s\S]+)。並べ替えを適用せず再走査しました$/u);
  if (reorderWarning) {
    return translate("{error}。並べ替えを適用せず再走査しました", language, {
      error: translateUiMessage(reorderWarning[1], language),
    });
  }
  const afterOperationWarning = message.match(/^操作後の([\s\S]+)。再走査してください$/u);
  if (afterOperationWarning) {
    return translate("操作後の{error}。再走査してください", language, {
      error: translateUiMessage(afterOperationWarning[1], language),
    });
  }
  // These two formats are produced by StateTransfer. Parse only their exact
  // framing; diagnostic codes remain parameters and never become UI state.
  const failure = message.match(
    /^処理失敗: ([\s\S]*?)。grant失効: (あり（自動復活しません。必要なタブを明示再読み込み）|なし)。backup公開: (あり|なし)。export公開: (あり|なし)。$/u,
  );
  if (failure) {
    return translate(
      "処理失敗: {code}。grant失効: {revoked}。backup公開: {backup}。export公開: {exported}。",
      language,
      {
        code: translateUiMessage(failure[1], language),
        revoked: translate(failure[2], language),
        backup: translate(failure[3], language),
        exported: translate(failure[4], language),
      },
    );
  }
  const status = message.match(
    /^処理状態: ([\s\S]*?)。取消要求や期限切れだけでは実行結果を断定できません。必要なら再照会してください。$/u,
  );
  if (status) {
    return translate(
      "処理状態: {status}。取消要求や期限切れだけでは実行結果を断定できません。必要なら再照会してください。",
      language,
      { status: translate(status[1], language) },
    );
  }
  for (const delimiter of [": ", ":", "\n"]) {
    const split = message.indexOf(delimiter);
    if (split < 0) continue;
    const prefix = message.slice(0, split);
    if (Object.hasOwn(messages, prefix)) {
      return (
        messages[prefix] +
        delimiter +
        translateUiMessage(message.slice(split + delimiter.length), language)
      );
    }
  }
  return /[ぁ-んァ-ヶ一-龠]/u.test(message) ? "Details: " + message : message;
}
