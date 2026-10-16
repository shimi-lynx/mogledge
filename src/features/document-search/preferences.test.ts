import { expect, it } from "vite-plus/test";
import { readSearchPreferences, rememberSearchScope } from "./preferences";

it("never probes old product preferences", () => {
  const keys: string[] = [];
  const preferences = readSearchPreferences({
    getItem: (key) => {
      keys.push(key);
      return key === "my-knowledge.search-preferences" ? "{corrupt legacy sentinel" : null;
    },
  });
  expect(keys).toEqual(["mogledge.search-preferences"]);
  expect(preferences.readOnly).toBe(false);
  expect(preferences.value.roots).toEqual([]);
});

it("bounds root history and preserves literal relative paths without a search query", () => {
  let preferences = readSearchPreferences({ getItem: () => null }).value;
  for (let i = 0; i < 10; i++)
    preferences = rememberSearchScope(preferences, `root-${i}`, '資料/%_quote"');
  expect(preferences.roots).toHaveLength(8);
  expect(preferences.roots.map((root) => root.rootId)).toEqual(
    [9, 8, 7, 6, 5, 4, 3, 2].map((i) => `root-${i}`),
  );
  const raw = JSON.stringify(preferences);
  expect(readSearchPreferences({ getItem: () => raw })).toEqual({
    value: preferences,
    readOnly: false,
  });
  expect(rememberSearchScope(preferences, "root-9", '資料/%_quote"')).toBe(preferences);
  expect(rememberSearchScope(preferences, "root-9", "").roots).toHaveLength(7);
  expect(raw).not.toContain("query");
});

it("keeps malformed, unknown, duplicate and oversized preferences read-only", () => {
  const valid = { version: 1, detailsOpen: true, mode: "and", roots: [] };
  for (const raw of [
    "{",
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, mode: "expression" }),
    JSON.stringify({ ...valid, query: "private keyword" }),
    "x".repeat(65_537),
    ...["../escape", "/absolute", "a\\b", "nul\u0000", "x".repeat(4097)].map((path) =>
      JSON.stringify({ ...valid, roots: [{ rootId: "root", path }] }),
    ),
    JSON.stringify({
      ...valid,
      roots: [
        { rootId: "root", path: "a" },
        { rootId: "root", path: "b" },
      ],
    }),
  ])
    expect(readSearchPreferences({ getItem: () => raw }).readOnly).toBe(true);
  expect(
    readSearchPreferences({
      getItem: () => {
        throw new Error("denied");
      },
    }).readOnly,
  ).toBe(true);
});
