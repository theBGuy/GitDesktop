//! Markdown → Atlassian Document Format (ADF).
//!
//! The write-path counterpart to [`super::adf`]: it turns the markdown a user types
//! (in a comment, or an issue description) into the ADF JSON document Jira's write
//! endpoints require. It covers the same subset the reader renders, kept symmetric where
//! it matters: paragraphs, headings (`#`..`######`), bullet + ordered lists (nested by
//! two-space indent), fenced code blocks, and the inline marks `**strong**`, `*em*` /
//! `_em_`, `` `code` ``, `[text](url)`, `~~strike~~`.
//!
//! Two hard rules:
//! 1. **Never drop content, never panic.** An unsupported construct degrades to plain
//!    text rather than vanishing — the block still ships as a paragraph.
//! 2. **The top-level `content` array is never empty.** Jira rejects an empty document
//!    (`content: []`); empty or whitespace-only input yields a single empty paragraph
//!    node so the request still validates.

use serde_json::{json, Value};

/// Convert a markdown string into an ADF document `Value` (`{type:"doc", version:1,
/// content:[…]}`). Pure and total: any input produces a valid document, and the
/// top-level `content` is guaranteed non-empty (empty/whitespace input → one empty
/// paragraph).
pub fn markdown_to_adf(md: &str) -> Value {
    let mut content = parse_blocks(md);
    if content.is_empty() {
        // Jira rejects an empty top-level content array — emit one empty paragraph.
        content.push(empty_paragraph());
    }
    json!({ "type": "doc", "version": 1, "content": content })
}

/// An empty paragraph node (`{type:"paragraph"}` with no content) — the safe filler that
/// keeps a document's `content` non-empty.
fn empty_paragraph() -> Value {
    json!({ "type": "paragraph" })
}

/// A paragraph node wrapping the given inline nodes. An empty inline vec collapses to an
/// empty paragraph (rather than `content: []`, which Jira also rejects on a paragraph).
fn paragraph(inlines: Vec<Value>) -> Value {
    if inlines.is_empty() {
        empty_paragraph()
    } else {
        json!({ "type": "paragraph", "content": inlines })
    }
}

/// Parse a whole markdown document into a vec of ADF block nodes. Blocks are separated by
/// blank lines; fenced code blocks and list runs are recognised structurally, everything
/// else becomes a paragraph (a heading line becomes a heading node).
fn parse_blocks(md: &str) -> Vec<Value> {
    // Normalise line endings so a CRLF document parses identically to an LF one.
    let normalized = md.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.lines().collect();
    let mut blocks: Vec<Value> = Vec::new();
    let mut i = 0usize;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        // Blank line — a block separator; skip it.
        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        // Fenced code block: a line of ``` optionally followed by a language, running to
        // the next ``` fence (or end of input). Content is verbatim (no inline parsing).
        if let Some(lang) = fence_lang(trimmed) {
            let (node, next) = parse_code_fence(&lines, i, lang);
            blocks.push(node);
            i = next;
            continue;
        }

        // Heading: 1..6 leading `#` then a space.
        if let Some((level, text)) = heading_parts(line) {
            blocks.push(json!({
                "type": "heading",
                "attrs": { "level": level },
                "content": parse_inline(text),
            }));
            i += 1;
            continue;
        }

        // List run: a maximal block of consecutive lines each of which is a list item
        // (bullet or ordered), possibly indented for nesting.
        if list_marker(line).is_some() {
            let (node, next) = parse_list(&lines, i, 0);
            blocks.push(node);
            i = next;
            continue;
        }

        // Otherwise a paragraph: gather consecutive non-blank, non-structural lines,
        // joining them with hard breaks (a soft newline inside a paragraph).
        let (node, next) = parse_paragraph(&lines, i);
        blocks.push(node);
        i = next;
    }

    blocks
}

/// If `trimmed` opens a code fence (starts with ```), return the (possibly empty)
/// language string that follows the backticks. `None` when it is not a fence line.
fn fence_lang(trimmed: &str) -> Option<&str> {
    trimmed.strip_prefix("```").map(str::trim)
}

/// Parse a fenced code block starting at `start` (the opening fence line). Returns the
/// `codeBlock` node and the index just past the closing fence (or past end-of-input if
/// the fence is unterminated). Content lines are taken verbatim.
fn parse_code_fence(lines: &[&str], start: usize, lang: &str) -> (Value, usize) {
    let mut code_lines: Vec<&str> = Vec::new();
    let mut i = start + 1;
    while i < lines.len() {
        if lines[i].trim().starts_with("```") {
            i += 1; // consume the closing fence
            break;
        }
        code_lines.push(lines[i]);
        i += 1;
    }
    let code = code_lines.join("\n");
    let mut attrs = serde_json::Map::new();
    if !lang.is_empty() {
        attrs.insert("language".to_string(), json!(lang));
    }
    // A codeBlock's content is a single text node; an empty block has no content.
    let node = if code.is_empty() {
        json!({ "type": "codeBlock", "attrs": attrs })
    } else {
        json!({
            "type": "codeBlock",
            "attrs": attrs,
            "content": [ { "type": "text", "text": code } ],
        })
    };
    (node, i)
}

/// Split a heading line into `(level, text)` when it is `#`..`######` followed by a
/// space. Leading indentation disqualifies it (that would be code/paragraph). Pure.
fn heading_parts(line: &str) -> Option<(u64, &str)> {
    // A heading marker sits at column 0 (no leading whitespace).
    if line.starts_with(char::is_whitespace) {
        return None;
    }
    let hashes = line.len() - line.trim_start_matches('#').len();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    // Require a space after the hashes (so `#no-space` is a paragraph, not a heading).
    let text = rest.strip_prefix(' ')?;
    Some((hashes as u64, text.trim_end()))
}

/// A recognised list marker on a line: `(indent_spaces, ordered)`. Bullet markers are
/// `-`, `*`, `+`; ordered markers are `<digits>.` or `<digits>)`. `None` when the line is
/// not a list item. Pure.
fn list_marker(line: &str) -> Option<ListMarker> {
    let indent = line.len() - line.trim_start().len();
    // Only spaces count as indentation for nesting (tabs are treated as one space-equiv
    // by trim, but we key nesting off the leading-space count).
    let content = &line[indent..];
    // Bullet: one of - * + then a space.
    for bullet in ['-', '*', '+'] {
        if let Some(rest) = content.strip_prefix(bullet) {
            if rest.starts_with(' ') {
                return Some(ListMarker {
                    indent,
                    ordered: false,
                    text_start: indent + 1 + leading_space_len(rest),
                });
            }
        }
    }
    // Ordered: digits then `.` or `)` then a space.
    let digits: String = content.chars().take_while(char::is_ascii_digit).collect();
    if !digits.is_empty() {
        let after = &content[digits.len()..];
        for sep in ['.', ')'] {
            if let Some(rest) = after.strip_prefix(sep) {
                if rest.starts_with(' ') {
                    return Some(ListMarker {
                        indent,
                        ordered: true,
                        text_start: indent + digits.len() + 1 + leading_space_len(rest),
                    });
                }
            }
        }
    }
    None
}

/// The number of leading spaces in `s` (after a marker, before the item text).
fn leading_space_len(s: &str) -> usize {
    s.len() - s.trim_start_matches(' ').len()
}

/// A parsed list marker: its indentation, whether it is ordered, and where the item text
/// begins on the line.
#[derive(Clone, Copy)]
struct ListMarker {
    indent: usize,
    ordered: bool,
    text_start: usize,
}

/// Parse a list run starting at `start`, at the given `base_indent` (the indentation of
/// this list's own items). Returns the `bulletList`/`orderedList` node and the index of
/// the first line that is not part of this list. Nested lists (more-indented items)
/// recurse. The list's kind is taken from its first item.
fn parse_list(lines: &[&str], start: usize, base_indent: usize) -> (Value, usize) {
    let first = list_marker(lines[start]).expect("parse_list called on a non-list line");
    let ordered = first.ordered;
    let this_indent = first.indent.max(base_indent);
    let mut items: Vec<Value> = Vec::new();
    let mut i = start;

    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            // A blank line ends the list run (we don't model loose lists).
            break;
        }
        let Some(marker) = list_marker(line) else {
            break;
        };
        // A marker indented less than this list belongs to an ancestor list — stop.
        if marker.indent < this_indent {
            break;
        }
        // A marker indented more than this list is handled as a nested list under the
        // current item (below), not as a sibling — so a sibling must match this indent.
        if marker.indent > this_indent {
            // Defensive: a deeper marker with no preceding shallower item at this indent.
            // Treat it as starting a nested list absorbed by the previous item if any,
            // else start this list at the deeper indent.
            if items.is_empty() {
                let (node, next) = parse_list(lines, i, marker.indent);
                return (node, next);
            }
            break;
        }

        // This line is an item at our level. Its text is the inline content after the
        // marker; a following run of more-indented list lines becomes a nested list.
        let text = &line[marker.text_start.min(line.len())..];
        let mut item_content: Vec<Value> = vec![paragraph(parse_inline(text))];
        i += 1;

        // Absorb a nested list: consecutive following lines whose marker indent is
        // greater than this item's indent.
        if i < lines.len() {
            if let Some(next_marker) = list_marker(lines[i]) {
                if next_marker.indent > this_indent {
                    let (nested, next) = parse_list(lines, i, next_marker.indent);
                    item_content.push(nested);
                    i = next;
                }
            }
        }

        items.push(json!({ "type": "listItem", "content": item_content }));
    }

    let list_type = if ordered { "orderedList" } else { "bulletList" };
    (json!({ "type": list_type, "content": items }), i)
}

/// Parse a paragraph starting at `start`: gather consecutive lines until a blank line or
/// a structural line (heading / list / fence). Multiple gathered lines join with a
/// `hardBreak` (a soft line break inside one paragraph). Returns the node and the next
/// index.
fn parse_paragraph(lines: &[&str], start: usize) -> (Value, usize) {
    let mut inlines: Vec<Value> = Vec::new();
    let mut i = start;
    let mut first = true;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        // Stop at a line that opens a different block type.
        if i != start
            && (fence_lang(trimmed).is_some()
                || heading_parts(line).is_some()
                || list_marker(line).is_some())
        {
            break;
        }
        if !first {
            inlines.push(json!({ "type": "hardBreak" }));
        }
        inlines.extend(parse_inline(line.trim_end()));
        first = false;
        i += 1;
    }
    (paragraph(inlines), i)
}

// ── Inline parsing ─────────────────────────────────────────────────────────────

/// The mark set applied to a run of text.
#[derive(Clone, Default, PartialEq)]
struct Marks {
    strong: bool,
    em: bool,
    code: bool,
    strike: bool,
    link: Option<String>,
}

impl Marks {
    /// Build the ADF `marks` array for this set, or `None` when there are no marks.
    fn to_adf(&self) -> Option<Value> {
        let mut arr: Vec<Value> = Vec::new();
        if self.strong {
            arr.push(json!({ "type": "strong" }));
        }
        if self.em {
            arr.push(json!({ "type": "em" }));
        }
        if self.code {
            arr.push(json!({ "type": "code" }));
        }
        if self.strike {
            arr.push(json!({ "type": "strike" }));
        }
        if let Some(href) = &self.link {
            arr.push(json!({ "type": "link", "attrs": { "href": href } }));
        }
        if arr.is_empty() {
            None
        } else {
            Some(Value::Array(arr))
        }
    }
}

/// Parse a single line of markdown into inline ADF text nodes, applying the supported
/// marks. Unsupported syntax degrades to literal text — nothing is dropped. An empty
/// input yields an empty vec (the caller decides whether that becomes an empty paragraph).
fn parse_inline(text: &str) -> Vec<Value> {
    let tokens = tokenize_inline(text, Marks::default());
    coalesce(tokens)
}

/// A resolved run of text with its marks.
struct Run {
    text: String,
    marks: Marks,
}

/// Tokenise `text` under the ambient `marks`, recursing into delimiter spans. `code`
/// spans are terminal (no nested marks parsed inside them). Order of precedence: code
/// first (so `` `**x**` `` stays literal), then links, then strong (`**`), then strike
/// (`~~`), then em (`*`/`_`).
fn tokenize_inline(text: &str, marks: Marks) -> Vec<Run> {
    if text.is_empty() {
        return Vec::new();
    }
    // Inside a code span, no further marks are parsed — emit the whole text verbatim.
    if marks.code {
        return vec![Run {
            text: text.to_string(),
            marks,
        }];
    }

    let bytes = text.as_bytes();
    let mut i = 0usize;
    let mut plain = String::new();
    let mut out: Vec<Run> = Vec::new();

    // Flush accumulated plain text as a run under the ambient marks.
    macro_rules! flush_plain {
        () => {
            if !plain.is_empty() {
                out.push(Run {
                    text: std::mem::take(&mut plain),
                    marks: marks.clone(),
                });
            }
        };
    }

    while i < bytes.len() {
        // Backtick code span: `code` — highest precedence, verbatim contents.
        if bytes[i] == b'`' {
            if let Some((inner, next)) = match_delim(text, i, "`", "`") {
                flush_plain!();
                let mut m = marks.clone();
                m.code = true;
                out.push(Run {
                    text: inner.to_string(),
                    marks: m,
                });
                i = next;
                continue;
            }
        }

        // Link: [text](url)
        if bytes[i] == b'[' {
            if let Some((label, href, next)) = match_link(text, i) {
                flush_plain!();
                let mut m = marks.clone();
                m.link = Some(href.to_string());
                out.extend(tokenize_inline(label, m));
                i = next;
                continue;
            }
        }

        // Strong: **text**
        if starts_with_at(bytes, i, b"**") {
            if let Some((inner, next)) = match_delim(text, i, "**", "**") {
                flush_plain!();
                let mut m = marks.clone();
                m.strong = true;
                out.extend(tokenize_inline(inner, m));
                i = next;
                continue;
            }
        }

        // Strike: ~~text~~
        if starts_with_at(bytes, i, b"~~") {
            if let Some((inner, next)) = match_delim(text, i, "~~", "~~") {
                flush_plain!();
                let mut m = marks.clone();
                m.strike = true;
                out.extend(tokenize_inline(inner, m));
                i = next;
                continue;
            }
        }

        // Emphasis: *text* or _text_ (single delimiter).
        if bytes[i] == b'*' || bytes[i] == b'_' {
            let delim = &text[i..i + 1];
            if let Some((inner, next)) = match_delim(text, i, delim, delim) {
                flush_plain!();
                let mut m = marks.clone();
                m.em = true;
                out.extend(tokenize_inline(inner, m));
                i = next;
                continue;
            }
        }

        // No delimiter matched here — take one char as literal text. Advance by a full
        // UTF-8 char so multi-byte characters aren't split.
        let ch_len = utf8_len(bytes[i]);
        plain.push_str(&text[i..(i + ch_len).min(text.len())]);
        i += ch_len;
    }

    flush_plain!();
    out
}

/// Whether `bytes[i..]` begins with `needle`.
fn starts_with_at(bytes: &[u8], i: usize, needle: &[u8]) -> bool {
    bytes.len() >= i + needle.len() && &bytes[i..i + needle.len()] == needle
}

/// The byte length of the UTF-8 character whose first byte is `b`.
fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else if b >> 3 == 0b11110 {
        4
    } else {
        1 // continuation/invalid byte: consume one to make progress
    }
}

/// Match a delimited span at `i`: the text opens with `open` and the next occurrence of
/// `close` (after the open) closes it. Returns `(inner_text, index_past_close)`. `None`
/// when there is no closing delimiter (so the opener is treated as literal text) or when
/// the span would be empty.
fn match_delim<'a>(text: &'a str, i: usize, open: &str, close: &str) -> Option<(&'a str, usize)> {
    let content_start = i + open.len();
    if content_start > text.len() {
        return None;
    }
    let rest = &text[content_start..];
    // Find the closing delimiter; an empty span (`**` immediately closed) is not a mark.
    let close_rel = rest.find(close)?;
    if close_rel == 0 {
        return None;
    }
    let inner = &rest[..close_rel];
    let next = content_start + close_rel + close.len();
    Some((inner, next))
}

/// Match a link `[label](url)` at `i`. Returns `(label, href, index_past_close)`. The
/// label may not contain `]`; the url may not contain `)`. `None` when the shape doesn't
/// match, so `[not a link` degrades to literal text.
fn match_link(text: &str, i: usize) -> Option<(&str, &str, usize)> {
    let after_open = &text[i + 1..];
    let close_bracket = after_open.find(']')?;
    let label = &after_open[..close_bracket];
    let after_bracket = &after_open[close_bracket + 1..];
    if !after_bracket.starts_with('(') {
        return None;
    }
    let after_paren = &after_bracket[1..];
    let close_paren = after_paren.find(')')?;
    let href = &after_paren[..close_paren];
    if href.is_empty() {
        return None;
    }
    // Absolute index past the closing paren.
    let next = i + 1 + close_bracket + 1 + 1 + close_paren + 1;
    Some((label, href, next))
}

/// Turn resolved runs into ADF text nodes, merging adjacent runs that share identical
/// marks (so `**a****b**` doesn't emit two separate bold nodes). Empty-text runs are
/// dropped.
fn coalesce(runs: Vec<Run>) -> Vec<Value> {
    let mut merged: Vec<Run> = Vec::new();
    for run in runs {
        if run.text.is_empty() {
            continue;
        }
        if let Some(last) = merged.last_mut() {
            if last.marks == run.marks {
                last.text.push_str(&run.text);
                continue;
            }
        }
        merged.push(run);
    }
    merged
        .into_iter()
        .map(|run| {
            let mut node = serde_json::Map::new();
            node.insert("type".to_string(), json!("text"));
            node.insert("text".to_string(), json!(run.text));
            if let Some(marks) = run.marks.to_adf() {
                node.insert("marks".to_string(), marks);
            }
            Value::Object(node)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::jira::adf::adf_to_markdown;

    /// The top-level content array of a produced document.
    fn content(v: &Value) -> &Vec<Value> {
        v.get("content").and_then(Value::as_array).unwrap()
    }

    #[test]
    fn empty_input_yields_one_empty_paragraph() {
        for input in ["", "   ", "\n\n", "\t  \n  \t"] {
            let doc = markdown_to_adf(input);
            let c = content(&doc);
            assert_eq!(c.len(), 1, "input {input:?}");
            assert_eq!(c[0].get("type").unwrap(), "paragraph");
            // No (or empty) inner content — the safe filler.
            assert!(c[0].get("content").is_none(), "input {input:?}");
        }
    }

    #[test]
    fn top_level_content_never_empty_invariant() {
        // Whatever we feed it, content is a non-empty array (Jira's hard requirement).
        for input in ["", "hello", "```\n```", "- ", "###### h"] {
            let doc = markdown_to_adf(input);
            assert!(!content(&doc).is_empty(), "empty content for {input:?}");
        }
    }

    #[test]
    fn doc_envelope_shape() {
        let doc = markdown_to_adf("hi");
        assert_eq!(doc.get("type").unwrap(), "doc");
        assert_eq!(doc.get("version").unwrap(), 1);
    }

    #[test]
    fn single_paragraph() {
        let doc = markdown_to_adf("Hello world");
        let c = content(&doc);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].get("type").unwrap(), "paragraph");
        let inline = c[0].get("content").and_then(Value::as_array).unwrap();
        assert_eq!(inline[0].get("text").unwrap(), "Hello world");
    }

    #[test]
    fn blank_line_separates_paragraphs() {
        let doc = markdown_to_adf("First\n\nSecond");
        let c = content(&doc);
        assert_eq!(c.len(), 2);
        assert_eq!(
            c[0].get("content").unwrap()[0].get("text").unwrap(),
            "First"
        );
        assert_eq!(
            c[1].get("content").unwrap()[0].get("text").unwrap(),
            "Second"
        );
    }

    #[test]
    fn soft_newline_becomes_hard_break() {
        let doc = markdown_to_adf("line1\nline2");
        let c = content(&doc);
        assert_eq!(c.len(), 1);
        let inline = c[0].get("content").and_then(Value::as_array).unwrap();
        // text, hardBreak, text
        assert_eq!(inline.len(), 3);
        assert_eq!(inline[1].get("type").unwrap(), "hardBreak");
    }

    #[test]
    fn headings_1_through_6() {
        for level in 1..=6usize {
            let md = format!("{} Title", "#".repeat(level));
            let doc = markdown_to_adf(&md);
            let c = content(&doc);
            assert_eq!(c[0].get("type").unwrap(), "heading");
            assert_eq!(
                c[0].get("attrs").unwrap().get("level").unwrap(),
                level as u64
            );
            assert_eq!(
                c[0].get("content").unwrap()[0].get("text").unwrap(),
                "Title"
            );
        }
    }

    #[test]
    fn seven_hashes_is_not_a_heading() {
        let doc = markdown_to_adf("####### too many");
        assert_eq!(content(&doc)[0].get("type").unwrap(), "paragraph");
    }

    #[test]
    fn hash_without_space_is_paragraph() {
        let doc = markdown_to_adf("#nospace");
        assert_eq!(content(&doc)[0].get("type").unwrap(), "paragraph");
    }

    #[test]
    fn bullet_list_dash_star_plus() {
        for bullet in ['-', '*', '+'] {
            let md = format!("{bullet} one\n{bullet} two");
            let doc = markdown_to_adf(&md);
            let c = content(&doc);
            assert_eq!(c[0].get("type").unwrap(), "bulletList");
            let items = c[0].get("content").and_then(Value::as_array).unwrap();
            assert_eq!(items.len(), 2);
            assert_eq!(items[0].get("type").unwrap(), "listItem");
            let para = &items[0].get("content").unwrap()[0];
            assert_eq!(para.get("content").unwrap()[0].get("text").unwrap(), "one");
        }
    }

    #[test]
    fn ordered_list() {
        let doc = markdown_to_adf("1. a\n2. b");
        let c = content(&doc);
        assert_eq!(c[0].get("type").unwrap(), "orderedList");
        let items = c[0].get("content").and_then(Value::as_array).unwrap();
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn ordered_list_paren_separator() {
        let doc = markdown_to_adf("1) a\n2) b");
        assert_eq!(content(&doc)[0].get("type").unwrap(), "orderedList");
    }

    #[test]
    fn nested_list_two_space_indent() {
        let md = "- parent\n  - child";
        let doc = markdown_to_adf(md);
        let c = content(&doc);
        assert_eq!(c[0].get("type").unwrap(), "bulletList");
        let items = c[0].get("content").and_then(Value::as_array).unwrap();
        assert_eq!(items.len(), 1);
        // The parent item holds a paragraph AND a nested bulletList.
        let parent_content = items[0].get("content").and_then(Value::as_array).unwrap();
        assert_eq!(parent_content.len(), 2);
        assert_eq!(parent_content[1].get("type").unwrap(), "bulletList");
        let nested_items = parent_content[1]
            .get("content")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(
            nested_items[0].get("content").unwrap()[0]
                .get("content")
                .unwrap()[0]
                .get("text")
                .unwrap(),
            "child"
        );
    }

    #[test]
    fn fenced_code_block_with_language() {
        let md = "```rust\nfn main() {}\n```";
        let doc = markdown_to_adf(md);
        let c = content(&doc);
        assert_eq!(c[0].get("type").unwrap(), "codeBlock");
        assert_eq!(c[0].get("attrs").unwrap().get("language").unwrap(), "rust");
        assert_eq!(
            c[0].get("content").unwrap()[0].get("text").unwrap(),
            "fn main() {}"
        );
    }

    #[test]
    fn fenced_code_block_without_language() {
        let md = "```\nplain code\n```";
        let doc = markdown_to_adf(md);
        let c = content(&doc);
        assert_eq!(c[0].get("type").unwrap(), "codeBlock");
        assert!(c[0].get("attrs").unwrap().get("language").is_none());
    }

    #[test]
    fn code_block_preserves_markdown_verbatim() {
        // Marks inside a fence are NOT parsed.
        let md = "```\n**not bold** `not code`\n```";
        let doc = markdown_to_adf(md);
        let text = content(&doc)[0].get("content").unwrap()[0]
            .get("text")
            .unwrap()
            .as_str()
            .unwrap()
            .to_string();
        assert!(text.contains("**not bold**"));
    }

    #[test]
    fn unterminated_fence_still_captures() {
        let md = "```\nline1\nline2";
        let doc = markdown_to_adf(md);
        let c = content(&doc);
        assert_eq!(c[0].get("type").unwrap(), "codeBlock");
        assert_eq!(
            c[0].get("content").unwrap()[0].get("text").unwrap(),
            "line1\nline2"
        );
    }

    #[test]
    fn inline_strong_em_code_strike() {
        let doc = markdown_to_adf("**b** *i* `c` ~~s~~");
        let inline = content(&doc)[0]
            .get("content")
            .and_then(Value::as_array)
            .unwrap();
        // Collect (text, first-mark-type) pairs for the marked runs.
        let mark_of = |node: &Value| -> Option<String> {
            node.get("marks")
                .and_then(Value::as_array)
                .and_then(|m| m.first())
                .and_then(|m| m.get("type"))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let b = inline
            .iter()
            .find(|n| n.get("text").unwrap() == "b")
            .unwrap();
        assert_eq!(mark_of(b).unwrap(), "strong");
        let i = inline
            .iter()
            .find(|n| n.get("text").unwrap() == "i")
            .unwrap();
        assert_eq!(mark_of(i).unwrap(), "em");
        let cc = inline
            .iter()
            .find(|n| n.get("text").unwrap() == "c")
            .unwrap();
        assert_eq!(mark_of(cc).unwrap(), "code");
        let s = inline
            .iter()
            .find(|n| n.get("text").unwrap() == "s")
            .unwrap();
        assert_eq!(mark_of(s).unwrap(), "strike");
    }

    #[test]
    fn underscore_emphasis() {
        let doc = markdown_to_adf("_italic_");
        let inline = content(&doc)[0].get("content").unwrap();
        assert_eq!(inline[0].get("text").unwrap(), "italic");
        assert_eq!(
            inline[0].get("marks").unwrap()[0].get("type").unwrap(),
            "em"
        );
    }

    #[test]
    fn link_produces_link_mark() {
        let doc = markdown_to_adf("see [the site](https://example.com) now");
        let inline = content(&doc)[0]
            .get("content")
            .and_then(Value::as_array)
            .unwrap();
        let link = inline
            .iter()
            .find(|n| n.get("text").unwrap() == "the site")
            .unwrap();
        let mark = &link.get("marks").unwrap()[0];
        assert_eq!(mark.get("type").unwrap(), "link");
        assert_eq!(
            mark.get("attrs").unwrap().get("href").unwrap(),
            "https://example.com"
        );
    }

    #[test]
    fn link_with_empty_href_degrades_to_text() {
        let doc = markdown_to_adf("[label]()");
        let inline = content(&doc)[0]
            .get("content")
            .and_then(Value::as_array)
            .unwrap();
        // The whole thing is literal text — no link mark.
        let joined: String = inline
            .iter()
            .map(|n| n.get("text").unwrap().as_str().unwrap())
            .collect();
        assert_eq!(joined, "[label]()");
    }

    #[test]
    fn nested_marks_strong_containing_code() {
        // **bold `code`** — bold wraps a code span; the code run keeps BOTH marks.
        let doc = markdown_to_adf("**bold `code`**");
        let inline = content(&doc)[0]
            .get("content")
            .and_then(Value::as_array)
            .unwrap();
        let code_run = inline
            .iter()
            .find(|n| n.get("text").unwrap() == "code")
            .unwrap();
        let types: Vec<String> = code_run
            .get("marks")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .map(|m| m.get("type").unwrap().as_str().unwrap().to_string())
            .collect();
        assert!(types.contains(&"strong".to_string()));
        assert!(types.contains(&"code".to_string()));
    }

    #[test]
    fn code_span_content_is_literal() {
        // Inside a code span the `**` is NOT a strong delimiter.
        let doc = markdown_to_adf("`**x**`");
        let inline = content(&doc)[0].get("content").unwrap();
        assert_eq!(inline[0].get("text").unwrap(), "**x**");
        assert_eq!(
            inline[0].get("marks").unwrap()[0].get("type").unwrap(),
            "code"
        );
    }

    #[test]
    fn unterminated_delimiter_is_literal() {
        let doc = markdown_to_adf("a **b c");
        let inline = content(&doc)[0]
            .get("content")
            .and_then(Value::as_array)
            .unwrap();
        let joined: String = inline
            .iter()
            .map(|n| n.get("text").unwrap().as_str().unwrap())
            .collect();
        assert_eq!(joined, "a **b c");
        // No marks emitted.
        assert!(inline.iter().all(|n| n.get("marks").is_none()));
    }

    #[test]
    fn empty_delimiter_not_a_mark() {
        // `****` is not bold-of-empty; it degrades to literal text.
        let doc = markdown_to_adf("x**** y");
        let inline = content(&doc)[0]
            .get("content")
            .and_then(Value::as_array)
            .unwrap();
        let joined: String = inline
            .iter()
            .map(|n| n.get("text").unwrap().as_str().unwrap())
            .collect();
        assert!(joined.contains("****"));
    }

    #[test]
    fn multibyte_text_not_split() {
        // A run with emoji / accented chars must not panic or corrupt bytes.
        let doc = markdown_to_adf("café 🚀 **bold**");
        let inline = content(&doc)[0]
            .get("content")
            .and_then(Value::as_array)
            .unwrap();
        let joined: String = inline
            .iter()
            .map(|n| n.get("text").unwrap().as_str().unwrap())
            .collect();
        assert!(joined.contains("café 🚀 "));
        assert!(joined.contains("bold"));
    }

    #[test]
    fn adjacent_same_mark_runs_coalesce() {
        // Two bold spans back-to-back merge into one text node.
        let doc = markdown_to_adf("**a****b**");
        let inline = content(&doc)[0]
            .get("content")
            .and_then(Value::as_array)
            .unwrap();
        let bold_runs: Vec<&Value> = inline
            .iter()
            .filter(|n| {
                n.get("marks")
                    .and_then(Value::as_array)
                    .map(|m| !m.is_empty())
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(bold_runs.len(), 1);
        assert_eq!(bold_runs[0].get("text").unwrap(), "ab");
    }

    // ── Round-trip sanity (markdown_to_adf → adf_to_markdown) ────────────────────

    fn round_trip(md: &str) -> String {
        adf_to_markdown(&markdown_to_adf(md))
    }

    #[test]
    fn round_trip_paragraph() {
        assert_eq!(round_trip("Hello world"), "Hello world");
    }

    #[test]
    fn round_trip_two_paragraphs() {
        assert_eq!(round_trip("First\n\nSecond"), "First\n\nSecond");
    }

    #[test]
    fn round_trip_heading() {
        assert_eq!(round_trip("## Title"), "## Title");
    }

    #[test]
    fn round_trip_bullet_list() {
        assert_eq!(round_trip("- one\n- two"), "- one\n- two");
    }

    #[test]
    fn round_trip_ordered_list() {
        assert_eq!(round_trip("1. a\n2. b"), "1. a\n2. b");
    }

    #[test]
    fn round_trip_nested_list() {
        assert_eq!(round_trip("- parent\n  - child"), "- parent\n  - child");
    }

    #[test]
    fn round_trip_code_block() {
        assert_eq!(
            round_trip("```rust\nfn main() {}\n```"),
            "```rust\nfn main() {}\n```"
        );
    }

    #[test]
    fn round_trip_inline_marks() {
        assert_eq!(round_trip("**b** *i* `c` ~~s~~"), "**b** *i* `c` ~~s~~");
    }

    #[test]
    fn round_trip_link() {
        assert_eq!(
            round_trip("[site](https://example.com)"),
            "[site](https://example.com)"
        );
    }
}
