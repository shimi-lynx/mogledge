import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ManagedFoldersPanel } from "./ManagedFoldersPanel";
import { setLanguage } from "../lib/i18n";
import type { Bridge, ManagedFolders } from "../lib/types";

beforeEach(() => setLanguage("en"));
afterEach(cleanup);
const initial: ManagedFolders = {
  revision: "one",
  selectedId: "a",
  folders: [
    { id: "a", name: "Tools", path: "/tools", status: "ready", kitUpdate: "current", error: null },
    {
      id: "b",
      name: "Moved",
      path: "/moved",
      status: "missing",
      kitUpdate: "current",
      error: null,
    },
  ],
};
function fixture() {
  const api = {
    getManagedFolders: vi.fn(async () => initial),
    createManagedFolder: vi.fn(async () => null as ManagedFolders | null),
    registerManagedFolder: vi.fn(async () => null as ManagedFolders | null),
  } as unknown as Bridge;
  const controller = {
    selectManagedFolder: vi.fn(async () => {}),
    unregisterManagedFolder: vi.fn(async () => ({
      ...initial,
      revision: "two",
      selectedId: null,
      folders: initial.folders.slice(1),
    })),
  };
  const onSelected = vi.fn();
  render(<ManagedFoldersPanel api={api} controller={controller} onSelected={onSelected} />);
  return { api, controller, onSelected };
}

test("creation and registration cancellation retain the list and name without selecting", async () => {
  const { api, controller, onSelected } = fixture();
  await screen.findByText("/tools");
  fireEvent.change(screen.getByRole("textbox", { name: "New folder name" }), {
    target: { value: " New tools " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Choose a location and create" }));
  await waitFor(() => expect(api.createManagedFolder).toHaveBeenCalledWith("New tools", "one"));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Register an existing folder" })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Register an existing folder" }));
  await waitFor(() => expect(api.registerManagedFolder).toHaveBeenCalledWith("one"));
  expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe(" New tools ");
  expect(screen.getByText("/tools")).toBeTruthy();
  expect(controller.selectManagedFolder).not.toHaveBeenCalled();
  expect(onSelected).not.toHaveBeenCalled();
});

test("setup failure remains open and never retries a read automatically", async () => {
  const { api, onSelected } = fixture();
  vi.mocked(api.registerManagedFolder!).mockRejectedValue("conflicting existing guide");
  await screen.findByText("/tools");
  fireEvent.click(screen.getByRole("button", { name: "Register an existing folder" }));
  expect((await screen.findByRole("alert")).textContent).toContain("conflicting existing guide");
  expect(api.getManagedFolders).toHaveBeenCalledOnce();
  expect(screen.getByText("/tools")).toBeTruthy();
  expect(onSelected).not.toHaveBeenCalled();
});

test("missing folders cannot be selected; ready folders use the controller and captured revision", async () => {
  const { controller, onSelected } = fixture();
  const moved = (await screen.findByText("/moved")).closest("li")!;
  expect(
    within(moved).getByRole<HTMLButtonElement>("button", { name: "Open this folder" }).disabled,
  ).toBe(true);
  expect(moved.textContent).toContain("Register an existing folder");
  fireEvent.click(screen.getAllByRole("button", { name: "Open this folder" })[0]!);
  await waitFor(() => expect(controller.selectManagedFolder).toHaveBeenCalledWith("a", "one"));
  await waitFor(() => expect(onSelected).toHaveBeenCalledOnce());
});

test("unregister requires its explicit confirmation and retains data wording", async () => {
  const { controller } = fixture();
  await screen.findByText("/tools");
  fireEvent.click(screen.getAllByRole("button", { name: "Unregister" })[0]!);
  expect(screen.getByText(/HTML files and saved data are all retained/)).toBeTruthy();
  expect(controller.unregisterManagedFolder).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(controller.unregisterManagedFolder).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Unregister" })[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Remove this registration" }));
  await waitFor(() => expect(controller.unregisterManagedFolder).toHaveBeenCalledWith("a", "one"));
  await waitFor(() => expect(screen.queryByText("/tools")).toBeNull());
  expect(screen.getByText("/moved")).toBeTruthy();
});
