import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { LANGUAGE_STORAGE_KEY, getLanguage, setLanguage } from "../lib/i18n";
import { LanguagePicker } from "./LanguagePicker";
beforeEach(() => setLanguage("en"));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage("ja");
  localStorage.removeItem(LANGUAGE_STORAGE_KEY);
});

test("native language select keeps both language names recognizable and changes its accessible label immediately", () => {
  render(<LanguagePicker />);
  const select = screen.getByRole("combobox", { name: "Choose display language" });
  expect(screen.getByRole("option", { name: "日本語" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
  select.focus();
  fireEvent.change(select, { target: { value: "ja" } });
  expect(screen.getByRole("combobox", { name: "表示言語を選択" })).toBe(select);
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("ja");
  fireEvent.change(select, { target: { value: "en" } });
  expect(screen.getByRole("combobox", { name: "Choose display language" })).toBe(select);
  expect(document.activeElement).toBe(select);
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
  expect(screen.queryByRole("status")).toBeNull();
});

test("storage denial preserves the immediate selection and announces the localized session-only warning, then recovers", async () => {
  setLanguage("ja");
  render(<LanguagePicker />);
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage denied");
  });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "en" } });
  expect(getLanguage()).toBe("en");
  expect(screen.getByRole("status").textContent).toContain("could not be saved");
  const select = screen.getByRole("combobox", { name: "Choose display language" });
  expect(select.getAttribute("aria-describedby")).toBe("language-preference-warning");
  expect(select.title).toContain("for this session");
  save.mockRestore();
  await act(() => setLanguage("en"));
  expect(screen.queryByRole("status")).toBeNull();
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
});
