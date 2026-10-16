import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { KnowledgeController } from "../../lib/controller";
import type { Bridge, Snapshot } from "../../lib/types";
import { DocumentDeck } from "./DocumentDeck";

afterEach(cleanup);
it.each(
  ["mogledge", "my-knowledge"].flatMap((prefix) => [
    [prefix, "document-ready-v1"],
    [prefix, "storage-request-v1"],
  ]),
)(
  "%s %s messages require the current opaque source, exact shape, token and URL",
  async (prefix, kind) => {
    const token = "a".repeat(64);
    const url = `http://127.0.0.1:1234/s/${token}/a.html`;
    const snapshot: Snapshot = {
      workspaceId: "root",
      viewId: "view",
      rootPath: "/fixture",
      revision: 1,
      watchError: null,
      nodes: [{ relativePath: "a.html", name: "a.html", kind: "html", children: [] }],
    };
    const api: Bridge = {
      beginView: async () => snapshot,
      getTree: async () => snapshot,
      chooseRoot: async () => snapshot,
      refresh: async () => snapshot,
      createTab: async () => "native",
      closeTab: async () => {},
      openDocument: async () => url,
      listen: async () => () => {},
      performFileAction: async () => {},
      mutateTree: async () => ({ snapshot, moves: [], warning: null }),
    };
    const controller = new KnowledgeController(api);
    await controller.start();
    await controller.select("a.html");
    const ready = vi.spyOn(
      controller,
      kind === "storage-request-v1" ? "documentStorageRequested" : "documentReady",
    );
    const view = render(<DocumentDeck state={controller.getSnapshot()} controller={controller} />);
    const frame = view.container.querySelector("iframe")!;
    const data = { type: `${prefix}-${kind}`, token };
    const send = (value: unknown, origin = "null", source = frame.contentWindow) =>
      window.dispatchEvent(new MessageEvent("message", { data: value, origin, source }));
    send(data, "http://127.0.0.1:1234");
    send(data, "null", window);
    send({ ...data, token: "b".repeat(64) });
    send({ ...data, extra: "unexpected" });
    send([data]);
    expect(ready).not.toHaveBeenCalled();
    send(data);
    expect(ready).toHaveBeenCalledExactlyOnceWith(controller.getSnapshot().tabs[0].id, url);
    frame.src = "http://127.0.0.1:1234/s/obsolete/a.html";
    send(data);
    expect(ready).toHaveBeenCalledTimes(1);
    controller.stop();
  },
);
