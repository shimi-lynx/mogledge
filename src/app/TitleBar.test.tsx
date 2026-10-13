import { createRef } from "react";
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { KnowledgeController } from "../lib/controller";
import type { Bridge } from "../lib/types";
import { TitleBar } from "./TitleBar";
import { setLanguage } from "../lib/i18n";

vi.mock("../features/document-viewer/TabStrip", () => ({ TabStrip: () => null }));
beforeEach(() => setLanguage("ja"));
afterEach(cleanup);

test("places help last in the app toolbar and leaves language selection to settings", () => {
  // No controller operation is invoked; only its initial snapshot is used.
  const controller = new KnowledgeController({} as Bridge);
  const view = render(
    <TitleBar
      chrome={{ platform: "other", height: 40, leftInset: 0, rightInset: 0 }}
      sidebarVisible
      sidebarWidth={230}
      sidebarView="files"
      state={controller.getSnapshot()}
      controller={controller}
      menuButton={createRef()}
      searchButton={createRef()}
      helpButton={createRef()}
      onToggle={vi.fn()}
      onFiles={vi.fn()}
      onSearch={vi.fn()}
      onHelp={vi.fn()}
      onEmpty={vi.fn()}
      onWorkspaceLists={vi.fn()}
    />,
  );
  const navigation = view.getByRole("navigation", { name: "左メニューの表示" });
  expect(within(navigation).getAllByRole("button").at(-1)?.getAttribute("aria-label")).toBe(
    "機能と使い方",
  );
  expect(view.queryByRole("combobox")).toBeNull();
  expect(within(navigation).getByRole("button", { name: "作業セット" })).toBeTruthy();
  expect(view.container.querySelector(".titlebar")?.textContent).not.toContain("Mogledge");
});
