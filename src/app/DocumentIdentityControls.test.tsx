import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DocumentIdentityControls } from "./DocumentIdentityControls";
import { setLanguage } from "../lib/i18n";
import type { Bridge, DocumentIdentityStatus } from "../lib/types";

beforeEach(() => setLanguage("en"));
afterEach(cleanup);
function fixture(status: DocumentIdentityStatus["status"], canAssign = true) {
  const api = {
    getDocumentIdentityStatus: vi.fn(async () => ({
      status,
      uuid: status === "missing" || status === "legacyConflict" ? null : "document-uuid",
      canAssign,
      canShare: true,
      legacyCandidates: [{ id: "legacy-one", path: "old/tool.html", revision: 4, appCount: 2 }],
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
      undefined,
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
      undefined,
    ),
  );
});

test("legacy conflict has no default recovery record", async () => {
  const { api } = fixture("legacyConflict");
  fireEvent.click(screen.getByRole("button", { name: "Review document ID" }));
  const recover = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Recover the selected saved data",
  });
  expect(recover.disabled).toBe(true);
  expect(api.configureDocumentIdentity).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "legacy-one" } });
  fireEvent.click(recover);
  await waitFor(() =>
    expect(api.configureDocumentIdentity).toHaveBeenCalledWith(
      "workspace",
      "view",
      "tool.html",
      "recover",
      "legacy-one",
    ),
  );
});

test.each([true, false])(
  "legacy conflict offers a fresh identity only when canAssign is %s",
  async (canAssign) => {
    const { api, onConfigured } = fixture("legacyConflict", canAssign);
    fireEvent.click(screen.getByRole("button", { name: "Review document ID" }));
    const recover = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Recover the selected saved data",
    });
    expect(recover.disabled).toBe(true);
    expect(screen.getByRole<HTMLSelectElement>("combobox").value).toBe("");
    expect(api.configureDocumentIdentity).not.toHaveBeenCalled();
    const createNew = screen.queryByRole("button", {
      name: "Use a new ID for a separate document",
    });
    if (!canAssign) {
      expect(createNew).toBeNull();
      return;
    }
    expect(createNew).not.toBeNull();
    fireEvent.click(createNew!);
    await waitFor(() =>
      expect(api.configureDocumentIdentity).toHaveBeenCalledWith(
        "workspace",
        "view",
        "tool.html",
        "new",
        undefined,
      ),
    );
    await waitFor(() => expect(onConfigured).toHaveBeenCalledOnce());
  },
);

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
