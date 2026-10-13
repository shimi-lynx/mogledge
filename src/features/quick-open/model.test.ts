import { expect, it } from "vite-plus/test";
import type { TreeNode } from "../../lib/types";
import {
  matchQuickOpen,
  quickOpenCandidates,
  QUICK_OPEN_LIMIT,
  QUICK_OPEN_QUERY_LIMIT,
} from "./model";

const html = (relativePath: string): TreeNode => ({
  name: relativePath.split("/").at(-1)!,
  relativePath,
  kind: "html",
  children: [],
});
it("ranks exact names and paths before prefixes and substrings, preserving tree order within a rank", () => {
  const candidates = quickOpenCandidates([
    html("extra-report.html"),
    html("report-long.html"),
    html("A/report.html"),
    html("B/report.HTM"),
    html("report.html"),
  ]);
  expect(matchQuickOpen(candidates, "report").items.map((item) => item.relativePath)).toEqual([
    "A/report.html",
    "B/report.HTM",
    "report.html",
    "report-long.html",
    "extra-report.html",
  ]);
  expect(matchQuickOpen(candidates, "REPORT.HTML").items[0].relativePath).toBe("A/report.html");
  expect(
    matchQuickOpen(candidates, "B\\report.htm").items.map((item) => item.relativePath),
  ).toEqual(["B/report.HTM"]);
});
it("supports Japanese, normalized width, same-name disambiguation and no matches without fuzzy expansion", () => {
  const candidates = quickOpenCandidates([
    html("資料/計算表.html"),
    html("旧資料/計算表.html"),
    html("ABC.html"),
  ]);
  expect(matchQuickOpen(candidates, " 計算表 ").items.map((item) => item.relativePath)).toEqual([
    "資料/計算表.html",
    "旧資料/計算表.html",
  ]);
  expect(matchQuickOpen(candidates, "ＡＢＣ").items[0].relativePath).toBe("ABC.html");
  expect(matchQuickOpen(candidates, "ac")).toEqual({ items: [], hasMore: false });
});
it("bounds 10001 metadata matches, includes a late exact match and never includes folders", () => {
  const children = Array.from({ length: 10001 }, (_, index) => html(`folder/${index}.html`));
  const candidates = quickOpenCandidates([
    { relativePath: "folder", name: "folder", kind: "folder", children },
  ]);
  const result = matchQuickOpen(candidates, "");
  expect(candidates).toHaveLength(10001);
  expect(result.items).toHaveLength(QUICK_OPEN_LIMIT);
  expect(result.hasMore).toBe(true);
  expect(matchQuickOpen(candidates, "10000").items[0].relativePath).toBe("folder/10000.html");
  expect(matchQuickOpen(quickOpenCandidates([]), "")).toEqual({ items: [], hasMore: false });
});
it("bounds raw and normalized query length and retains long original display names", () => {
  const name = "計".repeat(QUICK_OPEN_QUERY_LIMIT);
  const candidates = quickOpenCandidates([html(name + ".html")]);
  expect(matchQuickOpen(candidates, name + "ignored").items[0].name).toBe(name + ".html");
  expect(matchQuickOpen(candidates, "㍿".repeat(100))).toEqual({ items: [], hasMore: false });
});
