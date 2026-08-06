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
//! This is a privacy boundary: a pattern that fails to match is a file that
//! reaches a third-party model.

use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;

use tempfile::TempPath;
use tokio::sync::OnceCell;

use crate::error::{AppError, AppResult};
use crate::git::diff::{parse_numstat_z, parse_numstat_z_rows};
use crate::git::runner::{run_git, run_git_raw, run_git_raw_input, DEFAULT_TIMEOUT};
use crate::git::types::DiffStatEntry;

/// The lines of an AI-ignore list the matcher acts on: trimmed, with blanks,
/// `#` comments and `!` un-ignore lines dropped. Returns them with the number of
/// `!` lines dropped.
///
/// `!` is dropped rather than honored because a diff is filtered by EXCLUSION —
/// a pathspec has no un-exclude — so an un-ignore git's matcher honored would
/// hide a file on the name pass and hand it to a model on the content pass. Of
/// the two uniform behaviors, refusing an un-ignore withholds more.
fn actionable_lines(patterns: &[String]) -> (Vec<&str>, usize) {
    let mut lines: Vec<&str> = Vec::new();
    let mut skipped_negations = 0usize;
    for raw in patterns {
        let line = crate::fsops::trim_ignore_pattern(raw);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('!') {
            skipped_negations += 1;
            continue;
        }
        lines.push(line);
    }
    (lines, skipped_negations)
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
/// temp excludes file, so semantics are gitignore's own — but only the lines
/// [`actionable_lines`] keeps, so a `!` un-ignore is dropped here even though
/// git would honor it natively (see that function).
///
/// `paths` are repo-relative, forward-slashed. Empty `paths`, or an `exclude`
/// with no actionable line in it, short-circuits to `[]` without spawning git;
/// so does "nothing matched" (check-ignore's exit code 1, which is not an
/// error).
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
    let (lines, _) = actionable_lines(exclude);
    if paths.is_empty() || lines.is_empty() {
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
/// the diff is withheld whole: over-hiding costs the model context, spawning
/// without the terms would hand it every ignored file.
const TERM_BUDGET: usize = 16_000;

/// A `git diff` filtered by the user's AI-ignore list. `text` is untruncated —
/// each caller applies its own budget and boundary rule.
pub struct FilteredDiff {
    pub text: String,
    pub files: Vec<DiffStatEntry>,
    /// Changed files (rename pairs count once) the patterns hid.
    pub excluded_files: u32,
}

/// Whether an AI-ignore list holds anything the matcher would act on — the flag
/// a caller needs to keep its unfiltered command shape when it does not.
pub fn has_actionable_lines(patterns: &[String]) -> bool {
    !actionable_lines(patterns).0.is_empty()
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
/// `repo_path` must be the repository ROOT: diff prints root-relative names
/// while pathspecs resolve against the cwd, so a subdirectory would void every
/// term. The positive pathspec alongside the excludes must likewise be exactly
/// `.`: git's `common_prefix_len()` skips exclude items, then advances each
/// negative pattern by the prefix it computed, so any directory component
/// silently voids them (measured, git 2.51.1).
///
/// `recheck` re-reads the names after the content pass and retries on a mismatch,
/// for callers whose diff reads mutable state (index, working tree) — a file
/// appearing between the passes would otherwise enter the diff unchecked.
/// Callers over immutable trees pin their refs instead and pass `false`.
pub async fn filtered_diff(
    repo_path: &str,
    content_args: &[&str],
    numstat_args: &[&str],
    exclude: &[String],
    recheck: bool,
) -> AppResult<FilteredDiff> {
    if !has_actionable_lines(exclude) {
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

        let total_rows = rows.len() as u32;
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
        // Over budget the survivors go too: they can only be shipped by a spawn
        // that would either fail outright or have to drop terms (see TERM_BUDGET).
        if args.iter().map(|a| a.len()).sum::<usize>() > TERM_BUDGET {
            return Ok(FilteredDiff {
                text: String::new(),
                files: Vec::new(),
                excluded_files: total_rows,
            });
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
fn sorted_names(rows: &[crate::git::diff::DiffStatRow]) -> Vec<String> {
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
    fn drops_blanks_comments_and_negations() {
        let patterns = [
            "  ".to_string(),
            "# a comment".to_string(),
            "!docs/notes.md".to_string(),
            "  *.log  ".to_string(),
            "/".to_string(),
        ];
        let (lines, skipped) = actionable_lines(&patterns);
        // A bare `/` survives this filter: git's own matcher decides what it
        // means, exactly as it does for every other surviving line.
        assert_eq!(lines, ["*.log", "/"]);
        assert_eq!(skipped, 1);
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
    const FIXTURE: [&str; 27] = [
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
        // An escaped metacharacter beside the sibling a wildcard would also
        // sweep, so an over-broad match has a witness.
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
    const PARITY: [(&[&str], &[&str]); 27] = [
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
        // `!` un-ignore lines are unsupported and dropped before git sees them: a
        // lone negation hides nothing, and a negation after a matching pattern
        // re-includes nothing. Git's matcher would honor the second case, but a
        // diff filtered by exclusion has no un-exclude to mirror it with.
        (&["!docs/notes.md"], &[]),
        (
            &["*.md", "!docs/notes.md"],
            &[
                "a/b/notes.md",
                "docs/notes.md",
                "docs/日本語.md",
                "notes.md",
            ],
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

    /// A `!` un-ignore line is unsupported: adding one changes NOTHING. Git's own
    /// matcher would re-include the negated path, and a diff filtered by
    /// exclusion has no un-exclude to mirror that with.
    #[tokio::test]
    async fn negation_lines_change_nothing_on_either_engine() {
        let (_dir, repo) = parity_repo().await;
        let all: Vec<String> = FIXTURE.iter().map(|p| p.to_string()).collect();
        let plain = vec!["*.md".to_string()];
        let negated = vec!["*.md".to_string(), "!docs/notes.md".to_string()];

        let (kept, skipped) = actionable_lines(&negated);
        assert_eq!(skipped, 1);
        assert_eq!(kept, actionable_lines(&plain).0);

        let (with_negation, _) = hidden_by_command(&repo, &["*.md", "!docs/notes.md"]).await;
        let (without, _) = hidden_by_command(&repo, &["*.md"]).await;
        assert_eq!(
            with_negation, without,
            "the `!` line did not re-include anything"
        );
        assert!(
            with_negation.contains("docs/notes.md"),
            "the negated path stays hidden"
        );

        let with = git_filter_ai_ignored(repo.clone(), all.clone(), negated)
            .await
            .unwrap();
        let without = git_filter_ai_ignored(repo.clone(), all, plain)
            .await
            .unwrap();
        assert_eq!(with, without);

        // An exclude list of nothing BUT droppable lines matches nothing at all,
        // and never spawns git.
        let only_droppable = git_filter_ai_ignored(
            repo,
            vec!["docs/notes.md".to_string()],
            vec!["!docs/notes.md".into(), "# c".into(), "  ".into()],
        )
        .await
        .unwrap();
        assert!(only_droppable.is_empty());
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

    /// Past `TERM_BUDGET` the diff is withheld WHOLE — survivors included —
    /// because the only alternatives are a spawn that fails outright on Windows
    /// or one with terms dropped, which ships the very files that matched.
    #[tokio::test]
    async fn a_term_list_over_budget_withholds_the_whole_diff() {
        let (_dir, repo) = seed_repo("budget").await;
        let blob = seed_blob(&repo).await;

        // 400 long ignored names: ~94 bytes of term each, far past the budget.
        let pad = "a".repeat(60);
        let mut inner = String::new();
        for i in 0..400 {
            inner.push_str(&format!("100644 blob {blob}\tf{i}_{pad}.env\n"));
        }
        let vendor = mktree_raw(&repo, inner.as_bytes());
        let top = format!(
            "040000 tree {vendor}\tvendor\n\
             100644 blob {blob}\ta.txt\n\
             100644 blob {blob}\tkeep.txt\n"
        );
        let (base, head) = commit_tree_pair(&repo, top.as_bytes()).await;

        // Fixture precondition: the two survivors really are in the range.
        let all = git_branch_diff(repo.clone(), base.clone(), head.clone(), None, None)
            .await
            .unwrap();
        assert_eq!(all.files.len(), 402);
        assert_eq!(all.excluded_files, 0);

        let filtered = git_branch_diff(repo, base, head, None, Some(vec!["vendor/".to_string()]))
            .await
            .unwrap();
        assert!(filtered.text.is_empty(), "{}", filtered.text);
        assert!(filtered.files.is_empty(), "{:?}", filtered.files);
        assert_eq!(
            filtered.excluded_files, 402,
            "the disclosure counts survivors too — they are withheld as well"
        );
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
