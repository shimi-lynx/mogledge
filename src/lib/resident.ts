import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceDocument } from "./types";

export type ResidentTarget =
  | { kind: "current" }
  | { kind: "pinned"; rootIdentity: string; document: WorkspaceDocument };
export type ResidentCustomShortcut = {
  kind: "custom";
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
};
export type ResidentShortcut = { kind: "standard" } | ResidentCustomShortcut;
export type ResidentStatus = {
  enabled: boolean;
  trayAvailable: boolean;
  startupEnabled: boolean;
  startupRegistered: boolean | null;
  target: ResidentTarget;
  shortcut: ResidentShortcut;
  monitorStatus: "off" | "active" | "permission-required" | "unavailable";
  supported: boolean;
  readOnly: boolean;
  error: string | null;
};
export type ResidentAction =
  | { kind: "enabled" | "startup"; enabled: boolean }
  | { kind: "current" | "checkPermission" | "openPermissionSettings" }
  | { kind: "language"; language: "ja" | "en" }
  | { kind: "shortcut"; shortcut: ResidentShortcut }
  | {
      kind: "pin";
      workspaceId: string;
      viewId: string;
      revision: number;
      relativePath: string;
    };
export type ResidentSelection = {
  workspaceId: string | null;
  viewId: string;
  revision: number;
  document: WorkspaceDocument | null;
  fallback: boolean;
};
export type ResidentApi = {
  status: () => Promise<ResidentStatus>;
  update: (action: ResidentAction) => Promise<ResidentStatus>;
  resolve: (tabId?: string) => Promise<ResidentSelection>;
};
export const residentApi: ResidentApi = {
  status: () => invoke("get_resident_status"),
  update: (action) => invoke("update_resident_preferences", { action }),
  resolve: (tabId) => invoke("resolve_resident_target", { tabId }),
};

const shortcutKeys = new Set([
  "Space",
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);
export function residentShortcutFromKey(
  event: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "repeat" | "isComposing"
  >,
): ResidentCustomShortcut | null {
  // Capture an explicitly requested physical combination, never text or an input history.
  if (event.repeat || event.isComposing || !(event.ctrlKey || event.altKey || event.metaKey))
    return null;
  if (
    !/^(?:Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(event.code) &&
    !shortcutKeys.has(event.code)
  )
    return null;
  return {
    kind: "custom",
    control: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    key: event.code,
  };
}
export function residentShortcutLabel(shortcut: ResidentCustomShortcut): string {
  const key = shortcut.key.replace(/^(?:Key|Digit)/, "");
  return [
    shortcut.control && "Ctrl",
    shortcut.alt && "Alt",
    shortcut.shift && "Shift",
    shortcut.meta && "Cmd/Win",
    key,
  ]
    .filter(Boolean)
    .join(" + ");
}
export function sameResidentShortcut(left: ResidentShortcut, right: ResidentShortcut): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "standard" || right.kind === "standard") return true;
  return (
    left.control === right.control &&
    left.alt === right.alt &&
    left.shift === right.shift &&
    left.meta === right.meta &&
    left.key === right.key
  );
}

const preferenceDiagnostics = [
  "常駐設定を読み取れません",
  "常駐設定を更新できません",
  "常駐設定は読み取り専用です。保存内容を保持します",
  "常駐設定が無効です",
  "常駐設定が16KiBを超えています。原本を保持します",
  "常駐設定が上限を超えています",
  "常駐設定が外部で変更されました",
  "常駐設定が外部で変更されました。再起動して確認してください",
  "常駐設定が未対応または無効です。保存内容を保持します",
  "常駐設定の一時ファイルを作れません",
  "常駐設定の保存先が未初期化です",
  "常駐設定は通常ファイルではありません",
  "常駐設定を保存できません",
  "常駐設定を安全に読めません。保存内容を保持します",
  "常駐設定を書き込めません",
  "常駐設定を検証できません",
  "常駐設定を読めません",
  "常駐設定を読めません。保存内容を上書きせず保持します",
  "対象を確認できません",
  "対象HTMLが変更されました。再選択してください",
  "対象HTMLを識別できません",
  "対象のルートを識別できません",
];
const diagnosticMessages: Readonly<Record<string, string>> = {
  ...Object.fromEntries(preferenceDiagnostics.map((message) => [message, message])),
  ResidentInputUnavailable: "順次キー操作の監視を開始できません",
  ResidentInputConflict: "このアプリ内の別の入力監視と競合しています",
  ResidentPermissionRequired: "macOSの入力監視を利用者自身で許可してください",
  ResidentPermissionSettingsUnavailable:
    "入力監視の設定を開けません。システム設定から確認してください",
  ResidentPermissionNotRequired: "このOSでは入力監視の追加許可は不要です",
  ResidentUnsupportedPlatform: "常駐はWindowsとmacOSのNativeアプリで利用できます",
  ResidentTrayUnavailable: "トレイを準備できません。画面は表示したままです",
  ResidentRestoreUnavailable: "画面を戻せないため常駐を解除しません",
  ResidentStartupRequiresInstalledApp: "自動起動の登録と解除は正式な配布アプリで行ってください",
  ResidentStartupUnavailable: "自動起動の登録または解除に失敗しました",
  ResidentStartupLegacyRegistration:
    "旧版の自動起動登録が残っています。更新前に旧アプリで自動起動を解除し、更新後にMogledgeで有効にしてください。更新済みの場合は旧登録を確認して解除するまで変更しません。",
  ResidentStartupRollbackUnavailable:
    "OSの自動起動登録を元に戻せません。登録状態を再確認してください",
  ResidentSettingsReadOnly: "常駐設定は読み取り専用です。保存内容を保持します",
  ResidentUnavailable: "常駐設定を更新できません",
  ResidentInvalidSettings: "常駐設定が無効です",
  ResidentShortcutInvalid: "Ctrl・Alt・Cmd/Winのいずれかと通常キーを組み合わせてください",
  ResidentShortcutUnavailable: "呼び出しキーを登録できません。別の組み合わせを選んでください",
  ResidentShortcutRollbackUnavailable:
    "以前の呼び出しキーを復元できません。設定を再確認してください",
  ResidentShortcutReleaseUnavailable: "呼び出しキーを解除できません。設定を再確認してください",
  ResidentShortcutPermissionRequired:
    "標準の順次押しにはmacOSの入力監視の許可が必要です。現在の呼び出しキーを保持します",
};
export function residentDiagnostic(message: string): string {
  // IPC failures can contain internal filesystem paths. Only own, fixed
  // diagnostics reach the UI; inherited object properties are not messages.
  return Object.hasOwn(diagnosticMessages, message)
    ? diagnosticMessages[message]
    : diagnosticMessages.ResidentUnavailable;
}
