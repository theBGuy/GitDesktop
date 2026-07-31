//! The one AI-ignore matcher.
//!
//! The app documents its AI-ignore lists (`.gitdesktop/aiignore` + the global
//! settings list) as "gitignore-style", so matching has to BE gitignore. This
//! module owns the two ways we evaluate those patterns, and a test pins them to
//! the same truth table so they cannot drift:
//!
//! * [`pathspecs_for`] — pure translation to `:(exclude,glob)` pathspec terms,
//!   for the call sites that filter a whole git command's output
//!   (`git_staged_diff`, `git_branch_diff`).
//! * [`filter_ignored`] / [`git_filter_ai_ignored`] — git's real gitignore
//!   engine (`check-ignore --no-index --stdin`), for deciding a list of paths
//!   that need not exist in the working tree or index (a remote PR's changed
//!   files, or one conflicted path).
//!
//! This is a privacy boundary: a pattern that fails to match is a file that
//! reaches a third-party model.

use std::io::Write;
use std::path::PathBuf;

use tempfile::TempPath;
use tokio::sync::OnceCell;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git, run_git_raw, run_git_raw_input, DEFAULT_TIMEOUT};

/// The pathspec translation of one AI-ignore list.
pub struct AiIgnorePathspecs {
    /// `:(exclude,glob)…` terms, ready to append after a caller's own positive
    /// pathspec. Empty when nothing translatable was supplied.
    pub specs: Vec<String>,
    /// How many `!` un-ignore lines were dropped — by BOTH engines, not just
    /// this one (see [`actionable_lines`]); callers may surface the count as
    /// "un-ignore lines aren't supported". No consumer discloses it yet, and the
    /// crate's staticlib/cdylib targets make `pub` no defence against dead_code.
    #[allow(dead_code)]
    pub skipped_negations: usize,
    /// How many pattern pieces this translation had to over-broaden — a
    /// class-special escape or a backslash-carrying bracket expression becoming
    /// `?`, or an unterminated `[` that a later emitted class closed (see
    /// [`rewrite_for_pathspec`]). Each one can over-exclude a sibling name, never
    /// leak the named one. Unconsumed so far, and `pub` is no defence against
    /// dead_code here.
    #[allow(dead_code)]
    pub widened: usize,
}

/// The lines of an AI-ignore list that either engine acts on: trimmed, with
/// blanks, `#` comments and `!` un-ignore lines dropped. Returns them with the
/// number of `!` lines dropped.
///
/// One definition, deliberately shared: both engines must decide every list
/// identically, and `!` can only be made uniform by dropping it — a pathspec has
/// no un-exclude, so honoring negations on the gitignore side alone would hide a
/// file on one generation path and hand it to a model on another. Of the two
/// uniform behaviors, refusing an un-ignore withholds more.
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

/// Rewrites one gitignore pattern into the spelling the pathspec engine reads the
/// same way, returning the count that had to be widened.
///
/// On WINDOWS a backslash inside a pathspec argv element is normalized to `/`
/// before matching, so an escape that gitignore honors excludes NOTHING there —
/// on this privacy boundary that fails open (measured, git 2.51.1.windows.1:
/// `:(glob)sub\b.ts` matches `sub/b.ts`, `:(glob)sub/b\.ts` matches nothing).
/// Unix honors the escape, so the raw form worked there and only there; the
/// re-encode is what makes both platforms and both engines answer alike. A
/// one-character bracket class is exact on both engines, so `\<c>` becomes
/// `[<c>]`.
///
/// Three escapes route around that class. `/` becomes a bare `/`: no bracket
/// class matches a separator under `,glob`, while gitignore's `\/` does, so the
/// class form would open the same hole it closes. A NON-ASCII character also goes
/// bare — a class matches byte-wise, so `[日]` asks for one stray byte of a
/// three-byte character and matches nothing, while bare is exact because no
/// non-ASCII character is a glob metacharacter. The five class-special escapes
/// (`]`, `^`, `!`, `-`, `\`) and a dangling backslash have their own meaning
/// inside a class, so they degrade to `?`, a single-char wildcard that can only
/// over-exclude.
///
/// A bracket EXPRESSION the user wrote is git's own syntax, not ours to
/// translate: it is copied whole, or — when it carries a backslash anywhere
/// inside — replaced whole by a single `?`. Rewriting one member in place would
/// silently change the class's membership (`a[b\-c]d` would become the class
/// `{b,?,c}` and stop matching `a-d`, which gitignore hides). `?` is a strict
/// superset of any bracket, since neither matches `/`, so the swap stays
/// fail-closed. [`AiIgnorePathspecs::widened`] counts both `?` routes.
///
/// A backslash here is ALWAYS a gitignore escape and never a Windows path
/// separator — the lists are documented as .gitignore syntax. So a
/// Windows-path-shaped rule matches nothing it looks like it should: `src\foo.ts`
/// names the literal `srcfoo.ts`, uniformly on both engines.
///
/// Beside the widened brackets, one shape diverges in the same safe direction: a
/// line ending `\/` leaves a real trailing `/` here, so [`pathspecs_for`] files it
/// as a directory and hides its contents, while gitignore strips that slash and
/// aborts on the dangling `foo\` residue, matching NOTHING (measured, git 2.51.1:
/// excludes line `foo\/` hides neither `foo/x.txt` nor `foo`, where `foo/` hides
/// `foo/x.txt`). Uncounted, and unreachable from the menus, which never emit a
/// trailing `\/`.
fn rewrite_for_pathspec(pattern: &str) -> (String, usize) {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len());
    let mut widened = 0usize;
    let mut i = 0usize;
    // An unterminated `[` copied into `out` and not yet closed — see the arm below.
    let mut dangling_open = false;
    while i < chars.len() {
        if chars[i] == '[' {
            match bracket_end(&chars, i) {
                Some(end) => {
                    let expr: String = chars[i..=end].iter().collect();
                    if expr.contains('\\') {
                        out.push('?');
                        widened += 1;
                    } else {
                        out.push_str(&expr);
                    }
                    i = end + 1;
                }
                // Unterminated. Gitignore abandons the whole pattern, matching
                // NOTHING, and a copied `[` matches nothing too — UNLESS a later
                // escape emits a class whose `]` closes it, which the arm below
                // counts as the over-exclusion it is (measured, git 2.51.1:
                // gitignore `a[b\xc` hides nothing, our `**/a[b[x]c` hides
                // `abc`/`a[c`/`axc`).
                None => {
                    out.push('[');
                    dangling_open = true;
                    i += 1;
                }
            }
            continue;
        }
        if chars[i] != '\\' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        match chars.get(i + 1).copied() {
            Some('/') => out.push('/'),
            // A bracket class matches BYTE-wise, so `[日]` would ask for one
            // stray byte of a 3-byte character and match nothing. Bare is exact
            // instead: a non-ASCII char is never a glob metacharacter.
            Some(e) if !e.is_ascii() => out.push(e),
            Some(e) if !matches!(e, ']' | '^' | '!' | '-' | '\\') => {
                out.push('[');
                out.push(e);
                out.push(']');
                // This `]` is the first one in `out`, so it closes the dangling
                // `[` rather than this class — turning the run into a real class
                // where gitignore matched nothing at all.
                if dangling_open {
                    widened += 1;
                    dangling_open = false;
                }
            }
            _ => {
                out.push('?');
                widened += 1;
            }
        }
        i += if i + 1 < chars.len() { 2 } else { 1 };
    }
    (out, widened)
}

/// Index of the `]` closing the bracket expression opening at `open`, or `None`
/// when it is unterminated.
///
/// Follows wildmatch's own parse, which four details make non-obvious: a leading
/// `!` or `^` negates; a `]` in first position is a member rather than the
/// terminator; a backslash escapes the next character; and a POSIX class
/// `[:name:]` is consumed whole, so the `]` ending it is not the terminator
/// either. Miss any of them and the scan stops at a false terminator, splitting
/// the class — which then has a member rewritten in place and silently changes
/// what it accepts.
///
/// `[:name:]` alone: git's wildmatch has no `[=x=]` equivalence or `[.x.]`
/// collating form (measured, git 2.51.1 — both match nothing rather than acting
/// as a class), so treating their brackets as ordinary characters is what agrees
/// with it.
fn bracket_end(chars: &[char], open: usize) -> Option<usize> {
    let mut i = open + 1;
    if matches!(chars.get(i).copied(), Some('!' | '^')) {
        i += 1;
    }
    if matches!(chars.get(i).copied(), Some(']')) {
        i += 1;
    }
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 2,
            '[' if matches!(chars.get(i + 1).copied(), Some(':')) => {
                match posix_class_end(chars, i) {
                    Some(end) => i = end + 1,
                    None => i += 1,
                }
            }
            ']' => return Some(i),
            _ => i += 1,
        }
    }
    None
}

/// Index of the `]` ending the POSIX class `[:name:]` opening at `open`, or
/// `None` when no `:]` follows (then the `[` is an ordinary member).
fn posix_class_end(chars: &[char], open: usize) -> Option<usize> {
    let mut i = open + 2;
    while i + 1 < chars.len() {
        if chars[i] == ':' && chars[i + 1] == ']' {
            return Some(i + 1);
        }
        i += 1;
    }
    None
}

/// Translates gitignore-style lines into `:(exclude,glob)` pathspec terms.
///
/// Pure — no git call, no IO. Blanks, comments and `!` lines are dropped by the
/// shared [`actionable_lines`]. Per surviving line: backslash escapes are
/// re-encoded by [`rewrite_for_pathspec`] first (the pathspec engine cannot read
/// them), then a trailing `/` marks a directory, and a line is *anchored* when it
/// starts with `/` or still contains a `/` (exactly gitignore's rule). Unanchored
/// lines get a `**/` prefix so they match at any depth; a non-directory line also
/// emits a `<pattern>/**` term, which is what makes a bare `node_modules` hide
/// the directory's contents and matches nothing extra for a real file.
///
/// Every term carries `,glob` magic, and that is load-bearing twice over: it
/// makes a leading `**/` match at depth zero (so a bare name hits the repo root
/// too), and it stops `*` from crossing `/` (so `docs/*.log` does not
/// over-match `docs/sub/b.log`). Never `,literal` — gitignore reads `[1]` as a
/// character class, so we must too.
///
/// `icase` comes from the repo's `core.ignorecase` (see [`repo_ignorecase`]) and
/// adds `,icase`. It is required for parity, not a nicety: pathspec matching is
/// case-SENSITIVE whatever `core.ignorecase` says, while real gitignore folds
/// case when it is set — so on the case-insensitive filesystems Windows and
/// macOS default to, a `Secrets.env` pattern would hide `secrets.env` from the
/// gitignore engine and leak it through every pathspec caller (measured, git
/// 2.51.1).
///
/// ⚠ The caller's own positive pathspec must NOT carry a directory component —
/// `.` is the shape that works. Git's `common_prefix_len()` skips exclude items
/// when computing the leading prefix it strips, then `match_pathspec_item()`
/// advances each *negative* pattern by that many bytes: with a positive
/// pathspec of `docs/file.txt`, `**/file.txt` is compared as `ile.txt` and
/// silently matches nothing (measured, git 2.51.1). Ask about a single path via
/// [`filter_ignored`] instead.
pub fn pathspecs_for(patterns: &[String], icase: bool) -> AiIgnorePathspecs {
    let (lines, skipped_negations) = actionable_lines(patterns);
    let magic = if icase {
        "exclude,glob,icase"
    } else {
        "exclude,glob"
    };
    let mut specs: Vec<String> = Vec::new();
    let mut widened = 0usize;

    for line in lines {
        // Escapes are re-encoded BEFORE anything classifies the line: `anchored`
        // reads `/`, and Windows git reads a surviving backslash as one — so a
        // raw `a\b.ts` would be filed unanchored and then matched as `a/b.ts`.
        let (line, w) = rewrite_for_pathspec(line);
        widened += w;
        let is_dir = line.ends_with('/');
        let core = line.strip_suffix('/').unwrap_or(line.as_str());
        let anchored = core.starts_with('/') || core.contains('/');
        let core = core.strip_prefix('/').unwrap_or(core);
        if core.is_empty() {
            continue;
        }
        let prefix = if anchored { "" } else { "**/" };
        if !is_dir {
            specs.push(format!(":({magic}){prefix}{core}"));
        }
        specs.push(format!(":({magic}){prefix}{core}/**"));
    }

    AiIgnorePathspecs {
        specs,
        skipped_negations,
        widened,
    }
}

/// The repo's effective `core.ignorecase`. Unset (or unreadable) means `false`,
/// which is git's own default; `git init` sets it true on a case-insensitive
/// filesystem. Both engines must be driven from THIS one value so they fold case
/// alike — and from the user's repo, never from wherever a temp dir happens to
/// live.
///
/// `--type=bool` is required, not tidiness: git accepts `1`, `yes`, `on` and a
/// valueless key as true, and the raw value is whatever the user wrote. Reading
/// it raw computes false for those, which then FORCES `-c core.ignorecase=false`
/// onto `check-ignore` — so a `Secrets.env` pattern stops hiding `secrets.env` on
/// both engines at once (measured, git 2.51.1).
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

/// [`pathspecs_for`] with the repo's own case sensitivity applied — what the
/// diff call sites should use, so they never have to know about `core.ignorecase`.
pub async fn pathspecs_for_repo(repo_path: &str, patterns: &[String]) -> AiIgnorePathspecs {
    // Only worth a spawn when there is something to translate.
    if actionable_lines(patterns).0.is_empty() {
        return pathspecs_for(patterns, false);
    }
    pathspecs_for(patterns, repo_ignorecase(repo_path).await)
}

/// An empty throwaway repo, created once per process, that [`filter_ignored`]
/// runs `check-ignore` inside.
///
/// The AI-ignore patterns must be the ONLY rules in play: running in the user's
/// repo would add that repo's `.gitignore` files, which both over-reports (a
/// committed-but-gitignored lockfile declared AI-ignored, with no bypass in the
/// conflict UI) and breaks the invariant that this engine and `pathspecs_for`
/// decide alike. An empty work tree leaves `core.excludesFile` as the only
/// active source. Reused across calls because `is_ai_ignored` runs per
/// conflicted file; only a successful init is cached (`get_or_try_init` leaves
/// the cell empty on error).
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
/// temp excludes file, so semantics are gitignore's own rather than our pathspec
/// translation of them — but only the lines [`actionable_lines`] keeps, so a `!`
/// un-ignore is dropped here exactly as it is on the pathspec side. Git would
/// honor it natively; letting it would split the two engines on the same list.
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
/// dir happens to sit on, and agrees with [`pathspecs_for`].
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
/// filter with pathspecs.
#[tauri::command]
pub async fn git_filter_ai_ignored(
    repo_path: String,
    paths: Vec<String>,
    exclude: Vec<String>,
) -> AppResult<Vec<String>> {
    filter_ignored(&repo_path, &paths, &exclude).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::runner::{run_git, run_git_input};
    use std::collections::BTreeSet;
    use std::path::Path;

    fn specs_icase(pattern: &str) -> Vec<String> {
        pathspecs_for(&[pattern.to_string()], true).specs
    }

    fn specs(pattern: &str) -> Vec<String> {
        pathspecs_for(&[pattern.to_string()], false).specs
    }

    #[test]
    fn emits_the_measured_terms_per_pattern() {
        // A bare name matches at any depth (both the file and, harmlessly, its
        // "contents"); a leading slash anchors it to the repo root.
        assert_eq!(
            specs("notes.md"),
            [
                ":(exclude,glob)**/notes.md",
                ":(exclude,glob)**/notes.md/**"
            ]
        );
        assert_eq!(
            specs("/notes.md"),
            [":(exclude,glob)notes.md", ":(exclude,glob)notes.md/**"]
        );
        // A trailing slash is a directory: one term, contents only.
        assert_eq!(specs("build/"), [":(exclude,glob)**/build/**"]);
        assert_eq!(specs("docs/build/"), [":(exclude,glob)docs/build/**"]);
        // A bare directory NAME needs the second term to hide its contents.
        assert_eq!(
            specs("node_modules"),
            [
                ":(exclude,glob)**/node_modules",
                ":(exclude,glob)**/node_modules/**"
            ]
        );
        assert_eq!(
            specs("build"),
            [":(exclude,glob)**/build", ":(exclude,glob)**/build/**"]
        );
        // An embedded `/` anchors without a leading slash.
        assert_eq!(
            specs("docs/*.log"),
            [":(exclude,glob)docs/*.log", ":(exclude,glob)docs/*.log/**"]
        );
        assert_eq!(
            specs("docs/notes.md"),
            [
                ":(exclude,glob)docs/notes.md",
                ":(exclude,glob)docs/notes.md/**"
            ]
        );
        assert_eq!(
            specs("*.log"),
            [":(exclude,glob)**/*.log", ":(exclude,glob)**/*.log/**"]
        );
        assert_eq!(
            specs("*.md"),
            [":(exclude,glob)**/*.md", ":(exclude,glob)**/*.md/**"]
        );
        // Brackets pass through untouched — git reads them as a character class
        // on both sides, so neither engine matches the literal name.
        assert_eq!(
            specs("weird[1].txt"),
            [
                ":(exclude,glob)**/weird[1].txt",
                ":(exclude,glob)**/weird[1].txt/**"
            ]
        );
        assert!(specs("!docs/notes.md").is_empty());
    }

    /// Backslash escapes come out as one-character classes, the only spelling
    /// both engines read alike — a surviving backslash is a separator to Windows
    /// git, so the term would exclude nothing and the file would reach a model.
    #[test]
    fn escapes_become_one_character_classes() {
        assert_eq!(
            specs("/notes\\ "),
            [":(exclude,glob)notes[ ]", ":(exclude,glob)notes[ ]/**"]
        );
        assert_eq!(
            specs("weird\\[1].txt"),
            [
                ":(exclude,glob)**/weird[[]1].txt",
                ":(exclude,glob)**/weird[[]1].txt/**"
            ]
        );
        assert_eq!(
            specs("star\\*.txt"),
            [
                ":(exclude,glob)**/star[*].txt",
                ":(exclude,glob)**/star[*].txt/**"
            ]
        );
        assert_eq!(
            specs("q\\?.txt"),
            [":(exclude,glob)**/q[?].txt", ":(exclude,glob)**/q[?].txt/**"]
        );
        // `\#` and a hand-typed `\!` are how gitignore names a file whose name
        // starts with a comment/negation marker; only the second needs widening.
        assert_eq!(
            specs("\\#notes.md")[0],
            ":(exclude,glob)**/[#]notes.md"
        );

        // An escaped separator: no bracket class matches `/` under `,glob`, so
        // this one re-encodes to a bare `/` — which also anchors the line, exactly
        // as gitignore anchors it.
        assert_eq!(specs("a\\/b.ts")[0], ":(exclude,glob)a/b.ts");
        // At the END of a line that bare `/` is a directory marker, so this shape
        // hides a directory's contents where gitignore matches nothing at all —
        // the documented fail-closed divergence, pinned so it can't drift.
        assert_eq!(specs("foo\\/"), [":(exclude,glob)**/foo/**"]);

        // A Windows-path-shaped rule is NOT a path: the backslash escapes the
        // `f`, so the term names the literal `srcfoo.ts` and leaves `src/foo.ts`
        // alone. Windows pathspec matching would read it the other way round, on
        // that platform alone — which is exactly what the re-encode removes.
        assert_eq!(specs("src\\foo.ts")[0], ":(exclude,glob)**/src[f]oo.ts");

        // An escaped non-ASCII character goes BARE. A class is byte-wise, so
        // `[日]` names one byte of a three-byte character and matches nothing.
        assert_eq!(
            specs("docs/\\日本語.md")[0],
            ":(exclude,glob)docs/日本語.md"
        );
    }

    /// A bracket expression the user wrote is git's own syntax: copied whole when
    /// it holds no escape, and swapped whole for `?` when it does. Rewriting a
    /// single member in place would change which characters the class accepts.
    #[test]
    fn user_bracket_expressions_pass_through_or_widen_whole() {
        // Verbatim: plain class, negated (both spellings), and `]` as the first
        // member — all parsed the same way by both engines.
        for pattern in ["a[b-c]d", "a[!b]d", "a[^b]d", "a[]]d", "weird[[]1].txt"] {
            let out = pathspecs_for(&[pattern.to_string()], false);
            assert_eq!(out.specs[0], format!(":(exclude,glob)**/{pattern}"));
            assert_eq!(out.widened, 0, "pattern {pattern:?}");
        }

        // An escape anywhere inside widens the WHOLE class: `a[b?c]d` would be
        // the class `{b,?,c}`, which stops matching the `a-d` that gitignore hides.
        let out = pathspecs_for(&["a[b\\-c]d".to_string()], false);
        assert_eq!(out.specs[0], ":(exclude,glob)**/a?d");
        assert_eq!(out.widened, 1);
        // The scan steps over an escaped `]` rather than stopping at it, or the
        // class would be split at a false terminator.
        assert_eq!(
            pathspecs_for(&["a[b\\]c]d".to_string()], false).specs[0],
            ":(exclude,glob)**/a?d"
        );

        // A POSIX class holds a `]` that does NOT terminate the expression.
        // Escape-free, so it survives whole.
        for pattern in ["a[[:digit:]]d", "a[[:alpha:][:digit:]]d", "a[![:digit:]]d"] {
            let out = pathspecs_for(&[pattern.to_string()], false);
            assert_eq!(out.specs[0], format!(":(exclude,glob)**/{pattern}"));
            assert_eq!(out.widened, 0, "pattern {pattern:?}");
        }
        // With an escape after the class, the WHOLE expression widens — stopping
        // the scan at the class's `]` would instead rewrite one member and drop
        // the `a-d` that gitignore hides.
        let out = pathspecs_for(&["a[[:digit:]\\-]d".to_string()], false);
        assert_eq!(out.specs[0], ":(exclude,glob)**/a?d");
        assert_eq!(out.widened, 1);
        // A lone `[:` with no `:]` is an ordinary member, not a class.
        assert_eq!(specs("a[[:x]d")[0], ":(exclude,glob)**/a[[:x]d");

        // Unterminated: both engines abandon the pattern and match nothing, and
        // the copied `[` keeps the pathspec side there.
        assert_eq!(specs("a[b")[0], ":(exclude,glob)**/a[b");
        assert_eq!(specs("a[")[0], ":(exclude,glob)**/a[");
        // …unless a later escape emits a class whose `]` closes the dangling `[`,
        // making it a real class where gitignore matched nothing. Fail-closed, so
        // the emission stands — but it is counted, not silent.
        let reclosed = pathspecs_for(&["a[b\\xc".to_string()], false);
        assert_eq!(reclosed.specs[0], ":(exclude,glob)**/a[b[x]c");
        assert_eq!(reclosed.widened, 1);
    }

    /// The five class-special escapes (and a dangling backslash) fall back to
    /// `?`, counted so a caller could disclose it. Over-excluding a sibling name
    /// is the safe direction on a privacy boundary; leaking the named file is not.
    #[test]
    fn class_special_escapes_widen_to_a_wildcard() {
        for (pattern, want) in [
            ("bang\\!.txt", ":(exclude,glob)**/bang?.txt"),
            ("br\\].txt", ":(exclude,glob)**/br?.txt"),
            ("hat\\^.txt", ":(exclude,glob)**/hat?.txt"),
            ("dash\\-.txt", ":(exclude,glob)**/dash?.txt"),
            ("back\\\\.txt", ":(exclude,glob)**/back?.txt"),
            ("dangling\\", ":(exclude,glob)**/dangling?"),
        ] {
            let out = pathspecs_for(&[pattern.to_string()], false);
            assert_eq!(out.specs[0], want, "pattern {pattern:?}");
            assert_eq!(out.widened, 1, "pattern {pattern:?}");
        }
        // An exact class is not a widening — including the Windows-path-shaped
        // rule, whose `\f` is an ordinary escape however much it reads as a
        // separator.
        assert_eq!(pathspecs_for(&["/notes\\ ".into()], false).widened, 0);
        assert_eq!(pathspecs_for(&["src\\foo.ts".into()], false).widened, 0);
    }

    #[test]
    fn drops_blanks_comments_and_negations() {
        let out = pathspecs_for(
            &[
                "  ".to_string(),
                "# a comment".to_string(),
                "!docs/notes.md".to_string(),
                "  *.log  ".to_string(),
                "/".to_string(),
            ],
            false,
        );
        assert_eq!(
            out.specs,
            [":(exclude,glob)**/*.log", ":(exclude,glob)**/*.log/**"]
        );
        assert_eq!(out.skipped_negations, 1);
    }

    /// Every fixture path in the parity repo, repo-relative and sorted.
    const FIXTURE: [&str; 27] = [
        // A bracket expression's members (`a-d`/`abd`) plus a name only the
        // widened `?` reaches (`aXd`), so a class and its widening are
        // distinguishable.
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
        // Each `?`-widened escape with a sibling only the wildcard reaches, so
        // the fail-closed asymmetry has a witness (`widened_escapes_…` below).
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
    /// exactly which of `FIXTURE` it hides. Both engines must agree with it.
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
        // A bracket is a character class in gitignore, so it never matches the
        // literal name — `,literal` pathspec magic would silently diverge here.
        (&["weird[1].txt"], &[]),
        // `!` un-ignore lines are unsupported and dropped by BOTH engines: a lone
        // negation hides nothing, and a negation after a matching pattern
        // re-includes nothing. Git's own engine would honor the second case, so
        // this row is what holds the two engines together on negations.
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
        // pattern matches nothing — on BOTH engines. `case_folding_follows_the_repo`
        // covers the `true` half, which is the platform default on Windows/macOS.
        (&["NOTES.MD"], &[]),
        // A concrete path carrying glob metacharacters, escaped the way the UI's
        // *Exclude from AI* actions emit it: `[` wrapped as `[[]`. Unescaped it is
        // a character class and protects nothing — the `weird[1].txt` row above.
        (&["weird[[]1].txt"], &["weird[1].txt"]),
        (&["/weird[[]1].txt"], &["weird[1].txt"]),
        // The hand-typed gitignore spelling of the same escape. Only the
        // gitignore engine reads a backslash, so this row is what pins the
        // pathspec side's re-encode of it.
        (&["weird\\[1].txt"], &["weird[1].txt"]),
        // A backslash is ALWAYS a gitignore escape, never a Windows separator:
        // `src\foo.ts` escapes the `f` and names the literal `srcfoo.ts`, leaving
        // `src/foo.ts` visible. This row is what keeps that uniform across
        // engines — Windows pathspec matching would otherwise read the backslash
        // as a separator and hide the OTHER file, on that platform alone.
        (&["src\\foo.ts"], &["srcfoo.ts"]),
        // The one escape that is not a bracket class on the pathspec side: no
        // class matches a separator under `,glob`, so `\/` becomes a bare `/` —
        // which must also anchor the line exactly as gitignore anchors it.
        (&["a\\/b.ts"], &["a/b.ts"]),
        // A bracket expression the USER wrote, carrying no escape: copied through
        // untouched, and the two engines read it identically (a range here, so
        // `a-d` is NOT a member — only `abd` is in this fixture).
        (&["a[b-c]d"], &["abd"]),
        // An escaped NON-ASCII character goes bare. As a one-character class it
        // would ask for a single byte of a three-byte character and match nothing,
        // while gitignore hides the file — the fail-open direction.
        (&["docs/\\日本語.md"], &["docs/日本語.md"]),
        // A POSIX class carries its own `]`, which the terminator scan must step
        // over. Escape-free, so it passes through verbatim and both engines read
        // the same class.
        (&["a[[:digit:]]d"], &["a5d"]),
        // An unterminated `[` is abandoned by BOTH engines — an agreement row
        // that happens to hide nothing, which is exactly the claim worth pinning:
        // the copied `[` must not start matching on the pathspec side.
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

    /// What the pathspec terms hide: `FIXTURE` minus what `ls-files` still lists.
    /// Goes through `pathspecs_for_repo`, so case folding is resolved from the
    /// repo exactly as the real diff call sites do it.
    async fn hidden_by_pathspec(repo: &str, patterns: &[&str]) -> BTreeSet<String> {
        let owned: Vec<String> = patterns.iter().map(|p| p.to_string()).collect();
        let terms = pathspecs_for_repo(repo, &owned).await.specs;
        let mut args: Vec<String> = vec!["ls-files".into()];
        if !terms.is_empty() {
            args.push("--".into());
            args.push(".".into());
            args.extend(terms);
        }
        let argref: Vec<&str> = args.iter().map(String::as_str).collect();
        let listed: BTreeSet<String> = run_git(Some(repo), &argref, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        FIXTURE
            .iter()
            .map(|p| p.to_string())
            .filter(|p| !listed.contains(p))
            .collect()
    }

    /// A trailing space survives into the match, which only a backslash escape
    /// can express: gitignore strips an unescaped one, so the pattern for a file
    /// named `notes ` would otherwise hide `notes` instead — the wrong file, and
    /// the named one left visible.
    ///
    /// Gitignore engine only, deliberately: this engine takes arbitrary path
    /// STRINGS, while the pathspec half matches against the index, and git on
    /// Windows refuses to index a trailing-space path at all ("Invalid path").
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

    /// Both engines on one WORKING-TREE fixture, for the escaped-trailing-space
    /// shape the PARITY table cannot carry: git on Windows rejects a
    /// trailing-space path outright ("Invalid path"), so it can never enter that
    /// fixture's index. Skipped there for that reason alone — the pathspec half
    /// itself now holds on every platform, which
    /// [`escaped_trailing_space_excluded_by_pathspec_everywhere`] pins through the
    /// object database instead.
    ///
    /// Skipped at RUNTIME rather than `#[cfg(unix)]`-gated so the body still
    /// compiles on Windows; a cfg-gated test first compiles on CI, where a typo
    /// costs a red run instead of a local one.
    #[tokio::test]
    async fn escaped_trailing_space_agrees_across_engines() {
        if cfg!(windows) {
            return;
        }
        let dir = tempfile::Builder::new()
            .prefix("gd-aiignore-space-")
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
        let files = ["notes ", "notes"];
        for rel in files {
            std::fs::write(Path::new(&repo).join(rel), "x\n").unwrap();
        }
        run_git(Some(&repo), &["add", "-A", "-f"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        // Exactly what *Exclude from AI* now writes for a file named `notes `.
        let patterns = vec!["/notes\\ ".to_string()];

        let terms = pathspecs_for_repo(&repo, &patterns).await.specs;
        let mut args: Vec<String> = vec!["ls-files".into(), "--".into(), ".".into()];
        args.extend(terms);
        let argref: Vec<&str> = args.iter().map(String::as_str).collect();
        // NOT trimmed: the whole point is a name whose last character is a space.
        let listed: BTreeSet<String> = run_git(Some(&repo), &argref, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();
        let by_pathspec: BTreeSet<String> = files
            .iter()
            .map(|p| p.to_string())
            .filter(|p| !listed.contains(p))
            .collect();

        let by_gitignore: BTreeSet<String> = git_filter_ai_ignored(
            repo.clone(),
            files.iter().map(|p| p.to_string()).collect(),
            patterns,
        )
        .await
        .unwrap()
        .into_iter()
        .collect();

        let want: BTreeSet<String> = ["notes ".to_string()].into_iter().collect();
        assert_eq!(by_pathspec, want, "pathspec engine");
        assert_eq!(by_gitignore, want, "gitignore engine");
    }

    /// The pathspec engine hides an escaped-trailing-space file on EVERY platform
    /// — the regression that matters, since it is Windows where a raw `\ ` term
    /// silently excluded nothing and handed `notes ` to a model.
    ///
    /// Built straight in the object database (`hash-object` → `mktree`) and
    /// diffed tree against empty tree: no commit, no checkout and no index, which
    /// is the only way a trailing-space path exists at all under Windows git.
    #[tokio::test]
    async fn escaped_trailing_space_excluded_by_pathspec_everywhere() {
        let dir = tempfile::Builder::new()
            .prefix("gd-aiignore-tree-")
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

        let git_out = |args: Vec<String>, input: Option<String>| {
            let repo = repo.clone();
            async move {
                let argref: Vec<&str> = args.iter().map(String::as_str).collect();
                // NOT trimmed: a fixture name ends in a space, and the caller
                // below compares those names byte for byte.
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
        let empty = git_out(vec!["mktree".into()], Some(String::new()))
            .await
            .trim()
            .to_string();

        // Exactly what *Exclude from AI* writes for a file named `notes `.
        let terms = pathspecs_for_repo(&repo, &["/notes\\ ".to_string()])
            .await
            .specs;
        let mut args: Vec<String> = vec![
            "diff".into(),
            "--name-only".into(),
            empty,
            tree,
            "--".into(),
            ".".into(),
        ];
        args.extend(terms);
        let listed: BTreeSet<String> = git_out(args, None)
            .await
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();

        let hidden: BTreeSet<String> = files
            .iter()
            .map(|p| p.to_string())
            .filter(|p| !listed.contains(p))
            .collect();
        assert_eq!(
            hidden,
            ["notes ".to_string()].into_iter().collect::<BTreeSet<_>>(),
            "only the trailing-space file is hidden; listed = {listed:?}"
        );
    }

    /// The two engines agree with each other AND with the measured table, for
    /// every pattern shape the UI can produce. This is the test that stops the
    /// pathspec translation drifting away from real gitignore.
    #[tokio::test]
    async fn both_engines_match_the_measured_table() {
        let (_dir, repo) = parity_repo().await;
        let all: Vec<String> = FIXTURE.iter().map(|p| p.to_string()).collect();

        for (patterns, expected) in PARITY {
            let want: BTreeSet<String> = expected.iter().map(|p| p.to_string()).collect();

            let by_pathspec = hidden_by_pathspec(&repo, patterns).await;
            assert_eq!(by_pathspec, want, "pathspec engine, patterns {patterns:?}");

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

    /// The `?`-widened escapes hold the fail-CLOSED invariant, which is the most
    /// the PARITY table could never state: those shapes are the one place the two
    /// engines are allowed to disagree, and the direction is the whole point.
    ///
    /// The gitignore engine hides exactly the escaped name; the pathspec engine
    /// must hide AT LEAST it. Over-excluding a sibling costs a file the model
    /// could have seen; under-excluding hands over the file the user named.
    #[tokio::test]
    async fn widened_escapes_over_exclude_and_never_under_exclude() {
        let (_dir, repo) = parity_repo().await;
        let all: Vec<String> = FIXTURE.iter().map(|p| p.to_string()).collect();

        for (pattern, gitignore_hides, only_by_wildcard) in [
            ("bang\\!.txt", &["bang!.txt"][..], "bangX.txt"),
            ("hat\\^.txt", &["hat^.txt"][..], "hatX.txt"),
            // A bracket carrying an escape widens to `?` as a whole; gitignore
            // reads the class literally, so `a-d` and `abd` are its members.
            ("a[b\\-c]d", &["a-d", "abd"][..], "aXd"),
            // The same, with a POSIX class ahead of the escape. Rewriting the
            // escape in place would leave `a[[:digit:]?]d` — digits plus `?` —
            // which stops hiding the `a-d` that gitignore hides.
            ("a[[:digit:]\\-]d", &["a-d", "a5d"][..], "abd"),
        ] {
            let by_gitignore: BTreeSet<String> = git_filter_ai_ignored(
                repo.clone(),
                all.clone(),
                vec![pattern.to_string()],
            )
            .await
            .unwrap()
            .into_iter()
            .collect();
            assert_eq!(
                by_gitignore,
                gitignore_hides
                    .iter()
                    .map(|p| p.to_string())
                    .collect::<BTreeSet<_>>(),
                "gitignore engine hides exactly the named files, patterns {pattern:?}"
            );

            let by_pathspec = hidden_by_pathspec(&repo, &[pattern]).await;
            assert!(
                by_gitignore.is_subset(&by_pathspec),
                "pathspec engine must hide at least what gitignore hides; \
                 pattern {pattern:?} gave {by_pathspec:?}"
            );
            // Strictly more, here: the `?` also swallows the sibling. Asserted so
            // the subset check above can't pass by the two sets being equal for
            // some unrelated reason.
            assert!(
                by_pathspec.contains(only_by_wildcard),
                "pattern {pattern:?} should also sweep {only_by_wildcard}"
            );
        }
    }

    /// Case folding follows the USER'S REPO, identically on both engines.
    ///
    /// The failure this pins is asymmetric and silent: pathspec matching is
    /// case-sensitive whatever `core.ignorecase` says, while real gitignore folds
    /// when it is set — the default on Windows and macOS. Without `,icase` a
    /// `NOTES.MD` pattern would hide `notes.md` from the conflict gate and the
    /// remote-PR filter while every diff path still shipped it to the model.
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
        // nothing, on either engine.
        assert!(hidden_by_pathspec(&repo, &["NOTES.MD"]).await.is_empty());
        assert!(
            git_filter_ai_ignored(repo.clone(), all.clone(), pattern.clone())
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(specs("NOTES.MD")[0], ":(exclude,glob)**/NOTES.MD");

        // Flip the REPO's setting; both engines must follow it, and each other.
        // Written as `1`, NOT `true`: git accepts `1`/`yes`/`on`/a valueless key
        // as true, so a raw string compare reads this repo as case-SENSITIVE and
        // forces that onto both engines — agreeing with each other and wrong.
        run_git(
            Some(&repo),
            &["config", "core.ignorecase", "1"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        // Behavior first: an emitted-magic assertion ahead of it would mask which
        // half actually broke.
        let by_pathspec = hidden_by_pathspec(&repo, &["NOTES.MD"]).await;
        assert_eq!(by_pathspec, want_folded, "pathspec engine folds case");

        let by_gitignore: BTreeSet<String> = git_filter_ai_ignored(repo, all, pattern)
            .await
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(by_gitignore, want_folded, "gitignore engine folds case");
        assert_eq!(by_pathspec, by_gitignore, "and the two agree");
        assert_eq!(
            specs_icase("NOTES.MD")[0],
            ":(exclude,glob,icase)**/NOTES.MD"
        );
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

    /// The repo's OWN `.gitignore` is not an AI-ignore list. Matching runs in an
    /// empty neutral repo, so `keep.txt` — gitignored by the fixture, named by no
    /// AI pattern — stays visible to both engines. Running check-ignore inside
    /// the user's repo instead reports it, which would both silently
    /// over-withhold and split the two engines apart.
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
            ai_patterns.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            by_gitignore,
            vec!["notes.md".to_string()],
            "only the AI pattern matched — the repo's .gitignore did not leak in"
        );

        let by_pathspec = hidden_by_pathspec(&repo, &["notes.md"]).await;
        assert!(
            !by_pathspec.contains(REPO_GITIGNORE_ONLY),
            "the pathspec engine agrees the gitignored path is not AI-ignored"
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

    /// A `!` un-ignore line is unsupported: adding one changes NOTHING on either
    /// engine. Git's own matcher would re-include the negated path, so without
    /// the shared drop the same list would hide a file on the pathspec paths and
    /// hand it to a model on this one.
    #[tokio::test]
    async fn negation_lines_change_nothing_on_either_engine() {
        let (_dir, repo) = parity_repo().await;
        let all: Vec<String> = FIXTURE.iter().map(|p| p.to_string()).collect();
        let plain = vec!["*.md".to_string()];
        let negated = vec!["*.md".to_string(), "!docs/notes.md".to_string()];

        let translated = pathspecs_for(&negated, false);
        assert_eq!(translated.skipped_negations, 1);
        assert_eq!(translated.specs, pathspecs_for(&plain, false).specs);

        let with = git_filter_ai_ignored(repo.clone(), all.clone(), negated)
            .await
            .unwrap();
        let without = git_filter_ai_ignored(repo.clone(), all, plain)
            .await
            .unwrap();
        assert_eq!(with, without, "the `!` line did not re-include anything");
        assert!(
            with.contains(&"docs/notes.md".to_string()),
            "the negated path stays hidden"
        );

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
}
