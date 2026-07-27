//! AI-generation **recipe** tools.
//!
//! These tools do NOT call a model. Each assembles GitDesktop's fully-prepared
//! generation context — the same system prompt + user prompt the in-app AI feature
//! builds — and returns it as a recipe (`{ system, prompt, note }`). The CALLING
//! agent (itself a model) completes the prompt with its own inference and uses the
//! result as the commit message / PR description / branch name. No HTTP, no API
//! keys, no streaming: pure context assembly from the repository's git state.
//!
//! KEEP IN SYNC: src/lib/ai/prompt.ts (BASE_SYSTEM, buildCommitPrompt, buildPrPrompt,
//! buildBranchNamePrompt) and src/lib/ai/truncate.ts (budgetDiff, DIFF_CHAR_BUDGET,
//! PER_FILE_CAP, LOW_VALUE_PATH, splitIntoFileSections) — the MCP recipe tools mirror
//! these builders and the diff-budgeting they run (`budgetDiff(stripBinarySections(diff))`)
//! so recipe output quality matches the in-app feature (same section headers, ordering,
//! constraints, low-value-file filtering, per-file cap, and truncation-marker copy).
//! When either side changes a prompt or the budgeting, update the other.
//!
//! Budget note: the TS review path now SCALES `DIFF_CHAR_BUDGET`/`PER_FILE_CAP`
//! (and the review-extras caps) per reviewing model at review time — see
//! src/lib/ai/context-budget.ts. These MCP recipe tools deliberately keep the
//! DEFAULT profile constants (no model is known here — the recipe just assembles
//! context for the calling agent), so `DIFF_CHAR_BUDGET`/`PER_FILE_CAP` below
//! stay the fixed defaults and this mirror is unaffected by that scaling.
//!
//! Remaining divergence from the TS path: `budgetDiff` returns the list of
//! omitted-file names and the TS marker enumerates them (`N file(s) omitted: …`); the
//! recipe markers here don't carry those names, so the marker copy omits that clause
//! and keeps only the "rely on the file summary above" guidance (noted at each marker
//! below). The raw diff is requested at the SAME 200_000-byte `RAW_DIFF_MAX_BYTES` the
//! TS call sites use (a git-layer `truncate_at_file_boundary` cap), then binary-stripped
//! and run through the `budget_diff` mirror — the truncation flag is set when EITHER
//! the git cap or budgeting truncated, matching the TS `budgeted.truncated || diffTruncated`.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, GetPromptResult, PromptMessage, PromptMessageRole};
use rmcp::{prompt, prompt_router, schemars, tool, tool_router, ErrorData as McpError};

use super::{app_err, ensure_not_flag, json_result, to_value, GitDesktopMcp};
use crate::git::types::DiffStatEntry;

/// Raw diff bytes requested from the backend, matching the TS generation call
/// sites' `RAW_DIFF_MAX_BYTES` (useGenerateCommitMessage / useGeneratePrDescription /
/// useGenerateBranchName). The git layer caps this at a file boundary; the assembly
/// then binary-strips and runs `budget_diff` (the 80KB prompt-side budget), exactly
/// as the TS builders do.
const RAW_DIFF_MAX_BYTES: usize = 200_000;

// ---- System prompts (mirror src/lib/ai/prompt.ts verbatim) ----------------

/// Mirrors `BASE_SYSTEM` in src/lib/ai/prompt.ts. KEEP IN SYNC.
const BASE_SYSTEM: &str = "You write git commit messages.\n\
Output ONLY the commit message itself: the first line is the subject (imperative mood, at most 72 characters), then a blank line, then a body explaining what changed and why — a few sentences for a focused change; for a larger change spanning several areas, a short dash-bullet list with one line per area, most important first, naming the concrete surfaces touched. Omit the body only for a trivial, self-explanatory change.\n\
Never reference issue or PR numbers, tickets, or links (e.g. \"Closes #123\") — you can't see the issue tracker, so any such reference is fabricated.\n\
Do not wrap the message in markdown fences. Do not add commentary before or after the message.";

/// Mirrors `BRANCH_SYSTEM` in src/lib/ai/prompt.ts. KEEP IN SYNC.
const BRANCH_SYSTEM: &str = "You generate a single git branch name for a set of code changes.\n\
Output ONLY the branch name — one line, nothing else: no quotes, no explanation, no markdown, no trailing period.\n\
Use lowercase kebab-case, 2-5 words, specific to what the change does (avoid generic names like \"updates\" or \"changes\").\n\
If the existing branch names below show a prefix convention (e.g. \"feature/\", \"fix/\", \"chore/\"), follow it; otherwise pick a fitting type prefix such as \"feature/\" or \"fix/\".\n\
Never use spaces, uppercase, or characters invalid in a git ref name.";

/// Mirrors `PR_SYSTEM` in src/lib/ai/prompt.ts (the GitHub base). KEEP IN SYNC.
const PR_SYSTEM: &str = "You write GitHub pull request descriptions for reviewers.\n\
\n\
First line: the PR title — concise, imperative mood, no trailing period, no \"PR:\"/\"Title:\" prefix.\n\
Then a blank line, then the description in GitHub-flavored Markdown.\n\
\n\
Structure the description like a strong human-written PR:\n\
- Open with a 1-3 sentence summary that states what the change accomplishes AND why — the goal or motivation behind it — not just a restatement of the diff.\n\
- Then cover the notable changes. If the diff spans several distinct areas or concerns, GROUP related changes under short `###` section headings (by feature, layer, or component, e.g. \"### API layer\", \"### Documentation\") with a few bullets under each. If the change is small or single-purpose, skip the headings and use one flat bulleted list.\n\
- In every bullet, name the concrete file, directory, or symbol involved so a reviewer can find it — e.g. \"Adds validation in `src/contact.ts`\". This grounding is what makes the description trustworthy.\n\
- Order from most to least significant. Be specific and factual; describe only what the diff shows. Do not invent changes, tests, motivations, or file names you cannot see.\n\
- NEVER reference issue or PR numbers, tickets, milestones, or external links (e.g. \"Closes #123\", \"part of #60\", \"fixes JIRA-4\"). You have no access to the issue tracker, so any such reference is fabricated — leave them out entirely.\n\
\n\
Do not wrap the output in code fences. Do not add commentary before the title or after the body.";

/// The provider-specific nouns/wording a PR prompt needs — mirrors `PlatformCopy`
/// and `platformCopy` in src/lib/ai/prompt.ts. The `provider` arg is the frontend
/// tag `"github"`/`"gitlab"`/`"bitbucket"`; an unknown or None value keeps the
/// GitHub wording byte-for-byte. KEEP IN SYNC.
struct PlatformCopy {
    pr_noun: &'static str,
    markdown_flavor: &'static str,
}

fn platform_copy(provider: Option<&str>) -> PlatformCopy {
    match provider {
        Some("gitlab") => PlatformCopy {
            pr_noun: "merge request",
            markdown_flavor: "GitLab-flavored Markdown",
        },
        Some("bitbucket") => PlatformCopy {
            pr_noun: "pull request",
            markdown_flavor: "Bitbucket-compatible Markdown (avoid GitHub-only extensions)",
        },
        _ => PlatformCopy {
            pr_noun: "pull request",
            markdown_flavor: "GitHub-flavored Markdown",
        },
    }
}

/// Mirrors `prSystemFor` in src/lib/ai/prompt.ts: GitHub (or absent) returns
/// `PR_SYSTEM` verbatim; the others swap only the change-request noun and the
/// markdown-flavor phrase by the same targeted replacements. KEEP IN SYNC.
fn pr_system_for(provider: Option<&str>) -> String {
    match provider {
        None | Some("github") => PR_SYSTEM.to_string(),
        _ => {
            let copy = platform_copy(provider);
            let host = match provider {
                Some("gitlab") => "GitLab",
                Some("bitbucket") => "Bitbucket",
                _ => "GitHub",
            };
            let abbrev = if copy.pr_noun == "merge request" {
                "MR"
            } else {
                "PR"
            };
            PR_SYSTEM
                .replacen(
                    "GitHub pull request",
                    &format!("{host} {}", copy.pr_noun),
                    1,
                )
                .replacen("the PR title", &format!("the {} title", copy.pr_noun), 1)
                .replacen("no \"PR:\"", &format!("no \"{abbrev}:\""), 1)
                .replacen(
                    "human-written PR:",
                    &format!("human-written {}:", copy.pr_noun),
                    1,
                )
                .replacen(
                    "issue or PR numbers",
                    &format!("issue or {abbrev} numbers"),
                    1,
                )
                .replacen("GitHub-flavored Markdown", copy.markdown_flavor, 1)
        }
    }
}

// ---- Shared assembly helpers ----------------------------------------------

/// Append the optional `## Project instructions` / `## User instructions`
/// sections to a system prompt's parts, mirroring the TS builders (every builder
/// adds these two, in this order, gated on non-empty). `repo_instructions` is
/// already-trimmed repo content (or None); `global_instructions` is trimmed here
/// like the TS `.trim()` guard.
fn push_instruction_sections(
    parts: &mut Vec<String>,
    repo_instructions: Option<&str>,
    global_instructions: &str,
) {
    if let Some(repo) = repo_instructions {
        if !repo.is_empty() {
            parts.push(format!("## Project instructions\n{repo}"));
        }
    }
    let global = global_instructions.trim();
    if !global.is_empty() {
        parts.push(format!("## User instructions\n{global}"));
    }
}

/// One file-summary line per changed file, mirroring the TS `.map(...)`:
/// `path (binary)` for binaries, else `path +A -D`.
fn file_summary_line(f: &DiffStatEntry) -> String {
    if f.is_binary {
        format!("{} (binary)", f.path)
    } else {
        format!("{} +{} -{}", f.path, f.added, f.deleted)
    }
}

/// Binary file sections never help the model; drop them, mirroring the TS
/// `stripBinarySections` (split on the `diff --git ` boundary, drop any section
/// containing a `Binary files ` line, rejoin).
fn strip_binary_sections(diff_text: &str) -> String {
    if diff_text.is_empty() {
        return String::new();
    }
    // Split so each section starts at a `diff --git ` header (the first section
    // before any header, if any, is kept as-is).
    let mut out = String::with_capacity(diff_text.len());
    let mut sections: Vec<&str> = Vec::new();
    let mut last = 0usize;
    let bytes = diff_text.as_bytes();
    let marker = "diff --git ";
    let mut i = 0usize;
    while i < diff_text.len() {
        // A header boundary is a `diff --git ` at the very start or right after a newline.
        let at_start = i == 0;
        let after_newline = i > 0 && bytes[i - 1] == b'\n';
        // NOTE: `diff_text[i..]` slicing here can NOT panic on a UTF-8 boundary. The
        // slice only evaluates under the `(at_start || after_newline) &&` short-circuit,
        // and `i` is either 0 or a position immediately after a single-byte ASCII `\n` —
        // both are always char boundaries. (Not a UTF-8 bug; don't re-flag.)
        if (at_start || after_newline) && diff_text[i..].starts_with(marker) {
            if i != last {
                sections.push(&diff_text[last..i]);
                last = i;
            }
            i += marker.len();
        } else {
            i += 1;
        }
    }
    sections.push(&diff_text[last..]);
    for section in sections {
        if !section.contains("\nBinary files ") {
            out.push_str(section);
        }
    }
    out
}

// ---- Diff budgeting (mirrors budgetDiff in src/lib/ai/truncate.ts) ----------
//
// KEEP IN SYNC: src/lib/ai/truncate.ts (budgetDiff, DIFF_CHAR_BUDGET,
// PER_FILE_CAP, LOW_VALUE_PATH, splitIntoFileSections). The in-app generation
// builders run `budgetDiff(stripBinarySections(diff))`; the recipe tools mirror
// that so a large diff (e.g. a regenerated lockfile) is filtered the same way
// before it reaches the calling agent, instead of shipping the raw diff.
//
// The TS review path scales these budgets by a per-model profile at review time
// (src/lib/ai/context-budget.ts); these recipe tools deliberately keep the
// DEFAULT profile constants below, since no reviewing model is known here.

/// Character budget for the diff inside the prompt — mirrors `DIFF_CHAR_BUDGET`
/// in truncate.ts. Below this the diff passes through byte-identical to the raw
/// (post-binary-strip) text; only larger diffs get filtered/capped.
const DIFF_CHAR_BUDGET: usize = 80_000;
/// Cap applied to each individual oversized file section once over budget —
/// mirrors `PER_FILE_CAP` in truncate.ts.
const PER_FILE_CAP: usize = 6_000;

/// A single `diff --git` file section: the `b/`-side path and the section text.
struct DiffFileSection<'a> {
    path: String,
    text: &'a str,
}

/// True when a path is a low-value / generated file whose diff is dropped first
/// under budget — mirrors the `LOW_VALUE_PATH` regex in truncate.ts exactly
/// (lockfiles, `*.min.js`/`*.min.css`, `*.map`, `*.snap`). Matched on the path's
/// final segment for the lockfile names, and on the suffix for the extensions.
fn is_low_value_path(path: &str) -> bool {
    // The final path segment (the regex anchors the lockfile alternation with
    // `(^|\/)` … `$`, i.e. the basename).
    let basename = path.rsplit('/').next().unwrap_or(path);
    const LOCKFILE_BASENAMES: &[&str] = &[
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "Cargo.lock",
        "composer.lock",
        "Gemfile.lock",
        "go.sum",
    ];
    if LOCKFILE_BASENAMES.contains(&basename) {
        return true;
    }
    // `bun\.lockb?` — bun.lock or bun.lockb.
    if basename == "bun.lock" || basename == "bun.lockb" {
        return true;
    }
    // Suffix alternation `\.min\.(js|css)$` and `\.(map|snap)$` (anywhere in the
    // path, matching the un-anchored regex branches).
    path.ends_with(".min.js")
        || path.ends_with(".min.css")
        || path.ends_with(".map")
        || path.ends_with(".snap")
}

/// Split a diff into `diff --git` file sections, mirroring `splitIntoFileSections`
/// in truncate.ts: split so each section starts at a `diff --git ` header, drop
/// whitespace-only parts, and take the `b/<path>` side of the header (falling back
/// to the whole header line when it doesn't match).
fn split_into_file_sections(diff_text: &str) -> Vec<DiffFileSection<'_>> {
    let mut starts: Vec<usize> = Vec::new();
    let bytes = diff_text.as_bytes();
    let marker = "diff --git ";
    let mut i = 0usize;
    while i < diff_text.len() {
        let at_start = i == 0;
        let after_newline = i > 0 && bytes[i - 1] == b'\n';
        // NOTE: `diff_text[i..]` slicing here can NOT panic on a UTF-8 boundary. The
        // slice only evaluates under the `(at_start || after_newline) &&` short-circuit,
        // and `i` is either 0 or a position immediately after a single-byte ASCII `\n` —
        // both are always char boundaries. (Not a UTF-8 bug; don't re-flag.)
        if (at_start || after_newline) && diff_text[i..].starts_with(marker) {
            starts.push(i);
            i += marker.len();
        } else {
            i += 1;
        }
    }
    let mut sections = Vec::new();
    for (idx, &start) in starts.iter().enumerate() {
        let end = starts.get(idx + 1).copied().unwrap_or(diff_text.len());
        let part = &diff_text[start..end];
        if part.trim().is_empty() {
            continue;
        }
        // Header line = up to the first '\n' (or the whole part if none).
        let header = part.split('\n').next().unwrap_or(part);
        // Take the ` b/<path>` side.
        let path = header
            .rfind(" b/")
            .map(|p| header[p + 3..].to_string())
            .unwrap_or_else(|| header.to_string());
        sections.push(DiffFileSection { path, text: part });
    }
    sections
}

/// Char-boundary-safe head slice to at most `max` bytes. The TS `.slice(0, n)`
/// operates on UTF-16 code units; diffs are overwhelmingly ASCII, so a byte cut
/// matches in practice — this only guards against panicking mid-codepoint on the
/// rare non-ASCII diff (a soft-heuristic budget, so any small drift is immaterial).
fn head_slice(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// The budgeted diff and whether budgeting truncated it (mirrors `BudgetedDiff`,
/// minus `omittedFiles` — the recipe markers don't enumerate omitted files, per
/// the module divergence note).
struct BudgetedDiff {
    text: String,
    truncated: bool,
}

/// Fit a (binary-stripped) diff into the prompt budget — a faithful port of
/// `budgetDiff` in truncate.ts: drop low-value/generated file sections first, then
/// cap each remaining oversized section at `PER_FILE_CAP`, then hard-cap the total
/// by greedily including sections that fit. Below `DIFF_CHAR_BUDGET` the input
/// passes through unchanged (not truncated). KEEP IN SYNC.
fn budget_diff(diff_text: &str) -> BudgetedDiff {
    if diff_text.len() <= DIFF_CHAR_BUDGET {
        return BudgetedDiff {
            text: diff_text.to_string(),
            truncated: false,
        };
    }

    let sections = split_into_file_sections(diff_text);

    // 1. Drop low-value sections.
    let mut kept: Vec<(String, String)> = Vec::new();
    for s in sections {
        if is_low_value_path(&s.path) {
            continue;
        }
        kept.push((s.path, s.text.to_string()));
    }

    // 2. If still over budget, cap each oversized section at PER_FILE_CAP.
    let total: usize = kept.iter().map(|(_, t)| t.len()).sum();
    if total > DIFF_CHAR_BUDGET {
        for (path, text) in kept.iter_mut() {
            if text.len() > PER_FILE_CAP {
                *text = format!(
                    "{}\n[... rest of {} truncated]\n",
                    head_slice(text, PER_FILE_CAP),
                    path
                );
            }
        }
    }

    // 3. Hard-cap the total: greedily include sections that fit under budget.
    let mut included = String::new();
    let mut used = 0usize;
    for (_, text) in &kept {
        if used + text.len() > DIFF_CHAR_BUDGET {
            continue;
        }
        included.push_str(text);
        used += text.len();
    }

    BudgetedDiff {
        text: included,
        truncated: true,
    }
}

/// Extract candidate issue numbers referenced in git text (branch name, commit
/// subjects). Deduplicated, first-occurrence order. KEEP IN SYNC:
/// `extractIssueNumbers` in src/lib/issues/extract.ts — both sides use explicit
/// leading-boundary matching (no lookbehind) so behavior stays identical.
///
/// Three patterns, applied in order 1→2→3 each over the FULL text (matching the
/// TS pass order); results deduped preserving first-occurrence order across all
/// patterns. Case table:
///   `fix/123-crash` → [123]   (pattern 2: after `/`, digits then `-`)
///   `#45`           → [45]    (pattern 1: `#` not preceded by letter/digit/`&`)
///   `123-fix`       → [123]   (pattern 2: string start, digits then `-`)
///   `&#39;`         → []      (pattern 1's `&` exclusion keeps HTML entities out)
///   `issue-7`       → [7]     (pattern 3, case-insensitive)
///   `v2-123`        → []      (pattern 2 fires only at start or after `/`)
fn extract_issue_numbers(text: &str) -> Vec<u64> {
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut out: Vec<u64> = Vec::new();
    let bytes = text.as_bytes();

    // Parse a run of ASCII digits starting at `start`, returning (value, end).
    // `None` when there are no digits or the value overflows u64.
    fn parse_digits(bytes: &[u8], start: usize) -> Option<(u64, usize)> {
        let mut i = start;
        let mut value: u64 = 0;
        let mut any = false;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            any = true;
            value = value.checked_mul(10)?.checked_add((bytes[i] - b'0') as u64)?;
            i += 1;
        }
        if any {
            Some((value, i))
        } else {
            None
        }
    }

    let push = |n: u64, seen: &mut std::collections::HashSet<u64>, out: &mut Vec<u64>| {
        // Drop 0 and anything > 999_999_999 (mirrors the TS guard).
        if n == 0 || n > 999_999_999 {
            return;
        }
        if seen.insert(n) {
            out.push(n);
        }
    };

    // Pattern 1: `#123` where `#` is at start or preceded by a char that is NOT
    // `[A-Za-z0-9&]` (the `&` guard excludes HTML entities like `&#39;`).
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            let prev_ok = if i == 0 {
                true
            } else {
                let p = bytes[i - 1];
                !(p.is_ascii_alphanumeric() || p == b'&')
            };
            if prev_ok {
                if let Some((n, _)) = parse_digits(bytes, i + 1) {
                    push(n, &mut seen, &mut out);
                }
            }
        }
        i += 1;
    }

    // Pattern 2: a segment-leading `123-` where the digits are at start or
    // preceded by `/`.
    i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let at_boundary = i == 0 || bytes[i - 1] == b'/';
            if at_boundary {
                if let Some((n, end)) = parse_digits(bytes, i) {
                    if end < bytes.len() && bytes[end] == b'-' {
                        push(n, &mut seen, &mut out);
                    }
                    // Skip past this digit run either way (it can't start another
                    // boundary match mid-run).
                    i = end;
                    continue;
                }
            }
        }
        i += 1;
    }

    // Pattern 3: `issue-123` / `gh-123` case-insensitive, preceded by start or a
    // non-alphanumeric.
    i = 0;
    while i < bytes.len() {
        let prev_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        if prev_ok {
            let rest = &bytes[i..];
            let prefix_len = if rest.len() >= 6 && rest[..5].eq_ignore_ascii_case(b"issue") {
                Some(5usize)
            } else if rest.len() >= 3 && rest[..2].eq_ignore_ascii_case(b"gh") {
                Some(2usize)
            } else {
                None
            };
            if let Some(plen) = prefix_len {
                if bytes[i + plen] == b'-' {
                    if let Some((n, _)) = parse_digits(bytes, i + plen + 1) {
                        push(n, &mut seen, &mut out);
                    }
                }
            }
        }
        i += 1;
    }

    out
}

/// Extract the linked project's Jira issue keys from git text (branch name,
/// commit subjects) — `<PROJECTKEY>-\d+` case-insensitive, deduped,
/// first-occurrence order, upper-cased. KEEP IN SYNC: `extractJiraKeys` in
/// src/lib/jira/keys.ts (same boundary table; no lookbehind — hand-rolled scan).
///
/// Boundary semantics (copied from keys.ts's documented table):
///   - LEFT: the char before the key must NOT be `[A-Za-z0-9]` — underscore
///     adjacency IS allowed (`feature_MYT-5` → MYT-5); a letter/digit prefix
///     rejects (`XMYT-1` → []).
///   - RIGHT (after the digits): reject a letter suffix (`MYT-12a` → []) and a
///     version-like `dot+digit` (`MYT-1.2` → []); a sentence-ending period still
///     matches (`fixes MYT-1.` → MYT-1).
///
/// Case-insensitive on the key. Empty text or empty `project_key` → `[]`.
/// Case table: `feature_MYT-5 → MYT-5`, `feat/myt-2-fix → MYT-2`, `XMYT-1 → []`,
/// `MYT-12a → []`, `MYT-1.2 → []`, `fixes MYT-1. → MYT-1`.
fn extract_jira_keys(text: &str, project_key: &str) -> Vec<String> {
    if text.is_empty() || project_key.is_empty() {
        return Vec::new();
    }
    let bytes = text.as_bytes();
    let key_bytes = project_key.as_bytes();
    let klen = key_bytes.len();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();

    let mut i = 0usize;
    while i < bytes.len() {
        // LEFT boundary: at start, or the preceding byte is not [A-Za-z0-9].
        let left_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        // Case-insensitive prefix match on the project key.
        let key_ok = i + klen <= bytes.len() && bytes[i..i + klen].eq_ignore_ascii_case(key_bytes);
        if left_ok && key_ok {
            // Must be followed by `-` then ≥1 ASCII digit.
            let dash = i + klen;
            if dash < bytes.len() && bytes[dash] == b'-' {
                let mut j = dash + 1;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j > dash + 1 {
                    // At least one digit consumed. RIGHT boundary checks:
                    //   - no trailing letter (`MYT-12a`)
                    //   - no `dot+digit` (`MYT-1.2`), while `MYT-1.` still matches.
                    let next = bytes.get(j).copied();
                    let letter_suffix = next.is_some_and(|b| b.is_ascii_alphabetic());
                    let dot_digit = next == Some(b'.')
                        && bytes.get(j + 1).copied().is_some_and(|b| b.is_ascii_digit());
                    if !letter_suffix && !dot_digit {
                        // Canonical upper-case key so `myt-2` and `MYT-2` dedupe.
                        let key = text[i..j].to_ascii_uppercase();
                        if seen.insert(key.clone()) {
                            out.push(key);
                        }
                        // Advance past this key (can't start another match mid-run).
                        i = j;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// The set of ASCII-lowercased tokens of length ≥ 4 in `text`, splitting on any
/// non-alphanumeric character. Used to score candidate-issue title overlap with
/// the branch name + commit subjects when ranking fill candidates.
fn long_tokens(text: &str) -> std::collections::HashSet<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| t.len() >= 4)
        .map(|t| t.to_ascii_lowercase())
        .collect()
}

/// The trailing recipe `note`, restating the output-format constraints in one
/// sentence so the calling agent knows what to produce even if it skims the
/// system prompt. `output` is the artifact name; `constraints` restates the
/// format rule.
fn recipe_note(output: &str, constraints: &str) -> String {
    format!(
        "GitDesktop assembled this context from the repository. Complete the prompt with your own \
         model and use the result as the {output}. {constraints}"
    )
}

/// The `{ system, prompt, note }` recipe payload every generation tool returns.
#[derive(Debug, serde::Serialize)]
struct Recipe {
    system: String,
    prompt: String,
    note: String,
}

// ---- Pure prompt assembly (mirrors the TS builders; unit-testable) ---------

/// The gathered pieces a commit recipe is assembled from — factored out so the
/// assembly is a pure function testable without a repo.
struct CommitPieces {
    diff_text: String,
    diff_truncated: bool,
    files: Vec<DiffStatEntry>,
    excluded_files: u32,
    recent_subjects: Vec<String>,
    repo_instructions: Option<String>,
    global_instructions: String,
}

/// Assemble the commit-message recipe. Mirrors `buildCommitPrompt`
/// (src/lib/ai/prompt.ts) — same section headers, order, and constraint copy.
/// KEEP IN SYNC.
fn assemble_commit_recipe(p: CommitPieces) -> Recipe {
    let mut system_parts = vec![BASE_SYSTEM.to_string()];
    push_instruction_sections(
        &mut system_parts,
        p.repo_instructions.as_deref(),
        &p.global_instructions,
    );

    let file_summary = p
        .files
        .iter()
        .map(file_summary_line)
        .collect::<Vec<_>>()
        .join("\n");
    // Mirror the TS `budgetDiff(stripBinarySections(diff))`: strip binary
    // sections, then budget-filter (drop lockfiles/generated, cap per-file, hard-cap).
    let budgeted = budget_diff(&strip_binary_sections(&p.diff_text));

    let mut files_section = format!(
        "## Files changed\n{}",
        if file_summary.is_empty() {
            "(none)"
        } else {
            &file_summary
        }
    );
    if p.excluded_files > 0 {
        files_section.push_str(&format!(
            "\n[{} additional changed file(s) hidden by the user's AI ignore rules — do not speculate about them]",
            p.excluded_files
        ));
    }
    let mut prompt_parts = vec![files_section];
    if !p.recent_subjects.is_empty() {
        prompt_parts.push(format!(
            "## Recent commit subjects (style reference)\n{}",
            p.recent_subjects.join("\n")
        ));
    }
    let mut diff_section = format!("## Staged diff\n{}", budgeted.text);
    if budgeted.truncated || p.diff_truncated {
        // Divergence from TS: neither the git file-boundary truncation nor our
        // budget_diff enumerate the omitted file names here, so this marker omits
        // the TS `N file(s) omitted: …` clause. The "rely on the file summary above"
        // guidance is preserved.
        diff_section
            .push_str("\n[diff truncated — Rely on the file summary above for full coverage.]");
    }
    prompt_parts.push(diff_section);
    prompt_parts.push("Write the commit message for these staged changes.".to_string());

    Recipe {
        system: system_parts.join("\n\n"),
        prompt: prompt_parts.join("\n\n"),
        note: recipe_note(
            "commit message",
            "The subject line must be imperative mood and at most 72 characters, a body follows \
             after a blank line (a few sentences, or one dash bullet per area for a larger change; \
             omit it only for a trivial, self-explanatory change), and the output must contain no \
             markdown fences or issue/PR references.",
        ),
    }
}

/// The gathered pieces a branch-name recipe is assembled from.
struct BranchPieces {
    diff_text: String,
    diff_truncated: bool,
    files: Vec<DiffStatEntry>,
    untracked_paths: Vec<String>,
    excluded_files: u32,
    recent_branches: Vec<String>,
    /// Subjects of the commits this branch adds over its base, newest first —
    /// the strongest naming signal when the work is already committed, and supplied
    /// ONLY on that fallback path. Empty when the base can't be resolved, when the
    /// branch adds no commits, and when the `git log` itself fails (best-effort) —
    /// an empty list is never evidence that the branch has no commits.
    commit_subjects: Vec<String>,
    repo_instructions: Option<String>,
    global_instructions: String,
}

/// Assemble the branch-name recipe. Mirrors `buildBranchNamePrompt`
/// (src/lib/ai/prompt.ts). KEEP IN SYNC.
fn assemble_branch_recipe(p: BranchPieces) -> Recipe {
    let mut system_parts = vec![BRANCH_SYSTEM.to_string()];
    push_instruction_sections(
        &mut system_parts,
        p.repo_instructions.as_deref(),
        &p.global_instructions,
    );

    let mut summary_lines: Vec<String> = p.files.iter().map(file_summary_line).collect();
    for path in &p.untracked_paths {
        summary_lines.push(format!("{path} (new file)"));
    }
    let file_summary = summary_lines.join("\n");
    // Mirror the TS `budgetDiff(stripBinarySections(diff))`.
    let budgeted = budget_diff(&strip_binary_sections(&p.diff_text));

    let mut files_section = format!(
        "## Files changed\n{}",
        if file_summary.is_empty() {
            "(none)"
        } else {
            &file_summary
        }
    );
    if p.excluded_files > 0 {
        files_section.push_str(&format!(
            "\n[{} additional changed file(s) hidden by the user's AI ignore rules]",
            p.excluded_files
        ));
    }
    let mut prompt_parts = vec![files_section];
    if !p.recent_branches.is_empty() {
        prompt_parts.push(format!(
            "## Existing branch names (convention reference)\n{}",
            p.recent_branches.join("\n")
        ));
    }
    if !p.commit_subjects.is_empty() {
        prompt_parts.push(format!(
            "## Commits on this branch (newest first)\n{}",
            p.commit_subjects.join("\n")
        ));
    }
    // Mirror the TS `budgeted.text || "(no text diff …)"` fallback.
    let diff_body = if budgeted.text.is_empty() {
        "(no text diff — name the branch from the file list above)".to_string()
    } else {
        budgeted.text
    };
    let mut diff_section = format!("## Changes diff\n{diff_body}");
    if budgeted.truncated || p.diff_truncated {
        diff_section
            .push_str("\n[diff truncated — rely on the file summary above for full coverage.]");
    }
    prompt_parts.push(diff_section);
    prompt_parts.push("Generate the branch name for these changes.".to_string());

    Recipe {
        system: system_parts.join("\n\n"),
        prompt: prompt_parts.join("\n\n"),
        note: recipe_note(
            "branch name",
            "The output must be a single valid git ref name in lowercase kebab-case, one line, with \
             no quotes, markdown, or trailing period.",
        ),
    }
}

/// A real issue from the repo's tracker the model may link. KEEP IN SYNC with the
/// TS `PrPromptInput.issueCandidates` entries (src/lib/ai/types.ts).
struct IssueCandidate {
    number: u64,
    title: String,
    /// Neutral state: "OPEN" / "CLOSED".
    state: String,
}

/// A real issue from the repo's LINKED Jira project the model may mention.
/// Mention-only: Jira tickets are never closed from PR-description text.
struct JiraCandidate {
    key: String,
    summary: String,
    /// Jira status category: "new" / "indeterminate" / "done" / "".
    status_category: String,
}

/// The gathered pieces a PR-description recipe is assembled from.
struct PrPieces {
    diff_text: String,
    diff_truncated: bool,
    files: Vec<DiffStatEntry>,
    /// How many changed files the user's AI ignore patterns hid from `files` /
    /// `diff_text`, disclosed in the files section so the model knows the diff
    /// isn't the whole story.
    excluded_files: u32,
    commit_subjects: Vec<String>,
    base_branch: String,
    head_branch: String,
    /// The repo's labels as `(name, description)` pairs. The description (the
    /// label's stated purpose) is threaded into the prompt so the model weighs a
    /// label by what it's for, not just a name-plausible match.
    available_labels: Vec<(String, Option<String>)>,
    /// Real candidate issues the model may link (best-effort, fetched server-side).
    /// Empty ⇒ the prompt is byte-identical to before and the issue-reference ban
    /// stands.
    candidate_issues: Vec<IssueCandidate>,
    /// Real candidate issues from the repo's LINKED Jira project the model may
    /// MENTION (best-effort; Bitbucket-only). Mutually exclusive with
    /// `candidate_issues` — the Bitbucket-only gather makes both-non-empty
    /// impossible by construction; if both ever arrive, `candidate_issues` wins
    /// and this is ignored (precedence encoded in `assemble_pr_recipe`).
    jira_candidates: Vec<JiraCandidate>,
    repo_instructions: Option<String>,
    global_instructions: String,
    /// Frontend provider tag: `"github"` / `"gitlab"` / `"bitbucket"`, or None
    /// (GitHub wording, byte-for-byte).
    provider: Option<String>,
}

/// Render one label as a bullet line for the prompt's `## Labels` section:
/// `- name — description`, with the ` — description` part omitted when the
/// description is empty/whitespace. The description is trimmed and capped at 140
/// chars. Mirrors the TS `renderLabelLine` (src/lib/ai/prompt.ts) — KEEP IN SYNC.
fn render_label_line(name: &str, description: &str) -> String {
    let desc = description.trim();
    if desc.is_empty() {
        format!("- {name}")
    } else {
        let capped: String = desc.chars().take(140).collect();
        format!("- {name} — {capped}")
    }
}

/// Render one candidate issue as a bullet for the `## Related issues` section:
/// `- #123 — title`, ` (closed)` suffixed when closed, the ` — title` part omitted
/// when the title is empty. Title capped at 140 chars. Mirrors the TS
/// `renderIssueLine` (src/lib/ai/prompt.ts) — KEEP IN SYNC.
fn render_issue_line(number: u64, title: &str, state: &str) -> String {
    let closed = state.eq_ignore_ascii_case("CLOSED");
    let suffix = if closed { " (closed)" } else { "" };
    let title = title.trim();
    if title.is_empty() {
        format!("- #{number}{suffix}")
    } else {
        let capped: String = title.chars().take(140).collect();
        format!("- #{number}{suffix} — {capped}")
    }
}

/// Render one Jira candidate as a bullet for the `## Related issues` section:
/// `- MYT-123 — summary`, ` (done)` suffixed when `status_category` is "done",
/// bare `- MYT-123` when the summary is empty. Summary trimmed + 140-char cap.
/// KEEP IN SYNC with the TS mirror (`renderJiraLine`, src/lib/ai/prompt.ts).
fn render_jira_line(key: &str, summary: &str, status_category: &str) -> String {
    let done = status_category.eq_ignore_ascii_case("done");
    let suffix = if done { " (done)" } else { "" };
    let summary = summary.trim();
    if summary.is_empty() {
        format!("- {key}{suffix}")
    } else {
        let capped: String = summary.chars().take(140).collect();
        format!("- {key}{suffix} — {capped}")
    }
}

/// Assemble the PR/MR-description recipe. Mirrors `buildPrPrompt`
/// (src/lib/ai/prompt.ts) — provider-aware noun/markdown-flavor, the label
/// proposal system section, and the closing instructions. KEEP IN SYNC.
fn assemble_pr_recipe(p: PrPieces) -> Recipe {
    let copy = platform_copy(p.provider.as_deref());
    let pr_noun = copy.pr_noun;
    let abbrev = if pr_noun == "merge request" {
        "MR"
    } else {
        "PR"
    };

    // Real candidate issues the model may link (defensive cap 8, mirrored TS-side).
    // Empty ⇒ the issue-reference ban stands and the recipe is byte-identical to
    // before (no ban swap, no `## Related issues` section, unchanged note).
    let candidates: Vec<&IssueCandidate> =
        p.candidate_issues.iter().filter(|c| c.number > 0).take(8).collect();
    let has_candidates = !candidates.is_empty();

    // Jira candidates (Bitbucket repos with a linked project). Mention-only: they
    // drive a `Relates:`-only variant, never a `Closes:` line. Precedence: native
    // `candidate_issues` win — the Jira variant fires ONLY when there are no native
    // candidates (the Bitbucket-only gather makes both-non-empty impossible, but the
    // precedence is encoded here defensively). Filter empty keys, then cap at 8.
    let jira_candidates: Vec<&JiraCandidate> = if has_candidates {
        Vec::new()
    } else {
        p.jira_candidates
            .iter()
            .filter(|c| !c.key.is_empty())
            .take(8)
            .collect()
    };
    let has_jira = !jira_candidates.is_empty();

    let mut base_system = pr_system_for(p.provider.as_deref());
    if has_candidates {
        // Swap the issue-reference ban line for the relaxed rule that allows the
        // final `Closes:`/`Relates:` trailer lines drawn from the Related issues
        // section. Both lines are constructed with the in-scope `abbrev`, so the
        // swap works cross-provider (GitHub `PR` / GitLab `MR`).
        let ban = format!(
            "- NEVER reference issue or {abbrev} numbers, tickets, milestones, or external links (e.g. \"Closes #123\", \"part of #60\", \"fixes JIRA-4\"). You have no access to the issue tracker, so any such reference is fabricated — leave them out entirely."
        );
        let relaxed = format!(
            "- Do not put issue or {abbrev} numbers, tickets, milestones, or external links in the description body — the ONLY issue references you may make are the final Closes:/Relates: lines defined in the \"Related issues\" section, chosen from its list. Any other reference is fabricated — leave it out."
        );
        base_system = base_system.replacen(&ban, &relaxed, 1);
    } else if has_jira {
        // Jira mention-only variant: swap the ban for a RELAXED line that permits
        // only the final `Relates:` line (no `Closes:` — Jira tickets aren't closed
        // from PR text). `abbrev` is "PR" on Bitbucket.
        let ban = format!(
            "- NEVER reference issue or {abbrev} numbers, tickets, milestones, or external links (e.g. \"Closes #123\", \"part of #60\", \"fixes JIRA-4\"). You have no access to the issue tracker, so any such reference is fabricated — leave them out entirely."
        );
        let relaxed = format!(
            "- Do not put issue or {abbrev} numbers, tickets, milestones, or external links in the description body — the ONLY ticket references you may make are the final Relates: line defined in the \"Related issues\" section, chosen from its list. Any other reference is fabricated — leave it out."
        );
        base_system = base_system.replacen(&ban, &relaxed, 1);
    }

    let mut system_parts = vec![base_system];
    push_instruction_sections(
        &mut system_parts,
        p.repo_instructions.as_deref(),
        &p.global_instructions,
    );

    let file_summary = p
        .files
        .iter()
        .map(file_summary_line)
        .collect::<Vec<_>>()
        .join("\n");
    // Mirror the TS `budgetDiff(stripBinarySections(diff))`.
    let budgeted = budget_diff(&strip_binary_sections(&p.diff_text));

    let mut prompt_parts = vec![format!(
        "This {pr_noun} merges `{}` into `{}`.",
        p.head_branch, p.base_branch
    )];
    if !p.commit_subjects.is_empty() {
        prompt_parts.push(format!(
            "## Commits in this {abbrev}\n{}",
            p.commit_subjects
                .iter()
                .map(|s| format!("- {s}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let mut files_section = format!(
        "## Files changed\n{}",
        if file_summary.is_empty() {
            "(none)"
        } else {
            &file_summary
        }
    );
    if p.excluded_files > 0 {
        files_section.push_str(&format!(
            "\n[{} additional changed file(s) hidden by the user's AI ignore rules]",
            p.excluded_files
        ));
    }
    prompt_parts.push(files_section);

    let mut diff_section = format!("## Combined diff\n{}", budgeted.text);
    if budgeted.truncated || p.diff_truncated {
        diff_section.push_str(
            "\n[diff truncated — Rely on the commit list and file summary above for full coverage.]",
        );
    }
    prompt_parts.push(diff_section);

    // Label proposal — only when the repo actually has labels (mirrors the TS
    // `labels.length > 0` gate). Framed in the system prompt and reinforced by the
    // closing line. Each label is rendered with its stated purpose (description) so
    // the model can judge fit by purpose, not a name-plausible match. The parser
    // drops invented labels, so an off-list label is silently discarded.
    let labels: Vec<(&str, &str)> = p
        .available_labels
        .iter()
        .map(|(name, desc)| (name.trim(), desc.as_deref().unwrap_or("").trim()))
        .filter(|(name, _)| !name.is_empty())
        .collect();
    if !labels.is_empty() {
        let label_lines = labels
            .iter()
            .map(|(name, desc)| render_label_line(name, desc))
            .collect::<Vec<_>>()
            .join("\n");
        system_parts.push(format!(
            "## Labels\n{label_lines}\nLabels are optional metadata: for most changes the right outcome is one label or none — never force one. Suggest a label ONLY when the change as a whole is what that label is for, judged by its stated purpose above (or by an unambiguous name when it has no description). Some labels belong to automation or maintainer workflows rather than to authors: dependency-bot ecosystem labels (a language or tooling name described like \"Pull requests that update … code\", which bots apply to dependency bumps), changelog or release controls, and triage states. Never suggest those for ordinary code changes — only when the change is precisely that case (for example, a PR that does nothing but bump dependencies).\nAfter the description, if any label qualifies, add a final line exactly like `Labels: name1, name2` listing ONLY label names from the list above, copied verbatim. Omit the line entirely when none qualify — never invent a label."
        ));
    }

    // Related-issues proposal — only when real candidates were found (server-side
    // fetch). Pushed AFTER the Labels section so the `Closes:`/`Relates:` trailer
    // lines land after any `Labels:` line. Empty ⇒ this section is absent and the
    // ban above is untouched.
    if has_candidates {
        let issue_lines = candidates
            .iter()
            .map(|c| render_issue_line(c.number, &c.title, &c.state))
            .collect::<Vec<_>>()
            .join("\n");
        system_parts.push(format!(
            "## Related issues\n{issue_lines}\nThese are real, open-or-closed issues from this repository's tracker that MAY be related to this change — judge each by its title against what the diff actually does. Most changes genuinely address at most one or two, often none; never force a link. After the description (and after the Labels line when present), report qualifying issues on up to two final lines, exactly like:\nCloses: 123, 456\nRelates: 789\nUse Closes ONLY for an issue this change fully resolves — merging will close it automatically, so prefer Relates when unsure. Use Relates for an issue this change advances or clearly connects to without resolving it. List ONLY numbers from the list above, never any other number; omit either line (or both) when no issue qualifies."
        ));
    } else if has_jira {
        // Jira mention-only variant of the Related-issues section (Bitbucket + linked
        // project). Pushed AFTER the Labels section so the `Relates:` line lands after
        // any `Labels:` line. Only a `Relates:` line is offered — Jira tickets are not
        // closed from PR text.
        let issue_lines = jira_candidates
            .iter()
            .map(|c| render_jira_line(&c.key, &c.summary, &c.status_category))
            .collect::<Vec<_>>()
            .join("\n");
        system_parts.push(format!(
            "## Related issues\n{issue_lines}\nThese are real issues from this repository's linked Jira project that MAY be related to this change — judge each by its title against what the diff actually does. Most changes genuinely address at most one or two, often none; never force a link. After the description (and after the Labels line when present), report qualifying issues on ONE final line, exactly like:\nRelates: MYT-123, MYT-456\nNever use a Closes line for these — Jira tickets are not closed from pull-request text. List ONLY keys from the list above, never any other key; omit the line when no issue qualifies."
        ));
    }

    let mut closing = format!(
        "Write the {pr_noun} title and description. Lead with a summary of the goal, then group \
         related changes by theme under `###` headings when the diff touches several areas, citing \
         the files involved."
    );
    if !labels.is_empty() {
        closing.push_str(
            " Then, if any of the repository's labels qualify, end with a single `Labels:` line as \
             instructed.",
        );
    }
    if has_candidates {
        closing.push_str(
            " Then, if any of the listed related issues qualify, end with the `Closes:` / `Relates:` \
             line(s) as instructed.",
        );
    } else if has_jira {
        closing.push_str(
            " Then, if any of the listed related issues qualify, end with the `Relates:` line as \
             instructed.",
        );
    }
    prompt_parts.push(closing);

    // The note's trailing clause: with native candidates the `no issue/{abbrev}
    // references` rule is replaced by the Closes:/Relates: allowance; with Jira
    // candidates by the mention-only Relates: allowance; without either, it's
    // byte-identical to before.
    let note_tail = if has_candidates {
        "; issue references may appear ONLY as the final Closes:/Relates: lines drawn from the Related issues section".to_string()
    } else if has_jira {
        "; ticket references may appear ONLY as the final Relates: line drawn from the Related issues section".to_string()
    } else {
        format!(" and no issue/{abbrev} references")
    };
    Recipe {
        system: system_parts.join("\n\n"),
        prompt: prompt_parts.join("\n\n"),
        note: recipe_note(
            &format!("{pr_noun} title and description"),
            &format!(
                "The first line is the {pr_noun} title (imperative, no trailing period), then a \
                 blank line, then the description in {}, with no code fences{note_tail}.",
                copy.markdown_flavor
            ),
        ),
    }
}

// ---- Provider detection (network-light mirror of forge::detect_non_github) --

/// Resolve the frontend provider tag (`"github"` / `"gitlab"` / `"bitbucket"`) for
/// the bound repo from its `origin` remote, or None when it can't be determined
/// (no remote, unparseable URL, or an unrecognized host — the GitHub wording is
/// the resilient default). Composed from the same public primitives
/// `forge::detect_non_github` uses (remote URL → host → tag, with glab's
/// known-hosts covering self-managed GitLab) so it stays in lockstep without a
/// live status probe.
async fn provider_tag(repo: &str) -> Option<String> {
    let url = crate::git::remote::git_remote_url(repo.to_string(), "origin".to_string())
        .await
        .ok()?;
    let host = crate::forge::remote_host(&url)?;
    let glab_hosts = crate::forge::glab::known_hosts().await;
    crate::forge::provider_tag_for_host(&host, &glab_hosts).map(str::to_string)
}

// ---- The recipe tools ------------------------------------------------------

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct PrRecipeArgs {
    /// Base branch the PR/MR would merge INTO. Defaults to the repo's default
    /// branch when omitted.
    #[serde(default)]
    base: Option<String>,
    /// Head branch the PR/MR would merge FROM. Defaults to the current branch
    /// when omitted.
    #[serde(default)]
    head: Option<String>,
}

#[tool_router(router = generate_router, vis = "pub(crate)")]
impl GitDesktopMcp {
    #[tool(
        description = "Assemble GitDesktop's commit-message generation recipe from the STAGED \
                       changes: returns { system, prompt, note } — the same system + user prompt the \
                       in-app AI commit feature builds (staged diff, per-file summary, recent commit \
                       subjects as a style reference, and any project/user instructions). This tool \
                       does NOT call a model; complete the returned prompt with your own inference \
                       and use the result as the commit message. Errors if nothing is staged."
    )]
    async fn generate_commit_message(&self) -> Result<CallToolResult, McpError> {
        let recipe = self.build_commit_recipe().await?;
        json_result(&to_value(&recipe)?)
    }

    #[tool(
        description = "Assemble GitDesktop's PR/MR-description generation recipe for a branch range: \
                       returns { system, prompt, note } — the same provider-aware system + user \
                       prompt the in-app AI feature builds (three-dot branch diff, the commit \
                       subjects the PR would introduce, a per-file summary, the repo's available \
                       labels when any, and project/user instructions). Defaults: base = the repo's \
                       default branch, head = the current branch. This tool does NOT call a model; \
                       complete the returned prompt with your own inference."
    )]
    async fn generate_pr_description(
        &self,
        Parameters(args): Parameters<PrRecipeArgs>,
    ) -> Result<CallToolResult, McpError> {
        let recipe = self.build_pr_recipe(args).await?;
        json_result(&to_value(&recipe)?)
    }

    #[tool(
        description = "Assemble GitDesktop's branch-name generation recipe from the WHOLE working \
                       tree (staged + unstaged vs HEAD, plus untracked file names): returns \
                       { system, prompt, note } — the same system + user prompt the in-app AI feature \
                       builds (worktree diff, file summary, existing branch names as a convention \
                       reference, and project/user instructions). When the working tree is clean it \
                       falls back to the branch's COMMITTED work — the three-dot diff and commit \
                       subjects vs the repo's default branch — so an already-committed branch can \
                       still be named. This tool does NOT call a model; complete the returned prompt \
                       with your own inference and use the result as the branch name."
    )]
    async fn generate_branch_name(&self) -> Result<CallToolResult, McpError> {
        let recipe = self.build_branch_recipe().await?;
        json_result(&to_value(&recipe)?)
    }
}

// ---- Recipe builders (shared by the recipe TOOLS above and the PROMPTS below) --
//
// Each gathers the repository context and assembles the `Recipe`, returning the
// same `McpError::invalid_request` on the empty-input cases. The tools serialize
// the recipe as JSON; the prompts render it as a single user PromptMessage. One
// source of truth so a tool and its twin prompt can never drift.
impl GitDesktopMcp {
    /// The user's AI-ignore patterns for the bound repo: the repo's own ignore
    /// file first, then the global setting's patterns — the merge every recipe
    /// passes to the git layer as pathspec excludes. Takes the caller's already-read
    /// `settings`, so one recipe call reads the settings store exactly once.
    async fn ai_ignore_patterns(
        &self,
        settings: &crate::app_store::AiGenSettings,
    ) -> Result<Vec<String>, McpError> {
        let repo_ignore = crate::instructions::read_repo_ai_ignore(self.repo.clone())
            .await
            .map_err(app_err)?;
        Ok(repo_ignore
            .into_iter()
            .chain(settings.ai_ignore_patterns.iter().cloned())
            .collect())
    }

    /// Gather + assemble the commit-message recipe (STAGED changes). Errors with
    /// `invalid_request` when nothing is staged.
    async fn build_commit_recipe(&self) -> Result<Recipe, McpError> {
        let settings = crate::app_store::read_ai_generation_settings();
        let exclude = self.ai_ignore_patterns(&settings).await?;

        let staged = crate::git::diff::git_staged_diff(
            self.repo.clone(),
            Some(RAW_DIFF_MAX_BYTES),
            Some(exclude),
            Some(false),
        )
        .await
        .map_err(app_err)?;

        if staged.files.is_empty() {
            let msg = if staged.excluded_files > 0 {
                "All staged changes match the AI ignore patterns — nothing to describe. Stage \
                 changes outside those patterns first."
            } else {
                "Nothing is staged — stage the changes you want a commit message for first."
            };
            return Err(McpError::invalid_request(msg, None));
        }

        let commits = crate::git::commit::git_recent_commits(self.repo.clone(), 10)
            .await
            .map_err(app_err)?;
        let repo_instructions = crate::instructions::read_repo_instructions(self.repo.clone())
            .await
            .map_err(app_err)?;

        Ok(assemble_commit_recipe(CommitPieces {
            diff_text: staged.text,
            diff_truncated: staged.truncated,
            files: staged.files,
            excluded_files: staged.excluded_files,
            recent_subjects: commits.into_iter().map(|c| c.subject).collect(),
            repo_instructions,
            global_instructions: settings.global_instructions,
        }))
    }

    /// Gather + assemble the PR/MR-description recipe for a branch range, applying
    /// the in-app base/head defaults.
    async fn build_pr_recipe(&self, args: PrRecipeArgs) -> Result<Recipe, McpError> {
        // One settings read per recipe: it feeds both the ignore-pattern merge and
        // the user-instructions section below.
        let settings = crate::app_store::read_ai_generation_settings();
        // Resolve base/head, applying the same defaults the in-app flow uses.
        let base = match args.base {
            Some(b) => b,
            None => crate::git::branches::git_default_branch(self.repo.clone())
                .await
                .map_err(app_err)?
                .ok_or_else(|| {
                    McpError::invalid_request(
                        "Could not determine the repository's default branch — pass an explicit \
                         `base`.",
                        None,
                    )
                })?,
        };
        let head = match args.head {
            Some(h) => h,
            None => current_branch(&self.repo).await?,
        };
        ensure_not_flag(&base, "base")?;
        ensure_not_flag(&head, "head")?;

        // The user's AI-ignore patterns (repo ignore file first, then the global
        // setting) — the same merge the commit/branch recipes do, so a file the user
        // excluded never reaches the model.
        let exclude = self.ai_ignore_patterns(&settings).await?;

        let diff = crate::git::compare::git_branch_diff(
            self.repo.clone(),
            base.clone(),
            head.clone(),
            Some(RAW_DIFF_MAX_BYTES),
            Some(exclude),
        )
        .await
        .map_err(app_err)?;

        // An empty range must not yield a silent, contentless recipe: without this
        // the agent would write a description from the commit subjects alone (and,
        // with excludes, from files it was never shown). Mirrors the in-app toast
        // and the commit/branch recipes' empty-input errors.
        if diff.files.is_empty() {
            let msg = if diff.excluded_files > 0 {
                format!(
                    "All changes between {base} and {head} match the AI ignore patterns — nothing \
                     to describe."
                )
            } else {
                format!("No changes between {base} and {head} to describe.")
            };
            return Err(McpError::invalid_request(msg, None));
        }

        // The commits the PR would introduce = base..head "ahead" set (compare =
        // head), exactly as the in-app Create-PR flow derives `commitSubjects` from
        // `git_compare_branches(...).ahead`. Best-effort: an error yields no list.
        let commit_subjects = crate::git::compare::git_compare_branches(
            self.repo.clone(),
            base.clone(),
            head.clone(),
        )
        .await
        .map(|c| c.ahead.into_iter().map(|s| s.subject).collect::<Vec<_>>())
        .unwrap_or_default();

        // Labels are best-effort: a forge error omits the section entirely rather
        // than failing the tool (mirrors the spec's best-effort contract).
        let available_labels = crate::forge::forge_repo_labels(self.repo.clone(), None)
            .await
            .map(|labels| {
                labels
                    .into_iter()
                    .map(|l| (l.name, l.description))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        // Related-issue candidates are best-effort (mirrors the labels fetch): any
        // error — including Bitbucket's issues-disabled error — yields an empty list
        // and thus no `## Related issues` section.
        let candidate_issues = self.gather_pr_candidates(&head, &commit_subjects).await;

        let provider = provider_tag(&self.repo).await;

        // On a Bitbucket repo with NO native candidates (its issue tracker is
        // deprecated, so `candidate_issues` is always empty there) but a linked Jira
        // project, gather Jira candidates for a mention-only `Relates:` variant.
        // Best-effort: never fails the recipe. Mutually exclusive with the native list.
        let jira_candidates = if candidate_issues.is_empty()
            && provider.as_deref() == Some("bitbucket")
        {
            self.gather_jira_candidates(&head, &commit_subjects).await
        } else {
            Vec::new()
        };

        let repo_instructions = crate::instructions::read_repo_instructions(self.repo.clone())
            .await
            .map_err(app_err)?;

        Ok(assemble_pr_recipe(PrPieces {
            diff_text: diff.text,
            diff_truncated: diff.truncated,
            files: diff.files,
            excluded_files: diff.excluded_files,
            commit_subjects,
            base_branch: base,
            head_branch: head,
            available_labels,
            candidate_issues,
            jira_candidates,
            repo_instructions,
            global_instructions: settings.global_instructions,
            provider,
        }))
    }

    /// Gather up to 8 real candidate issues for the PR-description prompt,
    /// best-effort (any forge error → empty, matching the labels fetch). Numbers
    /// referenced in the branch name + commit subjects are pinned first (extraction
    /// order); remaining slots fill from the open-issue page ranked by title-token
    /// overlap with the branch + subjects. Mirrors the TS candidate gathering.
    async fn gather_pr_candidates(
        &self,
        head: &str,
        commit_subjects: &[String],
    ) -> Vec<IssueCandidate> {
        // Text the extraction + ranking read from: branch name + each commit subject.
        let subjects = commit_subjects.join("\n");
        let extracted = extract_issue_numbers(&format!("{head}\n{subjects}"));

        // The open-issue page (origin-pinned, like the labels fetch: `lens = None`).
        // On any error (incl. Bitbucket's issues-disabled), there are no candidates.
        let open_page: Vec<crate::github::issue::IssueInfo> =
            crate::forge::forge_issue_list(self.repo.clone(), "open".to_string(), Some(50), None)
                .await
                .unwrap_or_default();

        let mut out: Vec<IssueCandidate> = Vec::new();
        let mut included: std::collections::HashSet<u64> = std::collections::HashSet::new();

        // 1. Extracted numbers first (pinned, extraction order). Prefer the open-page
        //    entry; for numbers not on the page, probe the single-issue view and
        //    include on success, dropping silently on any error.
        for n in &extracted {
            if included.contains(n) {
                continue;
            }
            if let Some(info) = open_page.iter().find(|i| i.number == *n) {
                included.insert(*n);
                out.push(IssueCandidate {
                    number: info.number,
                    title: info.title.clone(),
                    state: info.state.clone(),
                });
            } else if let Ok(details) =
                crate::forge::forge_issue_view(self.repo.clone(), *n, None).await
            {
                included.insert(*n);
                out.push(IssueCandidate {
                    number: details.number,
                    title: details.title,
                    state: details.state,
                });
            }
        }

        // 2. Fill remaining slots (up to 8 total) from the open page, ranked by the
        //    count of shared long (≥4-char) tokens between the issue title and the
        //    branch + subjects, tie-broken by `updated_at` descending.
        if out.len() < 8 {
            let context = format!("{head}\n{subjects}");
            let context_tokens = long_tokens(&context);
            let mut ranked: Vec<(usize, &crate::github::issue::IssueInfo)> = open_page
                .iter()
                .filter(|i| !included.contains(&i.number))
                .map(|i| {
                    let title_tokens = long_tokens(&i.title);
                    let score = title_tokens
                        .iter()
                        .filter(|t| context_tokens.contains(*t))
                        .count();
                    (score, i)
                })
                .collect();
            // Score desc, then updated_at desc (string compare on ISO-8601 is
            // chronological).
            ranked.sort_by(|a, b| {
                b.0.cmp(&a.0)
                    .then_with(|| b.1.updated_at.cmp(&a.1.updated_at))
            });
            for (_, info) in ranked {
                if out.len() >= 8 {
                    break;
                }
                out.push(IssueCandidate {
                    number: info.number,
                    title: info.title.clone(),
                    state: info.state.clone(),
                });
            }
        }

        out
    }

    /// Gather up to 8 Jira candidates for the PR-description prompt from the repo's
    /// LINKED Jira project (Bitbucket repos), best-effort — any failure (no link, a
    /// Jira API error) yields an empty list so the recipe NEVER fails because Jira
    /// isn't linked. Keys referenced in the branch name + commit subjects are pinned
    /// first (extraction order); remaining slots fill from the open-issue page ranked
    /// by summary-token overlap. Mirrors `gather_pr_candidates`.
    async fn gather_jira_candidates(
        &self,
        head: &str,
        commit_subjects: &[String],
    ) -> Vec<JiraCandidate> {
        // Resolve the linked project (site + key). No link ⇒ no candidates (the recipe
        // must never fail because Jira isn't linked, so map the error to empty).
        let Ok(link) = self.jira_link().await else {
            return Vec::new();
        };

        // Text the extraction + ranking read from: branch name + each commit subject.
        let subjects = commit_subjects.join("\n");
        let extracted = extract_jira_keys(&format!("{head}\n{subjects}"), &link.project_key);

        // The open-issue page (single page, 50-cap internal). Any error ⇒ no candidates.
        let open_page: Vec<crate::forge::jira::JiraIssueInfo> =
            crate::forge::jira::issue_list(&link.site_host, &link.project_key, "open")
                .await
                .unwrap_or_default();

        let mut out: Vec<JiraCandidate> = Vec::new();
        let mut included: std::collections::HashSet<String> = std::collections::HashSet::new();

        // 1. Extracted keys first (pinned, extraction order). Prefer the open-page
        //    entry; for keys not on the page, probe the single-issue view (only after
        //    confirming the key belongs to the linked project), including on success and
        //    dropping silently on any error.
        for key in &extracted {
            if included.contains(key) {
                continue;
            }
            if let Some(info) = open_page.iter().find(|i| i.key.eq_ignore_ascii_case(key)) {
                included.insert(key.clone());
                out.push(JiraCandidate {
                    key: info.key.clone(),
                    summary: info.summary.clone(),
                    status_category: info.status_category.clone(),
                });
            } else if super::ensure_key_in_project(key, &link).is_ok() {
                if let Ok(details) = crate::forge::jira::issue_view(&link.site_host, key).await {
                    included.insert(key.clone());
                    out.push(JiraCandidate {
                        key: details.key,
                        summary: details.summary,
                        status_category: details.status_category,
                    });
                }
            }
        }

        // 2. Fill remaining slots (up to 8 total) from the open page, ranked by the
        //    count of shared long (≥4-char) tokens between the issue summary and the
        //    branch + subjects, tie-broken by `updated_at` descending.
        if out.len() < 8 {
            let context = format!("{head}\n{subjects}");
            let context_tokens = long_tokens(&context);
            let mut ranked: Vec<(usize, &crate::forge::jira::JiraIssueInfo)> = open_page
                .iter()
                .filter(|i| !included.contains(&i.key))
                .map(|i| {
                    let summary_tokens = long_tokens(&i.summary);
                    let score = summary_tokens
                        .iter()
                        .filter(|t| context_tokens.contains(*t))
                        .count();
                    (score, i)
                })
                .collect();
            ranked.sort_by(|a, b| {
                b.0.cmp(&a.0)
                    .then_with(|| b.1.updated_at.cmp(&a.1.updated_at))
            });
            for (_, info) in ranked {
                if out.len() >= 8 {
                    break;
                }
                out.push(JiraCandidate {
                    key: info.key.clone(),
                    summary: info.summary.clone(),
                    status_category: info.status_category.clone(),
                });
            }
        }

        out
    }

    /// Gather + assemble the branch-name recipe. The WHOLE working tree is the
    /// primary source; when it's clean, the branch's COMMITTED work vs the default
    /// branch is used instead (naming help is most wanted exactly then). Errors with
    /// `invalid_request` — naming the true reason — when neither yields anything.
    async fn build_branch_recipe(&self) -> Result<Recipe, McpError> {
        let settings = crate::app_store::read_ai_generation_settings();
        let exclude = self.ai_ignore_patterns(&settings).await?;

        // Whole-worktree diff vs HEAD (the TS uses git_staged_diff with worktree=true).
        let diff = crate::git::diff::git_staged_diff(
            self.repo.clone(),
            Some(RAW_DIFF_MAX_BYTES),
            Some(exclude.clone()),
            Some(true),
        )
        .await
        .map_err(app_err)?;

        // `git diff HEAD` omits untracked files; list their paths so a branch made
        // entirely of new files can still be named (mirrors the in-app call site).
        let untracked_paths = untracked_files(&self.repo).await.map_err(app_err)?;

        // The base for the committed-work fallback below. Only that path reads the
        // branch's commit subjects: on the working-tree path they'd describe the
        // CURRENT branch, biasing the name toward the parent branch's story.
        let base = committed_base_ref(&self.repo).await;

        // Nothing in progress → name the branch after what it has already committed.
        let (diff, untracked_paths, commit_subjects) = if diff.files.is_empty()
            && untracked_paths.is_empty()
        {
            let Some(base) = base.as_deref() else {
                let msg = if diff.excluded_files > 0 {
                    "All in-progress changes match the AI ignore patterns — nothing to name a \
                     branch after."
                } else {
                    "No in-progress changes, and no default branch to compare committed work \
                     against."
                };
                return Err(McpError::invalid_request(msg, None));
            };
            let mut committed = crate::git::compare::git_branch_diff(
                self.repo.clone(),
                base.to_string(),
                "HEAD".to_string(),
                Some(RAW_DIFF_MAX_BYTES),
                Some(exclude),
            )
            .await
            .map_err(app_err)?;
            if committed.files.is_empty() && committed.text.is_empty() {
                // Name the side that actually hid something: claiming in-progress
                // changes existed when the working tree was clean (or vice versa) is
                // exactly the kind of confident-but-false reason an agent acts on.
                let msg = match (diff.excluded_files > 0, committed.excluded_files > 0) {
                    (true, true) => "All in-progress and committed changes match the AI ignore \
                                     patterns — nothing to name a branch after."
                        .to_string(),
                    (false, true) => format!(
                        "No in-progress changes, and all committed changes vs {base} match the AI \
                         ignore patterns — nothing to name a branch after."
                    ),
                    (true, false) => format!(
                        "All in-progress changes match the AI ignore patterns, and there are no \
                         committed changes vs {base} — nothing to name a branch after."
                    ),
                    // Covers being ON the default branch and a fully-merged branch.
                    (false, false) => format!(
                        "No in-progress changes, and no committed changes vs {base} — nothing to \
                         name a branch after."
                    ),
                };
                return Err(McpError::invalid_request(msg, None));
            }
            // The committed diff has no untracked side. Fold the working tree's
            // hidden files into the disclosure — they're also changes the model
            // can't see (mirrors the TS fallback path). The sum is an UPPER BOUND:
            // a file hidden in both diffs is counted twice. Over-disclosing how much
            // is hidden is the safe direction — the number only tells the model the
            // diff isn't the whole story.
            committed.excluded_files += diff.excluded_files;
            let subjects = branch_commit_subjects(&self.repo, base).await;
            (committed, Vec::new(), subjects)
        } else {
            (diff, untracked_paths, Vec::new())
        };

        let branches = crate::git::branches::git_branches(self.repo.clone())
            .await
            .map(|bs| {
                bs.into_iter()
                    .map(|b| b.name)
                    // App-internal agent-session branches don't belong in the
                    // naming context (and could teach the model to mimic them).
                    .filter(|n| !n.starts_with(super::SESSION_BRANCH_PREFIX))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let repo_instructions = crate::instructions::read_repo_instructions(self.repo.clone())
            .await
            .map_err(app_err)?;

        Ok(assemble_branch_recipe(BranchPieces {
            diff_text: diff.text,
            diff_truncated: diff.truncated,
            files: diff.files,
            untracked_paths,
            excluded_files: diff.excluded_files,
            recent_branches: branches,
            commit_subjects,
            repo_instructions,
            global_instructions: settings.global_instructions,
        }))
    }
}

/// Render a [`Recipe`] as the single user [`PromptMessage`] an MCP prompt returns:
/// the system + user prompt joined, described by the recipe's `note`. The client
/// model completes the assembled prompt (the recipe tools return the same content
/// as JSON; the prompts hand it to the client as a ready-to-complete message).
fn recipe_as_prompt(recipe: Recipe) -> GetPromptResult {
    let Recipe {
        system,
        prompt,
        note,
    } = recipe;
    GetPromptResult::new(vec![PromptMessage::new_text(
        PromptMessageRole::User,
        format!("{system}\n\n{prompt}"),
    )])
    .with_description(note)
}

// ---- The generation PROMPTS (MCP prompts primitive) ------------------------
//
// The same three generation recipes as the tools above, exposed additionally as
// MCP prompts (slash-command-like in clients). Each assembles GitDesktop's system
// + user prompt from the repository and returns it as ONE user message for the
// client's own model to complete — read-only, no writes, no opt-in required. The
// Rust method names carry a `_prompt` suffix so they don't collide with the recipe
// tool methods on the same type.
#[prompt_router(router = "generate_prompt_router", vis = "pub(crate)")]
impl GitDesktopMcp {
    #[prompt(
        name = "commit-message",
        description = "Assemble GitDesktop's commit-message generation prompt from the currently \
                       STAGED changes (staged diff, per-file summary, recent commit subjects as a \
                       style reference, and any project/user instructions) as one ready-to-complete \
                       message. Your model completes it and the result is the commit message. Errors \
                       if nothing is staged."
    )]
    async fn commit_message_prompt(&self) -> Result<GetPromptResult, McpError> {
        Ok(recipe_as_prompt(self.build_commit_recipe().await?))
    }

    #[prompt(
        name = "pr-description",
        description = "Assemble GitDesktop's provider-aware PR/MR-description generation prompt for a \
                       branch range (branch diff, the commit subjects the PR would introduce, a \
                       per-file summary, the repo's labels when any, and project/user instructions) \
                       as one ready-to-complete message. Defaults: base = the repo's default branch, \
                       head = the current branch. Your model completes it and the result is the \
                       PR/MR title and description."
    )]
    async fn pr_description_prompt(
        &self,
        Parameters(args): Parameters<PrRecipeArgs>,
    ) -> Result<GetPromptResult, McpError> {
        Ok(recipe_as_prompt(self.build_pr_recipe(args).await?))
    }

    #[prompt(
        name = "branch-name",
        description = "Assemble GitDesktop's branch-name generation prompt from the WHOLE working \
                       tree (staged + unstaged vs HEAD, plus untracked file names; existing branch \
                       names as a convention reference, and project/user instructions) as one \
                       ready-to-complete message, falling back to the branch's COMMITTED work (the \
                       three-dot diff and commit subjects vs the repo's default branch) when the \
                       working tree is clean. Your model completes it and the result is the branch \
                       name. Errors only when there is neither in-progress nor committed work to \
                       name."
    )]
    async fn branch_name_prompt(&self) -> Result<GetPromptResult, McpError> {
        Ok(recipe_as_prompt(self.build_branch_recipe().await?))
    }
}

/// The bound repo's current branch (`rev-parse --abbrev-ref HEAD`), erroring on a
/// detached/unborn HEAD so the caller can pass an explicit `head`. Mirrors the
/// current-branch read used across the git layer.
async fn current_branch(repo: &str) -> Result<String, McpError> {
    let out = crate::git::runner::run_git(
        Some(repo),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        crate::git::runner::DEFAULT_TIMEOUT,
    )
    .await
    .map_err(app_err)?;
    let branch = out.stdout_lossy().trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        return Err(McpError::invalid_request(
            "HEAD is detached or unborn — pass an explicit `head` branch.",
            None,
        ));
    }
    Ok(branch)
}

/// How many commit subjects the branch-name recipe feeds the model (newest first).
const BRANCH_FALLBACK_MAX_SUBJECTS: usize = 30;

/// Whether a fully-qualified ref resolves in `repo`. A spawn/timeout error counts
/// as "absent" — the caller only ever uses this to pick a ref it can diff against.
async fn ref_exists(repo: &str, full_ref: &str) -> bool {
    crate::git::runner::run_git_raw(
        Some(repo),
        &["rev-parse", "--verify", "--quiet", full_ref],
        crate::git::runner::DEFAULT_TIMEOUT,
    )
    .await
    .map(|out| out.code == 0)
    .unwrap_or(false)
}

/// Subjects of the commits `HEAD` adds over `base` (`git log base..HEAD`), newest
/// first as git emits them, capped at [`BRANCH_FALLBACK_MAX_SUBJECTS`]. Deliberately
/// scoped rather than reusing `git_compare_branches`: that one also walks the
/// `behind` side, which this caller would discard, and the MCP server has no query
/// cache to amortize it. Best-effort — a git failure yields an empty list rather
/// than failing the recipe.
async fn branch_commit_subjects(repo: &str, base: &str) -> Vec<String> {
    let max = BRANCH_FALLBACK_MAX_SUBJECTS.to_string();
    let range = format!("{base}..HEAD");
    let Ok(out) = crate::git::runner::run_git(
        Some(repo),
        &["log", "--format=%s", "-n", &max, &range],
        crate::git::runner::DEFAULT_TIMEOUT,
    )
    .await
    else {
        return Vec::new();
    };
    out.stdout_lossy()
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// The ref a branch's COMMITTED work is compared against for naming: the repo's
/// default branch, preferring the remote-tracking `origin/<default>` over the local
/// `<default>`. `git_default_branch` returns the SHORT LOCAL name even when it
/// derived it from `origin/HEAD`, and that local branch may be stale (skewing the
/// three-dot diff) or not exist at all — so verify both and prefer the remote.
/// `None` = no default branch, or neither ref resolves ⇒ no fallback is possible.
async fn committed_base_ref(repo: &str) -> Option<String> {
    let default = crate::git::branches::git_default_branch(repo.to_string())
        .await
        .ok()
        .flatten()?;
    if ref_exists(repo, &format!("refs/remotes/origin/{default}")).await {
        return Some(format!("origin/{default}"));
    }
    if ref_exists(repo, &format!("refs/heads/{default}")).await {
        return Some(default);
    }
    None
}

/// Untracked (new) file paths, `git ls-files --others --exclude-standard`.
async fn untracked_files(repo: &str) -> Result<Vec<String>, crate::error::AppError> {
    let out = crate::git::runner::run_git(
        Some(repo),
        &["ls-files", "--others", "--exclude-standard"],
        crate::git::runner::DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(out
        .stdout_lossy()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, added: u32, deleted: u32, is_binary: bool) -> DiffStatEntry {
        DiffStatEntry {
            path: path.to_string(),
            added,
            deleted,
            is_binary,
        }
    }

    #[test]
    fn strip_binary_sections_drops_binary_files_only() {
        let diff = "diff --git a/text.rs b/text.rs\n@@ -1 +1 @@\n-a\n+b\n\
                    diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n";
        let stripped = strip_binary_sections(diff);
        assert!(stripped.contains("a/text.rs"));
        assert!(!stripped.contains("logo.png"));
    }

    #[test]
    fn strip_binary_sections_handles_empty_and_headerless() {
        assert_eq!(strip_binary_sections(""), "");
        // No `diff --git` header at all → returned unchanged.
        assert_eq!(strip_binary_sections("just text\n"), "just text\n");
    }

    #[test]
    fn commit_recipe_has_expected_section_headers() {
        let recipe = assemble_commit_recipe(CommitPieces {
            diff_text: "diff --git a/x.rs b/x.rs\n@@ -1 +1 @@\n-a\n+b\n".to_string(),
            diff_truncated: false,
            files: vec![file("x.rs", 1, 1, false)],
            excluded_files: 0,
            recent_subjects: vec!["feat: prior work".to_string()],
            repo_instructions: Some("Repo rule.".to_string()),
            global_instructions: "  Global rule.  ".to_string(),
        });
        // System: base + both instruction sections (global trimmed).
        assert!(recipe.system.starts_with("You write git commit messages."));
        assert!(recipe
            .system
            .contains("## Project instructions\nRepo rule."));
        assert!(recipe.system.contains("## User instructions\nGlobal rule."));
        // Prompt: all the expected headers, in order, plus the closing line.
        assert!(recipe.prompt.contains("## Files changed\nx.rs +1 -1"));
        assert!(recipe
            .prompt
            .contains("## Recent commit subjects (style reference)\nfeat: prior work"));
        assert!(recipe.prompt.contains("## Staged diff\ndiff --git a/x.rs"));
        assert!(recipe
            .prompt
            .ends_with("Write the commit message for these staged changes."));
        // Note restates the 72-char constraint.
        assert!(recipe.note.contains("72 characters"));
    }

    #[test]
    fn commit_recipe_reports_excluded_and_truncated() {
        let recipe = assemble_commit_recipe(CommitPieces {
            diff_text: "diff --git a/x.rs b/x.rs\n+a\n".to_string(),
            diff_truncated: true,
            files: vec![file("x.rs", 1, 0, false)],
            excluded_files: 3,
            recent_subjects: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
        });
        assert!(recipe
            .prompt
            .contains("[3 additional changed file(s) hidden by the user's AI ignore rules"));
        assert!(recipe.prompt.contains("[diff truncated —"));
        // No recent-subjects section when the list is empty.
        assert!(!recipe.prompt.contains("Recent commit subjects"));
        // No instruction sections when both are absent/empty.
        assert!(!recipe.system.contains("## Project instructions"));
        assert!(!recipe.system.contains("## User instructions"));
    }

    #[test]
    fn commit_recipe_empty_file_list_shows_none() {
        let recipe = assemble_commit_recipe(CommitPieces {
            diff_text: String::new(),
            diff_truncated: false,
            files: vec![],
            excluded_files: 0,
            recent_subjects: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
        });
        assert!(recipe.prompt.contains("## Files changed\n(none)"));
    }

    #[test]
    fn branch_recipe_lists_untracked_and_binary() {
        let recipe = assemble_branch_recipe(BranchPieces {
            diff_text: String::new(),
            diff_truncated: false,
            files: vec![file("logo.png", 0, 0, true)],
            untracked_paths: vec!["new.rs".to_string()],
            excluded_files: 0,
            recent_branches: vec!["feature/a".to_string(), "fix/b".to_string()],
            commit_subjects: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
        });
        assert!(recipe.prompt.contains("logo.png (binary)"));
        assert!(recipe.prompt.contains("new.rs (new file)"));
        assert!(recipe
            .prompt
            .contains("## Existing branch names (convention reference)\nfeature/a\nfix/b"));
        // Empty diff → the placeholder body.
        assert!(recipe
            .prompt
            .contains("(no text diff — name the branch from the file list above)"));
        assert!(recipe
            .prompt
            .ends_with("Generate the branch name for these changes."));
        // No commits section when the list is empty.
        assert!(!recipe.prompt.contains("## Commits on this branch"));
    }

    /// The committed-work signal: the commits section sits AFTER the existing branch
    /// names and BEFORE the diff, one subject per line (mirrors the TS builder).
    #[test]
    fn branch_recipe_renders_commit_subjects_between_branches_and_diff() {
        let recipe = assemble_branch_recipe(BranchPieces {
            diff_text: "diff --git a/x.rs b/x.rs\n@@ -1 +1 @@\n-a\n+b\n".to_string(),
            diff_truncated: false,
            files: vec![file("x.rs", 1, 1, false)],
            untracked_paths: vec![],
            excluded_files: 2,
            recent_branches: vec!["feature/a".to_string()],
            commit_subjects: vec![
                "fix: newest".to_string(),
                "feat: older".to_string(),
            ],
            repo_instructions: None,
            global_instructions: String::new(),
        });
        assert!(recipe
            .prompt
            .contains("## Commits on this branch (newest first)\nfix: newest\nfeat: older"));
        let branches_at = recipe.prompt.find("## Existing branch names").unwrap();
        let commits_at = recipe.prompt.find("## Commits on this branch").unwrap();
        let diff_at = recipe.prompt.find("## Changes diff").unwrap();
        assert!(
            branches_at < commits_at && commits_at < diff_at,
            "commits section sits between the branch names and the diff"
        );
        // The ignore-rules disclosure still rides along.
        assert!(recipe
            .prompt
            .contains("[2 additional changed file(s) hidden by the user's AI ignore rules]"));
    }

    #[test]
    fn pr_recipe_github_is_pull_request_wording() {
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: "diff --git a/x.rs b/x.rs\n+a\n".to_string(),
            diff_truncated: false,
            files: vec![file("x.rs", 1, 0, false)],
            excluded_files: 0,
            commit_subjects: vec!["feat: thing".to_string()],
            base_branch: "main".to_string(),
            head_branch: "feature/x".to_string(),
            available_labels: vec![],
            candidate_issues: vec![],
            jira_candidates: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("github".to_string()),
        });
        assert!(recipe
            .system
            .starts_with("You write GitHub pull request descriptions"));
        // No labels section when the repo has none (asserted again below).
        assert!(recipe
            .prompt
            .contains("This pull request merges `feature/x` into `main`."));
        assert!(recipe
            .prompt
            .contains("## Commits in this PR\n- feat: thing"));
        // No labels section when the repo has none.
        assert!(!recipe.system.contains("## Labels"));
    }

    /// The PR recipe discloses how many changed files the user's AI ignore rules hid,
    /// in the files-summary section; a zero count adds no line.
    #[test]
    fn pr_recipe_reports_excluded_files() {
        let pieces = |excluded: u32| PrPieces {
            diff_text: "diff --git a/x.rs b/x.rs\n+a\n".to_string(),
            diff_truncated: false,
            files: vec![file("x.rs", 1, 0, false)],
            excluded_files: excluded,
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "topic".to_string(),
            available_labels: vec![],
            candidate_issues: vec![],
            jira_candidates: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("github".to_string()),
        };
        let hidden = assemble_pr_recipe(pieces(4));
        assert!(hidden
            .prompt
            .contains("## Files changed\nx.rs +1 -0\n[4 additional changed file(s) hidden by the user's AI ignore rules]"));
        let none = assemble_pr_recipe(pieces(0));
        assert!(!none.prompt.contains("hidden by the user's AI ignore rules"));
    }

    #[test]
    fn pr_recipe_gitlab_swaps_noun_and_flavor() {
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: String::new(),
            diff_truncated: false,
            files: vec![],
            excluded_files: 0,
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "topic".to_string(),
            available_labels: vec![
                ("bug".to_string(), None),
                ("  ".to_string(), None),
            ],
            candidate_issues: vec![],
            jira_candidates: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("gitlab".to_string()),
        });
        assert!(recipe.system.contains("GitLab merge request"));
        assert!(recipe.system.contains("GitLab-flavored Markdown"));
        assert!(recipe
            .prompt
            .contains("This merge request merges `topic` into `main`."));
        // Labels present (blank entry filtered out), rendered one per line.
        assert!(recipe.system.contains("## Labels"));
        assert!(recipe.system.contains("\n- bug\n"));
        // The blank-name entry must not produce a dangling bullet.
        assert!(!recipe.system.contains("- \n"));
        // The conservative policy copy is present.
        assert!(recipe
            .system
            .contains("for most changes the right outcome is one label or none"));
        // Note restates MR wording.
        assert!(recipe.note.contains("merge request title"));
    }

    #[test]
    fn pr_recipe_label_with_description_renders_name_and_purpose() {
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: String::new(),
            diff_truncated: false,
            files: vec![],
            excluded_files: 0,
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "topic".to_string(),
            available_labels: vec![(
                "no-changelog".to_string(),
                Some("Skip the changelog check".to_string()),
            )],
            candidate_issues: vec![],
            jira_candidates: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("github".to_string()),
        });
        assert!(recipe
            .system
            .contains("- no-changelog — Skip the changelog check"));
    }

    #[test]
    fn pr_recipe_label_without_description_renders_bare_name() {
        // An empty/whitespace description must not leave a dangling ` — `.
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: String::new(),
            diff_truncated: false,
            files: vec![],
            excluded_files: 0,
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "topic".to_string(),
            available_labels: vec![
                ("enhancement".to_string(), None),
                ("chore".to_string(), Some("   ".to_string())),
            ],
            candidate_issues: vec![],
            jira_candidates: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("github".to_string()),
        });
        assert!(recipe.system.contains("\n- enhancement\n"));
        assert!(recipe.system.contains("- chore"));
        assert!(!recipe.system.contains("- enhancement —"));
        assert!(!recipe.system.contains("- chore —"));
    }

    // ---- Related issues (candidate plumbing + render) ----------------------

    /// The exact PR_SYSTEM issue-reference ban line (post provider-swap for GitHub
    /// it's byte-identical) — used to assert the ban is present without candidates
    /// and absent with them.
    const BAN_LINE: &str = "- NEVER reference issue or PR numbers, tickets, milestones, or external links (e.g. \"Closes #123\", \"part of #60\", \"fixes JIRA-4\"). You have no access to the issue tracker, so any such reference is fabricated — leave them out entirely.";
    const RELAXED_LINE: &str = "- Do not put issue or PR numbers, tickets, milestones, or external links in the description body — the ONLY issue references you may make are the final Closes:/Relates: lines defined in the \"Related issues\" section, chosen from its list. Any other reference is fabricated — leave it out.";

    fn candidate(number: u64, title: &str, state: &str) -> IssueCandidate {
        IssueCandidate {
            number,
            title: title.to_string(),
            state: state.to_string(),
        }
    }

    #[test]
    fn pr_recipe_no_candidates_keeps_ban_and_old_note() {
        // Byte-stability guard: with no candidates the ban stands, there's no
        // `## Related issues` section, and the note ends with the old tail.
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: "diff --git a/x.rs b/x.rs\n+a\n".to_string(),
            diff_truncated: false,
            files: vec![file("x.rs", 1, 0, false)],
            excluded_files: 0,
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "topic".to_string(),
            available_labels: vec![],
            candidate_issues: vec![],
            jira_candidates: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("github".to_string()),
        });
        assert!(recipe.system.contains(BAN_LINE));
        assert!(!recipe.system.contains(RELAXED_LINE));
        assert!(!recipe.system.contains("## Related issues"));
        assert!(!recipe.prompt.contains("## Related issues"));
        assert!(recipe
            .note
            .ends_with("with no code fences and no issue/PR references."));
        assert!(!recipe.note.contains("Closes:/Relates:"));
    }

    #[test]
    fn pr_recipe_with_candidates_swaps_ban_and_renders_section() {
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: "diff --git a/x.rs b/x.rs\n+a\n".to_string(),
            diff_truncated: false,
            files: vec![file("x.rs", 1, 0, false)],
            excluded_files: 0,
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "fix/123-crash".to_string(),
            available_labels: vec![],
            candidate_issues: vec![
                candidate(123, "Fix crash", "OPEN"),
                candidate(7, "", "CLOSED"),
                candidate(45, "Overlong title that should be capped ".repeat(10).trim(), "OPEN"),
            ],
            jira_candidates: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("github".to_string()),
        });
        // Ban swapped for the relaxed rule.
        assert!(recipe.system.contains(RELAXED_LINE));
        assert!(!recipe.system.contains(BAN_LINE));
        // Section present with the expected bullet forms.
        assert!(recipe.system.contains("## Related issues"));
        assert!(recipe.system.contains("- #123 — Fix crash"));
        // Empty-title closed issue → bare form with closed marker, no ` — `.
        assert!(recipe.system.contains("- #7 (closed)"));
        assert!(!recipe.system.contains("- #7 (closed) —"));
        // 140-char title cap (the rendered title portion is at most 140 chars).
        let long_bullet = recipe
            .system
            .lines()
            .find(|l| l.starts_with("- #45 "))
            .expect("issue 45 bullet");
        let rendered_title = long_bullet.trim_start_matches("- #45 — ");
        assert_eq!(rendered_title.chars().count(), 140);
        // Closing sentence and the swapped note tail.
        assert!(recipe
            .prompt
            .contains("if any of the listed related issues qualify, end with the `Closes:` / `Relates:` line(s)"));
        assert!(recipe.note.contains(
            "issue references may appear ONLY as the final Closes:/Relates: lines drawn from the Related issues section."
        ));
        assert!(!recipe.note.contains("no issue/PR references"));
    }

    #[test]
    fn pr_recipe_candidates_swap_uses_mr_on_gitlab() {
        // The ban/relaxed lines are constructed with the in-scope abbrev, so the
        // swap works cross-provider (GitLab → MR).
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: String::new(),
            diff_truncated: false,
            files: vec![],
            excluded_files: 0,
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "topic".to_string(),
            available_labels: vec![],
            candidate_issues: vec![candidate(9, "Thing", "OPEN")],
            jira_candidates: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("gitlab".to_string()),
        });
        // The GitLab ban line uses "issue or MR numbers"; after the swap the relaxed
        // MR-worded line is present and neither ban form remains.
        assert!(recipe
            .system
            .contains("the ONLY issue references you may make are the final Closes:/Relates: lines"));
        assert!(recipe.system.contains("issue or MR numbers, tickets, milestones, or external links in the description body"));
        assert!(!recipe
            .system
            .contains("NEVER reference issue or MR numbers"));
        assert!(recipe.system.contains("## Related issues"));
    }

    #[test]
    fn pr_recipe_candidates_capped_at_eight() {
        let candidate_issues: Vec<IssueCandidate> =
            (1..=9).map(|n| candidate(n, &format!("Issue {n}"), "OPEN")).collect();
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: String::new(),
            diff_truncated: false,
            files: vec![],
            excluded_files: 0,
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "topic".to_string(),
            available_labels: vec![],
            candidate_issues,
            jira_candidates: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("github".to_string()),
        });
        // Eight rendered, the ninth dropped by the defensive cap.
        for n in 1..=8 {
            assert!(recipe.system.contains(&format!("- #{n} — Issue {n}")));
        }
        assert!(!recipe.system.contains("- #9 — Issue 9"));
    }

    #[test]
    fn render_issue_line_forms() {
        assert_eq!(render_issue_line(123, "Fix crash", "OPEN"), "- #123 — Fix crash");
        assert_eq!(render_issue_line(7, "", "CLOSED"), "- #7 (closed)");
        assert_eq!(render_issue_line(7, "   ", "CLOSED"), "- #7 (closed)");
        assert_eq!(render_issue_line(8, "Done", "CLOSED"), "- #8 (closed) — Done");
        // Case-insensitive closed check.
        assert_eq!(render_issue_line(9, "x", "closed"), "- #9 (closed) — x");
        // 140-char title cap.
        let long: String = "a".repeat(200);
        let line = render_issue_line(1, &long, "OPEN");
        let title = line.trim_start_matches("- #1 — ");
        assert_eq!(title.chars().count(), 140);
    }

    // ---- Jira candidates (mention-only Related-issues variant) --------------

    fn jira_candidate(key: &str, summary: &str, status_category: &str) -> JiraCandidate {
        JiraCandidate {
            key: key.to_string(),
            summary: summary.to_string(),
            status_category: status_category.to_string(),
        }
    }

    /// The Bitbucket (abbrev "PR") relaxed-ban line for the Jira variant.
    const JIRA_RELAXED_LINE: &str = "- Do not put issue or PR numbers, tickets, milestones, or external links in the description body — the ONLY ticket references you may make are the final Relates: line defined in the \"Related issues\" section, chosen from its list. Any other reference is fabricated — leave it out.";

    #[test]
    fn extract_jira_keys_case_table() {
        // Underscore adjacency allowed; letter/digit prefix rejected.
        assert_eq!(extract_jira_keys("feature_MYT-5", "MYT"), vec!["MYT-5"]);
        // Case-insensitive key, canonical upper-case output.
        assert_eq!(extract_jira_keys("feat/myt-2-fix", "MYT"), vec!["MYT-2"]);
        // Letter prefix → no match.
        assert_eq!(extract_jira_keys("XMYT-1", "MYT"), Vec::<String>::new());
        // Trailing letter → no match.
        assert_eq!(extract_jira_keys("MYT-12a", "MYT"), Vec::<String>::new());
        // dot+digit → no match.
        assert_eq!(extract_jira_keys("MYT-1.2", "MYT"), Vec::<String>::new());
        // Sentence-ending period still matches.
        assert_eq!(extract_jira_keys("fixes MYT-1.", "MYT"), vec!["MYT-1"]);
        // Greedy digits (no MYT-1 from MYT-12).
        assert_eq!(extract_jira_keys("MYT-12", "MYT"), vec!["MYT-12"]);
        // Digit prefix rejected (`9MYT-1`).
        assert_eq!(extract_jira_keys("9MYT-1", "MYT"), Vec::<String>::new());
    }

    #[test]
    fn extract_jira_keys_dedupes_and_is_case_insensitive() {
        // `myt-2` and `MYT-2` dedupe to one canonical entry, first-occurrence order.
        assert_eq!(
            extract_jira_keys("myt-2 and MYT-2 and MYT-3", "MYT"),
            vec!["MYT-2", "MYT-3"]
        );
        // Lowercased project key argument still matches.
        assert_eq!(extract_jira_keys("MYT-9", "myt"), vec!["MYT-9"]);
    }

    #[test]
    fn extract_jira_keys_empty_inputs() {
        assert_eq!(extract_jira_keys("", "MYT"), Vec::<String>::new());
        assert_eq!(extract_jira_keys("MYT-1", ""), Vec::<String>::new());
    }

    #[test]
    fn render_jira_line_forms() {
        assert_eq!(render_jira_line("MYT-1", "Fix login", "new"), "- MYT-1 — Fix login");
        // Done marker (case-insensitive).
        assert_eq!(render_jira_line("MYT-2", "Ship it", "done"), "- MYT-2 (done) — Ship it");
        assert_eq!(render_jira_line("MYT-3", "x", "DONE"), "- MYT-3 (done) — x");
        // Bare key when the summary is empty (no dangling ` — `).
        assert_eq!(render_jira_line("MYT-4", "", "new"), "- MYT-4");
        assert_eq!(render_jira_line("MYT-5", "   ", "done"), "- MYT-5 (done)");
        // 140-char summary cap.
        let long: String = "a".repeat(200);
        let line = render_jira_line("MYT-6", &long, "new");
        let summary = line.trim_start_matches("- MYT-6 — ");
        assert_eq!(summary.chars().count(), 140);
    }

    #[test]
    fn pr_recipe_jira_candidates_render_relates_only_variant() {
        // Bitbucket repo, no native candidates, Jira candidates present → the
        // mention-only `Relates:` variant renders (no `Closes:` example).
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: "diff --git a/x.rs b/x.rs\n+a\n".to_string(),
            diff_truncated: false,
            files: vec![file("x.rs", 1, 0, false)],
            excluded_files: 0,
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "feature/MYT-123-fix".to_string(),
            available_labels: vec![],
            candidate_issues: vec![],
            jira_candidates: vec![
                jira_candidate("MYT-1", "Fix login", "new"),
                jira_candidate("MYT-2", "Ship it", "done"),
            ],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("bitbucket".to_string()),
        });
        // Relaxed Jira ban present; the native ban absent.
        assert!(recipe.system.contains(JIRA_RELAXED_LINE));
        assert!(!recipe.system.contains(BAN_LINE));
        // Section renders the Jira bullets (done marker on MYT-2).
        assert!(recipe.system.contains("## Related issues"));
        assert!(recipe.system.contains("- MYT-1 — Fix login"));
        assert!(recipe.system.contains("- MYT-2 (done) — Ship it"));
        // The `Relates:` example is present; NO `Closes:` example anywhere.
        assert!(recipe.system.contains("Relates: MYT-123, MYT-456"));
        assert!(!recipe.system.contains("Closes: 123"));
        assert!(recipe
            .system
            .contains("Never use a Closes line for these — Jira tickets are not closed"));
        // Closing sentence for the Relates-only variant.
        assert!(recipe
            .prompt
            .contains("if any of the listed related issues qualify, end with the `Relates:` line as instructed."));
        // Note tail swapped to the ticket-variant.
        assert!(recipe.note.contains(
            "with no code fences; ticket references may appear ONLY as the final Relates: line drawn from the Related issues section."
        ));
        assert!(!recipe.note.contains("no issue/PR references"));
    }

    #[test]
    fn pr_recipe_native_candidates_win_over_jira() {
        // Both lists constructed non-empty (impossible in production, guarded here):
        // native candidates win, no Jira section, Jira ban line absent.
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: "diff --git a/x.rs b/x.rs\n+a\n".to_string(),
            diff_truncated: false,
            files: vec![file("x.rs", 1, 0, false)],
            excluded_files: 0,
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "topic".to_string(),
            available_labels: vec![],
            candidate_issues: vec![candidate(123, "Native issue", "OPEN")],
            jira_candidates: vec![jira_candidate("MYT-1", "Jira issue", "new")],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("github".to_string()),
        });
        // Native relaxed line, native bullet; no Jira bullet or Relates-only copy.
        assert!(recipe.system.contains(RELAXED_LINE));
        assert!(recipe.system.contains("- #123 — Native issue"));
        assert!(!recipe.system.contains("- MYT-1"));
        assert!(!recipe.system.contains(JIRA_RELAXED_LINE));
        assert!(!recipe.system.contains("Jira tickets are not closed"));
        // Native Closes:/Relates: example is what renders.
        assert!(recipe.system.contains("Closes: 123, 456"));
    }

    #[test]
    fn pr_recipe_jira_candidates_capped_at_eight() {
        let jira_candidates: Vec<JiraCandidate> = (1..=9)
            .map(|n| jira_candidate(&format!("MYT-{n}"), &format!("Issue {n}"), "new"))
            .collect();
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: String::new(),
            diff_truncated: false,
            files: vec![],
            excluded_files: 0,
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "topic".to_string(),
            available_labels: vec![],
            candidate_issues: vec![],
            jira_candidates,
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("bitbucket".to_string()),
        });
        for n in 1..=8 {
            assert!(recipe.system.contains(&format!("- MYT-{n} — Issue {n}")));
        }
        assert!(!recipe.system.contains("- MYT-9 — Issue 9"));
    }

    // ---- extract_issue_numbers (mirror of extract.ts) ----------------------

    #[test]
    fn extract_issue_numbers_case_table() {
        assert_eq!(extract_issue_numbers("fix/123-crash"), vec![123]);
        assert_eq!(extract_issue_numbers("#45"), vec![45]);
        assert_eq!(extract_issue_numbers("123-fix"), vec![123]);
        assert_eq!(extract_issue_numbers("&#39;"), Vec::<u64>::new());
        assert_eq!(extract_issue_numbers("issue-7"), vec![7]);
        assert_eq!(extract_issue_numbers("gh-7"), vec![7]);
        assert_eq!(extract_issue_numbers("GH-7"), vec![7]);
        assert_eq!(extract_issue_numbers("v2-123"), Vec::<u64>::new());
        // `#` preceded by a letter/digit does not match.
        assert_eq!(extract_issue_numbers("abc#12"), Vec::<u64>::new());
        assert_eq!(extract_issue_numbers("9#12"), Vec::<u64>::new());
        // 0 and out-of-range dropped.
        assert_eq!(extract_issue_numbers("#0"), Vec::<u64>::new());
        assert_eq!(extract_issue_numbers("#1000000000"), Vec::<u64>::new());
        assert_eq!(extract_issue_numbers("#999999999"), vec![999_999_999]);
    }

    #[test]
    fn extract_issue_numbers_dedupes_first_occurrence_order() {
        // Same number twice → kept once (first occurrence).
        assert_eq!(extract_issue_numbers("#12 #12"), vec![12]);
        // Patterns applied in order 1→2→3 over the full text: pattern 1 (`#45`),
        // then pattern 2 (`123-`), then pattern 3 (`issue-7`).
        assert_eq!(
            extract_issue_numbers("fix/123-thing #45 issue-7"),
            vec![45, 123, 7]
        );
        // A number reachable by BOTH pattern 1 (`#5`) and pattern 2 (`5-` at string
        // start) is emitted once — during the pattern-1 pass, which runs first —
        // even though the pattern-2 hit appears earlier in the text.
        assert_eq!(extract_issue_numbers("5-x #5"), vec![5]);
    }

    // ---- budget_diff (mirror of truncate.ts budgetDiff) --------------------

    /// Build a `diff --git` file section for `path` with `body_len` bytes of body
    /// (a single long `+`-line), so tests can size sections precisely.
    fn section(path: &str, body_len: usize) -> String {
        let body = "x".repeat(body_len);
        format!("diff --git a/{path} b/{path}\n@@ -0,0 +1 @@\n+{body}\n")
    }

    #[test]
    fn budget_diff_passes_through_under_budget_byte_identical() {
        // A diff comfortably under DIFF_CHAR_BUDGET is returned unchanged and not
        // marked truncated (the two paths are byte-identical below the budget).
        let diff = format!("{}{}", section("a.rs", 100), section("b.rs", 100));
        assert!(diff.len() <= DIFF_CHAR_BUDGET);
        let out = budget_diff(&diff);
        assert_eq!(out.text, diff);
        assert!(!out.truncated);
    }

    #[test]
    fn budget_diff_drops_lockfile_section_above_budget() {
        // Over budget: the lockfile section is dropped first (LOW_VALUE_PATH),
        // the real code section survives. Sized so dropping the lockfile alone
        // brings the rest under budget (so the code file isn't itself capped).
        let lock = section("pnpm-lock.yaml", 70_000);
        let code = section("src/app.rs", 40_000);
        let diff = format!("{code}{lock}");
        assert!(diff.len() > DIFF_CHAR_BUDGET);
        let out = budget_diff(&diff);
        assert!(out.truncated);
        // Lockfile gone entirely; code file kept in full.
        assert!(!out.text.contains("pnpm-lock.yaml"));
        assert!(out.text.contains("diff --git a/src/app.rs b/src/app.rs"));
        // The 40KB code body survived un-capped (its section stayed under budget).
        assert!(out.text.contains(&"x".repeat(40_000)));
    }

    #[test]
    fn budget_diff_caps_oversized_file_section_at_per_file_cap() {
        // Two big non-lockfile sections push the total over budget even after the
        // (no-op) lockfile drop, so each oversized section is capped at PER_FILE_CAP
        // with the "[... rest of <path> truncated]" marker.
        let a = section("src/a.rs", 60_000);
        let b = section("src/b.rs", 60_000);
        let diff = format!("{a}{b}");
        assert!(diff.len() > DIFF_CHAR_BUDGET);
        let out = budget_diff(&diff);
        assert!(out.truncated);
        // Each surviving section carries the per-file cap marker...
        assert!(out.text.contains("[... rest of src/a.rs truncated]"));
        // ...and neither retains its full 60KB body (capped to ~PER_FILE_CAP).
        assert!(!out.text.contains(&"x".repeat(60_000)));
        // The kept body of the first section is bounded by the cap + marker, not
        // the original 60KB (a loose upper bound proving the cap fired).
        assert!(out.text.len() < 20_000);
    }

    #[test]
    fn is_low_value_path_matches_truncate_ts_set() {
        // Lockfiles (basename-anchored).
        for p in [
            "pnpm-lock.yaml",
            "sub/dir/Cargo.lock",
            "package-lock.json",
            "yarn.lock",
            "bun.lock",
            "bun.lockb",
            "composer.lock",
            "Gemfile.lock",
            "go.sum",
        ] {
            assert!(is_low_value_path(p), "expected low-value: {p}");
        }
        // Extension branches (suffix-anchored, anywhere in the path).
        for p in [
            "a/b.min.js",
            "x.min.css",
            "out/bundle.map",
            "t/__snap__.snap",
        ] {
            assert!(is_low_value_path(p), "expected low-value: {p}");
        }
        // Real code is NOT low-value (incl. a file merely NAMED like a lockfile part).
        for p in ["src/app.rs", "Cargo.toml", "lock.rs", "yarn.lockfile.md"] {
            assert!(!is_low_value_path(p), "expected NOT low-value: {p}");
        }
    }

    // ---- committed_base_ref (branch-name fallback base resolution) ----------

    async fn git(repo: &str, args: &[&str]) -> String {
        crate::git::runner::run_git_raw(Some(repo), args, crate::git::runner::DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// The scoped subjects log returns `base..HEAD` newest-first, and an empty list
    /// when HEAD adds nothing over the base (never an error).
    #[tokio::test]
    async fn branch_commit_subjects_are_newest_first() {
        let base_dir = tempfile::Builder::new()
            .prefix("gd-subjects-test-")
            .tempdir()
            .expect("create temp dir");
        let repo = base_dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        git(&repo_s, &["init", "-q"]).await;
        git(&repo_s, &["config", "user.email", "t@t.local"]).await;
        git(&repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(repo.join("a.txt"), "seed\n").unwrap();
        git(&repo_s, &["add", "-A"]).await;
        git(&repo_s, &["commit", "-qm", "seed"]).await;
        let base_sha = git(&repo_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        // Nothing on top of the base yet.
        assert!(
            branch_commit_subjects(&repo_s, &base_sha).await.is_empty(),
            "an empty range yields an empty list, not an error"
        );

        for (n, msg) in [("1", "feat: first"), ("2", "fix: second")] {
            std::fs::write(repo.join(format!("f{n}.txt")), "x\n").unwrap();
            git(&repo_s, &["add", "-A"]).await;
            git(&repo_s, &["commit", "-qm", msg]).await;
        }
        assert_eq!(
            branch_commit_subjects(&repo_s, &base_sha).await,
            vec!["fix: second".to_string(), "feat: first".to_string()],
            "git log order — newest first"
        );
    }

    /// Preference order: the remote-tracking `origin/<default>` wins when it exists,
    /// the local `<default>` is the fallback, and neither ⇒ `None` (no fallback base).
    #[tokio::test]
    async fn committed_base_ref_prefers_remote_tracking() {
        let base = tempfile::Builder::new()
            .prefix("gd-basref-test-")
            .tempdir()
            .expect("create temp dir");
        let repo = base.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        git(&repo_s, &["init", "-q"]).await;
        git(&repo_s, &["config", "user.email", "t@t.local"]).await;
        git(&repo_s, &["config", "user.name", "T"]).await;
        // Pin the branch name regardless of the host's init.defaultBranch.
        git(&repo_s, &["symbolic-ref", "HEAD", "refs/heads/main"]).await;
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        git(&repo_s, &["add", "-A"]).await;
        git(&repo_s, &["commit", "-qm", "seed"]).await;

        // Only the local branch exists → the local name.
        assert_eq!(
            committed_base_ref(&repo_s).await,
            Some("main".to_string()),
            "local default branch is the fallback base when there's no remote twin"
        );

        // Add the remote-tracking twin → it wins (the local one may be stale).
        git(&repo_s, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        assert_eq!(
            committed_base_ref(&repo_s).await,
            Some("origin/main".to_string()),
            "the remote-tracking ref is preferred over the local branch"
        );

        // Neither a main/master branch nor an origin ref → no base at all.
        git(&repo_s, &["branch", "-m", "main", "topic"]).await;
        git(&repo_s, &["update-ref", "-d", "refs/remotes/origin/main"]).await;
        assert_eq!(
            committed_base_ref(&repo_s).await,
            None,
            "no resolvable default branch ⇒ no committed-work fallback"
        );
    }
}
