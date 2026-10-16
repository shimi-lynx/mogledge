import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { nextSearchPageOffset, SearchPanel } from "./SearchPanel";
import type { IndexStatus, SearchBridge, SearchHit, SearchPage } from "./types";
import type { TreeNode } from "../../lib/types";
import { SEARCH_PREFERENCES_KEY } from "./preferences";
import { setLanguage } from "../../lib/i18n";

function status(overrides: Partial<IndexStatus> = {}): IndexStatus {
  return {
    workspaceId: "workspace-a",
    rootId: "root-a",
    phase: "ready",
    generation: 1,
    requestRevision: 1,
    indexed: 1,
    pending: 0,
    unavailable: 0,
    failed: 0,
    truncated: 0,
    databaseBytes: 8_192,
    complete: true,
    limited: false,
    rebuilt: false,
    error: null,
    ...overrides,
  };
}

function hit(id = "document-a", title = "検索した文書"): SearchHit {
  return {
    documentId: id,
    relativePath: `${id}.html`,
    title,
    snippet: "日本語の本文",
    titleMatches: [],
    snippetMatches: [],
    truncated: false,
  };
}

function page(overrides: Partial<SearchPage> = {}): SearchPage {
  return {
    generation: 1,
    requestRevision: 1,
    hits: [hit()],
    hasMore: false,
    normalizedQuery: "日本語",
    ...overrides,
  };
}

function createBridge() {
  return {
    getStatus: vi
      .fn<SearchBridge["getStatus"]>()
      .mockImplementation(async (workspaceId) => status({ workspaceId })),
    search: vi.fn<SearchBridge["search"]>().mockResolvedValue(page()),
    rebuild: vi.fn<SearchBridge["rebuild"]>().mockResolvedValue(status({ phase: "building" })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function type(value: string) {
  fireEvent.change(screen.getByRole("searchbox"), { target: { value } });
}

describe("SearchPanel", () => {
  beforeEach(() => {
    localStorage.removeItem("mogledge.search-preferences");
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    setLanguage("ja");
    vi.useRealTimers();
  });

  it("keeps details open across queries and cancel, coalesces settings writes, and resets conditions only", async () => {
    const bridge = createBridge();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} bridge={bridge} onSelect={vi.fn()} />,
    );
    await advance();
    const toggle = screen.getByRole("button", { name: "検索の詳細設定" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("radio")).toBeNull();
    for (let i = 0; i < 7; i++) fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("radio", { name: "OR（いずれかの語）" }));
    await advance(250);
    expect(writes.mock.calls.filter(([key]) => key === SEARCH_PREFERENCES_KEY)).toHaveLength(1);
    type("日本語");
    await advance(250);
    const saved = localStorage.getItem(SEARCH_PREFERENCES_KEY);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(
      (screen.getByRole("radio", { name: "OR（いずれかの語）" }) as HTMLInputElement).checked,
    ).toBe(true);
    type("別の語");
    await advance(250);
    expect(localStorage.getItem(SEARCH_PREFERENCES_KEY)).toBe(saved);
    fireEvent.click(screen.getByRole("button", { name: "検索条件をリセット" }));
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("別の語");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await advance(250);
    expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "別の語", 20, 0, "and");
    writes.mockRestore();
  });

  it("restores root-scoped settings before searching, keeps a new root clear, and resets a restored folder", async () => {
    localStorage.setItem(
      SEARCH_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        detailsOpen: true,
        mode: "or",
        roots: [{ rootId: "root-a", path: "資料/%_" }],
      }),
    );
    const nodes: TreeNode[] = [
      {
        kind: "folder",
        name: "資料",
        relativePath: "資料",
        children: [{ kind: "folder", name: "%_", relativePath: "資料/%_", children: [] }],
      },
    ];
    const bridge = createBridge();
    bridge.getStatus.mockImplementation(async (workspaceId) =>
      status({ workspaceId, rootId: workspaceId === "workspace-a" ? "root-a" : "root-b" }),
    );
    function Host({ workspaceId }: { workspaceId: string }) {
      const [selected, setSelected] = useState<{ workspace: string; path: string } | null>(null);
      const path = selected?.workspace === workspaceId ? selected.path : "";
      return (
        <SearchPanel
          workspaceId={workspaceId}
          viewId={workspaceId}
          revision={1}
          nodes={nodes}
          bridge={bridge}
          scope={path ? { relativePath: path, viewId: workspaceId } : undefined}
          onChangeScope={(path) => setSelected({ workspace: workspaceId, path })}
          onResetScope={() => setSelected(null)}
          onSelect={vi.fn()}
        />
      );
    }
    const view = render(<Host workspaceId="workspace-a" />);
    await advance();
    type("東京");
    await advance();
    await advance(500);
    expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "東京", 20, 0, "or", {
      relativePath: "資料/%_",
      viewId: "workspace-a",
    });
    expect(bridge.search.mock.calls.every((call) => call[5]?.relativePath === "資料/%_")).toBe(
      true,
    );
    view.rerender(<Host workspaceId="workspace-b" />);
    await advance();
    await advance(500);
    expect(bridge.search).toHaveBeenLastCalledWith("workspace-b", "東京", 20, 0, "or");
    view.rerender(<Host workspaceId="workspace-a" />);
    await advance();
    await advance(500);
    expect(screen.getByRole("combobox", { name: "検索するフォルダー" }).getAttribute("value")).toBe(
      "資料/%_",
    );
    fireEvent.click(screen.getByRole("button", { name: "検索条件をリセット" }));
    await advance();
    await advance(500);
    expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "東京", 20, 0, "and");
    expect(JSON.parse(localStorage.getItem(SEARCH_PREFERENCES_KEY)!).roots).toEqual([]);
  });

  it("drops a vanished saved folder without changing the remembered open state", async () => {
    localStorage.setItem(
      SEARCH_PREFERENCES_KEY,
      JSON.stringify({
        version: 1,
        detailsOpen: true,
        mode: "and",
        roots: [{ rootId: "root-a", path: "missing" }],
      }),
    );
    render(
      <SearchPanel
        workspaceId="workspace-a"
        viewId="view"
        revision={1}
        nodes={[]}
        onChangeScope={vi.fn()}
        bridge={createBridge()}
        onSelect={vi.fn()}
      />,
    );
    await advance();
    await advance(500);
    expect(
      screen.getByText("保存した検索範囲が見つからないため、ルート全体を検索します。"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "検索の詳細設定" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(JSON.parse(localStorage.getItem(SEARCH_PREFERENCES_KEY)!).roots).toEqual([]);
  });

  it("preserves unknown settings and reports write failure while keeping current controls usable", async () => {
    localStorage.setItem(SEARCH_PREFERENCES_KEY, '{"version":99}');
    const props = {
      workspaceId: "workspace-a",
      revision: 1,
      bridge: createBridge(),
      onSelect: vi.fn(),
    };
    const view = render(<SearchPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "検索の詳細設定" }));
    await advance(500);
    expect(screen.getByRole("alert").textContent).toContain("元の設定を保持");
    expect(localStorage.getItem(SEARCH_PREFERENCES_KEY)).toBe('{"version":99}');
    view.unmount();
    localStorage.removeItem(SEARCH_PREFERENCES_KEY);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    render(<SearchPanel {...props} />);
    await advance();
    fireEvent.click(screen.getByRole("button", { name: "検索の詳細設定" }));
    await advance(250);
    expect(screen.getByRole("alert").textContent).toContain("検索設定を保存できません");
    type("東京");
    await advance(250);
    expect(props.bridge.search).toHaveBeenLastCalledWith("workspace-a", "東京", 20, 0, "and");
    write.mockRestore();
  });

  it("changes UI language without reissuing searches or translating query, scope or result content", async () => {
    const bridge = createBridge();
    render(
      <SearchPanel
        workspaceId="workspace-a"
        revision={1}
        onSelect={vi.fn()}
        bridge={bridge}
        scope={{ relativePath: "長い日本語/$&", viewId: "view" }}
      />,
    );
    await advance();
    type("日本語 $&");
    await advance(250);
    const input = screen.getByRole("searchbox") as HTMLInputElement;
    const result = screen.getByText("検索した文書");
    const searches = bridge.search.mock.calls.length;
    const statusRequests = bridge.getStatus.mock.calls.length;
    await act(() => setLanguage("en"));
    await advance(300);
    expect(screen.getByRole("region", { name: "Document search" })).toBeTruthy();
    expect(screen.getByRole("searchbox")).toBe(input);
    expect(input.value).toBe("日本語 $&");
    expect(screen.getByTitle("長い日本語/$&").textContent).toBe("Scope: 長い日本語/$&");
    expect(screen.getByText("検索した文書")).toBe(result);
    expect(screen.getByText("日本語の本文")).toBeTruthy();
    expect(bridge.search).toHaveBeenCalledTimes(searches);
    expect(bridge.getStatus).toHaveBeenCalledTimes(statusRequests);
  });

  it.each(["success", "failure"])(
    "resets scoped pages and ignores old scope %s",
    async (outcome) => {
      const old = deferred<SearchPage>();
      const bridge = createBridge();
      bridge.search
        .mockResolvedValueOnce(page({ hasMore: true }))
        .mockReturnValueOnce(old.promise)
        .mockResolvedValue(page({ hits: [hit("new", "新しい範囲")] }));
      const scope = { relativePath: "foo", viewId: "view" };
      const props = {
        workspaceId: "workspace-a",
        viewId: "view",
        revision: 1,
        onSelect: vi.fn(),
        bridge,
      };
      const view = render(<SearchPanel {...props} scope={scope} />);
      await advance();
      type("日本語");
      await advance(250);
      expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "日本語", 20, 0, "and", scope);
      fireEvent.click(screen.getByRole("button", { name: "次の20件" }));
      expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "日本語", 20, 20, "and", scope);
      const nextScope = { ...scope, relativePath: "日本語/100%_計画" };
      view.rerender(<SearchPanel {...props} scope={nextScope} />);
      expect(screen.queryByText("検索した文書")).toBeNull();
      await advance();
      await advance(250);
      expect(bridge.search).toHaveBeenLastCalledWith(
        "workspace-a",
        "日本語",
        20,
        0,
        "and",
        nextScope,
      );
      await act(async () => {
        if (outcome === "success") old.resolve(page({ hits: [hit("old", "旧範囲")] }));
        else old.reject(new Error("旧範囲の失敗"));
      });
      expect(screen.queryByText("旧範囲")).toBeNull();
      expect(screen.queryByText("旧範囲の失敗")).toBeNull();
      expect(screen.getByText("新しい範囲")).toBeDefined();
      view.rerender(<SearchPanel {...props} />);
      await advance();
      await advance(250);
      expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "日本語", 20, 0, "and");
    },
  );

  it("shows the literal scope and resets it without clearing the query", async () => {
    const bridge = createBridge();
    const onResetScope = vi.fn();
    render(
      <SearchPanel
        workspaceId="workspace-a"
        revision={1}
        onSelect={vi.fn()}
        bridge={bridge}
        scope={{ relativePath: "資料/%_", viewId: "view" }}
        onResetScope={onResetScope}
      />,
    );
    await advance();
    type("日本語");
    expect(screen.getByTitle("資料/%_").textContent).toBe("範囲: 資料/%_");
    fireEvent.click(screen.getByRole("button", { name: "検索範囲を解除" }));
    expect(onResetScope).toHaveBeenCalledOnce();
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("日本語");
  });

  it("invalidates a deferred result when the view changes", async () => {
    const old = deferred<SearchPage>();
    const bridge = createBridge();
    bridge.search
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(page({ hits: [hit("new", "新しい表示")] }));
    const props = { workspaceId: "workspace-a", revision: 1, onSelect: vi.fn(), bridge };
    const view = render(<SearchPanel {...props} viewId="old" />);
    await advance();
    type("日本語");
    await advance(250);
    view.rerender(<SearchPanel {...props} viewId="new" />);
    await advance();
    await advance(250);
    await act(async () => old.resolve(page({ hits: [hit("old", "古い表示")] })));
    expect(screen.queryByText("古い表示")).toBeNull();
    expect(screen.getByText("新しい表示")).toBeDefined();
  });

  it("resets pages on mode changes and ignores old AND success and failure", async () => {
    const old = deferred<SearchPage>();
    const bridge = createBridge();
    bridge.search
      .mockResolvedValueOnce(page({ hasMore: true }))
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(page({ hits: [hit("or-result", "OR結果")] }));
    const view = render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("京 rust");
    await advance(250);
    fireEvent.click(screen.getByRole("button", { name: "次の20件" }));
    fireEvent.click(screen.getByRole("button", { name: "検索の詳細設定" }));
    fireEvent.click(screen.getByRole("radio", { name: "OR（いずれかの語）" }));
    expect(screen.queryByRole("list", { name: "検索結果" })).toBeNull();
    await advance(250);
    expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "京 rust", 20, 0, "or");
    await act(async () => old.resolve(page({ hits: [hit("old", "古いAND結果")] })));
    expect(screen.queryByText("古いAND結果")).toBeNull();
    expect(screen.getByText("OR結果")).toBeTruthy();
    view.rerender(
      <SearchPanel
        workspaceId="workspace-a"
        revision={1}
        onSelect={vi.fn()}
        bridge={bridge}
        active={false}
      />,
    );
    view.rerender(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance(250);
    expect(
      (screen.getByRole("radio", { name: "OR（いずれかの語）" }) as HTMLInputElement).checked,
    ).toBe(true);
    const stale = deferred<SearchPage>();
    bridge.search.mockReturnValueOnce(stale.promise);
    fireEvent.click(screen.getByRole("radio", { name: "AND（すべての語）" }));
    await advance(250);
    fireEvent.click(screen.getByRole("radio", { name: "OR（いずれかの語）" }));
    await act(async () => stale.reject(new Error("古いANDエラー")));
    expect(screen.queryByText("古いANDエラー")).toBeNull();
    await advance(250);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(view.container.querySelector("mark")).toBeNull();
  });

  it("allows the native offset 10000 boundary and stops before an unsupported page", () => {
    expect(nextSearchPageOffset(9_980, true)).toBe(10_000);
    expect(nextSearchPageOffset(10_000, true)).toBeNull();
    expect(nextSearchPageOffset(10_020, true)).toBeNull();
    expect(nextSearchPageOffset(0, false)).toBeNull();
  });

  it("disables searching without a selected workspace and ignores empty queries", async () => {
    const bridge = createBridge();
    const view = render(
      <SearchPanel workspaceId={null} revision={0} onSelect={vi.fn()} bridge={bridge} />,
    );
    expect((screen.getByRole("searchbox") as HTMLInputElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole("searchbox").closest("form")!);
    await advance(2_000);
    expect(bridge.getStatus).not.toHaveBeenCalled();
    expect(bridge.search).not.toHaveBeenCalled();
    view.rerender(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type(" \t ");
    await advance(2_000);
    expect(bridge.search).not.toHaveBeenCalled();
    expect(bridge.getStatus).toHaveBeenCalledTimes(1);
  });

  it("debounces 250ms and routes selected native relative paths to the existing viewer", async () => {
    const bridge = createBridge();
    const onSelect = vi.fn();
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={onSelect} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(249);
    expect(bridge.search).not.toHaveBeenCalled();
    await advance(1);
    expect(bridge.search).toHaveBeenCalledWith("workspace-a", "日本語", 20, 0, "and");
    fireEvent.click(screen.getByRole("button", { name: /検索した文書/ }));
    expect(onSelect).toHaveBeenCalledWith("document-a.html");
  });

  it("searches immediately on form submission without a submit button", async () => {
    const bridge = createBridge();
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    expect(screen.queryByRole("button", { name: "検索" })).toBeNull();
    fireEvent.submit(screen.getByRole("searchbox").closest("form")!);
    await advance();
    expect(bridge.search).toHaveBeenCalledTimes(1);
  });

  it("waits for IME composition to finish and prevents composing Enter submission", async () => {
    const bridge = createBridge();
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    const input = screen.getByRole("searchbox");
    fireEvent.compositionStart(input);
    type("にほん");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    await advance(500);
    expect(bridge.search).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input, { data: "日本語", target: { value: "日本語" } });
    await advance(250);
    expect(bridge.search).toHaveBeenCalledWith("workspace-a", "日本語", 20, 0, "and");
  });

  it("discards a previous query that resolves after a newer query", async () => {
    const bridge = createBridge();
    const old = deferred<SearchPage>();
    bridge.search
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(page({ hits: [hit("new", "新しい結果")] }));
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("old");
    await advance(250);
    type("new");
    await advance(250);
    await act(async () => {
      old.resolve(page({ hits: [hit("old", "古い結果")] }));
    });
    expect(screen.queryByText("古い結果")).toBeNull();
    expect(screen.getByText("新しい結果")).toBeTruthy();
  });

  it("discards results and status from an old workspace", async () => {
    const bridge = createBridge();
    const old = deferred<SearchPage>();
    bridge.search
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(page({ hits: [hit("new", "別フォルダの結果")] }));
    const view = render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(250);
    view.rerender(
      <SearchPanel workspaceId="workspace-b" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    await advance(250);
    await act(async () => {
      old.resolve(page({ hits: [hit("old", "別フォルダの古い結果")] }));
    });
    expect(screen.queryByText("別フォルダの古い結果")).toBeNull();
    expect(screen.getByText("別フォルダの結果")).toBeTruthy();
    expect(bridge.search).toHaveBeenLastCalledWith("workspace-b", "日本語", 20, 0, "and");
  });

  it("invalidates visible results immediately after a watcher revision changes", async () => {
    const bridge = createBridge();
    const next = deferred<SearchPage>();
    bridge.search.mockResolvedValueOnce(page()).mockReturnValueOnce(next.promise);
    const onSelect = vi.fn();
    const view = render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={onSelect} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(250);
    expect(screen.getByText("検索した文書")).toBeTruthy();
    view.rerender(
      <SearchPanel workspaceId="workspace-a" revision={2} onSelect={onSelect} bridge={bridge} />,
    );
    expect(screen.queryByText("検索した文書")).toBeNull();
    await advance();
    await advance(250);
    expect(onSelect).not.toHaveBeenCalled();
    expect(bridge.search).toHaveBeenCalledTimes(2);
  });

  it("requeries when index generation or request revision changes", async () => {
    const bridge = createBridge();
    bridge.getStatus
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ generation: 2, requestRevision: 4 }));
    bridge.search
      .mockResolvedValueOnce(page())
      .mockResolvedValue(
        page({ generation: 2, requestRevision: 4, hits: [hit("updated", "更新した結果")] }),
      );
    render(
      <SearchPanel workspaceId="workspace-a" revision={17} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(250);
    expect(screen.getByText("検索した文書")).toBeTruthy();
    await advance(750);
    expect(screen.queryByText("検索した文書")).toBeNull();
    await advance(250);
    expect(screen.getByText("更新した結果")).toBeTruthy();
  });

  it("pages 20 results and disables result selection while fetching a page", async () => {
    const bridge = createBridge();
    const second = deferred<SearchPage>();
    bridge.search
      .mockResolvedValueOnce(
        page({ hits: Array.from({ length: 20 }, (_, i) => hit(`doc-${i}`)), hasMore: true }),
      )
      .mockReturnValueOnce(second.promise);
    const onSelect = vi.fn();
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={onSelect} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(250);
    fireEvent.click(screen.getByRole("button", { name: "次の20件" }));
    expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "日本語", 20, 20, "and");
    fireEvent.click(screen.getAllByRole("button", { name: /検索した文書/ })[0]);
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => {
      second.resolve(page({ hits: [hit("second", "次ページ結果")] }));
    });
    expect(screen.getByText("次ページ結果")).toBeTruthy();
    expect(screen.queryByText("doc-0.html")).toBeNull();
    expect(screen.queryByRole("button", { name: "次の20件" })).toBeNull();
    bridge.search.mockResolvedValueOnce(page({ hits: [hit("first", "前ページ結果")] }));
    fireEvent.click(screen.getByRole("button", { name: "前の20件" }));
    await advance();
    expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "日本語", 20, 0, "and");
    expect(screen.getByText("前ページ結果")).toBeTruthy();
    expect(screen.queryByText("次ページ結果")).toBeNull();
  });

  it("drops a page when its index request revision differs and starts again at offset zero", async () => {
    const bridge = createBridge();
    bridge.search
      .mockResolvedValueOnce(page({ hasMore: true }))
      .mockResolvedValueOnce(
        page({ requestRevision: 2, hits: [hit("stale-page", "混在したページ")] }),
      )
      .mockResolvedValueOnce(page());
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(250);
    fireEvent.click(screen.getByRole("button", { name: "次の20件" }));
    await advance();
    expect(screen.queryByText("混在したページ")).toBeNull();
    await advance(250);
    expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "日本語", 20, 0, "and");
  });

  it("cancels pending work with Escape and the cancel button", async () => {
    const bridge = createBridge();
    const old = deferred<SearchPage>();
    bridge.search.mockReturnValueOnce(old.promise);
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(250);
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    await act(async () => {
      old.resolve(page());
    });
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("検索した文書")).toBeNull();
    type("another");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await advance(250);
    expect(bridge.search).toHaveBeenCalledTimes(1);
  });

  it("leaves composing Escape to the IME without canceling or bubbling to the sidebar", async () => {
    const bridge = createBridge();
    const sidebar = vi.fn();
    render(
      <div onKeyDown={sidebar}>
        <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />
      </div>,
    );
    await advance();
    const input = screen.getByRole("searchbox");
    for (const value of ["", "にほん"]) {
      fireEvent.compositionStart(input);
      type(value);
      expect(fireEvent.keyDown(input, { key: "Escape", isComposing: true })).toBe(true);
      expect((input as HTMLInputElement).value).toBe(value);
      expect(sidebar).not.toHaveBeenCalled();
      await advance(300);
      expect(bridge.search).not.toHaveBeenCalled();
      fireEvent.compositionEnd(input);
    }
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(sidebar).toHaveBeenCalledTimes(1);
  });

  it("caps Unicode input by characters and validates the eight term limit", async () => {
    const bridge = createBridge();
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("😀".repeat(300));
    expect(Array.from((screen.getByRole("searchbox") as HTMLInputElement).value)).toHaveLength(256);
    type("1 2 3 4 5 6 7 8 9");
    await advance(250);
    expect(screen.getByRole("alert").textContent).toContain("8個以内");
    expect(bridge.search).not.toHaveBeenCalled();
  });

  it("renders HTML-like native titles, paths, and snippets as text", async () => {
    const bridge = createBridge();
    bridge.search.mockResolvedValue(
      page({
        hits: [
          {
            ...hit(),
            title: "<img src=x onerror=alert(1)>",
            relativePath: "<script>.html",
            snippet: "<script>secret</script>",
            titleMatches: [{ start: 0, end: 7 }],
            snippetMatches: [{ start: 0, end: 8 }],
            truncated: true,
          },
        ],
      }),
    );
    const view = render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(250);
    expect(view.container.querySelector(".search-result-title")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(view.container.querySelector(".search-result-snippet")?.textContent).toBe(
      "<script>secret</script>",
    );
    expect(view.container.querySelectorAll("mark")).toHaveLength(2);
    expect(view.container.querySelector("img, script")).toBeNull();
    expect(screen.getByText("本文の一部を検索")).toBeTruthy();
  });

  it("shows incomplete, unavailable, failed, and truncated indexing states", async () => {
    const bridge = createBridge();
    bridge.getStatus.mockResolvedValue(
      status({
        phase: "building",
        pending: 3,
        unavailable: 2,
        failed: 1,
        truncated: 4,
        limited: true,
        complete: false,
      }),
    );
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    expect(screen.getByText("索引を作成しています")).toBeTruthy();
    expect(screen.getByText("索引を更新しています。検索結果は不完全です")).toBeTruthy();
    expect(screen.getByText("未索引 3件")).toBeTruthy();
    expect(screen.getByText("未取得・利用不可 2件")).toBeTruthy();
    expect(screen.getByText("読み取り失敗 1件")).toBeTruthy();
    expect(screen.getByText("本文を省略した文書 4件")).toBeTruthy();
    expect(screen.getByText(/索引の上限に達しました/)).toBeTruthy();
    await advance(1_000);
    expect(bridge.getStatus).toHaveBeenCalledTimes(2);
  });

  it("shows native errors and provides explicit rebuilding with results invalidated", async () => {
    const bridge = createBridge();
    bridge.search.mockRejectedValueOnce(new Error("検索を実行できませんでした"));
    const rebuilding = deferred<IndexStatus>();
    bridge.rebuild.mockReturnValue(rebuilding.promise);
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(250);
    expect(screen.getByRole("alert").textContent).toContain("検索を実行できませんでした");
    fireEvent.click(screen.getByText("索引の状態・再構築"));
    fireEvent.click(screen.getByRole("button", { name: "索引を再構築" }));
    expect(bridge.rebuild).toHaveBeenCalledWith("workspace-a");
    expect(
      (screen.getByRole("button", { name: "索引を再構築" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("索引を再構築しています")).toBeTruthy();
    await act(async () => {
      rebuilding.reject(new Error("再構築に失敗しました"));
    });
    expect(screen.getByRole("alert").textContent).toContain("再構築に失敗しました");
  });

  it("stops ready empty-query polling and cleans pending timers and responses in StrictMode", async () => {
    const bridge = createBridge();
    const request = deferred<SearchPage>();
    bridge.search.mockReturnValueOnce(request.promise);
    const view = render(
      <StrictMode>
        <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />
      </StrictMode>,
    );
    await advance();
    const initialCalls = bridge.getStatus.mock.calls.length;
    await advance(2_000);
    expect(bridge.getStatus).toHaveBeenCalledTimes(initialCalls);
    type("日本語");
    await advance(250);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      request.resolve(page());
    });
    await advance(2_000);
    expect(bridge.search).toHaveBeenCalledTimes(1);
  });

  it("keeps pending indexing queries queued and retries a failed status read while indexing", async () => {
    const bridge = createBridge();
    bridge.getStatus
      .mockResolvedValueOnce(status({ phase: "pending", pending: 1, complete: false }))
      .mockResolvedValueOnce(status({ phase: "pending", pending: 1, complete: false }))
      .mockRejectedValueOnce(new Error("索引状態を確認できません"))
      .mockResolvedValue(status());
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(1_000);
    expect(bridge.search).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("索引状態を確認できません");
    await advance(1_000);
    await advance(250);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("検索した文書")).toBeTruthy();
  });

  it("does not let a pre-rebuild status response replace the new index status", async () => {
    const bridge = createBridge();
    const oldStatus = deferred<IndexStatus>();
    bridge.getStatus
      .mockResolvedValueOnce(status())
      .mockReturnValueOnce(oldStatus.promise)
      .mockResolvedValue(status({ requestRevision: 2, indexed: 9 }));
    bridge.rebuild.mockResolvedValue(status({ phase: "pending", requestRevision: 2 }));
    bridge.search
      .mockResolvedValueOnce(page())
      .mockResolvedValue(page({ requestRevision: 2, hits: [hit("rebuilt", "再構築した結果")] }));
    render(
      <SearchPanel workspaceId="workspace-a" revision={1} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(250);
    fireEvent.click(screen.getByText("索引の状態・再構築"));
    fireEvent.click(screen.getByRole("button", { name: "索引を再構築" }));
    await advance();
    await act(async () => {
      oldStatus.resolve(status({ indexed: 1 }));
    });
    expect(screen.getByText("9件を検索できます")).toBeTruthy();
    await advance(250);
    expect(screen.getByText("再構築した結果")).toBeTruthy();
    expect(screen.queryByText("検索した文書")).toBeNull();
  });

  it("requeries a changed index request revision even before generation advances", async () => {
    const bridge = createBridge();
    bridge.getStatus
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ requestRevision: 2 }));
    bridge.search
      .mockResolvedValueOnce(page())
      .mockResolvedValue(page({ requestRevision: 2, hits: [hit("serial", "最新要求の結果")] }));
    render(
      <SearchPanel workspaceId="workspace-a" revision={100} onSelect={vi.fn()} bridge={bridge} />,
    );
    await advance();
    type("日本語");
    await advance(1_000);
    expect(screen.queryByText("検索した文書")).toBeNull();
    await advance(250);
    expect(screen.getByText("最新要求の結果")).toBeTruthy();
  });

  it("suspends hidden requests, retains the query and page, and revalidates before reopening", async () => {
    const bridge = createBridge();
    bridge.search.mockResolvedValue(page({ hasMore: true }));
    const props = { workspaceId: "workspace-a", revision: 1, onSelect: vi.fn(), bridge };
    const view = render(<SearchPanel {...props} active={false} />);
    await advance(2_000);
    expect(bridge.getStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("searchbox")).toBeNull();
    view.rerender(<SearchPanel {...props} active />);
    await advance();
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    type("日本語");
    await advance(250);
    fireEvent.click(screen.getByRole("button", { name: "次の20件" }));
    await advance();
    view.rerender(<SearchPanel {...props} active={false} />);
    const calls = bridge.getStatus.mock.calls.length;
    await advance(2_000);
    expect(bridge.getStatus).toHaveBeenCalledTimes(calls);
    expect(bridge.search).toHaveBeenCalledTimes(2);
    const fresh = deferred<IndexStatus>();
    bridge.getStatus.mockReturnValueOnce(fresh.promise);
    view.rerender(<SearchPanel {...props} active />);
    await advance(500);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("日本語");
    expect(screen.queryByText("検索した文書")).toBeNull();
    expect(bridge.search).toHaveBeenCalledTimes(2);
    await act(async () => fresh.resolve(status()));
    await advance(250);
    expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "日本語", 20, 20, "and");
  });

  it("drops a hidden in-flight response and restarts at page zero after an index change", async () => {
    const bridge = createBridge();
    const old = deferred<SearchPage>();
    bridge.search.mockReturnValueOnce(old.promise).mockResolvedValue(page({ generation: 2 }));
    const props = { workspaceId: "workspace-a", revision: 1, onSelect: vi.fn(), bridge };
    const view = render(<SearchPanel {...props} />);
    await advance();
    type("日本語");
    await advance(250);
    view.rerender(<SearchPanel {...props} active={false} />);
    await act(async () => old.resolve(page({ hits: [hit("old", "古い結果")] })));
    bridge.getStatus.mockResolvedValue(status({ generation: 2 }));
    view.rerender(<SearchPanel {...props} active />);
    expect(screen.queryByText("古い結果")).toBeNull();
    await advance();
    await advance(250);
    expect(bridge.search).toHaveBeenLastCalledWith("workspace-a", "日本語", 20, 0, "and");
    expect(screen.getByText("検索した文書")).toBeTruthy();
  });

  it.each([false, true])(
    "requires a fresh status across a hidden rebuild (resolve after reopening: %s)",
    async (resolveAfterReopen) => {
      const bridge = createBridge();
      const rebuilt = deferred<IndexStatus>();
      const fresh = deferred<IndexStatus>();
      bridge.rebuild.mockReturnValueOnce(rebuilt.promise);
      const props = { workspaceId: "workspace-a", revision: 1, onSelect: vi.fn(), bridge };
      const view = render(<SearchPanel {...props} />);
      await advance();
      type("日本語");
      await advance(250);
      fireEvent.click(screen.getByText("索引の状態・再構築"));
      fireEvent.click(screen.getByRole("button", { name: "索引を再構築" }));
      view.rerender(<SearchPanel {...props} active={false} />);
      if (!resolveAfterReopen) await act(async () => rebuilt.resolve(status()));
      bridge.getStatus.mockReturnValue(fresh.promise);
      view.rerender(<SearchPanel {...props} active />);
      if (resolveAfterReopen) await act(async () => rebuilt.resolve(status()));
      await advance(500);
      expect(bridge.search).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("検索した文書")).toBeNull();
      await act(async () => fresh.resolve(status()));
      await advance(250);
      expect(bridge.search).toHaveBeenCalledTimes(2);
    },
  );
});
