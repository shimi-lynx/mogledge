import type { WorkspaceSetShortcutSlot } from "./types";

export const workspaceSetShortcutSlots: readonly WorkspaceSetShortcutSlot[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
];

export function workspaceSetShortcutSlot(
  event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
): WorkspaceSetShortcutSlot | null {
  const primary = /Mac/i.test(navigator.platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!primary || !event.shiftKey || event.altKey || !/^Digit[0-9]$/.test(event.code)) return null;
  // Physical top-row codes survive JIS/US Shift symbols. Numpad is not a slot.
  return workspaceSetShortcutSlots.find((slot) => event.code === `Digit${slot % 10}`) ?? null;
}

export function workspaceSetShortcutHint(slot: WorkspaceSetShortcutSlot): string {
  return `${/Mac/i.test(navigator.platform) ? "Cmd" : "Ctrl"}+Shift+${slot % 10}`;
}
