import { expect, it } from "vite-plus/test";
import { rootFolderName } from "./rootDisplay";

it.each([
  ["C:\\", "C:\\"],
  ["d:/", "d:/"],
  ["C:\\Notes\\", "Notes"],
  ["/Users/example/日本語 資料/", "日本語 資料"],
  ["\\\\server\\share\\", "share"],
  ["/", "/"],
  ["/fixture/<img onerror='fail'>&$1{root}", "<img onerror='fail'>&$1{root}"],
  ["/fixture/" + "長い名前".repeat(80), "長い名前".repeat(80)],
  [null, null],
  [undefined, null],
  ["", null],
])("displays %s without treating the label as a path", (path, name) => {
  expect(rootFolderName(path)).toBe(name);
});
