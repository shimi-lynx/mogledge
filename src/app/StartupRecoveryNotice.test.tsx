import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { setLanguage } from "../lib/i18n";
import { StartupRecoveryNotice } from "./StartupRecoveryNotice";

afterEach(cleanup);
test("failed recovery restores idle focus without stealing it from another control", () => {
  const props = {
    recovery: { reason: "pathUnavailable" as const, canRetry: true },
    onRetry: vi.fn(),
    onChoose: vi.fn(),
  };
  const { rerender } = render(<StartupRecoveryNotice {...props} loading={false} />);
  const retry = screen.getAllByRole("button")[0];
  retry.focus();
  fireEvent.click(retry);
  rerender(<StartupRecoveryNotice {...props} loading={true} />);
  retry.blur();
  rerender(<StartupRecoveryNotice {...props} loading={false} />);
  expect(document.activeElement).toBe(retry);

  fireEvent.click(retry);
  rerender(<StartupRecoveryNotice {...props} loading={true} />);
  const other = document.createElement("button");
  document.body.append(other);
  other.focus();
  rerender(<StartupRecoveryNotice {...props} loading={false} />);
  expect(document.activeElement).toBe(other);
  other.remove();
});
test("root recovery is a nonmodal reason with explicit retry/select and live language", () => {
  const retry = vi.fn(),
    choose = vi.fn();
  const { rerender } = render(
    <StartupRecoveryNotice
      recovery={{ reason: "pathUnavailable", canRetry: true }}
      loading={false}
      onRetry={retry}
      onChoose={choose}
    />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("ドライブ接続");
  expect(retry).not.toHaveBeenCalled();
  const button = screen.getByRole("button", { name: "保存フォルダーを再試行" });
  button.focus();
  act(() => {
    setLanguage("en");
  });
  expect(document.activeElement).toBe(button);
  expect(screen.getByRole("status").textContent).toContain("drive connection");
  fireEvent.click(screen.getByRole("button", { name: "Retry saved folder" }));
  expect(retry).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Select another folder" }));
  expect(choose).toHaveBeenCalledOnce();
  rerender(
    <StartupRecoveryNotice
      recovery={{ reason: "pathUnavailable", canRetry: true }}
      loading={true}
      onRetry={retry}
      onChoose={choose}
    />,
  );
  expect(screen.getByRole("button", { name: "Retry saved folder" }).hasAttribute("disabled")).toBe(
    true,
  );
});
test("legacy requires manual confirmation; unknown offline errors are not labeled missing", () => {
  act(() => {
    setLanguage("en");
  });
  const { rerender } = render(
    <StartupRecoveryNotice
      recovery={{ reason: "confirmationRequired", canRetry: false }}
      loading={false}
      onRetry={vi.fn()}
      onChoose={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("Confirm");
  expect(screen.queryByRole("button", { name: "Retry saved folder" })).toBeNull();
  rerender(
    <StartupRecoveryNotice
      recovery={{ reason: "unavailable", canRetry: true }}
      loading={false}
      onRetry={vi.fn()}
      onChoose={vi.fn()}
    />,
  );
  expect(screen.getByRole("status").textContent).not.toMatch(/missing|deleted|not found/i);
});
