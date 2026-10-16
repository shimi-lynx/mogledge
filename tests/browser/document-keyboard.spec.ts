import { test, expect, type Page } from "@playwright/test";
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
  for (const [key, message, label, shift] of [
    ["p", "mogledge-quick-open-v1", "quick-open", false],
    ["b", "mogledge-sidebar-toggle-v1", "sidebar-toggle", false],
    ["e", "mogledge-files-show-v1", "files-show", true],
    ["w", "mogledge-close-tab-v1", "close-tab", false],
  ])
    test(`opaque ${label} uses ${platform} keys and honors HTML, editor and composition priority`, async ({
      page,
    }) => {
      await page.setContent(`<script>window.quick=[];addEventListener('message',event=>{
      if(event.source===document.querySelector('iframe').contentWindow&&event.data.type==='${message}')window.quick.push(event.data);
    });</script><iframe sandbox="allow-scripts"></iframe>`);
      await page.locator("iframe").evaluate(
        (frame, { script, platform }) => {
          (frame as HTMLIFrameElement).srcdoc =
            `<!doctype html><script>Object.defineProperty(navigator,'platform',{value:${JSON.stringify(platform)}});</script><script>${script}</script>
        <button id="plain">Plain</button><input id="input"><div id="edit" contenteditable>Editor</div><dialog>Modal</dialog>
        <script>window.cancelQuick=false;window.stopQuick=false;window.stopLateQuick=false;
          document.addEventListener('keydown',event=>{if(window.stopQuick)event.stopPropagation();});
          window.addEventListener('keydown',event=>{if(window.cancelQuick)event.preventDefault();if(window.stopLateQuick)event.stopImmediatePropagation();});
        </script>`;
        },
        { script: keyboard, platform },
      );
      const frame = page.frameLocator("iframe");
      const plain = frame.locator("#plain");
      await plain.click();
      await plain.press(primary + (shift ? "+Shift+" : "+") + key);
      await expect.poll(() => page.evaluate("window.quick.length")).toBe(1);
      expect(await page.evaluate("window.quick[0]")).toEqual({
        type: message,
        token,
      });
      if (key === "b" || key === "w") {
        await page.keyboard.down(primary);
        await page.keyboard.down(key);
        await expect.poll(() => page.evaluate("window.quick.length")).toBe(2);
        await page.keyboard.down(key);
        await page.keyboard.up(key);
        await page.keyboard.up(primary);
      }
      for (const chord of [
        other + (shift ? "+Shift+" : "+") + key,
        primary + (shift ? "+" : "+Shift+") + key,
        primary + (shift ? "+Alt+Shift+" : "+Alt+") + key,
        (shift ? "Control+Meta+Shift+" : "Control+Meta+") + key,
      ])
        await plain.press(chord);
      await plain.evaluate(() => {
        (window as unknown as { cancelQuick: boolean }).cancelQuick = true;
      });
      await plain.press(primary + (shift ? "+Shift+" : "+") + key);
      await plain.evaluate(() => {
        (window as unknown as { cancelQuick: boolean; stopQuick: boolean }).cancelQuick = false;
        (window as unknown as { stopQuick: boolean }).stopQuick = true;
      });
      await plain.press(primary + (shift ? "+Shift+" : "+") + key);
      await plain.evaluate(() => {
        (window as unknown as { stopQuick: boolean }).stopQuick = false;
      });
      if (key === "w") {
        await plain.evaluate(() => {
          (window as unknown as { stopLateQuick: boolean }).stopLateQuick = true;
        });
        await plain.press(primary + "+w");
        await page.waitForTimeout(60);
        // Existing adapter boundary: a later window propagation stop cannot undo
        // an observation already made. Such a listener must also preventDefault.
        expect(await page.evaluate("window.quick.length")).toBe(3);
        await plain.evaluate(() => {
          (window as unknown as { cancelQuick: boolean }).cancelQuick = true;
        });
        await plain.press(primary + "+w");
        await page.waitForTimeout(60);
        expect(await page.evaluate("window.quick.length")).toBe(3);
        await plain.evaluate(() => {
          (window as unknown as { stopLateQuick: boolean }).stopLateQuick = false;
          (window as unknown as { cancelQuick: boolean }).cancelQuick = false;
        });
      }
      for (const selector of ["#input", "#edit"]) {
        await frame.locator(selector).click();
        await frame.locator(selector).press(primary + (shift ? "+Shift+" : "+") + key);
      }
      await plain.click();
      await plain.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionstart")));
      await plain.press(primary + (shift ? "+Shift+" : "+") + key);
      await plain.evaluate(() => {
        window.dispatchEvent(new CompositionEvent("compositionend"));
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "b", ctrlKey: true, metaKey: true, bubbles: true }),
        );
        document.querySelector("dialog")!.showModal();
      });
      await frame.locator("dialog").press(primary + (shift ? "+Shift+" : "+") + key);
      // Observe absence across the deferred next task; this is not an initialization wait.
      await page.waitForTimeout(60);
      expect(await page.evaluate("window.quick.length")).toBe(
        key === "w" ? 3 : key === "b" ? 2 : 1,
      );
    });
}

for (const [platform, primary, other] of [
  ["Win32", "Control", "Meta"],
  ["MacIntel", "Meta", "Control"],
]) {
  test(`opaque AI handoff uses ${platform} keys and honors HTML, editor and composition priority`, async ({
    page,
  }) => {
    await page.setContent(`<script>window.handoff=[];addEventListener('message',event=>{
      if(event.source===document.querySelector('iframe').contentWindow&&event.data.type==='mogledge-ai-handoff-v1')window.handoff.push(event.data);
    });</script><iframe sandbox="allow-scripts"></iframe>`);
    await page.locator("iframe").evaluate(
      (frame, { script, platform }) => {
        (frame as HTMLIFrameElement).srcdoc =
          `<!doctype html><script>Object.defineProperty(navigator,'platform',{value:${JSON.stringify(platform)}});</script><script>${script}</script>
        <button id="plain">Plain</button><input id="input"><div id="edit" contenteditable>Editor</div><dialog>Modal</dialog>
        <script>window.cancelQuick=false;window.stopQuick=false;
          document.addEventListener('keydown',event=>{if(window.stopQuick)event.stopPropagation();});
          window.addEventListener('keydown',event=>{if(window.cancelQuick)event.preventDefault();});
        </script>`;
      },
      { script: keyboard, platform },
    );
    const frame = page.frameLocator("iframe");
    const plain = frame.locator("#plain");
    await plain.click();
    await plain.press(primary + "+Shift+a");
    await expect.poll(() => page.evaluate("window.handoff.length")).toBe(1);
    expect(await page.evaluate("window.handoff[0]")).toEqual({
      type: "mogledge-ai-handoff-v1",
      token,
    });
    for (const key of [
      other + "+Shift+a",
      primary + "+a",
      primary + "+Alt+Shift+a",
      "Control+Meta+Shift+a",
    ])
      await plain.press(key);
    await plain.evaluate(() => {
      (window as unknown as { cancelQuick: boolean }).cancelQuick = true;
    });
    await plain.press(primary + "+Shift+a");
    await plain.evaluate(() => {
      (window as unknown as { cancelQuick: boolean; stopQuick: boolean }).cancelQuick = false;
      (window as unknown as { stopQuick: boolean }).stopQuick = true;
    });
    await plain.press(primary + "+Shift+a");
    await plain.evaluate(() => {
      (window as unknown as { stopQuick: boolean }).stopQuick = false;
    });
    for (const selector of ["#input", "#edit"]) {
      await frame.locator(selector).click();
      await frame.locator(selector).press(primary + "+Shift+a");
    }
    await plain.click();
    await plain.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionstart")));
    await plain.press(primary + "+Shift+a");
    await plain.evaluate(() => {
      window.dispatchEvent(new CompositionEvent("compositionend"));
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "a",
          ctrlKey: /Win/.test(navigator.platform),
          metaKey: /Mac/.test(navigator.platform),
          shiftKey: true,
          bubbles: true,
        }),
      );
      document.querySelector("dialog")!.showModal();
    });
    await frame.locator("dialog").press(primary + "+Shift+a");
    // Observe absence across the deferred next task; this is not an initialization wait.
    await page.waitForTimeout(60);
    expect(await page.evaluate("window.handoff.length")).toBe(1);
  });
}

type ShadowWindow = {
  moves: unknown[];
  shadowFixture: {
    focus: (kind: string) => void;
    open: ShadowRoot;
    events: { trusted: boolean; prevented: boolean; target: string; editingInPath: boolean }[];
    lateModal: boolean;
  };
};

async function zoomDocument(page: Page) {
  await page.setContent(`<script>window.zooms=[];addEventListener('message',event=>{
    if(event.source===document.querySelector('iframe').contentWindow&&event.data.type==='mogledge-document-zoom-v1')window.zooms.push(event.data);
  });</script><iframe sandbox="allow-scripts" style="width:600px;height:400px"></iframe>`);
  await page.locator("iframe").evaluate((frame, script) => {
    (frame as HTMLIFrameElement).srcdoc = `<!doctype html><script>${script}</script>
      <button id="plain">Plain</button><input id="input"><div id="editor" contenteditable>Editable</div>
      <div style="height:3000px"></div><dialog>Modal</dialog><script>
        window.cancelZoom=false;window.addEventListener('keydown',event=>{if(window.cancelZoom)event.preventDefault();});
        window.addEventListener('wheel',event=>{if(window.cancelZoom)event.preventDefault();},{passive:false});
      </script>`;
  }, keyboard);
  return page.frameLocator("iframe");
}

test("opaque zoom keys cover equal, shifted plus, numpad and reset while respecting HTML and editing", async ({
  page,
}) => {
  const frame = await zoomDocument(page);
  const plain = frame.locator("#plain");
  await plain.click();
  for (const key of [
    "Control+Equal",
    "Control+Shift+Equal",
    "Control+Minus",
    "Control+NumpadAdd",
    "Control+NumpadSubtract",
    "Control+0",
  ])
    await plain.press(key);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { zooms: unknown[] }).zooms.length))
    .toBe(6);
  const changes = await page.evaluate(() =>
    (window as unknown as { zooms: { change: string }[] }).zooms.map((message) => message.change),
  );
  expect(changes).toEqual(["in", "in", "out", "in", "out", "reset"]);
  await plain.evaluate(() => {
    (window as unknown as { cancelZoom: boolean }).cancelZoom = true;
  });
  await plain.press("Control+Equal");
  await plain.evaluate(() => {
    (window as unknown as { cancelZoom: boolean }).cancelZoom = false;
  });
  for (const selector of ["#input", "#editor"]) {
    await frame.locator(selector).click();
    await frame.locator(selector).press("Control+Equal");
  }
  await plain.click();
  await plain.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionstart")));
  await plain.press("Control+0");
  await plain.evaluate(() => {
    window.dispatchEvent(new CompositionEvent("compositionend"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", ctrlKey: true }));
    document.querySelector("dialog")!.showModal();
  });
  await frame.locator("dialog").press("Control+Equal");
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => (window as unknown as { zooms: unknown[] }).zooms.length)).toBe(
    6,
  );
});

test("opaque Ctrl wheel accumulates small deltas and preserves ordinary scroll, cancellation and focused editors", async ({
  page,
}) => {
  const frame = await zoomDocument(page);
  await frame.locator("#plain").click();
  const bounds = await page.locator("iframe").boundingBox();
  await page.mouse.move(bounds!.x + 100, bounds!.y + 100);
  await page.keyboard.down("Control");
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -20);
    await page.waitForTimeout(30);
  }
  await page.keyboard.up("Control");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { zooms: unknown[] }).zooms.length))
    .toBe(1);
  await frame.locator("#plain").evaluate(() => {
    (window as unknown as { cancelZoom: boolean }).cancelZoom = true;
  });
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  await page.waitForTimeout(150);
  await frame.locator("#input").evaluate(() => {
    (window as unknown as { cancelZoom: boolean }).cancelZoom = false;
  });
  await frame.locator("#input").click();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 100);
  await page.keyboard.up("Control");
  await page.mouse.wheel(0, 100);
  await expect.poll(() => frame.locator("body").evaluate(() => scrollY)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { zooms: unknown[] }).zooms.length)).toBe(
    1,
  );
});

test("Mac document zoom keys use Command and leave Control keys alone", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "platform", { value: "MacIntel" }),
  );
  const frame = await zoomDocument(page);
  await frame.locator("#plain").click();
  await frame.locator("#plain").press("Control+Equal");
  await page.waitForTimeout(30);
  expect(await page.evaluate(() => (window as unknown as { zooms: unknown[] }).zooms.length)).toBe(
    0,
  );
  for (const key of [
    "Meta+Equal",
    "Meta+Shift+Equal",
    "Meta+Minus",
    "Meta+NumpadAdd",
    "Meta+NumpadSubtract",
    "Meta+0",
  ])
    await frame.locator("#plain").press(key);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { zooms: unknown[] }).zooms.length))
    .toBe(6);
  expect(
    await page.evaluate(() =>
      (window as unknown as { zooms: { change: string }[] }).zooms.map((message) => message.change),
    ),
  ).toEqual(["in", "in", "out", "in", "out", "reset"]);
});

test("opaque document keyboard defers to HTML cancellation and preserves editing/IME", async ({
  page,
}) => {
  await page.setContent(`<script>
    window.moves = [];
    addEventListener('message', event => {
      if (event.source === document.querySelector('iframe').contentWindow)
        if (event.data?.type === 'mogledge-move-tab-v1') window.moves.push({ data: event.data, origin: event.origin });
    });
  </script><iframe sandbox="allow-scripts"></iframe>`);
  await page.locator("iframe").evaluate((frame, script) => {
    (frame as HTMLIFrameElement).srcdoc = `<!doctype html><script>${script}</script>
      <button id="plain">Plain</button><input id="input"><textarea></textarea>
      <div id="editor" contenteditable>Editable</div><dialog>Modal</dialog>
      <script>
        window.mode = 'plain'; window.handled = 0;
        document.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          if (window.mode === 'document-cancel') { window.handled++; event.preventDefault(); }
          if (window.mode === 'stop') { window.handled++; event.stopPropagation(); }
        });
        window.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          if (window.mode === 'window-cancel') { window.handled++; event.preventDefault(); }
        });
      </script>`;
  }, keyboard);
  const frame = page.frameLocator("iframe");
  const plain = frame.locator("#plain");
  await plain.click();
  await plain.press("Control+Shift+ArrowRight");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { moves: unknown[] }).moves.length))
    .toBe(1);
  const first = await page.evaluate(() => (window as unknown as { moves: unknown[] }).moves[0]);
  expect(first).toEqual({
    data: { type: "mogledge-move-tab-v1", token, direction: 1 },
    origin: "null",
  });
  const counts: number[] = [];
  for (const mode of ["document-cancel", "window-cancel", "stop"]) {
    await plain.evaluate((_element, mode) => {
      (window as unknown as { mode: string }).mode = mode;
    }, mode);
    await plain.press("Control+Shift+ArrowLeft");
    await expect
      .poll(() => plain.evaluate(() => (window as unknown as { handled: number }).handled))
      .toBe(counts.length + 1);
    // Wait for the posted-message queue after the trusted keyboard event.
    await page.waitForTimeout(40);
    counts.push(
      await page.evaluate(() => (window as unknown as { moves: unknown[] }).moves.length),
    );
  }
  expect(counts).toEqual([1, 1, 1]);
  await plain.evaluate(() => {
    (window as unknown as { mode: string }).mode = "plain";
  });
  for (const selector of ["#input", "textarea", "#editor"]) {
    await frame.locator(selector).click();
    await frame.locator(selector).press("Control+Shift+ArrowRight");
  }
  await plain.click();
  await plain.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionstart")));
  await plain.press("Control+Shift+ArrowRight");
  await plain.evaluate(() => {
    window.dispatchEvent(new CompositionEvent("compositionend"));
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, shiftKey: true }),
    );
    document.querySelector("dialog")!.showModal();
  });
  await frame.locator("dialog").press("Control+Shift+ArrowRight");
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => (window as unknown as { moves: unknown[] }).moves.length)).toBe(
    1,
  );
  await plain.evaluate(() => document.querySelector("dialog")!.close());
  await plain.click();
  await plain.press("Control+Shift+ArrowLeft");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { moves: unknown[] }).moves.length))
    .toBe(2);
  expect(
    await plain.evaluate(() => {
      try {
        void parent.document.body;
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
});

async function shadowDocument(page: Page) {
  await page.setContent(`<script>
    window.moves = [];
    addEventListener('message', event => {
      if (event.source === document.querySelector('iframe').contentWindow)
        if (event.data?.type === 'mogledge-move-tab-v1') window.moves.push(event.data);
    });
  </script><iframe sandbox="allow-scripts"></iframe>`);
  await page.locator("iframe").evaluate((frame, script) => {
    (frame as HTMLIFrameElement).srcdoc = `<!doctype html><script>${script}</script>
      <button id="plain">Plain</button><div id="closed-input"></div>
      <x-editor id="closed-editor"></x-editor><div id="open"></div>
      <div id="uncertain" tabindex="0">Focusable container</div>
      <script>
        const inputHost = document.querySelector('#closed-input');
        const input = document.createElement('input'); input.value = 'two words';
        inputHost.attachShadow({ mode: 'closed' }).append(input);
        const editorHost = document.querySelector('#closed-editor');
        const editor = document.createElement('div');
        editor.contentEditable = 'true'; editor.textContent = 'two words';
        editorHost.attachShadow({ mode: 'closed' }).append(editor);
        const open = document.querySelector('#open').attachShadow({ mode: 'open' });
        open.innerHTML = '<button id="shadow-plain">Shadow button</button><dialog><button>Modal button</button></dialog><div role="dialog" aria-modal="false"><button>ARIA button</button></div>';
        window.shadowFixture = {
          focus(kind) { (kind === 'input' ? input : editor).focus(); },
          open,
          events: [],
          lateModal: false,
        };
        window.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          window.shadowFixture.events.push({
            trusted: event.isTrusted, prevented: event.defaultPrevented,
            target: event.target.id,
            editingInPath: event.composedPath().some(node => node instanceof Element && (node.matches('input, textarea, select') || node.isContentEditable)),
          });
          if (window.shadowFixture.lateModal)
            open.querySelector('[role="dialog"]').setAttribute('aria-modal', 'true');
        });
      </script>`;
  }, keyboard);
  const frame = page.frameLocator("iframe");
  await frame.locator("#plain").click();
  return frame;
}

for (const kind of ["input", "editor"] as const) {
  test(`closed shadow ${kind} keeps trusted selection keys in the document`, async ({ page }) => {
    const frame = await shadowDocument(page);
    await frame.locator("#plain").evaluate((_element, kind) => {
      (window as unknown as ShadowWindow).shadowFixture.focus(kind);
    }, kind);
    await page.keyboard.press("Control+Shift+ArrowRight");
    await expect
      .poll(() =>
        frame
          .locator("#plain")
          .evaluate(() => (window as unknown as ShadowWindow).shadowFixture.events.length),
      )
      .toBe(1);
    const event = await frame
      .locator("#plain")
      .evaluate(() => (window as unknown as ShadowWindow).shadowFixture.events[0]);
    expect(event).toMatchObject({ trusted: true, prevented: false, editingInPath: false });
    expect(event.target).toBe(kind === "input" ? "closed-input" : "closed-editor");
    expect(await frame.locator(`#${event.target}`).evaluate((host) => host.shadowRoot)).toBeNull();
    await page.waitForTimeout(40);
    expect(await page.evaluate(() => (window as unknown as ShadowWindow).moves)).toEqual([]);
  });
}

test("open shadow native and ARIA modals suppress column moves", async ({ page }) => {
  const frame = await shadowDocument(page);
  await frame
    .locator("#plain")
    .evaluate(() =>
      (window as unknown as ShadowWindow).shadowFixture.open.querySelector("dialog")!.showModal(),
    );
  await page.keyboard.press("Control+Shift+ArrowRight");
  await expect
    .poll(() =>
      frame
        .locator("#plain")
        .evaluate(() => (window as unknown as ShadowWindow).shadowFixture.events.length),
    )
    .toBe(1);
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => (window as unknown as ShadowWindow).moves)).toEqual([]);
  await frame.locator("#plain").evaluate(() => {
    const open = (window as unknown as ShadowWindow).shadowFixture.open;
    open.querySelector("dialog")!.close();
    open.querySelector('[role="dialog"]')!.setAttribute("aria-modal", "true");
    document.querySelector<HTMLButtonElement>("#plain")!.focus();
  });
  await page.keyboard.press("Control+Shift+ArrowRight");
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => (window as unknown as ShadowWindow).moves)).toEqual([]);
});

test("deferred move rechecks shadow modal and ambiguous focus while ordinary buttons still move", async ({
  page,
}) => {
  const frame = await shadowDocument(page);
  await frame.locator("#plain").evaluate(() => {
    (window as unknown as ShadowWindow).shadowFixture.lateModal = true;
  });
  await page.keyboard.press("Control+Shift+ArrowRight");
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => (window as unknown as ShadowWindow).moves)).toEqual([]);
  await frame.locator("#plain").evaluate(() => {
    const fixture = (window as unknown as ShadowWindow).shadowFixture;
    fixture.lateModal = false;
    fixture.open.querySelector('[role="dialog"]')!.setAttribute("aria-modal", "false");
    document.querySelector<HTMLElement>("#uncertain")!.focus();
  });
  await page.keyboard.press("Control+Shift+ArrowRight");
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => (window as unknown as ShadowWindow).moves)).toEqual([]);
  await frame
    .locator("#plain")
    .evaluate(() =>
      (window as unknown as ShadowWindow).shadowFixture.open
        .querySelector<HTMLElement>("#shadow-plain")!
        .focus(),
    );
  await page.keyboard.press("Control+Shift+ArrowRight");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as ShadowWindow).moves.length))
    .toBe(1);
  await frame
    .locator("#plain")
    .evaluate(() =>
      ((window as unknown as ShadowWindow).shadowFixture.open.activeElement as HTMLElement).blur(),
    );
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as ShadowWindow).moves.length))
    .toBe(2);
});

test("closed body shadow editing is protected while a neutral body still allows moves", async ({
  page,
}) => {
  const frame = await shadowDocument(page);
  await frame.locator("#plain").evaluate(() => {
    const root = document.body.attachShadow({ mode: "closed" });
    const input = document.createElement("input");
    root.append(input);
    input.focus();
  });
  await page.keyboard.press("Control+Shift+ArrowRight");
  await expect
    .poll(() =>
      frame
        .locator("#plain")
        .evaluate(() => (window as unknown as ShadowWindow).shadowFixture.events.length),
    )
    .toBe(1);
  const focused = await frame.locator("#plain").evaluate(() => ({
    bodyActive: document.activeElement === document.body,
    bodyFocused: document.body.matches(":focus"),
    rootHidden: document.body.shadowRoot === null,
  }));
  expect(focused).toEqual({ bodyActive: true, bodyFocused: true, rootHidden: true });
  await page.waitForTimeout(40);
  expect(await page.evaluate(() => (window as unknown as ShadowWindow).moves)).toEqual([]);
});

for (const [platform, back, forward] of [
  ["Win32", "Alt+ArrowLeft", "Alt+ArrowRight"],
  ["MacIntel", "Meta+BracketLeft", "Meta+BracketRight"],
]) {
  test(`opaque history keys use ${platform} and preserve HTML input composition and modal priority`, async ({
    page,
  }) => {
    await page.setContent(
      `<script>window.steps=[];addEventListener('message', event=>{if(event.source===document.querySelector('iframe').contentWindow&&event.data.type==='mogledge-history-v1')window.steps.push(event.data);});</script><iframe sandbox="allow-scripts"></iframe>`,
    );
    await page.locator("iframe").evaluate(
      (frame, { platform, script }) => {
        (frame as HTMLIFrameElement).srcdoc =
          `<script>Object.defineProperty(navigator,'platform',{value:${JSON.stringify(platform)}});</script><script>${script}</script><button id="plain">Plain</button><input><textarea></textarea><div contenteditable>Editor</div><dialog>Modal</dialog><script>window.cancelStep=false;window.stopStep=false;document.addEventListener('keydown',event=>{if(window.stopStep)event.stopPropagation();});window.addEventListener('keydown',event=>{if(window.cancelStep)event.preventDefault();});</script>`;
      },
      { platform, script: keyboard },
    );
    const frame = page.frameLocator("iframe"),
      plain = frame.locator("#plain");
    await plain.click();
    await plain.press(back);
    await plain.press(forward);
    await expect.poll(() => page.evaluate("window.steps.length")).toBe(2);
    expect(await page.evaluate("window.steps.map(step=>step.direction)")).toEqual([
      "back",
      "forward",
    ]);
    await plain.evaluate(() => {
      (window as unknown as { cancelStep: boolean }).cancelStep = true;
    });
    await plain.press(back);
    await plain.evaluate(() => {
      (window as unknown as { cancelStep: boolean; stopStep: boolean }).cancelStep = false;
      (window as unknown as { stopStep: boolean }).stopStep = true;
    });
    await plain.press(back);
    await plain.evaluate(() => {
      (window as unknown as { stopStep: boolean }).stopStep = false;
    });
    for (const selector of ["input", "textarea", "[contenteditable]"]) {
      await frame.locator(selector).click();
      await frame.locator(selector).press(back);
    }
    await plain.click();
    await plain.evaluate(() => window.dispatchEvent(new CompositionEvent("compositionstart")));
    await plain.press(back);
    await plain.evaluate(() => {
      window.dispatchEvent(new CompositionEvent("compositionend"));
      document.querySelector("dialog")!.showModal();
    });
    await frame.locator("dialog").press(back);
    await page.waitForTimeout(60);
    expect(await page.evaluate("window.steps.length")).toBe(2);
  });
}

test("history fragment waits for parser-blocking script and complete DOM before acknowledgement", async ({
  page,
}) => {
  const links = readFileSync("src-tauri/src/document_server/links.js", "utf8").replace(
    "__MOGLEDGE_LINK_TOKEN__",
    JSON.stringify(token),
  );
  let gate!: import("@playwright/test").Route;
  await page.route("https://fixture.test/gate.js", (route) => {
    gate = route;
  });
  await page.route("https://fixture.test/host", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<script>window.anchorResults=[];addEventListener('message',e=>{if(e.data.type==='mogledge-anchor-result-v1')window.anchorResults.push(e.data);});</script><iframe sandbox="allow-scripts" src="/document"></iframe>`,
    }),
  );
  await page.route("https://fixture.test/document", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<script>${links}</script><script src="https://fixture.test/gate.js"></script><div id="chapter">Late chapter</div>`,
    }),
  );
  const request = page.waitForRequest("https://fixture.test/gate.js");
  await page.goto("https://fixture.test/host", { waitUntil: "domcontentloaded" });
  await request;
  await page
    .locator("iframe")
    .evaluate(
      (frame, token) =>
        (frame as HTMLIFrameElement).contentWindow!.postMessage(
          { type: "mogledge-anchor-v1", token, fragment: "#chapter", request: 7 },
          "*",
        ),
      token,
    );
  await page.waitForTimeout(60);
  expect(await page.evaluate("window.anchorResults.length")).toBe(0);
  await gate.fulfill({ contentType: "application/javascript", body: "void 0;" });
  await expect.poll(() => page.evaluate("window.anchorResults.length")).toBe(1);
  expect(await page.evaluate("window.anchorResults[0].success")).toBe(true);
});
