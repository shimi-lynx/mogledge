import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchMode } from "./types";

export const SEARCH_PREFERENCES_KEY = "my-knowledge.search-preferences";
const MAX_STORAGE_CHARACTERS = 65_536;
const MAX_ROOTS = 8;
export interface SearchPreferences {
  version: 1;
  detailsOpen: boolean;
  mode: SearchMode;
  roots: { rootId: string; path: string }[];
}
const defaults = (): SearchPreferences => ({
  version: 1,
  detailsOpen: false,
  mode: "and",
  roots: [],
});

export function readSearchPreferences(storage: Pick<Storage, "getItem"> = window.localStorage) {
  try {
    const raw = storage.getItem(SEARCH_PREFERENCES_KEY);
    if (!raw) return { value: defaults(), readOnly: false };
    if (raw.length > MAX_STORAGE_CHARACTERS) throw new Error("size");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("shape");
    const stored = value as Partial<SearchPreferences>;
    if (
      Object.keys(stored).sort().join() !== "detailsOpen,mode,roots,version" ||
      stored.version !== 1 ||
      typeof stored.detailsOpen !== "boolean" ||
      (stored.mode !== "and" && stored.mode !== "or") ||
      !Array.isArray(stored.roots) ||
      stored.roots.length > MAX_ROOTS
    )
      throw new Error("shape");
    const ids = new Set<string>();
    for (const root of stored.roots) {
      if (
        !root ||
        typeof root !== "object" ||
        Object.keys(root).sort().join() !== "path,rootId" ||
        typeof root.rootId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/u.test(root.rootId) ||
        ids.has(root.rootId) ||
        typeof root.path !== "string" ||
        !root.path ||
        root.path.length > 4096 ||
        root.path.includes("\\") ||
        root.path.includes("\u0000") ||
        root.path.split("/").some((part) => !part || part === "." || part === "..")
      )
        throw new Error("root");
      ids.add(root.rootId);
    }
    return { value: stored as SearchPreferences, readOnly: false };
  } catch {
    // Unknown/corrupt preferences stay untouched, like other device settings.
    return { value: defaults(), readOnly: true };
  }
}

export function rememberSearchScope(preferences: SearchPreferences, rootId: string, path: string) {
  if ((preferences.roots.find((root) => root.rootId === rootId)?.path ?? "") === path)
    return preferences;
  const roots = preferences.roots.filter((root) => root.rootId !== rootId);
  if (path) roots.unshift({ rootId, path });
  return { ...preferences, roots: roots.slice(0, MAX_ROOTS) };
}

export function useSearchPreferences() {
  // Access to localStorage itself may throw; include that lookup in the read boundary.
  const [loaded] = useState(() => {
    try {
      return readSearchPreferences();
    } catch {
      return { value: defaults(), readOnly: true };
    }
  });
  const [preferences, setPreferences] = useState(loaded.value);
  const [saveFailed, setSaveFailed] = useState(false);
  const pending = useRef<SearchPreferences | null>(null);
  const update = useCallback((change: (current: SearchPreferences) => SearchPreferences) => {
    setPreferences((current) => {
      const next = change(current);
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      pending.current = next;
      return next;
    });
  }, []);
  const flush = useCallback(() => {
    if (!pending.current) return true;
    const value = pending.current;
    pending.current = null;
    try {
      if (loaded.readOnly) return false;
      const raw = JSON.stringify(value);
      if (
        raw.length > MAX_STORAGE_CHARACTERS ||
        readSearchPreferences({ getItem: () => raw }).readOnly
      )
        return false;
      window.localStorage.setItem(SEARCH_PREFERENCES_KEY, raw);
      return true;
    } catch {
      return false;
    }
  }, [loaded.readOnly]);
  useEffect(() => {
    if (!pending.current) return;
    // Coalesce rapid toggles; query edits never change this state or write it.
    const timer = setTimeout(() => setSaveFailed(!flush()), 250);
    return () => clearTimeout(timer);
  }, [preferences, flush]);
  useEffect(() => {
    const save = () => {
      flush();
    };
    window.addEventListener("beforeunload", save);
    return () => {
      window.removeEventListener("beforeunload", save);
      flush();
    };
  }, [flush]);
  return { preferences, update, saveFailed, readOnly: loaded.readOnly };
}
