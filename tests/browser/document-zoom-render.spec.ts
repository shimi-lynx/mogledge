import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Chromium opaque-frame rendering only; not a Native/WKWebView or physical pinch test.
const token = "a".repeat(64);
const keyboard = readFileSync("src-tauri/src/document_server/keyboard.js", "utf8").replace(
  "__MY_KNOWLEDGE_KEYBOARD_TOKEN__",
  JSON.stringify(token),
);
type Anchor = { x: number; y: number } | null;
type FixtureWindow = Window & {
  zoomFixture: {
    heap: { count: number };
    input: HTMLInputElement;
    canvas: HTMLCanvasElement;
    root: HTMLElement;
    body: HTMLElement;
    pointer: { x: number; y: number; rawX: number; rawY: number; trusted: boolean } | null;
    received: { zoom?: number }[];
    styleMutations: number;
    frames: Map<number, FrameRequestCallback>;
    flushFrames: () => number;
  };
};
function renderMessage(zoom: number, anchor: Anchor = null) {
  return { type: "my-knowledge-document-zoom-render-v1", token, zoom, anchor };
}
async function send(page: Page, message: unknown) {
  await page.locator("#document").evaluate((element, message) => {
    (element as HTMLIFrameElement).contentWindow!.postMessage(message, "*");
  }, message);
}
async function documentFixture(
  page: Page,
  { authoredStyle = "", stylesheet = "", controlledFrames = false, wide = false } = {},
) {
  await page.setContent(
    '<iframe id="document" sandbox="allow-scripts" style="width:600px;height:400px;border:0"></iframe>',
  );
  await page.locator("#document").evaluate(
    (element, options) => {
      (element as HTMLIFrameElement).srcdoc =
        `<!doctype html><html style="${options.authoredStyle}"><head>
      <script>
        window.zoomFixture={received:[],styleMutations:0,pointer:null,frames:new Map()};
        addEventListener('message',event=>window.zoomFixture.received.push(event.data));
        new MutationObserver(records=>window.zoomFixture.styleMutations+=records.length)
          .observe(document.documentElement,{attributes:true,attributeFilter:['style']});
        if(${options.controlledFrames}) {
          let nextId=0;
          requestAnimationFrame=callback=>{const id=++nextId;window.zoomFixture.frames.set(id,callback);return id;};
          cancelAnimationFrame=id=>window.zoomFixture.frames.delete(id);
          window.zoomFixture.flushFrames=()=>{const pending=[...window.zoomFixture.frames.values()];
            window.zoomFixture.frames.clear();for(const callback of pending)callback(performance.now());return pending.length;};
        }
      </script><script>${options.keyboard}</script>
      <style>body{margin:0;min-height:3000px;${options.wide ? "min-width:1600px;" : ""}}
        #glyph{display:block;width:120px;height:20px;font:20px monospace}
        #text{margin:0;font:16px/20px monospace}
        canvas{display:block;width:100px;height:80px}
        #anchor{position:absolute;left:500px;top:1000px;width:160px;height:120px;background:orange}
        ${options.stylesheet}</style></head><body>
      <span id="glyph">Readable text</span><input id="input" value="seed">
      <p id="text">${"word ".repeat(60)}</p><canvas id="canvas" width="100" height="80"></canvas>
      <button id="action">Action</button><div id="anchor"></div>
      <script>
        const fixture=window.zoomFixture;
        Object.assign(fixture,{heap:{count:41},input:document.querySelector('#input'),
          canvas:document.querySelector('canvas'),root:document.documentElement,body:document.body});
        fixture.canvas.getContext('2d').fillStyle='rgb(255,0,0)';
        fixture.canvas.getContext('2d').fillRect(3,4,1,1);
        fixture.canvas.addEventListener('pointerdown',event=>{
          const rect=fixture.canvas.getBoundingClientRect();
          fixture.pointer={x:(event.clientX-rect.left)*fixture.canvas.width/rect.width,
            y:(event.clientY-rect.top)*fixture.canvas.height/rect.height,
            rawX:event.offsetX,rawY:event.offsetY,trusted:event.isTrusted};
        });
        document.querySelector('#action').onclick=()=>fixture.heap.count++;
      </script></body></html>`;
    },
    { authoredStyle, stylesheet, controlledFrames, wide, keyboard },
  );
  const frame = page.frameLocator("#document");
  await expect(frame.locator("#action")).toBeAttached();
  return frame;
}

test("internal zoom reflows text and keeps scroll, Canvas pointer, DOM, input and heap", async ({
  page,
}) => {
  const frame = await documentFixture(page);
  await frame.locator("#input").fill("retained input");
  const before = await frame.locator("html").evaluate(() => {
    scrollTo(0, 600);
    return {
      glyphWidth: document.querySelector("#glyph")!.getBoundingClientRect().width,
      textWidth: Number.parseFloat(getComputedStyle(document.querySelector("#text")!).width),
      scrollY,
    };
  });
  const source = await page.locator("#document").getAttribute("srcdoc");
  const shellWidth = await page.evaluate(() => innerWidth);
  await send(page, renderMessage(125));
  await expect
    .poll(() => frame.locator("html").evaluate((root) => getComputedStyle(root).zoom))
    .toBe("1.25");
  const after = await frame.locator("html").evaluate(() => ({
    glyphWidth: document.querySelector("#glyph")!.getBoundingClientRect().width,
    textWidth: Number.parseFloat(getComputedStyle(document.querySelector("#text")!).width),
    scrollY,
  }));
  expect(after.glyphWidth / before.glyphWidth).toBeCloseTo(1.25, 2);
  expect(after.textWidth).toBeLessThan(before.textWidth);
  expect(after.scrollY).toBe(before.scrollY);
  await frame.locator("html").evaluate(() => scrollTo(0, 0));
  const frameBox = await page.locator("#document").boundingBox();
  const canvasBox = await frame.locator("#canvas").evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width };
  });
  const scale = canvasBox.width / 100;
  await page.mouse.click(
    frameBox!.x + canvasBox.x + 12 * scale,
    frameBox!.y + canvasBox.y + 20 * scale,
  );
  const pointer = await frame
    .locator("html")
    .evaluate(() => (window as unknown as FixtureWindow).zoomFixture.pointer);
  expect(pointer?.trusted).toBe(true);
  expect(pointer?.x).toBeCloseTo(12, 0);
  expect(pointer?.y).toBeCloseTo(20, 0);
  // Keep the browser's standard offsets intact. Rewriting them to logical pixels
  // would break HTML that already converts offset/rect coordinates to its buffer.
  expect(pointer?.rawX).toBeCloseTo(15, 0);
  expect(pointer?.rawY).toBeCloseTo(25, 0);
  await frame.locator("#action").click();
  expect(
    await frame.locator("html").evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).zoomFixture;
      return {
        sameNodes:
          fixture.root === document.documentElement &&
          fixture.body === document.body &&
          fixture.input === document.querySelector("#input") &&
          fixture.canvas === document.querySelector("#canvas"),
        input: fixture.input.value,
        count: fixture.heap.count,
        pixel: [...fixture.canvas.getContext("2d")!.getImageData(3, 4, 1, 1).data],
      };
    }),
  ).toEqual({ sameNodes: true, input: "retained input", count: 42, pixel: [255, 0, 0, 255] });
  expect(await page.locator("#document").getAttribute("srcdoc")).toBe(source);
  expect(await page.evaluate(() => innerWidth)).toBe(shellWidth);
});

test("continuous zoom keeps the pointed document location through scroll compensation", async ({
  page,
}) => {
  const frame = await documentFixture(page, { wide: true });
  const before = await frame.locator("#anchor").evaluate((target) => {
    scrollTo(200, 800);
    const rect = target.getBoundingClientRect();
    return {
      x: rect.left + rect.width * 0.25,
      y: rect.top + rect.height * 0.25,
      width: innerWidth,
      height: innerHeight,
    };
  });
  await send(page, renderMessage(135, { x: before.x / before.width, y: before.y / before.height }));
  await expect
    .poll(() => frame.locator("html").evaluate((root) => getComputedStyle(root).zoom))
    .toBe("1.35");
  const after = await frame.locator("#anchor").evaluate((target) => {
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.25 };
  });
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
});

test("pointer compensation and discrete restoration override authored smooth window scrolling", async ({
  page,
}) => {
  const frame = await documentFixture(page, {
    wide: true,
    controlledFrames: true,
    stylesheet: "html{scroll-behavior:smooth}",
  });
  const before = await frame.locator("#anchor").evaluate((target) => {
    scrollTo({ left: 200, top: 800, behavior: "instant" });
    const rect = target.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 4,
      y: rect.top + rect.height / 4,
      width: innerWidth,
      height: innerHeight,
    };
  });
  await send(page, renderMessage(135, { x: before.x / before.width, y: before.y / before.height }));
  await expect
    .poll(() =>
      frame
        .locator("html")
        .evaluate(() => (window as unknown as FixtureWindow).zoomFixture.frames.size),
    )
    .toBe(1);
  const after = await frame.locator("#anchor").evaluate((target) => {
    (window as unknown as FixtureWindow).zoomFixture.flushFrames();
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 4, y: rect.top + rect.height / 4, scrollX, scrollY };
  });
  // Read in the application frame itself: waiting for a smooth animation would hide this regression.
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  await send(page, renderMessage(100));
  await expect
    .poll(() => frame.locator("html").evaluate((root) => getComputedStyle(root).zoom))
    .toBe("1");
  expect(await frame.locator("html").evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual({
    x: after.scrollX,
    y: after.scrollY,
  });
});

for (const containingBlock of [
  "none",
  "root-filter",
  "root-will-change-filter",
  "transform",
  "will-change",
  "contain",
] as const) {
  test(`shrinking a fixed panel respects its ${containingBlock} containing block`, async ({
    page,
  }) => {
    const frame = await documentFixture(page, { controlledFrames: true });
    await send(page, renderMessage(135));
    await expect
      .poll(() => frame.locator("html").evaluate((root) => getComputedStyle(root).zoom))
      .toBe("1.35");
    const before = await frame.locator("html").evaluate((_root, containingBlock) => {
      const viewportFixed = containingBlock === "none" || containingBlock.startsWith("root-");
      if (containingBlock === "root-filter")
        document.documentElement.style.filter = "brightness(1)";
      if (containingBlock === "root-will-change-filter")
        document.documentElement.style.willChange = "filter";
      const outer = document.createElement("div");
      outer.id = "background-outer";
      outer.style.cssText = "position:absolute;inset:0;width:600px;height:400px;overflow:auto";
      if (containingBlock === "transform") outer.style.transform = "translateZ(0)";
      if (containingBlock === "will-change") outer.style.willChange = "transform";
      if (containingBlock === "contain") outer.style.contain = "layout";
      const fixedPosition = viewportFixed ? "left:20px;top:20px" : "left:160px;top:260px";
      outer.innerHTML = `<div style="height:1800px;width:1200px">
      <div id="fixed-panel" style="position:fixed;${fixedPosition};width:300px;height:250px;overflow:auto">
        <div style="position:relative;height:1200px;width:800px">
          <div id="fixed-marker" style="position:absolute;left:70px;top:70px;width:80px;height:40px;background:orange"></div>
        </div>
      </div></div>`;
      document.body.append(outer);
      outer.scrollTo({ left: 100, top: 200, behavior: "instant" });
      scrollTo({ top: 0, behavior: "instant" });
      const rect = document.querySelector("#fixed-marker")!.getBoundingClientRect();
      const x = rect.left + rect.width / 4,
        y = rect.top + rect.height / 4;
      return {
        x,
        y,
        width: innerWidth,
        height: innerHeight,
        outerX: outer.scrollLeft,
        outerY: outer.scrollTop,
        windowY: scrollY,
        hit: document.elementFromPoint(x, y)?.id,
      };
    }, containingBlock);
    expect(before.hit).toBe("fixed-marker");
    await send(
      page,
      renderMessage(100, { x: before.x / before.width, y: before.y / before.height }),
    );
    await expect
      .poll(() =>
        frame
          .locator("html")
          .evaluate(() => (window as unknown as FixtureWindow).zoomFixture.frames.size),
      )
      .toBe(1);
    const after = await frame.locator("#background-outer").evaluate((outer) => {
      (window as unknown as FixtureWindow).zoomFixture.flushFrames();
      const rect = document.querySelector("#fixed-marker")!.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 4,
        y: rect.top + rect.height / 4,
        outerX: outer.scrollLeft,
        outerY: outer.scrollTop,
        windowY: scrollY,
        panelY: document.querySelector("#fixed-panel")!.scrollTop,
      };
    });
    expect(after.panelY).toBe(0);
    if (containingBlock === "none" || containingBlock.startsWith("root-")) {
      expect(after.outerX).toBe(before.outerX);
      expect(after.outerY).toBe(before.outerY);
    } else {
      expect(after.outerY).toBeLessThan(before.outerY);
      expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
    }
    expect(after.windowY).toBe(before.windowY);
  });
}

for (const mode of ["fixed", "nested-fixed", "flow", "flow-clipped"] as const) {
  test(`pointer compensation consumes ${mode} container scroll and handles inner bounds`, async ({
    page,
  }) => {
    const frame = await documentFixture(page, {
      controlledFrames: true,
      stylesheet: "html{scroll-behavior:smooth}",
    });
    const before = await frame.locator("html").evaluate((_root, mode) => {
      const panel = document.createElement("div");
      panel.id = "panel";
      panel.style.cssText = mode.startsWith("flow")
        ? "position:absolute;left:0;top:800px;width:600px;height:300px;overflow:auto;scroll-behavior:smooth"
        : "position:fixed;inset:0;overflow:auto;scroll-behavior:smooth";
      const content = document.createElement("div");
      content.style.cssText = "position:relative;width:1600px;height:3000px";
      panel.append(content);
      document.body.append(panel);
      let inner = panel;
      if (mode === "nested-fixed") {
        inner = document.createElement("div");
        inner.id = "inner";
        inner.style.cssText =
          "position:absolute;left:100px;top:800px;width:400px;height:300px;overflow:auto;scroll-behavior:smooth";
        const innerContent = document.createElement("div");
        innerContent.style.cssText = "position:relative;width:900px;height:1000px";
        inner.append(innerContent);
        content.append(inner);
      } else if (mode === "flow") content.style.height = "1000px";
      const marker = document.createElement("div");
      marker.id = "container-anchor";
      marker.style.cssText = `position:absolute;left:${mode === "fixed" ? 500 : 300}px;top:${mode === "fixed" ? 1000 : 900}px;width:80px;height:40px;background:orange`;
      inner.firstElementChild!.append(marker);
      if (mode === "nested-fixed") {
        inner.scrollTo({ left: 150, top: 700, behavior: "instant" });
        panel.scrollTo({ top: 700, behavior: "instant" });
      } else
        panel.scrollTo({
          left: mode === "fixed" ? 250 : 150,
          top: mode === "fixed" ? 780 : 700,
          behavior: "instant",
        });
      scrollTo({ top: 700, behavior: "instant" });
      const rect = marker.getBoundingClientRect();
      const x = rect.left + rect.width / 4,
        y = rect.top + rect.height / 4;
      return {
        x,
        y,
        width: innerWidth,
        height: innerHeight,
        windowY: scrollY,
        panelY: panel.scrollTop,
        innerY: inner.scrollTop,
        hit: document.elementFromPoint(x, y)?.id,
      };
    }, mode);
    expect(before.hit).toBe("container-anchor");
    await send(
      page,
      renderMessage(135, { x: before.x / before.width, y: before.y / before.height }),
    );
    await expect
      .poll(() =>
        frame
          .locator("html")
          .evaluate(() => (window as unknown as FixtureWindow).zoomFixture.frames.size),
      )
      .toBe(1);
    const after = await frame.locator("#container-anchor").evaluate((marker) => {
      (window as unknown as FixtureWindow).zoomFixture.flushFrames();
      const rect = marker.getBoundingClientRect();
      const panel = document.querySelector("#panel")!;
      const inner = document.querySelector("#inner") ?? panel;
      return {
        x: rect.left + rect.width / 4,
        y: rect.top + rect.height / 4,
        windowY: scrollY,
        panelY: panel.scrollTop,
        innerY: inner.scrollTop,
      };
    });
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(2);
    if (mode.startsWith("flow")) {
      expect(after.panelY).toBe(before.panelY);
      expect(after.windowY).toBeGreaterThan(before.windowY);
    } else {
      expect(after.windowY).toBe(before.windowY);
      expect(after.panelY).toBeGreaterThan(before.panelY);
      if (mode === "nested-fixed") expect(after.innerY).toBe(before.innerY);
    }
  });
}

test("a blank scroller hit consumes its content displacement without double window compensation", async ({
  page,
}) => {
  const frame = await documentFixture(page, { controlledFrames: true });
  const before = await frame.locator("html").evaluate(() => {
    const panel = document.createElement("div");
    panel.id = "background-panel";
    panel.style.cssText =
      "position:absolute;left:0;top:0;width:600px;height:400px;overflow:auto;scroll-behavior:smooth";
    panel.innerHTML = '<div style="width:1600px;height:3000px;pointer-events:none"></div>';
    document.body.append(panel);
    panel.scrollTo({ left: 100, top: 700, behavior: "instant" });
    scrollTo({ top: 0, behavior: "instant" });
    return {
      logicalX: panel.scrollLeft + 200,
      logicalY: panel.scrollTop + 200,
      hit: document.elementFromPoint(200, 200)?.id,
    };
  });
  expect(before.hit).toBe("background-panel");
  await send(page, renderMessage(135, { x: 200 / 600, y: 200 / 400 }));
  await expect
    .poll(() =>
      frame
        .locator("html")
        .evaluate(() => (window as unknown as FixtureWindow).zoomFixture.frames.size),
    )
    .toBe(1);
  const after = await frame.locator("#background-panel").evaluate((panel) => {
    (window as unknown as FixtureWindow).zoomFixture.flushFrames();
    const rect = panel.getBoundingClientRect();
    // This ID belongs to the div created by this fixture, never an SVG element.
    const htmlPanel = panel as HTMLElement;
    return {
      logicalX: panel.scrollLeft + (200 - rect.left) / (rect.width / htmlPanel.offsetWidth),
      logicalY: panel.scrollTop + (200 - rect.top) / (rect.height / htmlPanel.offsetHeight),
      scrollX,
      scrollY,
    };
  });
  expect(after.logicalX).toBeCloseTo(before.logicalX, 0);
  expect(after.logicalY).toBeCloseTo(before.logicalY, 0);
  expect(after.scrollX).toBe(0);
  expect(after.scrollY).toBe(0);
});

for (const authored of [
  {
    authoredStyle: "zoom:1.1!important",
    stylesheet: "",
    scale: 1.1,
    value: "1.1",
    priority: "important",
  },
  {
    authoredStyle: "",
    stylesheet: "html{zoom:1.15!important}",
    scale: 1.15,
    value: "",
    priority: "",
  },
]) {
  test(`100% restores authored root zoom ${authored.scale} and its inline priority`, async ({
    page,
  }) => {
    const frame = await documentFixture(page, authored);
    await send(page, renderMessage(175));
    await expect
      .poll(() =>
        frame.locator("html").evaluate((root) => Number.parseFloat(getComputedStyle(root).zoom)),
      )
      .toBeCloseTo(authored.scale * 1.75, 4);
    expect(
      await frame.locator("html").evaluate((root) => root.style.getPropertyPriority("zoom")),
    ).toBe("important");
    await send(page, renderMessage(100));
    await expect
      .poll(() =>
        frame.locator("html").evaluate((root) => Number.parseFloat(getComputedStyle(root).zoom)),
      )
      .toBe(authored.scale);
    expect(
      await frame.locator("html").evaluate((root) => ({
        value: root.style.getPropertyValue("zoom"),
        priority: root.style.getPropertyPriority("zoom"),
      })),
    ).toEqual({ value: authored.value, priority: authored.priority });
  });
}

test("render messages reject wrong source, token, shape, bounds and nonfinite values", async ({
  page,
}) => {
  const frame = await documentFixture(page);
  const valid = renderMessage(175);
  await frame.locator("html").evaluate((_root, message) => window.postMessage(message, "*"), valid);
  for (const message of [
    { ...valid, token: "b".repeat(64) },
    { ...valid, type: "unrecognized" },
    { ...valid, extra: true },
    { type: valid.type, token, zoom: 175 },
    { ...valid, zoom: NaN },
    { ...valid, zoom: Infinity },
    { ...valid, zoom: 49 },
    { ...valid, zoom: 201 },
    { ...valid, zoom: "175" },
    { ...valid, anchor: {} },
    { ...valid, anchor: [] },
    { ...valid, anchor: { x: NaN, y: 0.5 } },
    { ...valid, anchor: { x: 0.5, y: Infinity } },
    { ...valid, anchor: { x: -0.01, y: 0.5 } },
    { ...valid, anchor: { x: 0.5, y: 1.01 } },
    { ...valid, anchor: { x: 0.5, y: 0.5, extra: true } },
    null,
    [],
  ])
    await send(page, message);
  await send(page, renderMessage(125));
  await expect
    .poll(() => frame.locator("html").evaluate((root) => getComputedStyle(root).zoom))
    .toBe("1.25");
  expect(
    await frame
      .locator("html")
      .evaluate(() => (window as unknown as FixtureWindow).zoomFixture.styleMutations),
  ).toBe(1);
});

test("continuous render coalesces to the latest value and reset cancels an older frame", async ({
  page,
}) => {
  const frame = await documentFixture(page, { controlledFrames: true });
  for (const zoom of [111, 129, 138]) await send(page, renderMessage(zoom, { x: 0.5, y: 0.5 }));
  await expect
    .poll(() =>
      frame
        .locator("html")
        .evaluate(() => (window as unknown as FixtureWindow).zoomFixture.received.at(-1)?.zoom),
    )
    .toBe(138);
  expect(
    await frame
      .locator("html")
      .evaluate(() => (window as unknown as FixtureWindow).zoomFixture.frames.size),
  ).toBe(1);
  expect(await frame.locator("html").evaluate((root) => root.style.getPropertyValue("zoom"))).toBe(
    "",
  );
  expect(
    await frame
      .locator("html")
      .evaluate(() => (window as unknown as FixtureWindow).zoomFixture.flushFrames()),
  ).toBe(1);
  await expect
    .poll(() => frame.locator("html").evaluate((root) => getComputedStyle(root).zoom))
    .toBe("1.38");
  await send(page, renderMessage(190, { x: 0.5, y: 0.5 }));
  await expect
    .poll(() =>
      frame
        .locator("html")
        .evaluate(() => (window as unknown as FixtureWindow).zoomFixture.frames.size),
    )
    .toBe(1);
  await send(page, renderMessage(100));
  await expect
    .poll(() => frame.locator("html").evaluate((root) => getComputedStyle(root).zoom))
    .toBe("1");
  expect(
    await frame
      .locator("html")
      .evaluate(() => (window as unknown as FixtureWindow).zoomFixture.flushFrames()),
  ).toBe(0);
  expect(await frame.locator("html").evaluate((root) => root.style.getPropertyValue("zoom"))).toBe(
    "",
  );
});

test("an early parent message waits for authored styles before capturing root zoom", async ({
  page,
}) => {
  let releaseParser!: () => void;
  let markBlocked!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseParser = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    markBlocked = resolve;
  });
  await page.route("https://zoom-fixture.invalid/parser.js", async (route) => {
    markBlocked();
    await release;
    await route.fulfill({ contentType: "text/javascript", body: "" });
  });
  try {
    await page.route("https://zoom-fixture.invalid/host", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<iframe id="document" sandbox="allow-scripts" src="/document" style="width:600px;height:400px;border:0"></iframe>',
      }),
    );
    await page.route("https://zoom-fixture.invalid/document", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>${keyboard}</script>
        <script>window.receivedZoom=null;addEventListener('message',event=>window.receivedZoom=event.data.zoom);</script>
        <script src="/parser.js"></script><style>html{zoom:1.1!important}</style><body>Ready</body>`,
      }),
    );
    await page.goto("https://zoom-fixture.invalid/host", { waitUntil: "domcontentloaded" });
    await blocked;
    const frame = page.frameLocator("#document");
    await send(page, renderMessage(125));
    await expect
      .poll(() =>
        frame
          .locator("html")
          .evaluate(() => (window as unknown as Window & { receivedZoom: number }).receivedZoom),
      )
      .toBe(125);
    expect(
      await frame.locator("html").evaluate((root) => ({
        ready: document.readyState,
        zoom: root.style.getPropertyValue("zoom"),
      })),
    ).toEqual({ ready: "loading", zoom: "" });
    releaseParser();
    await expect
      .poll(() =>
        frame.locator("html").evaluate((root) => Number.parseFloat(getComputedStyle(root).zoom)),
      )
      .toBeCloseTo(1.375, 4);
    await send(page, renderMessage(100));
    await expect
      .poll(() => frame.locator("html").evaluate((root) => getComputedStyle(root).zoom))
      .toBe("1.1");
    expect(
      await frame.locator("html").evaluate((root) => root.style.getPropertyValue("zoom")),
    ).toBe("");
  } finally {
    releaseParser();
  }
});

test("a parsed document keeps an early zoom pending until its external authored CSS loads", async ({
  page,
}) => {
  let releaseStyles!: () => void;
  let markBlocked!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseStyles = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    markBlocked = resolve;
  });
  await page.route("https://zoom-fixture.invalid/authored.css", async (route) => {
    markBlocked();
    await release;
    await route.fulfill({ contentType: "text/css", body: "html{zoom:1.1!important}" });
  });
  try {
    await page.route("https://zoom-fixture.invalid/host", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<iframe id="document" sandbox="allow-scripts" src="/document" style="width:600px;height:400px;border:0"></iframe>',
      }),
    );
    // No script follows the stylesheet: CSS must not defer DOMContentLoaded.
    await page.route("https://zoom-fixture.invalid/document", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><script>
        window.zoomLoadFixture={domReady:false,loaded:false,received:null};
        document.addEventListener('DOMContentLoaded',()=>window.zoomLoadFixture.domReady=true);
        addEventListener('load',()=>window.zoomLoadFixture.loaded=true);
        addEventListener('message',event=>window.zoomLoadFixture.received=event.data.zoom);
        ${keyboard}</script><link rel="stylesheet" href="/authored.css"></head>
        <body id="parsed">Parsed before CSS completes</body></html>`,
      }),
    );
    await page.goto("https://zoom-fixture.invalid/host", { waitUntil: "domcontentloaded" });
    await blocked;
    const frame = page.frameLocator("#document");
    const state = () =>
      frame.locator("#parsed").evaluate(() => {
        const fixture = (
          window as unknown as Window & {
            zoomLoadFixture: { domReady: boolean; loaded: boolean; received: number | null };
          }
        ).zoomLoadFixture;
        return {
          ...fixture,
          ready: document.readyState,
          zoom: document.documentElement.style.getPropertyValue("zoom"),
        };
      });
    await expect
      .poll(state)
      .toEqual({ domReady: true, loaded: false, received: null, ready: "interactive", zoom: "" });
    await send(page, renderMessage(125));
    await expect
      .poll(state)
      .toEqual({ domReady: true, loaded: false, received: 125, ready: "interactive", zoom: "" });
    releaseStyles();
    await expect
      .poll(() =>
        frame.locator("html").evaluate((root) => Number.parseFloat(getComputedStyle(root).zoom)),
      )
      .toBeCloseTo(1.375, 4);
    expect((await state()).loaded).toBe(true);
    await send(page, renderMessage(100));
    await expect
      .poll(() => frame.locator("html").evaluate((root) => getComputedStyle(root).zoom))
      .toBe("1.1");
    expect(
      await frame.locator("html").evaluate((root) => ({
        value: root.style.getPropertyValue("zoom"),
        priority: root.style.getPropertyPriority("zoom"),
      })),
    ).toEqual({ value: "", priority: "" });
  } finally {
    releaseStyles();
  }
});
