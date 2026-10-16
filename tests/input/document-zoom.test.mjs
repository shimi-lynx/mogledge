import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

// Mock gesture policy only; not a WKWebView/device test.
function inputFixture(platform = "Win32") {
  const listeners = new Map(),
    tasks = [],
    messages = [];
  let now = 0;
  function listen(name, listener, options) {
    const list = listeners.get(name) ?? [];
    list.push({ listener, capture: options === true || options?.capture === true });
    listeners.set(name, list);
  }
  function flush() {
    while (tasks.length) tasks.shift()();
  }
  const document = {
    activeElement: {
      matches: () => false,
      localName: "button",
      namespaceURI: "http://www.w3.org/1999/xhtml",
    },
    body: {},
    hasFocus: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
    hidden: false,
    addEventListener: listen,
  };
  runInNewContext(
    readFileSync("src-tauri/src/document_server/keyboard.js", "utf8").replace(
      "__MOGLEDGE_KEYBOARD_TOKEN__",
      '"test-token"',
    ),
    {
      window: {
        addEventListener: listen,
      },
      document,
      navigator: { platform },
      parent: {
        postMessage(message) {
          messages.push(message);
        },
      },
      Element: class {},
      performance: { now: () => now },
      innerHeight: 800,
      innerWidth: 1000,
      setTimeout(callback) {
        tasks.push(callback);
      },
    },
  );
  return {
    document,
    flush,
    send(name, fields = {}, afterDispatch, flushTasks = true) {
      const event = {
        isTrusted: true,
        defaultPrevented: false,
        cancelBubble: false,
        composedPath: () => [],
        ...fields,
      };
      for (const { listener, capture } of listeners.get(name) ?? []) {
        if (capture) listener(event);
      }
      for (const { listener, capture } of listeners.get(name) ?? []) {
        if (!capture && !event.cancelBubble) listener(event);
      }
      afterDispatch?.(event);
      if (flushTasks) flush();
    },
    time(value) {
      now = value;
    },
    changes() {
      return messages.map((message) => message.change ?? message.factor);
    },
    messages,
  };
}

test("mock gesture retains continuous ratios in quick bursts and excludes duplicate wheel", () => {
  const fixture = inputFixture();
  fixture.send("gesturestart", { scale: 1 });
  fixture.time(10);
  fixture.send("gesturechange", { scale: 1.2 });
  assert.deepEqual(fixture.changes(), [1.2]);
  fixture.time(30);
  fixture.send("gesturechange", { scale: 1.6 });
  fixture.send("wheel", { ctrlKey: true, deltaY: -100, deltaMode: 0 });
  assert.deepEqual(fixture.changes(), [1.2, 160 / 120]);
  fixture.time(150);
  fixture.send("gesturechange", { scale: 1.6 });
  fixture.time(300);
  fixture.send("gesturechange", { scale: 1.0 });
  fixture.send("gestureend");
  fixture.time(500);
  fixture.send("wheel", { ctrlKey: true, deltaY: -100, deltaMode: 0 });
  assert.deepEqual(fixture.changes(), [1.2, 160 / 120, 100 / 160]);
  fixture.time(800);
  fixture.send("wheel", { ctrlKey: true, deltaY: -100, deltaMode: 0 });
  assert.deepEqual(fixture.changes(), [1.2, 160 / 120, 100 / 160, "in"]);
});

test("mock gesture rejects invalid scales, synthetic input, later cancellation and editing", () => {
  const fixture = inputFixture();
  fixture.send("gesturestart", { isTrusted: false });
  fixture.send("gesturechange", { scale: 2 });
  fixture.send("gesturestart");
  for (const scale of [NaN, Infinity, -1, 0]) fixture.send("gesturechange", { scale });
  fixture.send("gesturechange", { scale: 2 }, (event) => {
    event.defaultPrevented = true;
  });
  fixture.document.activeElement = {
    matches: (selector) => selector === "input, textarea, select",
  };
  fixture.send("gesturechange", { scale: 2 });
  fixture.send("wheel", { ctrlKey: true, deltaY: -100, deltaMode: 0 });
  assert.deepEqual(fixture.changes(), []);
});

test("mock stopped gesture end clears capture state and invalidates queued start/change", () => {
  for (const queuedStart of [true, false]) {
    const fixture = inputFixture();
    fixture.send("gesturestart", {}, undefined, !queuedStart);
    fixture.send("gesturechange", { scale: 2 }, undefined, false);
    fixture.send("gestureend", { cancelBubble: true }, undefined, false);
    fixture.flush();
    assert.deepEqual(fixture.changes(), []);
    fixture.time(401);
    fixture.send("wheel", { ctrlKey: true, deltaY: -100, deltaMode: 0 });
    assert.deepEqual(fixture.changes(), ["in"]);
  }
});

test("mock blur/hidden invalidate queued gestures and missing end expires for wheel", () => {
  for (const name of ["blur", "visibilitychange"]) {
    const fixture = inputFixture();
    fixture.send("gesturestart", {}, undefined, false);
    fixture.document.hidden = name === "visibilitychange";
    fixture.send(name, {}, undefined, false);
    fixture.flush();
    fixture.document.hidden = false;
    fixture.send("wheel", { ctrlKey: true, deltaY: -100, deltaMode: 0 });
    assert.deepEqual(fixture.changes(), ["in"]);
  }
  const fixture = inputFixture();
  fixture.send("gesturestart");
  fixture.time(1400);
  fixture.send("wheel", { ctrlKey: true, deltaY: -100, deltaMode: 0 });
  assert.deepEqual(fixture.changes(), []);
  fixture.time(1501);
  fixture.send("wheel", { ctrlKey: true, deltaY: -100, deltaMode: 0 });
  assert.deepEqual(fixture.changes(), ["in"]);
});

test("mock Mac pixel pinch has no step threshold and carries a bounded viewport anchor", () => {
  const fixture = inputFixture("MacIntel");
  for (let i = 0; i < 3; i++)
    fixture.send("wheel", { ctrlKey: true, deltaY: -2, deltaMode: 0, clientX: 250, clientY: 600 });
  assert.equal(fixture.messages.length, 3);
  for (const message of fixture.messages) {
    assert.equal(message.type, "mogledge-document-pinch-v1");
    assert.equal(message.factor, Math.exp(0.004));
    assert.equal(message.x, 0.25);
    assert.equal(message.y, 0.75);
  }
});
test("mock gesture retains its start baseline through both clamped boundaries", () => {
  const fixture = inputFixture();
  fixture.send("gesturestart");
  for (const scale of [3, 2.5, 2, 1.9, 0.1, 0.3, 0.5, 0.6])
    fixture.send("gesturechange", { scale });
  assert.deepEqual(fixture.changes(), [2, 190 / 200, 50 / 190, 60 / 50]);
});
test("mock Mac wheel queued before blur/hidden cannot revive after focus recovery", () => {
  for (const name of ["blur", "visibilitychange"]) {
    const fixture = inputFixture("MacIntel");
    fixture.send("wheel", { ctrlKey: true, deltaY: -2, deltaMode: 0 }, undefined, false);
    fixture.document.hidden = name === "visibilitychange";
    fixture.send(name, {}, undefined, false);
    fixture.document.hidden = false;
    fixture.flush();
    assert.deepEqual(fixture.changes(), []);
  }
});

test("mock a new gesture invalidates old change tasks and synthetic end cannot terminate it", () => {
  const fixture = inputFixture();
  fixture.send("gesturestart");
  fixture.send("gesturechange", { scale: 2 }, undefined, false);
  fixture.send("gesturestart", {}, undefined, false);
  fixture.flush();
  assert.deepEqual(fixture.changes(), []);
  fixture.send("gestureend", { isTrusted: false });
  fixture.send("gesturechange", { scale: 1.2 });
  assert.deepEqual(fixture.changes(), [1.2]);
});
