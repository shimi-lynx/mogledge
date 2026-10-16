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
  test(`settings comma shortcut honors trusted HTML input and cancellation on ${platform}`, async ({
    page,
  }) => {
    await page.setContent(`<script>window.settings=[];addEventListener('message',event=>{
      if(event.source===document.querySelector('iframe').contentWindow&&event.data.type==='mogledge-settings-open-v1')window.settings.push(event.data);
    });</script><iframe sandbox="allow-scripts"></iframe>`);
    await page.locator("iframe").evaluate(
      (element, { keyboard, platform }) => {
        (element as HTMLIFrameElement).srcdoc =
          `<!doctype html><script>Object.defineProperty(navigator,'platform',{value:${JSON.stringify(platform)}});</script><script>${keyboard}</script>
      <button id="plain">Plain</button><input id="input"><textarea id="text"></textarea><select id="select"><option>Option</option></select><div id="edit" contenteditable>Editor</div><dialog tabindex="0">Modal</dialog>
      <script>window.cancelSettings=false;window.stopSettings=false;window.openModal=false;
      document.addEventListener('keydown',event=>{if(window.stopSettings)event.stopPropagation();});
      window.addEventListener('keydown',event=>{if(window.cancelSettings)event.preventDefault();if(window.openModal)document.querySelector('dialog').showModal();});</script>`;
      },
      { keyboard, platform },
    );
    const frame = page.frameLocator("iframe");
    const plain = frame.locator("#plain");
    await plain.click();
    await plain.press(primary + "+,");
    await expect.poll(() => page.evaluate("window.settings.length")).toBe(1);
    expect(await page.evaluate("window.settings[0]")).toEqual({
      type: "mogledge-settings-open-v1",
      token,
    });
    for (const key of [other + "+,", primary + "+Shift+,", primary + "+Alt+,", "Control+Meta+,"])
      await plain.press(key);
    await plain.evaluate(() => {
      (window as unknown as { cancelSettings: boolean }).cancelSettings = true;
    });
    await plain.press(primary + "+,");
    await plain.evaluate(() => {
      (window as unknown as { cancelSettings: boolean }).cancelSettings = false;
      (window as unknown as { stopSettings: boolean }).stopSettings = true;
    });
    await plain.press(primary + "+,");
    await plain.evaluate(() => {
      (window as unknown as { stopSettings: boolean }).stopSettings = false;
    });
    for (const selector of ["#input", "#text", "#select", "#edit"]) {
      await frame.locator(selector).focus();
      await frame.locator(selector).press(primary + "+,");
    }
    await plain.click();
    await plain.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionstart")));
    await plain.press(primary + "+,");
    await plain.evaluate(() => {
      window.dispatchEvent(new CompositionEvent("compositionend"));
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true }),
      );
      (window as unknown as { openModal: boolean }).openModal = true;
    });
    await plain.press(primary + "+,");
    await frame.locator("dialog").press(primary + "+,");
    // Wait across the deferred proposal task before asserting absence.
    await page.waitForTimeout(60);
    expect(await page.evaluate("window.settings.length")).toBe(1);
  });
}
