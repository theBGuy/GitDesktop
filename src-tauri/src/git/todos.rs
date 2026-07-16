use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::git::runner::run_git_raw;

/// A `git grep` over the whole working tree plus a parse pass can outlast the
/// default timeout on very large repositories, so we match the heavier read
/// commands (`STATS_TIMEOUT` in stats.rs) rather than `DEFAULT_TIMEOUT`.
const TODO_SCAN_TIMEOUT: Duration = Duration::from_secs(120);

/// Default global cap on returned items when the caller passes `None`.
const DEFAULT_MAX_HITS: u32 = 2000;

/// Max characters kept for an item's `text` (char-boundary-safe, so we never
/// split a UTF-8 codepoint).
const TEXT_CAP_CHARS: usize = 300;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoScanItem {
    /// Repo-relative path exactly as git emits it (forward slashes).
    pub path: String,
    /// 1-based line number.
    pub line: u32,
    /// The matched marker word, e.g. "TODO".
    pub marker: String,
    /// Comment text after the marker (see [`extract_text`]), trimmed, capped
    /// at 300 chars.
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoScan {
    /// In git grep's output order (path-grouped).
    pub items: Vec<TodoScanItem>,
    /// True when the global cap cut results off.
    pub truncated: bool,
}

/// Whether `c` is a "word" char for `-w`/word-boundary purposes: git's regex
/// treats `[A-Za-z0-9_]` as word characters, so a marker is a whole word only
/// when the chars flanking it are outside that set (or absent).
fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Comment-opener tokens (the TODO-Tree heuristic). A marker occurrence only
/// counts as a real to-do when the text before it on the line — trailing
/// whitespace stripped — is empty (marker at line start) or ends with one of
/// these. Ordering doesn't matter (we test each with `ends_with`), but note the
/// coverage each gives via `ends_with`: `//` also covers `///`, `*` covers
/// `/**`, `-` covers `--` (SQL/Lua) and markdown list bullets. This kills
/// mid-prose mentions ("the TODO line") and bare-word noise; it deliberately
/// still lets a string literal that itself begins with a comment opener
/// through — the documented TODO-Tree-parity limitation.
const OPENER_TOKENS: &[&str] = &["//", "//!", "#", "/*", "*", "<!--", ";", "%", "-"];

/// Whether `before` (the text on the line preceding a marker occurrence) opens
/// a comment: empty after trailing-whitespace strip, or ending with an opener
/// token.
fn passes_comment_gate(before: &str) -> bool {
    let before = before.trim_end();
    before.is_empty() || OPENER_TOKENS.iter().any(|tok| before.ends_with(tok))
}

/// A valid marker is a single word starting with a letter, then letters,
/// digits, `_`, or `-`. This is the injection guard: markers are interpolated
/// into an ERE alternation, so anything outside this grammar is rejected before
/// it can reach the regex.
fn is_valid_marker(marker: &str) -> bool {
    let mut chars = marker.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Finds the leftmost validated marker occurring as a whole word in `content`
/// (consistent with `git grep -w`: the preceding and following char must be
/// non-word) that ALSO passes [`passes_comment_gate`]. Returns the byte range
/// start and the matched marker word.
///
/// Every whole-word marker occurrence across all `markers` is considered in
/// left-to-right order: the first one whose preceding text opens a comment
/// wins. So if the leftmost occurrence is mid-prose ("the TODO line") but a
/// later one is a real comment opener, the later one is taken; if none opens a
/// comment, the line yields nothing.
fn find_marker(content: &str, markers: &[String]) -> Option<(usize, String)> {
    // Collect every word-boundary occurrence of every marker, then walk them
    // left-to-right and take the first that passes the comment-opener gate.
    let mut occurrences: Vec<(usize, &str)> = Vec::new();
    for marker in markers {
        // A marker can appear as a substring of a larger word (`myTODO`,
        // `TODOx`), which `-w` semantics must reject.
        let mut from = 0;
        while let Some(rel) = content[from..].find(marker.as_str()) {
            let start = from + rel;
            let end = start + marker.len();
            let before_ok = content[..start]
                .chars()
                .next_back()
                .is_none_or(|c| !is_word_char(c));
            let after_ok = content[end..]
                .chars()
                .next()
                .is_none_or(|c| !is_word_char(c));
            if before_ok && after_ok {
                occurrences.push((start, marker.as_str()));
            }
            from = end;
        }
    }
    // Leftmost first; on a tie (impossible for distinct words) it's stable.
    occurrences.sort_by_key(|(start, _)| *start);
    occurrences
        .into_iter()
        .find(|(start, _)| passes_comment_gate(&content[..*start]))
        .map(|(start, marker)| (start, marker.to_string()))
}

/// Extracts the comment `text` from `content` given the marker's byte range end.
/// Strips leading `:`, `;`, `-`, and whitespace (but keeps a leading `(` so
/// `TODO(evan): fix` yields `(evan): fix`), trims trailing whitespace/CR, and
/// caps at [`TEXT_CAP_CHARS`] on a char boundary.
fn extract_text(content: &str, marker_end: usize) -> String {
    let rest = &content[marker_end..];
    let trimmed = rest
        .trim_start_matches(|c: char| c == ':' || c == ';' || c == '-' || c.is_whitespace())
        .trim_end();
    if trimmed.chars().count() <= TEXT_CAP_CHARS {
        return trimmed.to_string();
    }
    // Char-boundary-safe truncation: take the first TEXT_CAP_CHARS chars.
    trimmed.chars().take(TEXT_CAP_CHARS).collect()
}

/// Parses one `git grep -z -n` record into a [`TodoScanItem`]. The `-z -n`
/// framing (confirmed empirically against this repo) is
/// `path \0 line \0 content`, with records separated by `\n`. A record whose
/// path/line can't be parsed, or that carries no validated marker, yields
/// `None` and is skipped (per-item resilience) rather than failing the batch.
fn parse_record(record: &str, markers: &[String]) -> Option<TodoScanItem> {
    let mut parts = record.splitn(3, '\0');
    let path = parts.next()?;
    let line = parts.next()?.parse::<u32>().ok()?;
    let content = parts.next()?;
    if path.is_empty() {
        return None;
    }
    let (marker_start, marker) = find_marker(content, markers)?;
    let text = extract_text(content, marker_start + marker.len());
    Some(TodoScanItem {
        path: path.to_string(),
        line,
        marker,
        text,
    })
}

/// Parses all records from `git grep -z -n` stdout, stopping once `max_hits`
/// items are collected (returning `truncated = true` and skipping the rest for
/// a cheap early exit). Records are `\n`-separated; a record can legally contain
/// no `\n` of its own, so a plain split is correct.
fn parse_scan(stdout: &str, markers: &[String], max_hits: usize) -> TodoScan {
    let mut items = Vec::new();
    let mut truncated = false;
    // Trailing newline yields an empty final record — filter empties.
    for record in stdout.split('\n').filter(|r| !r.is_empty()) {
        if items.len() >= max_hits {
            truncated = true;
            break;
        }
        if let Some(item) = parse_record(record, markers) {
            items.push(item);
        }
    }
    TodoScan { items, truncated }
}

/// Scans the working tree for real TODO/FIXME/etc. comment markers via
/// `git grep`, returning parsed, globally-capped hits.
///
/// `git grep -z -n -I -w --untracked -E "(M1|M2|…)"`: `-z` NUL-delimits the
/// path/line fields so a `:` in a path can't be mistaken for the separator,
/// `-n` prefixes line numbers, `-I` skips binaries, `-w` gives portable
/// word-boundary matching (git's `\b` support varies by platform regex lib),
/// `--untracked` includes new-but-not-gitignored files, and the pattern is an
/// ERE alternation of the validated markers. The match is case-sensitive by
/// design — a lowercase `todo` in an identifier or prose is noise.
///
/// `run_git_raw` (not `run_git`) so `git grep`'s documented no-match exit (code
/// 1) stays a success signal: exit 0 → parse, exit 1 → parse stdout anyway
/// (empty stdout yields an empty scan), any other code → a real error. This
/// also makes the unborn (no-commit) repo path a clean empty result — `git
/// grep` exits 1 there.
#[tauri::command]
pub async fn git_todo_scan(
    repo_path: String,
    markers: Vec<String>,
    max_hits: Option<u32>,
) -> AppResult<TodoScan> {
    if markers.is_empty() {
        return Err(AppError::InvalidArgument("no markers provided".into()));
    }
    for marker in &markers {
        if !is_valid_marker(marker) {
            return Err(AppError::InvalidArgument(format!(
                "invalid marker: {marker:?}"
            )));
        }
    }
    let max_hits = max_hits.unwrap_or(DEFAULT_MAX_HITS) as usize;

    let pattern = format!("({})", markers.join("|"));
    let args = [
        "grep",
        "-z",
        "-n",
        "-I",
        "-w",
        "--untracked",
        "-E",
        &pattern,
    ];
    let out = run_git_raw(Some(&repo_path), &args, TODO_SCAN_TIMEOUT).await?;
    match out.code {
        0 => Ok(parse_scan(&out.stdout_lossy(), &markers, max_hits)),
        // Exit 1 is git grep's documented no-matches exit (also fires on an
        // unborn repo). Parse stdout anyway as best-effort in case a
        // non-standard git emitted partial results before exiting 1 — parsing
        // empty stdout yields an empty scan, so this subsumes the no-match case.
        1 => Ok(parse_scan(&out.stdout_lossy(), &markers, max_hits)),
        _ => Err(AppError::Git {
            code: out.code,
            stderr: out.stderr,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic tags, deliberately NOT the real default markers: the
    // extraction/parsing logic is marker-agnostic, so using fake words keeps
    // this test file from self-reporting when GitDesktop scans its own repo.
    // The lone exception is the temp-dir real-repo test, whose fixture lives in
    // a throwaway directory, not this checkout.
    fn markers() -> Vec<String> {
        ["TAGX", "ZFIX", "QHACK", "WBUG", "VXX"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn marker_validation() {
        assert!(is_valid_marker("TAGX"));
        assert!(is_valid_marker("tagx"));
        assert!(is_valid_marker("MY-TAG"));
        assert!(is_valid_marker("VXX"));
        assert!(is_valid_marker("A1_b-c"));
        assert!(!is_valid_marker(""));
        assert!(!is_valid_marker("a b"));
        assert!(!is_valid_marker("TA+GX"));
        assert!(!is_valid_marker("1TAGX")); // must start with a letter
        assert!(!is_valid_marker("-tag"));
    }

    /// Each case: `content` → expected `(marker, text)`.
    #[test]
    fn extraction_rules() {
        let m = markers();
        let cases: &[(&str, &str, &str)] = &[
            ("// TAGX: fix", "TAGX", "fix"),
            ("# ZFIX broken", "ZFIX", "broken"),
            ("// TAGX(evan): fix", "TAGX", "(evan): fix"),
            // Trailing `*/` is kept: it's part of the comment text after the
            // marker, and stripping comment syntax is out of scope.
            ("/* VXX */", "VXX", "*/"),
            // A bare marker with no trailing text → empty text, still an item.
            ("// TAGX", "TAGX", ""),
            ("    // QHACK - remove me", "QHACK", "remove me"),
            ("; WBUG leaks", "WBUG", "leaks"),
        ];
        for (content, want_marker, want_text) in cases {
            let (start, marker) = find_marker(content, &m)
                .unwrap_or_else(|| panic!("no marker found in {content:?}"));
            assert_eq!(&marker, want_marker, "marker for {content:?}");
            let text = extract_text(content, start + marker.len());
            assert_eq!(&text, want_text, "text for {content:?}");
        }
    }

    /// The comment-opener gate: a marker only counts when it opens a comment
    /// (empty prefix or an opener token), killing mid-prose/bare-word noise.
    #[test]
    fn comment_opener_gate() {
        let m = markers();

        // KEPT: opener-adjacent or line-start markers.
        let kept: &[(&str, &str)] = &[
            ("code(); // TAGX: fix", "TAGX"), // code then `//`
            ("// TAGX fix", "TAGX"),          // `//` at line start
            (" * TAGX: fix", "TAGX"),         // JSDoc `*` continuation
            ("# ZFIX broken", "ZFIX"),        // `#`
            ("- TAGX buy milk", "TAGX"),      // markdown bullet `-`
            ("TAGX: fix", "TAGX"),            // column 0, no opener needed
            ("<!-- TAGX doc -->", "TAGX"),    // HTML comment
            ("-- ZFIX sql", "ZFIX"),          // `--` covered by `-`
            ("/** TAGX jsdoc", "TAGX"),       // `/**` covered by `*`
        ];
        for (content, want) in kept {
            let hit =
                find_marker(content, &m).unwrap_or_else(|| panic!("gate should keep {content:?}"));
            assert_eq!(hit.1, *want, "marker for {content:?}");
        }

        // SKIPPED: marker mid-prose, not opening a comment.
        let skipped = [
            "sees the TAGX line and moves on",
            "the TAGX here is just prose",
            "return the TAGX value",
        ];
        for content in skipped {
            assert!(
                find_marker(content, &m).is_none(),
                "gate should skip {content:?}"
            );
        }
    }

    /// When the leftmost occurrence fails the gate but a later one opens a
    /// comment, the later occurrence is taken.
    #[test]
    fn later_occurrence_passes_gate() {
        let m = markers();
        // First TAGX is mid-prose (skip); the second opens a `//` comment.
        let content = "widen the TAGX region // TAGX: do it";
        let (start, marker) = find_marker(content, &m).unwrap();
        assert_eq!(marker, "TAGX");
        // The kept occurrence is the second one (after the `//`).
        assert!(start > content.find("//").unwrap());
        let text = extract_text(content, start + marker.len());
        assert_eq!(text, "do it");
    }

    #[test]
    fn word_boundary_rejects_substrings() {
        let m = markers();
        assert!(find_marker("int myTAGX = 1;", &m).is_none());
        assert!(find_marker("// call TAGXx()", &m).is_none());
        assert!(find_marker("// aWBUGb", &m).is_none());
        // A real word boundary AND the marker directly opening the comment → matches.
        assert!(find_marker("// TAGX here", &m).is_some());
    }

    #[test]
    fn leftmost_marker_wins() {
        let m = markers();
        // When ZFIX appears before TAGX in the line, the earlier marker wins.
        let (start, marker) = find_marker("// ZFIX then TAGX later", &m).unwrap();
        assert_eq!(marker, "ZFIX");
        let text = extract_text("// ZFIX then TAGX later", start + marker.len());
        assert_eq!(text, "then TAGX later");
    }

    #[test]
    fn crlf_line_ends_trimmed() {
        let m = markers();
        // git preserves the file's CR in the record content; trailing CR/ws is trimmed.
        let content = "// TAGX: fix this\r";
        let (start, marker) = find_marker(content, &m).unwrap();
        let text = extract_text(content, start + marker.len());
        assert_eq!(text, "fix this");
    }

    #[test]
    fn text_capped_at_char_boundary() {
        let m = markers();
        // A multibyte char straddling the 300-char cap must not be split.
        let long = "é".repeat(400);
        let content = format!("// TAGX {long}");
        let (start, marker) = find_marker(&content, &m).unwrap();
        let text = extract_text(&content, start + marker.len());
        assert_eq!(text.chars().count(), TEXT_CAP_CHARS);
        // Valid UTF-8 (no split codepoint) — round-trips cleanly.
        assert_eq!(text, "é".repeat(TEXT_CAP_CHARS));
    }

    #[test]
    fn parse_record_framing() {
        let m = markers();
        // path \0 line \0 content
        let rec = "src/a.rs\u{0}42\u{0}    // TAGX: wire it up";
        let item = parse_record(rec, &m).expect("valid record parses");
        assert_eq!(item.path, "src/a.rs");
        assert_eq!(item.line, 42);
        assert_eq!(item.marker, "TAGX");
        assert_eq!(item.text, "wire it up");
    }

    #[test]
    fn parse_record_skips_unparseable() {
        let m = markers();
        // A record whose content has no validated marker is skipped (None).
        let rec = "src/a.rs\u{0}1\u{0}just a normal line";
        assert!(parse_record(rec, &m).is_none());
        // A path with an embedded colon survives (NUL, not `:`, is the separator).
        let rec = "src/a:b.rs\u{0}7\u{0}// ZFIX here";
        let item = parse_record(rec, &m).unwrap();
        assert_eq!(item.path, "src/a:b.rs");
        assert_eq!(item.line, 7);
    }

    #[test]
    fn parse_scan_caps_and_marks_truncated() {
        let m = markers();
        let mut stdout = String::new();
        for i in 1..=5 {
            stdout.push_str(&format!("f{i}.rs\u{0}{i}\u{0}// TAGX n{i}\n"));
        }
        let scan = parse_scan(&stdout, &m, 3);
        assert_eq!(scan.items.len(), 3);
        assert!(scan.truncated);

        let scan = parse_scan(&stdout, &m, 100);
        assert_eq!(scan.items.len(), 5);
        assert!(!scan.truncated);
    }

    // --- Real-repo async tests (git init in a temp dir) ---------------------

    async fn run(repo: &str, args: &[&str]) -> String {
        run_git_raw(Some(repo), args, TODO_SCAN_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    async fn seed_repo(tag: &str) -> (std::path::PathBuf, String) {
        let base = std::env::temp_dir().join(format!(
            "gd-{tag}-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        (base, repo_s)
    }

    /// The one integration test that uses the REAL default markers — its
    /// fixture files live in a throwaway temp dir, not this checkout, so they
    /// don't make todos.rs self-report when GitDesktop scans its own repo.
    fn real_markers() -> Vec<String> {
        ["TODO", "FIXME", "HACK", "BUG", "XXX"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[tokio::test]
    async fn scans_a_real_repo() {
        let (base, repo) = seed_repo("todo-scan").await;

        // Fixture content is assembled with `concat!` so the comment opener and
        // the real marker word never sit adjacent in THIS source file (which
        // would self-report when GitDesktop scans its own repo); the file
        // written to the temp dir still contains a genuine slash-slash marker
        // line. Line 3's marker is inside a string literal, mid-prose after
        // "the", so the gate skips it — proving prose is filtered.
        let a_src = concat!(
            "fn main() {\n",
            "    ",
            "//",
            " TODO: implement this\n",
            "    let s = \"the ",
            "TODO",
            " here is prose\";\n",
            "}\n"
        );
        std::fs::write(std::path::Path::new(&repo).join("a.rs"), a_src).unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "seed"]).await;

        // An untracked (uncommitted) file's markers should also show (--untracked).
        let b_src = concat!("//", " FIXME(me): later\n");
        std::fs::write(std::path::Path::new(&repo).join("b.rs"), b_src).unwrap();

        let scan = git_todo_scan(repo.clone(), real_markers(), None)
            .await
            .unwrap();
        assert!(!scan.truncated);

        let a: Vec<_> = scan.items.iter().filter(|i| i.path == "a.rs").collect();
        // Exactly one hit in a.rs: the opener-gated marker on line 2. The
        // mid-prose occurrence on line 3 is filtered by the comment gate.
        assert_eq!(a.len(), 1, "only the real comment marker counts, not prose");
        assert_eq!(a[0].line, 2);
        assert_eq!(a[0].marker, "TODO");
        assert_eq!(a[0].text, "implement this");

        let b = scan
            .items
            .iter()
            .find(|i| i.path == "b.rs")
            .expect("untracked file hit");
        assert_eq!(b.marker, "FIXME");
        assert_eq!(b.text, "(me): later");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn no_match_is_empty_not_error() {
        let (base, repo) = seed_repo("todo-nomatch").await;
        std::fs::write(std::path::Path::new(&repo).join("a.rs"), "fn main() {}\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "seed"]).await;

        let scan = git_todo_scan(repo, markers(), None).await.unwrap();
        assert!(scan.items.is_empty());
        assert!(!scan.truncated);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn unborn_repo_is_empty_not_error() {
        // git init, nothing committed: git grep exits 1 → clean empty result.
        let (base, repo) = seed_repo("todo-unborn").await;
        let scan = git_todo_scan(repo, markers(), None).await.unwrap();
        assert!(scan.items.is_empty());
        assert!(!scan.truncated);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn empty_markers_rejected() {
        let (base, repo) = seed_repo("todo-badmarker").await;
        let err = git_todo_scan(repo.clone(), vec![], None).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)));
        let err = git_todo_scan(repo, vec!["TO DO".into()], None)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)));
        let _ = std::fs::remove_dir_all(&base);
    }
}
