import { describe, expect, it } from "vite-plus/test";
import {
  MAX_NAVIGATION_HISTORY,
  cancelNavigation,
  commitNavigation,
  createNavigationHistory,
  failNavigation,
  prepareNavigation,
  recordNavigation,
  remapNavigationPaths,
  type NavigationHistory,
} from "./navigationHistory";

const location = (path: string, fragment = "") => ({ path, fragment });
const visits = (...paths: string[]) =>
  paths.reduce(
    (history, path) => recordNavigation(history, location(path)),
    createNavigationHistory(),
  );
function prepare(history: NavigationHistory, direction: "back" | "forward") {
  const next = prepareNavigation(history, direction);
  if (!next.request) throw new Error("Expected a history target");
  return { history: next.history, request: next.request };
}
const currentPath = (history: NavigationHistory) => history.entries[history.cursor]?.path;

describe("column document navigation history", () => {
  it("traverses A/B/C in both directions without adding visits", () => {
    let history = visits("a.html", "b.html", "c.html");
    const entries = history.entries;
    const back = prepare(history, "back");
    expect(back.request.target).toEqual(location("b.html"));
    expect(currentPath(back.history)).toBe("c.html");
    history = commitNavigation(back.history, back.request);
    expect(currentPath(history)).toBe("b.html");
    const forward = prepare(history, "forward");
    history = commitNavigation(forward.history, forward.request);
    expect(currentPath(history)).toBe("c.html");
    expect(history.entries).toBe(entries);
    expect(history.pending).toBeNull();
  });

  it("leaves empty and end-of-history requests unchanged", () => {
    for (const history of [createNavigationHistory(), visits("a.html")]) {
      for (const direction of ["back", "forward"] as const) {
        expect(prepareNavigation(history, direction)).toEqual({ history, request: null });
        expect(prepareNavigation(history, direction).history).toBe(history);
      }
    }
  });

  it("cuts forward only after a successful new document visit", () => {
    const back = prepare(visits("a.html", "b.html", "c.html"), "back");
    const history = commitNavigation(back.history, back.request);
    const forward = prepare(history, "forward");
    const failed = failNavigation(forward.history, forward.request);
    expect(failed.entries).toBe(history.entries);
    expect(failed.cursor).toBe(history.cursor);
    expect(failed.pending).toBeNull();
    const branch = recordNavigation(history, location("d.html"));
    expect(branch.entries.map((entry) => entry.path)).toEqual(["a.html", "b.html", "d.html"]);
    expect(prepareNavigation(branch, "forward").request).toBeNull();
  });

  it("bounds each column without globally deduplicating revisits", () => {
    let history = visits("a.html", "b.html", "a.html");
    expect(history.entries.map((entry) => entry.path)).toEqual(["a.html", "b.html", "a.html"]);
    for (let index = 0; index < MAX_NAVIGATION_HISTORY + 5; index++)
      history = recordNavigation(history, location(`file-${index}.html`));
    expect(history.entries).toHaveLength(MAX_NAVIGATION_HISTORY);
    expect(history.entries[0].path).toBe("file-5.html");
    expect(history.cursor).toBe(MAX_NAVIGATION_HISTORY - 1);
  });

  it("deduplicates the current document and updates its fragment without dropping forward", () => {
    const back = prepare(visits("a.html", "b.html", "c.html"), "back");
    const history = commitNavigation(back.history, back.request);
    expect(recordNavigation(history, location("b.html"))).toBe(history);
    const page = recordNavigation(history, location("b.html", "#details"));
    expect(page.entries).toHaveLength(3);
    expect(page.cursor).toBe(1);
    expect(page.entries[1].fragment).toBe("#details");
    const forward = prepare(page, "forward");
    const again = prepare(commitNavigation(forward.history, forward.request), "back");
    expect(again.request.target).toEqual(location("b.html", "#details"));
  });

  it("keeps same-path views independent across columns and rejects a foreign request", () => {
    const left = prepare(visits("same.html", "left.html"), "back");
    const right = prepare(visits("same.html", "right.html"), "back");
    expect(commitNavigation(right.history, left.request)).toBe(right.history);
    expect(failNavigation(right.history, left.request)).toBe(right.history);
    const changedLeft = recordNavigation(
      commitNavigation(left.history, left.request),
      location("same.html", "#left"),
    );
    expect(changedLeft.entries[0].fragment).toBe("#left");
    expect(right.history.entries[0].fragment).toBe("");
    expect(currentPath(right.history)).toBe("right.html");
  });

  it("accumulates rapid back requests and ignores reversed responses and replays", () => {
    const first = prepare(visits("a.html", "b.html", "c.html"), "back");
    const latest = prepare(first.history, "back");
    expect(latest.request.target.path).toBe("a.html");
    expect(currentPath(latest.history)).toBe("c.html");
    expect(commitNavigation(latest.history, first.request)).toBe(latest.history);
    expect(failNavigation(latest.history, first.request)).toBe(latest.history);
    const committed = commitNavigation(latest.history, latest.request);
    expect(currentPath(committed)).toBe("a.html");
    expect(commitNavigation(committed, latest.request)).toBe(committed);
    expect(commitNavigation(committed, first.request)).toBe(committed);
  });

  it("handles opposite direction intent and preserves the latest pending request at an edge", () => {
    const back = prepare(visits("a.html", "b.html", "c.html"), "back");
    const opposite = prepare(back.history, "forward");
    expect(opposite.request.target.path).toBe("c.html");
    expect(commitNavigation(opposite.history, back.request)).toBe(opposite.history);
    expect(currentPath(commitNavigation(opposite.history, opposite.request))).toBe("c.html");
    const earliest = prepare(back.history, "back");
    expect(prepareNavigation(earliest.history, "back")).toEqual({
      history: earliest.history,
      request: null,
    });
    expect(currentPath(commitNavigation(earliest.history, earliest.request))).toBe("a.html");
  });

  it("leaves the committed cursor intact on transient read or fragment validation failure", () => {
    const back = prepare(visits("a.html", "b.html", "c.html"), "back");
    const failed = failNavigation(back.history, back.request);
    expect(failed.entries).toBe(back.history.entries);
    expect(currentPath(failed)).toBe("c.html");
    expect(failed.pending).toBeNull();
    expect(prepare(failed, "back").request.target.path).toBe("b.html");
    expect(commitNavigation(failed, back.request)).toBe(failed);
  });

  it("supersedes pending traversal with a successful document or page-local action", () => {
    const back = prepare(visits("a.html", "b.html", "c.html"), "back");
    for (const target of [location("d.html"), location("c.html", "#new")]) {
      const recorded = recordNavigation(back.history, target);
      expect(commitNavigation(recorded, back.request)).toBe(recorded);
      expect(recorded.pending).toBeNull();
      expect(currentPath(recorded)).toBe(target.path);
    }
  });

  it("follows confirmed file/folder moves and invalidates earlier target validation", () => {
    const back = prepare(visits("folder/a.html", "folder/b.html", "c.html"), "back");
    const moved = remapNavigationPaths(back.history, (path) =>
      path.startsWith("folder/") ? "moved/" + path.slice("folder/".length) : path,
    );
    expect(moved.cursor).toBe(back.history.cursor);
    expect(moved.entries.map((entry) => entry.path)).toEqual([
      "moved/a.html",
      "moved/b.html",
      "c.html",
    ]);
    expect(commitNavigation(moved, back.request)).toBe(moved);
    expect(prepare(moved, "back").request.target.path).toBe("moved/b.html");
  });

  it("skips known missing history while retaining a missing current entry without changing display", () => {
    const history = visits("a.html", "b.html", "c.html");
    const missing = remapNavigationPaths(history, (path) => (path === "b.html" ? null : path));
    const back = prepare(missing, "back");
    expect(back.request.target.path).toBe("a.html");
    expect(
      prepare(commitNavigation(back.history, back.request), "forward").request.target.path,
    ).toBe("c.html");
    const restored = remapNavigationPaths(missing, (path) => path);
    expect(prepare(restored, "back").request.target.path).toBe("b.html");
    const missingCurrent = remapNavigationPaths(history, (path) =>
      path === "c.html" ? null : path,
    );
    expect(currentPath(missingCurrent)).toBe("c.html");
    expect(missingCurrent.entries[2].missing).toBe(true);
    const allMissing = remapNavigationPaths(history, () => null);
    expect(allMissing.cursor).toBe(2);
    expect(prepareNavigation(allMissing, "back").request).toBeNull();
  });

  it("keeps duplicate moved paths bounded and distinguishes fragments on later visits", () => {
    const history = recordNavigation(visits("a.html", "b.html"), location("a.html", "#again"));
    const moved = remapNavigationPaths(history, () => "same.html");
    expect(moved.entries).toHaveLength(3);
    expect(prepare(moved, "back").request.target.fragment).toBe("");
    expect(moved.entries[2].fragment).toBe("#again");
  });

  it("cancels pending work on reload or ownership transfer without inventing a visit", () => {
    const pending = prepare(visits("a.html", "b.html"), "back");
    const retained = cancelNavigation(pending.history);
    expect(retained.entries).toBe(pending.history.entries);
    expect(retained.cursor).toBe(pending.history.cursor);
    expect(commitNavigation(retained, pending.request)).toBe(retained);
    expect(cancelNavigation(retained)).toBe(retained);
    // A surviving pane can retain this state after collapse/reindex. The
    // discarded pane's timeline must never accept its old completion ticket.
    const replacement = prepare(visits("a.html", "b.html"), "back");
    expect(commitNavigation(replacement.history, pending.request)).toBe(replacement.history);
  });

  it("resets root/view history even when fresh paths and cursor match an old request", () => {
    const old = prepare(visits("a.html", "b.html"), "back");
    const reset = createNavigationHistory();
    expect(commitNavigation(reset, old.request)).toBe(reset);
    const fresh = prepare(visits("a.html", "b.html"), "back");
    expect(commitNavigation(fresh.history, old.request)).toBe(fresh.history);
    expect(failNavigation(fresh.history, old.request)).toBe(fresh.history);
  });

  it("does not mutate callers, earlier states, targets, or pending requests", () => {
    const target = Object.freeze({ ...location("a.html", "#start"), grant: "not-retained" });
    const initial = Object.freeze(createNavigationHistory());
    const history = recordNavigation(initial, target);
    const visited = recordNavigation(history, location("b.html"));
    visited.entries.forEach(Object.freeze);
    Object.freeze(visited.entries);
    Object.freeze(visited);
    const next = prepare(visited, "back");
    Object.freeze(next.request);
    Object.freeze(next.request.target);
    expect(commitNavigation(next.history, next.request).cursor).toBe(0);
    expect(initial.entries).toEqual([]);
    expect(history.entries).toEqual([{ path: "a.html", fragment: "#start", missing: false }]);
    expect(target).toEqual({ ...location("a.html", "#start"), grant: "not-retained" });
    expect(next.history.cursor).toBe(1);
  });
});
