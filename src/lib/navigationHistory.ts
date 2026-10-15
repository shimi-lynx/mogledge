// One independent state per live column. Locations come from the existing
// resolved/open path; this module performs no filesystem or permission checks.
export const MAX_NAVIGATION_HISTORY = 32;

export type NavigationLocation = Readonly<{ path: string; fragment: string }>;
export type NavigationEntry = NavigationLocation & Readonly<{ missing: boolean }>;
export type NavigationRequest = Readonly<{ index: number; target: NavigationLocation }>;
export type NavigationHistory = Readonly<{
  entries: readonly NavigationEntry[];
  cursor: number;
  pending: NavigationRequest | null;
}>;

export function createNavigationHistory(): NavigationHistory {
  return { entries: [], cursor: -1, pending: null };
}

// Call only after an explicit user navigation has succeeded, never from a
// background reload or a history-step completion. Tabs/iframes remain external.
export function recordNavigation(
  history: NavigationHistory,
  target: NavigationLocation,
): NavigationHistory {
  const current = history.entries[history.cursor];
  if (
    current?.path === target.path &&
    current.fragment === target.fragment &&
    !current.missing &&
    !history.pending
  )
    return history;
  // Copy only location fields even if a caller has a structurally compatible
  // view object. History must not retain grants, tab state, or other payloads.
  const entry = { path: target.path, fragment: target.fragment, missing: false };
  if (current?.path === target.path) {
    // Page-local anchors do not add document-history entries or cut forward.
    // A newly successful action still supersedes any pending history request.
    const entries = [...history.entries];
    entries[history.cursor] = entry;
    return { entries, cursor: history.cursor, pending: null };
  }
  const entries = [...history.entries.slice(0, history.cursor + 1), entry].slice(
    -MAX_NAVIGATION_HISTORY,
  );
  return { entries, cursor: entries.length - 1, pending: null };
}

export function prepareNavigation(
  history: NavigationHistory,
  direction: "back" | "forward",
): { history: NavigationHistory; request: NavigationRequest | null } {
  const step = direction === "back" ? -1 : 1;
  // Repeated keys accumulate intent without moving the committed cursor.
  let index = (history.pending?.index ?? history.cursor) + step;
  while (index >= 0 && index < history.entries.length) {
    const entry = history.entries[index];
    if (!entry.missing) {
      // Object identity guards against replay/old responses, including a reset
      // that happens to have exactly the same paths and indices.
      const request = { index, target: { path: entry.path, fragment: entry.fragment } };
      return { history: { ...history, pending: request }, request };
    }
    index += step;
  }
  return { history, request: null };
}

export function commitNavigation(
  history: NavigationHistory,
  request: NavigationRequest,
): NavigationHistory {
  if (history.pending !== request) return history;
  return { entries: history.entries, cursor: request.index, pending: null };
}

export function failNavigation(
  history: NavigationHistory,
  request: NavigationRequest,
): NavigationHistory {
  if (history.pending !== request) return history;
  return cancelNavigation(history);
}

// Cancel before moving a column's history to a different owner, on reload
// invalidation, or when abandoning a navigation. Root/view changes reset it.
// Display-folder navigation retains document history under the registered root.
export function cancelNavigation(history: NavigationHistory): NavigationHistory {
  return history.pending ? { ...history, pending: null } : history;
}

// Feed confirmed move/tree results. null means known missing, not a transient
// read error. Keep the current entry/cursor even if missing: changing the tree
// must not pretend that a different document has been displayed successfully.
export function remapNavigationPaths(
  history: NavigationHistory,
  mapPath: (path: string) => string | null,
): NavigationHistory {
  let changed = false;
  const entries = history.entries.map((entry) => {
    const path = mapPath(entry.path);
    const missing = path === null;
    if ((path ?? entry.path) === entry.path && missing === entry.missing) return entry;
    changed = true;
    return { ...entry, path: path ?? entry.path, missing };
  });
  // Any path/availability reconciliation invalidates earlier validation work.
  if (!changed) return cancelNavigation(history);
  return { entries, cursor: history.cursor, pending: null };
}
