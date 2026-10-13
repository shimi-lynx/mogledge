//! Bounded, inert HTML text extraction. This tokenizes HTML without building a DOM,
//! loading resources, evaluating scripts, or attempting CSS visibility inference.

use std::cell::RefCell;

use html5ever::tendril::StrTendril;
use html5ever::tokenizer::states::RawKind;
use html5ever::tokenizer::{BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer};
use unicode_normalization::UnicodeNormalization;

const MAX_TITLE_CHARS: usize = 512;
const MAX_HEADING_CHARS: usize = 8_192;
pub(super) const MAX_TEXT_CHARS: usize = 65_536;
const INPUT_CHUNK_BYTES: usize = 16_384;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Extracted {
    pub title: String,
    pub headings: String,
    pub body: String,
    pub truncated: bool,
}

/// The caller enforces the file byte limit and decodes the document as UTF-8.
pub(super) fn extract(html: &str) -> Extracted {
    let tokenizer = Tokenizer::new(
        Sink(RefCell::new(Extraction::default())),
        Default::default(),
    );
    let input = BufferQueue::default();
    let mut remaining = html;
    while !remaining.is_empty() {
        let mut end = remaining.len().min(INPUT_CHUNK_BYTES);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        input.push_back(StrTendril::from_slice(&remaining[..end]));
        let _ = tokenizer.feed(&input);
        remaining = &remaining[end..];
    }
    tokenizer.end();
    let state = tokenizer.sink.0.into_inner();
    Extracted {
        truncated: state.title.truncated || state.headings.truncated || state.body.truncated,
        title: state.title.text,
        headings: state.headings.text,
        body: state.body.text,
    }
}

/// Shared normalization for indexed text and literal search queries. Japanese
/// remains unsegmented; width variants, composed characters, and case normalize.
pub(super) fn normalize_search(text: &str) -> String {
    let mut normalized = String::new();
    let mut space = false;
    for character in text.nfkc().flat_map(char::to_lowercase) {
        if character.is_whitespace() {
            space = !normalized.is_empty();
        } else {
            if space {
                normalized.push(' ');
                space = false;
            }
            normalized.push(character);
        }
    }
    normalized
}

struct BoundedText {
    text: String,
    characters: usize,
    limit: usize,
    pending_space: bool,
    truncated: bool,
}

impl BoundedText {
    fn new(limit: usize) -> Self {
        Self {
            text: String::new(),
            characters: 0,
            limit,
            pending_space: false,
            truncated: false,
        }
    }

    fn separate(&mut self) {
        self.pending_space = !self.text.is_empty();
    }

    fn append(&mut self, text: &str) {
        for character in text.chars() {
            if character.is_whitespace() {
                self.separate();
                continue;
            }
            let needed = 1 + usize::from(self.pending_space);
            if self.characters + needed > self.limit {
                self.truncated = true;
                // Keep a complete prefix: a separator cannot fit without its
                // following character. Never resume after a dropped character.
                return;
            }
            if self.truncated {
                return;
            }
            if self.pending_space {
                self.text.push(' ');
                self.pending_space = false;
            }
            self.text.push(character);
            self.characters += needed;
        }
    }
}

struct Extraction {
    title: BoundedText,
    headings: BoundedText,
    body: BoundedText,
    template_depth: usize,
    suppressed_raw: Option<String>,
    in_title: bool,
    first_title: bool,
    title_seen: bool,
    in_heading: bool,
    in_head: bool,
}

impl Default for Extraction {
    fn default() -> Self {
        Self {
            title: BoundedText::new(MAX_TITLE_CHARS),
            headings: BoundedText::new(MAX_HEADING_CHARS),
            body: BoundedText::new(MAX_TEXT_CHARS),
            template_depth: 0,
            suppressed_raw: None,
            in_title: false,
            first_title: false,
            title_seen: false,
            in_heading: false,
            in_head: false,
        }
    }
}

struct Sink(RefCell<Extraction>);

impl TokenSink for Sink {
    type Handle = ();

    fn process_token(&self, token: Token, _line_number: u64) -> TokenSinkResult<()> {
        let mut state = self.0.borrow_mut();
        match token {
            Token::CharacterTokens(text) => {
                if state.template_depth == 0 && state.suppressed_raw.is_none() {
                    if state.in_title {
                        if state.first_title {
                            state.title.append(&text);
                        }
                    } else if !state.in_head {
                        state.body.append(&text);
                        if state.in_heading {
                            state.headings.append(&text);
                        }
                    }
                }
            }
            Token::TagToken(tag) => {
                let name = tag.name.as_ref();
                let start = tag.kind == TagKind::StartTag;
                if let Some(suppressed) = &state.suppressed_raw {
                    if !start && suppressed == name {
                        state.suppressed_raw = None;
                    }
                    return TokenSinkResult::Continue;
                }
                if start {
                    let raw = match name {
                        "script" => Some(RawKind::ScriptData),
                        "textarea" => Some(RawKind::Rcdata),
                        "style" | "noscript" | "iframe" | "noembed" => Some(RawKind::Rawtext),
                        _ => None,
                    };
                    if let Some(raw) = raw {
                        state.suppressed_raw = Some(name.to_owned());
                        return TokenSinkResult::RawData(raw);
                    }
                }
                if name == "template" {
                    if start {
                        state.template_depth = state.template_depth.saturating_add(1);
                    } else {
                        state.template_depth = state.template_depth.saturating_sub(1);
                    }
                }
                if state.template_depth != 0 {
                    // Raw text modes must still apply inside an excluded
                    // template: apparent closing tags are literal content and
                    // must not prematurely release the exclusion boundary.
                    return match (start, name) {
                        (true, "title") => TokenSinkResult::RawData(RawKind::Rcdata),
                        (true, "xmp") => TokenSinkResult::RawData(RawKind::Rawtext),
                        (true, "plaintext") => TokenSinkResult::Plaintext,
                        _ => TokenSinkResult::Continue,
                    };
                }
                match name {
                    "title" => {
                        state.in_title = start;
                        if start {
                            state.first_title = !state.title_seen;
                            state.title_seen = true;
                            return TokenSinkResult::RawData(RawKind::Rcdata);
                        }
                    }
                    "head" => state.in_head = start,
                    "body" if start => state.in_head = false,
                    "xmp" if start => return TokenSinkResult::RawData(RawKind::Rawtext),
                    "plaintext" if start => return TokenSinkResult::Plaintext,
                    "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                        state.in_heading = start;
                        state.headings.separate();
                    }
                    _ => {}
                }
                if is_block_boundary(name) {
                    state.body.separate();
                    if state.in_heading {
                        state.headings.separate();
                    }
                }
            }
            // Comments, attributes, doctypes and parser diagnostics are not text.
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

fn is_block_boundary(name: &str) -> bool {
    matches!(
        name,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "br"
            | "caption"
            | "dd"
            | "details"
            | "div"
            | "dl"
            | "dt"
            | "fieldset"
            | "figcaption"
            | "figure"
            | "footer"
            | "form"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "hr"
            | "li"
            | "main"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "summary"
            | "table"
            | "td"
            | "th"
            | "tr"
            | "ul"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_title_headings_body_and_decodes_entities() {
        let result = extract(
            "<!doctype html><head><title> A &amp; 日本語 &#x1F600; </title></head>\
             <body><h1>第一<b>章</b></h1><p>A&nbsp; B &lt;x&gt;</p><h2>次へ</h2></body>",
        );
        assert_eq!(result.title, "A & 日本語 😀");
        assert_eq!(result.headings, "第一章 次へ");
        assert_eq!(result.body, "第一章 A B <x> 次へ");
        assert!(!result.truncated);
    }

    #[test]
    fn ignores_comments_attributes_and_inactive_content() {
        let result = extract(
            "<p data-secret='attribute'>visible</p><!-- secret -->\
             <script>let text = '<h1>secret</h1>'; if (1 < 2) {}</script>\
             <style>.secret { content: '<p>secret</p>'; }</style>\
             <template><h1>secret</h1><template>nested</template><script>secret</script></template>\
             <noscript><p>secret</p></noscript><p>after</p>",
        );
        assert_eq!(result.body, "visible after");
        assert!(result.title.is_empty());
        assert!(result.headings.is_empty());
    }

    #[test]
    fn does_not_index_form_values_or_textarea_content() {
        let result = extract("<input type='password' value='secret'><input value='another'><textarea>private &amp; &lt;/textarea&gt;</textarea><p>public</p>");
        assert_eq!(result.body, "public");
        assert!(!result.truncated);
    }

    #[test]
    fn respects_rcdata_inside_excluded_templates() {
        let result = extract(
            "<template><title>literal </template> text</title>private</template><p>public</p>",
        );
        assert_eq!(result.body, "public");
        assert!(result.title.is_empty());
    }

    #[test]
    fn respects_rawtext_inside_excluded_templates() {
        let result = extract(
            "<template><xmp></template>hidden_template_sentinel</xmp></template><p>public</p>",
        );
        assert_eq!(result.body, "public");
        assert!(result.title.is_empty());
        assert!(result.headings.is_empty());
    }

    #[test]
    fn plaintext_inside_excluded_template_keeps_the_remainder_excluded() {
        let result = extract("<p>before</p><template><plaintext></template>hidden_template_sentinel</plaintext></template><p>also excluded</p>");
        assert_eq!(result.body, "before");
        assert!(result.title.is_empty());
        assert!(result.headings.is_empty());
    }

    #[test]
    fn preserves_inline_words_and_separates_blocks() {
        let result = extract("Hel<em>lo</em><br>world<p>one</p><div>two</div><table><tr><td>A</td><td>B</td></tr></table>");
        assert_eq!(result.body, "Hello world one two A B");
    }

    #[test]
    fn handles_partial_html_and_unicode_chunk_boundaries() {
        let repeated = "あ".repeat(INPUT_CHUNK_BYTES);
        let result = extract(&format!("<h1>日本語 &amp; {repeated}"));
        assert_eq!(result.body, format!("日本語 & {repeated}"));
        assert_eq!(result.headings.chars().count(), MAX_HEADING_CHARS);
        assert!(result.truncated);
        assert_eq!(extract("<p>malformed <b>still").body, "malformed still");
    }

    #[test]
    fn empty_and_unclosed_suppressed_documents_have_no_text() {
        assert_eq!(
            extract(""),
            Extracted {
                title: String::new(),
                headings: String::new(),
                body: String::new(),
                truncated: false
            }
        );
        assert!(extract("<script>secret <p>still secret").body.is_empty());
        assert!(extract("<template>secret").body.is_empty());
        assert!(extract("<head><meta name=x>ignored</head>").body.is_empty());
    }

    #[test]
    fn title_uses_rcdata_and_only_first_title() {
        let result =
            extract("<title>one <b>literal</b> &amp;</title><title>two</title><p>body</p>");
        assert_eq!(result.title, "one <b>literal</b> &");
        assert_eq!(result.body, "body");
    }

    #[test]
    fn text_caps_are_unicode_safe_and_report_dropped_text() {
        let exact = "😀".repeat(MAX_TEXT_CHARS);
        let result = extract(&format!("<p>{exact} </p>"));
        assert_eq!(result.body, exact);
        assert!(!result.truncated);
        let result = extract(&format!("<p>{exact}追加</p>"));
        assert_eq!(result.body.chars().count(), MAX_TEXT_CHARS);
        assert!(result.truncated);
        let result = extract(&format!(
            "<title>{}</title>",
            "題".repeat(MAX_TITLE_CHARS + 1)
        ));
        assert_eq!(result.title.chars().count(), MAX_TITLE_CHARS);
        assert!(result.truncated);
    }

    #[test]
    fn normalizes_width_composition_case_and_whitespace() {
        assert_eq!(
            normalize_search(" \tＡＢＣ　ﾆﾎﾝｺﾞ\nCafe\u{301}  "),
            "abc ニホンゴ café"
        );
        assert_eq!(normalize_search("情報検索"), "情報検索");
        assert_eq!(normalize_search("  \n"), "");
    }
}
