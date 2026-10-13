import { useRef } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { AppState } from "../../lib/types";
import type { KnowledgeController } from "../../lib/controller";
import { useDocumentShortcuts } from "./documentShortcuts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const token = "a".repeat(64);
function currentState(): AppState {
  return {
    snapshot: {
      workspaceId: "root",
      viewId: "view",
      rootPath: "/fixture",
      revision: 1,
      nodes: [],
      watchError: null,
    },
    tabs: [
      {
        id: "tab",
        path: "a.html",
        url: `http://127.0.0.1/s/${token}/index.html`,
        loading: false,
        closing: false,
        dirty: false,
        missing: false,
        error: null,
      },
    ],
    columns: ["tab", null],
    activeColumn: 0,
    split: false,
    closed: [],
    selectedPath: "a.html",
    documentUrl: null,
    loading: false,
    error: null,
    actionBusy: false,
    actionMessage: null,
    workspaceSets: {
      sets: [],
      setShortcuts: ["set", null, null, null, null, null, null, null, null, "zero"],
      error: null,
      readOnly: false,
    },
  };
}
function Harness({ state, controller }: { state: AppState; controller: KnowledgeController }) {
  const stage = useRef<HTMLDivElement>(null);
  useDocumentShortcuts(stage, state, controller);
  return (
    <div ref={stage}>
      <section className="document-pane" id="panel-tab">
        <iframe title="document" src={state.tabs[0]?.url ?? ""} />
      </section>
      <button>Shell</button>
      <input aria-label="Editor" />
      <div contentEditable>Editable</div>
    </div>
  );
}
function setup() {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const state = currentState();
  const restore = vi.fn();
  const close = vi.fn(async () => {});
  const focus = vi.fn();
  const controller = {
    getSnapshot: () => state,
    restoreWorkspaceSetShortcut: restore,
    closeTab: close,
    focusTab: focus,
  } as unknown as KnowledgeController;
  return {
    state,
    restore,
    close,
    focus,
    controller,
    ...render(<Harness state={state} controller={controller} />),
  };
}
for (const [platform, modifier] of [
  ["Win32", "ctrlKey"],
  ["MacIntel", "metaKey"],
] as const) {
  it(`shell slots honor unassigned, input, IME, modal, focus and busy guards on ${platform}`, () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const ctx = setup();
    const shell = ctx.getByRole("button");
    shell.focus();
    const key = (extra: KeyboardEventInit = {}) =>
      fireEvent.keyDown(window, {
        code: "Digit1",
        key: "!",
        [modifier]: true,
        shiftKey: true,
        ...extra,
      });
    key();
    expect(ctx.restore).toHaveBeenCalledExactlyOnceWith(1);
    key({ code: "Digit2" });
    key({ repeat: true });
    key({ isComposing: true });
    key({ keyCode: 229 });
    ctx.getByRole("textbox", { name: "Editor" }).focus();
    key();
    ctx.container.querySelector<HTMLElement>("[contenteditable]")!.focus();
    key();
    shell.focus();
    fireEvent(document, new CompositionEvent("compositionstart"));
    key();
    fireEvent(document, new CompositionEvent("compositionend"));
    const dialog = document.createElement("dialog");
    dialog.open = true;
    document.body.append(dialog);
    key();
    dialog.remove();
    ctx.state.loading = true;
    key();
    ctx.state.loading = false;
    ctx.state.actionBusy = true;
    key();
    ctx.state.actionBusy = false;
    const cancelled = new KeyboardEvent("keydown", {
      code: "Digit1",
      [modifier]: true,
      shiftKey: true,
      cancelable: true,
    });
    cancelled.preventDefault();
    fireEvent(window, cancelled);
    ctx.container.querySelector("iframe")!.focus();
    key();
    shell.focus();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    key();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    expect(ctx.restore).toHaveBeenCalledOnce();
    key({ code: "Digit0", key: ")" });
    expect(ctx.restore).toHaveBeenLastCalledWith(10);
  });
}
it("accepts only an exact slot proposal from the current focused live frame", () => {
  const ctx = setup();
  const frame = ctx.container.querySelector("iframe")!;
  frame.focus();
  const data = { type: "my-knowledge-workspace-set-v1", token, slot: 10 };
  const send = (
    payload: unknown = data,
    source: Window | null = frame.contentWindow,
    origin = "null",
  ) => fireEvent(window, new MessageEvent("message", { source, data: payload, origin }));
  for (const slot of [0, 11, 1.5, "1", null]) send({ ...data, slot });
  send({ ...data, id: "arbitrary" });
  send({ ...data, token: "b".repeat(64) });
  send(data, window);
  send(data, frame.contentWindow, "http://foreign");
  const dialog = document.createElement("dialog");
  dialog.open = true;
  document.body.append(dialog);
  send();
  dialog.remove();
  expect(ctx.restore).not.toHaveBeenCalled();
  send();
  expect(ctx.restore).toHaveBeenCalledExactlyOnceWith(10);
  for (const extra of [
    { loading: true },
    { actionBusy: true },
    { tabs: [{ ...ctx.state.tabs[0], closing: true }] },
    { tabs: [{ ...ctx.state.tabs[0], deferred: true }] },
    { tabs: [{ ...ctx.state.tabs[0], kind: "help" as const }] },
  ]) {
    ctx.rerender(<Harness state={{ ...ctx.state, ...extra }} controller={ctx.controller} />);
    frame.focus();
    send();
  }
  ctx.rerender(<Harness state={ctx.state} controller={ctx.controller} />);
  frame.focus();
  frame.closest<HTMLElement>("section")!.hidden = true;
  send();
  expect(ctx.restore).toHaveBeenCalledOnce();
});

for (const [platform, primary, other] of [
  ["Win32", "ctrlKey", "metaKey"],
  ["MacIntel", "metaKey", "ctrlKey"],
] as const) {
  it(`closes the active column tab once and reserves repeats on ${platform}`, () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const ctx = setup();
    ctx.state.tabs.push({ ...ctx.state.tabs[0], id: "right", column: 1 });
    ctx.state.columns = ["tab", "right"];
    ctx.state.split = true;
    ctx.state.activeColumn = 1;
    const shell = ctx.getByRole("button");
    shell.focus();
    const key = (extra: KeyboardEventInit = {}) =>
      fireEvent.keyDown(shell, { key: "w", [primary]: true, ...extra });
    for (const fields of [
      { [primary]: false, [other]: true },
      { altKey: true },
      { shiftKey: true },
      { [other]: true },
      { isComposing: true },
      { keyCode: 229 },
    ])
      key(fields);
    ctx.getByRole("textbox").focus();
    key();
    ctx.container.querySelector<HTMLElement>("[contenteditable]")!.focus();
    key();
    shell.focus();
    const modal = document.createElement("dialog");
    modal.open = true;
    document.body.append(modal);
    key();
    modal.remove();
    fireEvent(document, new CompositionEvent("compositionstart"));
    key();
    fireEvent(document, new CompositionEvent("compositionend"));
    const cancelled = new KeyboardEvent("keydown", {
      key: "w",
      [primary]: true,
      bubbles: true,
      cancelable: true,
    });
    cancelled.preventDefault();
    shell.dispatchEvent(cancelled);
    expect(ctx.close).not.toHaveBeenCalled();
    expect(key()).toBe(false);
    expect(ctx.close).toHaveBeenCalledExactlyOnceWith("right");
    expect(key({ repeat: true })).toBe(false);
    key();
    expect(ctx.close).toHaveBeenCalledOnce();
  });
}

it("accepts only a current visible focused frame close proposal and rejects busy, hidden and stale sources", () => {
  const ctx = setup();
  const frame = ctx.getByTitle("document") as HTMLIFrameElement;
  frame.focus();
  const payload = { type: "my-knowledge-close-tab-v1", token };
  const send = (
    data: unknown = payload,
    source: MessageEventSource | null = frame.contentWindow,
    origin = "null",
  ) => fireEvent(window, new MessageEvent("message", { data, source, origin }));
  send({ ...payload, extra: true });
  send({ ...payload, token: "b".repeat(64) });
  send(payload, window);
  send(payload, frame.contentWindow, "http://foreign");
  ctx.state.actionBusy = true;
  send();
  ctx.state.actionBusy = false;
  ctx.state.loading = true;
  send();
  ctx.state.loading = false;
  frame.closest<HTMLElement>("section")!.hidden = true;
  send();
  frame.closest<HTMLElement>("section")!.hidden = false;
  ctx.state.tabs[0].closing = true;
  send();
  ctx.state.tabs[0].closing = false;
  ctx.getByRole("button").focus();
  send();
  frame.focus();
  expect(ctx.close).not.toHaveBeenCalled();
  send();
  send();
  expect(ctx.close).toHaveBeenCalledExactlyOnceWith("tab");
  expect(ctx.focus).toHaveBeenCalledWith("tab");
});
