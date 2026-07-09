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
//! Remaining divergence from the TS path: `budgetDiff` returns the list of
//! omitted-file names and the TS marker enumerates them (`N file(s) omitted: …`); the
//! recipe markers here don't carry those names, so the marker copy omits that clause
//! and keeps only the "rely on the file summary above" guidance (noted at each marker
//! below). The raw diff is requested at the SAME 200_000-byte `RAW_DIFF_MAX_BYTES` the
//! TS call sites use (a git-layer `truncate_at_file_boundary` cap), then binary-stripped
//! and run through the `budget_diff` mirror — the truncation flag is set when EITHER
//! the git cap or budgeting truncated, matching the TS `budgeted.truncated || diffTruncated`.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{schemars, tool, tool_router, ErrorData as McpError};

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
Output ONLY the commit message itself: the first line is the subject (imperative mood, at most 72 characters), then a blank line, then an optional body explaining what changed and why.\n\
Never reference issue or PR numbers, tickets, or links (e.g. \"Closes #123\") — you can't see the issue tracker, so any such reference is fabricated.\n\
Do not wrap the message in markdown fences. Do not add commentary before or after the message.";

/// Mirrors `BRANCH_SYSTEM` in src/lib/ai/prompt.ts. KEEP IN SYNC.
const BRANCH_SYSTEM: &str = "You generate a single git branch name for a set of in-progress changes.\n\
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
                .replacen("GitHub pull request", &format!("{host} {}", copy.pr_noun), 1)
                .replacen("the PR title", &format!("the {} title", copy.pr_noun), 1)
                .replacen("no \"PR:\"", &format!("no \"{abbrev}:\""), 1)
                .replacen("human-written PR:", &format!("human-written {}:", copy.pr_noun), 1)
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
            "The subject line must be imperative mood and at most 72 characters, an optional body \
             follows after a blank line, and the output must contain no markdown fences or issue/PR \
             references.",
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

/// The gathered pieces a PR-description recipe is assembled from.
struct PrPieces {
    diff_text: String,
    diff_truncated: bool,
    files: Vec<DiffStatEntry>,
    commit_subjects: Vec<String>,
    base_branch: String,
    head_branch: String,
    available_labels: Vec<String>,
    repo_instructions: Option<String>,
    global_instructions: String,
    /// Frontend provider tag: `"github"` / `"gitlab"` / `"bitbucket"`, or None
    /// (GitHub wording, byte-for-byte).
    provider: Option<String>,
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

    let mut system_parts = vec![pr_system_for(p.provider.as_deref())];
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
    prompt_parts.push(format!(
        "## Files changed\n{}",
        if file_summary.is_empty() {
            "(none)"
        } else {
            &file_summary
        }
    ));

    let mut diff_section = format!("## Combined diff\n{}", budgeted.text);
    if budgeted.truncated || p.diff_truncated {
        diff_section.push_str(
            "\n[diff truncated — Rely on the commit list and file summary above for full coverage.]",
        );
    }
    prompt_parts.push(diff_section);

    // Label proposal — only when the repo actually has labels (mirrors the TS
    // `labels.length > 0` gate). Framed in the system prompt and reinforced by the
    // closing line. The parser drops invented labels, so an off-list label is
    // silently discarded rather than applied.
    let labels: Vec<&str> = p
        .available_labels
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if !labels.is_empty() {
        system_parts.push(format!(
            "## Labels\nThe repository has these labels: {}.\nAfter the description, if one or more of these labels fit this {pr_noun}, add a final line exactly like `Labels: name1, name2` listing ONLY labels from that list, copied verbatim. Choose only labels that genuinely apply — never invent a label that isn't in the list, and omit the line entirely when none apply.",
            labels.join(", ")
        ));
    }

    let mut closing = format!(
        "Write the {pr_noun} title and description. Lead with a summary of the goal, then group \
         related changes by theme under `###` headings when the diff touches several areas, citing \
         the files involved."
    );
    if !labels.is_empty() {
        closing.push_str(
            " Then, if any of the repository's labels apply, end with a single `Labels:` line as \
             instructed.",
        );
    }
    prompt_parts.push(closing);

    Recipe {
        system: system_parts.join("\n\n"),
        prompt: prompt_parts.join("\n\n"),
        note: recipe_note(
            &format!("{pr_noun} title and description"),
            &format!(
                "The first line is the {pr_noun} title (imperative, no trailing period), then a \
                 blank line, then the description in {}, with no code fences and no issue/{abbrev} \
                 references.",
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
        let settings = crate::app_store::read_ai_generation_settings();
        let repo_ignore = crate::instructions::read_repo_ai_ignore(self.repo.clone())
            .await
            .map_err(app_err)?;
        let exclude: Vec<String> = repo_ignore
            .into_iter()
            .chain(settings.ai_ignore_patterns.iter().cloned())
            .collect();

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

        let recipe = assemble_commit_recipe(CommitPieces {
            diff_text: staged.text,
            diff_truncated: staged.truncated,
            files: staged.files,
            excluded_files: staged.excluded_files,
            recent_subjects: commits.into_iter().map(|c| c.subject).collect(),
            repo_instructions,
            global_instructions: settings.global_instructions,
        });
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

        let diff = crate::git::compare::git_branch_diff(
            self.repo.clone(),
            base.clone(),
            head.clone(),
            Some(RAW_DIFF_MAX_BYTES),
        )
        .await
        .map_err(app_err)?;

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
        let available_labels = crate::forge::forge_repo_labels(self.repo.clone())
            .await
            .map(|labels| labels.into_iter().map(|l| l.name).collect::<Vec<_>>())
            .unwrap_or_default();

        let provider = provider_tag(&self.repo).await;
        let repo_instructions = crate::instructions::read_repo_instructions(self.repo.clone())
            .await
            .map_err(app_err)?;
        let settings = crate::app_store::read_ai_generation_settings();

        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: diff.text,
            diff_truncated: diff.truncated,
            files: diff.files,
            commit_subjects,
            base_branch: base,
            head_branch: head,
            available_labels,
            repo_instructions,
            global_instructions: settings.global_instructions,
            provider,
        });
        json_result(&to_value(&recipe)?)
    }

    #[tool(
        description = "Assemble GitDesktop's branch-name generation recipe from the WHOLE working \
                       tree (staged + unstaged vs HEAD, plus untracked file names): returns \
                       { system, prompt, note } — the same system + user prompt the in-app AI feature \
                       builds (worktree diff, file summary, existing branch names as a convention \
                       reference, and project/user instructions). This tool does NOT call a model; \
                       complete the returned prompt with your own inference and use the result as the \
                       branch name."
    )]
    async fn generate_branch_name(&self) -> Result<CallToolResult, McpError> {
        let settings = crate::app_store::read_ai_generation_settings();
        let repo_ignore = crate::instructions::read_repo_ai_ignore(self.repo.clone())
            .await
            .map_err(app_err)?;
        let exclude: Vec<String> = repo_ignore
            .into_iter()
            .chain(settings.ai_ignore_patterns.iter().cloned())
            .collect();

        // Whole-worktree diff vs HEAD (the TS uses git_staged_diff with worktree=true).
        let diff = crate::git::diff::git_staged_diff(
            self.repo.clone(),
            Some(RAW_DIFF_MAX_BYTES),
            Some(exclude),
            Some(true),
        )
        .await
        .map_err(app_err)?;

        // `git diff HEAD` omits untracked files; list their paths so a branch made
        // entirely of new files can still be named (mirrors the in-app call site).
        let untracked_paths = untracked_files(&self.repo).await.map_err(app_err)?;

        if diff.files.is_empty() && untracked_paths.is_empty() {
            let msg = if diff.excluded_files > 0 {
                "All in-progress changes match the AI ignore patterns — nothing to name a branch \
                 after."
            } else {
                "No in-progress changes to name a branch after — make some edits first."
            };
            return Err(McpError::invalid_request(msg, None));
        }

        let branches = crate::git::branches::git_branches(self.repo.clone())
            .await
            .map(|bs| bs.into_iter().map(|b| b.name).collect::<Vec<_>>())
            .unwrap_or_default();
        let repo_instructions = crate::instructions::read_repo_instructions(self.repo.clone())
            .await
            .map_err(app_err)?;

        let recipe = assemble_branch_recipe(BranchPieces {
            diff_text: diff.text,
            diff_truncated: diff.truncated,
            files: diff.files,
            untracked_paths,
            excluded_files: diff.excluded_files,
            recent_branches: branches,
            repo_instructions,
            global_instructions: settings.global_instructions,
        });
        json_result(&to_value(&recipe)?)
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
        assert!(recipe.system.contains("## Project instructions\nRepo rule."));
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
    }

    #[test]
    fn pr_recipe_github_is_pull_request_wording() {
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: "diff --git a/x.rs b/x.rs\n+a\n".to_string(),
            diff_truncated: false,
            files: vec![file("x.rs", 1, 0, false)],
            commit_subjects: vec!["feat: thing".to_string()],
            base_branch: "main".to_string(),
            head_branch: "feature/x".to_string(),
            available_labels: vec![],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("github".to_string()),
        });
        assert!(recipe.system.starts_with("You write GitHub pull request descriptions"));
        assert!(recipe
            .prompt
            .contains("This pull request merges `feature/x` into `main`."));
        assert!(recipe.prompt.contains("## Commits in this PR\n- feat: thing"));
        // No labels section when the repo has none.
        assert!(!recipe.system.contains("## Labels"));
    }

    #[test]
    fn pr_recipe_gitlab_swaps_noun_and_flavor() {
        let recipe = assemble_pr_recipe(PrPieces {
            diff_text: String::new(),
            diff_truncated: false,
            files: vec![],
            commit_subjects: vec![],
            base_branch: "main".to_string(),
            head_branch: "topic".to_string(),
            available_labels: vec!["bug".to_string(), "  ".to_string()],
            repo_instructions: None,
            global_instructions: String::new(),
            provider: Some("gitlab".to_string()),
        });
        assert!(recipe.system.contains("GitLab merge request"));
        assert!(recipe.system.contains("GitLab-flavored Markdown"));
        assert!(recipe.prompt.contains("This merge request merges `topic` into `main`."));
        // Labels present (blank entry filtered out).
        assert!(recipe.system.contains("## Labels"));
        assert!(recipe.system.contains("these labels: bug."));
        // Note restates MR wording.
        assert!(recipe.note.contains("merge request title"));
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
        for p in ["a/b.min.js", "x.min.css", "out/bundle.map", "t/__snap__.snap"] {
            assert!(is_low_value_path(p), "expected low-value: {p}");
        }
        // Real code is NOT low-value (incl. a file merely NAMED like a lockfile part).
        for p in ["src/app.rs", "Cargo.toml", "lock.rs", "yarn.lockfile.md"] {
            assert!(!is_low_value_path(p), "expected NOT low-value: {p}");
        }
    }
}
