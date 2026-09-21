use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git, run_git_mutating_input, run_git_raw, DEFAULT_TIMEOUT};
use crate::git::types::{DiffStatEntry, FileDiff, StagedDiff};
use crate::image_sniff::{dimensions_within_caps, has_raster_magic, sniff_image};
use crate::state::AppState;

/// Cap on file bytes shipped for image previews.
const IMAGE_MAX_BYTES: usize = 20_000_000;

/// One file's bytes for the webview, or the reason they are being withheld. A refusal
/// is a STATE rather than an error: the diff view has a pane to show for it.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBytes {
    /// Base64 of the file bytes; `None` when the preview is refused.
    pub base64: Option<String>,
    /// Media type sniffed from the bytes — one of PNG, GIF, JPEG, WebP. `None` for
    /// anything else (SVG, BMP, ICO, text, …), which ships bounded by bytes alone.
    pub mime: Option<String>,
    pub too_large: bool,
}

/// Raw file bytes (base64) at a revision, or from the working tree when
/// `rev` is None. `None` result = the file doesn't exist there (e.g. the
/// old side of an added file). Drives the image diff view.
#[tauri::command]
pub async fn git_file_base64(
    repo_path: String,
    rev: Option<String>,
    file_path: String,
) -> AppResult<Option<FileBytes>> {
    use base64::Engine;
    let bytes: Option<Vec<u8>> = match rev {
        Some(rev) => {
            if rev.is_empty() || rev.starts_with('-') {
                return Err(AppError::InvalidArgument(format!("invalid rev: {rev}")));
            }
            let spec = format!("{rev}:{file_path}");
            let out = run_git_raw(Some(&repo_path), &["show", &spec], DEFAULT_TIMEOUT).await?;
            // Nonzero exit = the path doesn't exist at that revision.
            (out.code == 0).then_some(out.stdout)
        }
        None => tokio::fs::read(std::path::Path::new(&repo_path).join(&file_path))
            .await
            .ok(),
    };
    let Some(bytes) = bytes else { return Ok(None) };
    if bytes.len() > IMAGE_MAX_BYTES {
        return Ok(Some(FileBytes {
            base64: None,
            mime: None,
            too_large: true,
        }));
    }
    // The byte cap bounds the compressed copy and says nothing about the decode the
    // webview performs, so a sniffable raster is gated on the size its header DECLARES:
    // a few KB of PNG can otherwise ask the renderer for gigabytes. The type comes from
    // the bytes rather than the extension, which any commit can spell freely.
    let sniffed = sniff_image(&bytes);
    let refuse = match sniffed {
        Some((_, width, height)) => !dimensions_within_caps(width, height),
        // `sniff_image`'s `None` is fail-CLOSED, not "nothing to gate": its walk stops
        // at any header it cannot read with certainty, while the webview's decoder is
        // more lenient than the walk (it discards the stuffed `FF 00` pairs the walk
        // refuses and reads the frame header behind them). A recognized container with
        // an unreadable header therefore has no measured raster, and must not reach
        // that decoder — only magic-less bytes fall through to the byte cap.
        None => has_raster_magic(&bytes),
    };
    if refuse {
        return Ok(Some(FileBytes {
            base64: None,
            mime: sniffed.map(|(media_type, _, _)| media_type.to_string()),
            too_large: true,
        }));
    }
    // Bytes that open with no raster magic at all ship under the byte cap alone. SVG is
    // kept deliberately: in an `<img>` it is a non-scripting document — no script runs
    // and external references are blocked — so unlike the link-preview gate, which
    // carries third-party bytes into a hover card, this surface can render a
    // repository's own SVGs. It is also outside what a declared-dimensions cap could
    // bound: the webview rasterizes SVG at display size, so its header states no
    // decode. BMP and ICO have no reader here either and are likewise byte-bound.
    Ok(Some(FileBytes {
        base64: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        mime: sniffed.map(|(media_type, _, _)| media_type.to_string()),
        too_large: false,
    }))
}

/// Applies a patch — typically a single hunk cut out of a working-tree diff.
/// stage hunk = `cached`, unstage hunk = `cached + reverse`,
/// discard hunk = `reverse` (working tree).
#[tauri::command]
pub async fn git_apply_patch(
    state: State<'_, AppState>,
    repo_path: String,
    patch: String,
    cached: bool,
    reverse: bool,
) -> AppResult<()> {
    if patch.trim().is_empty() {
        return Err(AppError::InvalidArgument("empty patch".into()));
    }
    let mut args = vec!["apply", "--whitespace=nowarn"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-"); // read the patch from stdin
    run_git_mutating_input(&state, &repo_path, &args, Some(&patch), DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// One changed line the user selected for partial staging. `side` is which side
/// of the diff the line belongs to: `old` for a deletion (matched by old-file
/// line number), `new` for an addition (matched by new-file line number).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Old,
    New,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SelectedLine {
    pub side: Side,
    pub line: u32,
}

/// Parse the start line numbers from a `@@ -A[,B] +C[,D] @@ …` header. Only the
/// first `-`/`+` token counts (a section heading may contain more).
fn parse_hunk_starts(header: &str) -> (u32, u32) {
    let mut old = None;
    let mut new = None;
    for tok in header.split_whitespace() {
        if old.is_none() {
            if let Some(rest) = tok.strip_prefix('-') {
                old = rest.split(',').next().and_then(|s| s.parse().ok());
                continue;
            }
        }
        if new.is_none() {
            if let Some(rest) = tok.strip_prefix('+') {
                new = rest.split(',').next().and_then(|s| s.parse().ok());
            }
        }
    }
    (old.unwrap_or(0), new.unwrap_or(0))
}

/// The optional section heading after the closing `@@` of a hunk header.
fn hunk_section(header: &str) -> &str {
    let mut it = header.match_indices("@@");
    it.next();
    match it.next() {
        Some((idx, _)) => &header[idx + 2..],
        None => "",
    }
}

/// Build a patch containing only the user-selected changed lines from a
/// single-file unified diff, neutralizing the rest so the result still applies
/// cleanly. `reverse` means the patch will be applied with `--reverse`
/// (unstage/discard); it flips which unselected changes are dropped vs. turned
/// into context. Returns an empty string if nothing selected lands in any hunk.
///
/// Forward (stage): unselected `+` dropped, unselected `-` → context.
/// Reverse (unstage/discard): unselected `+` → context, unselected `-` dropped.
pub fn build_partial_patch(diff_text: &str, selected: &[SelectedLine], reverse: bool) -> String {
    use std::collections::HashSet;
    let sel_old: HashSet<u32> = selected
        .iter()
        .filter(|s| s.side == Side::Old)
        .map(|s| s.line)
        .collect();
    let sel_new: HashSet<u32> = selected
        .iter()
        .filter(|s| s.side == Side::New)
        .map(|s| s.line)
        .collect();

    let lines: Vec<&str> = diff_text.split('\n').collect();
    let Some(first_hunk) = lines.iter().position(|l| l.starts_with("@@")) else {
        return String::new();
    };
    let header = lines[..first_hunk].join("\n");

    let mut out_hunks = String::new();
    let mut i = first_hunk;
    while i < lines.len() {
        if !lines[i].starts_with("@@") {
            i += 1;
            continue;
        }
        let (old_start, new_start) = parse_hunk_starts(lines[i]);
        let mut j = i + 1;
        while j < lines.len() && !lines[j].starts_with("@@") {
            j += 1;
        }

        let mut out_body: Vec<String> = Vec::new();
        let mut old_no = old_start;
        let mut new_no = new_start;
        let mut old_count = 0u32;
        let mut new_count = 0u32;
        let mut kept_change = false;
        let mut last_kept = false;

        for &bl in &lines[i + 1..j] {
            // The final "\n" split leaves a trailing "" — a real context blank
            // line is " " (a space), so empty strings are just that artifact.
            if bl.is_empty() {
                continue;
            }
            match bl.as_bytes()[0] {
                b' ' => {
                    out_body.push(bl.to_string());
                    old_no += 1;
                    new_no += 1;
                    old_count += 1;
                    new_count += 1;
                    last_kept = true;
                }
                b'+' => {
                    let selected = sel_new.contains(&new_no);
                    new_no += 1;
                    if selected {
                        out_body.push(bl.to_string());
                        new_count += 1;
                        kept_change = true;
                        last_kept = true;
                    } else if reverse {
                        // Stays in the index/worktree — show it as context.
                        out_body.push(format!(" {}", &bl[1..]));
                        old_count += 1;
                        new_count += 1;
                        last_kept = true;
                    } else {
                        last_kept = false; // forward: drop it
                    }
                }
                b'-' => {
                    let selected = sel_old.contains(&old_no);
                    old_no += 1;
                    if selected {
                        out_body.push(bl.to_string());
                        old_count += 1;
                        kept_change = true;
                        last_kept = true;
                    } else if reverse {
                        last_kept = false; // reverse: drop it
                    } else {
                        // Not being removed yet — show it as context.
                        out_body.push(format!(" {}", &bl[1..]));
                        old_count += 1;
                        new_count += 1;
                        last_kept = true;
                    }
                }
                b'\\' => {
                    // "\ No newline at end of file" annotates the previous line.
                    if last_kept {
                        out_body.push(bl.to_string());
                    }
                }
                _ => out_body.push(bl.to_string()),
            }
        }

        if kept_change {
            out_hunks.push_str(&format!(
                "@@ -{old_start},{old_count} +{new_start},{new_count} @@{}\n",
                hunk_section(lines[i])
            ));
            for l in &out_body {
                out_hunks.push_str(l);
                out_hunks.push('\n');
            }
        }
        i = j;
    }

    if out_hunks.is_empty() {
        return String::new();
    }
    format!("{header}\n{out_hunks}")
}

/// Stage/unstage/discard a selected subset of lines (see `build_partial_patch`).
/// stage = cached; unstage = cached + reverse; discard = reverse.
#[tauri::command]
pub async fn git_apply_partial(
    state: State<'_, AppState>,
    repo_path: String,
    diff_text: String,
    selected: Vec<SelectedLine>,
    cached: bool,
    reverse: bool,
) -> AppResult<()> {
    let patch = build_partial_patch(&diff_text, &selected, reverse);
    if patch.trim().is_empty() {
        return Err(AppError::InvalidArgument("no changes selected".into()));
    }
    // --recount lets git fix up hunk line counts from content, a safety net on
    // top of the exact counts we compute.
    let mut args = vec!["apply", "--whitespace=nowarn", "--recount"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");
    run_git_mutating_input(&state, &repo_path, &args, Some(&patch), DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// Cap on diff text shipped to the webview for rendering.
const VIEWER_MAX_BYTES: usize = 1_000_000;
/// Default cap on staged diff text shipped for AI prompt building.
const AI_DEFAULT_MAX_BYTES: usize = 1_000_000;

#[tauri::command]
pub async fn git_diff_file(
    repo_path: String,
    file_path: String,
    staged: bool,
    untracked: bool,
) -> AppResult<FileDiff> {
    let out = if untracked {
        // Full-file "added" diff for files git doesn't track yet.
        // git maps /dev/null to the platform null device; exit code 1 just
        // means "differences found" for --no-index.
        // `--no-index` takes FILESYSTEM paths, not pathspecs — `:(literal)` here
        // fails with "could not access" (measured), so this half stays raw.
        let out = run_git_raw(
            Some(&repo_path),
            &["diff", "--no-index", "--", "/dev/null", &file_path],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if out.code > 1 {
            return Err(AppError::Git {
                code: out.code,
                stderr: out.stderr,
            });
        }
        out
    } else {
        // Literal pathspec: a `[slug]`-style path would otherwise splice its
        // glob-siblings' hunks into this file's diff.
        let spec = crate::git::pathspec::literal(&file_path);
        let mut args = vec!["diff", "--no-color"];
        if staged {
            args.push("--cached");
        }
        args.extend(["--", spec.as_str()]);
        run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?
    };

    let text = out.stdout_lossy();
    let is_binary = text.lines().any(|l| {
        l.starts_with("Binary files ") && l.ends_with(" differ")
    });
    let (text, is_truncated) = truncate_at_char_boundary(text, VIEWER_MAX_BYTES);

    Ok(FileDiff {
        file_path,
        is_binary,
        is_truncated,
        text,
    })
}

/// Diff a single file in an agent **session** worktree against the session's base
/// commit — the file's *cumulative* change across the whole session (committed
/// turns AND the current uncommitted edits, unlike `git diff HEAD`, which resets
/// per checkpoint commit). Powers the inline edit-step diff in the agent
/// transcript. A brand-new file the agent just wrote is still untracked, so the
/// base diff shows nothing — fall back to a full-file "added" diff (as
/// `git_diff_file` does for untracked files). `repo_path` is the worktree.
#[tauri::command]
pub async fn git_session_file_diff(
    repo_path: String,
    file_path: String,
    base: String,
) -> AppResult<FileDiff> {
    // base → working tree: captures both committed-turn changes and uncommitted edits.
    // Literal pathspec so a `[slug]`-style path can't pull in a glob-sibling's hunks.
    let spec = crate::git::pathspec::literal(&file_path);
    let out = run_git(
        Some(&repo_path),
        &["diff", "--no-color", &base, "--", &spec],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let mut text = out.stdout_lossy();

    // Empty tracked diff + the file is untracked (a just-written new file) →
    // show it as a full add, the same way git_diff_file handles untracked.
    if text.trim().is_empty() {
        let others = run_git(
            Some(&repo_path),
            &["ls-files", "--others", "--exclude-standard", "--", &spec],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if !others.stdout_lossy().trim().is_empty() {
            // `--no-index` takes a FILESYSTEM path, so this one stays raw (see
            // git_diff_file); only the pathspec-taking probe above is literalized.
            let no_index = run_git_raw(
                Some(&repo_path),
                &["diff", "--no-index", "--", "/dev/null", &file_path],
                DEFAULT_TIMEOUT,
            )
            .await?;
            // exit 1 just means "differences found" for --no-index; >1 is a real error.
            if no_index.code > 1 {
                return Err(AppError::Git {
                    code: no_index.code,
                    stderr: no_index.stderr,
                });
            }
            text = no_index.stdout_lossy();
        }
    }

    let is_binary = text
        .lines()
        .any(|l| l.starts_with("Binary files ") && l.ends_with(" differ"));
    let (text, is_truncated) = truncate_at_char_boundary(text, VIEWER_MAX_BYTES);

    Ok(FileDiff {
        file_path,
        is_binary,
        is_truncated,
        text,
    })
}

#[tauri::command]
pub async fn git_staged_diff(
    repo_path: String,
    max_bytes: Option<usize>,
    exclude: Option<Vec<String>>,
    worktree: Option<bool>,
) -> AppResult<StagedDiff> {
    let max_bytes = max_bytes.unwrap_or(AI_DEFAULT_MAX_BYTES);
    // `--cached` diffs staged changes vs HEAD (commit messages); `HEAD` diffs
    // the whole working tree vs HEAD (staged + unstaged), for naming a branch
    // off in-progress work that hasn't been staged yet.
    let base = if worktree.unwrap_or(false) {
        "HEAD"
    } else {
        "--cached"
    };

    // `recheck: true` — this diff reads the index and working tree, which a
    // concurrent edit can change between the name pass and the content pass.
    let filtered = crate::git::ai_ignore::filtered_diff(
        &repo_path,
        &["diff", base, "--no-color"],
        &["diff", base, "--numstat", "-z"],
        &exclude.unwrap_or_default(),
        true,
    )
    .await?;

    let (text, truncated) = truncate_at_file_boundary(filtered.text, max_bytes);

    Ok(StagedDiff {
        text,
        truncated,
        files: filtered.files,
        excluded_files: filtered.excluded_files,
    })
}

/// Per-file line counts for the working tree, one list per diff side.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingLineStats {
    /// Index vs HEAD — what the Staged section's rows show.
    pub staged: Vec<DiffStatEntry>,
    /// Working tree vs index — what the Changes section's rows show.
    pub unstaged: Vec<DiffStatEntry>,
}

/// git's own binary sniff window: with no `.gitattributes` diff override in play, a
/// NUL among a file's first 8000 bytes is what makes git report `-` counts, so an
/// untracked file falls back to the same test.
const BINARY_SNIFF_BYTES: usize = 8000;
/// git's DEFAULT `core.bigFileThreshold`, past which git diffs a file as binary. The
/// repo's effective value is resolved per call, and this reaches git as that read's
/// `--default` for an unset key; a read that answers nothing readable blanks the
/// untracked lane rather than falling back here.
const BIG_FILE_BYTES_DEFAULT: u64 = 512 * 1024 * 1024;
/// Ceiling on bytes one call may read across untracked files, spent in `ls-files`
/// order — it bounds the 5s poll's I/O on a tree full of not-yet-ignored files. A
/// hard ceiling, not an accounting one: the reader carries what is left of it as its
/// own cap, so a file that grows after its size check still cannot read past it.
const UNTRACKED_READ_BUDGET: u64 = 64 * 1024 * 1024;
/// Read window for the line count: the only memory a file's size can influence,
/// so no untracked file is ever held whole.
const LINE_COUNT_CHUNK: usize = 64 * 1024;

/// A path's `diff` attribute, for the paths `.gitattributes` decides. A custom driver
/// name resolves through its `diff.<name>.binary` config; only an unconfigured driver,
/// one set to `binary = auto`, or a path no rule names carries no verdict and falls
/// back to the content sniff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiffAttr {
    /// `-diff`, or a driver with `binary = true`: git diffs the path as binary
    /// whatever its bytes are.
    Binary,
    /// `diff`, or a driver with `binary = false`: forced text, so a NUL in the
    /// content must not flip the verdict.
    ForcedText,
}

/// git's config-bool alphabet, case-insensitive: the named spellings, a VALUELESS key
/// (`None`) as true, an empty value as false, and any DECIMAL integer, where non-zero
/// is true (git also reads `0x` hex via strtoimax base 0; that spelling drops to the
/// sniff here). A junk value is not a bool git can parse either — git FATALS the diff
/// rather than choosing — so dropping the entry and letting the content sniff decide
/// is strictly more graceful than what git itself does.
fn git_config_bool(value: Option<&str>) -> Option<bool> {
    let Some(value) = value else {
        return Some(true);
    };
    let value = value.to_ascii_lowercase();
    match value.as_str() {
        "true" | "yes" | "on" | "1" => return Some(true),
        "false" | "no" | "off" | "0" | "" => return Some(false),
        _ => {}
    }
    // git reads an integer value as a bool by its zero-ness, and its scale suffixes
    // multiply, so a non-zero numeric part cannot scale to zero — only that part is
    // read here. (`0` and `1` answer above; both routes agree on them.)
    let numeric = value.strip_suffix(['k', 'm', 'g']).unwrap_or(&value);
    numeric.parse::<i64>().ok().map(|n| n != 0)
}

/// Parses `git config -z --get-regexp` output: NUL separates ENTRIES, and a newline
/// separates each entry's key from its value — a valueless key carries no newline at
/// all. Only a `diff.<driver>.binary` key whose value is a git bool carries a verdict;
/// `<driver>` is everything between the prefix and the suffix, so a dotted driver name
/// survives intact. `None` = the stream is not the shape this asked git for (a key
/// outside the queried pattern), which is a probe FAILURE rather than an empty answer.
/// Three cases skip their own entry instead: `auto`, the key's third value (the key is
/// a tristate, not a bool), which asks for a content decision and so CLEARS any verdict
/// an earlier scope set; any OTHER non-bool value, since git fatals on those and
/// per-entry degrading is the gentler read; and an EMPTY driver name, since `[diff ""]`
/// is legal config whose key is in-pattern.
fn parse_diff_driver_binary(text: &str) -> Option<std::collections::HashMap<String, bool>> {
    let mut flags = std::collections::HashMap::new();
    for entry in text.split('\0').filter(|e| !e.is_empty()) {
        let (key, value) = match entry.split_once('\n') {
            Some((key, value)) => (key, Some(value)),
            None => (entry, None),
        };
        // An off-pattern key means the stream is not what this asked for.
        let name = key
            .strip_prefix("diff.")
            .and_then(|rest| rest.strip_suffix(".binary"))?;
        // An empty subsection names no driver any `diff` attribute value could
        // reference — check-attr never answers with an empty string.
        if name.is_empty() {
            continue;
        }
        // The key is a TRISTATE: `auto` means decide by content, which is what the
        // sniff already does, and as a later match it CLEARS an earlier scope's
        // verdict rather than leaving it standing.
        if value.is_some_and(|value| value.eq_ignore_ascii_case("auto")) {
            flags.remove(name);
            continue;
        }
        let Some(binary) = git_config_bool(value) else {
            continue;
        };
        // `--get-regexp` lists matches in git's own read order and `--get` documents
        // taking the last one, so overwriting leaves the value git itself would use.
        flags.insert(name.to_string(), binary);
    }
    Some(flags)
}

/// Every `diff.<driver>.binary` the repo configures. `None` = the probe FAILED (spawn,
/// timeout, or an exit this cannot read as an answer) and the caller blanks the whole
/// untracked lane; exit 1 is git's "no match" and answers with an empty map. Read
/// through the raw runner because `run_git` folds every non-zero exit into one error,
/// which would make the expected no-match indistinguishable from a real failure.
async fn diff_driver_binary_flags(
    repo_path: &str,
) -> Option<std::collections::HashMap<String, bool>> {
    let out = run_git_raw(
        Some(repo_path),
        &["config", "-z", "--get-regexp", r"^diff\..*\.binary$"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    match out.code {
        0 => parse_diff_driver_binary(&out.stdout_lossy()),
        1 => Some(std::collections::HashMap::new()),
        _ => None,
    }
}

/// Parses `git config -z --name-only --get-regexp` output: NUL-separated KEYS with no
/// values. A `filter.<driver>.clean`/`.process` key is what makes a `filter` attribute
/// value name a real driver; `<driver>` is everything between the prefix and the
/// suffix, so a dotted driver name survives intact. `None` = a key outside the queried
/// pattern, which means the stream is not the shape this asked for — a probe FAILURE,
/// not an empty answer. An EMPTY driver name is not that case: `[filter ""]` is legal
/// config and canonicalizes to an in-pattern key, so it skips its own entry and leaves
/// the rest of the stream readable.
fn parse_configured_filters(text: &str) -> Option<std::collections::HashSet<String>> {
    let mut names = std::collections::HashSet::new();
    for key in text.split('\0').filter(|k| !k.is_empty()) {
        // An off-pattern key means the stream is not what this asked for.
        let name = key.strip_prefix("filter.").and_then(|rest| {
            rest.strip_suffix(".clean")
                .or_else(|| rest.strip_suffix(".process"))
        })?;
        // An empty subsection names no driver any `filter` attribute value could
        // reference — check-attr never answers with an empty string.
        if name.is_empty() {
            continue;
        }
        names.insert(name.to_string());
    }
    Some(names)
}

/// The filter drivers the repo actually configures. `None` = the probe FAILED and the
/// caller blanks the whole untracked lane; exit 1 is git's "no match" and answers with
/// an empty set. Raw runner for the same reason as [`diff_driver_binary_flags`].
async fn configured_filter_drivers(repo_path: &str) -> Option<std::collections::HashSet<String>> {
    let out = run_git_raw(
        Some(repo_path),
        &[
            "config",
            "-z",
            "--name-only",
            "--get-regexp",
            r"^filter\..*\.(clean|process)$",
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    match out.code {
        0 => parse_configured_filters(&out.stdout_lossy()),
        1 => Some(std::collections::HashSet::new()),
        _ => None,
    }
}

/// What `.gitattributes` says about one untracked path. The default — no `diff`
/// verdict, no conversion — is what a path no rule names carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct PathAttrs {
    diff: Option<DiffAttr>,
    /// What git stores is a CONVERSION of the worktree bytes, so any count taken from
    /// them is another file's: a `working-tree-encoding`, or a `filter` naming a driver
    /// the repo configures.
    converts: bool,
}

/// The attributes requested per path, in the order [`untracked_attr_output`] asks for
/// them; `check-attr` answers one triple per attribute per path.
const REQUESTED_ATTRS: [&str; 3] = ["diff", "working-tree-encoding", "filter"];

/// Parses `check-attr -z` output: `path NUL attr NUL value NUL` triples, one per
/// requested attribute per path. `None` = the stream does not divide into whole
/// triples, a shape this cannot read, which is a probe FAILURE — the caller blanks the
/// lane rather than letting sniff verdicts stand in for git's. An empty map is a
/// legitimate answer (every triple `unspecified`). `drivers` resolves a value that
/// names a custom diff driver and `filters` a value that names a content filter; one
/// the repo does not configure stays unresolved, since only git knows what running it
/// would decide.
fn parse_path_attrs(
    text: &str,
    drivers: &std::collections::HashMap<String, bool>,
    filters: &std::collections::HashSet<String>,
) -> Option<std::collections::HashMap<String, PathAttrs>> {
    let mut tokens: Vec<&str> = text.split('\0').collect();
    // `-z` terminates every token, so the split's last element is empty.
    if tokens.last() == Some(&"") {
        tokens.pop();
    }
    let mut attrs: std::collections::HashMap<String, PathAttrs> = std::collections::HashMap::new();
    if !tokens.len().is_multiple_of(3) {
        return None;
    }
    for record in tokens.as_chunks::<3>().0 {
        let (path, attr, value) = (record[0], record[1], record[2]);
        match attr {
            "diff" => {
                let verdict = match value {
                    "unset" => DiffAttr::Binary,
                    "set" => DiffAttr::ForcedText,
                    "unspecified" => continue,
                    driver => match drivers.get(driver) {
                        Some(true) => DiffAttr::Binary,
                        Some(false) => DiffAttr::ForcedText,
                        None => continue,
                    },
                };
                attrs.entry(path.to_string()).or_default().diff = Some(verdict);
            }
            // git dies on a valueless `working-tree-encoding`, so blanking the row is
            // strictly gentler than what it does; any value at all converts.
            "working-tree-encoding" if value != "unspecified" && value != "unset" => {
                attrs.entry(path.to_string()).or_default().converts = true;
            }
            // A `filter` converts only when it names a driver the repo CONFIGURES: git
            // resolves the name to `filter.<name>.clean`/`.process`, and an unknown one
            // (or a valueless `set`, which names nothing) stores the bytes verbatim.
            // check-attr's reserved answers are excluded first, since a repo may also
            // configure a driver literally called `set` or `unspecified`.
            "filter"
                if value != "unspecified"
                    && value != "unset"
                    && value != "set"
                    && filters.contains(value) =>
            {
                attrs.entry(path.to_string()).or_default().converts = true;
            }
            _ => {}
        }
    }
    Some(attrs)
}

/// `check-attr`'s raw `-z` stream for every enumerated path, in one batched spawn.
/// `None` = the probe FAILED — `check-attr` has no expected non-zero exit, so `run_git`
/// folding spawn, timeout and non-zero alike into one error is exactly the distinction
/// this needs.
async fn untracked_attr_output(repo_path: &str, paths: &[&str]) -> Option<String> {
    if paths.is_empty() {
        return Some(String::new());
    }
    let stdin: String = paths.iter().map(|p| format!("{p}\0")).collect();
    let mut args = vec!["check-attr", "--stdin", "-z"];
    args.extend(REQUESTED_ATTRS);
    crate::git::runner::run_git_input(Some(repo_path), &args, Some(&stdin), DEFAULT_TIMEOUT)
        .await
        .ok()
        .map(|out| out.stdout_lossy())
}

/// What one untracked file's read produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadOutcome {
    /// Every line of a text file, all of them additions.
    Counted { added: u32 },
    /// A NUL inside the sniff window: the zero-count shape a `-` numstat row takes.
    Binary,
    /// The byte cap was reached with the file unfinished; the count would be partial,
    /// so the caller emits nothing.
    Incomplete,
}

/// The repo's effective `core.bigFileThreshold`. `--type=int` normalizes the `k`/`m`/`g`
/// suffixes a user may have written and `--default` answers for an unset key. `None` =
/// the probe FAILED: `--default` means an empty or unparsable answer is not something
/// git should ever produce here, so reading one is a malformed result rather than a
/// reason to fall back to the default.
async fn untracked_big_file_threshold(repo_path: &str) -> Option<u64> {
    let default = BIG_FILE_BYTES_DEFAULT.to_string();
    run_git(
        Some(repo_path),
        &[
            "config",
            "--get",
            "--type=int",
            "--default",
            &default,
            "core.bigFileThreshold",
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|out| out.stdout_lossy().trim().parse::<u64>().ok())
}

/// Counts `\n` bytes through a bounded buffer, plus the final unterminated line.
/// The bytes are counted raw — numstat reports the worktree's own line endings, so a
/// CRLF file still has one `\n` per line and nothing is converted here. With `sniff`
/// on, a NUL inside the sniff window answers binary straight away, the shape a `-`
/// numstat row takes; a path forced to text by `.gitattributes` passes `false`, since
/// numstat counts its lines regardless.
///
/// `max_bytes` is a HARD cap, enforced per read: a file that grew since its size
/// check cannot read past it, and reaching it with bytes left over is `Incomplete`
/// rather than a truncated count. The consumed count rides alongside EVERY outcome,
/// including the I/O error, so the caller's budget is charged for work that happened.
fn count_untracked_lines(
    file: &mut std::fs::File,
    buf: &mut [u8],
    sniff: bool,
    max_bytes: u64,
) -> (std::io::Result<ReadOutcome>, u64) {
    use std::io::Read;

    let mut sniff_left = if sniff { BINARY_SNIFF_BYTES } else { 0 };
    let mut lines: u32 = 0;
    let mut last: Option<u8> = None;
    let mut consumed: u64 = 0;
    while consumed < max_bytes {
        let room = usize::try_from(max_bytes - consumed)
            .unwrap_or(usize::MAX)
            .min(buf.len());
        let read = match file.read(&mut buf[..room]) {
            Ok(read) => read,
            Err(err) => return (Err(err), consumed),
        };
        if read == 0 {
            return (Ok(counted(lines, last)), consumed);
        }
        consumed = consumed.saturating_add(read as u64);
        let chunk = &buf[..read];
        if sniff_left > 0 {
            let window = &chunk[..read.min(sniff_left)];
            if window.contains(&0) {
                return (Ok(ReadOutcome::Binary), consumed);
            }
            sniff_left -= window.len();
        }
        let newlines = chunk.iter().filter(|b| **b == b'\n').count();
        lines = lines.saturating_add(u32::try_from(newlines).unwrap_or(u32::MAX));
        last = chunk.last().copied();
    }
    // At the cap: whether the file ended here is a question `fstat` answers without
    // spending a byte, so the cap stays exact even when the file fits it precisely.
    match file.metadata() {
        Ok(meta) if consumed >= meta.len() => (Ok(counted(lines, last)), consumed),
        Ok(_) => (Ok(ReadOutcome::Incomplete), consumed),
        Err(err) => (Err(err), consumed),
    }
}

/// numstat counts a final unterminated line, so content not ending in `\n` gets one
/// more than it has `\n` bytes.
fn counted(lines: u32, last: Option<u8>) -> ReadOutcome {
    ReadOutcome::Counted {
        added: if last.is_some_and(|b| b != b'\n') {
            lines.saturating_add(1)
        } else {
            lines
        },
    }
}

/// Line counts for the untracked paths `git ls-files --others -z` named, as
/// unstaged entries whose every line is an addition — the shape numstat reports
/// for the same file once it is staged. Blocking reads, so callers run it off the
/// async workers. Anything that is not a readable regular file is skipped instead
/// of followed (a directory is a nested repo; a symlink must not be read through),
/// as is any file whose read fails — a path deleted or locked mid-poll keeps the
/// blank slot rather than failing the whole command.
///
/// `budget` is the bytes this call may still read; only a file whose size fits what
/// is left is opened, so no count is ever truncated, and a file too big for the
/// remainder is skipped ALONE — later, smaller files still get their counts.
/// `attrs` carries the `.gitattributes` verdicts: the diff attribute, which outranks
/// the sniff once a driver name has resolved through its config, and the conversion
/// flag, which keeps a path git would re-encode or filter at the blank slot.
/// `big_file_bytes` is the repo's effective `core.bigFileThreshold`.
fn untracked_line_stats(
    repo_path: &str,
    ls_files_z: &str,
    mut budget: u64,
    big_file_bytes: u64,
    attrs: &std::collections::HashMap<String, PathAttrs>,
) -> Vec<DiffStatEntry> {
    let root = std::path::Path::new(repo_path);
    let mut buf = vec![0u8; LINE_COUNT_CHUNK];
    let mut entries = Vec::new();

    for rel in ls_files_z.split('\0').filter(|p| !p.is_empty()) {
        if budget == 0 {
            break;
        }
        let entry = |added: u32, is_binary: bool| DiffStatEntry {
            path: rel.to_string(),
            added,
            deleted: 0,
            is_binary,
        };
        let path = root.join(rel);
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let path_attrs = attrs.get(rel).copied().unwrap_or_default();
        // `-diff` is the first content decision: numstat answers `-  -` from the
        // attribute alone, even for an empty file or one a filter would rewrite, so
        // neither a read nor a budget charge happens.
        let sniff = match path_attrs.diff {
            Some(DiffAttr::Binary) => {
                entries.push(entry(0, true));
                continue;
            }
            Some(DiffAttr::ForcedText) => false,
            None => true,
        };
        // Content-affecting attributes split two ways. Count-CHANGING ones (`filter`,
        // `working-tree-encoding`) make git store a conversion of these bytes, so any
        // count taken here would be a different file's and the row stays blank.
        // Count-NEUTRAL ones (`text`/`eol`/`ident`) preserve line counts — CRLF→LF and
        // ident expansion rewrite bytes within a line — so the raw count already
        // matches and nothing is needed for them.
        if path_attrs.converts {
            continue;
        }
        let len = meta.len();
        if len == 0 {
            // git numstat reports `0 0` for an empty file once staged.
            entries.push(entry(0, false));
            continue;
        }
        // The threshold governs UNSPECIFIED paths only: numstat counts a forced-text
        // file's lines however big it is, and only an unmarked file past the threshold
        // reports `-  -`. An oversized forced-text file is bounded by the read budget.
        if sniff && len > big_file_bytes {
            entries.push(entry(0, true));
            continue;
        }
        if len > budget {
            continue;
        }
        let Ok(mut file) = std::fs::File::open(&path) else {
            continue;
        };
        let (outcome, consumed) = count_untracked_lines(&mut file, &mut buf, sniff, budget);
        // Charged whatever the outcome: a refused or failed read still spent the I/O.
        budget = budget.saturating_sub(consumed);
        match outcome {
            Ok(ReadOutcome::Counted { added }) => entries.push(entry(added, false)),
            Ok(ReadOutcome::Binary) => entries.push(entry(0, true)),
            // A partial read and a failed one both leave the row blank rather than
            // report a count the file does not have.
            Ok(ReadOutcome::Incomplete) | Err(_) => {}
        }
    }
    entries
}

/// Line counts for the Changes panel's file rows, split by side so a file that
/// is BOTH staged and re-edited reports each row's own numbers (never one
/// shared or summed count). Read-only and lock-free like `status_core`, so it
/// can ride the same 5s poll. Untracked paths join the unstaged side with every
/// line counted as an addition, read from the worktree because numstat reports
/// tracked changes alone; their text-or-binary verdict comes from the path's
/// `.gitattributes` diff attribute, with a custom driver name resolved through its
/// `diff.<name>.binary` config and a content sniff as the fallback, so a row agrees
/// with the diff pane git renders for the same file. A path git converts on the way in
/// (`working-tree-encoding`, or a `filter` naming a configured driver) keeps the blank
/// slot, since counting the unconverted bytes would report a different file's lines.
#[tauri::command]
pub async fn git_working_line_stats(repo_path: String) -> AppResult<WorkingLineStats> {
    let (staged, unstaged, untracked) = tokio::try_join!(
        run_git(
            Some(&repo_path),
            &["diff", "--cached", "--numstat", "-z"],
            DEFAULT_TIMEOUT,
        ),
        run_git(
            Some(&repo_path),
            &["diff", "--numstat", "-z"],
            DEFAULT_TIMEOUT,
        ),
        // Enumerating untracked paths is the one arm allowed to fail: an error or a
        // timeout here degrades to blank untracked slots, while a numstat failure is
        // still an error, since blanking every tracked count is the worse answer.
        // `ls-files` names paths relative to the CWD, so `repo_path` must be the
        // worktree toplevel — `validate_repo` resolves it — or the entries mis-key.
        async {
            Ok::<String, AppError>(
                run_git(
                    Some(&repo_path),
                    &["ls-files", "--others", "--exclude-standard", "-z"],
                    DEFAULT_TIMEOUT,
                )
                .await
                .map(|out| out.stdout_lossy())
                .unwrap_or_default(),
            )
        }
    )?;
    let mut unstaged_entries = parse_numstat_z(&unstaged.stdout_lossy());
    let paths: Vec<&str> = untracked.split('\0').filter(|p| !p.is_empty()).collect();
    // No probe matters without untracked paths, so an empty set spawns none of them.
    // A FAILED probe must not substitute sniff semantics for git's: every path this
    // tick keeps the blank slot it had before the feature, and the 5s poll retries.
    let resolved = if paths.is_empty() {
        Some((std::collections::HashMap::new(), BIG_FILE_BYTES_DEFAULT))
    } else {
        let (attr_output, big_file_bytes, drivers, filters) = tokio::join!(
            untracked_attr_output(&repo_path, &paths),
            untracked_big_file_threshold(&repo_path),
            diff_driver_binary_flags(&repo_path),
            configured_filter_drivers(&repo_path)
        );
        match (attr_output, big_file_bytes, drivers, filters) {
            (Some(attr_output), Some(big_file_bytes), Some(drivers), Some(filters)) => {
                parse_path_attrs(&attr_output, &drivers, &filters)
                    .map(|attrs| (attrs, big_file_bytes))
            }
            _ => None,
        }
    };
    if let Some((attrs, big_file_bytes)) = resolved {
        // Counting lines is blocking file I/O, kept off the async workers this poll
        // shares with every other repo operation.
        let untracked_entries = tauri::async_runtime::spawn_blocking(move || {
            untracked_line_stats(
                &repo_path,
                &untracked,
                UNTRACKED_READ_BUDGET,
                big_file_bytes,
                &attrs,
            )
        })
        .await
        .unwrap_or_default();
        unstaged_entries.extend(untracked_entries);
    }
    Ok(WorkingLineStats {
        staged: parse_numstat_z(&staged.stdout_lossy()),
        unstaged: unstaged_entries,
    })
}

pub fn truncate_at_char_boundary(text: String, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// Truncates a multi-file diff at a `diff --git` boundary so no file is cut
/// mid-hunk; falls back to a char-boundary cut for a single oversized file.
fn truncate_at_file_boundary(text: String, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut kept_end = 0;
    let mut search_from = 0;
    loop {
        let next = if search_from == 0 && text.starts_with("diff --git ") {
            Some(0)
        } else {
            text[search_from..]
                .find("\ndiff --git ")
                .map(|i| search_from + i + 1)
        };
        match next {
            Some(start) if start <= max => {
                kept_end = start;
                search_from = start + 1;
            }
            _ => break,
        }
    }
    // kept_end is the start of the first file section that crosses the budget;
    // keep everything before it. If even the first file is too big, hard-cut.
    if kept_end == 0 {
        return truncate_at_char_boundary(text, max);
    }
    (text[..kept_end].trim_end().to_string(), true)
}

/// One `--numstat -z` row together with EVERY path it names — one for a regular
/// change, both sides for a rename.
///
/// The AI-ignore filter reads names through this struct's BYTE twin
/// (`ai_ignore::parse_numstat_z_rows_bytes`); `names` here is read only by the
/// equivalence pin that holds the two parsers to one grammar — hence test-scoped.
/// Both carry EVERY side of a rename: excluding one side would leave the other
/// half of the change (an `A` or `D` row) in the diff, so a match on either name
/// has to hide the pair.
pub(crate) struct DiffStatRow {
    pub entry: DiffStatEntry,
    #[cfg_attr(not(test), allow(dead_code))]
    pub names: Vec<String>,
}

/// Parses `git diff --numstat -z` output.
/// Regular entry: `added\tdeleted\tpath\0`.
/// Rename entry:  `added\tdeleted\t\0oldpath\0newpath\0`.
/// Binary files report `-` for both counts.
pub fn parse_numstat_z(text: &str) -> Vec<DiffStatEntry> {
    parse_numstat_z_rows(text)
        .into_iter()
        .map(|row| row.entry)
        .collect()
}

/// [`parse_numstat_z`] keeping both sides of a rename (see [`DiffStatRow`]).
pub(crate) fn parse_numstat_z_rows(text: &str) -> Vec<DiffStatRow> {
    let mut rows = Vec::new();
    let mut tokens = text.split('\0');
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        let mut fields = token.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let is_binary = added == "-";
        let added = added.parse().unwrap_or(0);
        let deleted = deleted.parse().unwrap_or(0);
        let (path, names) = if path.is_empty() {
            // rename: old path, then new path — the entry reports the new one.
            let old = tokens.next().unwrap_or("");
            match tokens.next() {
                Some(new_path) if !new_path.is_empty() => (
                    new_path.to_string(),
                    [old, new_path]
                        .iter()
                        .filter(|n| !n.is_empty())
                        .map(|n| n.to_string())
                        .collect(),
                ),
                _ => continue,
            }
        } else {
            (path.to_string(), vec![path.to_string()])
        };
        rows.push(DiffStatRow {
            entry: DiffStatEntry {
                path,
                added,
                deleted,
                is_binary,
            },
            names,
        });
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_sniff::{jpeg_fixture, png_fixture, stuffed_pair_jpeg};

    #[test]
    fn parses_numstat_with_rename_and_binary() {
        let text = "3\t1\tapp.js\0-\t-\tbinary.bin\x000\t0\t\0util.js\0helpers.js\0";
        let entries = parse_numstat_z(text);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "app.js");
        assert_eq!(entries[0].added, 3);
        assert_eq!(entries[0].deleted, 1);
        assert!(entries[1].is_binary);
        assert_eq!(entries[1].path, "binary.bin");
        assert_eq!(entries[2].path, "helpers.js");
    }

    #[test]
    fn truncates_multi_file_diff_at_file_boundary() {
        let file_a = format!("diff --git a/a b/a\n{}\n", "+a\n".repeat(10));
        let file_b = format!("diff --git a/b b/b\n{}\n", "+b\n".repeat(10));
        let text = format!("{file_a}{file_b}");
        let (out, truncated) = truncate_at_file_boundary(text, file_a.len() + 5);
        assert!(truncated);
        assert!(out.starts_with("diff --git a/a"));
        assert!(!out.contains("diff --git a/b"));
    }

    #[test]
    fn small_diff_not_truncated() {
        let (out, truncated) = truncate_at_file_boundary("diff --git a/a b/a\n+x\n".into(), 1000);
        assert!(!truncated);
        assert!(out.contains("+x"));
    }

    /// `exclude` filters the staged diff with real gitignore semantics (via
    /// `git::ai_ignore`): a bare name hides every copy at any depth, a leading
    /// `/` anchors to the repo root, and `excluded_files` counts what was hidden.
    #[tokio::test]
    async fn staged_diff_applies_gitignore_style_excludes() {
        let _tmp = tempfile::Builder::new()
            .prefix("gd-staged-exclude-test-")
            .tempdir()
            .expect("create temp dir");
        let dir = _tmp.path().to_path_buf();
        let repo = dir.to_string_lossy().into_owned();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@t.local"],
            vec!["config", "user.name", "T"],
        ] {
            run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap();
        }
        std::fs::write(dir.join("seed.txt"), "seed\n").unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(Some(&repo), &["commit", "-qm", "seed"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        // Two copies of the same file name, one nested, plus an unrelated file.
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("notes.md"), "root\n").unwrap();
        std::fs::write(dir.join("docs").join("notes.md"), "nested\n").unwrap();
        std::fs::write(dir.join("app.rs"), "fn main() {}\n").unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        // No excludes → everything staged is present, nothing reported hidden.
        let all = git_staged_diff(repo.clone(), None, None, None).await.unwrap();
        assert_eq!(all.files.len(), 3);
        assert_eq!(all.excluded_files, 0);

        // A bare name hides BOTH copies — gitignore matches at any depth.
        let bare = git_staged_diff(repo.clone(), None, Some(vec!["notes.md".into()]), None)
            .await
            .unwrap();
        assert_eq!(bare.files.len(), 1);
        assert!(bare.files.iter().any(|f| f.path == "app.rs"));
        assert!(
            !bare.text.contains("docs/notes.md"),
            "the nested copy is hidden too"
        );
        assert_eq!(bare.excluded_files, 2);

        // A leading `/` anchors to the root, sparing the nested copy — and does
        // NOT wipe the whole diff (it used to read as an absolute path).
        let anchored = git_staged_diff(repo.clone(), None, Some(vec!["/notes.md".into()]), None)
            .await
            .unwrap();
        assert_eq!(anchored.files.len(), 2);
        assert!(
            anchored.files.iter().any(|f| f.path == "docs/notes.md"),
            "an anchored pattern spares the nested copy"
        );
        assert!(!anchored.files.iter().any(|f| f.path == "notes.md"));
        assert_eq!(anchored.excluded_files, 1);

        // Blank / `#` lines translate to no pathspec at all — same as no excludes.
        let noop = git_staged_diff(
            repo,
            None,
            Some(vec!["  ".into(), "# comment".into()]),
            None,
        )
        .await
        .unwrap();
        assert_eq!(noop.files.len(), 3);
        assert_eq!(noop.excluded_files, 0);
    }

    /// Sets up a temp git repo with a deterministic identity. These tests count LINES
    /// and read ignore/attribute verdicts, so every source outside the fixture is shut
    /// off: `core.autocrlf` pinned, `core.excludesFile` and `core.attributesFile`
    /// emptied, and `.git/info/exclude` + `.git/info/attributes` truncated.
    async fn init_line_stats_repo(prefix: &str) -> (tempfile::TempDir, std::path::PathBuf, String) {
        let tmp = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir()
            .expect("create temp dir");
        let dir = tmp.path().to_path_buf();
        let repo = dir.to_string_lossy().into_owned();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@t.local"],
            vec!["config", "user.name", "T"],
            vec!["config", "core.autocrlf", "false"],
            vec!["config", "core.excludesFile", ""],
            vec!["config", "core.attributesFile", ""],
        ] {
            run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap();
        }
        // An `init.templateDir` can seed both of these into every `git init`: rules in
        // `info/exclude` would join `--exclude-standard`, and `info/attributes`
        // OUTRANKS the in-tree `.gitattributes` this fixture writes, so a developer's
        // template would decide these tests. Truncating leaves the fixture's own rules.
        let info = dir.join(".git").join("info");
        std::fs::create_dir_all(&info).unwrap();
        std::fs::write(info.join("exclude"), "").unwrap();
        std::fs::write(info.join("attributes"), "").unwrap();
        (tmp, dir, repo)
    }

    /// The feature's real contract: an untracked row must already say what numstat
    /// will say about the same file once it is staged. Stages the named paths, then
    /// compares each one's staged row with the entry captured while it was untracked.
    /// `core.autocrlf` is pinned in the fixture, so staging shifts nothing. Staging is
    /// SCOPED to those names so a test can leave a path unstaged on purpose — a
    /// converted one whose filter or encoder must not run here.
    async fn assert_untracked_matches_staged(
        repo: &str,
        untracked: &[DiffStatEntry],
        names: &[&str],
    ) {
        let mut args = vec!["add", "-A", "--"];
        args.extend(names);
        run_git(Some(repo), &args, DEFAULT_TIMEOUT).await.unwrap();
        let staged = run_git(
            Some(repo),
            &["diff", "--cached", "--numstat", "-z"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy();
        let rows = parse_numstat_z(&staged);
        for name in names {
            let row = rows
                .iter()
                .find(|e| e.path == *name)
                .unwrap_or_else(|| panic!("{name} has a staged numstat row"));
            let entry = untracked
                .iter()
                .find(|e| e.path == *name)
                .unwrap_or_else(|| panic!("{name} was counted while untracked"));
            assert_eq!(
                (entry.added, entry.deleted, entry.is_binary),
                (row.added, row.deleted, row.is_binary),
                "{name}: the untracked row must match staged numstat"
            );
        }
    }

    /// The panel's core invariant: a file that is staged AND re-edited reports
    /// DIFFERENT counts per side — staged is index vs HEAD, unstaged is working
    /// tree vs index. An untracked file rides the unstaged side alone, every
    /// line an addition.
    #[tokio::test]
    async fn working_line_stats_splits_sides_and_counts_untracked() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-test-").await;

        std::fs::write(dir.join("file.txt"), "a\nb\nc\n").unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(Some(&repo), &["commit", "-qm", "seed"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        // Stage a 2-line append (index vs HEAD = +2 -0)...
        std::fs::write(dir.join("file.txt"), "a\nb\nc\nd\ne\n").unwrap();
        run_git(Some(&repo), &["add", "file.txt"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        // ...then edit further in the worktree (worktree vs index = +3 -1).
        std::fs::write(dir.join("file.txt"), "a\nb\nc\nd\nE\nf\ng\n").unwrap();
        std::fs::write(dir.join("untracked.txt"), "x\ny\n").unwrap();

        let stats = git_working_line_stats(repo).await.unwrap();

        let staged = stats
            .staged
            .iter()
            .find(|e| e.path == "file.txt")
            .expect("staged side reports the file");
        assert_eq!((staged.added, staged.deleted), (2, 0));
        let unstaged = stats
            .unstaged
            .iter()
            .find(|e| e.path == "file.txt")
            .expect("unstaged side reports the file");
        assert_eq!((unstaged.added, unstaged.deleted), (3, 1));

        let untracked = stats
            .unstaged
            .iter()
            .find(|e| e.path == "untracked.txt")
            .expect("the unstaged side counts the untracked file");
        assert_eq!((untracked.added, untracked.deleted), (2, 0));
        assert!(!untracked.is_binary);
        assert!(
            !stats.staged.iter().any(|e| e.path == "untracked.txt"),
            "nothing untracked belongs on the staged side"
        );
    }

    /// A NUL in the sniff window makes the entry read `bin` in the panel — the
    /// exact shape numstat's `-\t-` row parses to.
    #[tokio::test]
    async fn working_line_stats_reports_untracked_binary() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-binary-test-").await;

        std::fs::write(dir.join("blob.bin"), b"PNG\x00\x01\x02rest\nof it\n").unwrap();

        let stats = git_working_line_stats(repo.clone()).await.unwrap();
        let entry = stats
            .unstaged
            .iter()
            .find(|e| e.path == "blob.bin")
            .expect("the binary file still gets an entry");
        assert_eq!((entry.added, entry.deleted), (0, 0));
        assert!(entry.is_binary);

        assert_untracked_matches_staged(&repo, &stats.unstaged, &["blob.bin"]).await;
    }

    /// numstat counts a final unterminated line, so a file with no trailing
    /// newline reports one more line than it has `\n` bytes. An empty file is
    /// its own case: present, with zero counts, and NOT binary.
    #[tokio::test]
    async fn working_line_stats_counts_final_line_and_empty_untracked() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-final-line-test-").await;

        std::fs::write(dir.join("unterminated.txt"), "x\ny").unwrap();
        std::fs::write(dir.join("empty.txt"), "").unwrap();

        let stats = git_working_line_stats(repo.clone()).await.unwrap();
        let unterminated = stats
            .unstaged
            .iter()
            .find(|e| e.path == "unterminated.txt")
            .expect("a file without a final newline is counted");
        assert_eq!((unterminated.added, unterminated.deleted), (2, 0));
        let empty = stats
            .unstaged
            .iter()
            .find(|e| e.path == "empty.txt")
            .expect("an empty file gets an entry of its own");
        assert_eq!((empty.added, empty.deleted), (0, 0));
        assert!(!empty.is_binary);

        assert_untracked_matches_staged(&repo, &stats.unstaged, &["unterminated.txt", "empty.txt"])
            .await;
    }

    /// The entry's path is the repo-relative, forward-slashed string `status
    /// --untracked-files=all` reports, which is how the panel's rows find it.
    #[tokio::test]
    async fn working_line_stats_reports_nested_untracked_path() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-nested-test-").await;

        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("inner.txt"), "a\nb\nc\n").unwrap();

        let stats = git_working_line_stats(repo).await.unwrap();
        let entry = stats
            .unstaged
            .iter()
            .find(|e| e.path == "sub/inner.txt")
            .expect("the nested path is reported with forward slashes");
        assert_eq!((entry.added, entry.deleted), (3, 0));
    }

    /// A `.gitattributes` diff override outranks the content sniff AND emptiness, so
    /// an untracked row agrees with the diff pane git renders for the same file:
    /// `-diff` reads `bin` on text content and on an empty file (numstat reports
    /// `-  -` for a staged one), a forced `diff` counts the lines of NUL-bearing
    /// content, and a path no rule names still sniffs (the control files, whose bytes
    /// are the same as their attribute-marked twins'). A custom driver goes by its
    /// `diff.<name>.binary` setting, and an unconfigured driver sniffs.
    #[tokio::test]
    async fn working_line_stats_honors_gitattributes_diff_overrides() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-attrs-test-").await;

        std::fs::write(
            dir.join(".gitattributes"),
            "*.dat -diff\n*.forced diff\n*.byes diff=binyes\n*.bno diff=binno\n\
             *.b2 diff=bintwo\n*.bauto diff=binauto\n*.plain diff=plaindrv\n",
        )
        .unwrap();
        // `yes` and `2` rather than `true` so the parity assertions hold the bool parse
        // to git's whole alphabet, named and integer; `binauto` pins the tristate's
        // third value; `plaindrv` deliberately gets no `binary` setting, since an
        // unconfigured driver is the arm that must sniff.
        for args in [
            vec!["config", "diff.binyes.binary", "yes"],
            vec!["config", "diff.binno.binary", "false"],
            vec!["config", "diff.bintwo.binary", "2"],
            vec!["config", "diff.binauto.binary", "true"],
            // Repeated key, `true` then `auto`: the stream carries both, and the later
            // one has to clear the earlier verdict the way git's own last-match read
            // does. A lone `auto` would pass whether or not it clears anything.
            vec!["config", "--add", "diff.binauto.binary", "auto"],
        ] {
            run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap();
        }
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(
            Some(&repo),
            &["commit", "-qm", "attributes"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();

        std::fs::write(dir.join("text.dat"), "a\nb\nc\n").unwrap();
        std::fs::write(dir.join("empty.dat"), "").unwrap();
        std::fs::write(dir.join("bin.forced"), b"a\0b\nc\n").unwrap();
        std::fs::write(dir.join("plain.txt"), "a\nb\nc\n").unwrap();
        std::fs::write(dir.join("plain.bin"), b"a\0b\nc\n").unwrap();
        std::fs::write(dir.join("clean.byes"), "a\nb\n").unwrap();
        std::fs::write(dir.join("binfile.bno"), b"a\0b\nc\n").unwrap();
        std::fs::write(dir.join("clean.b2"), "a\nb\n").unwrap();
        std::fs::write(dir.join("clean.bauto"), "a\nb\n").unwrap();
        std::fs::write(dir.join("clean.plain"), "a\nb\n").unwrap();

        let stats = git_working_line_stats(repo.clone()).await.unwrap();
        let seen = |name: &str| {
            let e = stats
                .unstaged
                .iter()
                .find(|e| e.path == name)
                .unwrap_or_else(|| panic!("{name} is counted"));
            (e.added, e.deleted, e.is_binary)
        };
        assert_eq!(seen("text.dat"), (0, 0, true), "`-diff` beats text content");
        assert_eq!(seen("empty.dat"), (0, 0, true), "`-diff` beats emptiness");
        assert_eq!(
            seen("bin.forced"),
            (2, 0, false),
            "a forced `diff` beats a NUL"
        );
        assert_eq!(seen("plain.txt"), (3, 0, false));
        assert_eq!(seen("plain.bin"), (0, 0, true));
        assert_eq!(
            seen("clean.byes"),
            (0, 0, true),
            "a driver's `binary = true` beats clean content"
        );
        assert_eq!(
            seen("binfile.bno"),
            (2, 0, false),
            "a driver's `binary = false` beats a NUL"
        );
        assert_eq!(
            seen("clean.b2"),
            (0, 0, true),
            "a driver's integer `binary = 2` is true like any non-zero"
        );
        assert_eq!(
            seen("clean.bauto"),
            (2, 0, false),
            "a driver's `binary = auto` asks for the content decision"
        );
        assert_eq!(
            seen("clean.plain"),
            (2, 0, false),
            "an unconfigured driver leaves the sniff in charge"
        );

        assert_untracked_matches_staged(
            &repo,
            &stats.unstaged,
            &[
                "text.dat",
                "empty.dat",
                "bin.forced",
                "plain.txt",
                "plain.bin",
                "clean.byes",
                "binfile.bno",
                "clean.b2",
                "clean.bauto",
                "clean.plain",
            ],
        )
        .await;
    }

    /// A path whose content git CONVERTS on the way in — `working-tree-encoding` or a
    /// `filter` — keeps the blank slot: the poll refuses to run conversions (arbitrary
    /// user commands from a read-only 5s poll), and counting the unconverted worktree
    /// bytes would report a different file's lines. `-diff` still wins over that,
    /// since its `(0, 0, bin)` comes from the attribute without reading content.
    #[tokio::test]
    async fn working_line_stats_blanks_converted_paths() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-convert-test-").await;

        std::fs::write(
            dir.join(".gitattributes"),
            "*.u16 working-tree-encoding=UTF-16\n*.lfs filter=fake\n*.lfs2 filter=ghost\n\
             both.dat -diff filter=fake\n",
        )
        .unwrap();
        // `fake` is configured, so git would resolve and run it; `ghost` is named by an
        // attribute but configured nowhere, which is why its path still counts. The
        // clean command never runs here — the blanked paths are never staged.
        run_git(
            Some(&repo),
            &["config", "filter.fake.clean", "cat"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(
            Some(&repo),
            &["commit", "-qm", "attributes"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();

        // UTF-16LE with a BOM: NUL-interleaved, so the content sniff would call it
        // binary while numstat counts the lines of git's UTF-8 conversion.
        let mut utf16 = vec![0xFF, 0xFE];
        for byte in "alpha\nbeta\ngamma\n".bytes() {
            utf16.push(byte);
            utf16.push(0);
        }
        std::fs::write(dir.join("doc.u16"), &utf16).unwrap();
        std::fs::write(dir.join("data.lfs"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("loose.lfs2"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("both.dat"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("plain.txt"), "one\ntwo\n").unwrap();

        let stats = git_working_line_stats(repo.clone()).await.unwrap();
        let found = |name: &str| stats.unstaged.iter().find(|e| e.path == name);
        assert!(
            found("doc.u16").is_none(),
            "an encoded path keeps its blank slot, got {:?}",
            found("doc.u16")
        );
        assert!(
            found("data.lfs").is_none(),
            "a filtered path keeps its blank slot, got {:?}",
            found("data.lfs")
        );
        let both = found("both.dat").expect("`-diff` answers without reading content");
        assert_eq!(
            (both.added, both.deleted, both.is_binary),
            (0, 0, true),
            "`-diff` outranks the conversion blank"
        );
        let loose = found("loose.lfs2").expect("an unconfigured filter name converts nothing");
        assert_eq!((loose.added, loose.deleted, loose.is_binary), (2, 0, false));
        let plain = found("plain.txt").expect("the control file is still counted");
        assert_eq!((plain.added, plain.deleted), (2, 0));

        // Staging `loose.lfs2` succeeds and stores the bytes verbatim precisely because
        // no driver answers to `ghost`; the blanked paths stay out of this call.
        assert_untracked_matches_staged(&repo, &stats.unstaged, &["loose.lfs2", "plain.txt"]).await;
    }

    /// The reader's hard cap. A file bigger than the cap stops at exactly the cap and
    /// answers `Incomplete` — never a truncated count — while a cap the file fits
    /// under, INCLUDING one equal to its size, reads it whole. The consumed count is
    /// what the caller charges, so it must be exact in both directions.
    #[test]
    fn count_untracked_lines_stops_at_its_byte_cap() {
        let tmp = tempfile::Builder::new()
            .prefix("gd-line-cap-test-")
            .tempdir()
            .expect("create temp dir");
        let path = tmp.path().join("grown.txt");
        std::fs::write(&path, "a\nb\nc\nd\n").unwrap();
        let mut buf = vec![0u8; LINE_COUNT_CHUNK];

        let mut file = std::fs::File::open(&path).unwrap();
        let (outcome, consumed) = count_untracked_lines(&mut file, &mut buf, true, 5);
        assert_eq!(consumed, 5, "the cap is exact, not a buffer boundary");
        assert_eq!(outcome.unwrap(), ReadOutcome::Incomplete);

        // A cap AT the file's size is not a partial read — the file ends there.
        for cap in [8, 64] {
            let mut file = std::fs::File::open(&path).unwrap();
            let (outcome, consumed) = count_untracked_lines(&mut file, &mut buf, true, cap);
            assert_eq!(consumed, 8, "cap {cap} reads the whole 8-byte file");
            assert_eq!(outcome.unwrap(), ReadOutcome::Counted { added: 4 });
        }
    }

    /// The `check-attr -z` grammar this depends on: whole `path NUL attr NUL value
    /// NUL` triples, one per REQUESTED attribute per path. A stream that does not
    /// divide into triples is unreadable rather than empty, so the caller blanks the
    /// untracked lane instead of verdicting half a file list.
    #[test]
    fn parses_check_attr_triples_and_refuses_a_malformed_stream() {
        let none = std::collections::HashMap::new();
        let no_filters = std::collections::HashSet::new();
        let binary = PathAttrs {
            diff: Some(DiffAttr::Binary),
            converts: false,
        };
        let forced = PathAttrs {
            diff: Some(DiffAttr::ForcedText),
            converts: false,
        };

        let valid = "a.dat\0diff\0unset\0b.forced\0diff\0set\0c.txt\0diff\0unspecified\0";
        let attrs = parse_path_attrs(valid, &none, &no_filters).expect("a whole-triple stream");
        assert_eq!(attrs.get("a.dat"), Some(&binary));
        assert_eq!(attrs.get("b.forced"), Some(&forced));
        assert_eq!(attrs.get("c.txt"), None, "`unspecified` carries no verdict");
        assert_eq!(attrs.len(), 2);

        // A driver the repo configures resolves; an unconfigured one sniffs, since
        // only running it would say what it decides.
        let drivers = std::collections::HashMap::from([
            ("binyes".to_string(), true),
            ("binno".to_string(), false),
        ]);
        let resolved = parse_path_attrs(
            "a.byes\0diff\0binyes\0b.bno\0diff\0binno\0c.png\0diff\0exif\0",
            &drivers,
            &no_filters,
        )
        .expect("a whole-triple stream");
        assert_eq!(resolved.get("a.byes"), Some(&binary));
        assert_eq!(resolved.get("b.bno"), Some(&forced));
        assert_eq!(resolved.get("c.png"), None, "an unconfigured driver sniffs");
        assert_eq!(
            parse_path_attrs("d.png\0diff\0exif\0", &none, &no_filters),
            Some(std::collections::HashMap::new()),
            "no verdicts is a legitimate answer, not a failure"
        );

        // A stream that does not divide into triples is a probe FAILURE, not an empty
        // answer: the caller blanks the lane rather than sniffing every path.
        assert_eq!(
            parse_path_attrs("a.dat\0diff\0", &none, &no_filters),
            None,
            "a partial triple is unreadable"
        );
        assert_eq!(
            parse_path_attrs("", &none, &no_filters),
            Some(std::collections::HashMap::new()),
            "an empty stream is empty, not malformed"
        );
    }

    /// All three requested attributes come back per path, so one path's triples are
    /// folded into one verdict. A `working-tree-encoding` converts on any value, while
    /// a `filter` converts only when it names a CONFIGURED driver — an unknown name, a
    /// valueless `set`, an `unset` or an `unspecified` all leave the content alone.
    #[test]
    fn folds_multi_attribute_check_attr_rows_per_path() {
        let none = std::collections::HashMap::new();
        // `set` is in the set on purpose: check-attr's reserved answers must never
        // reach the driver lookup, however a repo happens to name its drivers.
        let filters = std::collections::HashSet::from(["fake".to_string(), "set".to_string()]);
        let folded = parse_path_attrs(
            "doc.u16\0diff\0unspecified\0doc.u16\0working-tree-encoding\0UTF-16\0\
             doc.u16\0filter\0unspecified\0\
             both.dat\0diff\0unset\0both.dat\0working-tree-encoding\0unspecified\0\
             both.dat\0filter\0fake\0",
            &none,
            &filters,
        )
        .expect("a whole-triple stream");
        assert_eq!(
            folded.get("doc.u16"),
            Some(&PathAttrs {
                diff: None,
                converts: true
            }),
            "an encoding alone converts without deciding text-or-binary"
        );
        assert_eq!(
            folded.get("both.dat"),
            Some(&PathAttrs {
                diff: Some(DiffAttr::Binary),
                converts: true
            }),
            "a path's triples fold into ONE verdict"
        );
        assert_eq!(folded.len(), 2);

        let unresolved = parse_path_attrs(
            "a.lfs\0filter\0set\0b.lfs\0filter\0ghost\0",
            &none,
            &filters,
        )
        .expect("a whole-triple stream");
        assert!(
            unresolved.is_empty(),
            "a valueless filter names nothing and an unconfigured one runs nothing"
        );

        let inert = parse_path_attrs(
            "b.txt\0filter\0unset\0b.txt\0working-tree-encoding\0unspecified\0",
            &none,
            &filters,
        )
        .expect("a whole-triple stream");
        assert!(
            inert.is_empty(),
            "`-filter` and an unspecified encoding convert nothing"
        );
    }

    /// The `--name-only` key stream that says which filter drivers the repo really
    /// configures: either half of the pair counts and a dotted driver name survives
    /// whole. A key the queried pattern could not have produced means the stream is not
    /// what this asked for — a probe FAILURE, not an empty answer.
    #[test]
    fn parses_configured_filter_driver_names() {
        let names = parse_configured_filters(
            "filter.fake.clean\0filter.streamed.process\0filter.my.lfs.clean\0",
        )
        .expect("keys the queried pattern produces");
        assert!(names.contains("fake"));
        assert!(
            names.contains("streamed"),
            "`.process` configures a driver too"
        );
        assert!(
            names.contains("my.lfs"),
            "a dotted driver name is the whole middle"
        );
        assert_eq!(names.len(), 3);

        for off_pattern in [
            "filter.fake.smudge\0",
            "filter.fake.required\0",
            "core.autocrlf\0",
        ] {
            assert_eq!(
                parse_configured_filters(off_pattern),
                None,
                "{off_pattern:?} is not a key this query can return"
            );
        }

        // `[filter ""]` is legal config and canonicalizes to a key the query DOES
        // return, so it is in-pattern: it names no driver and skips its own entry
        // rather than condemning the stream.
        assert_eq!(
            parse_configured_filters("filter..clean\0"),
            Some(std::collections::HashSet::new()),
            "an empty subsection names no driver"
        );
        let beside = parse_configured_filters("filter..clean\0filter.real.clean\0")
            .expect("an empty subsection is in-pattern");
        assert_eq!(
            beside,
            std::collections::HashSet::from(["real".to_string()]),
            "a real driver beside it still resolves"
        );
        assert_eq!(
            parse_configured_filters(""),
            Some(std::collections::HashSet::new()),
            "no matches is an empty answer, not a failure"
        );
    }

    /// The `git config -z --get-regexp` grammar: NUL between entries, a newline
    /// between each key and its value, and NO newline at all for a valueless key.
    /// The value alphabet is git's own, case-insensitive — a valueless key is true, an
    /// empty value is false, and any integer goes by its zero-ness — and a dotted
    /// driver name survives whole. A junk VALUE skips its own entry; a key outside the
    /// queried pattern means the stream is unreadable, which is a probe FAILURE.
    #[test]
    fn parses_diff_driver_binary_config() {
        let read = |text: &str| parse_diff_driver_binary(text).expect("keys the query produces");
        // `1`/`0` sit in both the named alphabet and the integer rule; the two agree.
        for spelling in [
            "true", "yes", "on", "1", "TRUE", "Yes", "ON", "2", "-1", "1k",
        ] {
            let flags = read(&format!("diff.d.binary\n{spelling}\0"));
            assert_eq!(flags.get("d"), Some(&true), "{spelling} reads as true");
        }
        for spelling in ["false", "no", "off", "0", "False", "NO", "Off", "0k", "0M"] {
            let flags = read(&format!("diff.d.binary\n{spelling}\0"));
            assert_eq!(flags.get("d"), Some(&false), "{spelling} reads as false");
        }
        for spelling in ["maybe", "1.5", "k", "1kk"] {
            let flags = read(&format!("diff.d.binary\n{spelling}\0"));
            assert!(flags.is_empty(), "{spelling} is not a bool git could read");
        }
        let valueless = read("diff.dvalueless.binary\0");
        assert_eq!(
            valueless.get("dvalueless"),
            Some(&true),
            "a key with no newline at all is git's valueless true"
        );
        let empty_value = read("diff.dempty.binary\n\0");
        assert_eq!(
            empty_value.get("dempty"),
            Some(&false),
            "an empty value is git's false"
        );

        let mixed =
            read("diff.binyes.binary\nyes\0diff.binno.binary\nfalse\0diff.my.tool.binary\ntrue\0");
        assert_eq!(mixed.get("binyes"), Some(&true));
        assert_eq!(mixed.get("binno"), Some(&false));
        assert_eq!(
            mixed.get("my.tool"),
            Some(&true),
            "a dotted driver name is the whole middle"
        );
        assert_eq!(mixed.len(), 3);

        let junk = read("diff.odd.binary\nmaybe\0diff.two.binary\n2\0");
        assert_eq!(
            junk.get("two"),
            Some(&true),
            "a non-zero integer is true beside an unreadable sibling"
        );
        assert_eq!(junk.get("odd"), None, "a non-bool value carries no verdict");
        assert_eq!(junk.len(), 1);

        assert_eq!(
            parse_diff_driver_binary(""),
            Some(std::collections::HashMap::new()),
            "no matches is an empty answer, not a failure"
        );
        assert_eq!(
            parse_diff_driver_binary("core.autocrlf\nfalse\0"),
            None,
            "a key this query cannot return means the stream is unreadable"
        );

        // `auto` is the key's third value (the key is a tristate): decide by content,
        // which is the sniff. As a LATER match it clears what an earlier scope set; an
        // earlier one is simply overwritten by the later verdict.
        assert_eq!(
            read("diff.dauto.binary\nauto\0").get("dauto"),
            None,
            "`auto` alone asks for the content decision"
        );
        assert_eq!(
            read("diff.dover.binary\ntrue\0diff.dover.binary\nauto\0").get("dover"),
            None,
            "a later `auto` clears an earlier scope's verdict"
        );
        assert_eq!(
            read("diff.dover.binary\nfalse\0diff.dover.binary\nauto\0").get("dover"),
            None,
            "it clears a `false` the same way"
        );
        assert_eq!(
            read("diff.dover.binary\nauto\0diff.dover.binary\ntrue\0").get("dover"),
            Some(&true),
            "a later verdict still wins over an earlier `auto`"
        );
        assert_eq!(
            read("diff.dcase.binary\nAUTO\0").get("dcase"),
            None,
            "the tristate spelling is case-insensitive like the bools"
        );

        // `[diff ""]` is legal config and in-pattern: it names no driver and skips its
        // own entry, leaving the rest of the stream readable.
        assert_eq!(
            parse_diff_driver_binary("diff..binary\ntrue\0"),
            Some(std::collections::HashMap::new()),
            "an empty subsection names no driver"
        );
        let beside = read("diff..binary\ntrue\0diff.real.binary\ntrue\0");
        assert_eq!(
            beside,
            std::collections::HashMap::from([("real".to_string(), true)]),
            "a real driver beside it still resolves"
        );
    }

    /// The read budget, spent in `ls-files` order (which git emits sorted). A file
    /// too big for what is left is skipped ALONE — `b-oversized.txt` sits between
    /// two small files and only it loses its entry — and the budget is charged for
    /// bytes actually read, so `c-fits.txt` drives it to exactly zero and
    /// `d-after.txt` gets nothing.
    #[tokio::test]
    async fn working_line_stats_spends_its_untracked_read_budget_in_order() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-budget-test-").await;

        std::fs::write(dir.join("a-first.txt"), "x\n").unwrap();
        std::fs::write(dir.join("b-oversized.txt"), "y\n".repeat(50)).unwrap();
        std::fs::write(dir.join("c-fits.txt"), "p\nq\n").unwrap();
        std::fs::write(dir.join("d-after.txt"), "r\n").unwrap();

        let listed = run_git(
            Some(&repo),
            &["ls-files", "--others", "--exclude-standard", "-z"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy();

        // 6 bytes: a-first spends 2, b-oversized (100) cannot fit the remaining 4,
        // c-fits spends the last 4, and d-after is never opened.
        let entries = untracked_line_stats(
            &repo,
            &listed,
            6,
            BIG_FILE_BYTES_DEFAULT,
            &Default::default(),
        );
        let by_path: Vec<_> = entries.iter().map(|e| (e.path.as_str(), e.added)).collect();
        assert_eq!(by_path, vec![("a-first.txt", 1), ("c-fits.txt", 2)]);
    }

    /// The repo's own `core.bigFileThreshold` decides, not a hardcoded default: an
    /// oversized UNSPECIFIED path reads `bin` like numstat's `-  -`, while a forced
    /// `diff` attribute counts every line however big the file is. The small plain
    /// file is the control that keeps the threshold from swallowing everything.
    #[tokio::test]
    async fn working_line_stats_honors_configured_big_file_threshold() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-threshold-test-").await;
        run_git(
            Some(&repo),
            &["config", "core.bigFileThreshold", "1k"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();

        std::fs::write(dir.join(".gitattributes"), "*.forced diff\n").unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(
            Some(&repo),
            &["commit", "-qm", "attributes"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();

        let big: String = (1..=200).map(|i| format!("line {i}\n")).collect();
        assert!(
            big.len() > 1024,
            "the fixture must exceed the 1k threshold, got {}",
            big.len()
        );
        std::fs::write(dir.join("big.txt"), &big).unwrap();
        std::fs::write(dir.join("big.forced"), &big).unwrap();
        std::fs::write(dir.join("small.txt"), "a\nb\n").unwrap();

        let stats = git_working_line_stats(repo.clone()).await.unwrap();
        let seen = |name: &str| {
            let e = stats
                .unstaged
                .iter()
                .find(|e| e.path == name)
                .unwrap_or_else(|| panic!("{name} is counted"));
            (e.added, e.deleted, e.is_binary)
        };
        assert_eq!(
            seen("big.txt"),
            (0, 0, true),
            "the configured threshold governs an unspecified path"
        );
        assert_eq!(
            seen("big.forced"),
            (200, 0, false),
            "a forced `diff` beats the threshold"
        );
        assert_eq!(seen("small.txt"), (2, 0, false));

        assert_untracked_matches_staged(
            &repo,
            &stats.unstaged,
            &["big.txt", "big.forced", "small.txt"],
        )
        .await;
    }

    /// A nested repo is a directory to `ls-files`, and the counter skips anything that
    /// is not a regular file rather than descending into it — that row keeps the blank
    /// slot it had before, whichever way git spells the name.
    #[tokio::test]
    async fn working_line_stats_skips_a_nested_repository() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-nested-repo-test-").await;

        let nested = dir.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        run_git(
            Some(&nested.to_string_lossy().into_owned()),
            &["init", "-q"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        std::fs::write(nested.join("inner.txt"), "a\nb\n").unwrap();
        std::fs::write(dir.join("outer.txt"), "a\n").unwrap();

        // Pinned so the assertion below can't pass because enumeration never named it:
        // `ls-files` does report the nested repo, and the skip arm is what drops it.
        let listed = run_git(
            Some(&repo),
            &["ls-files", "--others", "--exclude-standard", "-z"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy();
        assert!(
            listed.split('\0').any(|p| p.starts_with("nested")),
            "enumeration must name the nested repo, got {listed:?}"
        );

        let stats = git_working_line_stats(repo).await.unwrap();
        assert!(
            !stats.unstaged.iter().any(|e| e.path.starts_with("nested")),
            "a nested repo is never counted, got {:?}",
            stats.unstaged.iter().map(|e| &e.path).collect::<Vec<_>>()
        );
        assert!(
            stats.unstaged.iter().any(|e| e.path == "outer.txt"),
            "the control file beside it is still counted"
        );
    }

    /// `--exclude-standard` keeps ignored files out of the count entirely: they
    /// are not rows in the panel, so they must not be entries either.
    #[tokio::test]
    async fn working_line_stats_skips_ignored_files() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-ignored-test-").await;

        std::fs::write(dir.join(".gitignore"), "ignored.txt\n").unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(
            Some(&repo),
            &["commit", "-qm", "ignore rules"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        std::fs::write(dir.join("ignored.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.join("seen.txt"), "one\n").unwrap();

        let stats = git_working_line_stats(repo).await.unwrap();
        assert!(
            !stats.unstaged.iter().any(|e| e.path == "ignored.txt"),
            "an ignored file is never an untracked row"
        );
        assert!(
            stats.unstaged.iter().any(|e| e.path == "seen.txt"),
            "the control file is still counted"
        );
    }

    /// A brand-new repo with no commits still reports its staged counts — `git
    /// diff --cached` falls back to the empty tree, so the command needs no
    /// unborn-HEAD special case.
    #[tokio::test]
    async fn working_line_stats_handles_unborn_head() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-unborn-test-").await;

        std::fs::write(dir.join("new.txt"), "one\ntwo\n").unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        let stats = git_working_line_stats(repo).await.unwrap();
        let staged = stats
            .staged
            .iter()
            .find(|e| e.path == "new.txt")
            .expect("staged side reports the file");
        assert_eq!((staged.added, staged.deleted), (2, 0));
        assert!(stats.unstaged.is_empty());
    }

    /// The premise behind the Changes panel's conflicted-row gate: numstat emits
    /// MORE THAN ONE unstaged row for an unmerged path (measured: a zero-count
    /// row plus the content diff), so a `.get(path)` lookup would surface an
    /// arbitrary one of them. Pinned here because the gate reads as unmotivated
    /// once the shape is out of view.
    #[tokio::test]
    async fn working_line_stats_reports_duplicate_rows_for_a_conflict() {
        let (_tmp, dir, repo) = init_line_stats_repo("gd-line-stats-conflict-test-").await;

        std::fs::write(dir.join("file.txt"), "a\nb\nc\n").unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(Some(&repo), &["commit", "-qm", "seed"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        // Both branches are created by name off the seed commit, so the test
        // never depends on what `git init` called the default branch.
        for args in [
            vec!["checkout", "-q", "-b", "mine"],
            vec!["checkout", "-q", "-b", "other", "mine"],
        ] {
            run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap();
        }
        std::fs::write(dir.join("file.txt"), "a\nOTHER\nc\n").unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(Some(&repo), &["commit", "-qm", "other"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        run_git(Some(&repo), &["checkout", "-q", "mine"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        std::fs::write(dir.join("file.txt"), "a\nMINE\nc\n").unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(Some(&repo), &["commit", "-qm", "mine"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        // The conflicting merge exits non-zero, which `run_git` would turn into
        // an error — this one spawn takes the raw runner. `--no-edit` so an
        // unexpectedly clean merge can't block on an editor.
        let merge = run_git_raw(
            Some(&repo),
            &["merge", "--no-edit", "other"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(merge.code, 0, "the merge must actually conflict");

        let stats = git_working_line_stats(repo).await.unwrap();
        let rows = stats
            .unstaged
            .iter()
            .filter(|e| e.path == "file.txt")
            .count();
        assert!(
            rows > 1,
            "an unmerged path yields duplicate unstaged rows, got {rows}"
        );
    }

    const FILE_HEADER: &str = "diff --git a/f.txt b/f.txt\nindex 000..111 100644\n--- a/f.txt\n+++ b/f.txt\n";

    fn sel(side: Side, line: u32) -> SelectedLine {
        SelectedLine { side, line }
    }

    #[test]
    fn stages_one_of_two_added_lines() {
        let diff = format!("{FILE_HEADER}@@ -1,2 +1,4 @@\n line1\n+added A\n+added B\n line2\n");
        // Select only "added A" (new-side line 2).
        let patch = build_partial_patch(&diff, &[sel(Side::New, 2)], false);
        assert_eq!(
            patch,
            format!("{FILE_HEADER}@@ -1,2 +1,3 @@\n line1\n+added A\n line2\n"),
        );
    }

    #[test]
    fn stages_one_of_two_deleted_lines() {
        // Unselected deletion becomes context so the old side still matches.
        let diff = format!("{FILE_HEADER}@@ -1,4 +1,2 @@\n line1\n-del A\n-del B\n line4\n");
        let patch = build_partial_patch(&diff, &[sel(Side::Old, 2)], false);
        assert_eq!(
            patch,
            format!("{FILE_HEADER}@@ -1,4 +1,3 @@\n line1\n-del A\n del B\n line4\n"),
        );
    }

    #[test]
    fn reverse_unselected_addition_becomes_context() {
        // Unstage only "added A": "added B" must survive as context.
        let diff = format!("{FILE_HEADER}@@ -1,2 +1,4 @@\n line1\n+added A\n+added B\n line2\n");
        let patch = build_partial_patch(&diff, &[sel(Side::New, 2)], true);
        assert_eq!(
            patch,
            format!("{FILE_HEADER}@@ -1,3 +1,4 @@\n line1\n+added A\n added B\n line2\n"),
        );
    }

    #[test]
    fn only_hunks_with_a_selected_change_are_emitted() {
        let diff = format!(
            "{FILE_HEADER}@@ -1,2 +1,3 @@\n a\n+first\n b\n@@ -10,2 +11,3 @@\n c\n+second\n d\n"
        );
        // Select only the addition in the second hunk (new-side line 12).
        let patch = build_partial_patch(&diff, &[sel(Side::New, 12)], false);
        assert!(!patch.contains("+first"));
        assert!(patch.contains("@@ -10,2 +11,3 @@"));
        assert!(patch.contains("+second"));
    }

    #[test]
    fn no_newline_marker_follows_its_line() {
        let diff = format!(
            "{FILE_HEADER}@@ -1,2 +1,2 @@\n line1\n-old last\n\\ No newline at end of file\n+new last\n\\ No newline at end of file\n"
        );
        let patch = build_partial_patch(&diff, &[sel(Side::Old, 2), sel(Side::New, 2)], false);
        assert!(patch.contains("-old last\n\\ No newline at end of file\n"));
        assert!(patch.contains("+new last\n\\ No newline at end of file\n"));
    }

    #[test]
    fn nothing_selected_yields_empty() {
        let diff = format!("{FILE_HEADER}@@ -1,2 +1,3 @@\n line1\n+added\n line2\n");
        assert!(build_partial_patch(&diff, &[], false).is_empty());
    }

    /// The built partial patch is accepted by real `git apply --cached`: of two
    /// added lines, staging one leaves exactly the other unstaged.
    #[tokio::test]
    async fn partial_patch_stages_a_single_added_line() {
        use crate::git::runner::run_git_input;

        let _tmp = tempfile::Builder::new()
            .prefix("gd-partial-test-")
            .tempdir()
            .expect("create temp dir");
        let dir = _tmp.path().to_path_buf();
        let repo = dir.to_string_lossy().into_owned();
        let git = |args: Vec<&'static str>| {
            let repo = repo.clone();
            async move { run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap() }
        };

        git(vec!["init"]).await;
        git(vec!["config", "user.email", "t@t"]).await;
        git(vec!["config", "user.name", "t"]).await;
        let base: Vec<String> = (1..=5).map(|i| format!("line {i}")).collect();
        let file = dir.join("file.txt");
        std::fs::write(&file, base.join("\n") + "\n").unwrap();
        git(vec!["add", "."]).await;
        git(vec!["commit", "-m", "base"]).await;
        // Insert two new lines after "line 2".
        let edited = "line 1\nline 2\nNEW A\nNEW B\nline 3\nline 4\nline 5\n";
        std::fs::write(&file, edited).unwrap();

        let diff = git(vec!["diff", "--no-color"]).await.stdout_lossy();
        // "NEW A" is new-side line 3 in the edited file.
        let patch = build_partial_patch(&diff, &[sel(Side::New, 3)], false);
        run_git_input(
            Some(&repo),
            &["apply", "--whitespace=nowarn", "--recount", "--cached", "-"],
            Some(&patch),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();

        let staged = git(vec!["diff", "--cached", "--no-color"]).await.stdout_lossy();
        let unstaged = git(vec!["diff", "--no-color"]).await.stdout_lossy();
        assert!(staged.contains("NEW A"));
        assert!(!staged.contains("NEW B"));
        assert!(unstaged.contains("NEW B"));
    }

    /// A selection spanning two hunks and both sides survives real
    /// `git apply --cached`: the old-side line of one modification and the
    /// new-side line of another stage independently, each hunk's unselected
    /// line neutralized by forward semantics.
    #[tokio::test]
    async fn partial_patch_stages_mixed_sides_across_hunks() {
        use crate::git::runner::run_git_input;

        let _tmp = tempfile::Builder::new()
            .prefix("gd-partial-crosshunk-test-")
            .tempdir()
            .expect("create temp dir");
        let dir = _tmp.path().to_path_buf();
        let repo = dir.to_string_lossy().into_owned();
        let git = |args: Vec<&'static str>| {
            let repo = repo.clone();
            async move { run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap() }
        };

        git(vec!["init"]).await;
        git(vec!["config", "user.email", "t@t"]).await;
        git(vec!["config", "user.name", "t"]).await;
        // Two modification sites far enough apart (> 6 context lines) to force
        // two hunks, each carrying both a `-` and a `+`.
        let base: Vec<String> = (1..=30).map(|i| format!("line {i}")).collect();
        let file = dir.join("file.txt");
        std::fs::write(&file, base.join("\n") + "\n").unwrap();
        git(vec!["add", "."]).await;
        git(vec!["commit", "-m", "base"]).await;
        let mut edited = base.clone();
        edited[2] = "line 3 EDITED".into();
        edited[24] = "line 25 EDITED".into();
        std::fs::write(&file, edited.join("\n") + "\n").unwrap();
        let worktree_before = std::fs::read(&file).unwrap();

        let diff = git(vec!["diff", "--no-color"]).await.stdout_lossy();
        // Pinned so a context merge can never quietly turn this into one hunk.
        assert_eq!(
            diff.lines().filter(|l| l.starts_with("@@")).count(),
            2,
            "fixture must produce two hunks:\n{diff}"
        );

        // Hunk 1's deletion (old-side line 3) plus hunk 2's addition
        // (new-side line 25) — mixed sides, one line from each hunk.
        let patch = build_partial_patch(&diff, &[sel(Side::Old, 3), sel(Side::New, 25)], false);
        run_git_input(
            Some(&repo),
            &["apply", "--whitespace=nowarn", "--recount", "--cached", "-"],
            Some(&patch),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();

        // Hunk 1: the selected `-` deletes "line 3" and its unselected `+` is
        // dropped. Hunk 2: the unselected `-` keeps "line 25" as context and
        // the selected `+` adds its replacement after it.
        let mut expected = base.clone();
        expected.remove(2);
        let after_kept = expected
            .iter()
            .position(|l| l == "line 25")
            .expect("hunk 2's old line stays in the index")
            + 1;
        expected.insert(after_kept, "line 25 EDITED".into());
        let index_content = git(vec!["show", ":0:file.txt"]).await.stdout_lossy();
        assert_eq!(index_content, expected.join("\n") + "\n");

        assert_eq!(
            std::fs::read(&file).unwrap(),
            worktree_before,
            "staging must not touch the working tree"
        );
    }

    /// The unstage twin: the same cross-hunk, mixed-side selection applied with
    /// `--cached --reverse` over the STAGED diff. Unstaging half a modification
    /// is deliberately lossy in one direction — a selected `-` restores its old
    /// line while the paired `+` stays staged, but a selected `+` is withdrawn
    /// without its unselected `-` bringing the old line back.
    #[tokio::test]
    async fn partial_patch_unstages_mixed_sides_across_hunks() {
        use crate::git::runner::run_git_input;

        let _tmp = tempfile::Builder::new()
            .prefix("gd-partial-crosshunk-rev-test-")
            .tempdir()
            .expect("create temp dir");
        let dir = _tmp.path().to_path_buf();
        let repo = dir.to_string_lossy().into_owned();
        let git = |args: Vec<&'static str>| {
            let repo = repo.clone();
            async move { run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap() }
        };

        git(vec!["init"]).await;
        git(vec!["config", "user.email", "t@t"]).await;
        git(vec!["config", "user.name", "t"]).await;
        let base: Vec<String> = (1..=30).map(|i| format!("line {i}")).collect();
        let file = dir.join("file.txt");
        std::fs::write(&file, base.join("\n") + "\n").unwrap();
        git(vec!["add", "."]).await;
        git(vec!["commit", "-m", "base"]).await;
        let mut edited = base.clone();
        edited[2] = "line 3 EDITED".into();
        edited[24] = "line 25 EDITED".into();
        std::fs::write(&file, edited.join("\n") + "\n").unwrap();
        // Both modifications fully staged — the unstage path reads HEAD→index.
        git(vec!["add", "file.txt"]).await;
        let worktree_before = std::fs::read(&file).unwrap();

        let diff = git(vec!["diff", "--cached", "--no-color"]).await.stdout_lossy();
        // Pinned so a context merge can never quietly turn this into one hunk.
        assert_eq!(
            diff.lines().filter(|l| l.starts_with("@@")).count(),
            2,
            "fixture must produce two hunks:\n{diff}"
        );

        let patch = build_partial_patch(&diff, &[sel(Side::Old, 3), sel(Side::New, 25)], true);
        run_git_input(
            Some(&repo),
            &["apply", "--whitespace=nowarn", "--recount", "--cached", "--reverse", "-"],
            Some(&patch),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();

        // Hunk 1: the selected `-` puts "line 3" back while its unselected `+`
        // stays staged as context. Hunk 2: the selected `+` is withdrawn and its
        // unselected `-` was dropped, so "line 25" does NOT return.
        let mut expected = base.clone();
        let after_restored = expected
            .iter()
            .position(|l| l == "line 3")
            .expect("hunk 1's old line returns to the index")
            + 1;
        expected.insert(after_restored, "line 3 EDITED".into());
        let withdrawn = expected
            .iter()
            .position(|l| l == "line 25")
            .expect("hunk 2's old line is in the base");
        expected.remove(withdrawn);
        let index_content = git(vec!["show", ":0:file.txt"]).await.stdout_lossy();
        assert_eq!(index_content, expected.join("\n") + "\n");

        assert_eq!(
            std::fs::read(&file).unwrap(),
            worktree_before,
            "unstaging must not touch the working tree"
        );
    }

    /// End-to-end check of the hunk-staging plumbing: a single hunk cut out
    /// of a two-hunk diff stages via stdin `git apply --cached` and unstages
    /// via `--reverse`. Requires git on PATH (true for this project's dev
    /// environment).
    #[tokio::test]
    async fn apply_patch_stages_and_unstages_a_single_hunk() {
        use crate::git::runner::run_git_input;

        let _tmp = tempfile::Builder::new()
            .prefix("gd-apply-test-")
            .tempdir()
            .expect("create temp dir");
        let dir = _tmp.path().to_path_buf();
        let repo = dir.to_string_lossy().into_owned();
        let git = |args: Vec<&'static str>| {
            let repo = repo.clone();
            async move { run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap() }
        };

        git(vec!["init"]).await;
        git(vec!["config", "user.email", "t@t"]).await;
        git(vec!["config", "user.name", "t"]).await;
        // Two edit sites far enough apart (> 6 context lines) to force
        // two separate hunks.
        let base: Vec<String> = (1..=30).map(|i| format!("line {i}")).collect();
        let file = dir.join("file.txt");
        std::fs::write(&file, base.join("\n") + "\n").unwrap();
        git(vec!["add", "."]).await;
        git(vec!["commit", "-m", "base"]).await;
        let mut edited = base.clone();
        edited[2] = "line 3 EDITED".into();
        edited[24] = "line 25 EDITED".into();
        std::fs::write(&file, edited.join("\n") + "\n").unwrap();

        let diff = git(vec!["diff", "--no-color"]).await.stdout_lossy();
        let first_hunk_at = diff.find("\n@@").unwrap() + 1;
        let second_hunk_at = diff[first_hunk_at..].find("\n@@").unwrap() + first_hunk_at + 1;
        let patch = format!("{}{}", &diff[..first_hunk_at], &diff[first_hunk_at..second_hunk_at]);

        // Stage only the first hunk.
        run_git_input(
            Some(&repo),
            &["apply", "--whitespace=nowarn", "--cached", "-"],
            Some(&patch),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        let staged = git(vec!["diff", "--cached", "--no-color"]).await.stdout_lossy();
        let unstaged = git(vec!["diff", "--no-color"]).await.stdout_lossy();
        assert!(staged.contains("line 3 EDITED"));
        assert!(!staged.contains("line 25 EDITED"));
        assert!(unstaged.contains("line 25 EDITED"));

        // Unstage it again.
        run_git_input(
            Some(&repo),
            &["apply", "--whitespace=nowarn", "--cached", "--reverse", "-"],
            Some(&patch),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        let staged = git(vec!["diff", "--cached", "--no-color"]).await.stdout_lossy();
        assert!(staged.trim().is_empty());
    }

    /// `git_session_file_diff` shows a file's CUMULATIVE change vs the session
    /// base — a committed-turn edit PLUS a later uncommitted edit (the base-aware
    /// behavior `git diff HEAD` would miss after a checkpoint commit) — and
    /// surfaces a brand-new untracked file as a full add via the fallback.
    #[tokio::test]
    async fn session_file_diff_is_cumulative_against_base() {
        let _tmp = tempfile::Builder::new()
            .prefix("gd-session-diff-")
            .tempdir()
            .expect("create temp dir");
        let dir = _tmp.path().to_path_buf();
        let repo = dir.to_string_lossy().into_owned();
        let git = |args: Vec<&'static str>| {
            let repo = repo.clone();
            async move { run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap() }
        };

        git(vec!["init"]).await;
        git(vec!["config", "user.email", "t@t"]).await;
        git(vec!["config", "user.name", "t"]).await;
        let file = dir.join("file.txt");
        std::fs::write(&file, "base line\n").unwrap();
        git(vec!["add", "."]).await;
        git(vec!["commit", "-m", "base"]).await;
        let base = git(vec!["rev-parse", "HEAD"]).await.stdout_lossy().trim().to_string();

        // Turn 1: edit + commit (a checkpoint) — HEAD moves past base.
        std::fs::write(&file, "base line\nFROM COMMITTED TURN\n").unwrap();
        git(vec!["commit", "-am", "turn 1"]).await;
        // Turn 2 (in progress): a further uncommitted edit.
        std::fs::write(
            &file,
            "base line\nFROM COMMITTED TURN\nFROM UNCOMMITTED EDIT\n",
        )
        .unwrap();

        let diff = git_session_file_diff(repo.clone(), "file.txt".into(), base.clone())
            .await
            .unwrap();
        assert!(diff.text.contains("FROM COMMITTED TURN"), "{}", diff.text);
        assert!(diff.text.contains("FROM UNCOMMITTED EDIT"), "{}", diff.text);
        assert!(!diff.is_binary);

        // A brand-new untracked file surfaces as a full add (the fallback path).
        std::fs::write(dir.join("new.txt"), "hello new file\n").unwrap();
        let added = git_session_file_diff(repo.clone(), "new.txt".into(), base)
            .await
            .unwrap();
        assert!(added.text.contains("+hello new file"), "{}", added.text);
        assert!(added.text.contains("new.txt"), "{}", added.text);
    }

    /// A repo whose committed files are inert header fixtures — headers only, nothing
    /// a decoder would act on. `core.autocrlf` is pinned so the byte-exact fixtures
    /// come back out of `git show` unchanged.
    async fn init_preview_repo() -> (tempfile::TempDir, std::path::PathBuf, String) {
        let (tmp, dir, repo) = init_line_stats_repo("gd-file-bytes-test-").await;
        // Named `.png` regardless of what the bytes are: the extension is what the
        // sniffed type has to beat.
        std::fs::write(dir.join("bomb.png"), png_fixture(9000, 9000)).unwrap();
        std::fs::write(dir.join("area.png"), png_fixture(7000, 7000)).unwrap();
        std::fs::write(dir.join("ok.png"), png_fixture(1200, 630)).unwrap();
        std::fs::write(dir.join("lying.png"), jpeg_fixture(0xc0, &[], 40, 30)).unwrap();
        std::fs::write(dir.join("stuffed.jpg"), stuffed_pair_jpeg()).unwrap();
        std::fs::write(
            dir.join("icon.svg"),
            b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"9000\" height=\"9000\"/>",
        )
        .unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(Some(&repo), &["commit", "-qm", "fixtures"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        (tmp, dir, repo)
    }

    /// The decode gate: a few bytes of PNG declaring a raster past either cap comes back
    /// as a refusal rather than as bytes. Both read paths are exercised because the rev
    /// arm and the working-tree arm are separate reads that meet at the same gate.
    #[tokio::test]
    async fn a_declared_raster_past_the_caps_is_refused_on_both_read_paths() {
        let (_tmp, _dir, repo) = init_preview_repo().await;
        // 9000 is over the per-axis cap; 7000x7000 = 49 MP clears both axes and is
        // refused by the area cap alone.
        for name in ["bomb.png", "area.png"] {
            for rev in [None, Some("HEAD".to_string())] {
                let got = git_file_base64(repo.clone(), rev.clone(), name.into())
                    .await
                    .unwrap()
                    .expect("the file exists on both paths");
                assert!(got.too_large, "{name} at {rev:?} must be refused");
                assert_eq!(got.base64, None, "{name} must not ship its bytes");
                assert_eq!(got.mime.as_deref(), Some("image/png"));
            }
        }
    }

    /// The type on the data URI comes from the bytes: a JPEG named `.png` ships as a
    /// JPEG, and bytes with no reader here ship typeless under the byte cap alone.
    #[tokio::test]
    async fn the_sniffed_type_wins_over_the_file_extension() {
        let (_tmp, _dir, repo) = init_preview_repo().await;
        for rev in [None, Some("HEAD".to_string())] {
            let ok = git_file_base64(repo.clone(), rev.clone(), "ok.png".into())
                .await
                .unwrap()
                .unwrap();
            assert!(!ok.too_large);
            assert_eq!(ok.mime.as_deref(), Some("image/png"));
            assert!(ok.base64.is_some());

            let lying = git_file_base64(repo.clone(), rev.clone(), "lying.png".into())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(lying.mime.as_deref(), Some("image/jpeg"));
            assert!(lying.base64.is_some());

            // SVG has no header raster to gate, so its declared 9000x9000 is not a
            // decode the caps can bound — it ships, byte-bound, and typeless.
            let svg = git_file_base64(repo.clone(), rev.clone(), "icon.svg".into())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(svg.mime, None);
            assert!(!svg.too_large);
            assert!(svg.base64.is_some());
        }
    }

    /// The sniffer refuses a header it cannot read, and that refusal has to survive the
    /// trip through this gate. A JPEG opening with a stuffed `FF 00` pair stops the
    /// marker walk — but not the webview's decoder, which discards the pair and reads
    /// the 9000x9000 frame header behind it. Shipping those bytes byte-bound would hand
    /// the renderer a raster the caps never saw.
    #[tokio::test]
    async fn a_recognized_container_with_an_unreadable_header_is_refused() {
        let (_tmp, _dir, repo) = init_preview_repo().await;
        // The premise, pinned: the magic names a JPEG, the walk reads no size from it.
        let bytes = stuffed_pair_jpeg();
        assert!(crate::image_sniff::has_raster_magic(&bytes));
        assert_eq!(sniff_image(&bytes), None);

        for rev in [None, Some("HEAD".to_string())] {
            let got = git_file_base64(repo.clone(), rev.clone(), "stuffed.jpg".into())
                .await
                .unwrap()
                .expect("the file exists on both paths");
            assert!(got.too_large, "at {rev:?} the container must be refused");
            assert_eq!(got.base64, None, "no bytes may reach the decoder");
        }

        // The control that keeps the refusal from swallowing everything typeless: bytes
        // with no raster magic still ship, bounded by the byte cap alone.
        let svg = git_file_base64(repo.clone(), None, "icon.svg".into())
            .await
            .unwrap()
            .unwrap();
        assert!(!svg.too_large);
        assert!(svg.base64.is_some());
    }

    /// The byte cap is a refusal STATE now, not an error, and an absent file is still
    /// the `None` every caller reads as "no version here".
    #[tokio::test]
    async fn the_byte_cap_refuses_and_a_missing_file_is_still_none() {
        let (_tmp, dir, repo) = init_preview_repo().await;
        std::fs::write(dir.join("huge.bin"), vec![0u8; IMAGE_MAX_BYTES + 1]).unwrap();
        let huge = git_file_base64(repo.clone(), None, "huge.bin".into())
            .await
            .unwrap()
            .expect("an over-cap file is a refusal, not an absence");
        assert!(huge.too_large);
        assert_eq!(huge.base64, None);
        assert_eq!(huge.mime, None);

        for rev in [None, Some("HEAD".to_string())] {
            assert!(git_file_base64(repo.clone(), rev, "nope.png".into())
                .await
                .unwrap()
                .is_none());
        }
    }

    /// The frontend reads `base64`/`mime`/`tooLarge` off this record — `rename_all` is a
    /// rename trap the repo has been bitten by, so the wire shape is pinned.
    #[test]
    fn file_bytes_serializes_to_the_pinned_wire_shape() {
        assert_eq!(
            serde_json::to_value(FileBytes {
                base64: Some("AAAA".into()),
                mime: Some("image/png".into()),
                too_large: false,
            })
            .unwrap(),
            serde_json::json!({ "base64": "AAAA", "mime": "image/png", "tooLarge": false })
        );
        assert_eq!(
            serde_json::to_value(FileBytes {
                base64: None,
                mime: None,
                too_large: true,
            })
            .unwrap(),
            serde_json::json!({ "base64": null, "mime": null, "tooLarge": true })
        );
    }
}
