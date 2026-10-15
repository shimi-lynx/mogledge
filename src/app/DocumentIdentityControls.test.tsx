import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DocumentIdentityControls } from "./DocumentIdentityControls";
import { setLanguage } from "../lib/i18n";
import type { Bridge, DocumentIdentityStatus } from "../lib/types";

beforeEach(() => setLanguage("en"));
afterEach(cleanup);
function fixture(status: DocumentIdentityStatus["status"], canAssign = true, canShare = true) {
  const api = {
    getDocumentIdentityStatus: vi.fn(async () => ({
      status,
      uuid: status === "missing" ? null : "document-uuid",
      canAssign,
      canShare,
    })),
    configureDocumentIdentity: vi.fn(async () => {}),
  } as unknown as Bridge;
  const onConfigured = vi.fn(async () => {});
  render(
    <DocumentIdentityControls
      api={api}
      workspaceId="workspace"
      viewId="view"
      relativePath="tool.html"
      onConfigured={onConfigured}
    />,
  );
  return { api, onConfigured };
}

test("missing identity is only written by an explicit add action and then reloads", async () => {
  const { api, onConfigured } = fixture("missing");
  expect(api.getDocumentIdentityStatus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review document ID" }));
  const add = await screen.findByRole("button", { name: "Add a document ID to HTML" });
  expect(api.configureDocumentIdentity).not.toHaveBeenCalled();
  fireEvent.click(add);
  await waitFor(() =>
    expect(api.configureDocumentIdentity).toHaveBeenCalledWith(
      "workspace",
      "view",
      "tool.html",
      "add",
    ),
  );
  await waitFor(() => expect(onConfigured).toHaveBeenCalledOnce());
});

test.each([
  ["Use a new ID for a separate document", "new"],
  ["Share saved data with the same ID", "share"],
])("duplicate identity supports explicit %s", async (label, action) => {
  const { api } = fixture("duplicate");
  fireEvent.click(screen.getByRole("button", { name: "Review document ID" }));
  fireEvent.click(await screen.findByRole("button", { name: label }));
  await waitFor(() =>
    expect(api.configureDocumentIdentity).toHaveBeenCalledWith(
      "workspace",
      "view",
      "tool.html",
      action,
    ),
  );
});

test("ready identity only reloads after review and never offers legacy recovery", async () => {
  const { api, onConfigured } = fixture("ready");
  expect(api.getDocumentIdentityStatus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review document ID" }));
  const reload = await screen.findByRole("button", { name: "Reload document" });
  expect(api.getDocumentIdentityStatus).toHaveBeenCalledWith("workspace", "view", "tool.html");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("button", { name: /Recover/ })).toBeNull();
  expect(api.configureDocumentIdentity).not.toHaveBeenCalled();
  expect(onConfigured).not.toHaveBeenCalled();
  fireEvent.click(reload);
  await waitFor(() => expect(onConfigured).toHaveBeenCalledOnce());
  expect(api.configureDocumentIdentity).not.toHaveBeenCalled();
});

test("read-only duplicate identities do not offer assignment or sharing", async () => {
  const { api } = fixture("duplicate", false, false);
  fireEvent.click(screen.getByRole("button", { name: "Review document ID" }));
  await screen.findByText(/Another HTML file has the same document ID/);
  expect(screen.queryByRole("button", { name: "Use a new ID for a separate document" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Share saved data with the same ID" })).toBeNull();
  expect(api.configureDocumentIdentity).not.toHaveBeenCalled();
});

test("failed configuration preserves the controls and never reloads", async () => {
  const { api, onConfigured } = fixture("missing");
  vi.mocked(api.configureDocumentIdentity!).mockRejectedValue("HTML is read-only");
  fireEvent.click(screen.getByRole("button", { name: "Review document ID" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add a document ID to HTML" }));
  expect((await screen.findByRole("alert")).textContent).toBe("HTML is read-only");
  expect(screen.getByRole("button", { name: "Add a document ID to HTML" })).toBeTruthy();
  expect(onConfigured).not.toHaveBeenCalled();
});

test("invalid identity cannot be assigned or shared through the controls", async () => {
  const { api } = fixture("invalid");
  fireEvent.click(screen.getByRole("button", { name: "Review document ID" }));
  await screen.findByText(/Correct the ID in the HTML/);
  expect(screen.queryByRole("button", { name: "Add a document ID to HTML" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Share saved data with the same ID" })).toBeNull();
  expect(api.configureDocumentIdentity).not.toHaveBeenCalled();
});
