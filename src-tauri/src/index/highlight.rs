//! Map literal normalized matches back to the original display text. Only the
//! bounded result page is processed; the source HTML and its DOM are untouched.
use unicode_normalization::{
    char::{canonical_combining_class, compose, decompose_compatible},
    UnicodeNormalization,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRange {
    // Half-open Unicode scalar offsets, independent of Rust bytes / JS UTF-16.
    pub start: usize,
    pub end: usize,
}

struct MappedText {
    text: String,
    // Each normalized UTF-8 byte points to its original normalization cluster.
    source: Vec<MatchRange>,
}

fn normalize_mapped(text: &str) -> MappedText {
    let mut mapped = MappedText {
        text: String::new(),
        source: Vec::new(),
    };
    let mut pending_space = None;
    let mut cluster = String::new();
    let mut start = 0;
    let mut end = 0;
    let append = |cluster: &str,
                  range: MatchRange,
                  mapped: &mut MappedText,
                  pending_space: &mut Option<MatchRange>| {
        for character in cluster.nfkc().flat_map(char::to_lowercase) {
            if character.is_whitespace() {
                if !mapped.text.is_empty() {
                    *pending_space = Some(range);
                }
            } else {
                if let Some(space) = pending_space.take() {
                    mapped.text.push(' ');
                    mapped.source.push(space);
                }
                mapped.text.push(character);
                mapped
                    .source
                    .extend(std::iter::repeat_n(range, character.len_utf8()));
            }
        }
    };
    for (index, character) in text.chars().enumerate() {
        let mut first = None;
        decompose_compatible(character, |part| {
            first.get_or_insert(part);
        });
        let first = first.unwrap_or(character);
        // Combining sequences (including halfwidth voiced kana) stay together.
        // Adjacent starters can also compose, notably Hangul L/V/T Jamo.
        if !cluster.is_empty()
            && canonical_combining_class(first) == 0
            && cluster
                .nfkc()
                .last()
                .and_then(|last| compose(last, first))
                .is_none()
        {
            append(
                &cluster,
                MatchRange { start, end },
                &mut mapped,
                &mut pending_space,
            );
            cluster.clear();
            start = index;
        }
        cluster.push(character);
        end = index + 1;
    }
    append(
        &cluster,
        MatchRange { start, end },
        &mut mapped,
        &mut pending_space,
    );
    mapped
}

pub(super) fn matches(text: &str, terms: &[&str]) -> Vec<MatchRange> {
    let mapped = normalize_mapped(text);
    matches_within(&mapped, terms, 0, text.chars().count())
}

fn source_range(mapped: &MappedText, start: usize, end: usize) -> MatchRange {
    let source = &mapped.source[start..end];
    MatchRange {
        start: source.iter().map(|range| range.start).min().unwrap(),
        end: source.iter().map(|range| range.end).max().unwrap(),
    }
}

fn matches_within(
    mapped: &MappedText,
    terms: &[&str],
    window_start: usize,
    window_end: usize,
) -> Vec<MatchRange> {
    let mut ranges = Vec::new();
    for term in terms {
        // Advance one scalar, rather than one match, to retain overlapping hits.
        let mut offset = 0;
        while let Some(found) = mapped.text[offset..].find(term) {
            let start = offset + found;
            let end = start + term.len();
            let range = source_range(mapped, start, end);
            if range.start >= window_end {
                break;
            }
            if range.start >= window_start && range.end <= window_end {
                ranges.push(range);
            }
            offset = start + mapped.text[start..].chars().next().unwrap().len_utf8();
        }
    }
    ranges.sort_by_key(|range| (range.start, range.end));
    let mut merged: Vec<MatchRange> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut().filter(|last| range.start <= last.end) {
            last.end = last.end.max(range.end);
        } else {
            merged.push(range);
        }
    }
    merged
}

pub(super) fn snippet(body: &str, terms: &[&str]) -> (String, Vec<MatchRange>) {
    const MAX_SNIPPET: usize = 240;
    let mapped = normalize_mapped(body);
    let first = terms
        .iter()
        .filter_map(|term| {
            mapped
                .text
                .find(term)
                .map(|start| source_range(&mapped, start, start + term.len()))
        })
        .min_by_key(|range| (range.start, range.end));
    let characters: Vec<_> = body.chars().collect();
    // Keep at most 40 characters before the first body match so it stays near
    // the visible beginning. The 240-character budget includes omission marks.
    let start = first.map_or(0, |range| range.start.saturating_sub(40));
    let prefix = usize::from(start > 0);
    let available = MAX_SNIPPET - prefix;
    let suffix = usize::from(characters.len().saturating_sub(start) > available);
    let end = (start + available - suffix).min(characters.len());
    let mut excerpt = String::new();
    if prefix > 0 {
        excerpt.push('…');
    }
    excerpt.extend(characters[start..end].iter());
    if suffix > 0 {
        excerpt.push('…');
    }
    let visible = matches_within(&mapped, terms, start, end)
        .into_iter()
        .filter_map(|range| {
            // Never mark a clipped normalization cluster as a complete match.
            (range.start >= start && range.end <= end).then_some(MatchRange {
                start: range.start.saturating_sub(start) + prefix,
                end: range.end.saturating_sub(start) + prefix,
            })
        })
        .collect();
    (excerpt, visible)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::extract::normalize_search;

    #[test]
    fn normalized_ranges_cover_width_composition_expansion_and_overlap() {
        for (text, query, expected) in [
            ("😀ＲＵＳＴ", "rust", (1, 5)),
            ("Cafe\u{301}", "café", (0, 5)),
            ("ｶﾞ", "ガ", (0, 2)),
            ("㍍", "メートル", (0, 1)),
            ("ﬃ", "fi", (0, 1)),
            ("İ", "i\u{307}", (0, 1)),
            ("\u{1100}\u{1161}\u{11a8}", "각", (0, 3)),
            ("aaaa", "aaa", (0, 4)),
        ] {
            let query = normalize_search(query);
            assert_eq!(normalize_mapped(text).text, normalize_search(text));
            assert_eq!(
                matches(text, &[&query]),
                vec![MatchRange {
                    start: expected.0,
                    end: expected.1
                }],
                "{text}"
            );
        }
        assert_eq!(
            matches("東京都 ＲＵＳＴ", &["東京", "京都", "rust"]),
            vec![
                MatchRange { start: 0, end: 3 },
                MatchRange { start: 4, end: 8 }
            ]
        );
    }

    #[test]
    fn mapped_normalization_agrees_for_unicode_and_reordered_combining_sequences() {
        for scalar in 0..=0x10ffff {
            if let Some(character) = char::from_u32(scalar) {
                let text = format!(" A{character}\u{301}\u{323} Z ");
                assert_eq!(
                    normalize_mapped(&text).text,
                    normalize_search(&text),
                    "U+{scalar:04X}"
                );
            }
        }
        for text in [
            "\u{301}A",
            "A\u{301}\u{323}",
            "a \t\n b",
            "\u{1100}\u{1161}\u{11a8}",
            "ﷺ",
            "\u{a0} x \u{a0}",
        ] {
            assert_eq!(normalize_mapped(text).text, normalize_search(text));
        }
    }

    #[test]
    fn snippets_are_bounded_and_do_not_invent_body_matches() {
        let body = format!("{}Cafe\u{301}{}", "前".repeat(600), "後".repeat(400));
        let (excerpt, ranges) = snippet(&body, &["café"]);
        assert_eq!(excerpt.chars().count(), 240);
        assert!(excerpt.starts_with('…') && excerpt.ends_with('…'));
        assert_eq!(ranges, vec![MatchRange { start: 41, end: 46 }]);
        let (_, ranges) = snippet(&body, &["path-only"]);
        assert!(ranges.is_empty());
        let (excerpt, ranges) = snippet(&"a".repeat(65_536), &["a", "aa"]);
        assert_eq!(excerpt.chars().count(), 240);
        assert_eq!(ranges, vec![MatchRange { start: 0, end: 239 }]);
        let (_, ranges) = snippet(&"a".repeat(300), &[&"a".repeat(256)]);
        assert!(ranges.is_empty());
        assert_eq!(
            snippet("短い本文", &["本文"]),
            ("短い本文".into(), vec![MatchRange { start: 2, end: 4 }])
        );
    }
}
