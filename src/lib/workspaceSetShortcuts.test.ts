import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  workspaceSetShortcutHint,
  workspaceSetShortcutSlot,
  workspaceSetShortcutSlots,
} from "./workspaceSetShortcuts";

afterEach(() => vi.restoreAllMocks());

for (const [platform, modifier, wrong] of [
  ["Win32", "ctrlKey", "metaKey"],
  ["MacIntel", "metaKey", "ctrlKey"],
] as const) {
  it(`uses physical Digit codes and exact modifiers on ${platform}`, () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    for (const slot of workspaceSetShortcutSlots) {
      for (const key of [String(slot % 10), "!", "&", "(", ")", "~"]) {
        expect(
          workspaceSetShortcutSlot(
            new KeyboardEvent("keydown", {
              code: `Digit${slot % 10}`,
              key,
              [modifier]: true,
              shiftKey: true,
            }),
          ),
        ).toBe(slot);
      }
      expect(workspaceSetShortcutHint(slot)).toBe(
        `${platform === "MacIntel" ? "Cmd" : "Ctrl"}+Shift+${slot % 10}`,
      );
    }
    for (const options of [
      { code: "Digit1", [wrong]: true, shiftKey: true },
      { code: "Digit1", [modifier]: true },
      { code: "Digit1", [modifier]: true, shiftKey: true, altKey: true },
      { code: "Digit1", ctrlKey: true, metaKey: true, shiftKey: true },
      { code: "Numpad1", [modifier]: true, shiftKey: true },
      { code: "Digit11", [modifier]: true, shiftKey: true },
      { key: "1", [modifier]: true, shiftKey: true },
    ])
      expect(workspaceSetShortcutSlot(new KeyboardEvent("keydown", options))).toBeNull();
  });
}
