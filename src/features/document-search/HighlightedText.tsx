import type { MatchRange } from "./types";

export function HighlightedText({ text, ranges = [] }: { text: string; ranges?: MatchRange[] }) {
  const characters = Array.from(text);
  const parts = [];
  let offset = 0;
  // Accept only bounded, ordered native ranges. All content remains React text.
  for (const range of ranges) {
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < offset ||
      range.end <= range.start ||
      range.end > characters.length
    )
      continue;
    parts.push(characters.slice(offset, range.start).join(""));
    parts.push(<mark key={range.start}>{characters.slice(range.start, range.end).join("")}</mark>);
    offset = range.end;
  }
  parts.push(characters.slice(offset).join(""));
  return <>{parts}</>;
}
