import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ManagementSession } from "../lib/stateManagement";
import { setLanguage } from "../lib/i18n";
import { context, fixtureApi, page, plan, receipt } from "../lib/stateManagement.test-fixtures";
import { SavedDataSettings } from "./SavedDataSettings";
beforeEach(() => setLanguage("en"));
afterEach(() => {
  cleanup();
  setLanguage("ja");
});
test("bounded inspection starts with nothing selected and renders untrusted names as text", async () => {
  const api = fixtureApi();
  const session = new ManagementSession(api);
  const { container } = render(<SavedDataSettings context={context} session={session} />);
  await screen.findByText(page.entries[0].relativePath!);
  expect(container.querySelectorAll("img")).toHaveLength(0);
  for (const radio of screen.getAllByRole<HTMLInputElement>("radio"))
    expect(radio.checked).toBe(false);
  expect(
    screen.getByRole<HTMLInputElement>("radio", { name: "Source location is unverified" }).disabled,
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Review impact on the selected record" })
      .disabled,
  ).toBe(true);
  expect(screen.getAllByText("Last used: unknown (not collected)")).toHaveLength(2);
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.confirm).not.toHaveBeenCalled();
});
test("explicit record choice and impact acknowledgement precede quarantine", async () => {
  const api = fixtureApi();
  const session = new ManagementSession(api);
  render(<SavedDataSettings context={context} session={session} />);
  fireEvent.click(await screen.findByRole("radio", { name: page.entries[0].relativePath! }));
  fireEvent.click(screen.getByRole("button", { name: "Review impact on the selected record" }));
  await screen.findByText("Selected committed input: 2 appIds, 80 bytes");
  expect(api.prepare).toHaveBeenCalledWith({
    context,
    operation: "quarantine",
    candidateId: plan.candidateId,
    snapshotId: "snapshot",
  });
  const confirm = screen.getByRole<HTMLButtonElement>("button", {
    name: "Run the reviewed operation",
  });
  expect(confirm.disabled).toBe(true);
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I reviewed the target, input impact, restoration conditions and backup",
    }),
  );
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await screen.findByText("The reviewed operation completed");
  expect(api.confirm).toHaveBeenCalledExactlyOnceWith({
    context,
    planId: "plan",
    confirmation: "plan",
  });
});
test("lost responses survive page closure without retry and require explicit verification", async () => {
  const api = fixtureApi();
  api.confirm = vi.fn(async () => {
    throw "lost-response";
  });
  const session = new ManagementSession(api);
  const first = render(<SavedDataSettings context={context} session={session} />);
  fireEvent.click(await screen.findByRole("radio", { name: page.entries[0].relativePath! }));
  fireEvent.click(screen.getByRole("button", { name: "Review impact on the selected record" }));
  await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Run the reviewed operation" }));
  await screen.findByRole("button", { name: "Check operation result" });
  first.unmount();
  render(<SavedDataSettings context={context} session={session} />);
  expect(api.confirm).toHaveBeenCalledOnce();
  expect(api.verify).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check operation result" }));
  await screen.findByText("The reviewed operation completed");
  expect(api.verify).toHaveBeenCalledExactlyOnceWith(context, receipt.operationId);
});
test("language changes preserve selection and plan without another inspection", async () => {
  const api = fixtureApi();
  const session = new ManagementSession(api);
  render(<SavedDataSettings context={context} session={session} />);
  fireEvent.click(await screen.findByRole("radio", { name: page.entries[0].relativePath! }));
  fireEvent.click(screen.getByRole("button", { name: "Review impact on the selected record" }));
  await screen.findByRole("checkbox");
  setLanguage("ja");
  await waitFor(() => expect(screen.getByText("選択した保存済み入力を隔離")).toBeTruthy());
  expect(session.getSnapshot().plan?.planId).toBe("plan");
  expect(api.list).toHaveBeenCalledOnce();
});
test.each([
  "/private/transport/internal/state.db: failed to receive response",
  { code: "/private/transport/internal/state.db", message: "internal response detail" },
])(
  "unknown transport diagnostics stay private and never retry confirmation (%j)",
  async (error) => {
    const api = fixtureApi();
    api.confirm = vi.fn(async () => {
      throw error;
    });
    const session = new ManagementSession(api);
    const { container } = render(<SavedDataSettings context={context} session={session} />);
    fireEvent.click(await screen.findByRole("radio", { name: page.entries[0].relativePath! }));
    fireEvent.click(screen.getByRole("button", { name: "Review impact on the selected record" }));
    await screen.findByRole("checkbox");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Run the reviewed operation" }));
    await screen.findByRole("button", { name: "Check operation result" });
    expect(session.getSnapshot().phase).toBe("unknown");
    expect(session.getSnapshot().error).toBe("saved_state_unavailable");
    expect(container.textContent).not.toContain("/private/");
    expect(container.textContent).not.toContain("internal response detail");
    expect(screen.queryByText("The reviewed operation completed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Run the reviewed operation" })).toBeNull();
    expect(api.confirm).toHaveBeenCalledOnce();
    expect(api.verify).not.toHaveBeenCalled();
    api.verify = vi.fn(async () => ({ status: "unknown" as const, currentSchemaVersion: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "Check operation result" }));
    await waitFor(() => expect(api.verify).toHaveBeenCalledOnce());
    expect(session.getSnapshot().phase).toBe("unknown");
    expect(api.confirm).toHaveBeenCalledOnce();
  },
);
