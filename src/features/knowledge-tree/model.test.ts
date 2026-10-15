import { expect, it } from "vite-plus/test";
import {
  displayedNodes,
  visibleRows,
  countDocuments,
  treeLabel,
  htmlNameParts,
  renamedHtmlPath,
} from "./model";
import type { TreeNode } from "../../lib/types";
it("limits display to a child while preserving registered-root-relative document paths", () => {
  const document: TreeNode = {
    name: "a.html",
    relativePath: "parent/child/a.html",
    kind: "html",
    children: [],
  };
  const child: TreeNode = {
    name: "child",
    relativePath: "parent/child",
    kind: "folder",
    children: [document],
  };
  const nodes: TreeNode[] = [
    { name: "parent", relativePath: "parent", kind: "folder", children: [child] },
  ];
  expect(displayedNodes(nodes, "")).toBe(nodes);
  expect(displayedNodes(nodes, "parent/child")).toEqual([document]);
  expect(displayedNodes(nodes, "parent/child/a.html")).toEqual([]);
  expect(displayedNodes(nodes, "parent-other")).toEqual([]);
  expect(document.relativePath).toBe("parent/child/a.html");
});
it("only flattens expanded folders while counting all HTML", () => {
  const nodes: TreeNode[] = [
    {
      name: "folder",
      relativePath: "folder",
      kind: "folder",
      children: [{ name: "a.html", relativePath: "folder/a.html", kind: "html", children: [] }],
    },
  ];
  expect(visibleRows(nodes, new Set())).toHaveLength(1);
  expect(visibleRows(nodes, new Set(["folder"]))[1].depth).toBe(1);
  expect(countDocuments(nodes)).toBe(1);
});
it("hides only the terminal HTML extension in labels and preserves original paths", () => {
  for (const [name, expected] of [
    ["長い日本語の名前.HtMl", "長い日本語の名前"],
    ["guide.htm", "guide"],
    ["nested.html.part.HTML", "nested.html.part"],
    [".html", ".html"],
    ["document.xhtml", "document.xhtml"],
    ["document.html.txt", "document.html.txt"],
  ]) {
    const node: TreeNode = { name, relativePath: "folder/" + name, kind: "html", children: [] };
    expect(treeLabel(node)).toBe(expected);
    expect(node.relativePath).toBe("folder/" + name);
    expect(treeLabel({ ...node, kind: "folder" })).toBe(name);
  }
  expect(htmlNameParts("guide.HTM")).toEqual({ basename: "guide", extension: ".HTM" });
  expect(renamedHtmlPath("folder/guide.HTM", "新しい名前")).toBe("folder/新しい名前.HTM");
  expect(renamedHtmlPath("guide.HtMl", "name.part")).toBe("name.part.HtMl");
});
