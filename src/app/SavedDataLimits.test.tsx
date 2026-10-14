import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { setLanguage } from "../lib/i18n";
import {
  LIMITS_RESPONSE_DEADLINE_MS,
  StorageLimitsSession,
  type LimitsApi,
  type LimitsSnapshot,
} from "../lib/storageLimits";
import { limitsContext, limitsFixture, limitsFixtureApi } from "../lib/storageLimits.test-fixtures";
import { SavedDataLimits } from "./SavedDataLimits";
beforeEach(() => setLanguage("en"));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLanguage("ja");
});
test("read-only initial values and defaults/cancel require explicit edits and never save", async () => {
  const api = limitsFixtureApi(),
    session = new StorageLimitsSession(api);
  render(<SavedDataLimits context={limitsContext} session={session} />);
  await screen.findByText("5.243 MB per document · 536.871 MB total");
  expect(screen.getByText(/Summary capacities are rounded to three decimal places/)).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit storage limits" }));
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Document limit" }).value).toBe(
    "5.24288",
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Apply storage limits" }).disabled,
  ).toBe(true);
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Document limit" }), {
    target: { value: "8.388608" },
  });
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Apply storage limits" }).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Fill in defaults" }));
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel limit edits" }));
  expect(api.set).not.toHaveBeenCalled();
});
test("values outside whole-MiB precision are rejected; acknowledgement precedes an immediate apply without a restart notice", async () => {
  const api = limitsFixtureApi(),
    session = new StorageLimitsSession(api);
  render(<SavedDataLimits context={limitsContext} session={session} />);
  await screen.findByText("5.243 MB per document · 536.871 MB total");
  fireEvent.click(screen.getByRole("button", { name: "Edit storage limits" }));
  const document = screen.getByRole("textbox", { name: "Document limit" });
  fireEvent.change(document, { target: { value: "1.5" } });
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Apply storage limits" }).disabled,
  ).toBe(true);
  fireEvent.change(document, { target: { value: "8.388608" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Apply storage limits" }));
  await screen.findByText("Storage limits applied. They take effect for the next save.");
  expect(api.set).toHaveBeenCalledOnce();
  expect(screen.queryByText(/Restart the app/)).toBeNull();
});
test("large limits show technical capacities separately, stay editable, and old-table format updates require acknowledgement", async () => {
  const api = limitsFixtureApi();
  api.get = vi.fn(async () => ({ ...limitsFixture, revision: 3 }));
  const session = new StorageLimitsSession(api);
  render(<SavedDataLimits context={limitsContext} session={session} />);
  await screen.findByText("5.243 MB per document · 536.871 MB total");
  expect(screen.getByText("Technical document capacity")).toBeTruthy();
  expect(screen.getAllByText("1 GB")).toHaveLength(2);
  expect(screen.getByText("Technical database capacity")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit storage limits" }));
  const document = screen.getByRole("textbox", { name: "Document limit" });
  const total = screen.getByRole("textbox", { name: "Total limit" });
  expect(document.getAttribute("max")).toBeNull();
  expect(total.getAttribute("max")).toBeNull();
  fireEvent.change(document, { target: { value: "2147.483648" } });
  fireEvent.change(total, { target: { value: "20971520" } });
  expect(screen.getByText(/Larger limits may require more memory/)).toBeTruthy();
  expect(
    screen.getByText(/Your limits exceed a technical document or database capacity/),
  ).toBeTruthy();
  const apply = screen.getByRole<HTMLButtonElement>("button", { name: "Apply storage limits" });
  expect(apply.disabled).toBe(true);
  const acknowledgement = screen.getByRole("checkbox", { name: /Updating the saved format/ });
  fireEvent.click(acknowledgement);
  expect(apply.disabled).toBe(false);
  fireEvent.click(apply);
  await screen.findByText("Storage limits applied. They take effect for the next save.");
  expect(
    screen.getByText(/Your limits exceed a technical document or database capacity/),
  ).toBeTruthy();
  expect(api.set).toHaveBeenCalledExactlyOnceWith({
    context: limitsContext,
    expectedRevision: 3,
    expectedGeneration: 7,
    documentMiB: 2048,
    totalMiB: 20000000,
    acknowledgeCompatibility: true,
  });
});
test("closing and reopening unknown outcomes keeps draft, hides private diagnostics, and permits get only", async () => {
  const api = limitsFixtureApi();
  api.set = vi.fn(async () => {
    throw { code: "/private/transport.db" };
  });
  const session = new StorageLimitsSession(api);
  const first = render(<SavedDataLimits context={limitsContext} session={session} />);
  await screen.findByText("5.243 MB per document · 536.871 MB total");
  fireEvent.click(screen.getByRole("button", { name: "Edit storage limits" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Document limit" }), {
    target: { value: "8.388608" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Apply storage limits" }));
  await screen.findByText(/The limit-change outcome is unknown/);
  first.unmount();
  const second = render(<SavedDataLimits context={limitsContext} session={session} />);
  expect(second.container.textContent).not.toContain("/private/");
  expect(api.get).toHaveBeenCalledOnce();
  expect(api.set).toHaveBeenCalledOnce();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Apply storage limits" }).disabled,
  ).toBe(true);
  api.get = vi.fn(async () => ({
    ...limitsFixture,
    documentMiB: 8,
    revision: 1,
    generation: 8,
    requiresCompatibilityAcknowledgement: false,
  }));
  fireEvent.click(screen.getByRole("button", { name: "Check effective limits" }));
  await screen.findByText(
    "Current effective limits checked. This does not prove that a past change request completed.",
  );
  expect(api.set).toHaveBeenCalledOnce();
  setLanguage("ja");
  await screen.findByText("保存入力の容量上限");
  expect(api.get).toHaveBeenCalledOnce();
});
test("pending requests survive page closure without a duplicate read or save", async () => {
  const api = limitsFixtureApi();
  let reply!: (value: LimitsSnapshot) => void;
  api.set = vi.fn<LimitsApi["set"]>(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const session = new StorageLimitsSession(api);
  const first = render(<SavedDataLimits context={limitsContext} session={session} />);
  await screen.findByText("5.243 MB per document · 536.871 MB total");
  fireEvent.click(screen.getByRole("button", { name: "Edit storage limits" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Document limit" }), {
    target: { value: "8.388608" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Apply storage limits" }));
  await waitFor(() => expect(api.set).toHaveBeenCalledOnce());
  first.unmount();
  render(<SavedDataLimits context={limitsContext} session={session} />);
  expect(api.get).toHaveBeenCalledOnce();
  expect(api.set).toHaveBeenCalledOnce();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Apply storage limits" }).disabled,
  ).toBe(true);
  reply({
    ...limitsFixture,
    documentMiB: 8,
    revision: 1,
    generation: 8,
    requiresCompatibilityAcknowledgement: false,
  });
  await screen.findByText("Storage limits applied. They take effect for the next save.");
  expect(api.set).toHaveBeenCalledOnce();
});
test("deadline outcomes survive reopening and explicit get reports current values without proving the old save", async () => {
  const api = limitsFixtureApi();
  let reply!: (value: LimitsSnapshot) => void;
  api.set = vi.fn<LimitsApi["set"]>(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  const session = new StorageLimitsSession(api);
  const first = render(<SavedDataLimits context={limitsContext} session={session} />);
  await screen.findByText("5.243 MB per document · 536.871 MB total");
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Edit storage limits" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Document limit" }), {
    target: { value: "8.388608" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Apply storage limits" }));
  await act(() => vi.advanceTimersByTimeAsync(LIMITS_RESPONSE_DEADLINE_MS));
  expect(screen.getByText(/The limit-change outcome is unknown/)).toBeTruthy();
  first.unmount();
  render(<SavedDataLimits context={limitsContext} session={session} />);
  expect(api.set).toHaveBeenCalledOnce();
  expect(api.get).toHaveBeenCalledOnce();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Apply storage limits" }).disabled,
  ).toBe(true);
  api.get = vi.fn(async () => ({
    ...limitsFixture,
    documentMiB: 6,
    revision: 2,
    generation: 9,
    requiresCompatibilityAcknowledgement: false,
  }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check effective limits" }));
  });
  expect(
    screen.getByText(
      "Current effective limits checked. This does not prove that a past change request completed.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("6.291 MB per document · 536.871 MB total")).toBeTruthy();
  await act(async () => {
    reply({ ...limitsFixture, documentMiB: 8, revision: 1, generation: 8 });
  });
  expect(
    screen.queryByText("Storage limits applied. They take effect for the next save."),
  ).toBeNull();
  expect(screen.getByText("6.291 MB per document · 536.871 MB total")).toBeTruthy();
  expect(api.set).toHaveBeenCalledOnce();
});
