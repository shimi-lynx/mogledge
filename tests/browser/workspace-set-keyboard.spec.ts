import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const token = "a".repeat(64);
const keyboard = readFileSync("src-tauri/src/document_server/keyboard.js", "utf8").replace(
  "__MOGLEDGE_KEYBOARD_TOKEN__",
  JSON.stringify(token),
);

for (const [platform, primary, other] of [
  ["Win32", "Control", "Meta"],
  ["MacIntel", "Meta", "Control"],
]) {
  test(`workspace slots use trusted physical Digit keys and preserve HTML priority on ${platform}`, async ({
    page,
  }) => {
    await page.setContent(`<script>window.slots=[];addEventListener('message',event=>{
      if(event.source===document.querySelector('iframe').contentWindow&&event.data.type==='mogledge-workspace-set-v1')window.slots.push(event.data);
    });</script><iframe sandbox="allow-scripts"></iframe>`);
    await page.locator("iframe").evaluate(
      (frame, { keyboard, platform }) => {
        (frame as HTMLIFrameElement).srcdoc =
          `<!doctype html><script>Object.defineProperty(navigator,'platform',{value:${JSON.stringify(platform)}});</script><script>${keyboard}</script>
        <button id="plain">Plain</button><input id="input"><textarea id="text"></textarea><select id="select"><option>Item</option></select><div id="edit" contenteditable>Editor</div><dialog tabindex="0">Modal</dialog>
        <script>window.cancelSlot=false;window.stopSlot=false;window.openModal=false;
          document.addEventListener('keydown',event=>{if(window.stopSlot)event.stopPropagation();});
          window.addEventListener('keydown',event=>{if(window.cancelSlot)event.preventDefault();if(window.openModal)document.querySelector('dialog').showModal();});
        </script>`;
      },
      { keyboard, platform },
    );
    const frame = page.frameLocator("iframe");
    const plain = frame.locator("#plain");
    await plain.click();
    for (const digit of [1, 2, 3, 4, 5, 6, 7, 8, 9, 0])
      await plain.press(`${primary}+Shift+Digit${digit}`);
    await expect.poll(() => page.evaluate("window.slots.length")).toBe(10);
    expect(await page.evaluate("window.slots")).toEqual(
      Array.from({ length: 10 }, (_, index) => ({
        type: "mogledge-workspace-set-v1",
        token,
        slot: index + 1,
      })),
    );
    for (const key of [
      `${other}+Shift+Digit1`,
      `${primary}+Digit1`,
      `${primary}+Alt+Shift+Digit1`,
      "Control+Meta+Shift+Digit1",
      `${primary}+Shift+Numpad1`,
    ])
      await plain.press(key);
    await plain.evaluate(() => {
      (window as unknown as { cancelSlot: boolean }).cancelSlot = true;
    });
    await plain.press(`${primary}+Shift+Digit1`);
    await plain.evaluate(() => {
      (window as unknown as { cancelSlot: boolean; stopSlot: boolean }).cancelSlot = false;
      (window as unknown as { stopSlot: boolean }).stopSlot = true;
    });
    await plain.press(`${primary}+Shift+Digit1`);
    await plain.evaluate(() => {
      (window as unknown as { stopSlot: boolean }).stopSlot = false;
    });
    for (const selector of ["#input", "#text", "#select", "#edit"]) {
      await frame.locator(selector).focus();
      await frame.locator(selector).press(`${primary}+Shift+Digit1`);
    }
    await plain.click();
    await plain.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionstart")));
    await plain.press(`${primary}+Shift+Digit1`);
    await plain.evaluate(() => {
      window.dispatchEvent(new CompositionEvent("compositionend"));
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "Digit1",
          ctrlKey: true,
          metaKey: true,
          shiftKey: true,
        }),
      );
      (window as unknown as { openModal: boolean }).openModal = true;
    });
    await plain.press(`${primary}+Shift+Digit1`);
    await frame.locator("dialog").press(`${primary}+Shift+Digit1`);
    // Absence is observed after the deferred proposal has had a chance to run.
    await page.waitForTimeout(60);
    expect(await page.evaluate("window.slots.length")).toBe(10);
  });
}
