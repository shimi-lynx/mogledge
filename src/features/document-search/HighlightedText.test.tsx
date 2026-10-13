import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vite-plus/test";
import { HighlightedText } from "./HighlightedText";

afterEach(cleanup);

it("uses scalar offsets for astral characters and preserves combined source text", () => {
  const text = "😀ＲＵＳＴ Cafe\u0301 ｶﾞ";
  const view = render(
    <HighlightedText
      text={text}
      ranges={[
        { start: 1, end: 5 },
        { start: 6, end: 11 },
        { start: 12, end: 14 },
      ]}
    />,
  );
  expect(view.container.textContent).toBe(text);
  expect(Array.from(view.container.querySelectorAll("mark"), (mark) => mark.textContent)).toEqual([
    "ＲＵＳＴ",
    "Cafe\u0301",
    "ｶﾞ",
  ]);
});

it("ignores malformed and overlapping ranges while keeping HTML-like text inert", () => {
  const text = "<script>text</script>";
  const view = render(
    <HighlightedText
      text={text}
      ranges={[
        { start: -1, end: 3 },
        { start: 0, end: 8 },
        { start: 4, end: 9 },
        { start: 8.5, end: 10 },
        { start: 8, end: 100 },
      ]}
    />,
  );
  expect(view.container.textContent).toBe(text);
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.container.querySelectorAll("mark")).toHaveLength(1);
});
