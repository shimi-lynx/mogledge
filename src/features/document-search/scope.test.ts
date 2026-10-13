import { expect, it } from "vite-plus/test";
import type { Snapshot, TreeNode } from "../../lib/types";
import { reconcileSearchScope, type SelectedSearchScope } from "./scope";

function folder(relativePath: string, children: TreeNode[] = []): TreeNode {
  return { relativePath, name: relativePath.split("/").at(-1)!, kind: "folder", children };
}
const scope: SelectedSearchScope = {
  workspaceId: "workspace",
  viewId: "view",
  revision: 1,
  relativePath: "foo/深い",
};
function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    workspaceId: "workspace",
    viewId: "view",
    revision: 1,
    rootPath: null,
    watchError: null,
    nodes: [folder("foo", [folder("foo/深い")]), folder("foobar")],
    ...overrides,
  };
}

it("retains an existing deep scope and ignores prior move records", () => {
  expect(reconcileSearchScope(scope, snapshot())).toBe(scope);
  expect(
    reconcileSearchScope(scope, snapshot({ pathMoves: [{ from: "foo", to: "old", revision: 1 }] })),
  ).toBe(scope);
});

it("follows ancestor moves in order using segment boundaries", () => {
  const current = snapshot({
    revision: 3,
    nodes: [folder("資料", [folder("資料/移動先")])],
    pathMoves: [
      { from: "foobar", to: "other", revision: 2 },
      { from: "foo", to: "資料", revision: 2 },
      { from: "資料/深い", to: "資料/移動先", revision: 3 },
    ],
  });
  expect(reconcileSearchScope(scope, current)).toEqual({
    ...scope,
    relativePath: "資料/移動先",
    revision: 3,
  });
});

it("clears deleted, file-replaced, root-switched and view-switched scopes", () => {
  for (const value of [
    snapshot({ nodes: [] }),
    snapshot({ workspaceId: "new" }),
    snapshot({ viewId: "new" }),
    snapshot({ nodes: [folder("foo", [{ ...folder("foo/深い"), kind: "html" }])] }),
  ]) {
    expect(reconcileSearchScope(scope, value)).toBeNull();
  }
  expect(reconcileSearchScope(null, snapshot())).toBeNull();
});
