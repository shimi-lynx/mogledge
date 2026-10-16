import { fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import { DocumentViewer } from "./DocumentViewer";
it("shows the decorative D2 welcome image only while no document is selected", () => {
  const view = render(<DocumentViewer url={null} loading={false} />);
  expect(view.container.querySelector(".welcome-symbol")?.tagName).toBe("IMG");
  expect(view.container.querySelector(".welcome-symbol")?.getAttribute("alt")).toBe("");
  expect(view.container.querySelector("iframe")).toBeNull();
  view.rerender(<DocumentViewer url="http://127.0.0.1/s/one/index.html" loading={false} />);
  expect(view.container.querySelector(".welcome-symbol")).toBeNull();
  expect(view.container.querySelector("iframe")).not.toBeNull();
});
it("remounts the isolated frame on every URL change", () => {
  const view = render(<DocumentViewer url="http://127.0.0.1/s/one/index.html" loading={false} />);
  const initial = view.container.querySelector("iframe")!;
  expect(initial.getAttribute("sandbox")).toBe("allow-scripts");
  expect(initial.getAttribute("referrerpolicy")).toBe("no-referrer");
  view.rerender(<DocumentViewer url="http://127.0.0.1/s/two/index.html" loading={false} />);
  expect(view.container.querySelector("iframe")).not.toBe(initial);
});
it("retains the browsing context and restores current zoom before load/fragment navigation", () => {
  const token = "a".repeat(64);
  const url = `http://127.0.0.1/s/${token}/index.html`;
  const view = render(<DocumentViewer url={url} loading={false} />);
  const frame = view.container.querySelector("iframe")!;
  const send = vi.spyOn(frame.contentWindow!, "postMessage");
  view.rerender(
    <DocumentViewer url={url} loading={false} zoom={113.7} zoomAnchor={{ x: 0.2, y: 0.8 }} />,
  );
  expect(view.container.querySelector("iframe")).toBe(frame);
  expect(frame.style.transform).toBe("");
  expect(send).toHaveBeenLastCalledWith(
    {
      type: "mogledge-document-zoom-render-v1",
      token,
      zoom: 113.7,
      anchor: { x: 0.2, y: 0.8 },
    },
    "*",
  );
  fireEvent.load(frame);
  expect(send).toHaveBeenLastCalledWith(
    { type: "mogledge-document-zoom-render-v1", token, zoom: 113.7, anchor: null },
    "*",
  );
  send.mockClear();
  view.rerender(
    <DocumentViewer
      url={url}
      loading={false}
      zoom={113.7}
      zoomAnchor={{ x: 0.2, y: 0.8 }}
      navigation={{ fragment: "section", request: 1 }}
    />,
  );
  expect(send.mock.calls.slice(-2)).toEqual([
    [{ type: "mogledge-document-zoom-render-v1", token, zoom: 113.7, anchor: null }, "*"],
    [{ type: "mogledge-anchor-v1", token, fragment: "section", request: 1 }, "*"],
  ]);
  view.rerender(<DocumentViewer url={url} loading={false} zoom={100} zoomRequest={1} />);
  send.mockClear();
  view.rerender(<DocumentViewer url={url} loading={false} zoom={100} zoomRequest={2} />);
  expect(send).toHaveBeenCalledExactlyOnceWith(
    { type: "mogledge-document-zoom-render-v1", token, zoom: 100, anchor: null },
    "*",
  );
});
