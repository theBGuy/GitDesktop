//! The one AI-ignore matcher.
//!
//! The app documents its AI-ignore lists (`.gitdesktop/aiignore` + the global
//! settings list) as "gitignore-style", so matching has to BE gitignore: every
//! verdict comes from git's own engine via [`filter_ignored`]
//! (`check-ignore --no-index --stdin`) in a neutral repo, which matches
//! arbitrary path STRINGS and so needs nothing to exist in the index or the
//! working tree.
//!
//! Filtering a whole diff therefore runs in two passes ([`filtered_diff`]): name
//! the changed files with `--numstat -z`, ask this engine which of those names
//! are ignored, then re-run the content diff with one `:(exclude,literal)<name>`
//! term per hidden name. `git diff` has no `--pathspec-from-file`, so the
//! exclude direction is the only one available; a `,literal` term of a name git
//! itself printed is exact, which leaves no pattern translation to drift. The
//! two names that spelling cannot carry — one holding a `\`, or one that was not
//! valid UTF-8 — fall back to a deliberately wider glob
//! ([`widened_glob_for_name`]), which over-hides rather than leaks.
//!
//! `!` un-ignore lines are honored with git's own semantics, which makes list
//! ORDER significant (last match wins) and carries git's documented limitation
//! with it: a file cannot be re-included once one of its parent directories is
//! excluded. Callers concatenate repo-then-global so the user's own list wins.
//!
//! This is a privacy boundary: a pattern that fails to match is a file that
//! reaches a third-party model.

use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;

use tempfile::TempPath;
use tokio::sync::OnceCell;

use crate::error::{AppError, AppResult};
use crate::git::diff::{parse_numstat_z, parse_numstat_z_rows, DiffStatRow};
use crate::git::runner::{run_git, run_git_raw, run_git_raw_input, DEFAULT_TIMEOUT};
use crate::git::types::DiffStatEntry;

/// The lines of an AI-ignore list the matcher acts on — trimmed, with blanks and
/// `#` comments dropped — plus whether any of them is a POSITIVE (non-`!`) line.
///
/// Order is preserved and load-bearing: gitignore is last-match-wins, so a `!`
/// un-ignore only re-includes what an EARLIER line hid, and the caller's
/// concatenation order decides precedence.
///
/// The flag exists because a list of nothing but `!` lines can never hide
/// anything — a negation alone causes no ignoring — so callers short-circuit on
/// it rather than spawning git to be told nothing matched.
fn actionable_lines(patterns: &[String]) -> (Vec<&str>, bool) {
    let mut lines: Vec<&str> = Vec::new();
    let mut has_positive = false;
    for raw in patterns {
        let line = crate::fsops::trim_ignore_pattern(raw);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // An embedded newline would smuggle EXTRA pattern lines into the excludes
        // file past this per-line classification — the smuggled tail could be a
        // negation while the entry classifies by its first character as positive.
        if line.contains('\n') || line.contains('\r') {
            continue;
        }
        has_positive |= !line.starts_with('!');
        lines.push(line);
    }
    (lines, has_positive)
}

/// The repo's effective `core.ignorecase`. Unset (or unreadable) means `false`,
/// which is git's own default; `git init` sets it true on a case-insensitive
/// filesystem. Case folding must come from the USER'S repo, never from wherever
/// the neutral temp repo happens to live.
///
/// `--type=bool` is required, not tidiness: git accepts `1`, `yes`, `on` and a
/// valueless key as true, and the raw value is whatever the user wrote. Reading
/// it raw computes false for those, which then FORCES `-c core.ignorecase=false`
/// onto `check-ignore` — so a `Secrets.env` pattern stops hiding `secrets.env`
/// (measured, git 2.51.1).
async fn repo_ignorecase(repo_path: &str) -> bool {
    run_git_raw(
        Some(repo_path),
        &["config", "--type=bool", "--get", "core.ignorecase"],
        DEFAULT_TIMEOUT,
    )
    .await
    .map(|out| out.code == 0 && out.stdout_lossy().trim() == "true")
    .unwrap_or(false)
}

/// An empty throwaway repo, created once per process, that [`filter_ignored`]
/// runs `check-ignore` inside.
///
/// The AI-ignore patterns must be the ONLY rules in play: running in the user's
/// repo would add that repo's `.gitignore` files, which both over-reports (a
/// committed-but-gitignored lockfile declared AI-ignored, with no bypass in the
/// conflict UI) and reports paths no AI pattern named. An empty work tree leaves
/// `core.excludesFile` as the only active source. Reused across calls because
/// `is_ai_ignored` runs per conflicted file; only a successful init is cached
/// (`get_or_try_init` leaves the cell empty on error).
///
/// `TempDir` rather than a pid-derived name: in a shared `/tmp` a guessable path
/// lets a local attacker pre-create `.git/info/exclude` holding `!secrets.env`,
/// which outranks `core.excludesFile` and fails the conflict gate OPEN. TempDir
/// creates exclusively, with owner-only permissions; it lives in a static, so the
/// OS temp reaper rather than `Drop` eventually removes it.
static NEUTRAL_REPO: OnceCell<tempfile::TempDir> = OnceCell::const_new();

async fn neutral_repo() -> AppResult<PathBuf> {
    let dir = NEUTRAL_REPO
        .get_or_try_init(|| async {
            let dir = tempfile::Builder::new()
                .prefix("gd-aiignore-")
                .tempdir()
                .map_err(AppError::Io)?;
            let path = dir.path().to_string_lossy().into_owned();
            run_git(Some(&path), &["init", "-q"], DEFAULT_TIMEOUT).await?;
            // A user's `init.templateDir` can seed `.git/info/exclude`, which
            // outranks `core.excludesFile` and would join the ruleset.
            tokio::fs::write(dir.path().join(".git/info/exclude"), "")
                .await
                .map_err(AppError::Io)?;
            Ok::<tempfile::TempDir, AppError>(dir)
        })
        .await?;
    Ok(dir.path().to_path_buf())
}

/// The subset of `paths` that the AI-ignore `exclude` lines hide, evaluated by
/// git's own gitignore engine.
///
/// `check-ignore --no-index --stdin` matches *arbitrary* paths — they need not
/// exist in the working tree or the index — which is what lets callers ask about
/// a remote PR's changed-file list, or about one conflicted path without
/// depending on how the index happens to hold it. The pattern lines go into a
/// temp excludes file IN ORDER, so semantics are gitignore's own, `!` un-ignore
/// lines and their last-match-wins precedence included.
///
/// `paths` are repo-relative, forward-slashed. Empty `paths`, or an `exclude`
/// carrying no positive line (see [`actionable_lines`]), short-circuits to `[]`
/// without spawning git; so does "nothing matched" (check-ignore's exit code 1,
/// which is not an error).
///
/// Matching runs in [`neutral_repo`] rather than the user's repo, so their AI
/// patterns are the only rules in play — but `repo_path` still decides case
/// folding: `core.ignorecase` is read from it and forced onto the invocation, so
/// the answer follows the user's repo instead of whatever filesystem the temp
/// dir happens to sit on.
///
/// `-z` is load-bearing, not cosmetic: without it git C-dequotes an input path
/// that happens to be quoted and C-quotes non-ASCII output, either of which
/// returns a path that no longer compares equal to the one the caller sent — on
/// a privacy boundary that fails OPEN. It also makes a path containing a newline
/// representable at all.
///
/// The excludes file carries that boundary too, so it must be unguessable and
/// exclusively created: an emptied or substituted list reports NOTHING ignored.
/// It is created with `O_EXCL` inside [`neutral_repo`]'s owner-only directory and
/// written through that same handle, never re-opened by name — so no other user
/// can pre-create the path, and nothing can be swapped in between the write and
/// git's read. Removed explicitly below on both arms, with the handle's own drop
/// as a backstop.
pub async fn filter_ignored(
    repo_path: &str,
    paths: &[String],
    exclude: &[String],
) -> AppResult<Vec<String>> {
    let (lines, has_positive) = actionable_lines(exclude);
    if paths.is_empty() || !has_positive {
        return Ok(Vec::new());
    }
    let icase = repo_ignorecase(repo_path).await;
    let neutral = neutral_repo().await?.to_string_lossy().into_owned();

    let mut body = lines.join("\n");
    body.push('\n');
    // Created and written through one exclusive handle, inside the neutral repo's
    // own directory — see the security note on this function.
    let dir = neutral.clone();
    let excludes_file = tokio::task::spawn_blocking(move || -> std::io::Result<TempPath> {
        let mut file = tempfile::Builder::new()
            .prefix("excludes-")
            .suffix(".txt")
            .tempfile_in(dir)?;
        file.as_file_mut().write_all(body.as_bytes())?;
        Ok(file.into_temp_path())
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
    .map_err(AppError::Io)?;

    let result = async {
        // Forward slashes: a `-c` value is config-parsed, and a Windows temp path's
        // backslashes would be read as escapes. Git accepts `/` on every platform.
        let config = format!(
            "core.excludesFile={}",
            excludes_file.to_string_lossy().replace('\\', "/")
        );
        let mut stdin = paths.join("\0");
        stdin.push('\0');
        let case = format!("core.ignorecase={icase}");
        let out = run_git_raw_input(
            Some(&neutral),
            &[
                "-c",
                &config,
                "-c",
                &case,
                "check-ignore",
                "--no-index",
                "--stdin",
                "-z",
            ],
            Some(&stdin),
            DEFAULT_TIMEOUT,
        )
        .await?;
        // 0 = at least one path matched, 1 = none matched (not an error).
        if out.code > 1 {
            return Err(AppError::Git {
                code: out.code,
                stderr: out.stderr,
            });
        }
        // `-z` output is NUL-TERMINATED, so the split yields a trailing empty
        // element; nothing else needs trimming (no CR, no quoting).
        Ok(out
            .stdout_lossy()
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(String::from)
            .collect())
    }
    .await;

    let _ = tokio::fs::remove_file(&excludes_file).await;
    result
}

/// [`filter_ignored`] as a command: which of `paths` the user's AI-ignore
/// patterns hide. The frontend uses it for path lists it holds itself (a remote
/// PR's changed files), where there is no git command whose output we could
/// filter.
#[tauri::command]
pub async fn git_filter_ai_ignored(
    repo_path: String,
    paths: Vec<String>,
    exclude: Vec<String>,
) -> AppResult<Vec<String>> {
    filter_ignored(&repo_path, &paths, &exclude).await
}

/// U+FFFD — what a non-UTF-8 byte in a filename becomes on the way in.
const REPLACEMENT: char = '\u{FFFD}';

/// How many times [`filtered_diff`] re-runs its two passes when the tree moved
/// underneath them.
const MAX_ATTEMPTS: u32 = 3;

/// Byte ceiling on the content pass's whole argv. The exclude list grows with
/// the hidden-file count and Windows caps a command line at 32,767 UTF-16 units,
/// so a large enough change fails the spawn outright (os error 206). Past this
/// the call ERRORS: spawning without the terms would hand the model every
/// ignored file, and returning an empty diff is indistinguishable from
/// "everything was ignored" — advice the caller would repeat to the user while
/// survivors sat unshown.
const TERM_BUDGET: usize = 16_000;

/// A `git diff` filtered by the user's AI-ignore list. `text` is untruncated —
/// each caller applies its own budget and boundary rule.
pub struct FilteredDiff {
    pub text: String,
    pub files: Vec<DiffStatEntry>,
    /// Changed files (rename pairs count once) the patterns hid.
    pub excluded_files: u32,
}

/// Whether an AI-ignore list can hide anything — the flag a caller needs to keep
/// its unfiltered command shape when it cannot. A list of nothing but `!` lines
/// is inert (a negation causes no ignoring), so it takes the unfiltered path.
pub fn has_positive_pattern(patterns: &[String]) -> bool {
    actionable_lines(patterns).1
}

/// Whether a name is inexpressible as a `,literal` exclude term and needs
/// [`widened_glob_for_name`] instead — see that function for both causes.
fn needs_widened_term(name: &str) -> bool {
    name.contains(REPLACEMENT) || name.contains('\\')
}

/// An exclude term for a name `,literal` cannot express, deliberately WIDER than
/// the name itself. Two causes, both fail-OPEN without this:
///
/// A non-UTF-8 byte arrives only as U+FFFD, so a literal term would compare the
/// lossy string against the real bytes and match nothing; each RUN of U+FFFD
/// becomes one `*`, which cannot cross `/` because no lossy byte is one.
/// A literal `\` is normalized to a separator by Windows git even under
/// `,literal`, so that term matches nothing there while the content ships; `?`
/// in its place excludes the file on Windows and, since glob `?` matches a
/// literal `\` on Unix, spells the same term on both (measured, git 2.51.1).
///
/// Either way the term can sweep a sibling name — the safe direction — but never
/// misses the file it stands for.
fn widened_glob_for_name(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 8);
    let mut in_run = false;
    for c in path.chars() {
        if c == REPLACEMENT {
            if !in_run {
                out.push('*');
                in_run = true;
            }
            continue;
        }
        in_run = false;
        match c {
            '\\' => out.push('?'),
            // `[`, `*` and `?` are glob metacharacters; a one-character class is
            // the spelling that keeps them literal.
            '[' | '*' | '?' => {
                out.push('[');
                out.push(c);
                out.push(']');
            }
            _ => out.push(c),
        }
    }
    out
}

/// The `git diff` described by `content_args` with every AI-ignored file removed.
///
/// Two passes, because git's gitignore engine takes path STRINGS while `git diff`
/// takes pathspecs and has no `--pathspec-from-file`: name the changed files with
/// `numstat_args`, get verdicts from [`filter_ignored`], then re-run the content
/// diff excluding the concrete names it hid. A rename is hidden whole when either
/// side matches, and an unreadable name is hidden unconditionally.
///
/// Once there is anything to filter, every spawn runs at the working-tree
/// TOPLEVEL, resolved here rather than trusted from `repo_path`: below the
/// toplevel the exclude terms would match nothing and the positive `.` would
/// truncate the diff, so a subdirectory binding has to be resolved before any
/// pathspec is built. The positive pathspec must likewise be exactly `.`: git's
/// `common_prefix_len()` skips exclude items, then advances each negative pattern
/// by the prefix it computed, so any directory component silently voids them
/// (measured, git 2.51.1).
///
/// `recheck` re-reads the names after the content pass and retries on a mismatch,
/// for callers whose diff reads mutable state (index, working tree) — a file
/// appearing between the passes would otherwise enter the diff unchecked.
/// Callers over immutable trees pin their refs instead and pass `false`.
///
/// Errors when the exclude terms would exceed [`TERM_BUDGET`]: an empty result
/// there would read to every caller as "everything was ignored" while survivors
/// went unshown, so the failure is explicit rather than silent.
pub async fn filtered_diff(
    repo_path: &str,
    content_args: &[&str],
    numstat_args: &[&str],
    exclude: &[String],
    recheck: bool,
) -> AppResult<FilteredDiff> {
    // No toplevel resolution here: there are no exclude terms for a subdirectory
    // cwd to void, and `git diff` is cwd-independent anyway (measured, git 2.51.1:
    // `--cached --numstat` returns the same root-relative rows from a
    // subdirectory). So these spawns stay byte-identical to the unfiltered
    // command, and the common case pays nothing.
    if !has_positive_pattern(exclude) {
        let (content, stat) = tokio::try_join!(
            run_git(Some(repo_path), content_args, DEFAULT_TIMEOUT),
            run_git(Some(repo_path), numstat_args, DEFAULT_TIMEOUT)
        )?;
        return Ok(FilteredDiff {
            text: content.stdout_lossy(),
            files: parse_numstat_z(&stat.stdout_lossy()),
            excluded_files: 0,
        });
    }

    // Pin every spawn below to the working-tree toplevel. PATHSPEC elements
    // resolve against the cwd, so below the toplevel the exclude terms match
    // nothing and the positive `.` truncates the diff — shipping an excluded file
    // while reporting it hidden.
    let toplevel = crate::git::runner::worktree_toplevel(repo_path).await?;
    let repo_path = toplevel.as_str();

    for _ in 0..MAX_ATTEMPTS {
        let stat = run_git(Some(repo_path), numstat_args, DEFAULT_TIMEOUT).await?;
        let rows = parse_numstat_z_rows(&stat.stdout_lossy());
        let before = recheck.then(|| sorted_names(&rows));

        // Only names we can vouch for byte-for-byte are worth asking about.
        let readable: Vec<String> = rows
            .iter()
            .filter(|row| !row.names.iter().any(|n| n.contains(REPLACEMENT)))
            .flat_map(|row| row.names.iter().cloned())
            .collect();
        let ignored: HashSet<String> = filter_ignored(repo_path, &readable, exclude)
            .await?
            .into_iter()
            .collect();

        let mut terms: Vec<String> = Vec::new();
        let mut files: Vec<DiffStatEntry> = Vec::new();
        let mut excluded_files = 0u32;
        for row in rows {
            let hidden = row
                .names
                .iter()
                .any(|n| n.contains(REPLACEMENT) || ignored.contains(n));
            if !hidden {
                files.push(row.entry);
                continue;
            }
            excluded_files += 1;
            for name in row.names {
                terms.push(if needs_widened_term(&name) {
                    format!(":(exclude,glob){}", widened_glob_for_name(&name))
                } else {
                    format!(":(exclude,literal){name}")
                });
            }
        }

        // Nothing survives ⇒ no content pass at all: a `git diff` carrying no
        // pathspec is the FULL diff, which is the leak this branch exists to
        // prevent. Nothing was read, so nothing needs re-checking either.
        if files.is_empty() {
            return Ok(FilteredDiff {
                text: String::new(),
                files,
                excluded_files,
            });
        }

        let mut args: Vec<&str> = content_args.to_vec();
        args.extend(["--", "."]);
        args.extend(terms.iter().map(String::as_str));
        // Over budget this cannot be answered safely OR honestly — see TERM_BUDGET.
        if args.iter().map(|a| a.len()).sum::<usize>() > TERM_BUDGET {
            return Err(AppError::Command(
                "too many AI-ignored changed files to filter this diff safely \
                 — narrow the diff or the AI ignore patterns"
                    .into(),
            ));
        }
        let content = run_git(Some(repo_path), &args, DEFAULT_TIMEOUT).await?;

        if let Some(before) = before {
            let stat = run_git(Some(repo_path), numstat_args, DEFAULT_TIMEOUT).await?;
            if sorted_names(&parse_numstat_z_rows(&stat.stdout_lossy())) != before {
                continue;
            }
        }
        return Ok(FilteredDiff {
            text: content.stdout_lossy(),
            files,
            excluded_files,
        });
    }
    Err(AppError::Command(
        "the repository changed while computing the AI-filtered diff; try again".into(),
    ))
}

/// Every path a numstat pass named, both rename sides included, in a
/// comparable order.
fn sorted_names(rows: &[DiffStatRow]) -> Vec<String> {
    let mut names: Vec<String> = rows
        .iter()
        .flat_map(|row| row.names.iter().cloned())
        .collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::compare::git_branch_diff;
    use crate::git::diff::git_staged_diff;
    use crate::git::runner::{run_git, run_git_input};
    use std::collections::BTreeSet;
    use std::path::Path;

    #[test]
    fn keeps_negations_in_order_drops_blanks_and_comments() {
        let patterns = [
            "  ".to_string(),
            "# a comment".to_string(),
            "!docs/notes.md".to_string(),
            "  *.log  ".to_string(),
            "/".to_string(),
        ];
        let (lines, has_positive) = actionable_lines(&patterns);
        // Negations are KEPT, in place: order is what gives them meaning. A bare
        // `/` survives too — git's own matcher decides what it means, exactly as
        // it does for every other surviving line.
        assert_eq!(lines, ["!docs/notes.md", "*.log", "/"]);
        assert!(has_positive);

        // Nothing but negations (and droppables) can never hide anything.
        let inert = ["!a".to_string(), "  ".to_string(), "# c".to_string()];
        let (lines, has_positive) = actionable_lines(&inert);
        assert_eq!(lines, ["!a"]);
        assert!(!has_positive);
        assert!(!has_positive_pattern(&inert));

        // An embedded newline would reach the excludes file as TWO lines — the
        // second an effective negation — while classifying by its first
        // character as positive. `git_filter_ai_ignored` takes this list
        // straight from the renderer, so the entry is dropped whole.
        let smuggled = ["*.env\n!secrets.env".to_string()];
        let (lines, has_positive) = actionable_lines(&smuggled);
        assert!(lines.is_empty(), "{lines:?}");
        assert!(!has_positive);
        assert!(!has_positive_pattern(&smuggled));
        // A bare CR is dropped on the same grounds.
        assert!(actionable_lines(&["a\rb".to_string()]).0.is_empty());
        // …but a TRAILING newline is just line noise: it trims away and the
        // pattern still counts.
        let trailing = ["*.env\n".to_string()];
        assert_eq!(actionable_lines(&trailing).0, ["*.env"]);
        assert!(has_positive_pattern(&trailing));
    }

    /// The widened term keeps every glob metacharacter literal, collapses each
    /// RUN of unreadable bytes into a single `*`, and swaps a `\` for `?`.
    #[test]
    fn widened_glob_escapes_metacharacters_and_widens_the_inexpressible() {
        assert_eq!(
            widened_glob_for_name("we?rd\u{FFFD}\u{FFFD}[1].txt"),
            "we[?]rd*[[]1].txt"
        );
        assert_eq!(
            widened_glob_for_name("docs/caf\u{FFFD}.env"),
            "docs/caf*.env"
        );
        assert_eq!(widened_glob_for_name("a\\b.env"), "a?b.env");
        // All three causes at once.
        assert_eq!(
            widened_glob_for_name("a\\b\u{FFFD}\u{FFFD}c[1]*.env"),
            "a?b*c[[]1][*].env"
        );
        assert_eq!(widened_glob_for_name("st*ar.txt"), "st[*]ar.txt");
        // Nothing inexpressible, nothing special: unchanged.
        assert_eq!(widened_glob_for_name("src/a.rs"), "src/a.rs");

        // Only these two shapes route away from the exact `,literal` spelling.
        assert!(needs_widened_term("a\\b.env"));
        assert!(needs_widened_term("caf\u{FFFD}.env"));
        assert!(!needs_widened_term("weird[1].txt"));
        assert!(!needs_widened_term("notes "));
    }

    /// Every fixture path in the parity repo, repo-relative and sorted.
    const FIXTURE: [&str; 28] = [
        // A name starting with the negation marker, so an escaped `\!` pattern
        // has something real to hide. `!` is a legal filename character on every
        // platform we ship.
        "!important.txt",
        // A bracket expression's members (`a-d`/`abd`) plus `aXd`, which is not
        // one — so a class that quietly widened would be visible.
        "a-d",
        // `a/b.ts` beside `srcfoo.ts`/`src/foo.ts`: the pair of shapes that tell a
        // backslash ESCAPE apart from a Windows path separator (the `\/` and
        // `\f` rows below).
        "a/b.ts",
        "a/b/notes.md",
        // A digit member for the POSIX-class rows, and a name holding a literal
        // `[` so the unterminated-bracket rows have something they could wrongly
        // hide (git accepts `[` in a filename on every platform).
        "a5d",
        "aXd",
        "a[b",
        "abd",
        "app.log",
        // Negative controls: a `!` and a `^` mid-name, each beside an `X` twin.
        // Nothing in PARITY may hide these — they are what an over-broad match
        // (a stray wildcard, a mis-parsed class) would sweep up first.
        "bang!.txt",
        "bangX.txt",
        "build/x.txt",
        "buildfile.txt",
        "deep/app.log",
        "docs/a.log",
        "docs/build/y.txt",
        "docs/notes.md",
        "docs/sub/b.log",
        // CJK ideographs have no NFC/NFD variance, so this round-trips through a
        // real filesystem on every CI platform; the decomposable case (`café.md`)
        // is covered by the filesystem-free test below.
        "docs/日本語.md",
        "hatX.txt",
        "hat^.txt",
        "keep.txt",
        "node_modules/pkg/i.js",
        "notes.md",
        "src/foo.ts",
        "src/node_modules/j.js",
        "srcfoo.ts",
        "weird[1].txt",
    ];

    /// The measured truth table (git 2.51.1): for each AI-ignore pattern LIST,
    /// exactly which of `FIXTURE` it hides. The diff commands and
    /// `git_filter_ai_ignored` must both agree with it.
    const PARITY: [(&[&str], &[&str]); 34] = [
        (
            &["notes.md"],
            &["a/b/notes.md", "docs/notes.md", "notes.md"],
        ),
        (&["/notes.md"], &["notes.md"]),
        (
            &["*.log"],
            &["app.log", "deep/app.log", "docs/a.log", "docs/sub/b.log"],
        ),
        (
            &["*.md"],
            &[
                "a/b/notes.md",
                "docs/notes.md",
                "docs/日本語.md",
                "notes.md",
            ],
        ),
        (&["build/"], &["build/x.txt", "docs/build/y.txt"]),
        (&["build"], &["build/x.txt", "docs/build/y.txt"]),
        // Anchored directory, both spellings: the leading `/` pins it to the repo
        // root, so the nested `docs/build/` survives where the bare rows above
        // hide it. The trailing-slash form is what *Exclude folder from AI*
        // emits; the slashless twin pins the same anchoring for a typed line.
        (&["/build/"], &["build/x.txt"]),
        (&["/build"], &["build/x.txt"]),
        (
            &["node_modules"],
            &["node_modules/pkg/i.js", "src/node_modules/j.js"],
        ),
        (&["docs/notes.md"], &["docs/notes.md"]),
        (&["docs/*.log"], &["docs/a.log"]),
        (&["docs/build/"], &["docs/build/y.txt"]),
        // A bracket is a character class in gitignore, so this PATTERN never
        // matches the literal name — however concrete the name looks.
        (&["weird[1].txt"], &[]),
        // A LONE `!` line hides nothing: a negation only ever re-includes what an
        // earlier line hid, so it can never cause ignoring by itself.
        (&["!docs/notes.md"], &[]),
        // …but after a matching pattern it re-includes, with git's own
        // last-match-wins precedence.
        (
            &["*.md", "!docs/notes.md"],
            &["a/b/notes.md", "docs/日本語.md", "notes.md"],
        ),
        // Reversed, the negation is DEAD — the later positive line matches last.
        (
            &["!docs/notes.md", "*.md"],
            &[
                "a/b/notes.md",
                "docs/notes.md",
                "docs/日本語.md",
                "notes.md",
            ],
        ),
        // Git's documented limitation, pinned so it is never mistaken for a bug:
        // a file cannot be re-included once a parent DIRECTORY is excluded, so
        // this hides exactly what a bare `build/` hides.
        (
            &["build/", "!build/x.txt"],
            &["build/x.txt", "docs/build/y.txt"],
        ),
        // The repo-then-global concatenation in miniature: whichever list is
        // appended LAST decides, which is why callers put the user's global
        // patterns after the repo's committed file.
        (&["notes.md", "!notes.md"], &[]),
        (
            &["!notes.md", "notes.md"],
            &["a/b/notes.md", "docs/notes.md", "notes.md"],
        ),
        // Blanks and comments are dropped everywhere too.
        (&["  ", "# a comment", "docs/*.log"], &["docs/a.log"]),
        // Case: the fixture pins `core.ignorecase=false`, so a case-differing
        // pattern matches nothing. `case_folding_follows_the_repo` covers the
        // `true` half, which is the platform default on Windows/macOS.
        (&["NOTES.MD"], &[]),
        // A concrete path carrying glob metacharacters, escaped the way the UI's
        // *Exclude from AI* actions emit it: `[` wrapped as `[[]`. Unescaped it is
        // a character class and protects nothing — the `weird[1].txt` row above.
        (&["weird[[]1].txt"], &["weird[1].txt"]),
        (&["/weird[[]1].txt"], &["weird[1].txt"]),
        // The hand-typed gitignore spelling of the same escape, read natively by
        // git's matcher.
        (&["weird\\[1].txt"], &["weird[1].txt"]),
        // A backslash in a PATTERN is ALWAYS a gitignore escape, never a Windows
        // separator: `src\foo.ts` escapes the `f` and names the literal
        // `srcfoo.ts`, leaving `src/foo.ts` visible — uniformly on every platform,
        // since one matcher decides it.
        (&["src\\foo.ts"], &["srcfoo.ts"]),
        // An escaped separator is still a separator to the matcher, so it anchors
        // the line the same way a bare `/` would.
        (&["a\\/b.ts"], &["a/b.ts"]),
        // A bracket expression the USER wrote is git's own syntax, read as a range
        // here — so `a-d` is NOT a member, only `abd` is in this fixture.
        (&["a[b-c]d"], &["abd"]),
        // A backslash escape INSIDE a class: `\-` makes the `-` a member rather
        // than a range, so the class is {b,-,c} and `a-d` joins `abd`. `aXd` is
        // the control that must stay visible either way.
        (&["a[b\\-c]d"], &["a-d", "abd"]),
        // An escaped NON-ASCII character is simply that character to the matcher,
        // multi-byte encoding and all.
        (&["docs/\\日本語.md"], &["docs/日本語.md"]),
        // A POSIX class carries its own `]`, which does not terminate the
        // enclosing expression.
        (&["a[[:digit:]]d"], &["a5d"]),
        // An unterminated `[` makes git abandon the whole pattern, so these hide
        // nothing at all — including the `a[b` that is a real fixture name.
        (&["a["], &[]),
        (&["a[b"], &[]),
        // `\!` ESCAPES the marker: this is a POSITIVE pattern naming a file whose
        // name starts with `!`, and the bare form is a negation that hides
        // nothing. The pair pins the classification `has_positive` keys on — read
        // it as a negation and a list of only this line takes the unfiltered fast
        // path, shipping the whole diff.
        (&["\\!important.txt"], &["!important.txt"]),
        (&["!important.txt"], &[]),
    ];

    /// A `.gitignore` line the fixture repo carries but the AI-ignore lists never
    /// mention: nothing either engine reports may ever be traceable to it.
    const REPO_GITIGNORE_ONLY: &str = "keep.txt";

    /// Builds a repo whose index holds `FIXTURE` (added with `-f` so a user's
    /// global excludes can't drop `node_modules` from the fixture), plus a
    /// `.gitignore` covering `REPO_GITIGNORE_ONLY` so every assertion below also
    /// proves the repo's own ignore rules stay out of AI-ignore matching.
    async fn parity_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix("gd-aiignore-parity-")
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@t.local"],
            vec!["config", "user.name", "T"],
            // PINNED, not inherited: `git init` sets this true on Windows/macOS and
            // false on Linux, which would make every case-sensitive expectation in
            // PARITY platform-dependent.
            vec!["config", "core.ignorecase", "false"],
        ] {
            run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap();
        }
        for rel in FIXTURE {
            let path = Path::new(&repo).join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "x\n").unwrap();
        }
        std::fs::write(
            Path::new(&repo).join(".gitignore"),
            format!("{REPO_GITIGNORE_ONLY}\n"),
        )
        .unwrap();
        run_git(Some(&repo), &["add", "-A", "-f"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        (dir, repo)
    }

    /// What the real staged-diff command hides: `FIXTURE` minus the paths it
    /// still lists, plus the count it disclosed. `parity_repo` has no commits, so
    /// `git diff --cached` compares the index against the empty tree and every
    /// fixture file shows up as an addition. Sets are FIXTURE-relative because the
    /// index also holds a `.gitignore` no PARITY pattern names.
    ///
    /// The DIFF TEXT is checked against the file list here rather than in each
    /// caller: the file list comes from the name pass, so a term constructor that
    /// excluded nothing would leave every "hidden" file's content in `text` while
    /// every list-based assertion still passed. Paths come off the `+++ b/` lines
    /// (the runner forces `core.quotePath=false` and the fixture is ASCII).
    async fn hidden_by_command(repo: &str, patterns: &[&str]) -> (BTreeSet<String>, u32) {
        let owned: Vec<String> = patterns.iter().map(|p| p.to_string()).collect();
        let out = git_staged_diff(repo.to_string(), None, Some(owned), None)
            .await
            .unwrap();
        let listed: BTreeSet<&str> = out.files.iter().map(|f| f.path.as_str()).collect();
        let hidden: BTreeSet<String> = FIXTURE
            .iter()
            .filter(|p| !listed.contains(*p))
            .map(|p| p.to_string())
            .collect();

        let in_text: BTreeSet<String> = out
            .text
            .lines()
            .filter_map(|l| l.strip_prefix("+++ b/"))
            .map(str::to_string)
            .collect();
        let mut want_text: BTreeSet<String> = FIXTURE
            .iter()
            .filter(|p| !hidden.contains(**p))
            .map(|p| p.to_string())
            .collect();
        want_text.insert(".gitignore".to_string());
        assert_eq!(
            in_text, want_text,
            "diff text must carry exactly the surviving files, patterns {patterns:?}"
        );

        (hidden, out.excluded_files)
    }

    /// A trailing space survives into the match, which only a backslash escape
    /// can express: gitignore strips an unescaped one, so the pattern for a file
    /// named `notes ` would otherwise hide `notes` instead — the wrong file, and
    /// the named one left visible.
    ///
    /// Driven straight through `filter_ignored`, which takes arbitrary path
    /// STRINGS: git on Windows refuses to index a trailing-space path at all
    /// ("Invalid path"), so `parity_repo` cannot carry this fixture.
    #[tokio::test]
    async fn escaped_trailing_space_matches_only_that_file() {
        let (_dir, repo) = parity_repo().await;
        let paths = vec!["notes ".to_string(), "notes".to_string()];

        let escaped = git_filter_ai_ignored(repo.clone(), paths.clone(), vec!["notes\\ ".into()])
            .await
            .unwrap();
        assert_eq!(escaped, vec!["notes ".to_string()]);

        // Unescaped, git strips the space and the match lands on the other file.
        let bare = git_filter_ai_ignored(repo, paths, vec!["notes ".into()])
            .await
            .unwrap();
        assert_eq!(bare, vec!["notes".to_string()]);
    }

    /// A returned path is byte-identical to the one that went in, whatever
    /// characters it holds. The caller intersects this result with its own path
    /// list, so any rewriting silently drops the path from the ignored set and
    /// sends the file to a model. Needs no files on disk (`--no-index` matches
    /// path strings), which also keeps it clear of filesystem normalization.
    #[tokio::test]
    async fn returned_paths_are_byte_identical_to_the_input() {
        let (_dir, repo) = parity_repo().await;
        let paths = vec![
            "café.md".to_string(),
            "docs/日本語.md".to_string(),
            // Quotes as literal filename characters: git C-dequotes these without
            // `-z` and hands back the unquoted name.
            "\"quoted\".md".to_string(),
            "plain.md".to_string(),
            "keep.txt".to_string(),
        ];

        let hit = git_filter_ai_ignored(repo.clone(), paths.clone(), vec!["*.md".into()])
            .await
            .unwrap();
        assert_eq!(
            hit,
            vec![
                "café.md".to_string(),
                "docs/日本語.md".to_string(),
                "\"quoted\".md".to_string(),
                "plain.md".to_string(),
            ],
            "every matched path comes back exactly as sent"
        );
        for p in &hit {
            assert!(paths.contains(p), "`{p}` is not one of the input strings");
        }

        // The non-ASCII paths must be reachable by a pattern of their own, not
        // just swept up by `*.md`.
        let precise =
            git_filter_ai_ignored(repo, paths, vec!["café.md".into(), "docs/日本語.md".into()])
                .await
                .unwrap();
        assert_eq!(
            precise,
            vec!["café.md".to_string(), "docs/日本語.md".to_string()]
        );
    }

    /// `git_filter_ai_ignored` matches paths that exist nowhere in the repo (the
    /// remote-PR case), returns `[]` rather than erroring when nothing matches,
    /// and short-circuits on empty input.
    #[tokio::test]
    async fn filter_handles_absent_paths_and_empty_input() {
        let (_dir, repo) = parity_repo().await;
        let ghost = vec![
            "never/existed/secrets.env".to_string(),
            "never/existed/app.rs".to_string(),
        ];

        let hit = git_filter_ai_ignored(repo.clone(), ghost.clone(), vec!["*.env".into()])
            .await
            .unwrap();
        assert_eq!(hit, vec!["never/existed/secrets.env".to_string()]);

        let miss = git_filter_ai_ignored(repo.clone(), ghost.clone(), vec!["*.lock".into()])
            .await
            .unwrap();
        assert!(miss.is_empty(), "no match is Ok([]), not an error");

        assert!(
            git_filter_ai_ignored(repo.clone(), vec![], vec!["*.env".into()])
                .await
                .unwrap()
                .is_empty()
        );
        assert!(git_filter_ai_ignored(repo, ghost, vec![])
            .await
            .unwrap()
            .is_empty());
    }

    /// A fresh repo with an identity and pinned case sensitivity, for the
    /// commit-based fixtures below.
    async fn seed_repo(tag: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-aiignore-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@t.local"],
            vec!["config", "user.name", "T"],
            vec!["config", "core.ignorecase", "false"],
        ] {
            run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap();
        }
        (dir, repo)
    }

    /// An escaped-trailing-space file is hidden from a real branch diff on EVERY
    /// platform — the regression that matters, since it is Windows where a raw
    /// `\ ` term silently excluded nothing and handed `notes ` to a model.
    ///
    /// Built straight in the object database (`hash-object` → `mktree` →
    /// `commit-tree`): git on Windows refuses to index a trailing-space path at
    /// all ("Invalid path"), so no checkout can carry this fixture.
    #[tokio::test]
    async fn escaped_trailing_space_excluded_from_a_branch_diff_everywhere() {
        let (_dir, repo) = seed_repo("tree").await;

        let git_out = |args: Vec<String>, input: Option<String>| {
            let repo = repo.clone();
            async move {
                let argref: Vec<&str> = args.iter().map(String::as_str).collect();
                // NOT trimmed beyond the surrounding newline: a fixture name ends
                // in a space, and the assertions below compare names byte for byte.
                run_git_input(Some(&repo), &argref, input.as_deref(), DEFAULT_TIMEOUT)
                    .await
                    .unwrap()
                    .stdout_lossy()
            }
        };

        let blob = git_out(
            vec!["hash-object".into(), "-w".into(), "--stdin".into()],
            Some("x\n".into()),
        )
        .await
        .trim()
        .to_string();
        let files = ["notes ", "notes", "keep.txt"];
        let rows: String = files
            .iter()
            .map(|p| format!("100644 blob {blob}\t{p}\n"))
            .collect();
        let tree = git_out(vec!["mktree".into()], Some(rows))
            .await
            .trim()
            .to_string();
        let empty_tree = git_out(vec!["mktree".into()], Some(String::new()))
            .await
            .trim()
            .to_string();
        // The empty-tree commit is the merge base, so the three-dot diff below is
        // the whole tree.
        let base = git_out(
            vec![
                "commit-tree".into(),
                empty_tree,
                "-m".into(),
                "empty".into(),
            ],
            None,
        )
        .await
        .trim()
        .to_string();
        let head = git_out(
            vec![
                "commit-tree".into(),
                tree,
                "-p".into(),
                base.clone(),
                "-m".into(),
                "full".into(),
            ],
            None,
        )
        .await
        .trim()
        .to_string();

        // Exactly what *Exclude from AI* writes for a file named `notes `.
        let out = git_branch_diff(repo, base, head, None, Some(vec!["/notes\\ ".to_string()]))
            .await
            .unwrap();

        let listed: BTreeSet<&str> = out.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            listed,
            ["keep.txt", "notes"].into_iter().collect::<BTreeSet<_>>(),
            "only the trailing-space file is hidden"
        );
        assert_eq!(out.excluded_files, 1);
        // Compared as HEADER lines, not by substring: `diff --git a/notes b/notes`
        // itself contains the string "notes ".
        let headers: BTreeSet<&str> = out
            .text
            .lines()
            .filter(|l| l.starts_with("diff --git "))
            .collect();
        assert_eq!(
            headers,
            [
                "diff --git a/keep.txt b/keep.txt",
                "diff --git a/notes b/notes"
            ]
            .into_iter()
            .collect::<BTreeSet<_>>(),
            "diff text: {}",
            out.text
        );
    }

    /// The staged-diff command agrees with the measured table AND with
    /// `git_filter_ai_ignored`, for every pattern shape the UI can produce — the
    /// test that keeps the diff paths on real gitignore semantics.
    #[tokio::test]
    async fn staged_diff_matches_the_measured_table() {
        let (_dir, repo) = parity_repo().await;
        let all: Vec<String> = FIXTURE.iter().map(|p| p.to_string()).collect();

        for (patterns, expected) in PARITY {
            let want: BTreeSet<String> = expected.iter().map(|p| p.to_string()).collect();

            let (hidden, excluded) = hidden_by_command(&repo, patterns).await;
            assert_eq!(hidden, want, "staged diff, patterns {patterns:?}");
            assert_eq!(
                excluded as usize,
                want.len(),
                "disclosed count, patterns {patterns:?}"
            );

            let by_gitignore: BTreeSet<String> = git_filter_ai_ignored(
                repo.clone(),
                all.clone(),
                patterns.iter().map(|p| p.to_string()).collect(),
            )
            .await
            .unwrap()
            .into_iter()
            .collect();
            assert_eq!(
                by_gitignore, want,
                "gitignore engine, patterns {patterns:?}"
            );
        }
    }

    /// Case folding follows the USER'S REPO. Pathspec matching is case-SENSITIVE
    /// whatever `core.ignorecase` says, so every verdict has to come from the
    /// gitignore engine driven by the repo's own setting — `true` is the default
    /// on Windows and macOS, where a `NOTES.MD` pattern must hide `notes.md`.
    #[tokio::test]
    async fn case_folding_follows_the_repo() {
        let (_dir, repo) = parity_repo().await;
        let all: Vec<String> = FIXTURE.iter().map(|p| p.to_string()).collect();
        let pattern = vec!["NOTES.MD".to_string()];
        let want_folded: BTreeSet<String> = ["a/b/notes.md", "docs/notes.md", "notes.md"]
            .iter()
            .map(|p| p.to_string())
            .collect();

        // The fixture pins ignorecase=false: a case-differing pattern matches
        // nothing.
        let (hidden, excluded) = hidden_by_command(&repo, &["NOTES.MD"]).await;
        assert!(hidden.is_empty());
        assert_eq!(excluded, 0);
        assert!(
            git_filter_ai_ignored(repo.clone(), all.clone(), pattern.clone())
                .await
                .unwrap()
                .is_empty()
        );

        // Flip the REPO's setting; the command must follow it. Written as `1`,
        // NOT `true`: git accepts `1`/`yes`/`on`/a valueless key as true, so a raw
        // string compare would read this repo as case-SENSITIVE and force that on.
        run_git(
            Some(&repo),
            &["config", "core.ignorecase", "1"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        let (hidden, excluded) = hidden_by_command(&repo, &["NOTES.MD"]).await;
        assert_eq!(hidden, want_folded, "the staged diff folds case");
        assert_eq!(excluded as usize, want_folded.len());

        let by_gitignore: BTreeSet<String> = git_filter_ai_ignored(repo, all, pattern)
            .await
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(by_gitignore, want_folded, "gitignore engine folds case");
    }

    /// The repo's OWN `.gitignore` is not an AI-ignore list. Matching runs in an
    /// empty neutral repo, so `keep.txt` — gitignored by the fixture, named by no
    /// AI pattern — stays visible. Running check-ignore inside the user's repo
    /// instead reports it, silently over-withholding.
    #[tokio::test]
    async fn repo_gitignore_never_counts_as_an_ai_pattern() {
        let (_dir, repo) = parity_repo().await;
        // Sanity: git really does ignore it there, so the negative below has teeth.
        let native = run_git(
            Some(&repo),
            &["check-ignore", "--no-index", "--", REPO_GITIGNORE_ONLY],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(
            native.stdout_lossy().trim(),
            REPO_GITIGNORE_ONLY,
            "fixture precondition: the repo's .gitignore covers this path"
        );

        let ai_patterns = vec!["notes.md".to_string()];
        let by_gitignore = git_filter_ai_ignored(
            repo.clone(),
            vec![REPO_GITIGNORE_ONLY.to_string(), "notes.md".to_string()],
            ai_patterns,
        )
        .await
        .unwrap();
        assert_eq!(
            by_gitignore,
            vec!["notes.md".to_string()],
            "only the AI pattern matched — the repo's .gitignore did not leak in"
        );

        let (hidden, _) = hidden_by_command(&repo, &["notes.md"]).await;
        assert!(
            !hidden.contains(REPO_GITIGNORE_ONLY),
            "the staged diff agrees the gitignored path is not AI-ignored"
        );
    }

    /// A `!` un-ignore line really re-includes the file, all the way through the
    /// REAL command: the re-included path is back in the diff TEXT, not merely
    /// back in the file list. Every AI surface reads the same engine, so the one
    /// `git_filter_ai_ignored` assertion carries the conflict-gate and
    /// remote-PR paths with it.
    #[tokio::test]
    async fn a_negation_re_includes_the_file_end_to_end() {
        let (_dir, repo) = parity_repo().await;
        let all: Vec<String> = FIXTURE.iter().map(|p| p.to_string()).collect();

        let out = git_staged_diff(
            repo.clone(),
            None,
            Some(vec!["*.md".to_string(), "!docs/notes.md".to_string()]),
            None,
        )
        .await
        .unwrap();

        let listed: BTreeSet<&str> = out.files.iter().map(|f| f.path.as_str()).collect();
        assert!(
            listed.contains("docs/notes.md"),
            "the un-ignored file is back in the file list: {listed:?}"
        );
        assert!(
            out.text.contains("+++ b/docs/notes.md"),
            "…and back in the diff TEXT, which is what reaches the model"
        );
        for still_hidden in ["notes.md", "a/b/notes.md", "docs/日本語.md"] {
            assert!(
                !listed.contains(still_hidden),
                "{still_hidden} stays hidden"
            );
            assert!(
                !out.text.contains(&format!("+++ b/{still_hidden}")),
                "{still_hidden} stays out of the diff text"
            );
        }
        assert_eq!(out.excluded_files, 3, "the three unnegated `*.md` files");

        // The shared engine, so every other AI surface inherits the same verdict.
        let by_gitignore = git_filter_ai_ignored(
            repo,
            all,
            vec!["*.md".to_string(), "!docs/notes.md".to_string()],
        )
        .await
        .unwrap();
        assert!(!by_gitignore.contains(&"docs/notes.md".to_string()));
        assert!(by_gitignore.contains(&"notes.md".to_string()));
    }

    /// A list of nothing but `!` lines is inert — it cannot hide anything — so it
    /// takes the unfiltered fast path rather than spawning the two-pass flow.
    #[tokio::test]
    async fn only_negations_behaves_as_no_filter() {
        let (_dir, repo) = parity_repo().await;

        let unfiltered = git_staged_diff(repo.clone(), None, None, None)
            .await
            .unwrap();
        let negations_only = git_staged_diff(
            repo.clone(),
            None,
            Some(vec!["!notes.md".to_string(), "!docs/a.log".to_string()]),
            None,
        )
        .await
        .unwrap();

        assert_eq!(negations_only.files.len(), unfiltered.files.len());
        assert_eq!(negations_only.excluded_files, 0);
        assert_eq!(negations_only.text, unfiltered.text);

        // Same on the path-list engine: no positive line, nothing hidden.
        let only_droppable = git_filter_ai_ignored(
            repo,
            vec!["docs/notes.md".to_string()],
            vec!["!docs/notes.md".into(), "# c".into(), "  ".into()],
        )
        .await
        .unwrap();
        assert!(only_droppable.is_empty());
    }

    /// What a `\` in a NAME needs from a pattern, per platform — the two lines
    /// `aiExcludePatternLinesForPath` emits for such a path.
    ///
    /// The platforms disagree about what that byte IS while matching. Unix keeps
    /// it an ordinary byte, so the ESCAPED pattern matches it exactly. Windows
    /// normalizes the name's `\` to a separator before matching, so no backslash
    /// spelling can reach it and only the `/`-separated twin does. Path STRINGS,
    /// so no filesystem is involved and the fixture exists on both.
    ///
    /// The raw single-backslash pattern is asserted everywhere because it is the
    /// bug this pins: gitignore reads it as an escape, so it hides a DIFFERENT
    /// file and leaves the named one visible.
    #[tokio::test]
    async fn a_backslash_in_a_name_needs_the_platforms_own_spelling() {
        let (_dir, repo) = parity_repo().await;
        let paths = vec!["weird\\name.env".to_string(), "weirdname.env".to_string()];
        let hits = |pattern: &str| {
            let repo = repo.clone();
            let paths = paths.clone();
            let pattern = pattern.to_string();
            async move {
                git_filter_ai_ignored(repo, paths, vec![pattern])
                    .await
                    .unwrap()
            }
        };

        // The bug: `\n` is an escaped `n`, so this names `weirdname.env`.
        let raw = hits("/weird\\name.env").await;
        assert_eq!(
            raw,
            vec!["weirdname.env".to_string()],
            "a raw backslash escapes the next character on every platform"
        );

        let escaped = hits("/weird\\\\name.env").await;
        let separated = hits("/weird/name.env").await;
        if cfg!(windows) {
            assert_eq!(
                separated,
                vec!["weird\\name.env".to_string()],
                "the name's `\\` normalizes to a separator here"
            );
            assert!(
                !escaped.contains(&"weird\\name.env".to_string()),
                "…so no backslash spelling reaches it: {escaped:?}"
            );
        } else {
            assert_eq!(
                escaped,
                vec!["weird\\name.env".to_string()],
                "the `\\` is an ordinary byte here, matched exactly by the escape"
            );
            assert!(
                !separated.contains(&"weird\\name.env".to_string()),
                "…and the `/` twin names a nested path instead: {separated:?}"
            );
        }
    }

    /// A renamed file is hidden WHOLE when either side matches. Excluding only
    /// the new name leaves a `D <old name>` row, which names the very file the
    /// user withheld; excluding only the old name leaves the new content.
    #[tokio::test]
    async fn a_rename_is_hidden_when_either_side_matches() {
        let (_dir, repo) = seed_repo("rename").await;
        let root = Path::new(&repo);
        std::fs::write(root.join("secrets.env"), "TOKEN=abc123\nKEY=def456\n").unwrap();
        std::fs::write(root.join("keep.txt"), "keep\n").unwrap();
        for args in [
            vec!["add", "-A", "-f"],
            vec!["commit", "-qm", "first"],
            vec!["mv", "secrets.env", "renamed.txt"],
            vec!["commit", "-qam", "rename"],
        ] {
            run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap();
        }
        let first = run_git(Some(&repo), &["rev-parse", "HEAD~1"], DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
            .trim()
            .to_string();

        // Fixture precondition: git reports ONE rename row, not an add + delete.
        let all = git_branch_diff(repo.clone(), first.clone(), "HEAD".into(), None, None)
            .await
            .unwrap();
        assert_eq!(
            all.files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["renamed.txt"]
        );

        let filtered = git_branch_diff(
            repo,
            first,
            "HEAD".into(),
            None,
            Some(vec!["*.env".to_string()]),
        )
        .await
        .unwrap();
        assert!(filtered.files.is_empty(), "{:?}", filtered.files);
        assert_eq!(filtered.excluded_files, 1);
        assert!(!filtered.text.contains("secrets.env"), "{}", filtered.text);
        assert!(!filtered.text.contains("renamed.txt"), "{}", filtered.text);
    }

    /// `git mktree` fed RAW bytes, for a fixture whose name is not valid UTF-8 —
    /// the `run_git` helpers are `&str`-typed and cannot express one.
    fn mktree_raw(repo: &str, input: &[u8]) -> String {
        use std::io::Write as _;
        use std::process::{Command, Stdio};
        let mut child = Command::new("git")
            .arg("mktree")
            .current_dir(repo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn git mktree");
        child
            .stdin
            .take()
            .expect("stdin was piped")
            .write_all(input)
            .expect("write tree rows");
        let out = child.wait_with_output().expect("git mktree");
        assert!(
            out.status.success(),
            "git mktree failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Commits raw `mktree` rows as the child of an empty-tree commit, returning
    /// `(base, head)`. The empty commit is the merge base, so a three-dot diff
    /// over the pair is the whole tree — and nothing ever reaches the index,
    /// which is the only way these fixture names exist under Windows git.
    async fn commit_tree_pair(repo: &str, rows: &[u8]) -> (String, String) {
        let tree = mktree_raw(repo, rows);
        let empty_tree = mktree_raw(repo, b"");
        let base = run_git(
            Some(repo),
            &["commit-tree", &empty_tree, "-m", "empty"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy()
        .trim()
        .to_string();
        let head = run_git(
            Some(repo),
            &["commit-tree", &tree, "-p", &base, "-m", "full"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy()
        .trim()
        .to_string();
        (base, head)
    }

    /// A blob of `x\n`, for the object-DB fixtures.
    async fn seed_blob(repo: &str) -> String {
        run_git_input(
            Some(repo),
            &["hash-object", "-w", "--stdin"],
            Some("x\n"),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy()
        .trim()
        .to_string()
    }

    /// A name that is not valid UTF-8 reaches us only as a lossy string, so its
    /// check-ignore verdict cannot be trusted in the leak direction: the row is
    /// hidden unconditionally, through a widened glob rather than an exact term.
    #[tokio::test]
    async fn an_unreadable_name_is_hidden_unconditionally() {
        let (_dir, repo) = seed_repo("lossy").await;
        let blob = seed_blob(&repo).await;

        // A lone `0xE9` is not valid UTF-8, so this name comes back as
        // `caf\u{FFFD}.env` — a string no `,literal` term can match.
        let mut rows: Vec<u8> = format!("100644 blob {blob}\t").into_bytes();
        rows.extend_from_slice(b"caf\xE9.env\n");
        rows.extend_from_slice(format!("100644 blob {blob}\tkeep.txt\n").as_bytes());
        let (base, head) = commit_tree_pair(&repo, &rows).await;

        let filtered = git_branch_diff(
            repo.clone(),
            base.clone(),
            head.clone(),
            None,
            Some(vec!["*.env".to_string()]),
        )
        .await
        .unwrap();
        assert_eq!(
            filtered
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["keep.txt"]
        );
        assert_eq!(filtered.excluded_files, 1);
        assert!(!filtered.text.contains("caf"), "{}", filtered.text);

        // Control: unfiltered, the lossy row is present under its lossy name.
        let all = git_branch_diff(repo, base, head, None, None).await.unwrap();
        assert_eq!(
            all.files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["caf\u{FFFD}.env", "keep.txt"]
        );
    }

    /// A `repo_path` BELOW the toplevel still filters correctly, because the
    /// flow resolves the toplevel itself.
    ///
    /// Left at a subdirectory cwd, `--numstat` still prints root-relative names
    /// — so the verdicts and `excluded_files` look right — while the exclude
    /// terms resolve against that cwd and match nothing, and the positive `.`
    /// scopes the diff to the subdirectory. The excluded file's content would
    /// ship while reported hidden, and everything outside the subdirectory would
    /// vanish. The MCP server takes `--repo` verbatim, so this cwd is reachable.
    #[tokio::test]
    async fn a_subdirectory_repo_path_still_filters_from_the_toplevel() {
        let (_dir, repo) = seed_repo("subdir").await;
        let root = Path::new(&repo);
        std::fs::create_dir_all(root.join("services").join("api")).unwrap();
        std::fs::write(
            root.join("services").join("api").join(".env"),
            "TOKEN=SECRET_MARKER\n",
        )
        .unwrap();
        std::fs::write(
            root.join("services").join("api").join("app.js"),
            "// APP_MARKER\n",
        )
        .unwrap();
        std::fs::write(root.join("root.txt"), "ROOT_MARKER\n").unwrap();
        run_git(Some(&repo), &["add", "-A", "-f"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        let subdir = root
            .join("services")
            .join("api")
            .to_string_lossy()
            .into_owned();
        for (label, path) in [("subdirectory", &subdir), ("toplevel", &repo)] {
            let out = git_staged_diff(path.clone(), None, Some(vec!["*.env".to_string()]), None)
                .await
                .unwrap();

            assert_eq!(
                out.files
                    .iter()
                    .map(|f| f.path.as_str())
                    .collect::<Vec<_>>(),
                ["root.txt", "services/api/app.js"],
                "{label}: file list"
            );
            assert_eq!(out.excluded_files, 1, "{label}: disclosure");
            assert!(
                !out.text.contains("SECRET_MARKER"),
                "{label}: the excluded file's CONTENT must not ship"
            );
            assert!(
                out.text.contains("ROOT_MARKER"),
                "{label}: the diff must not be scoped to the subdirectory"
            );
            assert!(out.text.contains("APP_MARKER"), "{label}: survivor kept");
        }

        // …and with NO patterns at all: both paths cover the same tree. The
        // unfiltered path takes no toplevel resolution at all, so this passes
        // either way — `git diff` is cwd-independent. It is the uniformity
        // insurance, guarding the SCOPE property (a future `--relative`, or a
        // pathspec added to this path, would break it), not the resolution.
        for (label, path) in [("subdirectory", &subdir), ("toplevel", &repo)] {
            let out = git_staged_diff(path.clone(), None, None, None)
                .await
                .unwrap();
            assert_eq!(
                out.files
                    .iter()
                    .map(|f| f.path.as_str())
                    .collect::<Vec<_>>(),
                ["root.txt", "services/api/.env", "services/api/app.js"],
                "{label}: unfiltered scope"
            );
            assert_eq!(out.excluded_files, 0);
            assert!(
                out.text.contains("ROOT_MARKER"),
                "{label}: the whole tree, not just the subdirectory"
            );
        }
    }

    /// Every changed file hidden ⇒ no content pass runs at all. A `git diff`
    /// carrying no pathspec is the FULL diff, so this short-circuit is what stops
    /// an all-ignored change from coming back unfiltered.
    #[tokio::test]
    async fn everything_hidden_returns_an_empty_diff() {
        let (_dir, repo) = seed_repo("allhidden").await;
        let root = Path::new(&repo);
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("a.txt"), "a\n").unwrap();
        std::fs::write(root.join("b.rs"), "b\n").unwrap();
        std::fs::write(root.join("docs").join("c.md"), "c\n").unwrap();
        run_git(Some(&repo), &["add", "-A", "-f"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        let all = git_staged_diff(repo.clone(), None, None, None)
            .await
            .unwrap();
        assert_eq!(all.files.len(), 3);

        let hidden = git_staged_diff(repo, None, Some(vec!["*".to_string()]), None)
            .await
            .unwrap();
        assert!(hidden.text.is_empty(), "{}", hidden.text);
        assert!(hidden.files.is_empty());
        assert!(!hidden.truncated);
        assert_eq!(hidden.excluded_files, 3);
    }

    /// A `\` in a name is inexpressible as a `,literal` term: Windows git
    /// normalizes it to a separator even under literal magic, so the term
    /// excludes NOTHING while the file list still reports the file hidden — the
    /// content leaks. The widened `?` form excludes it on both platforms
    /// (measured, git 2.51.1.windows.1).
    ///
    /// Runs on EVERY platform deliberately: Windows is the one the leak exists on.
    #[tokio::test]
    async fn a_backslash_name_is_excluded_by_the_widened_term() {
        let (_dir, repo) = seed_repo("backslash").await;
        let blob = seed_blob(&repo).await;

        // Byte 0x5C is ordinary UTF-8, so unlike the lossy fixture this name
        // round-trips exactly — only its TERM encoding has to widen.
        let mut rows: Vec<u8> = format!("100644 blob {blob}\t").into_bytes();
        rows.extend_from_slice(b"weird\\name.env\n");
        rows.extend_from_slice(format!("100644 blob {blob}\tkeep.txt\n").as_bytes());
        let (base, head) = commit_tree_pair(&repo, &rows).await;

        let filtered = git_branch_diff(
            repo.clone(),
            base.clone(),
            head.clone(),
            None,
            Some(vec!["*.env".to_string()]),
        )
        .await
        .unwrap();
        assert_eq!(
            filtered
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["keep.txt"]
        );
        assert_eq!(filtered.excluded_files, 1);
        // "weird" rather than the whole name: `--name-only`-style diff headers
        // C-quote a backslash whatever `core.quotePath` says.
        assert!(!filtered.text.contains("weird"), "{}", filtered.text);

        // Control: unfiltered, the row is present under its raw name.
        let all = git_branch_diff(repo, base, head, None, None).await.unwrap();
        assert_eq!(
            all.files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["keep.txt", "weird\\name.env"]
        );
    }

    /// Past `TERM_BUDGET` the call ERRORS rather than returning an empty diff:
    /// empty is indistinguishable from "everything was ignored", which every
    /// generation surface repeats to the user as advice — while survivors sit
    /// unshown. The just-under case runs alongside it so the cliff cannot move
    /// silently in either direction.
    ///
    /// Sizes are argv bytes: each term is `:(exclude,literal)` (19) plus a
    /// ~73-char path, so ~94 each on top of ~100 bytes of fixed args.
    #[tokio::test]
    async fn a_term_list_over_budget_errors_instead_of_leaking_or_lying() {
        let (_dir, repo) = seed_repo("budget").await;
        let blob = seed_blob(&repo).await;
        let pad = "a".repeat(60);

        // Builds a tree of `count` long ignored names under `vendor/`, plus two
        // short survivors outside it.
        let tree_of = |count: usize| {
            let blob = blob.clone();
            let pad = pad.clone();
            let repo = repo.clone();
            async move {
                let mut inner = String::new();
                for i in 0..count {
                    inner.push_str(&format!("100644 blob {blob}\tf{i}_{pad}.env\n"));
                }
                let vendor = mktree_raw(&repo, inner.as_bytes());
                let top = format!(
                    "040000 tree {vendor}\tvendor\n\
                     100644 blob {blob}\ta.txt\n\
                     100644 blob {blob}\tkeep.txt\n"
                );
                commit_tree_pair(&repo, top.as_bytes()).await
            }
        };

        // ~400 × 94 ≈ 37,600 bytes of terms — far past the 16,000 budget.
        let (base, head) = tree_of(400).await;
        let all = git_branch_diff(repo.clone(), base.clone(), head.clone(), None, None)
            .await
            .unwrap();
        assert_eq!(all.files.len(), 402, "fixture precondition");

        let err = git_branch_diff(
            repo.clone(),
            base,
            head,
            None,
            Some(vec!["vendor/".to_string()]),
        )
        .await
        .expect_err("over budget must not return a diff at all");
        assert!(
            err.to_string()
                .contains("too many AI-ignored changed files"),
            "{err}"
        );

        // ~150 × 94 ≈ 14,100 bytes — just under, so the content pass runs and
        // the survivors come back filtered in the ordinary way.
        let (base, head) = tree_of(150).await;
        let filtered = git_branch_diff(repo, base, head, None, Some(vec!["vendor/".to_string()]))
            .await
            .expect("under budget filters normally");
        assert_eq!(
            filtered
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["a.txt", "keep.txt"]
        );
        assert_eq!(filtered.excluded_files, 150);
        assert!(!filtered.text.contains("vendor/"), "{}", filtered.text);
    }

    /// A multi-line rev expansion is a hard error on the pinned path, rather than
    /// an argument whose extra output line silently misaligns the two SHAs.
    /// Only the filtered path resolves refs, so the unfiltered one is untouched.
    #[tokio::test]
    async fn a_multi_line_rev_is_rejected_when_patterns_are_actionable() {
        let (_dir, repo) = seed_repo("revpin").await;
        let root = Path::new(&repo);
        std::fs::write(root.join("a.txt"), "a\n").unwrap();
        for args in [vec!["add", "-A"], vec!["commit", "-qm", "one"]] {
            run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap();
        }
        std::fs::write(root.join("b.txt"), "b\n").unwrap();
        for args in [vec!["add", "-A"], vec!["commit", "-qm", "two"]] {
            run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap();
        }

        let out = git_branch_diff(
            repo,
            "HEAD^!".into(),
            "HEAD".into(),
            None,
            Some(vec!["*.env".to_string()]),
        )
        .await;
        assert!(
            out.is_err(),
            "a two-line rev expansion must not resolve to a pinned range"
        );
    }
}
