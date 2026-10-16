import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { AppState } from "../../lib/types";
import type { KnowledgeController } from "../../lib/controller";
import { setLanguage } from "../../lib/i18n";
import { DocumentExports } from "./DocumentExports";
const token = "a".repeat(64),
  id = "12345678-1234-1234-1234-123456789abc";
const url = `http://127.0.0.1/s/${token}/entry.html`;
const context = {
  workspaceId: "workspace",
  viewId: "view",
  tabId: "native-1",
  request: 2,
  revision: 3,
  token,
};
let activation = true;
beforeEach(() => {
  setLanguage("ja");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: {
      get isActive() {
        return activation;
      },
    },
  });
  activation = true;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (navigator as unknown as { userActivation?: unknown }).userActivation;
});
function setup() {
  const state: AppState = {
    snapshot: {
      workspaceId: "workspace",
      viewId: "view",
      rootPath: "/fixture",
      revision: 3,
      nodes: [],
      watchError: null,
    },
    tabs: [
      {
        id: "local-1",
        path: "entry.html",
        url,
        loading: false,
        closing: false,
        dirty: false,
        missing: false,
        error: null,
      },
    ],
    columns: ["local-1", null],
    activeColumn: 0,
    split: false,
    closed: [],
    selectedPath: "entry.html",
    documentUrl: url,
    loading: false,
    error: null,
    actionBusy: false,
    actionMessage: null,
  };
  const stage = createRef<HTMLDivElement>();
  const derive = vi.fn(() => context);
  const controller = { artifactContext: derive } as unknown as KnowledgeController;
  const api = vi.fn(async () => ({ status: "saved" as const, name: "report.txt", bytes: 1 }));
  const tree = (value = state) => (
    <>
      <div ref={stage}>
        <section id="panel-local-1" className="document-pane">
          <iframe src={url} />
        </section>
      </div>
      <DocumentExports stage={stage} state={value} controller={controller} api={api} />
    </>
  );
  const view = render(tree());
  const frame = view.container.querySelector("iframe")!;
  vi.spyOn(frame.contentWindow!, "focus").mockImplementation(() => {});
  const reply = vi.spyOn(frame.contentWindow!, "postMessage");
  const send = (data: Record<string, unknown> = {}, options: MessageEventInit = {}) => {
    frame.focus();
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: "null",
        source: frame.contentWindow,
        data: {
          type: "mogledge-artifact-export-v1",
          token,
          id,
          format: "text",
          name: "report",
          data: "YQ==",
          ...data,
        },
        ...options,
      }),
    );
  };
  return { state, frame, reply, send, api, derive, view, tree };
}
it("requires exact focused opaque/current source and main confirmation, preserves language/focus, then dispatches main-derived context", async () => {
  const f = setup();
  f.send({}, { origin: "http://foreign.test" });
  f.send({ token: "b".repeat(64) });
  f.send({ destination: "/tmp" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.api).not.toHaveBeenCalled();
  f.send();
  const dialog = screen.getByRole("dialog", { name: "生成ファイルを書き出す" });
  expect(f.api).not.toHaveBeenCalled();
  await act(() => setLanguage("en"));
  expect(screen.getByRole("dialog", { name: "Export generated file" })).toBe(dialog);
  activation = false;
  fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
  expect(f.api).not.toHaveBeenCalled();
  activation = true;
  fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.api).toHaveBeenCalledExactlyOnceWith({
    context,
    format: "text",
    name: "report",
    data: "YQ==",
  });
  expect(f.reply).toHaveBeenCalledWith(
    {
      type: "mogledge-artifact-result-v1",
      token,
      id,
      result: { status: "saved", name: "report.txt", bytes: 1 },
    },
    "*",
  );
  expect(document.activeElement).toBe(f.frame);
});
it("legacy protocol retains token checks and replies in its requested namespace", () => {
  const f = setup();
  f.send({ type: "my-knowledge-artifact-export-v1", token: "b".repeat(64) });
  expect(screen.queryByRole("dialog")).toBeNull();
  f.send({ type: "my-knowledge-artifact-export-v1" });
  fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
  expect(f.api).not.toHaveBeenCalled();
  expect(f.reply).toHaveBeenCalledWith(
    { type: "my-knowledge-artifact-result-v1", token, id, result: { status: "cancelled" } },
    "*",
  );
});
it("cancel never dispatches and immediate next requests are throttled", () => {
  const f = setup();
  f.send();
  fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
  expect(f.api).not.toHaveBeenCalled();
  expect(f.reply).toHaveBeenCalledWith(
    expect.objectContaining({ result: { status: "cancelled" } }),
    "*",
  );
  f.send();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.reply).toHaveBeenLastCalledWith(
    expect.objectContaining({ result: { error: "ArtifactCooldown" } }),
    "*",
  );
});
it("rechecks context before picker and reports uncertain failure without retry or browser fallback", async () => {
  const f = setup();
  f.send();
  f.api.mockRejectedValueOnce("ArtifactPublishedUnconfirmed");
  fireEvent.click(screen.getByRole("button", { name: "保存先を選ぶ" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("自動で再試行せず"));
  expect(screen.getByRole("button", { name: "保存先を選ぶ" }).hasAttribute("disabled")).toBe(true);
  expect(f.api).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
});
it("rejects a changed Native request/token/revision immediately before explicit confirmation", () => {
  const f = setup();
  f.send();
  f.derive.mockReturnValue({ ...context, request: 3 });
  fireEvent.click(screen.getByRole("button", { name: "保存先を選ぶ" }));
  expect(f.api).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("文書が変わった");
});

it("rejects hidden/current-context/bounded-data proposals and cancels source changes before confirmation", () => {
  const f = setup();
  f.frame.closest("section")!.hidden = true;
  f.send();
  expect(screen.queryByRole("dialog")).toBeNull();
  f.frame.closest("section")!.hidden = false;
  f.send({}, { source: window });
  expect(screen.queryByRole("dialog")).toBeNull();
  f.send({ format: "svg" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.reply).toHaveBeenLastCalledWith(
    expect.objectContaining({ result: { error: "ArtifactTooLargeOrInvalid" } }),
    "*",
  );
  expect(f.api).not.toHaveBeenCalled();
});
it("cancels a pending proposal when a render exposes changed Native source context", () => {
  const f = setup();
  f.send();
  f.derive.mockReturnValue({ ...context, revision: 4 });
  f.view.rerender(f.tree({ ...f.state, snapshot: { ...f.state.snapshot, revision: 4 } }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.api).not.toHaveBeenCalled();
  expect(f.reply).toHaveBeenLastCalledWith(
    expect.objectContaining({ result: { error: "ArtifactSourceChanged" } }),
    "*",
  );
});

it("normalizes unknown post-dispatch transport failure to an uncertain result in both main and HTML without leaking diagnostics", async () => {
  const f = setup();
  f.send();
  f.api.mockRejectedValueOnce(new Error("reply lost after publish at /private/report.txt"));
  fireEvent.click(screen.getByRole("button", { name: "保存先を選ぶ" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("選んだ保存先を確認"),
  );
  expect(screen.getByRole("alert").textContent).not.toContain("/private");
  expect(f.reply).toHaveBeenLastCalledWith(
    expect.objectContaining({ result: { error: "ArtifactResultUnknown" } }),
    "*",
  );
  expect(screen.getByRole("button", { name: "保存先を選ぶ" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "保存先を選ぶ" }));
  expect(f.api).toHaveBeenCalledTimes(1);
});
