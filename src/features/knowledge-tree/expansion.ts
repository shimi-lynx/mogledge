import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import type { TreeNode } from "../../lib/types";

export const TREE_EXPANSION_KEY = "my-knowledge.tree-expansion:";
const MAX_CHARACTERS = 65_536;
type Expansion = { scope: string | null; expanded: Set<string>; readOnly: boolean };

function readExpansion(scope: string | null, persistent: boolean): Expansion {
  const empty = { scope, expanded: new Set<string>(), readOnly: false };
  if (!persistent || !scope) return empty;
  try {
    const raw = window.localStorage.getItem(TREE_EXPANSION_KEY + scope);
    if (!raw) return empty;
    if (raw.length > MAX_CHARACTERS) throw new Error("size");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("shape");
    const stored = value as { version?: unknown; paths?: unknown };
    if (
      Object.keys(stored).sort().join() !== "paths,version" ||
      stored.version !== 1 ||
      !Array.isArray(stored.paths) ||
      !stored.paths.every(
        (path): path is string =>
          typeof path === "string" &&
          path.length <= 4096 &&
          !path.includes("\\") &&
          !path.includes("\u0000") &&
          path.split("/").every((part) => !!part && part !== "." && part !== ".."),
      )
    )
      throw new Error("shape");
    return { ...empty, expanded: new Set(stored.paths) };
  } catch {
    // Unknown, corrupt or inaccessible UI preferences remain untouched.
    return { ...empty, readOnly: true };
  }
}

export function useTreeExpansion(
  rootPath: string | null | undefined,
  workspaceId: string | null,
  nodes: TreeNode[],
) {
  // workspaceId changes on each selection; only the registered root path is persistent.
  const scope = rootPath ?? workspaceId;
  const pending = useRef(new Map<string, Set<string>>());
  const [state, setState] = useState(() => readExpansion(scope, !!rootPath));
  if (state.scope !== scope) {
    const loaded = readExpansion(scope, !!rootPath);
    if (scope && pending.current.has(scope)) loaded.expanded = pending.current.get(scope)!;
    setState(loaded);
  }
  const folders = useMemo(() => {
    const paths = new Set<string>();
    const visit = (items: TreeNode[]) => {
      for (const node of items) {
        if (node.kind !== "folder") continue;
        paths.add(node.relativePath);
        visit(node.children);
      }
    };
    visit(nodes);
    return paths;
  }, [nodes]);
  const setExpanded = useCallback(
    (change: SetStateAction<Set<string>>) => {
      setState((previous) => {
        if (previous.scope !== scope) return previous;
        const next = typeof change === "function" ? change(previous.expanded) : change;
        if (
          next.size === previous.expanded.size &&
          [...next].every((path) => previous.expanded.has(path))
        )
          return previous;
        if (rootPath && !previous.readOnly) pending.current.set(rootPath, next);
        return { ...previous, expanded: next };
      });
    },
    [scope, rootPath],
  );
  const reconcileExpanded = useCallback(() => {
    setExpanded((previous) => new Set([...previous].filter((path) => folders.has(path))));
  }, [setExpanded, folders]);
  const flush = useCallback(() => {
    for (const [root, expanded] of pending.current) {
      try {
        const raw = JSON.stringify({ version: 1, paths: [...expanded] });
        if (raw.length <= MAX_CHARACTERS)
          window.localStorage.setItem(TREE_EXPANSION_KEY + root, raw);
      } catch {
        // Expansion still works for this session if local preference storage is unavailable.
      }
    }
    pending.current.clear();
  }, []);
  useEffect(() => {
    if (!pending.current.size) return;
    // Like search preferences, coalesce rapid toggles and flush on controlled teardown.
    const timer = setTimeout(flush, 250);
    return () => clearTimeout(timer);
  }, [state, flush]);
  useEffect(() => {
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [flush]);
  return { expanded: state.expanded, setExpanded, reconcileExpanded };
}
