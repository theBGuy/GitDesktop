//! Atlassian Document Format (ADF) → Markdown.
//!
//! Jira issue/comment bodies are ADF — a JSON document tree, not markdown
//! ([structure docs](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/)).
//! We convert the read-path subset the app renders through its existing Markdown
//! component: paragraphs, headings, lists (nested), code blocks, blockquotes, rules,
//! hard breaks, plus text marks (bold/italic/code/strike/link) and a few inline node
//! types (mention/emoji/inlineCard).
//!
//! The one hard rule: **never panic, never drop the whole doc**. An unknown node type
//! degrades to its text content (recursing into `content`), so a document that mixes a
//! supported node with a novel one still renders everything it can. Every field access
//! is defensive — a malformed tree yields a best-effort string, not an error.

use serde_json::Value;

/// Convert an ADF document value to markdown. An empty/null/non-object value yields an
/// empty string. Top-level entry point: walk the document's block `content`, joining
/// blocks with blank lines, and trim the trailing whitespace.
pub fn adf_to_markdown(value: &Value) -> String {
    if !value.is_object() {
        return String::new();
    }
    let blocks = value
        .get("content")
        .and_then(Value::as_array)
        .map(|nodes| render_blocks(nodes, 0))
        .unwrap_or_default();
    blocks.trim_end().to_string()
}

/// Render a sequence of block-level nodes, joining them with a blank line. `depth` is
/// the current list-nesting depth (0 at the top level), used to indent nested lists.
fn render_blocks(nodes: &[Value], depth: usize) -> String {
    let mut out = String::new();
    for node in nodes {
        let block = render_block(node, depth);
        if block.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&block);
    }
    out
}

/// Render one block-level node to markdown. Unknown block types fall back to their
/// inline text (recursing into `content`), so nothing is silently dropped.
fn render_block(node: &Value, depth: usize) -> String {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");
    match node_type {
        "paragraph" => render_inline_content(node),
        "heading" => {
            // `attrs.level` is 1..=6; clamp anything out of range so a bad level can't
            // emit an empty or absurd prefix.
            let level = node
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 6) as usize;
            let hashes = "#".repeat(level);
            let text = render_inline_content(node);
            format!("{hashes} {text}")
        }
        "bulletList" => render_list(node, depth, ListKind::Bullet),
        "orderedList" => render_list(node, depth, ListKind::Ordered),
        "codeBlock" => {
            let lang = node
                .get("attrs")
                .and_then(|a| a.get("language"))
                .and_then(Value::as_str)
                .unwrap_or("");
            // A code block's content is plain text nodes; collect their raw text
            // verbatim (no mark processing inside a fence).
            let code = collect_text(node);
            format!("```{lang}\n{code}\n```")
        }
        "blockquote" => {
            // A blockquote holds block children; render them, then prefix each line.
            let inner = node
                .get("content")
                .and_then(Value::as_array)
                .map(|nodes| render_blocks(nodes, depth))
                .unwrap_or_default();
            inner
                .lines()
                .map(|line| {
                    if line.is_empty() {
                        ">".to_string()
                    } else {
                        format!("> {line}")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        "rule" => "---".to_string(),
        // A bare block-level unknown: recurse into its children as blocks (so a wrapping
        // node we don't model still surfaces everything inside), else its inline text.
        _ => match node.get("content").and_then(Value::as_array) {
            Some(nodes) => render_blocks(nodes, depth),
            None => render_inline_content(node),
        },
    }
}

#[derive(Clone, Copy)]
enum ListKind {
    Bullet,
    Ordered,
}

/// Render a bullet/ordered list. Each `listItem` may itself contain paragraphs and
/// nested lists; nested content is indented by two spaces per depth level. An ordered
/// list numbers its items from 1.
fn render_list(node: &Value, depth: usize, kind: ListKind) -> String {
    let items = match node.get("content").and_then(Value::as_array) {
        Some(items) => items,
        None => return String::new(),
    };
    let indent = "  ".repeat(depth);
    let mut out = String::new();
    let mut index = 0usize;
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("listItem") {
            continue;
        }
        index += 1;
        let marker = match kind {
            ListKind::Bullet => "-".to_string(),
            ListKind::Ordered => format!("{index}."),
        };
        // A listItem holds block children (usually one paragraph, optionally a nested
        // list). Render the FIRST paragraph inline on the marker line; render remaining
        // blocks beneath. A nested list self-indents (rendered at `depth + 1`, so its
        // lines already carry the right indent); a non-list continuation block (an extra
        // paragraph) carries no indent of its own, so it's prefixed one level deeper.
        let children = item.get("content").and_then(Value::as_array);
        let first_line = children
            .and_then(|b| b.first())
            .map(render_item_lead)
            .unwrap_or_default();
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(&format!("{indent}{marker} {first_line}"));
        if let Some(blocks) = children {
            for block in blocks.iter().skip(1) {
                let is_list = matches!(
                    block.get("type").and_then(Value::as_str),
                    Some("bulletList") | Some("orderedList")
                );
                let rendered = if is_list {
                    // Self-indents at the deeper depth.
                    render_block(block, depth + 1)
                } else {
                    render_block(block, depth)
                };
                if rendered.is_empty() {
                    continue;
                }
                let extra_indent = if is_list {
                    String::new()
                } else {
                    // Indent a non-list continuation one level deeper than the marker.
                    format!("{indent}  ")
                };
                for line in rendered.lines() {
                    out.push('\n');
                    out.push_str(&format!("{extra_indent}{line}"));
                }
            }
        }
    }
    out
}

/// The lead content of a list item's first child block — inline text for a paragraph,
/// else a best-effort block render (an item leading with e.g. a code block).
fn render_item_lead(node: &Value) -> String {
    match node.get("type").and_then(Value::as_str) {
        Some("paragraph") => render_inline_content(node),
        _ => render_block(node, 0),
    }
}

/// Render a node's inline `content` (an array of text/mention/emoji/… nodes) to a
/// single markdown string. A node with no `content` yields an empty string.
fn render_inline_content(node: &Value) -> String {
    let Some(nodes) = node.get("content").and_then(Value::as_array) else {
        return String::new();
    };
    let mut out = String::new();
    for inline in nodes {
        out.push_str(&render_inline(inline));
    }
    out
}

/// Render one inline node. Text nodes apply their marks; the recognized non-text
/// inline nodes (hardBreak/mention/emoji/inlineCard) map to their markdown/text form;
/// anything else degrades to its own `text` field or recursed inline content.
fn render_inline(node: &Value) -> String {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");
    match node_type {
        "text" => {
            let text = node.get("text").and_then(Value::as_str).unwrap_or("");
            apply_marks(text, node.get("marks").and_then(Value::as_array))
        }
        "hardBreak" => "  \n".to_string(),
        "mention" => {
            // `attrs.text` is usually "@Display Name"; fall back to a bare "@".
            let mention = node
                .get("attrs")
                .and_then(|a| a.get("text"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| "@".to_string());
            // Ensure a leading @ even when attrs.text omits it.
            if mention.starts_with('@') {
                mention
            } else {
                format!("@{mention}")
            }
        }
        "emoji" => node
            .get("attrs")
            .and_then(|a| a.get("shortName").or_else(|| a.get("text")))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        "inlineCard" => node
            .get("attrs")
            .and_then(|a| a.get("url"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        // Unknown inline node: its own text, else recurse into any inline content.
        _ => match node.get("text").and_then(Value::as_str) {
            Some(text) => text.to_string(),
            None => render_inline_content(node),
        },
    }
}

/// Apply a text node's marks to its raw text. Marks nest from the inside out
/// (`link([code](strong)))` → wrap code first, then strong, then link) — the order
/// here (strong/em/code/strike wrap the text, link wraps last) yields valid markdown
/// for the common single/double-mark cases. An unknown mark type is ignored (the text
/// still renders).
fn apply_marks(text: &str, marks: Option<&Vec<Value>>) -> String {
    let Some(marks) = marks else {
        return text.to_string();
    };
    let mut out = text.to_string();
    let mut link_href: Option<String> = None;
    for mark in marks {
        match mark.get("type").and_then(Value::as_str).unwrap_or("") {
            "strong" => out = format!("**{out}**"),
            "em" => out = format!("*{out}*"),
            "code" => out = format!("`{out}`"),
            "strike" => out = format!("~~{out}~~"),
            "link" => {
                // Defer the link wrap so it sits outermost (a code+link span reads
                // `[`text`](href)`).
                link_href = mark
                    .get("attrs")
                    .and_then(|a| a.get("href"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
            }
            _ => {}
        }
    }
    if let Some(href) = link_href {
        out = format!("[{out}]({href})");
    }
    out
}

/// Collect the raw text of a node's descendants verbatim (no marks, no markdown) —
/// used inside a code fence, where the content is plain text nodes joined as-is.
fn collect_text(node: &Value) -> String {
    let mut out = String::new();
    collect_text_into(node, &mut out);
    out
}

fn collect_text_into(node: &Value, out: &mut String) {
    if let Some(text) = node.get("text").and_then(Value::as_str) {
        out.push_str(text);
    }
    if let Some(children) = node.get("content").and_then(Value::as_array) {
        for child in children {
            collect_text_into(child, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A shorthand: wrap block nodes in a doc envelope.
    fn doc(content: Value) -> Value {
        json!({ "type": "doc", "version": 1, "content": content })
    }

    /// A plain text node.
    fn text(s: &str) -> Value {
        json!({ "type": "text", "text": s })
    }

    #[test]
    fn empty_and_null_docs_yield_empty_string() {
        assert_eq!(adf_to_markdown(&Value::Null), "");
        assert_eq!(adf_to_markdown(&json!({})), "");
        assert_eq!(adf_to_markdown(&doc(json!([]))), "");
        // A non-object (array/string/number) is empty, not a panic.
        assert_eq!(adf_to_markdown(&json!("hi")), "");
        assert_eq!(adf_to_markdown(&json!([1, 2, 3])), "");
    }

    #[test]
    fn paragraph_with_plain_text() {
        let d = doc(json!([
            { "type": "paragraph", "content": [text("Hello world")] }
        ]));
        assert_eq!(adf_to_markdown(&d), "Hello world");
    }

    #[test]
    fn multiple_paragraphs_are_blank_line_separated() {
        let d = doc(json!([
            { "type": "paragraph", "content": [text("First")] },
            { "type": "paragraph", "content": [text("Second")] },
        ]));
        assert_eq!(adf_to_markdown(&d), "First\n\nSecond");
    }

    #[test]
    fn text_marks_bold_italic_code_strike() {
        let d = doc(json!([
            { "type": "paragraph", "content": [
                { "type": "text", "text": "b", "marks": [{ "type": "strong" }] },
                text(" "),
                { "type": "text", "text": "i", "marks": [{ "type": "em" }] },
                text(" "),
                { "type": "text", "text": "c", "marks": [{ "type": "code" }] },
                text(" "),
                { "type": "text", "text": "s", "marks": [{ "type": "strike" }] },
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "**b** *i* `c` ~~s~~");
    }

    #[test]
    fn link_mark_wraps_outermost() {
        let d = doc(json!([
            { "type": "paragraph", "content": [
                { "type": "text", "text": "site", "marks": [
                    { "type": "link", "attrs": { "href": "https://example.com" } }
                ]}
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "[site](https://example.com)");
    }

    #[test]
    fn link_plus_code_mark_nests_link_outside() {
        let d = doc(json!([
            { "type": "paragraph", "content": [
                { "type": "text", "text": "x", "marks": [
                    { "type": "code" },
                    { "type": "link", "attrs": { "href": "https://e.co" } }
                ]}
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "[`x`](https://e.co)");
    }

    #[test]
    fn headings_1_through_6() {
        for level in 1..=6u64 {
            let d = doc(json!([
                { "type": "heading", "attrs": { "level": level }, "content": [text("H")] }
            ]));
            let expected = format!("{} H", "#".repeat(level as usize));
            assert_eq!(adf_to_markdown(&d), expected);
        }
    }

    #[test]
    fn heading_out_of_range_level_is_clamped() {
        let d = doc(json!([
            { "type": "heading", "attrs": { "level": 99 }, "content": [text("H")] }
        ]));
        assert_eq!(adf_to_markdown(&d), "###### H");
    }

    #[test]
    fn bullet_list() {
        let d = doc(json!([
            { "type": "bulletList", "content": [
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [text("one")] }
                ]},
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [text("two")] }
                ]},
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "- one\n- two");
    }

    #[test]
    fn ordered_list_numbers_from_one() {
        let d = doc(json!([
            { "type": "orderedList", "content": [
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [text("a")] }
                ]},
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [text("b")] }
                ]},
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "1. a\n2. b");
    }

    #[test]
    fn nested_list_indents_two_spaces() {
        let d = doc(json!([
            { "type": "bulletList", "content": [
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [text("parent")] },
                    { "type": "bulletList", "content": [
                        { "type": "listItem", "content": [
                            { "type": "paragraph", "content": [text("child")] }
                        ]}
                    ]}
                ]},
            ]}
        ]));
        // The child list nests one level under the parent item.
        assert_eq!(adf_to_markdown(&d), "- parent\n  - child");
    }

    #[test]
    fn code_block_fences_with_language() {
        let d = doc(json!([
            { "type": "codeBlock", "attrs": { "language": "rust" }, "content": [
                text("fn main() {}")
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "```rust\nfn main() {}\n```");
    }

    #[test]
    fn code_block_without_language() {
        let d = doc(json!([
            { "type": "codeBlock", "content": [text("plain")] }
        ]));
        assert_eq!(adf_to_markdown(&d), "```\nplain\n```");
    }

    #[test]
    fn blockquote_prefixes_each_line() {
        let d = doc(json!([
            { "type": "blockquote", "content": [
                { "type": "paragraph", "content": [text("quoted")] }
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "> quoted");
    }

    #[test]
    fn rule_renders_as_thematic_break() {
        let d = doc(json!([
            { "type": "paragraph", "content": [text("above")] },
            { "type": "rule" },
            { "type": "paragraph", "content": [text("below")] },
        ]));
        assert_eq!(adf_to_markdown(&d), "above\n\n---\n\nbelow");
    }

    #[test]
    fn hard_break_inside_paragraph() {
        let d = doc(json!([
            { "type": "paragraph", "content": [
                text("line1"),
                { "type": "hardBreak" },
                text("line2"),
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "line1  \nline2");
    }

    #[test]
    fn mention_uses_attrs_text() {
        let d = doc(json!([
            { "type": "paragraph", "content": [
                text("cc "),
                { "type": "mention", "attrs": { "id": "abc", "text": "@Jane Doe" } },
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "cc @Jane Doe");
    }

    #[test]
    fn mention_without_leading_at_gets_one() {
        let d = doc(json!([
            { "type": "paragraph", "content": [
                { "type": "mention", "attrs": { "text": "Jane" } },
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "@Jane");
    }

    #[test]
    fn emoji_uses_short_name() {
        let d = doc(json!([
            { "type": "paragraph", "content": [
                text("nice "),
                { "type": "emoji", "attrs": { "shortName": ":smile:", "text": "🙂" } },
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "nice :smile:");
    }

    #[test]
    fn inline_card_renders_its_url() {
        let d = doc(json!([
            { "type": "paragraph", "content": [
                { "type": "inlineCard", "attrs": { "url": "https://card.example" } },
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "https://card.example");
    }

    #[test]
    fn unknown_block_node_falls_back_to_inner_text() {
        // A node type we don't model (e.g. a panel) still surfaces its content.
        let d = doc(json!([
            { "type": "panel", "attrs": { "panelType": "info" }, "content": [
                { "type": "paragraph", "content": [text("heads up")] }
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "heads up");
    }

    #[test]
    fn unknown_inline_node_falls_back_to_text() {
        let d = doc(json!([
            { "type": "paragraph", "content": [
                text("see "),
                { "type": "someNewInline", "text": "fallback" },
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "see fallback");
    }

    #[test]
    fn mixed_known_and_unknown_nodes_all_render() {
        let d = doc(json!([
            { "type": "heading", "attrs": { "level": 2 }, "content": [text("Title")] },
            { "type": "paragraph", "content": [text("intro")] },
            { "type": "mysteryBlock", "content": [
                { "type": "paragraph", "content": [text("still shown")] }
            ]},
            { "type": "bulletList", "content": [
                { "type": "listItem", "content": [
                    { "type": "paragraph", "content": [text("item")] }
                ]}
            ]},
        ]));
        assert_eq!(
            adf_to_markdown(&d),
            "## Title\n\nintro\n\nstill shown\n\n- item"
        );
    }

    #[test]
    fn text_node_missing_text_field_is_tolerated() {
        // A text node with no `text` field renders as empty, not a panic.
        let d = doc(json!([
            { "type": "paragraph", "content": [
                { "type": "text" },
                text("ok"),
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "ok");
    }

    #[test]
    fn unknown_mark_is_ignored_text_survives() {
        let d = doc(json!([
            { "type": "paragraph", "content": [
                { "type": "text", "text": "kept", "marks": [{ "type": "underline" }] }
            ]}
        ]));
        assert_eq!(adf_to_markdown(&d), "kept");
    }
}
