use std::collections::HashSet;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::ignored_guard::{self, ignored_files_in_the_way, name_paths};
use crate::git::runner::{
    acquire_repo_lock, acquire_repo_lock_unbounded, config_lock_busy, holder_label,
    is_config_lock_contention, run_git, run_git_config_write, run_git_config_write_held,
    run_git_raw, run_git_raw_index_retry, run_git_worktree_admin, subcommand_of,
    try_acquire_repo_lock, with_config_write_lock, ConfigWriteHeld, GitOutput, DEFAULT_TIMEOUT,
    LOCK_WAIT_TIMEOUT, NETWORK_LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT, WORKTREE_OP_TIMEOUT,
};
use crate::git::types::{Branch, BranchDivergence, RemoteBranch};
use crate::state::AppState;

/// The shared guard against refspec/argv injection from a user-named ref: every
/// ref-reaching name routes through here or through `validate_tag_name`. Rev
/// syntax (`~ ^ @ { }`) is deliberately accepted, for branch start-points.
pub(crate) fn validate_ref_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {name}"
        )));
    }
    // Reject glob/refspec metacharacters. A ref name is interpolated into
    // `for-each-ref refs/heads/<name>` (where `* ? [` glob) and, on the push
    // path, into a push refspec `refs/heads/<name>:refs/heads/<name>` (where `*`
    // is a wildcard and `:` a separator) — so an unfiltered `*` would glob-match
    // and mirror-push every branch. These characters are never valid in a real
    // git ref name. `~ ^ @ { }` are deliberately NOT rejected: this validator is
    // also used for rev-expression start points (e.g. `main~3`, `HEAD@{2}`).
    if name
        .chars()
        .any(|c| matches!(c, '*' | '?' | '[' | ':' | '\\' | ' ') || c.is_ascii_control())
    {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {name}"
        )));
    }
    Ok(())
}

/// The stricter gate for inputs that must name a BRANCH and nothing else: it adds
/// a rejection of rev-expression syntax, which `rev-parse` would otherwise resolve
/// (`feature~1` exists under `refs/heads/` as the branch's parent commit), and of
/// bare `@`, git's HEAD shorthand in the rev positions these names reach.
pub(crate) fn validate_branch_name(name: &str) -> AppResult<()> {
    validate_ref_name(name)?;
    if name == "@" || name.contains(['~', '^']) || name.contains("..") || name.contains("@{") {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {name}"
        )));
    }
    Ok(())
}

/// HEAD's branch as its full ref (`refs/heads/<name>`), or `None` when HEAD is
/// detached. Read with `symbolic-ref`, never `rev-parse --abbrev-ref`: the short form
/// disambiguates, so a branch shadowed by a same-named tag reads `heads/<name>` (or the
/// full ref, when that is ambiguous too). An UNBORN branch still answers here — sites
/// that must refuse before the first commit check `git::history::unborn_head`. Any
/// other failure (not a repository, git missing) is an `Err`.
pub(crate) async fn current_branch_ref(repo_path: &str) -> AppResult<Option<String>> {
    let out = run_git_raw(
        Some(repo_path),
        &["symbolic-ref", "-q", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match out.code {
        0 => {
            let full = out.stdout_lossy();
            let full = full.trim_end_matches(['\r', '\n']);
            let named = full
                .strip_prefix("refs/heads/")
                .is_some_and(|name| !name.is_empty());
            Ok(named.then(|| full.to_string()))
        }
        // `-q` exits 1, silently, exactly when HEAD is not a symbolic ref.
        1 => Ok(None),
        code => Err(AppError::Git {
            code,
            stderr: out.full_failure_text(),
        }),
    }
}

/// The checked-out branch's NAME (what a branch argument, config key, refspec or
/// comparison against `status --branch` wants), with [`current_branch_ref`]'s
/// detached/unborn/error contract. A rev position takes the full ref instead: a bare
/// name resolves to a same-named tag first.
pub(crate) async fn current_branch_name(repo_path: &str) -> AppResult<Option<String>> {
    Ok(current_branch_ref(repo_path)
        .await?
        .and_then(|full| full.strip_prefix("refs/heads/").map(str::to_string)))
}

/// Whether HEAD names a branch with no commits yet (a fresh `git init`, an orphan
/// switch) — the state [`current_branch_name`] reports as an ordinary branch.
pub(crate) async fn head_is_unborn(repo_path: &str) -> AppResult<bool> {
    let out = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--verify", "-q", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(out.code != 0)
}

/// `name` for a REV position whose callers name LOCAL BRANCHES. A name git already
/// resolves to that branch stays as given (`merge` words its message from it: the full
/// ref would read "Merge branch 'refs/heads/x'"). When something else captures it, a
/// same-named tag first (gitrevisions checks refs/tags before refs/heads), the local
/// branch named exactly `name` is taken by its full ref, git's own `%(refname)`.
/// Anything that names no local branch (a remote-tracking ref, sha, rev expression)
/// passes through, as does a failed read, leaving each command's own error to surface.
/// An input already spelled as a full ref (`refs/...`) is returned untouched, so a
/// branch literally named `refs/heads/x` can never capture it. Callers validate `name`
/// first. Not for inputs that may legitimately be TAGS: a tag sharing a branch's name
/// would lose to the branch.
pub(crate) async fn branch_first_rev(repo_path: &str, name: &str) -> String {
    if name.starts_with("refs/") {
        return name.to_string();
    }
    // Ambiguous names answer empty on stdout with exit 0 (the error rides stderr).
    let resolved = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--symbolic-full-name", name],
        DEFAULT_TIMEOUT,
    )
    .await;
    if let Ok(out) = resolved {
        if out.code == 0 && out.stdout_lossy().trim().strip_prefix("refs/heads/") == Some(name) {
            return name.to_string();
        }
    }
    let listed = run_git_raw(
        Some(repo_path),
        &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        DEFAULT_TIMEOUT,
    )
    .await;
    let Ok(out) = listed else {
        return name.to_string();
    };
    if out.code != 0 {
        return name.to_string();
    }
    out.stdout_lossy()
        .lines()
        .find(|full| full.strip_prefix("refs/heads/") == Some(name))
        .map_or_else(|| name.to_string(), str::to_string)
}

/// The refusal for an operation that needs a commit on HEAD's branch.
pub(crate) fn unborn_head_error() -> AppError {
    AppError::InvalidArgument(
        "The current branch has no commits yet — commit on it, or switch to another branch, \
         first."
            .into(),
    )
}

/// Every local branch. Names are read in FULL and stripped of exactly `refs/heads/`:
/// `%(refname:short)` disambiguates, so a branch shadowed by a same-named tag lists as
/// `heads/<name>` (or the full ref, when that is ambiguous too) and every row action
/// would target the wrong name. `%(upstream:short)` stays short on purpose — the UI
/// hands it back as a rev, which its disambiguated form resolves correctly.
///
/// The same spawn lists every remote's `HEAD` (`**`, since `*` stops at the `/` of a
/// slash-named remote) so `upstream_is_remote_default` compares two full refs, exact
/// under a remapped fetch refspec. A dangling remote HEAD prints no row: false.
#[tauri::command]
pub async fn git_branches(repo_path: String) -> AppResult<Vec<Branch>> {
    let out = run_git(
        Some(&repo_path),
        &[
            "for-each-ref",
            "refs/heads",
            "refs/remotes/**/HEAD",
            "--format=%(refname)%00%(upstream:short)%00%(HEAD)%00%(committerdate:iso8601-strict)%00%(upstream:track)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)%00%(symref)",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let flags = read_branch_flags(&repo_path).await?;
    let remote_heads: std::collections::HashMap<&str, &str> = text
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\0').collect();
            let refname = fields.first()?;
            let symref = fields.get(8).filter(|s| !s.is_empty())?;
            (refname.starts_with("refs/remotes/") && refname.ends_with("/HEAD"))
                .then_some((*refname, *symref))
        })
        .collect();
    // Read once per listing; a failed read leaves every row's push destination unknown.
    #[cfg(test)]
    run_test_hook(&LISTING_ROUTING_HOOK).await;
    let routing = crate::git::remote::named_push_routing(&repo_path)
        .await
        .ok();
    // Rows whose live upstream has another name: (row index, upstream name, full ref).
    let mut candidates: Vec<(usize, String, String)> = Vec::new();
    let mut branches = Vec::new();
    for line in text.lines() {
        let mut parts = line.split('\0');
        let (
            Some(refname),
            upstream,
            head,
            date,
            track,
            upstream_remote,
            upstream_remote_ref,
            upstream_full,
        ) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        )
        else {
            continue;
        };
        let Some(name) = refname
            .strip_prefix("refs/heads/")
            .filter(|n| !n.is_empty())
        else {
            continue;
        };
        let (upstream_ahead, upstream_behind, upstream_gone) =
            parse_upstream_track(track.unwrap_or(""));
        let remote = upstream_remote.unwrap_or("");
        let upstream_full = upstream_full.unwrap_or("");
        let upstream_is_remote_default = !upstream_gone
            && crate::git::remote::is_named_remote(remote)
            && upstream_remote_ref.is_some_and(|r| r.starts_with("refs/heads/"))
            && !upstream_full.is_empty()
            && crate::git::remote::upstream_is_remote_default(
                remote_heads
                    .get(format!("refs/remotes/{remote}/HEAD").as_str())
                    .copied(),
                upstream_full,
            ) == Some(true);
        let upstream_kind =
            crate::git::remote::upstream_from_remoteref(upstream_remote_ref.unwrap_or(""));
        let candidate_up = match &upstream_kind {
            crate::git::remote::Upstream::Branch(up)
                if !upstream_gone
                    && crate::git::remote::is_named_remote(remote)
                    && !upstream_is_remote_default
                    && up != name =>
            {
                Some(up.clone())
            }
            _ => None,
        };
        if let (Some(up), Ok(full_ref)) = (candidate_up, branch_full_ref(name)) {
            candidates.push((branches.len(), up, full_ref));
        }
        let (named_push_remote, named_push_branch, named_push_refused) = named_push_fields(
            routing
                .as_ref()
                .map(|r| r.destination(name, &upstream_kind, remote, upstream_gone)),
        );
        branches.push(Branch {
            name: name.to_string(),
            is_current: head == Some("*"),
            upstream: upstream.filter(|u| !u.is_empty()).map(str::to_string),
            last_commit_date: date.unwrap_or("").to_string(),
            archived: flags.archived.contains(name),
            upstream_ahead,
            upstream_behind,
            upstream_gone,
            upstream_remote: upstream_remote.filter(|r| !r.is_empty()).map(str::to_string),
            upstream_remote_ref: upstream_remote_ref
                .filter(|r| !r.is_empty())
                .map(str::to_string),
            keep_local: flags.keep_local.contains(name),
            upstream_is_remote_default,
            renamed_from_upstream: false,
            named_push_remote,
            named_push_branch,
            named_push_refused,
        });
    }
    // One reflog spawn per chunk of candidates; a failed spawn (one ref deleted since the
    // listing fails the whole call) leaves that chunk's rows false and the listing whole.
    #[cfg(test)]
    run_test_hook(&LISTING_REFLOG_HOOK).await;
    for chunk in candidates.chunks(REFLOG_BATCH) {
        let refs: Vec<String> = chunk
            .iter()
            .map(|(_, _, full_ref)| full_ref.clone())
            .collect();
        match read_reflog_subjects(&repo_path, &refs).await {
            Ok(subjects) => {
                for (row, up, full_ref) in chunk {
                    let subjects = subjects.get(full_ref).map_or(&[][..], Vec::as_slice);
                    let previous = previous_branch_names(subjects, &branches[*row].name);
                    branches[*row].renamed_from_upstream = previous.contains(up);
                }
            }
            Err(e) => {
                eprintln!("gitdesktop: branch-list reflog read failed (rows read false): {e}")
            }
        }
    }
    Ok(branches)
}

/// A row's three push-destination fields; an unread routing (None) is `None`/`None`/false.
fn named_push_fields(
    destination: Option<crate::git::remote::NamedPushDestination>,
) -> (Option<String>, Option<String>, bool) {
    use crate::git::remote::NamedPushDestination;
    match destination {
        Some(NamedPushDestination::To { remote, branch }) => (Some(remote), Some(branch), false),
        Some(NamedPushDestination::Refused) => (None, None, true),
        None => (None, None, false),
    }
}

/// The for-each-ref atoms [`push_destination_fields`] reads, appended NUL-separated
/// after a read's own fields: the push remote, its explicit destination ref (filled only
/// under a `remote.<r>.push` refspec), the destination's remote-tracking ref, and the
/// upstream's tracking ref it is compared with.
const PUSH_DESTINATION_ATOMS: &str =
    "%(push:remotename)%00%(push:remoteref)%00%(push)%00%(upstream)";

/// The position of `%(upstream)` among [`PUSH_DESTINATION_ATOMS`], for readers that
/// take that one atom off a line.
pub(crate) const UPSTREAM_ATOM_INDEX: usize = 3;

/// Runs `for-each-ref <pattern>` with `base_format` extended by
/// [`PUSH_DESTINATION_ATOMS`]. A git that rejects one of them fails the whole command,
/// so that failure re-runs `base_format` once and the lines carry no atoms: the
/// destination reads as unknown, never a broken read (the status read may still derive
/// one from the push config).
pub(crate) async fn read_refs_with_push_destination(
    repo_path: &str,
    pattern: &str,
    base_format: &str,
) -> AppResult<String> {
    let extended = format!("{base_format}%00{PUSH_DESTINATION_ATOMS}");
    read_refs_with_fallback(repo_path, pattern, &extended, base_format).await
}

async fn read_refs_with_fallback(
    repo_path: &str,
    pattern: &str,
    extended: &str,
    base_format: &str,
) -> AppResult<String> {
    let out = run_git_raw(
        Some(repo_path),
        &["for-each-ref", pattern, extended],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code == 0 {
        return Ok(out.stdout_lossy());
    }
    // Any other failure surfaces exactly as `run_git` would have reported it.
    if !is_unknown_format_atom(&out.stderr) {
        out.exit_verdict()?;
    }
    let out = run_git(
        Some(repo_path),
        &["for-each-ref", pattern, base_format],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(out.stdout_lossy())
}

/// Whether for-each-ref refused a format atom: git's ref-filter says `unknown field
/// name: <atom>` for an atom it lacks and `unrecognized %(push) argument: <arg>` for a
/// known atom's unknown argument. The runner pins `LC_ALL=C`, so neither localizes.
fn is_unknown_format_atom(stderr: &str) -> bool {
    stderr.contains("unknown field name") || stderr.contains("unrecognized %(push) argument")
}

/// `(push_remote, push_branch)` from a line's [`PUSH_DESTINATION_ATOMS`] fields (empty
/// when the read fell back without them), via [`push_destination`].
pub(crate) fn push_destination_fields(
    local: &str,
    atoms: &[&str],
    upstream_remote: &str,
    upstream_remoteref: &str,
) -> (Option<String>, Option<String>) {
    let [push_remote, push_remoteref, push_track, upstream_track] = match atoms {
        [a, b, c, d, ..] => [*a, *b, *c, *d],
        _ => return (None, None),
    };
    push_destination(
        local,
        push_remote,
        push_remoteref,
        push_track,
        upstream_track,
        upstream_remote,
        upstream_remoteref,
    )
}

/// Where a BARE push of `local` lands, as `(remote, branch on it)`: both Some or both
/// None. A push remote with its own push refspecs is unresolved: git's bare push sends
/// every configured refspec, which no single destination describes, and
/// `%(push:remoteref)` fills only then (one that doesn't map the branch leaves `%(push)`
/// empty). Otherwise `%(push)` is the destination's LOCAL remote-tracking ref, which
/// depends on the fetch refspec's mapping, so it is only read back when it is the
/// upstream's own tracking ref on the same remote (the upstream's branch) or the
/// standard `refs/remotes/<remote>/<local>` (the same name). Any other shape (a
/// remapped fetch refspec, `team/…`) is unresolved: a wrong branch name is never an
/// answer. A mirror push remote (`remote.<r>.mirror`) resolves here like any other; the
/// atoms can't tell it apart, so the status read clears it from the push config, except
/// for the branch's own same-named live upstream, where it reads no config. Every app
/// push to a mirror is refused before git runs (`refuse_mirror_push`).
fn push_destination(
    local: &str,
    push_remote: &str,
    push_remoteref: &str,
    push_track: &str,
    upstream_track: &str,
    upstream_remote: &str,
    upstream_remoteref: &str,
) -> (Option<String>, Option<String>) {
    if !crate::git::remote::is_named_remote(push_remote) || !push_remoteref.is_empty() {
        return (None, None);
    }
    let branch = if push_track.is_empty() {
        None
    } else if push_track == upstream_track && upstream_remote == push_remote {
        upstream_remoteref.strip_prefix("refs/heads/")
    } else if push_track == format!("refs/remotes/{push_remote}/{local}") {
        Some(local)
    } else {
        None
    };
    match branch.filter(|b| !b.is_empty()) {
        Some(b) => (Some(push_remote.to_string()), Some(b.to_string())),
        None => (None, None),
    }
}

/// Parses git's `%(upstream:track)` field into `(ahead, behind, gone)`.
///
/// Shapes: `[ahead 1, behind 2]`, `[ahead 1]`, `[behind 2]`, `[gone]`
/// (upstream deleted), or empty (no upstream, or in sync). `[gone]` yields
/// `(0, 0, true)`; empty and anything unparseable yield `(0, 0, false)`.
/// The `gone` bit lets consumers offer "Publish branch" instead of Push/Pull
/// against a dead ref, even though `%(upstream:short)` still names the upstream.
fn parse_upstream_track(track: &str) -> (u32, u32, bool) {
    let inner = track
        .trim()
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'));
    let Some(inner) = inner else {
        return (0, 0, false);
    };
    let (mut ahead, mut behind, mut gone) = (0u32, 0u32, false);
    for part in inner.split(',') {
        let mut words = part.split_whitespace();
        match (words.next(), words.next()) {
            (Some("ahead"), Some(n)) => ahead = n.parse().unwrap_or(0),
            (Some("behind"), Some(n)) => behind = n.parse().unwrap_or(0),
            (Some("gone"), _) => gone = true,
            _ => {}
        }
    }
    (ahead, behind, gone)
}

/// Splits a remote-tracking ref past `refs/remotes/` at the longest configured
/// remote followed by `/` (a remote name may itself hold `/`), else at the first
/// `/`; `None` when either side would be empty. The same rule as Compare's
/// `splitRemoteDisplay`, so against the same remote list the two agree on every row.
fn split_remote_tracking<'a>(rest: &'a str, remotes: &[String]) -> Option<(&'a str, &'a str)> {
    let mut slash = rest.find('/')?;
    for remote in remotes {
        if remote.len() > slash
            && rest
                .strip_prefix(remote.as_str())
                .is_some_and(|tail| tail.starts_with('/'))
        {
            slash = remote.len();
        }
    }
    let (remote, name) = (&rest[..slash], &rest[slash + 1..]);
    (!remote.is_empty() && !name.is_empty()).then_some((remote, name))
}

/// Branches that exist on a remote, feeding every remote-branch list. Returns
/// every `refs/remotes/<remote>/<branch>`, skipping each configured remote's
/// symbolic `HEAD`; consumers drop what they don't offer (such as
/// `gd/session/*`). The list reflects the last fetch. A failed
/// remotes read fails the list: a guessed split would leak session branches.
#[tauri::command]
pub async fn git_remote_branches(repo_path: String) -> AppResult<Vec<RemoteBranch>> {
    let (out, remotes) = tokio::try_join!(
        run_git(
            Some(&repo_path),
            &[
                "for-each-ref",
                "refs/remotes",
                "--format=%(refname)%00%(committerdate:iso8601-strict)",
            ],
            DEFAULT_TIMEOUT,
        ),
        crate::git::remote::git_remotes(repo_path.clone()),
    )?;
    let mut branches = Vec::new();
    for line in out.stdout_lossy().lines() {
        let mut parts = line.split('\0');
        let (Some(refname), date) = (parts.next(), parts.next()) else {
            continue;
        };
        // Full ref, stripped of exactly `refs/remotes/`: the short form turns into
        // `remotes/<remote>/<branch>` when a local ref is named `<remote>/<branch>`.
        // A `/` inside a branch name or a configured remote's name stays whole; a ref
        // under no configured remote splits at its first `/`.
        let Some((remote, name)) = refname
            .strip_prefix("refs/remotes/")
            .and_then(|r| split_remote_tracking(r, &remotes))
        else {
            continue;
        };
        // Skip the remote's symbolic HEAD (`origin/HEAD` → points at the default).
        if name == "HEAD" {
            continue;
        }
        branches.push(RemoteBranch {
            name: name.to_string(),
            remote: remote.to_string(),
            last_commit_date: date.unwrap_or("").to_string(),
        });
    }
    Ok(branches)
}

/// The per-branch flags the branch list reads from git config.
#[derive(Debug, Default)]
struct BranchFlags {
    archived: HashSet<String>,
    keep_local: HashSet<String>,
}

/// The branches the user has archived (`branch.<name>.gitdesktopArchived true`) and
/// marked Keep local ([`keep_local_key`]), in one config read. git keeps both in sync
/// across renames and removes them on delete, so they never go stale. A failed read
/// fails the list ([`branch_flags_answer`]): it must not show a marked branch unmarked
/// while the push guard refuses it.
async fn read_branch_flags(repo_path: &str) -> AppResult<BranchFlags> {
    let out = run_git_raw(
        Some(repo_path),
        &[
            "config",
            "--get-regexp",
            r"^branch\..*\.gitdesktop(archived|localonly)$",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    branch_flags_answer(&out)
}

/// The verdict over one flag read: exit 1 is "no key matched" whatever stderr carries,
/// since the regex is a constant; any exit other than 0 or 1 is an `Err`.
fn branch_flags_answer(out: &GitOutput) -> AppResult<BranchFlags> {
    match out.code {
        0 => Ok(parse_branch_flags(&out.stdout_lossy())),
        1 => Ok(BranchFlags::default()),
        code => Err(AppError::Git {
            code,
            stderr: out.full_failure_text(),
        }),
    }
}

/// Parses `--get-regexp` lines: `key value`, `key ` for an empty value, bare `key` for
/// a valueless one. Archived keeps its literal `true` rule; Keep local is marked unless
/// git reads the last entry as a definite false, so junk reads marked like the guard.
fn parse_branch_flags(text: &str) -> BranchFlags {
    let mut flags = BranchFlags::default();
    let mut keep_local = std::collections::HashMap::new();
    for line in text.lines() {
        let (key, value) = match line.split_once(' ') {
            Some((key, value)) => (key, Some(value)),
            None => (line, None),
        };
        let Some(rest) = key.strip_prefix("branch.") else {
            continue;
        };
        if let Some(name) = rest.strip_suffix(".gitdesktoparchived") {
            if value.is_some_and(|v| v.trim() == "true") {
                flags.archived.insert(name.to_string());
            }
        } else if let Some(name) = rest.strip_suffix(".gitdesktoplocalonly") {
            let marked = crate::git::diff::git_config_bool(value) != Some(false);
            keep_local.insert(name, marked);
        }
    }
    flags.keep_local = keep_local
        .into_iter()
        .filter(|&(_, marked)| marked)
        .map(|(name, _)| name.to_string())
        .collect();
    flags
}

/// The git config key that marks a branch Keep local. The subsection is the exact
/// branch name (case-sensitive), so only that spelling is marked.
pub(crate) fn keep_local_key(name: &str) -> String {
    format!("branch.{name}.gitdesktopLocalOnly")
}

/// Whether `name` is marked Keep local: the one Rust read, the same command the
/// managed pre-push hook runs, across every config scope. Unset or false allows; any
/// answer git can't give as a bool (junk, an invalid key) is an `Err`, so a guard built
/// on it fails closed. A non-repository reads unset: nothing can be pushed from one.
pub(crate) async fn branch_keep_local(repo_path: &str, name: &str) -> AppResult<bool> {
    branch_keep_local_env(repo_path, name, &[]).await
}

/// [`branch_keep_local`] with extra spawn environment: the tests' per-spawn seam.
async fn branch_keep_local_env(
    repo_path: &str,
    name: &str,
    envs: &[(&str, &str)],
) -> AppResult<bool> {
    let key = keep_local_key(name);
    let out = crate::git::runner::run_git_raw_env(
        Some(repo_path),
        &["config", "--type=bool", "--get", &key],
        envs,
        DEFAULT_TIMEOUT,
    )
    .await?;
    keep_local_answer(&out)
}

/// The verdict over one Keep local read. Exit 1 is "not set" unless git's stderr carries
/// its own `error:`/`fatal:` line (an invalid key): inherited GIT_TRACE* variables put
/// trace lines on stderr of every run, and the runner's LC_ALL=C keeps the prefixes.
fn keep_local_answer(out: &GitOutput) -> AppResult<bool> {
    let stdout = out.stdout_lossy();
    let diagnosed = out.stderr.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("error:") || line.starts_with("fatal:")
    });
    match (out.code, stdout.trim_end_matches(['\r', '\n'])) {
        (0, "true") => Ok(true),
        (0, "false") => Ok(false),
        (1, "") if !diagnosed => Ok(false),
        _ => Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        }),
    }
}

/// Archives/unarchives a branch by setting (or unsetting) a personal,
/// local-config flag, so it's hidden from the dropdown without being deleted.
#[tauri::command]
pub async fn git_set_branch_archived(
    repo_path: String,
    name: String,
    archived: bool,
) -> AppResult<()> {
    set_branch_archived_core(&repo_path, &name, archived).await
}

/// The body of `git_set_branch_archived`.
///
/// No domain lock, only the config-write mutex: the worktree-admin domain is held for a
/// whole removal (minutes on a large tree), so queueing there would turn a second
/// worktree delete into a failed archive for the first. Config writers hold
/// `.git/config.lock` for milliseconds, in this process or another, which the one
/// retry covers.
pub(crate) async fn set_branch_archived_core(
    repo_path: &str,
    name: &str,
    archived: bool,
) -> AppResult<()> {
    // Archiving is held while a publish pushes the branch; unarchiving is not.
    if archived {
        refuse_while_publishing(repo_path, name).await?;
    }
    validate_ref_name(name)?;
    // No current/default-branch refusal here by design: the frontend owns the
    // guard (the current-branch arm is total; the default arm is best-effort,
    // dropping out while defaultName resolves), no MCP tool mutates the flag,
    // and it is fully reversible — a backend default-branch check would also
    // ride the multi-spawn, fallible remote-HEAD resolution per call.
    let key = format!("branch.{name}.gitdesktopArchived");
    let args = if archived {
        ["config", key.as_str(), "true"]
    } else {
        ["config", "--unset-all", key.as_str()]
    };
    let out = run_git_config_write(repo_path, &args, DEFAULT_TIMEOUT).await?;
    // exit 5 = "key not found" — already unarchived, which is fine. `--unset-all`
    // because plain `--unset` ALSO exits 5 on a multi-valued key and removes nothing.
    if out.code == 0 || (!archived && out.code == 5) {
        return Ok(());
    }
    if is_config_lock_contention(&out.stderr) {
        return Err(archive_config_busy(name, archived));
    }
    Err(AppError::Git {
        code: out.code,
        stderr: out.stderr,
    })
}

/// The refusal once the retry ALSO lost the config lock: what happened and what to
/// do, never git's lock-file path.
fn archive_config_busy(name: &str, archived: bool) -> AppError {
    let verb = if archived { "archived" } else { "unarchived" };
    AppError::Command(format!(
        "Another Git process was saving this repository's settings, so {name} wasn't \
         {verb} — try again."
    ))
}

/// Marks or unmarks a branch Keep local (local config), so GitDesktop and its MCP
/// server refuse to push or publish it.
#[tauri::command]
pub async fn git_set_branch_keep_local(
    repo_path: String,
    name: String,
    keep_local: bool,
) -> AppResult<()> {
    set_branch_keep_local_core(&repo_path, &name, keep_local).await
}

/// The body of `git_set_branch_keep_local`, with [`set_branch_archived_core`]'s lock
/// policy. Any local branch may be marked, current and default included. The write is
/// local scope while [`branch_keep_local`] reads every scope, so only a write that read
/// confirms returns Ok; one it contradicts is reported and left in place.
pub(crate) async fn set_branch_keep_local_core(
    repo_path: &str,
    name: &str,
    keep_local: bool,
) -> AppResult<()> {
    validate_ref_name(name)?;
    let key = keep_local_key(name);
    // `--replace-all` and `--unset-all`: a plain set or `--unset` exits 5 on a key a hand
    // edit made multi-valued and writes nothing. Exit 5 on unset is "key not found":
    // already off.
    let args: &[&str] = if keep_local {
        &["config", "--replace-all", &key, "true"]
    } else {
        &["config", "--unset-all", &key]
    };
    let out = run_git_config_write(repo_path, args, DEFAULT_TIMEOUT).await?;
    if out.code != 0 && (keep_local || out.code != 5) {
        if is_config_lock_contention(&out.stderr) {
            let verb = if keep_local { "on" } else { "off" };
            return Err(config_lock_busy(&format!(
                "Keep local wasn't turned {verb} for {name} — try again."
            )));
        }
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    match (keep_local, branch_keep_local(repo_path, name).await?) {
        (false, true) => Err(AppError::Command(format!(
            "Keep local is still on for {name}: it is set outside this repository's own Git \
             config (a global, system, worktree or included config file), so GitDesktop can't \
             turn it off here."
        ))),
        (true, false) => Err(AppError::Command(format!(
            "Keep local is still off for {name}: another Git config scope sets it off (a \
             worktree or included config file), so GitDesktop can't turn it on here."
        ))),
        _ => Ok(()),
    }
}

/// Agent-session prefix; [`refuse_session_branch_name`] guards case-insensitively, and
/// `mcp_server::write_git::ensure_not_session_branch` delegates to it, so the MCP tools
/// refuse with the same text.
pub(crate) const SESSION_BRANCH_PREFIX: &str = "gd/session/";

/// What a completed rename reports beyond success.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameBranchOutcome {
    /// Set when the local-PR migration could not complete after git renamed the
    /// branch — the rename itself succeeded. Shown verbatim in the GUI success
    /// toast's description and appended to the MCP text.
    pub warning: Option<String>,
}

pub(crate) fn is_session_branch_name(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with(SESSION_BRANCH_PREFIX)
}

/// Refuse names whose branches or worktrees would vanish from every filtered surface.
pub(crate) fn refuse_session_branch_name(name: &str) -> AppResult<()> {
    if is_session_branch_name(name) {
        return Err(AppError::InvalidArgument(format!(
            "\"{name}\" is in gd/session/, which is reserved for agent sessions — choose another name."
        )));
    }
    Ok(())
}

/// Refuses a rename into or out of the agent-session namespace, compared
/// case-insensitively: a case-insensitive filesystem can land `GD/Session/x` inside
/// an existing `gd/session/` ref folder.
fn refuse_session_rename(old_name: &str, new_name: &str) -> AppResult<()> {
    if is_session_branch_name(old_name) {
        return Err(AppError::InvalidArgument(format!(
            "\"{old_name}\" is an agent-session branch — renaming it would break its session's Resume."
        )));
    }
    refuse_session_branch_name(new_name)
}

#[tauri::command]
pub async fn git_rename_branch(
    state: State<'_, AppState>,
    repo_path: String,
    old_name: String,
    new_name: String,
) -> AppResult<RenameBranchOutcome> {
    git_rename_branch_core(&state, repo_path, old_name, new_name).await
}

pub(crate) async fn git_rename_branch_core(
    state: &AppState,
    repo_path: String,
    old_name: String,
    new_name: String,
) -> AppResult<RenameBranchOutcome> {
    // git stores and renames a branch literally named `@`, and this is its only in-app exit,
    // so the old name passes it; `@{…}`, which git expands to another branch, is refused.
    validate_ref_name(&old_name)?;
    if old_name != "@" {
        validate_branch_name(&old_name)?;
    }
    validate_branch_name(&new_name)?;
    refuse_session_rename(&old_name, &new_name)?;
    refuse_while_publishing(&repo_path, &old_name).await?;
    // `branch -m` does NOT refuse a branch checked out elsewhere — it retargets that
    // worktree's HEAD silently, which under a running update means renaming the branch
    // out from under it.
    crate::git::update_marker::refuse_if_branch_updating(state, &repo_path, &old_name).await?;
    // Ordering and store atomicity are separate locks. The rename lock is per repository
    // identity and spans the git rename and both app-data moves, so chained renames (a→b,
    // b→c) from any process apply their moves in order. It is an OS file lock because it
    // must outlive git's waits and timeouts with no stale age a waiter could evict it by; the
    // OS frees it if its holder dies. Each move takes its store's own lock pair only for its
    // write, never across git. Contention refuses before git runs; an unusable lock file
    // falls back to in-process ordering (`lock_for_rename` says why).
    let keyed = match crate::git::repo::repo_identity(&repo_path).await {
        Ok(identity) => {
            let ordered = crate::local_prs::lock_for_rename(&identity).await?;
            Ok((identity, ordered))
        }
        // No identity means no key and no lock; both moves need that identity too, so
        // each skips, logged, and the local-PR one warns.
        Err(e) => Err(e),
    };
    // The lock's wait reopens the window the check above guards; the publish hold is
    // re-checked inside the minting hold, past both waits.
    crate::git::update_marker::refuse_if_branch_updating(state, &repo_path, &old_name).await?;
    #[cfg(test)]
    rename_phase(RenamePhase::BeforeGit).await;
    let repo = repo_path.as_str();
    let (old_section, new_section) = (format!("branch.{old_name}"), format!("branch.{new_name}"));
    let mode = rename_mode(repo, &old_name, &new_name).await?;
    let renamed = run_minting_write(
        state,
        repo,
        &["branch", mode, "--", &old_name, &new_name],
        &new_name,
        Some(&old_name),
        |out, held| async move {
            if out.code == 0 || !out.stderr.contains(RENAMED_CONFIG_LEFT_BEHIND) {
                return Ok(out);
            }
            let moved = ["config", "--rename-section", &old_section, &new_section];
            if repair_branch_section(&held, repo, &moved).await {
                return Ok(GitOutput { code: 0, ..out });
            }
            Ok(out)
        },
    )
    .await?;
    full_failure_verdict(renamed)?;
    #[cfg(test)]
    rename_phase(RenamePhase::BeforeMoves).await;
    // Carry the branch's reviewer note over to the new name, keyed by the same identity
    // the MCP deposit path uses. Strictly after the `?` and best-effort: the rename has
    // already happened, so a store failure must never be reported as a failed rename.
    // This is the one seam both in-app renames share (the GUI command and the MCP
    // `rename_branch` tool); a terminal `git branch -m` has no hook, the same accepted
    // gap as the commit-draft migration. Cold-start test mode is out of reach too — the
    // GUI aliases its store file there (`storeName` in src/lib/test-mode.ts).
    let note_result = match &keyed {
        Ok((identity, _)) => crate::review_notes::rename_branch(identity, &old_name, &new_name)
            .await
            .map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    if let Err(e) = note_result {
        eprintln!("gitdesktop: reviewer-note rename failed (branch renamed anyway): {e}");
    }
    // Open local PRs follow the rename, under the same best-effort rule and the same two
    // gaps (terminal renames; a cold-start instance's aliased store). A failed write may
    // have counted nothing, so the warning names no number.
    let pr_result = match &keyed {
        Ok((identity, ordered)) => {
            crate::local_prs::rename_branch(ordered, identity, &repo_path, &old_name, &new_name)
                .await
                .map_err(|e| e.to_string())
        }
        Err(e) => Err(e.to_string()),
    };
    drop(keyed);
    let warning = match pr_result {
        Ok(_) => None,
        Err(e) => {
            eprintln!("gitdesktop: local-PR rename migration failed (branch renamed anyway): {e}");
            Some(format!(
                "Some local pull requests may still point at {old_name}."
            ))
        }
    };
    Ok(RenameBranchOutcome { warning })
}

/// `-M` only for a case-only rename of the last name part (the disk keeps a shared
/// directory's spelling, so a directory change keeps `-m` and git's refusal), where ref
/// names can alias ([`refs_can_alias_strict`]; a failed probe keeps `-m`) and no exact ref
/// [`exact_branch_tip`] has the new name: git reads the old loose ref under the new spelling
/// and `-m` refuses it. [`run_minting_write`] re-reads the exact ref inside its hold and
/// falls back to `-m`, so a branch of the new spelling created since this read is refused.
async fn rename_mode(repo_path: &str, old_name: &str, new_name: &str) -> AppResult<&'static str> {
    let (old_dir, new_dir) = (old_name.rsplit_once('/'), new_name.rsplit_once('/'));
    if !is_case_only_rename(old_name, Some(new_name))
        || old_dir.map(|(dir, _)| dir) != new_dir.map(|(dir, _)| dir)
        || !refs_can_alias_strict(repo_path).await.unwrap_or(false)
        || exact_branch_tip(repo_path, new_name).await?.is_some()
    {
        return Ok("-m");
    }
    Ok("-M")
}

/// Where a rename can be held from a test: rename lock taken but git not yet run, and git
/// done but neither app-data move run.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RenamePhase {
    BeforeGit,
    BeforeMoves,
}

#[cfg(test)]
type RenamePhaseHook = std::sync::Arc<
    dyn Fn(RenamePhase) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

#[cfg(test)]
tokio::task_local! {
    /// Awaited at each [`RenamePhase`] of the rename it is scoped to, so a test can hold
    /// that rename there while a second one races it.
    static RENAME_PHASE_HOOK: RenamePhaseHook;
}

#[cfg(test)]
async fn rename_phase(phase: RenamePhase) {
    if let Ok(wait) = RENAME_PHASE_HOOK.try_with(|hook| hook(phase)) {
        wait.await;
    }
}

/// If `name` is checked out in a LINKED worktree (one other than `repo_path`
/// itself), returns that worktree's path, which a caller turns into an actionable
/// message. Best-effort: a `worktree list` failure yields `None`, so in a branch delete
/// this probe only steers the pre-hold sweep and its message; the delete's guard is the
/// under-hold [`linked_holder_in`] over a checked listing. The `repo_path` checkout is
/// excluded so its *current* branch isn't misreported as held by a linked worktree.
///
/// The self-exclusion compares CANONICALIZED spellings (`worktree::canonical_wt_path`, as
/// `ops::is_listed_worktree` does): git's porcelain prints the resolved path, so a caller
/// holding macOS's `/var/…` symlink or a Windows 8.3 short name (`RUNNER~1`)
/// would otherwise fail to recognize its OWN checkout and report the branch as
/// held by a "linked" worktree that is really this one — sending the caller to
/// the wrong remedy. A path that no longer resolves falls back to the raw
/// spelling, so the normalize-only compare stays as a second chance; either
/// match excludes, which can only ever remove a false positive.
async fn worktree_holding_branch(repo_path: &str, name: &str) -> Option<String> {
    worktree_holding_branch_checked(repo_path, name)
        .await
        .ok()
        .flatten()
}

/// [`worktree_holding_branch`] with a failed `worktree list` reported as an `Err`, for
/// a caller with no git refusal behind it to fall back on.
async fn worktree_holding_branch_checked(repo_path: &str, name: &str) -> AppResult<Option<String>> {
    let porcelain = list_worktrees_porcelain(repo_path).await?;
    Ok(linked_holder_in(&porcelain, repo_path, name).await)
}

async fn list_worktrees_porcelain(repo_path: &str) -> AppResult<String> {
    let listed = run_git(
        Some(repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(listed.stdout_lossy())
}

/// [`worktree_holding_branch_checked`]'s lookup over a `worktree list --porcelain` text
/// the caller already read, matching by [`holds_branch`].
async fn linked_holder_in(porcelain: &str, repo_path: &str, name: &str) -> Option<String> {
    use crate::git::ops::{parse_worktree_branches, parse_worktree_paths};
    // Both parsers emit one entry per `worktree …` stanza in the same list order,
    // so the zip is length-safe and pairs each worktree's path with its branch.
    let candidates: Vec<(String, String)> = parse_worktree_paths(porcelain)
        .into_iter()
        .zip(parse_worktree_branches(porcelain))
        .filter(|(path, branch)| {
            eq_ignoring_case(branch, name) && !is_this_checkout(repo_path, path)
        })
        .collect();
    for (path, branch) in candidates {
        if holds_branch(repo_path, &branch, name).await {
            return Some(path);
        }
    }
    None
}

/// Whether the listed worktree `path` is `repo_path`'s own checkout.
fn is_this_checkout(repo_path: &str, path: &str) -> bool {
    use crate::git::worktree::{canonical_wt_path, normalize_wt_path};
    normalize_wt_path(path) == normalize_wt_path(repo_path)
        || canonical_wt_path(path) == canonical_wt_path(repo_path)
}

/// Whether two branch spellings are equal under Unicode lowercasing, as NTFS folds
/// non-ASCII letters too. Folded per character: a filesystem's table has no context
/// rules, and `str::to_lowercase`'s final-sigma rule would pair the wrong names.
pub(crate) fn eq_ignoring_case(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
        || a.chars()
            .flat_map(char::to_lowercase)
            .eq(b.chars().flat_map(char::to_lowercase))
}

/// Whether a checkout on `holder` holds the branch `target`: the same name, or one equal
/// ignoring case by [`holder_spelling_holds`]'s verdict over the holder's exact ref and
/// its loose read (`show-ref --verify`). A failed spawn of either read counts as holding;
/// a `show-ref` that exits non-zero reads no ref. Every compare that decides whether a
/// ref may be deleted or moved without its checkout uses this rule, never a plain
/// equality; a write through a holder's checkout also needs its HEAD at the branch's tip
/// read under that checkout's hold, a spelling [`writes_through_another_spelling`]
/// accepts, and for another spelling a store whose names alias
/// ([`spelling_reaches_branch`]).
pub(crate) async fn holds_branch(repo_path: &str, holder: &str, target: &str) -> bool {
    if holder == target {
        return true;
    }
    if !eq_ignoring_case(holder, target) {
        return false;
    }
    let Ok(exact) = exact_branch_tip(repo_path, holder).await else {
        return true;
    };
    let shown = shown_branch_tip(repo_path, holder).await;
    let can_alias = exact.is_none() && matches!(shown, Ok(None)) && refs_can_alias(repo_path).await;
    holder_spelling_holds(exact.as_deref(), &shown, can_alias)
}

/// [`holds_branch`]'s verdict for a case-only holder spelling. With an exact ref it holds
/// unless its loose read is that same tip. Without one it holds when that read finds a ref,
/// fails to spawn, or finds none where refs can alias (`can_alias`, read only then): a
/// bare write of the target makes a loose file that the holder's spelling then reads, as
/// for a target stored packed after the checkout.
fn holder_spelling_holds(
    exact: Option<&str>,
    shown: &AppResult<Option<String>>,
    can_alias: bool,
) -> bool {
    match (exact, shown) {
        (Some(exact), Ok(Some(shown))) => shown != exact,
        (Some(_), _) => true,
        (None, Ok(None)) => can_alias,
        (None, _) => true,
    }
}

/// The refusal for a checkout, this one included, whose rebase or bisect is working on
/// `branch`, or whose `rebase --update-refs` will move it. Such a checkout usually reads
/// as detached in `worktree list` (a bisect before its first good commit, or started with
/// `--no-checkout`, still lists on the branch), and `update-ref` moves the ref under it
/// where `branch -f` refuses, so every admin dir under the common dir is read the way git's
/// own checked-out test reads them. Fails closed: a marker that exists but can't be read
/// is an `Err`. `verb` ends the sentence ("before {verb} {branch}.").
pub(crate) async fn branch_operation_refusal(
    repo_path: &str,
    branch: &str,
    verb: &str,
) -> AppResult<Option<String>> {
    let dirs = read_git_dirs(repo_path).await?;
    let porcelain = list_worktrees_porcelain(repo_path).await?;
    operation_refusal(repo_path, &porcelain, &dirs, branch, verb).await
}

/// [`operation_refusal_in`] with each case-only spelling it stops at resolved through
/// [`holds_branch`]. With none recorded, which is the common path, it spawns nothing.
async fn operation_refusal(
    repo_path: &str,
    porcelain: &str,
    dirs: &GitDirs,
    branch: &str,
    verb: &str,
) -> AppResult<Option<String>> {
    // Capped, since markers are re-read each round and one rewritten meanwhile could
    // keep minting new spellings; hitting the cap fails closed.
    let mut resolved = Vec::new();
    for _ in 0..OPERATION_RESOLVE_ROUNDS {
        match operation_refusal_in(porcelain, dirs, branch, verb, &resolved)? {
            OperationCheck::Clear => return Ok(None),
            OperationCheck::Refuse(refusal) => return Ok(Some(refusal)),
            OperationCheck::Resolve(spelling) => {
                let holds = holds_branch(repo_path, &spelling, branch).await;
                resolved.push((spelling, holds));
            }
        }
    }
    Err(AppError::Command(format!(
        "Couldn't tell whether a rebase or bisect is working on {branch}: too many \
         spellings of it are recorded. Nothing was changed."
    )))
}

/// How many scans [`operation_refusal`] runs; each scan that stops on a case-only
/// spelling resolves it, and the last one gives up after resolving, without another scan.
const OPERATION_RESOLVE_ROUNDS: usize = 16;

/// What [`operation_refusal_in`] found.
enum OperationCheck {
    Clear,
    Refuse(String),
    /// A recorded spelling equal to the branch ignoring case and not in `resolved` yet:
    /// the scan stops there; the caller resolves it through [`holds_branch`] and scans
    /// again with the verdict.
    Resolve(String),
}

/// The admin dirs [`branch_operation_refusal`] reads markers under: the common dir, and
/// this checkout's own admin dir in canonical form.
struct GitDirs {
    common: std::path::PathBuf,
    own_admin: String,
}

/// Both git dirs from one `rev-parse`, which prints them one per line in argument order.
async fn read_git_dirs(repo_path: &str) -> AppResult<GitDirs> {
    let out = run_git(
        Some(repo_path),
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--absolute-git-dir",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    parse_git_dirs(&out.stdout_lossy())
}

/// [`read_git_dirs`]'s two lines; an empty, missing or extra line is the `Err`. git prints
/// a path's newline unescaped, so more than two lines can't be split into the two dirs.
fn parse_git_dirs(text: &str) -> AppResult<GitDirs> {
    let text = text.strip_suffix('\n').unwrap_or(text);
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    match lines.as_slice() {
        [common, own_admin] if !common.is_empty() && !own_admin.is_empty() => Ok(GitDirs {
            common: std::path::PathBuf::from(common),
            own_admin: crate::git::worktree::canonical_wt_path(own_admin),
        }),
        _ => Err(AppError::Command(
            "git did not report this checkout's git directory.".to_string(),
        )),
    }
}

/// [`branch_operation_refusal`] over a `worktree list --porcelain` text and git dirs the
/// caller already read. A recorded name matches `branch` when it is the same, or a
/// case-only spelling whose [`holds_branch`] verdict `resolved` carries as true.
fn operation_refusal_in(
    porcelain: &str,
    dirs: &GitDirs,
    branch: &str,
    verb: &str,
    resolved: &[(String, bool)],
) -> AppResult<OperationCheck> {
    use crate::git::ops::parse_worktree_paths;
    use crate::git::worktree::canonical_wt_path;
    let GitDirs { common, own_admin } = dirs;
    // Checkout paths are shown in git's own spelling: the porcelain lists the main
    // checkout first, and a linked one is matched to its entry by canonical path.
    let listed = parse_worktree_paths(porcelain);
    // git reads the head-name, update-refs and BISECT_START markers back stripping only
    // the line ending; a branch name may start or end in non-ASCII whitespace, which
    // `trim` would drop.
    let read = |path: std::path::PathBuf| -> AppResult<Option<String>> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(Some(text.trim_end_matches(['\r', '\n']).to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    };
    // The main checkout's admin dir is the common dir; each linked one's sits under
    // `worktrees/`, its `gitdir` file naming the checkout's `.git` (maybe relative).
    let mut admins = vec![(common.clone(), listed.first().cloned())];
    match std::fs::read_dir(common.join("worktrees")) {
        Ok(entries) => {
            for entry in entries {
                let admin = entry?.path();
                // git's own listing skips anything that isn't a directory.
                match std::fs::metadata(&admin) {
                    Ok(meta) if meta.is_dir() => {}
                    Ok(_) => continue,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e.into()),
                }
                let checkout = read(admin.join("gitdir"))?
                    .and_then(|dot_git| admin.join(dot_git).parent().map(|p| p.to_path_buf()))
                    .map(|path| {
                        let path = path.to_string_lossy().into_owned();
                        let key = canonical_wt_path(&path);
                        listed
                            .iter()
                            .find(|listed| canonical_wt_path(listed) == key)
                            .cloned()
                            .unwrap_or(path)
                    });
                admins.push((admin, checkout));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    // `Err(spelling)`: a case-only spelling with no verdict yet.
    let matches = |name: &str| -> Result<bool, String> {
        if name == branch {
            Ok(true)
        } else if eq_ignoring_case(name, branch) {
            resolved
                .iter()
                .find(|(n, _)| n == name)
                .map(|&(_, holds)| holds)
                .ok_or_else(|| name.to_string())
        } else {
            Ok(false)
        }
    };
    let on_branch = |line: &str| line.strip_prefix("refs/heads/").map_or(Ok(false), matches);
    for (admin, checkout) in admins {
        let rebase_merge = admin.join("rebase-merge");
        // The apply backend's head-name is read only when the merge backend's misses.
        let mut rebasing = false;
        for head_name in [
            rebase_merge.join("head-name"),
            admin.join("rebase-apply").join("head-name"),
        ] {
            if let Some(line) = read(head_name)? {
                match on_branch(&line) {
                    Ok(hit) => rebasing = hit,
                    Err(spelling) => return Ok(OperationCheck::Resolve(spelling)),
                }
            }
            if rebasing {
                break;
            }
        }
        // Triplets of lines: the ref, then its before and after oids.
        let mut updating = false;
        for line in read(rebase_merge.join("update-refs"))?
            .unwrap_or_default()
            .lines()
            .step_by(3)
        {
            match on_branch(line) {
                Ok(false) => {}
                Ok(true) => {
                    updating = true;
                    break;
                }
                Err(spelling) => return Ok(OperationCheck::Resolve(spelling)),
            }
        }
        // `BISECT_START` holds the short name the bisect started on.
        let bisecting = match read(admin.join("BISECT_START"))?.map(|name| matches(&name)) {
            None => false,
            Some(Ok(hit)) => hit,
            Some(Err(spelling)) => return Ok(OperationCheck::Resolve(spelling)),
        };
        if !rebasing && !updating && !bisecting {
            continue;
        }
        let place = if canonical_wt_path(&admin.to_string_lossy()) == *own_admin {
            "here".to_string()
        } else {
            let at = checkout.unwrap_or_else(|| admin.to_string_lossy().into_owned());
            format!("in the worktree at {at}")
        };
        let (what, remedy) = match (rebasing, updating) {
            (true, _) => ("is being rebased", "finish or abort that rebase"),
            (false, true) => ("is part of a rebase", "finish or abort that rebase"),
            (false, false) => ("is being bisected", "end that bisect (git bisect reset)"),
        };
        return Ok(OperationCheck::Refuse(format!(
            "{branch} {what} {place} — {remedy} before {verb} {branch}."
        )));
    }
    Ok(OperationCheck::Clear)
}

/// Arbitrates a `worktree_holding_branch` hit that turns out to be an UPDATE's hidden
/// `gd-update-*` checkout. `true` means "cleared — re-probe"; `false` leaves the
/// caller's own message to speak, which is also the answer whenever the marker proves
/// nothing: an unreadable lock, or a checkout from a pre-marker build that may still be
/// mid-update — and, before any of that, a root set this process cannot resolve. Only a
/// lock that EXISTS and is acquirable authorizes the age-free removal, and only a HELD
/// one authorizes a refusal.
async fn clear_update_holder(
    state: &AppState,
    repo_path: &str,
    branch: &str,
    holder: &str,
) -> AppResult<bool> {
    use crate::git::update_marker::{self as marker, LockProbe};
    // Root-scoped: a `gd-update-*` worktree the USER made, outside our app-data root, is
    // their own and takes the ordinary path however its neighbours look. Resolved through
    // the cache the claim below uses, so one call never arbitrates over two root sets.
    let Ok(roots) = marker::roots_for_cached(state, repo_path).await else {
        return Ok(false);
    };
    if !marker::is_managed_update_worktree_in(&roots, holder) {
        return Ok(false);
    }
    match marker::update_worktree_probe(holder) {
        LockProbe::Live => Err(marker::branch_update_refusal(branch)),
        LockProbe::Released => {
            if marker::claim_dead_update_worktree(state, repo_path, holder).await {
                return Ok(true);
            }
            // Provably dead but unclaimed (the admin domain was busy, the lock no longer
            // read released, or its removal failed and kept the marker for a retry) — the
            // hidden path is nothing the user can act on, so name the state instead.
            Err(marker::interrupted_update_refusal(branch))
        }
        LockProbe::Missing | LockProbe::Unknown => Ok(false),
    }
}

/// [`clear_update_holder`]'s no-claim verdict for a re-probed holder, used under a
/// working-tree hold or after that function's sweep already ran: a claim's removal
/// runs in the admin domain and can take minutes. `None` leaves the caller's own
/// message to speak, as that function's `Ok(false)` does; a dead update's checkout
/// reads as interrupted, left for a retry to sweep.
async fn update_holder_refusal(
    state: &AppState,
    repo_path: &str,
    branch: &str,
    holder: &str,
) -> Option<AppError> {
    use crate::git::update_marker::{self as marker, LockProbe};
    let roots = marker::roots_for_cached(state, repo_path).await.ok()?;
    if !marker::is_managed_update_worktree_in(&roots, holder) {
        return None;
    }
    match marker::update_worktree_probe(holder) {
        LockProbe::Live => Some(marker::branch_update_refusal(branch)),
        LockProbe::Released => Some(marker::interrupted_update_refusal(branch)),
        LockProbe::Missing | LockProbe::Unknown => None,
    }
}

/// What a branch delete did. `TipMoved` is returned only to a caller that pinned the
/// tip, and under it nothing was deleted. The TS mirror is `DeleteBranchOutcome` in
/// `src/lib/git/api/branches.ts`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DeleteBranchOutcome {
    /// `tip` is the commit the ref pointed at when it was deleted, the one Restore needs;
    /// `kept_local` and `upstream` are its Keep local mark and upstream as read under the
    /// delete's lock (see [`RefDeleteAt::Deleted`]).
    Deleted {
        tip: String,
        kept_local: bool,
        upstream: Option<String>,
    },
    TipMoved {
        expected: String,
        actual: String,
    },
}

/// A caller-supplied tip pin in the form the compare reads: a full object id (40 or 64
/// hex), lowercased. `update-ref` resolves a short old value as a rev and an empty one
/// skips its compare, so anything else is refused before git runs.
pub(crate) fn full_object_id(id: &str) -> AppResult<String> {
    if !matches!(id.len(), 40 | 64) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidArgument(
            "expected tip must be a full commit id (40 or 64 hex characters)".into(),
        ));
    }
    Ok(id.to_ascii_lowercase())
}

/// Force-deletes a local branch (the UI confirms first, GitHub Desktop style).
#[tauri::command]
pub async fn git_delete_branch(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    expected_tip: Option<String>,
) -> AppResult<DeleteBranchOutcome> {
    git_delete_branch_core(&state, repo_path, name, expected_tip).await
}

/// The refusal for a branch checked out in a linked worktree; a test pins its wording.
fn checked_out_elsewhere(name: &str, path: &str) -> AppError {
    AppError::Command(format!(
        "{name} is checked out in the worktree at {path} — remove that worktree \
         (or switch it to another branch) before deleting {name}."
    ))
}

pub(crate) async fn git_delete_branch_core(
    state: &AppState,
    repo_path: String,
    name: String,
    expected_tip: Option<String>,
) -> AppResult<DeleteBranchOutcome> {
    git_delete_branch_within(state, repo_path, name, expected_tip, LOCK_WAIT_TIMEOUT).await
}

/// The label of both of the delete's holds, so a waiter behind either reads one name.
const BRANCH_DELETE_HOLDER: &str = "a branch delete";

/// [`git_delete_branch_core`] with both domain waits bounded by `lock_wait`, so a test
/// holding a domain passes `Duration::ZERO` to get `Busy` at once.
pub(crate) async fn git_delete_branch_within(
    state: &AppState,
    repo_path: String,
    name: String,
    expected_tip: Option<String>,
    lock_wait: std::time::Duration,
) -> AppResult<DeleteBranchOutcome> {
    validate_branch_name(&name)?;
    let expected = expected_tip.as_deref().map(full_object_id).transpose()?;
    // Two halves of one window: the marker covers an update that has minted but not yet
    // registered its checkout (the `worktree add` is the long part), the porcelain arm
    // below covers it once registered. Heal-free — the healing lives in the claim arm.
    crate::git::update_marker::refuse_if_branch_updating_no_heal(state, &repo_path, &name).await?;
    // Best-effort pre-hold probe, so a dead update's hidden checkout is swept OUTSIDE the
    // hold (its removal runs in the admin domain); the guards re-run under the hold.
    if let Some(path) = worktree_holding_branch(&repo_path, &name).await {
        if !clear_update_holder(state, &repo_path, &name, &path).await? {
            return Err(checked_out_elsewhere(&name, &path));
        }
        // A holder found there after the sweep gets the update refusal when its marker
        // proves it live or dead; otherwise the caller's own message.
        if let Some(path) = worktree_holding_branch(&repo_path, &name).await {
            return Err(update_holder_refusal(state, &repo_path, &name, &path)
                .await
                .unwrap_or_else(|| checked_out_elsewhere(&name, &path)));
        }
    }

    // ADMIN, then WORKING-TREE, both held across the tip read, the guards and the
    // delete; the primitive takes the config-write mutex inside them, after the tip read.
    // ADMIN keeps a worktree add from checking the branch out meanwhile. Taken after the
    // sweep, whose claim try-acquires ADMIN and would lose to this hold. Every spawn
    // under them is lock-free, since `run_git_mutating*` re-acquires these domains.
    let repo = repo_path.as_str();
    let admin = state.worktree_admin_lock(repo).await;
    let _admin = acquire_repo_lock(&admin, lock_wait, BRANCH_DELETE_HOLDER).await?;
    let domain = state.working_tree_lock(repo).await;
    let _guard = acquire_repo_lock(&domain, lock_wait, BRANCH_DELETE_HOLDER).await?;
    // git's own text for a missing branch.
    let not_found = || AppError::Git {
        code: 1,
        stderr: format!("error: branch '{name}' not found"),
    };
    let Some(tip) = exact_branch_tip(repo, &name).await? else {
        return Err(not_found());
    };
    if let Some(expected) = expected.as_ref().filter(|expected| **expected != tip) {
        return Ok(DeleteBranchOutcome::TipMoved {
            expected: expected.clone(),
            actual: tip,
        });
    }
    match delete_branch_ref_at(state, repo, &name, &tip).await? {
        RefDeleteAt::Deleted {
            kept_local,
            upstream,
        } => Ok(DeleteBranchOutcome::Deleted {
            tip,
            kept_local,
            upstream,
        }),
        RefDeleteAt::Moved { actual: None } => Err(not_found()),
        RefDeleteAt::Moved {
            actual: Some(actual),
        } => match expected {
            Some(expected) => Ok(DeleteBranchOutcome::TipMoved { expected, actual }),
            // KEEP IN STEP: the "… — nothing was <verb>." family of the reset's
            // ref-move refusal below, ops.rs's `RESET_HEAD_MOVED` and commit.rs's
            // `UNDO_HEAD_MOVED`.
            None => Err(AppError::Git {
                code: 1,
                stderr: format!("{name} changed since you confirmed — nothing was deleted."),
            }),
        },
    }
}

/// The commit `refs/heads/<name>` points at, `None` only from a run that listed no ref
/// of exactly that name; a failed run, or the ref listed without a commit, is an `Err`.
/// Unlike `rev-parse --verify`, the pattern takes neither a case variant nor the
/// `refs/heads/refs/heads/<name>` fallback, but it lists `<name>/…` children, so only the
/// exact line counts. A symbolic ref reads as its target's commit; a dangling one, and a
/// broken loose ref (git only warns and exits 0), read as absent.
pub(crate) async fn exact_branch_tip(repo_path: &str, name: &str) -> AppResult<Option<String>> {
    let full_ref = branch_full_ref(name)?;
    let out = run_git(
        Some(repo_path),
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)",
            &full_ref,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match exact_ref_field(&out.stdout_lossy(), &full_ref) {
        None => Ok(None),
        Some("") => Err(AppError::Command(format!(
            "git listed {full_ref} without a commit id."
        ))),
        Some(oid) => Ok(Some(oid.to_string())),
    }
}

/// The field after the NUL on the `for-each-ref` line whose refname is exactly
/// `full_ref`. An exact line without a NUL reads as an empty field, so the caller
/// refuses it rather than skipping it.
fn exact_ref_field<'a>(stdout: &'a str, full_ref: &str) -> Option<&'a str> {
    stdout.lines().find_map(|line| {
        let (refname, field) = line.split_once('\0').unwrap_or((line, ""));
        (refname == full_ref).then_some(field)
    })
}

/// `refs/heads/<name>` for the delete's tip read and its `update-ref` target, never a
/// refspec; the name is validated here as well as at every entry point, as a branch
/// name, since a rev expression (`feat~1`) would resolve under `refs/heads/` to another
/// commit.
fn branch_full_ref(name: &str) -> AppResult<String> {
    validate_branch_name(name)?;
    Ok(format!("refs/heads/{name}"))
}

/// The display form of `full_ref`'s upstream, from the exact `for-each-ref` line (the
/// pattern also lists `<name>/…` children); `None` for a failed run, no exact line or
/// no upstream. The full atom, never `:short`, which a same-named tag turns into
/// `remotes/<remote>/<branch>`.
async fn deleted_branch_upstream(repo_path: &str, full_ref: &str) -> Option<String> {
    let out = run_git(
        Some(repo_path),
        &[
            "for-each-ref",
            "--format=%(refname)%00%(upstream)",
            full_ref,
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    exact_ref_field(&out.stdout_lossy(), full_ref).and_then(upstream_display)
}

/// A full upstream ref stripped of exactly `refs/remotes/`, else exactly `refs/heads/`
/// (a local upstream); any other shape, or nothing left after the strip, is `None`.
fn upstream_display(full: &str) -> Option<String> {
    full.strip_prefix("refs/remotes/")
        .or_else(|| full.strip_prefix("refs/heads/"))
        .filter(|rest| !rest.is_empty())
        .map(str::to_string)
}

/// What [`delete_branch_ref_at`] did with the ref.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RefDeleteAt {
    /// Its Keep local mark (`true` when the read failed) and its upstream's display form
    /// (`None` when unset or unreadable), read after the first guard pass and before the
    /// delete, under the config-write mutex.
    Deleted {
        kept_local: bool,
        upstream: Option<String>,
    },
    /// The ref no longer pointed at the tip, so nothing was deleted; `None` = it is gone.
    Moved { actual: Option<String> },
}

/// Deletes `refs/heads/<name>` only while it still points at `tip`, then drops its
/// `branch.<name>` section. The caller holds ADMIN, which excludes the app's PR checkout
/// switches; the guards run under the config-write mutex its other plain switches hold,
/// before the delete, where a hit or a failed read refuses, and after it, where either
/// puts the ref back at `tip`. Out of reach: gh's `pr checkout`, the MCP server, a second
/// instance and a terminal. A failed put-back keeps the section for the next commit of a
/// checkout left unborn on the exact name: the put-back runs only on a failed read or the
/// name in use: claimed, checked out, under an operation, or a checkout's HEAD moved off `tip`.
pub(crate) async fn delete_branch_ref_at(
    state: &AppState,
    repo_path: &str,
    name: &str,
    tip: &str,
) -> AppResult<RefDeleteAt> {
    refuse_while_publishing(repo_path, name).await?;
    #[cfg(test)]
    delete_phase(DeletePhase::BeforeGuards).await;
    // `--no-deref`: on a symbolic ref git would otherwise delete the TARGET branch and
    // leave the alias dangling. The old-value compare still reads the resolved commit.
    let full_ref = branch_full_ref(name)?;
    // The guards run inside the mutex, whose wait is unbounded, so a checkout landing
    // during that wait is still seen; each is a read that takes no lock of its own.
    with_config_write_lock(repo_path, |held| async move {
        // The mutex wait reopens the publish window the check above guards.
        refuse_while_publishing(repo_path, name).await?;
        let (mut git_dirs, mut heads) = (None, None);
        refuse_if_branch_in_use(state, repo_path, name, tip, &mut git_dirs, &mut heads).await?;
        #[cfg(test)]
        delete_phase(DeletePhase::BeforeDelete).await;
        // What the delete removes, read by name after the guards and under the mutex;
        // neither read can fail the delete.
        let kept_local = branch_keep_local(repo_path, name).await.unwrap_or(true);
        let upstream = deleted_branch_upstream(repo_path, &full_ref).await;
        let out = run_git_raw(
            Some(repo_path),
            &["update-ref", "--no-deref", "-d", &full_ref, tip],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if out.code == 0 {
            #[cfg(test)]
            delete_phase(DeletePhase::AfterDelete).await;
            // No lock excludes a checkout by another process (the out-of-reach list
            // above), so the reads run again; a failed read counts as a hit.
            if let Err(refusal) =
                refuse_if_branch_in_use(state, repo_path, name, tip, &mut git_dirs, &mut heads)
                    .await
            {
                if restore_deleted_ref(repo_path, &full_ref, tip, &refusal).await {
                    return Err(refusal);
                }
                // The section stays (see the contract above).
                return Ok(RefDeleteAt::Deleted {
                    kept_local,
                    upstream,
                });
            }
            // `update-ref -d` leaves `branch.<name>.*` behind, where `branch -D` drops it.
            remove_deleted_branch_section(&held, repo_path, name).await;
            return Ok(RefDeleteAt::Deleted {
                kept_local,
                upstream,
            });
        }
        // A failed delete reads as moved only when the ref really moved; a stale ref
        // `.lock` keeps git's own error.
        match exact_branch_tip(repo_path, name).await? {
            Some(now) if now == tip => Err(AppError::Git {
                code: out.code,
                stderr: out.full_failure_text(),
            }),
            actual => Ok(RefDeleteAt::Moved { actual }),
        }
    })
    .await
}

/// [`delete_branch_ref_at`]'s guards, in order: an update marker claiming `name`, a
/// linked worktree holding it, the current branch, a checkout whose HEAD was `tip` in the
/// previous pass and changed since, or that arrived on or switched onto a case variant of
/// the name, a rebase or bisect working on it. Shared by both passes so they refuse alike;
/// a failed read is the `Err` too. The marker read heals nothing and reads no ref. Each
/// pass lists the worktrees afresh; `git_dirs` is resolved by the first pass that reaches
/// the operation check and reused after it, and `heads` carries each pass's stanzas
/// (path, HEAD and branch line) to the next.
async fn refuse_if_branch_in_use(
    state: &AppState,
    repo_path: &str,
    name: &str,
    tip: &str,
    git_dirs: &mut Option<GitDirs>,
    heads: &mut Option<Vec<ListedHead>>,
) -> AppResult<()> {
    crate::git::update_marker::refuse_if_branch_updating_no_heal(state, repo_path, name).await?;
    let porcelain = list_worktrees_porcelain(repo_path).await?;
    let before = heads.replace(worktree_heads(&porcelain));
    let here = || {
        AppError::Command(format!(
            "{name} is checked out here — switch to another branch before deleting {name}."
        ))
    };
    // Never swept here: a holder that registered or died since the caller's probe
    // refuses, and a retry sweeps a dead one.
    if let Some(path) = linked_holder_in(&porcelain, repo_path, name).await {
        return Err(update_holder_refusal(state, repo_path, name, &path)
            .await
            .unwrap_or_else(|| checked_out_elsewhere(name, &path)));
    }
    if let Some(current) = current_branch_name(repo_path).await? {
        if holds_branch(repo_path, &current, name).await {
            return Err(here());
        }
    }
    // A checkout that was at `tip` and whose HEAD changed across the delete, or that
    // arrived on a case variant of the name, may have been reading the deleted ref under a
    // spelling no name rule saw. An unrelated checkout at that same commit that commits
    // inside the window refuses too, which fails safe.
    if let (Some(before), Some(after)) = (before.as_deref(), heads.as_deref()) {
        if let Some((path, how)) = head_moved_in(before, after, name, tip) {
            let this = is_this_checkout(repo_path, path);
            return Err(match (how, this) {
                (HeadMove::Arrived, true) => here(),
                (HeadMove::Arrived, false) => checked_out_elsewhere(name, path),
                (HeadMove::Moved, true) => AppError::Command(format!(
                    "{name} wasn't deleted: this checkout moved to another commit while the \
                     delete ran, and it may have been using {name}. Try again."
                )),
                (HeadMove::Moved, false) => AppError::Command(format!(
                    "{name} wasn't deleted: the checkout at {path} moved to another commit \
                     while the delete ran, and it may have been using {name}. Try again."
                )),
            });
        }
    }
    if git_dirs.is_none() {
        *git_dirs = Some(read_git_dirs(repo_path).await?);
    }
    if let Some(dirs) = git_dirs.as_ref() {
        if let Some(refusal) =
            operation_refusal(repo_path, &porcelain, dirs, name, "deleting").await?
        {
            return Err(AppError::Command(refusal));
        }
    }
    Ok(())
}

/// One `worktree list --porcelain` stanza: its path, its `HEAD` line value (all zeros for
/// an unresolvable HEAD; absent for a bare entry) and its `branch` line value (absent
/// when detached or bare).
#[derive(Debug, PartialEq, Eq)]
struct ListedHead {
    path: String,
    head: Option<String>,
    branch: Option<String>,
}

/// Each stanza of a `worktree list --porcelain` text, in list order.
fn worktree_heads(porcelain: &str) -> Vec<ListedHead> {
    let mut heads: Vec<ListedHead> = Vec::new();
    for line in porcelain.lines().map(|line| line.trim_end_matches('\r')) {
        if let Some(path) = line.strip_prefix("worktree ") {
            heads.push(ListedHead {
                path: path.to_string(),
                head: None,
                branch: None,
            });
        } else if let Some(last) = heads.last_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                last.head = Some(head.to_string());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                last.branch = Some(branch.to_string());
            }
        }
    }
    heads
}

/// Which of [`head_moved_in`]'s reasons fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeadMove {
    /// The checkout is (new, or with a changed branch line) on a case variant of the name.
    Arrived,
    /// The checkout's HEAD was the deleted tip and changed, under the same branch line.
    Moved,
}

/// The worktree in `after` whose HEAD value differs from its `before` entry (matched by
/// path) where that entry's HEAD was `tip`, or that is (new, or with a changed branch
/// line) on a branch equal to `name` ignoring case. An arrival outranks a move, within one
/// stanza and across stanzas, since it is the stronger evidence the name was in use.
fn head_moved_in<'a>(
    before: &[ListedHead],
    after: &'a [ListedHead],
    name: &str,
    tip: &str,
) -> Option<(&'a str, HeadMove)> {
    let mut moved_first = None;
    for now in after {
        let was = before.iter().find(|was| was.path == now.path);
        let on_name = now
            .branch
            .as_deref()
            .and_then(|branch| branch.strip_prefix("refs/heads/"))
            .is_some_and(|branch| eq_ignoring_case(branch, name));
        if on_name && was.is_none_or(|was| was.branch != now.branch) {
            return Some((now.path.as_str(), HeadMove::Arrived));
        }
        let moved = was.is_some_and(|was| was.head.as_deref() == Some(tip) && was.head != now.head);
        if moved && moved_first.is_none() {
            moved_first = Some((now.path.as_str(), HeadMove::Moved));
        }
    }
    moved_first
}

/// Re-creates `full_ref` at `tip` only while no ref of that name exists: an all-zero
/// old value is git's "must not exist" (leaving the old value out would skip the
/// compare), so a name taken again since the delete is never overwritten. `false` is
/// logged with the `refusal` that asked for the restore.
async fn restore_deleted_ref(
    repo_path: &str,
    full_ref: &str,
    tip: &str,
    refusal: &AppError,
) -> bool {
    let absent = "0".repeat(tip.len());
    match run_git_raw(
        Some(repo_path),
        &[
            "update-ref",
            "--no-deref",
            "-m",
            "restored: in use during delete",
            full_ref,
            tip,
            &absent,
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(out) if out.code == 0 => true,
        Ok(out) => {
            eprintln!(
                "gitdesktop: branch restore after delete failed ({refusal}): {}",
                out.stderr.trim()
            );
            false
        }
        Err(e) => {
            eprintln!("gitdesktop: branch restore after delete failed ({refusal}): {e}");
            false
        }
    }
}

/// Where a branch delete can be held from a test: before the config-write mutex and
/// the guards under it, between those guards and the compare-and-delete, and after a
/// delete that landed, before the reads that run again.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DeletePhase {
    BeforeGuards,
    BeforeDelete,
    AfterDelete,
}

#[cfg(test)]
pub(crate) type DeletePhaseHook = std::sync::Arc<
    dyn Fn(DeletePhase) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

#[cfg(test)]
tokio::task_local! {
    /// Awaited at each [`DeletePhase`] of the delete it is scoped to, so a test can act
    /// on the repository at that point.
    pub(crate) static DELETE_PHASE_HOOK: DeletePhaseHook;
}

#[cfg(test)]
async fn delete_phase(phase: DeletePhase) {
    if let Ok(wait) = DELETE_PHASE_HOOK.try_with(|hook| hook(phase)) {
        wait.await;
    }
}

/// git's text when `branch -m` moved the ref but lost `.git/config.lock`: exit 128,
/// `branch.<old>.*` left under the old name (measured, git 2.51.1, C locale).
const RENAMED_CONFIG_LEFT_BEHIND: &str = "branch is renamed, but update of config-file failed";

/// git's text when a tracking setup (`switch --track`, a tracked `switch -c`/`branch`,
/// `push -u`) lost the config lock after its ref work landed.
pub(crate) const UPSTREAM_WRITE_FAILED: &str = "unable to write upstream branch configuration";

/// Redoes one `branch.<name>` section edit whose ref change already landed, counting
/// "no such section" as done: the branch had no settings, or another writer already
/// handled them. `false` (logged) leaves the caller's own verdict to speak.
async fn repair_branch_section(held: &ConfigWriteHeld, repo_path: &str, args: &[&str]) -> bool {
    match run_git_config_write_held(held, repo_path, args, DEFAULT_TIMEOUT).await {
        Ok(out) if out.code == 0 || out.stderr.contains("no such section") => true,
        Ok(out) => {
            eprintln!(
                "gitdesktop: branch config repair failed: {}",
                out.stderr.trim()
            );
            false
        }
        Err(e) => {
            eprintln!("gitdesktop: branch config repair failed: {e}");
            false
        }
    }
}

/// Drops `branch.<name>.*` after the ref itself was deleted, so it can't resurface on
/// the next branch of that name: `update-ref -d` never touches it. Best-effort, since
/// the delete itself succeeded.
pub(crate) async fn remove_deleted_branch_section(
    held: &ConfigWriteHeld,
    repo_path: &str,
    name: &str,
) {
    let section = format!("branch.{name}");
    repair_branch_section(held, repo_path, &["config", "--remove-section", &section]).await;
}

/// Re-establishes `branch` → `upstream` tracking after a tracking setup lost the config
/// lock, never re-running the command that set it up. `upstream` is the fully
/// qualified ref git itself would have tracked; callers that can't pin it don't call.
pub(crate) async fn restore_upstream(
    held: &ConfigWriteHeld,
    repo_path: &str,
    branch: &str,
    upstream: &str,
) -> bool {
    let flag = format!("--set-upstream-to={upstream}");
    match run_git_config_write_held(
        held,
        repo_path,
        &["branch", &flag, "--", branch],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(out) if out.code == 0 => true,
        Ok(out) => {
            eprintln!("gitdesktop: upstream repair failed: {}", out.stderr.trim());
            false
        }
        Err(e) => {
            eprintln!("gitdesktop: upstream repair failed: {e}");
            false
        }
    }
}

/// What decided a tracking setup's upstream, and so what a repair may re-set.
#[derive(Clone, Copy)]
pub(crate) enum TrackedBy {
    /// An explicit `--track`: always the start ref itself.
    ExplicitTrack,
    /// `branch.autoSetupMerge`, whose mode decides (see [`direct_tracking_target`]).
    AutoSetupMerge,
}

/// What [`finish_tracking_setup`] left behind.
pub(crate) struct FinishedSetup {
    /// The output to report: success once both legs landed, else git's own failure.
    pub(crate) out: GitOutput,
    /// The repair's switch leg landed, so HEAD is on the new branch whatever `out`
    /// says — a caller that treats a failure as "HEAD never moved" must check this.
    pub(crate) switched: bool,
}

/// A tracking setup (`switch --track`, or `switch -c`/`branch` that set tracking up)
/// that loses the config lock has CREATED `branch` and, for a switch, moved the index
/// and working tree to it, yet left HEAD on the old branch and the upstream unwritten
/// (measured, git 2.51.1: exit 1). Finishes both legs, the switch first and whatever
/// the upstream does: the moved tree under the old HEAD reads as staged changes a
/// commit would land on the old branch. An upstream git's own choice can't be pinned
/// for, or that loses again, keeps git's failure in `out`, never a guessed upstream.
pub(crate) async fn finish_tracking_setup(
    held: &ConfigWriteHeld,
    repo_path: &str,
    out: GitOutput,
    branch: &str,
    start: &str,
    tracked_by: TrackedBy,
    switch: bool,
) -> AppResult<FinishedSetup> {
    if out.code == 0 || !out.stderr.contains(UPSTREAM_WRITE_FAILED) {
        return Ok(FinishedSetup {
            out,
            switched: false,
        });
    }
    // Resolved BEFORE the switch leg: a `HEAD` start must name the branch the create
    // started from, never the one the leg is about to check out.
    let upstream = direct_tracking_target(repo_path, start, tracked_by).await;
    if switch {
        let switched = run_git_raw(Some(repo_path), &["switch", branch], DEFAULT_TIMEOUT).await?;
        if switched.code != 0 {
            return Ok(FinishedSetup {
                out: switched,
                switched: false,
            });
        }
    }
    let restored = match upstream {
        Some(upstream) => restore_upstream(held, repo_path, branch, &upstream).await,
        None => false,
    };
    let out = if restored {
        GitOutput { code: 0, ..out }
    } else {
        out
    };
    Ok(FinishedSetup {
        out,
        switched: switch,
    })
}

/// The ref git itself tracked from `start`, fully qualified, or `None` when that can't
/// be pinned. git tracks the start ref directly under an explicit `--track` and under
/// every `branch.autoSetupMerge` value that sets tracking up at all except `inherit`,
/// which copies the START's own upstream (possibly several merge entries) instead
/// (measured, git 2.51.1). The start resolves the way git's create resolved it.
pub(crate) async fn direct_tracking_target(
    repo_path: &str,
    start: &str,
    tracked_by: TrackedBy,
) -> Option<String> {
    if let TrackedBy::AutoSetupMerge = tracked_by {
        let mode = run_git_raw(
            Some(repo_path),
            &["config", "--get", "branch.autoSetupMerge"],
            DEFAULT_TIMEOUT,
        )
        .await
        .ok()?;
        // Exit 1 is unset, git's default `true`. `inherit` is matched as git does,
        // case-sensitively; the last value wins in both readers.
        let direct = match mode.code {
            0 => mode.stdout_lossy().trim() != "inherit",
            1 => true,
            _ => false,
        };
        if !direct {
            return None;
        }
    }
    let resolved = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--symbolic-full-name",
            start,
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let full = resolved.stdout_lossy().trim().to_string();
    (resolved.code == 0 && (full.starts_with("refs/remotes/") || full.starts_with("refs/heads/")))
        .then_some(full)
}

/// Deletes a branch on a remote via `git push <remote> --delete`, authenticating
/// with the same one-shot provider-CLI credential entries `git_push` uses (so a
/// stale ambient credential can't shadow the signed-in CLI's identity). git prunes
/// the local remote-tracking ref on success.
#[tauri::command]
pub async fn git_delete_remote_branch(
    state: State<'_, AppState>,
    repo_path: String,
    remote: String,
    name: String,
) -> AppResult<()> {
    git_delete_remote_branch_core(&state, repo_path, remote, name).await
}

pub(crate) async fn git_delete_remote_branch_core(
    state: &AppState,
    repo_path: String,
    remote: String,
    name: String,
) -> AppResult<()> {
    validate_ref_name(&remote)?;
    validate_ref_name(&name)?;
    if name == "HEAD" {
        return Err(AppError::InvalidArgument(REMOTE_HEAD_POINTER.into()));
    }
    crate::git::status::refuse_mirror_push(
        &repo_path,
        crate::git::status::PushRemote::Named(&remote),
    )
    .await?;

    // Best-effort guard: if the remote's symbolic HEAD resolves (only set on
    // clone, so absence is fine — skip then) to this branch, it's the remote's
    // default and can't be deleted. The server refuses anyway, but cryptically;
    // check locally first. Probe with a non-propagating raw run. Read in FULL
    // and stripped of exactly `refs/remotes/`: `--short` disambiguates, so a
    // tag or local branch named `<remote>/<name>` turns the answer into
    // `remotes/<remote>/<name>` (measured, git 2.51.1).
    let head = run_git_raw(
        Some(&repo_path),
        &["symbolic-ref", &format!("refs/remotes/{remote}/HEAD")],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let head_ref = head.stdout_lossy();
    if head.code == 0
        && head_ref
            .trim_end_matches(['\r', '\n'])
            .strip_prefix("refs/remotes/")
            == Some(format!("{remote}/{name}").as_str())
    {
        return Err(AppError::InvalidArgument(format!(
            "\"{name}\" is the default branch on {remote} and can't be deleted from here."
        )));
    }
    drop_symbolic_tracking_ref(&repo_path, &remote, &name).await?;

    let cred = crate::forge::credential_config_for_remote(&repo_path, &remote).await?;
    let branch_ref = format!("refs/heads/{name}");
    let out = crate::git::remote::run_git_mutating_with_creds(
        state,
        &repo_path,
        &cred,
        &["push", &remote, "--delete", "--", &branch_ref],
        NETWORK_TIMEOUT,
    )
    .await;
    match out {
        Ok(_) => Ok(()),
        // Idempotent: the server ref is already gone. Unlike the success path, a
        // failed delete-push doesn't prune the local remote-tracking ref, so the
        // switcher row would survive until the next pruning fetch — best-effort
        // delete it now (it may already be absent).
        Err(AppError::Git { stderr, .. })
            if stderr.to_lowercase().contains("remote ref does not exist") =>
        {
            let _ = run_git_raw(
                Some(&repo_path),
                &[
                    "update-ref",
                    "--no-deref",
                    "-d",
                    &format!("refs/remotes/{remote}/{name}"),
                ],
                DEFAULT_TIMEOUT,
            )
            .await;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// Why a branch can't also be renamed on its remote: nothing was renamed, here or there.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RemoteRenameRefusal {
    /// The branch has no live upstream `refs/heads/<old>` on the named remote.
    NotTracking,
    /// The branch is marked Keep local.
    KeepLocal,
    /// The branch's configured push remote (`branch.<old>.pushRemote`, else
    /// `remote.pushDefault`) is another remote, which the setting would keep after the
    /// rename; `push_remote` is the name as configured.
    PushesElsewhere { push_remote: String },
    /// `remote.<remote>.mirror` is set.
    Mirror,
    /// The remote pushes somewhere other than the repository it fetches from, or to several.
    PushUrlDiffers,
    /// The names differ only in letter case and this store's refs can alias.
    CaseOnly,
    /// The live read failed; `detail` is git's reason.
    Unreachable { detail: String },
    /// The remote's live HEAD is the branch.
    RemoteDefault,
    /// The remote has no `refs/heads/<old>`.
    RemoteGone,
    /// The remote's tip differs from the one the caller pinned.
    Moved,
    /// The remote already has `refs/heads/<new>`, at any commit.
    NewExists,
    /// The remote's tip is not contained in the local branch.
    RemoteAhead,
}

/// The remote rename's verdict before anything changes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RemoteRenameCheck {
    /// `old_tip` is the remote's tip of the old name: the act's delete leases it.
    Clear {
        old_tip: String,
    },
    Refused {
        refusal: RemoteRenameRefusal,
    },
}

/// Why the old remote branch was left in place after the new name was pushed.
#[derive(Debug, serde::Serialize)]
#[serde(
    tag = "reason",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OldKeptCause {
    /// The pushed branch does not contain the old remote tip; no delete was attempted.
    NotInPush,
    /// The pushed copy could not be compared with the old remote tip; no delete was attempted.
    Unverified,
    /// The lease refused and a read after it still lists the old branch.
    Moved,
    /// The remote refused the delete; its reason verbatim.
    Rejected { detail: String },
    /// A transport failure, a timeout, or a failed read after the delete: nothing reads
    /// back, so the delete may have landed.
    Failed { error: AppError },
}

/// What a remote rename did. Every status but `Refused` renamed the branch here; `warning`
/// is the local rename's [`RenameBranchOutcome::warning`], plus the lost-upstream sentence
/// when the push did not set `<remote>/<new>` as the upstream.
#[derive(Debug, serde::Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RemoteRenameOutcome {
    /// Nothing renamed, here or there.
    Refused { refusal: RemoteRenameRefusal },
    /// The old remote branch is untouched. After a push timeout, whether the new one exists
    /// on the remote is unknown.
    PushFailed {
        warning: Option<String>,
        error: AppError,
    },
    /// The new name is pushed (and tracked, unless `warning` says otherwise; a failed config
    /// read adds no warning); the old remote branch was not deleted, except after `Failed`,
    /// where it may have been.
    OldKept {
        warning: Option<String>,
        cause: OldKeptCause,
    },
    /// The new name is pushed, and the old remote branch was deleted or already gone.
    Renamed { warning: Option<String> },
}

/// The rename dialog's read of whether `old_name` can also be renamed on `remote`;
/// `new_name` is the name being typed, `None` while there is none.
#[tauri::command]
pub async fn git_remote_rename_check(
    state: State<'_, AppState>,
    repo_path: String,
    old_name: String,
    new_name: Option<String>,
    remote: String,
) -> AppResult<RemoteRenameCheck> {
    Box::pin(remote_rename_check(
        &state,
        &repo_path,
        &old_name,
        new_name.as_deref(),
        &remote,
        None,
    ))
    .await
}

/// Renames `old_name` here and on `remote`; `expected_old_tip` is the remote tip the
/// dialog's check showed.
#[tauri::command]
pub async fn git_rename_branch_remote(
    state: State<'_, AppState>,
    repo_path: String,
    old_name: String,
    new_name: String,
    remote: String,
    expected_old_tip: Option<String>,
) -> AppResult<RemoteRenameOutcome> {
    Box::pin(git_rename_branch_remote_core(
        &state,
        repo_path,
        old_name,
        new_name,
        remote,
        expected_old_tip,
    ))
    .await
}

/// The act: renames `old_name` here, pushes `new_name` with `-u` under the push's
/// create-only lease, proves the pushed branch contains the old remote tip, then deletes
/// the old remote branch under a lease pinned to that tip. An MCP entry, when one is
/// added, passes `None` for the pin. Every stop after the local rename is an outcome that
/// says what is where.
///
/// - An `Err` means nothing was renamed, except one arm of the rename core: `branch -m`
///   moved the ref and the config-lock repair failed, so the ref is renamed already.
/// - The one loss window left: someone rewinds the remote `new_name` between the proof's
///   live read and the leased delete, which then removes the old name while the new one
///   no longer holds its tip. The commit survives here: the local branch held it at the check.
/// - A `-u` that lost the config lock exits 0 with `new_name` still tracking the old
///   upstream; the warning then says the upstream wasn't set.
/// - A proof that could not compare (a failed read, no row, a tip not here) deletes nothing.
/// - The push always carries the create-only lease, whatever the tracking ref says, so a
///   `new_name` created on the remote since the check refuses it. A creation at the very
///   commit being pushed still reads as pushed: git's up-to-date check runs first.
/// - An upstream outside the remote's fetch refspec reads as not live, so the dialog
///   offers no remote step and this answers `NotTracking`.
pub(crate) async fn git_rename_branch_remote_core(
    state: &AppState,
    repo_path: String,
    old_name: String,
    new_name: String,
    remote: String,
    expected_old_tip: Option<String>,
) -> AppResult<RemoteRenameOutcome> {
    let repo = repo_path.as_str();
    let checked = remote_rename_check(
        state,
        repo,
        &old_name,
        Some(&new_name),
        &remote,
        expected_old_tip.as_deref(),
    )
    .await?;
    let old_tip = match checked {
        RemoteRenameCheck::Clear { old_tip } => old_tip,
        RemoteRenameCheck::Refused { refusal } => {
            return Ok(RemoteRenameOutcome::Refused { refusal })
        }
    };
    let warning =
        git_rename_branch_core(state, repo_path.clone(), old_name.clone(), new_name.clone())
            .await?
            .warning;
    // The check read `new_name` absent on the remote, so a tracking ref for it is stale.
    drop_stale_tracking_ref(repo, &remote, &new_name).await;
    #[cfg(test)]
    remote_rename_phase(RemoteRenamePhase::BeforePush).await;
    let pushed = crate::git::remote::git_push_creating_core(
        state,
        repo_path.clone(),
        new_name.clone(),
        remote.clone(),
    )
    .await;
    if let Err(error) = pushed {
        return Ok(RemoteRenameOutcome::PushFailed { warning, error });
    }
    #[cfg(test)]
    remote_rename_phase(RemoteRenamePhase::AfterPush).await;
    // The branch can move back (a reset, an undo, a rebase) between the check and the
    // push's spawn, so what was pushed is proven, never assumed.
    let (copy, tracked) = pushed_branch_contains(repo, &remote, &new_name, &old_tip).await;
    let warning = if tracked {
        warning
    } else {
        with_lost_upstream_warning(repo, &remote, &new_name, warning).await
    };
    let cause = match copy {
        PushedCopy::Contains => None,
        PushedCopy::Missing => Some(OldKeptCause::NotInPush),
        PushedCopy::Unknown => Some(OldKeptCause::Unverified),
    };
    if let Some(cause) = cause {
        return Ok(RemoteRenameOutcome::OldKept { warning, cause });
    }
    #[cfg(test)]
    remote_rename_phase(RemoteRenamePhase::BeforeDelete).await;
    Ok(
        match delete_remote_branch_leased(state, repo, &remote, &old_name, &old_tip).await {
            RemoteDeleteLeased::Deleted | RemoteDeleteLeased::AlreadyGone => {
                RemoteRenameOutcome::Renamed { warning }
            }
            RemoteDeleteLeased::Kept(cause) => RemoteRenameOutcome::OldKept { warning, cause },
        },
    )
}

/// One decision table for the dialog's check and the act; the first refusal answers.
/// Everything before the one `ls-remote` is local, so each local refusal holds offline.
/// An `Err` means a local read failed or an existing refusal fired (an agent-session
/// name, a repository publish, a running update): nothing was decided or changed. A
/// branch literally named `@` fails validation here.
pub(crate) async fn remote_rename_check(
    state: &AppState,
    repo_path: &str,
    old: &str,
    new: Option<&str>,
    remote: &str,
    expected_old_tip: Option<&str>,
) -> AppResult<RemoteRenameCheck> {
    use RemoteRenameRefusal as Refusal;
    let refused = |refusal: RemoteRenameRefusal| -> AppResult<RemoteRenameCheck> {
        Ok(RemoteRenameCheck::Refused { refusal })
    };
    validate_ref_name(remote)?;
    if !crate::git::remote::is_named_remote(remote) {
        return Err(AppError::InvalidArgument(format!(
            "invalid remote: {remote}"
        )));
    }
    validate_branch_name(old)?;
    if let Some(new) = new {
        validate_branch_name(new)?;
    }
    let expected = expected_old_tip.map(full_object_id).transpose()?;
    if let Some(new) = new {
        refuse_session_rename(old, new)?;
    }
    refuse_while_publishing(repo_path, old).await?;
    crate::git::update_marker::refuse_if_branch_updating(state, repo_path, old).await?;
    let upstream = read_branch_upstream(repo_path, old).await?;
    if !upstream
        .as_ref()
        .is_some_and(|up| up.live_branch() == Some(old) && up.remote == remote)
    {
        return refused(Refusal::NotTracking);
    }
    // The OLD name's mark: it moves with the rename, and the new name's section is a
    // leftover the rename drops.
    match crate::git::remote::refuse_publishing_branch(repo_path, old).await {
        Err(AppError::BranchKeptLocal { .. }) => return refused(Refusal::KeepLocal),
        other => other?,
    }
    // The setting moves with the rename, so the next plain push would publish the new name
    // there beside a stale copy of the old one. An empty value gives git no push remote.
    let config = crate::git::status::push_config_strict(repo_path).await?;
    if let Some((_, push_remote)) = config.push_remote_setting(old) {
        if !push_remote.is_empty() && push_remote != remote {
            return refused(Refusal::PushesElsewhere {
                push_remote: push_remote.to_string(),
            });
        }
    }
    let target = crate::git::status::PushRemote::Named(remote);
    match crate::git::status::refuse_mirror_push(repo_path, target).await {
        Err(AppError::PushRemoteIsMirror { .. }) => return refused(Refusal::Mirror),
        other => other?,
    }
    // Read uncached: the push URLs below are live, and a cached fetch URL could compare a
    // `set-url` from the last few seconds against the one before it.
    let fetch_url = run_git(
        Some(repo_path),
        &["remote", "get-url", remote],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();
    // `--all`: a plain `get-url --push` prints only the first of several push URLs.
    let listed = run_git(
        Some(repo_path),
        &["remote", "get-url", "--push", "--all", remote],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy();
    let push_urls: Vec<&str> = listed
        .lines()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .collect();
    if !same_push_repository(&fetch_url, &push_urls) {
        return refused(Refusal::PushUrlDiffers);
    }
    if is_case_only_rename(old, new) && refs_can_alias_strict(repo_path).await? {
        return refused(Refusal::CaseOnly);
    }
    let Some(local_tip) = exact_branch_tip(repo_path, old).await? else {
        return Err(AppError::Git {
            code: 1,
            stderr: format!("error: branch '{old}' not found"),
        });
    };
    let old_ref = branch_full_ref(old)?;
    let new_ref = new.map(branch_full_ref).transpose()?;
    let mut patterns = vec!["HEAD", old_ref.as_str()];
    patterns.extend(new_ref.as_deref());
    let cred = crate::forge::credential_config_for_remote(repo_path, remote).await?;
    let stdout = match ls_remote_refs(repo_path, &cred, remote, true, &patterns).await {
        Ok(stdout) => stdout,
        Err(e) => {
            return refused(Refusal::Unreachable {
                detail: unreachable_detail(&e),
            })
        }
    };
    let read = parse_remote_rename_read(&stdout, &old_ref, new_ref.as_deref());
    if let Some(refusal) = remote_side_refusal(&read, &old_ref, expected.as_deref()) {
        return refused(refusal);
    }
    let Some(old_tip) = read.old_tip else {
        return refused(Refusal::RemoteGone);
    };
    // Exit 1 is a commit this store lacks (the remote is ahead); any other failure, such as
    // a corrupt object, is the read's `Err`.
    let present = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{old_tip}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match present.code {
        0 => {}
        1 => return refused(Refusal::RemoteAhead),
        _ => {
            present.exit_verdict()?;
        }
    }
    if !is_strict_ancestor(repo_path, &old_tip, &local_tip).await? {
        return refused(Refusal::RemoteAhead);
    }
    Ok(RemoteRenameCheck::Clear { old_tip })
}

/// `merge-base --is-ancestor` over the commits as stored, for the remote rename's two
/// destructive decisions: replace refs off and `GIT_GRAFT_FILE` at a path under a regular
/// file, which cannot exist, so a local graft or replacement never proves a containment the
/// remote lacks. A shallow boundary can only answer false, toward keeping. Exit 0 is true,
/// 1 false, anything else the `Err`.
async fn is_strict_ancestor(repo_path: &str, ancestor: &str, descendant: &str) -> AppResult<bool> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Command(format!("couldn't resolve the app's path: {e}")))?;
    let no_grafts = exe.join("no-grafts");
    let out = crate::git::runner::run_git_raw_env(
        Some(repo_path),
        &["merge-base", "--is-ancestor", ancestor, descendant],
        &[
            ("GIT_NO_REPLACE_OBJECTS", "1"),
            ("GIT_GRAFT_FILE", &no_grafts.to_string_lossy()),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match out.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => out.exit_verdict().map(|_| false),
    }
}

/// Whether `new` differs from `old` only in letter case. The remote rename refuses such a
/// rename wherever local refs can alias, since the remote's own folding can't be read, and
/// [`rename_mode`] reads it to pick the local rename's flag.
fn is_case_only_rename(old: &str, new: Option<&str>) -> bool {
    new.is_some_and(|new| new != old && eq_ignoring_case(old, new))
}

/// Whether a push to `push_urls` writes the repository `fetch_url` reads: exactly one push
/// URL, textually the fetch URL or the same path by `forge::remote_path` and, within one
/// transport family ([`url_transport`]), the same authority by `forge::remote_authority`
/// (port included unless it is the scheme's default, case-insensitive) and the same ssh
/// user, whose home a relative scp path starts from. Across families (ssh beside https) only
/// the host must match, since each serves its own port. A side these fns can't parse refuses.
fn same_push_repository(fetch_url: &str, push_urls: &[&str]) -> bool {
    let [push_url] = push_urls else {
        return false;
    };
    if *push_url == fetch_url {
        return true;
    }
    let identity = |url: &str| {
        let authority = crate::forge::remote_authority(url)?;
        // git connects to these ports when a URL names none.
        let default_port = match url.split_once("://").map(|(s, _)| s.to_ascii_lowercase()) {
            Some(scheme) if matches!(scheme.as_str(), "ssh" | "git+ssh" | "ssh+git") => ":22",
            Some(scheme) if scheme == "https" => ":443",
            Some(scheme) if scheme == "http" => ":80",
            _ => "",
        };
        let authority = match authority.strip_suffix(default_port) {
            Some(bare) if !default_port.is_empty() => bare.to_string(),
            _ => authority,
        };
        Some((
            url_transport(url),
            authority,
            crate::forge::remote_host(url)?,
            crate::forge::remote_path(url)?,
        ))
    };
    match (identity(fetch_url), identity(push_url)) {
        (
            Some((fetch_transport, fetch_authority, fetch_host, fetch_path)),
            Some((push_transport, push_authority, push_host, push_path)),
        ) => {
            if fetch_path != push_path {
                return false;
            }
            if fetch_transport.0 != push_transport.0 {
                return fetch_host.eq_ignore_ascii_case(&push_host);
            }
            fetch_authority.eq_ignore_ascii_case(&push_authority)
                && fetch_transport.1 == push_transport.1
        }
        _ => false,
    }
}

/// A URL's transport family (`http` for http and https; `ssh` for ssh, git+ssh, ssh+git and
/// scp form; otherwise its scheme) and, in the ssh family, the user name it logs in as.
fn url_transport(url: &str) -> (String, Option<String>) {
    let (scheme, authority) = match url.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest.split('/').next()),
        None => ("ssh".to_string(), url.split(':').next()),
    };
    let family = match scheme.as_str() {
        "http" | "https" => "http",
        "ssh" | "git+ssh" | "ssh+git" => "ssh",
        other => other,
    }
    .to_string();
    let user = (family == "ssh")
        .then(|| authority?.rsplit_once('@'))
        .flatten()
        .map(|(userinfo, _)| userinfo.split(':').next().unwrap_or(userinfo).to_string());
    (family, user)
}

/// What the check's `ls-remote --symref <remote> HEAD <old> [<new>]` listed.
#[derive(Debug, PartialEq, Eq)]
struct RemoteRenameRead {
    default_ref: Option<String>,
    old_tip: Option<String>,
    new_exists: bool,
}

/// `ls-remote` patterns match a ref's TAIL (`refs/heads/x/refs/heads/old` is listed for
/// `refs/heads/old`), so a row counts only when its name is exactly the full ref; a tip
/// also needs a full object id.
fn parse_remote_rename_read(
    stdout: &str,
    old_ref: &str,
    new_ref: Option<&str>,
) -> RemoteRenameRead {
    RemoteRenameRead {
        default_ref: parse_symref_head(stdout),
        old_tip: listed_tip(stdout, old_ref),
        new_exists: new_ref.is_some_and(|new_ref| listed_row(stdout, new_ref).is_some()),
    }
}

/// The object field of the `ls-remote` row named exactly `full_ref`.
fn listed_row<'a>(stdout: &'a str, full_ref: &str) -> Option<&'a str> {
    stdout.lines().find_map(|line| {
        let (oid, name) = line.split_once('\t')?;
        (name == full_ref).then_some(oid)
    })
}

/// [`listed_row`]'s object when it is a full object id, lowercased.
fn listed_tip(stdout: &str, full_ref: &str) -> Option<String> {
    listed_row(stdout, full_ref).and_then(|oid| full_object_id(oid).ok())
}

/// The remote side's refusal, in order: default, gone, moved from the pin, new name taken.
/// An absent symref line is not the default (a detached or empty remote HEAD).
fn remote_side_refusal(
    read: &RemoteRenameRead,
    old_ref: &str,
    expected_old_tip: Option<&str>,
) -> Option<RemoteRenameRefusal> {
    if read.default_ref.as_deref() == Some(old_ref) {
        return Some(RemoteRenameRefusal::RemoteDefault);
    }
    let Some(tip) = read.old_tip.as_deref() else {
        return Some(RemoteRenameRefusal::RemoteGone);
    };
    if expected_old_tip.is_some_and(|expected| !expected.eq_ignore_ascii_case(tip)) {
        return Some(RemoteRenameRefusal::Moved);
    }
    read.new_exists.then_some(RemoteRenameRefusal::NewExists)
}

/// The budget of a live `ls-remote` that a dialog or a gate waits on: room for a slow
/// transport, short of [`NETWORK_TIMEOUT`], which would hold the rename check pending for
/// ten minutes.
const REMOTE_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// `ls-remote [--symref] <remote> <patterns>` with the remote's credentials, lock-free
/// with one ambient retry (`run_git_with_creds_once`): stdout on exit 0, a non-zero exit
/// as [`AppError::Git`] carrying git's text.
async fn ls_remote_refs(
    repo_path: &str,
    cred: &[String],
    remote: &str,
    symref: bool,
    patterns: &[&str],
) -> AppResult<String> {
    let mut argv = vec!["ls-remote"];
    if symref {
        argv.push("--symref");
    }
    argv.push(remote);
    argv.extend_from_slice(patterns);
    let out =
        crate::git::remote::run_git_with_creds_once(repo_path, cred, &argv, REMOTE_READ_TIMEOUT)
            .await?;
    if out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    Ok(out.stdout_lossy())
}

/// `Unreachable`'s detail: git's first meaningful line, without a leading `fatal: ` or
/// `error: `; a spawn failure or timeout reads as its own message.
fn unreachable_detail(error: &AppError) -> String {
    let AppError::Git { stderr, .. } = error else {
        return error.to_string();
    };
    stderr
        .lines()
        .map(str::trim)
        .find(|line| {
            !line.is_empty() && !line.starts_with("warning:") && !line.starts_with("hint:")
        })
        .map(|line| {
            let line = line.strip_prefix("fatal: ").unwrap_or(line);
            line.strip_prefix("error: ").unwrap_or(line).to_string()
        })
        .unwrap_or_else(|| error.to_string())
}

/// Removes `refs/remotes/<remote>/<name>` at the value just read, best-effort: a failure is
/// logged and the push goes ahead.
async fn drop_stale_tracking_ref(repo_path: &str, remote: &str, name: &str) {
    let tracking = format!("refs/remotes/{remote}/{name}");
    let listed = run_git(
        Some(repo_path),
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)",
            &tracking,
        ],
        DEFAULT_TIMEOUT,
    )
    .await;
    let value = match &listed {
        Ok(out) => exact_ref_field(&out.stdout_lossy(), &tracking).map(str::to_string),
        Err(e) => {
            eprintln!("gitdesktop: couldn't read {tracking} before the rename's push: {e}");
            return;
        }
    };
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return;
    };
    let dropped = run_git_raw(
        Some(repo_path),
        &[
            "update-ref",
            "--no-deref",
            "-d",
            &format!("refs/remotes/{remote}/{name}"),
            &value,
        ],
        DEFAULT_TIMEOUT,
    )
    .await;
    if !dropped.as_ref().is_ok_and(|out| out.code == 0) {
        eprintln!("gitdesktop: couldn't remove the stale {tracking} before the rename's push");
    }
}

/// What the containment proof found. Only an `is_ancestor` that answered says contains or
/// missing; every read that failed or proved nothing is unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PushedCopy {
    Contains,
    Missing,
    Unknown,
}

/// Whether the pushed `new` holds `old_tip`, proven against the remote's live tip (a
/// tracking ref the push wrote can be held at an older value by a leftover lock), and
/// whether `new`'s upstream reads as `<remote>/<new>`, which only steers the lost-upstream
/// warning (a failed read counts as not).
async fn pushed_branch_contains(
    repo_path: &str,
    remote: &str,
    new: &str,
    old_tip: &str,
) -> (PushedCopy, bool) {
    let tracked = read_branch_upstream(repo_path, new)
        .await
        .ok()
        .flatten()
        .is_some_and(|up| up.live_branch() == Some(new) && up.remote == remote);
    let Some(target) = live_pushed_tip(repo_path, remote, new).await else {
        return (PushedCopy::Unknown, tracked);
    };
    let copy = match is_strict_ancestor(repo_path, old_tip, &target).await {
        Ok(true) => PushedCopy::Contains,
        Ok(false) => PushedCopy::Missing,
        Err(_) => PushedCopy::Unknown,
    };
    (copy, tracked)
}

/// `warning` plus the lost-upstream sentence when `new`'s own config does not name
/// `<remote>` and `refs/heads/<new>`. Read from the config, never the atoms: under a fetch
/// refspec that does not cover `new` they read untracked while the config is right.
async fn with_lost_upstream_warning(
    repo_path: &str,
    remote: &str,
    new: &str,
    warning: Option<String>,
) -> Option<String> {
    if upstream_config_names(repo_path, remote, new).await != Some(false) {
        return warning;
    }
    let sentence = format!("Couldn't set {new}'s upstream to {remote}/{new}.");
    Some(match warning {
        Some(warning) => format!("{warning} {sentence}"),
        None => sentence,
    })
}

/// Whether `branch.<new>.remote` and `branch.<new>.merge` are `remote` and the full ref
/// of `new`; an unset key is false, a failed read `None`.
async fn upstream_config_names(repo_path: &str, remote: &str, new: &str) -> Option<bool> {
    let merge = branch_full_ref(new).ok()?;
    let mut named = true;
    for (key, want) in [
        (format!("branch.{new}.remote"), remote),
        (format!("branch.{new}.merge"), merge.as_str()),
    ] {
        let out = run_git_raw(Some(repo_path), &["config", "--get", &key], DEFAULT_TIMEOUT)
            .await
            .ok()?;
        match out.code {
            0 => named &= out.stdout_lossy().trim_end_matches(['\r', '\n']) == want,
            1 => named = false,
            _ => return None,
        }
    }
    Some(named)
}

/// The remote's tip of `name` when a live read lists it exactly and its commit is in the
/// local store; `None` otherwise.
async fn live_pushed_tip(repo_path: &str, remote: &str, name: &str) -> Option<String> {
    let full_ref = branch_full_ref(name).ok()?;
    let cred = crate::forge::credential_config_for_remote(repo_path, remote)
        .await
        .ok()?;
    let stdout = ls_remote_refs(repo_path, &cred, remote, false, &[&full_ref])
        .await
        .ok()?;
    let tip = listed_tip(&stdout, &full_ref)?;
    let present = run_git_raw(
        Some(repo_path),
        &["cat-file", "-e", &format!("{tip}^{{commit}}")],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    (present.code == 0).then_some(tip)
}

/// What the leased delete of the old remote branch did.
enum RemoteDeleteLeased {
    Deleted,
    AlreadyGone,
    Kept(OldKeptCause),
}

/// Deletes `name` on `remote` only while it points at `expected_tip`, under the network
/// lock. A refused lease is told apart by a read after it: gone is already done (its stale
/// tracking ref removed), still listed is moved. No `--porcelain`: with it git reports the
/// rejection on stdout.
async fn delete_remote_branch_leased(
    state: &AppState,
    repo_path: &str,
    remote: &str,
    name: &str,
    expected_tip: &str,
) -> RemoteDeleteLeased {
    let failed = |error| RemoteDeleteLeased::Kept(OldKeptCause::Failed { error });
    let checked = validate_ref_name(remote)
        .and_then(|()| {
            crate::git::remote::is_named_remote(remote)
                .then_some(())
                .ok_or_else(|| AppError::InvalidArgument(format!("invalid remote: {remote}")))
        })
        .and_then(|()| match name {
            "HEAD" => Err(AppError::InvalidArgument(REMOTE_HEAD_POINTER.into())),
            _ => Ok(()),
        })
        .and_then(|()| Ok((branch_full_ref(name)?, full_object_id(expected_tip)?)));
    let (full_ref, tip) = match checked {
        Ok(checked) => checked,
        Err(e) => return failed(e),
    };
    let cred = match crate::forge::credential_config_for_remote(repo_path, remote).await {
        Ok(cred) => cred,
        Err(e) => return failed(e),
    };
    if let Err(e) = drop_symbolic_tracking_ref(repo_path, remote, name).await {
        return failed(e);
    }
    let lease = format!("--force-with-lease={full_ref}:{tip}");
    let delete = format!(":{full_ref}");
    // `--no-follow-tags`: under `push.followTags` a tag the remote refuses would fail a
    // delete that landed.
    let out = crate::git::remote::run_git_mutating_with_creds(
        state,
        repo_path,
        &cred,
        &["push", "--no-follow-tags", &lease, remote, &delete],
        NETWORK_TIMEOUT,
    )
    .await;
    match out {
        Ok(_) => RemoteDeleteLeased::Deleted,
        // A lease also refuses a ref that is already gone; only a read tells the two apart.
        Err(AppError::Git { stderr, .. })
            if crate::git::remote::is_stale_lease_rejection(&stderr) =>
        {
            match ls_remote_refs(repo_path, &cred, remote, false, &[&full_ref]).await {
                Ok(stdout) if listed_row(&stdout, &full_ref).is_some() => {
                    RemoteDeleteLeased::Kept(OldKeptCause::Moved)
                }
                Ok(_) => {
                    let _ = run_git_raw(
                        Some(repo_path),
                        &[
                            "update-ref",
                            "--no-deref",
                            "-d",
                            &format!("refs/remotes/{remote}/{name}"),
                        ],
                        DEFAULT_TIMEOUT,
                    )
                    .await;
                    RemoteDeleteLeased::AlreadyGone
                }
                Err(error) => failed(error),
            }
        }
        Err(AppError::Git { stderr, .. }) if is_remote_rejection(&stderr) => {
            RemoteDeleteLeased::Kept(OldKeptCause::Rejected {
                detail: remote_rejection_detail(&stderr),
            })
        }
        Err(error) => failed(error),
    }
}

/// The refusal of a remote delete of `HEAD`: its tracking ref is the clone-made
/// `refs/remotes/<remote>/HEAD`, which the symbolic drop below would remove.
const REMOTE_HEAD_POINTER: &str = "HEAD is the remote's default-branch pointer, not a branch";

/// Removes `refs/remotes/<remote>/<name>` when it is a symbolic ref, before a push deletes
/// `name` there: git's own tracking update follows a symbolic ref and deletes the branch it
/// names. A failed read pushes as before; a failed removal is the `Err`, nothing pushed.
async fn drop_symbolic_tracking_ref(repo_path: &str, remote: &str, name: &str) -> AppResult<()> {
    let tracking = format!("refs/remotes/{remote}/{name}");
    let read = run_git_raw(
        Some(repo_path),
        &["symbolic-ref", "-q", &tracking],
        DEFAULT_TIMEOUT,
    )
    .await;
    if !read.is_ok_and(|out| out.code == 0) {
        return Ok(());
    }
    run_git_raw(
        Some(repo_path),
        &[
            "update-ref",
            "--no-deref",
            "-d",
            &format!("refs/remotes/{remote}/{name}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?
    .exit_verdict()
    .map(|_| ())
}

/// Whether git reports a `! [remote rejected]` ref status line; the words anywhere else (a
/// path in a fatal line) are no rejection.
fn is_remote_rejection(stderr: &str) -> bool {
    stderr.lines().any(|line| {
        crate::git::remote::rejection_status_line(line).starts_with("! [remote rejected]")
    })
}

/// The remote's reason for refusing a push: every `remote:` line with the prefix and
/// surrounding whitespace removed, empty ones dropped (GitHub pads its `GH006` text with
/// blank ones), joined by newlines; with none, the text inside the last parentheses of the
/// `[remote rejected]` line.
fn remote_rejection_detail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix("remote:"))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if !lines.is_empty() {
        return lines.join("\n");
    }
    stderr
        .lines()
        .rfind(|line| line.contains("[remote rejected]"))
        .and_then(|line| {
            let open = line.rfind('(')?;
            let close = open + line[open..].find(')')?;
            Some(line[open + 1..close].to_string())
        })
        .unwrap_or_default()
}

/// Where a remote rename can be held from a test: between the check and the push, between
/// the push and the proof, and between the proof and the delete.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RemoteRenamePhase {
    BeforePush,
    AfterPush,
    BeforeDelete,
}

#[cfg(test)]
type RemoteRenamePhaseHook = std::sync::Arc<
    dyn Fn(RemoteRenamePhase) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

#[cfg(test)]
tokio::task_local! {
    /// Awaited at each [`RemoteRenamePhase`] of the remote rename it is scoped to. Separate
    /// from [`RENAME_PHASE_HOOK`]: a hook that runs a rename would re-enter that one.
    static REMOTE_RENAME_PHASE_HOOK: RemoteRenamePhaseHook;
}

#[cfg(test)]
async fn remote_rename_phase(phase: RemoteRenamePhase) {
    if let Ok(wait) = REMOTE_RENAME_PHASE_HOOK.try_with(|hook| hook(phase)) {
        wait.await;
    }
}

/// The repository's default branch: the HEAD a remote points at — `origin` first,
/// then every other remote in `git remote` order, so a clone made with `-o <name>`
/// resolves too — otherwise a local "main"/"master" if one exists.
///
/// Local refs only, no network: this runs in read paths and takes no `State`, so a
/// remote whose `refs/remotes/<remote>/HEAD` symref was never written (a hand-added
/// one) falls through to the local-name fallback.
#[tauri::command]
pub async fn git_default_branch(repo_path: String) -> AppResult<Option<String>> {
    // Origin answers almost every repo, so probe it before paying for a remote
    // listing — the common case stays at one git spawn.
    if let Some(name) = crate::git::remote::remote_head_branch(&repo_path, "origin").await? {
        return Ok(Some(name));
    }
    // Only now list, and sweep the OTHER remotes in `git remote` order — a clone made
    // with `-o <name>` keeps its HEAD there. Best-effort: an unlistable remote set
    // just leaves no remote HEAD to consult, which the fallback below already covers.
    let remotes = crate::git::remote::git_remotes(repo_path.clone())
        .await
        .unwrap_or_default();
    for remote in remotes.iter().filter(|r| r.as_str() != "origin") {
        if let Some(name) = crate::git::remote::remote_head_branch(&repo_path, remote).await? {
            return Ok(Some(name));
        }
    }
    for candidate in ["main", "master"] {
        let exists = run_git_raw(
            Some(&repo_path),
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{candidate}"),
            ],
            DEFAULT_TIMEOUT,
        )
        .await?
        .code
            == 0;
        if exists {
            return Ok(Some(candidate.to_string()));
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn git_checkout_branch(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    git_checkout_branch_core(&state, repo_path, name).await
}

pub(crate) async fn git_checkout_branch_core(
    state: &AppState,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    validate_ref_name(&name)?;
    let session_name = is_session_branch_name(&name);
    // Refuse only guess-creation so existing session-named branches stay reachable.
    if session_name && !branch_exists_exact(&repo_path, &name).await? {
        refuse_session_branch_name(&name)?;
    }
    crate::git::update_marker::refuse_if_branch_updating(state, &repo_path, &name).await?;
    let mut args = vec!["switch"];
    if session_name {
        // The existence check runs outside the lock; a concurrent delete must
        // not re-open guess-creation at the switch.
        args.push("--no-guess");
    }
    args.push(&name);
    // The switch's HEAD write lands inside the config-write mutex, so it cannot fall
    // inside a branch delete's guarded window; its working-tree hold comes first.
    let repo = repo_path.as_str();
    let domain = state.working_tree_lock(repo).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, holder_label("switch")).await?;
    with_config_write_lock(repo, |_held| async move {
        run_git_raw_index_retry(repo, &args, DEFAULT_TIMEOUT).await
    })
    .await?
    .exit_verdict()?;
    Ok(())
}

/// Check out a remote-only branch as a new local tracking branch of a SPECIFIC
/// remote. We pass `--track -c <name> refs/remotes/<remote>/<name>` explicitly rather
/// than plain `switch <name>` because when the same branch name exists on 2+ remotes
/// git's DWIM refuses ("matched multiple remote tracking branches"), and even in the
/// single-remote case the switcher row promised the user this exact remote — so
/// we honor it by construction instead of trusting git's guess. The local name is
/// explicit because `--track` alone strips only the start's first component after
/// `refs/remotes/`, so a remote named `team/fork` would mint `fork/<name>`.
#[tauri::command]
pub async fn git_checkout_remote_branch(
    state: State<'_, AppState>,
    repo_path: String,
    remote: String,
    name: String,
) -> AppResult<()> {
    git_checkout_remote_branch_core(&state, repo_path, remote, name).await
}

pub(crate) async fn git_checkout_remote_branch_core(
    state: &AppState,
    repo_path: String,
    remote: String,
    name: String,
) -> AppResult<()> {
    validate_ref_name(&remote)?;
    validate_branch_name(&name)?;
    refuse_session_branch_name(&name)?;
    // A live update means a LOCAL `name` already exists and is held, so this switch
    // collides on it rather than creating anything.
    crate::git::update_marker::refuse_if_branch_updating(state, &repo_path, &name).await?;
    // The full ref: a tag or local branch named `<remote>/<name>` makes the bare form
    // ambiguous, and git refuses to start from it.
    let start = format!("refs/remotes/{remote}/{name}");
    let (repo, local, start_s) = (repo_path.as_str(), name.as_str(), start.as_str());
    let out = run_minting_write(
        state,
        repo,
        &["switch", "--track", "-c", local, start_s],
        local,
        None,
        |out, held| async move {
            let by = TrackedBy::ExplicitTrack;
            let finished = finish_tracking_setup(&held, repo, out, local, start_s, by, true).await;
            finished.map(|finished| finished.out)
        },
    )
    .await?;
    full_failure_verdict(out)?;
    Ok(())
}

/// Build the argv for creating a branch. Pure so the decision table
/// (checkout × start_point × no_track) is unit-testable without a repo.
///
/// `no_track` suppresses git's automatic upstream setup so that basing a new
/// branch on a remote-tracking ref (e.g. `origin/epic/x`) yields a branch with
/// NO upstream — its first push then publishes it under its own name. Placement
/// matters: `--no-track` goes right after `switch` in the checkout arm, and
/// BEFORE the `--` in the `branch` arm.
fn build_create_branch_args(
    name: &str,
    checkout: bool,
    start_point: Option<&str>,
    no_track: bool,
) -> Vec<String> {
    let mut args: Vec<String> = if checkout {
        let mut a = vec!["switch".to_string()];
        if no_track {
            a.push("--no-track".to_string());
        }
        a.push("-c".to_string());
        a.push(name.to_string());
        a
    } else {
        let mut a = vec!["branch".to_string()];
        if no_track {
            a.push("--no-track".to_string());
        }
        a.push("--".to_string());
        a.push(name.to_string());
        a
    };
    if let Some(start) = start_point {
        args.push(start.to_string());
    }
    args
}

#[tauri::command]
pub async fn git_create_branch(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    checkout: bool,
    start_point: Option<String>,
    no_track: bool,
) -> AppResult<()> {
    git_create_branch_core(&state, repo_path, name, checkout, start_point, no_track).await
}

pub(crate) async fn git_create_branch_core(
    state: &AppState,
    repo_path: String,
    name: String,
    checkout: bool,
    start_point: Option<String>,
    no_track: bool,
) -> AppResult<()> {
    validate_branch_name(&name)?;
    refuse_session_branch_name(&name)?;
    if let Some(start) = &start_point {
        // start_point may be a branch name or a commit hash — validate as a ref
        // (non-empty, no leading '-') rather than strictly a hash.
        validate_ref_name(start)?;
    }
    let args = build_create_branch_args(&name, checkout, start_point.as_deref(), no_track);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (repo, local) = (repo_path.as_str(), name.as_str());
    // Any create but `--no-track` can set tracking up, the one leg that writes the
    // config: with no start point git starts from HEAD, where `always` tracks that
    // local branch and `inherit` copies its upstream (measured, git 2.51.1).
    if no_track {
        // Writes no config, so a lost config lock has nothing to repair.
        run_minting_write(state, repo, &arg_refs, local, None, |out, _| async move {
            Ok(out)
        })
        .await?
        .exit_verdict()?;
        return Ok(());
    }
    let start = start_point.as_deref().unwrap_or("HEAD");
    let out = run_minting_write(
        state,
        repo,
        &arg_refs,
        local,
        None,
        |out, held| async move {
            let by = TrackedBy::AutoSetupMerge;
            let finished =
                finish_tracking_setup(&held, repo, out, local, start, by, checkout).await;
            finished.map(|finished| finished.out)
        },
    )
    .await?;
    full_failure_verdict(out)?;
    Ok(())
}

/// A write that mints the branch `name` (`replaces` is the branch a rename moves off):
/// the working-tree domain, then the config-write mutex, each taken ONCE and both held
/// through git, with [`refuse_new_name_twin`] inside the mutex, so a twin another creator
/// in any checkout mints during the wait is still seen. A lost config lock hands the raw
/// output and the held mutex to `repair`, as [`run_git_mutating_config_write`] does; the
/// raw output comes back for the caller's verdict.
///
/// Before git runs, a name with no ref loses its leftover `branch.<name>` section, so a
/// minted branch carries only its own settings (a rename, or a create whose name is not
/// marked Keep local, removes it whole). A create keeps a true Keep local mark and drops
/// the section's other keys: Restore marks the name before it creates the branch and keeps
/// the mark when that create fails. A rename that does not land puts back what the drop
/// removed while the new name still has no ref.
///
/// [`run_git_mutating_config_write`]: crate::git::runner::run_git_mutating_config_write
async fn run_minting_write<F, Fut>(
    state: &AppState,
    repo_path: &str,
    args: &[&str],
    name: &str,
    replaces: Option<&str>,
    repair: F,
) -> AppResult<GitOutput>
where
    F: FnOnce(GitOutput, ConfigWriteHeld) -> Fut,
    Fut: std::future::Future<Output = AppResult<GitOutput>>,
{
    let domain = state.working_tree_lock(repo_path).await;
    let label = holder_label(subcommand_of(args));
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, label).await?;
    with_config_write_lock(repo_path, |held| async move {
        if let Some(old) = replaces {
            // Both waits above reopen the window of the rename's pre-wait publish check.
            refuse_while_publishing(repo_path, old).await?;
        }
        refuse_new_name_twin(repo_path, name, replaces).await?;
        let mut argv = args.to_vec();
        // A rename's `-M` was read before the hold: an exact `name` minted since then
        // takes `-m`, so git refuses instead of replacing it.
        if replaces.is_some() {
            if let Some(flag) = argv.iter_mut().find(|arg| **arg == "-M") {
                if exact_branch_tip(repo_path, name).await?.is_some() {
                    *flag = "-m";
                }
            }
        }
        let dropped =
            drop_leftover_branch_settings(&held, repo_path, name, replaces.is_some()).await?;
        #[cfg(test)]
        run_test_hook(&MINT_CLEANUP_HOOK).await;
        let out = run_git_raw_index_retry(repo_path, &argv, DEFAULT_TIMEOUT).await;
        // A refusal or a run that never finished (spawn error, timeout) restores; the
        // run's own result stays the answer.
        let landed = out.as_ref().is_ok_and(|out| out.code == 0);
        if !landed && replaces.is_some() && !dropped.is_empty() {
            restore_dropped_branch_settings(&held, repo_path, name, &dropped).await;
        }
        let out = out?;
        if is_config_lock_contention(&out.stderr) {
            return repair(out, held).await;
        }
        Ok(out)
    })
    .await
}

/// [`run_git_mutating_config_write`]'s verdict: a non-zero exit is [`AppError::Git`]
/// with [`GitOutput::full_failure_text`].
///
/// [`run_git_mutating_config_write`]: crate::git::runner::run_git_mutating_config_write
fn full_failure_verdict(out: GitOutput) -> AppResult<GitOutput> {
    if out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    Ok(out)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePair {
    pub base: String,
    pub head: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchMergeState {
    /// `head` is fully contained in `base` — nothing left to merge.
    pub merged: bool,
    /// The `head` branch still exists locally.
    pub head_exists: bool,
}

/// For each (base, head) pair, whether `head` is merged into `base` and whether
/// the `head` branch still exists. Reconciles local PRs whose branch was merged
/// (→ merged) or deleted (→ closed) outside the app.
#[tauri::command]
pub async fn git_branch_merge_states(
    repo_path: String,
    pairs: Vec<MergePair>,
) -> AppResult<Vec<BranchMergeState>> {
    let mut result = Vec::with_capacity(pairs.len());
    for pair in pairs {
        // The branch-name gate, not the ref gate: this reconciles LOCAL PR records,
        // and a record persisted with a rev expression (`feature~1`) would pass the
        // probe below and auto-transition the PR against a commit no branch is at.
        let valid_head = validate_branch_name(&pair.head).is_ok();
        let head_exists = if valid_head {
            run_git_raw(
                Some(&repo_path),
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{}", pair.head),
                ],
                DEFAULT_TIMEOUT,
            )
            .await?
            .code
                == 0
        } else {
            false
        };
        let merged = if valid_head && validate_branch_name(&pair.base).is_ok() {
            // Both are branch names: read as the branches, never same-named tags.
            let head = branch_first_rev(&repo_path, &pair.head).await;
            let base = branch_first_rev(&repo_path, &pair.base).await;
            run_git_raw(
                Some(&repo_path),
                &["merge-base", "--is-ancestor", &head, &base],
                DEFAULT_TIMEOUT,
            )
            .await?
            .code
                == 0
        } else {
            false
        };
        result.push(BranchMergeState {
            merged,
            head_exists,
        });
    }
    Ok(result)
}

// %(ahead-behind:<base>) prints ahead first; the rev-list loop below prints behind
// first, so the atom's counts must keep their own order.
fn parse_ahead_behind(base: &str, stdout: &str) -> Option<Vec<BranchDivergence>> {
    let mut rows = Vec::new();
    for line in stdout.lines().filter(|line| !line.is_empty()) {
        let mut tokens = line.rsplitn(3, ' ');
        let behind = tokens.next()?.parse::<u32>().ok()?;
        let ahead = tokens.next()?.parse::<u32>().ok()?;
        let name = tokens.next()?.strip_prefix("refs/heads/")?;
        if name.is_empty() || name.contains(' ') {
            return None;
        }
        rows.push(BranchDivergence {
            name: name.to_string(),
            ahead: if name == base { 0 } else { ahead },
            behind: if name == base { 0 } else { behind },
        });
    }
    Some(rows)
}

fn parse_git_version(stdout: &str) -> Option<(u32, u32)> {
    let mut parts = stdout.trim().strip_prefix("git version ")?.split('.');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

async fn ahead_behind_supported() -> bool {
    static SUPPORTED: tokio::sync::OnceCell<bool> = tokio::sync::OnceCell::const_new();
    match SUPPORTED
        .get_or_try_init(|| async {
            let out = run_git_raw(None, &["version"], DEFAULT_TIMEOUT).await?;
            Ok::<bool, AppError>(
                out.code == 0
                    && parse_git_version(&out.stdout_lossy()).is_some_and(|v| v >= (2, 41)),
            )
        })
        .await
    {
        Ok(supported) => *supported,
        Err(_) => false,
    }
}

async fn divergence_single_spawn(
    repo_path: &str,
    base: &str,
    base_rev: &str,
) -> AppResult<Option<Vec<BranchDivergence>>> {
    // These characters can change the for-each-ref format string's meaning, so
    // such a base must skip the fast path.
    if base_rev.contains([')', '%']) {
        return Ok(None);
    }
    let out = run_git_raw(
        Some(repo_path),
        &[
            "for-each-ref",
            "refs/heads",
            &format!("--format=%(refname) %(ahead-behind:{base_rev})"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(None);
    }
    Ok(parse_ahead_behind(base, &out.stdout_lossy()))
}

/// Compare branches to one base rev (default branch or compare base); the base itself reports 0/0.
/// Git >= 2.41 uses one for-each-ref. Refused bases, unreadable output, or any non-zero exit
/// (unsupported atom, unresolvable base) use per-branch rev-list; spawn errors/timeouts propagate.
#[tauri::command]
pub async fn git_branch_divergence(
    repo_path: String,
    base: String,
) -> AppResult<Vec<BranchDivergence>> {
    validate_ref_name(&base)?;
    let base_rev = branch_first_rev(&repo_path, &base).await;
    if ahead_behind_supported().await {
        if let Some(rows) = divergence_single_spawn(&repo_path, &base, &base_rev).await? {
            return Ok(rows);
        }
    }
    divergence_per_branch(&repo_path, &base, &base_rev).await
}

async fn divergence_per_branch(
    repo_path: &str,
    base: &str,
    base_rev: &str,
) -> AppResult<Vec<BranchDivergence>> {
    let out = run_git(
        Some(repo_path),
        &["for-each-ref", "refs/heads", "--format=%(refname)"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    // (full ref, name): the payload and the base comparison take the name, stripped of
    // exactly `refs/heads/` as `git_branches` strips it, and the range takes the full
    // ref (and the base its branch-first rev), which a bare name would lose to a
    // same-named tag.
    let refs: Vec<(String, String)> = out
        .stdout_lossy()
        .lines()
        .map(str::trim)
        .filter_map(|full| {
            let name = full.strip_prefix("refs/heads/").filter(|n| !n.is_empty())?;
            Some((full.to_string(), name.to_string()))
        })
        .collect();

    let mut result = Vec::with_capacity(refs.len());
    for (full, name) in refs {
        if name == base {
            result.push(BranchDivergence {
                name,
                ahead: 0,
                behind: 0,
            });
            continue;
        }
        // `base...name` left/right: left = on base only (behind), right = on
        // name only (ahead). A bad/unrelated ref just yields 0/0.
        let range = format!("{base_rev}...{full}");
        let counts = run_git_raw(
            Some(repo_path),
            &["rev-list", "--left-right", "--count", &range],
            DEFAULT_TIMEOUT,
        )
        .await?;
        let (mut behind, mut ahead) = (0u32, 0u32);
        if counts.code == 0 {
            let text = counts.stdout_lossy();
            let mut nums = text.split_whitespace();
            behind = nums.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            ahead = nums.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
        result.push(BranchDivergence {
            name,
            ahead,
            behind,
        });
    }
    Ok(result)
}

/// Evidence for telling a server-side REWRITE of a branch's upstream (GitHub's
/// "Update branch → rebase", any remote rebase or force-push) apart from ordinary
/// two-sided divergence — the two need OPPOSITE remedies, so the app must not
/// guess.
///
/// `remote_rewritten` answers one narrow question: is the upstream tip absent
/// from this branch's own reflog, i.e. has the branch ever literally been AT it.
/// That is a membership test over the same reflog `--force-if-includes` walks,
/// but a weaker question than the flag's — the flag asks whether the remote tip
/// is REACHABLE from some reflog entry, so a branch that saw the tip and then
/// merged or rebased past it satisfies the flag and fails this test. Those
/// shapes land on the ordinary-divergence arms, which is the safe direction.
///
/// It is NOT proof of a rewrite on its own either — ordinary divergence looks
/// identical (measured). Only paired with `local_only == 0` (no local commit
/// lacks a patch-twin upstream) does it describe the shape a rewrite produces,
/// and only that pair may drive a reset-to-upstream offer.
///
/// `None` means nothing was provable — no upstream, no reflog, any failed probe,
/// or a divergence too large to walk (a probe that SUCCEEDED but whose answer is
/// out of the range these surfaces serve) — and callers MUST then render exactly
/// what they render without this data. The inverse of
/// [`branch_has_reflog`](crate::git::remote)'s fail-safe on purpose: there, an
/// unrunnable probe must not unlock a degraded push; here, it must not unlock a
/// destructive offer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRewriteStatus {
    /// `Some(true)` = the upstream tip is not in the branch's reflog.
    pub remote_rewritten: Option<bool>,
    /// Commits on the branch with NO patch-equivalent upstream — exactly the work
    /// a reset to the upstream would destroy.
    pub local_only: u32,
    /// Commits on the upstream with no patch-equivalent locally.
    pub remote_only: u32,
    /// Commits `--cherry-mark` matched by patch id. It counts BOTH sides' members
    /// of each pair (measured, git 2.51.1), so a clean N-commit rebase reports
    /// `2 * N` — user-facing copy must not present it as a commit count.
    pub patch_equal: u32,
    /// The upstream's short name (e.g. `origin/feature`).
    pub upstream: Option<String>,
    /// The upstream tip's sha. A confirmed reset targets THIS commit rather than
    /// re-resolving the ref, so it can only ever land on the state the user was
    /// shown — and it keeps `git_reset`'s hex-only validator intact.
    pub upstream_tip: Option<String>,
    /// The branch's own tip when the status was measured. A confirmed reset pins
    /// this sha and the backend refuses if the branch moved off it since.
    pub local_tip: Option<String>,
}

impl BranchRewriteStatus {
    /// The zeroed, verdict-less shape. It is what the PRE-VERDICT arms return —
    /// the ones that bail before any count exists (no upstream, unresolvable tip,
    /// unreadable or oversized counts). A sub-probe that fails AFTER the counts
    /// land does NOT come here: the reflog arm keeps its real counts and only
    /// leaves `remote_rewritten: None` (pinned by
    /// `rewrite_status_without_a_reflog_refuses_to_guess`).
    fn unknown() -> Self {
        Self {
            remote_rewritten: None,
            local_only: 0,
            remote_only: 0,
            patch_equal: 0,
            upstream: None,
            upstream_tip: None,
            local_tip: None,
        }
    }
}

/// Classifies a diverged branch against its upstream. Read-only: every spawn is a ref
/// or history read, so this is safe to call from a menu-open path; a read's non-zero
/// exit, and any failure of the tip read, answers the unknown verdict, and another
/// failed spawn is the `Err`.
#[tauri::command]
pub async fn git_branch_rewrite_status(
    repo_path: String,
    branch: String,
) -> AppResult<BranchRewriteStatus> {
    branch_rewrite_status(&repo_path, &branch).await
}

pub(crate) async fn branch_rewrite_status(
    repo_path: &str,
    branch: &str,
) -> AppResult<BranchRewriteStatus> {
    validate_branch_name(branch)?;
    // git looks the name before `@{upstream}` up as a BRANCH, so no same-named tag can
    // capture it, and the `refs/heads/` spelling is refused ("no such branch").
    let upstream_rev = format!("{branch}@{{upstream}}");

    // No upstream at all → nothing to compare against. `rev-parse` exits non-zero
    // and writes its own diagnostic; that is a normal answer here, not a failure.
    // Read in FULL and stripped: `--abbrev-ref` disambiguates, so a tag named
    // `origin/feature` turns the display into `remotes/origin/feature`.
    let full = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--symbolic-full-name", &upstream_rev],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if full.code != 0 {
        return Ok(BranchRewriteStatus::unknown());
    }
    let full = full.stdout_lossy();
    let full = full.trim();
    let upstream = full
        .strip_prefix("refs/remotes/")
        .or_else(|| full.strip_prefix("refs/heads/"))
        .unwrap_or(full)
        .to_string();
    if upstream.is_empty() {
        return Ok(BranchRewriteStatus::unknown());
    }
    let Ok(Some(local_tip)) = branch_tip_sha(repo_path, branch).await else {
        return Ok(BranchRewriteStatus::unknown());
    };

    let tip_out = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{upstream_rev}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if tip_out.code != 0 {
        return Ok(BranchRewriteStatus::unknown());
    }
    let tip = tip_out.stdout_lossy().trim().to_string();
    if tip.is_empty() {
        return Ok(BranchRewriteStatus::unknown());
    }

    // Both ends as measured shas: a bare branch name resolves to a same-named tag
    // first, and the upstream side is then the exact commit a reset would land on.
    let range = format!("{local_tip}...{tip}");

    // Cheap size gate BEFORE the patch-id walk: `--cherry-mark` computes a patch id
    // for every commit on both sides, which means diffing each one, where a plain
    // left/right count only walks the graph.
    //
    // The two bounds are ASYMMETRIC because they answer different questions, and a
    // single sum-based bound gets the motivating case wrong: "Update branch →
    // rebase" on a branch forked far back leaves a handful of local commits against
    // a huge remote side (3 local vs ~253 remote is the reported shape), which a
    // combined 200 would refuse — disabling the feature exactly where it exists to
    // help. So the LOCAL side alone carries the copy bound, since it is the N in
    // "all N commits are already upstream", and the remote side is allowed to be
    // enormous.
    let sizes = run_git_raw(
        Some(repo_path),
        &["rev-list", "--left-right", "--count", &range],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if sizes.code != 0 {
        return Ok(BranchRewriteStatus::unknown());
    }
    if divergence_out_of_range(
        &sizes.stdout_lossy(),
        MAX_LOCAL_COMMITS_FOR_COPY,
        MAX_CHERRY_MARK_TOTAL,
    ) {
        return Ok(BranchRewriteStatus::unknown());
    }

    // Symmetric difference with patch-id matching: left = branch-only, right =
    // upstream-only, third = the patch-equal commits `--cherry-mark` paired off.
    let counts = run_git_raw(
        Some(repo_path),
        &[
            "rev-list",
            "--left-right",
            "--cherry-mark",
            "--count",
            &range,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if counts.code != 0 {
        return Ok(BranchRewriteStatus::unknown());
    }
    let Some((local_only, remote_only, patch_equal)) =
        parse_cherry_counts(&counts.stdout_lossy())
    else {
        return Ok(BranchRewriteStatus::unknown());
    };

    // `--walk-reflogs` lists the commit each of the branch's reflog entries names.
    // A branch with no reflog (core.logAllRefUpdates=false, or an expired one)
    // yields nothing to walk, which cannot distinguish anything — verdict stays
    // `None` rather than reading absence as a rewrite. The full ref, because a bare
    // name with no branch reflog falls back to a same-named ref's (a tag's, under
    // `logAllRefUpdates=always`).
    let reflog = run_git_raw(
        Some(repo_path),
        &[
            "rev-list",
            "--walk-reflogs",
            &format!("refs/heads/{branch}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let reflog_text = reflog.stdout_lossy();
    let mut entries = reflog_text.lines().map(str::trim).filter(|l| !l.is_empty());
    let remote_rewritten = if reflog.code != 0 {
        None
    } else {
        let mut seen = false;
        let contains = entries.any(|l| {
            seen = true;
            l == tip
        });
        // `any` short-circuits, so a hit leaves `seen` true; a miss walked the
        // whole list and `seen` distinguishes "no entries" from "not found".
        if contains {
            Some(false)
        } else if seen {
            Some(true)
        } else {
            None
        }
    };

    Ok(BranchRewriteStatus {
        remote_rewritten,
        local_only,
        remote_only,
        patch_equal,
        upstream: Some(upstream),
        upstream_tip: Some(tip),
        local_tip: Some(local_tip),
    })
}

/// Commits on the LOCAL side past which this probe stops being useful. Purely a
/// UI bound: it is the N in the confirm's "all N commits are already upstream",
/// and a branch carrying that many unique commits wants a rebase, not a one-click
/// reset. The REMOTE side is deliberately unbounded here — a branch forked far
/// back sits hundreds of commits behind by construction, which says nothing about
/// whether its own handful of commits were replayed.
const MAX_LOCAL_COMMITS_FOR_COPY: u32 = 200;

/// Total two-sided divergence past which the patch-id walk is refused on COST
/// alone — nothing to do with the copy. `--cherry-mark` diffs every commit on both
/// sides; this caps that work for a pathological range while staying far above any
/// shape the feature actually serves.
const MAX_CHERRY_MARK_TOTAL: u32 = 1000;

/// Whether a plain `rev-list --left-right --count` reply is outside the range this
/// probe will walk: more than `max_local` commits on the LOCAL side (a copy bound)
/// or more than `max_total` across both (a cost bound). An unreadable reply answers
/// `true` — the caller turns that into the no-verdict shape, the same "never guess"
/// direction that governs [`parse_cherry_counts`].
fn divergence_out_of_range(text: &str, max_local: u32, max_total: u32) -> bool {
    let mut nums = text.split_whitespace();
    let mut next = || nums.next()?.parse::<u32>().ok();
    match (next(), next()) {
        (Some(left), Some(right)) => {
            left > max_local || left.saturating_add(right) > max_total
        }
        _ => true,
    }
}

/// Parses `rev-list --left-right --cherry-mark --count`'s reply into
/// `(local_only, remote_only, patch_equal)`.
///
/// ALL THREE or nothing. A per-field default would fabricate `local_only == 0`,
/// which is half of the pair that unlocks the destructive reset offer — the one
/// value this must never invent, so an unreadable line answers `None` and the
/// whole status degrades to "nothing provable".
fn parse_cherry_counts(text: &str) -> Option<(u32, u32, u32)> {
    let mut nums = text.split_whitespace();
    let mut next = || nums.next()?.parse::<u32>().ok();
    Some((next()?, next()?, next()?))
}

/// Points a branch at its upstream's tip, the remedy when the remote rewrote it and
/// nothing local is unique. Never touches a working tree, so it is the NON-current-branch
/// half of the reset story; the current branch goes through `git_reset` in `--hard` mode.
///
/// Refused with the holding worktree named when the branch is checked out, rebased,
/// bisected, or listed for a stacked `rebase --update-refs` ANYWHERE, a linked worktree
/// or this checkout itself. The ref moves by `update-ref`, which refuses none of these,
/// so those probes fail closed.
///
/// Two measured shas pin the move: `expected_tip`, the upstream tip the user was shown
/// (a background fetch that moved it refuses), and `expected_local_tip`, the branch's own
/// tip then (an outside commit refuses rather than being dropped). The guards and the
/// compare-and-swap share one working-tree hold, so only an operation this checkout's
/// hold doesn't serialize (another process, or this app in a linked worktree, whose
/// working-tree domain is its own) can slip past them. A dead update's hidden checkout
/// is swept BEFORE the hold: its removal takes the admin domain and can run for minutes.
#[tauri::command]
pub async fn git_branch_reset_to_upstream(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
    expected_tip: String,
    expected_local_tip: String,
) -> AppResult<()> {
    branch_reset_to_upstream(
        &state,
        &repo_path,
        &branch,
        &expected_tip,
        &expected_local_tip,
    )
    .await
}

pub(crate) async fn branch_reset_to_upstream(
    state: &AppState,
    repo_path: &str,
    branch: &str,
    expected_tip: &str,
    expected_local_tip: &str,
) -> AppResult<()> {
    branch_reset_to_upstream_within(
        state,
        repo_path,
        branch,
        expected_tip,
        expected_local_tip,
        LOCK_WAIT_TIMEOUT,
    )
    .await
}

/// [`branch_reset_to_upstream`] with the working-tree lock's wait bound as a seam: a
/// test holding the lock passes `Duration::ZERO` to get `Busy` at once, while a free
/// lock is still taken (runner.rs's `acquire_repo_lock` contract).
async fn branch_reset_to_upstream_within(
    state: &AppState,
    repo_path: &str,
    branch: &str,
    expected_tip: &str,
    expected_local_tip: &str,
    lock_wait: std::time::Duration,
) -> AppResult<()> {
    validate_branch_name(branch)?;
    crate::git::history::validate_hash(expected_tip)?;
    crate::git::history::validate_hash(expected_local_tip)?;
    let upstream_rev = format!("{branch}@{{upstream}}");
    let tip_out = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{upstream_rev}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if tip_out.code != 0 {
        return Err(AppError::InvalidArgument(format!(
            "{branch} has no upstream branch to reset to."
        )));
    }
    let tip = tip_out.stdout_lossy().trim().to_string();
    if tip != expected_tip {
        return Err(AppError::InvalidArgument(format!(
            "{branch}'s upstream moved since this was measured — reopen the branch \
             menu to see where it stands now."
        )));
    }

    // KEEP IN STEP: one wording family with ops.rs's `RESET_HEAD_MOVED`, commit.rs's
    // `UNDO_HEAD_MOVED` and `git_delete_branch_core`'s moved ref ("… — nothing was <verb>.").
    let moved = || AppError::Git {
        code: 1,
        stderr: format!("{branch} changed since you confirmed — nothing was reset."),
    };

    let checked_out = |path: String| {
        AppError::Command(format!(
            "{branch} is checked out in the worktree at {path} — switch that worktree \
             to another branch (or remove it) before resetting {branch}."
        ))
    };
    // Pre-mutation guards. `update-ref` refuses none of these itself, so a probe that
    // errors refuses too. The linked-worktree probe excludes THIS checkout, so the
    // current branch takes its own arm. An update's hidden checkout names no remedy
    // the user can follow: refused while live, and swept once dead OUTSIDE the hold,
    // since its removal runs in the admin domain (see `clear_update_holder`).
    if let Some(path) = worktree_holding_branch_checked(repo_path, branch).await? {
        if !clear_update_holder(state, repo_path, branch, &path).await? {
            return Err(checked_out(path));
        }
        // A holder found there after the sweep gets the update refusal when its marker
        // proves it live or dead; otherwise the caller's own message.
        if let Some(path) = worktree_holding_branch_checked(repo_path, branch).await? {
            return Err(update_holder_refusal(state, repo_path, branch, &path)
                .await
                .unwrap_or_else(|| checked_out(path)));
        }
    }

    // One hold across the re-probes, the local-tip compare and the swap. Every spawn
    // under it is lock-free: `run_git_mutating` re-acquires this non-reentrant domain.
    let domain = state.working_tree_lock(repo_path).await;
    let _guard = acquire_repo_lock(&domain, lock_wait, "a reset").await?;
    // Two halves of one window, as in `git_delete_branch_core`: the marker covers an
    // update that has minted but not yet registered its checkout, the porcelain arm
    // below covers it once registered. Heal-free — healing lives in the claim arm.
    crate::git::update_marker::refuse_if_branch_updating_no_heal(state, repo_path, branch).await?;
    // Re-probed under the hold and never swept here: a holder that registered or died
    // since the probe above refuses, and a retry sweeps a dead one.
    if let Some(path) = worktree_holding_branch_checked(repo_path, branch).await? {
        return Err(update_holder_refusal(state, repo_path, branch, &path)
            .await
            .unwrap_or_else(|| checked_out(path)));
    }
    if let Some(current) = current_branch_name(repo_path).await? {
        if holds_branch(repo_path, &current, branch).await {
            return Err(AppError::Command(format!(
                "{branch} is checked out here — use Reset to {branch}'s upstream from the \
                 sync controls, which moves your working tree with it."
            )));
        }
    }
    if let Some(refusal) = branch_operation_refusal(repo_path, branch, "resetting").await? {
        return Err(AppError::Command(refusal));
    }
    // `update-ref` writes by `branch`'s spelling, which for an aliased spelling, or a case
    // twin where refs alias, is another branch's file under a checkout the guards above,
    // keyed on `branch`'s spelling, miss.
    if bare_move_tip(repo_path, branch).await?.as_deref() != Some(expected_local_tip) {
        return Err(moved());
    }
    // The reflog line is the one `branch -f` writes, so recovery reads the same.
    let message = format!("branch: Reset to {tip}");
    let full_ref = format!("refs/heads/{branch}");
    let out = run_git_raw(
        Some(repo_path),
        &[
            "update-ref",
            "-m",
            &message,
            &full_ref,
            &tip,
            expected_local_tip,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        // A failed swap reads as moved only when the branch really moved; a stale ref
        // `.lock` keeps git's own error.
        if branch_tip_sha(repo_path, branch).await?.as_deref() != Some(expected_local_tip) {
            return Err(moved());
        }
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    Ok(())
}

/// Updates `branch` with the latest commits from `base` WITHOUT switching to it, so
/// the user's working tree — and any watchers (vite, `tsc --watch`) — never change.
///
/// - already contains `base` → no-op, `"up-to-date"`.
/// - strictly behind → fast-forward the ref, `"fast-forward"`.
/// - diverged → merge `base` in a throwaway worktree so the main checkout is
///   untouched, `"merge"`; a conflicting merge is aborted and the branch left as-is,
///   and a `branch` that moved while that worktree was materializing is refused.
/// - checked out in ANOTHER checkout → the same fast-forward or merge runs inside that
///   checkout, which reports back as `holder`; a session's, mid-operation, dirty or
///   conflicting holder is refused as [`AppError::BranchHeld`] with nothing changed,
///   and one whose folder is missing as a plain `Command` error, with nothing to open.
///
/// When `branch` IS the current branch there's nothing to avoid switching to, so it
/// merges in place (conflicts surface in the changes list as usual — no abort), and
/// the outcome follows what that merge did to HEAD: unchanged → `"up-to-date"`, moved
/// to `base`'s tip → `"fast-forward"`, otherwise (or when HEAD can't be read) `"merge"`.
#[tauri::command]
pub async fn git_update_branch_from(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
    base: String,
) -> AppResult<UpdateBranchOutcome> {
    use tauri::Manager;
    let session_paths = crate::sessions::session_worktree_paths(&app);
    // The same root `worktree::git_worktree_list_user` hides as app-internal.
    let app_data_root =
        app.path().app_data_dir().ok().map(|d| {
            crate::git::worktree::normalize_wt_path(&d.join("worktrees").to_string_lossy())
        });
    update_branch_from(
        &state,
        &repo_path,
        &branch,
        &base,
        &session_paths,
        app_data_root.as_deref(),
    )
    .await
}

/// What an update did, and where.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateBranchOutcome {
    /// "merge" | "up-to-date" | "fast-forward" — the existing strings, unchanged.
    pub outcome: String,
    /// The holder checkout's path (porcelain spelling from `worktree list`) when the
    /// update ran inside another checkout; None on every other arm.
    pub holder: Option<String>,
}

impl UpdateBranchOutcome {
    /// An update that ran in this checkout or a throwaway one.
    fn unheld(outcome: &str) -> Self {
        Self {
            outcome: outcome.to_string(),
            holder: None,
        }
    }
}

/// The commit `rev` names, or None when the read fails. Lock-free: callers hold the
/// working-tree lock.
async fn commit_oid(repo_path: &str, rev: &str) -> Option<String> {
    let peeled = format!("{rev}^{{commit}}");
    let out = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--verify", "-q", &peeled],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let oid = out.stdout_lossy().trim().to_string();
    (out.code == 0 && !oid.is_empty()).then_some(oid)
}

/// The commit HEAD resolves to in the checkout at `checkout`; `None` for an unborn or
/// unresolvable HEAD, a failed spawn the `Err`. A holder arm merges into that HEAD, so it
/// acts only when this is the tip of the branch it was asked to move, read under its hold.
pub(crate) async fn head_commit(checkout: &str) -> AppResult<Option<String>> {
    let out = run_git_raw(
        Some(checkout),
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let oid = out.stdout_lossy().trim().to_string();
    Ok((out.code == 0 && !oid.is_empty()).then_some(oid))
}

/// Whether a write through the HEAD of a checkout on `now`, which holds the stored
/// `branch`, must be refused. A write there goes to `now`'s ref file, so a different leaf
/// (compared byte for byte) renames or twins `branch`, while a folder-only difference
/// writes the stored leaf in place; a HEAD that resolves to no commit (`head_resolves`
/// false) under any other spelling is refused too, since git can't read it there.
pub(crate) fn writes_through_another_spelling(
    now: &str,
    branch: &str,
    head_resolves: bool,
) -> bool {
    let leaf = |name: &str| name.rsplit('/').next().map(str::to_owned);
    leaf(now) != leaf(branch) || (!head_resolves && now != branch)
}

/// The refusal for a checkout that [`writes_through_another_spelling`] stops: a retry
/// refuses alike until that checkout names the branch exactly.
pub(crate) fn other_spelling_message(holder: &str, now: &str, branch: &str) -> String {
    format!(
        "The checkout at {holder} is on {now}, a different capitalization of {branch}, so \
         nothing was updated there. Check out {branch} by its exact name there, then try \
         again. {branch} is unchanged."
    )
}

/// The refusal for a checkout that no longer holds `branch` at its tip under its hold; a
/// retry re-reads and takes whichever arm then applies.
fn switched_away_message(holder: &str, branch: &str) -> String {
    format!(
        "The checkout at {holder} switched away from {branch} before it could be updated — \
         try again. {branch} is unchanged."
    )
}

/// [`update_branch_from`]'s verdict on merging in place through HEAD.
#[derive(Debug, PartialEq, Eq)]
enum InPlace {
    Merge,
    /// The current checkout is not on `branch`: the holder and bare arms update it.
    NotHeld,
    /// Refused: on a store whose names alias, a bare write would move the ref under HEAD.
    Moved,
}

/// [`InPlace`] for a checkout `holds` (by [`holds_branch`]) on the exact name or another
/// spelling of the stored branch. Another spelling merges only where the store's names can
/// alias (`can_alias`, read strictly) and HEAD is the branch's tip under the hold. Only the
/// truth-table test reaches the `can_alias` and HEAD-at-tip conjuncts: with stable reads
/// `holds` is already false for another spelling where names can't alias, and an aliased
/// spelling's HEAD leaves the tip only across a race.
fn in_place_gate(
    exact_name: bool,
    holds: bool,
    can_alias: bool,
    head: Option<&str>,
    tip: Option<&str>,
) -> InPlace {
    if !holds {
        InPlace::NotHeld
    } else if exact_name {
        InPlace::Merge
    } else if !can_alias {
        InPlace::NotHeld
    } else if head.is_none() || head != tip {
        InPlace::Moved
    } else {
        InPlace::Merge
    }
}

/// The in-place arm's outcome, read from what the merge did rather than a pre-probe:
/// the user's `merge.ff` decides whether git fast-forwards or makes a merge commit.
/// Only two successful reads may claim "up-to-date" or "fast-forward"; else "merge".
fn in_place_outcome(before: Option<&str>, after: Option<&str>, base: Option<&str>) -> &'static str {
    match (before, after) {
        (Some(b), Some(a)) if a == b => "up-to-date",
        (Some(_), Some(a)) if base == Some(a) => "fast-forward",
        _ => "merge",
    }
}

/// Testable core of [`git_update_branch_from`] — takes a plain `&AppState` so
/// real-repo tokio tests can drive it (mirrors `git::ops`' `*_core` pairs).
/// `session_paths` (the agent-session registry's worktree set) and `app_data_root` (the
/// normalized app-data worktrees root) name checkouts a held branch is never updated in.
pub(crate) async fn update_branch_from(
    state: &AppState,
    repo_path: &str,
    branch: &str,
    base: &str,
    session_paths: &HashSet<String>,
    app_data_root: Option<&str>,
) -> AppResult<UpdateBranchOutcome> {
    validate_branch_name(branch)?;
    validate_branch_name(base)?;
    // A case variant of a stored branch acts as that branch from here on, so the marker
    // checks below see the name its marker is minted under. Read before the hold, which is
    // safe: every write re-reads under one, through a checkout's HEAD that `holds_branch`
    // matches, or through `bare_move_tip`, which refuses a name renamed meanwhile.
    let stored = stored_branch_spelling(repo_path, branch).await?;
    let branch = stored.as_str();
    if branch == base {
        return Err(AppError::InvalidArgument(
            "a branch can't be updated from itself".to_string(),
        ));
    }
    // One guard covers both self-collisions: a second update of the same branch, and
    // the fast-forward arm's `fetch . <base>:<branch>`, which git refuses outright
    // against a branch held by the first update's checkout. Heal-free deliberately —
    // this path's own `worktree add` takes the admin domain, and a detached sweep
    // fired here would win it first and time that bounded acquire out.
    crate::git::update_marker::refuse_if_branch_updating_no_heal(state, repo_path, branch).await?;
    // Healing, in two tiers. THIS branch's provably-dead leftovers go first and
    // synchronously, so the first update after a crash clears its own predecessor
    // before the add rather than racing it; everything else waits for the age gate and
    // is skipped outright while the admin domain is busy.
    crate::git::update_marker::claim_dead_updates_for_branch(state, repo_path, branch).await;
    crate::git::update_marker::sweep_orphaned_update_worktrees(state, repo_path).await;

    // Mutating refs — serialize against other writes to this repo's working tree.
    let domain = state.working_tree_lock(repo_path).await;
    let guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a branch update").await?;

    // An unborn branch has nothing to merge into, and an in-place merge would adopt
    // `base`'s history as its first commit.
    let current = current_branch_name(repo_path).await?;
    if current.is_some() && head_is_unborn(repo_path).await? {
        return Err(unborn_head_error());
    }
    // Every rev position below reads `base` as a branch, never a same-named tag, and
    // `branch` by its tip sha.
    let base_rev = branch_first_rev(repo_path, base).await;

    // The current branch is already checked out, so just merge in place. The merge
    // reads only HEAD and `base`, so an aliased spelling of it lands here too, once
    // `in_place_gate` has seen HEAD at the branch's tip under this hold.
    let holds = match current.as_deref() {
        Some(current) => holds_branch(repo_path, current, branch).await,
        None => false,
    };
    let exact_name = current.as_deref() == Some(branch);
    let mut can_alias = false;
    let (mut head, mut tip) = (None, None);
    if holds && !exact_name {
        can_alias = refs_can_alias_strict(repo_path).await?;
        if can_alias {
            head = head_commit(repo_path).await?;
            tip = branch_tip_sha(repo_path, branch).await?;
        }
    }
    let in_place = match in_place_gate(
        exact_name,
        holds,
        can_alias,
        head.as_deref(),
        tip.as_deref(),
    ) {
        InPlace::Merge => true,
        InPlace::NotHeld => false,
        InPlace::Moved => {
            return Err(AppError::Command(switched_away_message(repo_path, branch)));
        }
    };
    if let Some(current) = current.as_deref().filter(|_| in_place) {
        // HEAD resolves: an unborn one was refused above, under this hold.
        if writes_through_another_spelling(current, branch, true) {
            return Err(AppError::Command(other_spelling_message(
                repo_path, current, branch,
            )));
        }
    }
    if in_place {
        let already_unmerged = crate::git::ops::unmerged_paths(repo_path).await;
        // A fetch can't change git's own refusal verdict, so a blocked merge skips the
        // network wait that only the ignored-file check needs.
        let blocked = ignored_guard::merge_is_blocked(repo_path, &already_unmerged)
            .await
            .map_err(|e| ignored_guard::check_failed("Update", e))?;
        let network = state.network_lock(repo_path).await;
        let _net_guard = if blocked {
            None
        } else {
            Some(acquire_repo_lock(&network, NETWORK_LOCK_WAIT_TIMEOUT, "a branch update").await?)
        };
        if !blocked {
            if let Some(incoming_sha) =
                ignored_guard::target_commit(repo_path, &base_rev, DEFAULT_TIMEOUT, "Update")
                    .await?
            {
                let paths = ignored_files_in_the_way(repo_path, &incoming_sha, DEFAULT_TIMEOUT)
                    .await
                    .map_err(|e| ignored_guard::check_failed("Update", e))?;
                if !paths.is_empty() {
                    return Err(ignored_guard::update_refusal(branch, base, &paths));
                }
            }
        }
        let head_before = commit_oid(repo_path, "HEAD").await;
        // Raw: a conflicted merge reports entirely on stdout and leaves stderr
        // empty (measured, git 2.51.1), which a stderr-only error renders as
        // "git exited with code 1". Lock-free runners only — the hold is ours.
        let out = run_git_raw(
            Some(repo_path),
            &["merge", "--no-edit", "--no-overwrite-ignore", &base_rev],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if out.code != 0 {
            return Err(crate::git::ops::classify_failure(
                repo_path,
                "merge",
                &already_unmerged,
                out.code,
                out.full_failure_text(),
            )
            .await);
        }
        return Ok(UpdateBranchOutcome::unheld(in_place_outcome(
            head_before.as_deref(),
            commit_oid(repo_path, "HEAD").await.as_deref(),
            commit_oid(repo_path, &base_rev).await.as_deref(),
        )));
    }

    // Read under THIS hold: the diverged arm below pins it too.
    let Some(branch_tip) = branch_tip_sha(repo_path, branch).await? else {
        return Err(AppError::InvalidArgument(format!(
            "unknown branch: {branch}"
        )));
    };

    // base already reachable from branch → nothing to bring in.
    let already = run_git_raw(
        Some(repo_path),
        &["merge-base", "--is-ancestor", &base_rev, &branch_tip],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if already.code == 0 {
        return Ok(UpdateBranchOutcome::unheld("up-to-date"));
    }

    // branch reachable from base → pure fast-forward.
    let ff = run_git_raw(
        Some(repo_path),
        &["merge-base", "--is-ancestor", &branch_tip, &base_rev],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let fast_forward = ff.code == 0;

    // Pinned under THIS hold, because the holder and diverged arms below release it: the
    // base for both, the branch's tip for the diverged arm, which a holder re-reads under
    // its own hold.
    let base_out = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base_rev}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if base_out.code != 0 {
        return Err(AppError::InvalidArgument(format!("unknown branch: {base}")));
    }
    let pins = UpdatePins {
        branch_tip,
        base_sha: base_out.stdout_lossy().trim().to_string(),
    };

    // A branch another checkout holds is updated INSIDE that checkout. Clearing a dead
    // update's holder takes ADMIN and removes its checkout under THIS hold: a bounded,
    // try-only exception to the nesting rule, rare once `claim_dead_updates_for_branch` ran.
    let mut holder = worktree_holding_branch_checked(repo_path, branch).await?;
    if let Some(path) = holder.as_deref() {
        if clear_update_holder(state, repo_path, branch, path).await? {
            holder = worktree_holding_branch_checked(repo_path, branch).await?;
        }
    }
    if let Some(holder) = holder {
        if is_session_holder(&holder, branch, session_paths, app_data_root) {
            return Err(branch_held(
                "session",
                &holder,
                branch,
                format!(
                    "{branch} is checked out in a worktree GitDesktop manages at {holder}, so \
                     it is not updated from here. {branch} is unchanged."
                ),
            ));
        }
        let merge = if fast_forward {
            HolderMerge::FastForward
        } else {
            HolderMerge::Merge {
                subject: merge_subject(repo_path, &base_rev, branch).await,
            }
        };
        // The throwaway arm's marker, minted under THIS hold so the guards refusing a
        // rename, delete or second update of a branch mid-update see this one too. Nothing
        // is ever created at its path, so settling it always deletes the pair.
        let tmp = update_worktree_path(repo_path).await?;
        if let Some(root) = tmp.parent() {
            std::fs::create_dir_all(root).map_err(AppError::Io)?;
        }
        let marker = crate::git::update_marker::UpdateMarker::create_for(&tmp, branch)?;
        // Two sibling checkouts' working-tree locks are never held together (only a
        // submodule accept nests, parent then child): release this checkout's first.
        drop(guard);
        let result = update_in_holder(state, &holder, branch, base, &pins.base_sha, merge).await;
        settle_marker(Some(marker), &tmp.to_string_lossy());
        return result;
    }

    // A rebase or bisect working on `branch` usually lists its checkout as detached, so no
    // holder took it above. git's own refusal in either bare arm is keyed on spelling, so
    // an operation recorded on a case variant would let the ref move under it.
    if let Some(refusal) = branch_operation_refusal(repo_path, branch, "updating").await? {
        return Err(AppError::Command(refusal));
    }

    // Both bare arms below write the ref by `branch`'s spelling: for a case twin where refs
    // alias, git writes a loose file that the twin's spelling also reads, under any
    // checkout on the twin, which git's own checked-out test (keyed on spelling) misses.
    if bare_move_tip(repo_path, branch).await?.is_none() {
        return Err(AppError::InvalidArgument(format!(
            "unknown branch: {branch}"
        )));
    }

    // `fetch .` refuses a branch checked out under its own spelling, so it runs only for
    // an UNHELD one: the current branch took the in-place arm, every held one the holder
    // arm, and a twin was refused above where refs can alias. Its SOURCE resolves
    // tag-first like any rev; the destination is spelled in full so it can only ever name
    // the branch.
    if fast_forward {
        run_git(
            Some(repo_path),
            &["fetch", ".", &format!("{base_rev}:refs/heads/{branch}")],
            DEFAULT_TIMEOUT,
        )
        .await?;
        return Ok(UpdateBranchOutcome::unheld("fast-forward"));
    }

    // Diverged → merge in a throwaway worktree so the user's checkout is untouched. The
    // worktree steps below run in the worktree-admin domain, which no blocking hold nests
    // with (a dead holder's claim in the holder probe above takes it try-only under the
    // working-tree hold).
    drop(guard);

    // Minted under the app-data worktrees root, never the OS temp dir: that
    // placement is what hides the checkout from the user-facing worktree listing
    // and the surfaces built on it (`is_session_worktree`'s app-data arm).
    let tmp = update_worktree_path(repo_path).await?;
    if let Some(root) = tmp.parent() {
        std::fs::create_dir_all(root).map_err(AppError::Io)?;
    }
    // Before the `worktree add`, which is the longest part of the window this marker
    // exists to announce. A failure to mint refuses the update: an app-data write that
    // fails is the same failure domain as materializing the checkout itself.
    let marker = crate::git::update_marker::UpdateMarker::create_for(&tmp, branch)?;
    let tmp_str = tmp.to_string_lossy().to_string();
    merge_diverged_in_worktree(
        state,
        repo_path,
        &tmp_str,
        branch,
        base,
        &pins,
        Some(marker),
    )
    .await
    .map(|outcome| UpdateBranchOutcome::unheld(&outcome))
}

/// Whether `holder` is an app-internal checkout, matched as the worktree manager hides
/// one (`worktree::is_session_worktree`): registry paths compared normalized, with the
/// `gd/session/` branch and the app-data root (a hidden update's home too) as backstops.
/// The root takes a trailing separator, so a SIBLING `<root>x/…` never matches.
fn is_session_holder(
    holder: &str,
    branch: &str,
    session_paths: &HashSet<String>,
    app_data_root: Option<&str>,
) -> bool {
    use crate::git::worktree::normalize_wt_path;
    let holder = normalize_wt_path(holder);
    is_session_branch_name(branch)
        || session_paths.iter().any(|p| normalize_wt_path(p) == holder)
        || app_data_root.is_some_and(|root| holder.starts_with(&format!("{root}/")))
}

/// A refusal from the holder arm, which leaves `branch` and its holder as they were.
fn branch_held(reason: &str, holder: &str, branch: &str, message: String) -> AppError {
    AppError::BranchHeld {
        message,
        holder: holder.to_string(),
        branch: branch.to_string(),
        reason: reason.to_string(),
    }
}

/// Which merge the holder arm runs, decided by the ancestry read under the first hold.
enum HolderMerge {
    FastForward,
    /// `subject` words the commit as a merge of `base` by name ([`merge_subject`]).
    Merge {
        subject: Option<String>,
    },
}

/// The update of a `branch` that the checkout at `holder` has checked out: `fetch .`
/// and `worktree add` both refuse a held branch, so the fast-forward or merge runs
/// inside that checkout, under ITS working-tree lock, and its index and tree advance
/// with the ref. The caller must not hold another working-tree lock, and everything
/// here runs on lock-free runners because the hold is ours.
///
/// The merge takes `base_sha`, the base PINNED under the first hold, so a base that
/// moved after the pin cannot change what lands, and runs only while the holder's HEAD
/// is the branch's tip read under the holder's own hold, which may be past the first
/// read's. A branch that already contains the pin by the time the hold is taken answers
/// `"up-to-date"` without merging.
async fn update_in_holder(
    state: &AppState,
    holder: &str,
    branch: &str,
    base: &str,
    base_sha: &str,
    merge: HolderMerge,
) -> AppResult<UpdateBranchOutcome> {
    validate_branch_name(branch)?;
    // Before the lock, whose key resolution already spawns git there: a LOCKED worktree
    // whose folder is gone still lists, and still holds its branch, since prune skips it.
    // It pre-empts that steady state only; a folder removed after it gets the raw error.
    if matches!(std::path::Path::new(holder).try_exists(), Ok(false)) {
        return Err(AppError::Command(format!(
            "The worktree at {holder} still holds {branch}, but its folder is missing. Unlock \
             and prune that worktree (or restore its folder), then try again. {branch} is \
             unchanged."
        )));
    }
    let domain = state.working_tree_lock(holder).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a branch update").await?;

    // Re-checked under the hold, in order: the holder was found before it was taken.
    // Everything below acts on the holder's HEAD, never on `branch`'s spelling, so the
    // checkout must still hold the branch under a spelling a write there keeps, and HEAD
    // must be the branch's tip as read under this hold. In the merge arm a commit made
    // there since the first read is merged into (the fast-forward arm fails on it), and
    // an unborn HEAD, which would take the merge as its first commit, is refused.
    let now = current_branch_name(holder).await?;
    let still = match now.as_deref() {
        Some(now) => {
            holds_branch(holder, now, branch).await
                && spelling_reaches_branch(holder, now, branch).await?
        }
        None => false,
    };
    let head = if still {
        head_commit(holder).await?
    } else {
        None
    };
    if let Some(now) = now.as_deref().filter(|_| still) {
        if writes_through_another_spelling(now, branch, head.is_some()) {
            let message = other_spelling_message(holder, now, branch);
            return Err(branch_held("moved", holder, branch, message));
        }
    }
    let at_tip = match head.as_deref() {
        Some(head) => branch_tip_sha(holder, branch).await?.as_deref() == Some(head),
        None => false,
    };
    if !at_tip {
        return Err(branch_held(
            "moved",
            holder,
            branch,
            switched_away_message(holder, branch),
        ));
    }
    // The reads `ops::refuse_mid_op_for` gates on, split so the refusal can name the
    // operation.
    let op = crate::git::ops::op_state(holder).await?;
    let paused = if op.rebasing {
        Some("a rebase")
    } else if op.merging {
        Some("a merge")
    } else if op.cherry_picking {
        Some("a cherry-pick")
    } else if op.reverting {
        Some("a revert")
    } else if crate::git::ops::has_unmerged(holder).await? {
        Some("resolving conflicts")
    } else {
        None
    };
    if let Some(paused) = paused {
        return Err(branch_held(
            "mid-op",
            holder,
            branch,
            format!(
                "The checkout at {holder} is in the middle of {paused} — finish or abort it \
                 there, then try again. {branch} is unchanged."
            ),
        ));
    }
    // Tracked changes only: untracked files don't block a merge, and one the merge
    // would overwrite is refused by git itself in the failure arms below.
    if has_tracked_changes(holder).await? {
        return Err(branch_held(
            "dirty",
            holder,
            branch,
            format!(
                "The checkout at {holder} has uncommitted changes — commit or stash them \
                 there, then try again. {branch} is unchanged."
            ),
        ));
    }

    let updated = |outcome: &str| UpdateBranchOutcome {
        outcome: outcome.to_string(),
        holder: Some(holder.to_string()),
    };

    // A branch that took in the base since the first read must not report git's
    // "Already up to date" no-op as an update.
    let contains = run_git_raw(
        Some(holder),
        &["merge-base", "--is-ancestor", base_sha, "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if contains.code == 0 {
        return Ok(updated("up-to-date"));
    }

    // An ignored file is local data its owner can't see being consumed. Both merges pass
    // `--no-overwrite-ignore`, which turns the fast-forward's silent overwrite into a
    // refusal; a 3-way merge ignores the flag (measured, git 2.51.1), so that arm checks.
    let subject = match merge {
        HolderMerge::FastForward => {
            let out = run_git_raw(
                Some(holder),
                &["merge", "--ff-only", "--no-overwrite-ignore", base_sha],
                DEFAULT_TIMEOUT,
            )
            .await?;
            if out.code != 0 {
                // A refused ff-only merge writes nothing.
                return Err(branch_held(
                    "failed",
                    holder,
                    branch,
                    format!(
                        "Couldn't fast-forward {branch} to {base} in the checkout at {holder}. \
                         {branch} is unchanged.\n{}",
                        out.full_failure_text()
                    ),
                ));
            }
            return Ok(updated("fast-forward"));
        }
        HolderMerge::Merge { subject } => subject,
    };

    // Fails closed: a check that could not run refuses rather than risk the overwrite.
    let in_the_way = match ignored_files_in_the_way(holder, base_sha, DEFAULT_TIMEOUT).await {
        Ok(paths) => paths,
        Err(e) => {
            return Err(branch_held(
                "failed",
                holder,
                branch,
                format!(
                    "Couldn't check the checkout at {holder} for ignored files the merge \
                     would overwrite. {branch} is unchanged.\n{e}"
                ),
            ))
        }
    };
    if !in_the_way.is_empty() {
        return Err(branch_held(
            "failed",
            holder,
            branch,
            format!(
                "Merging {base} into {branch} in the checkout at {holder} would overwrite \
                 ignored files there: {}. Move them aside, then try again. {branch} is \
                 unchanged.",
                name_paths(&in_the_way)
            ),
        ));
    }

    // Raw: a conflicted merge reports entirely on stdout with stderr empty (measured,
    // git 2.51.1), the same trap the in-place arm documents.
    let mut args = vec!["merge", "--no-edit", "--no-overwrite-ignore"];
    if let Some(subject) = subject.as_deref() {
        args.extend(["-m", subject]);
    }
    args.push(base_sha);
    let merged = run_git_raw(Some(holder), &args, DEFAULT_TIMEOUT).await;
    if merged.as_ref().is_ok_and(|out| out.code == 0) {
        return Ok(updated("merge"));
    }
    let merge_text = match &merged {
        Ok(out) => out.full_failure_text(),
        Err(e) => e.to_string(),
    };

    // The conflict list comes from the index, read before the abort clears it. A merge
    // git refused before starting (an untracked or ignored file in the way) has nothing
    // to abort.
    let conflicts = crate::git::ops::unmerged_paths(holder).await;
    let abort_failure = if merge_head_present(holder).await {
        match run_git_raw(Some(holder), &["merge", "--abort"], DEFAULT_TIMEOUT).await {
            Ok(out) if out.code == 0 => None,
            Ok(out) => Some(out.full_failure_text()),
            Err(e) => Some(e.to_string()),
        }
    } else {
        None
    };
    // Our own residue only: the hold serializes GitDesktop, not the user's editor, so a
    // tracked edit saved during the merge is theirs and never reads as a failed restore.
    let restored = abort_failure.is_none() && !merge_head_present(holder).await;
    if !restored {
        let abort_text = abort_failure.unwrap_or_default();
        return Err(branch_held(
            "failed",
            holder,
            branch,
            format!(
                "Merging {base} into {branch} in the checkout at {holder} failed, and that \
                 checkout could not be put back as it was, so it needs manual attention. \
                 {branch} is unchanged.\n{merge_text}\n{abort_text}"
            )
            .trim_end()
            .to_string(),
        ));
    }
    if !conflicts.is_empty() {
        return Err(branch_held(
            "conflict",
            holder,
            branch,
            format!(
                "{branch} has changes that conflict with {base} in {}, so the merge in the \
                 checkout at {holder} was aborted. {branch} is unchanged.",
                name_paths(&conflicts)
            ),
        ));
    }
    Err(branch_held(
        "failed",
        holder,
        branch,
        format!(
            "Couldn't merge {base} into {branch} in the checkout at {holder}. {branch} is \
             unchanged.\n{merge_text}"
        ),
    ))
}

/// Whether `dir` is mid-merge, failing closed: only git's verified-absent exit 1 says no.
async fn merge_head_present(dir: &str) -> bool {
    match run_git_raw(
        Some(dir),
        &["rev-parse", "-q", "--verify", "MERGE_HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(out) => out.code != 1,
        Err(_) => true,
    }
}

/// Whether `dir`'s checkout has staged or unstaged changes to TRACKED files.
async fn has_tracked_changes(dir: &str) -> AppResult<bool> {
    let status = run_git(
        Some(dir),
        &["status", "--porcelain", "--untracked-files=no"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(!status.stdout_lossy().trim().is_empty())
}

/// A fixed `Merge branch '<x>' into <branch>` subject (`remote-tracking branch` for a
/// remote base) for the holder's merge, which takes the pinned sha and would otherwise be
/// titled by it. `None`, leaving git's wording, when the rev names neither kind of branch.
async fn merge_subject(repo_path: &str, base_rev: &str, branch: &str) -> Option<String> {
    let out = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--symbolic-full-name", base_rev],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .filter(|out| out.code == 0)?;
    let full = out.stdout_lossy();
    let full = full.trim();
    let source = if let Some(name) = full.strip_prefix("refs/heads/") {
        format!("branch '{name}'")
    } else {
        let name = full.strip_prefix("refs/remotes/")?;
        format!("remote-tracking branch '{name}'")
    };
    Some(format!("Merge {source} into {branch}"))
}

/// Where an update's throwaway checkout goes: `<app-data>/worktrees/<identity-hash>/
/// gd-update-<unique>`. Resolution only — creating the root is the caller's job.
///
/// Through `update_marker::root_for`, not `ops::worktree_root_dir` directly, so the
/// mint and the guards that police it can never disagree about which root they mean.
/// Alone among that function's callers this one PROPAGATES an unresolvable root instead
/// of failing open: a guard that cannot resolve simply stays quiet, but a mint that
/// cannot would put a checkout where nothing is watching it.
async fn update_worktree_path(repo_path: &str) -> AppResult<std::path::PathBuf> {
    Ok(crate::git::update_marker::root_for(repo_path)
        .await?
        .join(format!("gd-update-{}", unique_suffix())))
}

/// The two refs an update is planned against, resolved under the first working-tree
/// hold so nothing that moves afterwards can change what lands on the branch. Only the
/// diverged arm's [`verify_pin_and_merge`] reads `branch_tip`.
struct UpdatePins {
    branch_tip: String,
    base_sha: String,
}

/// Enumerate stored names so case-insensitive loose-ref lookups cannot alias a branch.
pub(crate) async fn branch_exists_exact(repo_path: &str, name: &str) -> AppResult<bool> {
    Ok(stored_branch_names(repo_path)
        .await?
        .iter()
        .any(|stored| stored == name))
}

/// Every stored branch name, from one `for-each-ref` over `refs/heads/`.
async fn stored_branch_names(repo_path: &str) -> AppResult<Vec<String>> {
    let refs = run_git(
        Some(repo_path),
        &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(refs
        .stdout_lossy()
        .lines()
        .filter_map(|line| line.strip_prefix("refs/heads/"))
        .map(str::to_string)
        .collect())
}

/// How a branch name stands against the stored names, letter case folded by
/// [`eq_ignoring_case`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BranchSpelling {
    /// An exact ref at `tip`; where the twin check ran, no other stored name equal to it
    /// ignoring case.
    Own { tip: String },
    /// No exact ref, git reads a ref by this spelling, and exactly this one stored name
    /// equals it ignoring case.
    StoredAs(String),
    /// An exact ref at `tip`, and `twin`, another stored name equal to it ignoring case.
    Twin { tip: String, twin: String },
    /// No exact ref, git reads a ref by this spelling, and two or more stored names equal
    /// it ignoring case; `first` and `second` are the first two in refname order. git
    /// reads the one loose twin, and no tip is offered: a write would move it by a name
    /// it doesn't store.
    FoldedTwins { first: String, second: String },
    /// No exact ref, and either git reads no ref by this spelling or no stored name
    /// equals it ignoring case.
    Missing,
}

/// Classifies `name` by [`exact_branch_tip`], then by one listing of the stored names
/// only when the answer needs it: with `find_twin` false an exact ref answers `Own`
/// unlisted, for a site that only asks whether the name is stored under another
/// spelling. Without an exact ref, a spelling git reads no ref by is `Missing` unlisted:
/// only the disk decides whether two spellings name one branch, so a case-sensitive disk
/// (or a packed-only stored name) never swaps one in. A failed `for-each-ref` read is the
/// `Err`; any `show-ref` failure reads as no ref, so it classes as `Missing`.
pub(crate) async fn branch_spelling(
    repo_path: &str,
    name: &str,
    find_twin: bool,
) -> AppResult<BranchSpelling> {
    let exact = exact_branch_tip(repo_path, name).await?;
    if let (Some(tip), false) = (&exact, find_twin) {
        return Ok(BranchSpelling::Own { tip: tip.clone() });
    }
    if exact.is_none() && shown_branch_tip(repo_path, name).await?.is_none() {
        return Ok(BranchSpelling::Missing);
    }
    let stored = stored_branch_names(repo_path).await?;
    let mut others = stored
        .into_iter()
        .filter(|stored| stored != name && eq_ignoring_case(stored, name));
    let first = others.next();
    let second = others.next();
    Ok(match (exact, first, second) {
        (Some(tip), None, _) => BranchSpelling::Own { tip },
        (Some(tip), Some(twin), _) => BranchSpelling::Twin { tip, twin },
        (None, Some(stored), None) => BranchSpelling::StoredAs(stored),
        (None, Some(first), Some(second)) => BranchSpelling::FoldedTwins { first, second },
        (None, None, _) => BranchSpelling::Missing,
    })
}

/// `name` as git stores it: the stored name when git reads `name` as that one case
/// variant's ref ([`BranchSpelling::StoredAs`]), else `name` itself, folded twins
/// included: no single stored name answers there, and [`bare_move_tip`] refuses them.
/// A branch literally named `@` (which git stores and pushes, but no rev-taking site
/// admits) passes [`validate_ref_name`] alone and answers itself: it has no case variant.
pub(crate) async fn stored_branch_spelling(repo_path: &str, name: &str) -> AppResult<String> {
    if name == "@" {
        validate_ref_name(name)?;
        return Ok(name.to_string());
    }
    Ok(match branch_spelling(repo_path, name, false).await? {
        BranchSpelling::StoredAs(stored) => stored,
        _ => name.to_string(),
    })
}

/// Whether this repository's ref names can alias one another, read from the disk rather
/// than `core.ignorecase`, which a user may set false on a disk that still folds case. A
/// reftable repository, recognized by [`is_reftable_store`], never aliases, since its ref
/// names are table keys rather than file names; any other answers by its disk. A common
/// dir that can't be resolved, or a disk probe that fails, counts as aliasing, toward
/// refusing.
pub(crate) async fn refs_can_alias(repo_path: &str) -> bool {
    refs_can_alias_strict(repo_path).await.unwrap_or(true)
}

/// [`refs_can_alias`] for a caller whose `true` authorizes a write through a checkout on
/// another spelling: a common dir that can't be resolved, or a disk probe that fails, is
/// the `Err`, never "can alias".
pub(crate) async fn refs_can_alias_strict(repo_path: &str) -> AppResult<bool> {
    let common = crate::git::worktree::git_common_dir(repo_path).await?;
    Ok(refs_can_alias_at(std::path::Path::new(&common))?)
}

/// Whether a checkout on `now`, which [`holds_branch`] says holds the stored `branch`, may
/// be written through for it, as far as the store can tell: the same name, or a store whose
/// names alias ([`refs_can_alias_strict`]). Where names can't alias, two spellings are two
/// refs whatever `holds_branch`'s conservative reads answered. No spawn for the same name.
pub(crate) async fn spelling_reaches_branch(
    checkout: &str,
    now: &str,
    branch: &str,
) -> AppResult<bool> {
    if now == branch {
        return Ok(true);
    }
    refs_can_alias_strict(checkout).await
}

/// [`refs_can_alias`] over a resolved common dir: false for a reftable store, else
/// [`refs_dir_folds_case`].
fn refs_can_alias_at(common: &std::path::Path) -> std::io::Result<bool> {
    if is_reftable_store(common) {
        return Ok(false);
    }
    refs_dir_folds_case(common)
}

/// Whether `common` holds a reftable ref store: `reftable/tables.list` beside a
/// `refs/heads` that is a FILE, the stub `git init --ref-format=reftable` leaves (git
/// 2.51.1). A files repository keeps its branches in a `refs/heads` directory, so a stray
/// `reftable` folder beside one never reads as reftable.
fn is_reftable_store(common: &std::path::Path) -> bool {
    common.join("refs").join("heads").is_file()
        && common.join("reftable").join("tables.list").is_file()
}

/// Whether `<common>/refs` exists and its upper-cased spelling `REFS` resolves too; a
/// missing `refs` answers true, and a read that fails is the `Err`.
fn refs_dir_folds_case(common: &std::path::Path) -> std::io::Result<bool> {
    if !common.join("refs").try_exists()? {
        return Ok(true);
    }
    common.join("REFS").try_exists()
}

/// The refusal for a bare move of `branch` beside `twin`, a stored name that differs
/// from it only in letter case.
pub(crate) fn twin_refusal(branch: &str, twin: &str) -> AppError {
    AppError::Command(format!(
        "{branch} and {twin} differ only in letter case, which this disk can't keep \
         apart. Rename one of them, then try again."
    ))
}

/// The refusal for minting `name` beside `twin`, a stored name that differs from it only
/// in letter case.
fn new_name_twin_refusal(name: &str, twin: &str) -> AppError {
    AppError::Command(format!(
        "{name} differs from the existing branch {twin} only in letter case, which this \
         disk can't keep apart. Use a different name, or rename {twin} first."
    ))
}

/// The stored name that a new branch `name` would be a case twin of, folded as
/// [`branch_spelling`] folds. `None` when `name` itself is stored, so git's own "already
/// exists" answers, and `replaces` (the branch a rename moves off) never counts.
fn case_twin_of<'a>(stored: &'a [String], name: &str, replaces: Option<&str>) -> Option<&'a str> {
    if stored.iter().any(|stored| stored == name) {
        return None;
    }
    stored
        .iter()
        .map(String::as_str)
        .find(|stored| Some(*stored) != replaces && eq_ignoring_case(stored, name))
}

/// The twin check shared by the routes that mint a branch name here (create, rename,
/// remote checkout, the autostash tracking arm, new-branch worktree add): refuses `name`
/// when a stored name other than `replaces` equals it ignoring case and refs can alias
/// ([`refs_can_alias`]), since git refuses only a twin of a LOOSE ref. Takes no lock: each
/// caller supplies its hold, and only a call inside the config-write mutex held through
/// the write makes check-then-create atomic. A failed listing is the `Err`; the disk is
/// probed only when a stored name folds to `name`. It first refuses any `name` that
/// [`validate_branch_name`] refuses, so a route that mints through here can't compare a rev
/// expression's literal spelling while git creates the branch it expands to.
pub(crate) async fn refuse_new_name_twin(
    repo_path: &str,
    name: &str,
    replaces: Option<&str>,
) -> AppResult<()> {
    validate_branch_name(name)?;
    let stored = stored_branch_names(repo_path).await?;
    let Some(twin) = case_twin_of(&stored, name, replaces) else {
        return Ok(());
    };
    if refs_can_alias(repo_path).await {
        return Err(new_name_twin_refusal(name, twin));
    }
    Ok(())
}

/// The tip a bare move of `branch` (a ref write no checkout's HEAD goes through) compares
/// against: the exact tip of a branch with its own ref, a twin's included where refs
/// can't alias; `None` without an exact ref. A twin where refs can alias is the
/// [`twin_refusal`]: git writes a loose file that the twin's spelling also reads, under
/// any checkout on the twin. Folded twins are refused too. A failed read is the `Err`.
pub(crate) async fn bare_move_tip(repo_path: &str, branch: &str) -> AppResult<Option<String>> {
    let spelling = branch_spelling(repo_path, branch, true).await?;
    let can_alias =
        matches!(spelling, BranchSpelling::Twin { .. }) && refs_can_alias(repo_path).await;
    bare_move_gate(branch, spelling, can_alias)
}

/// [`bare_move_tip`]'s verdict for a classified `branch`; `can_alias` is read only for a
/// twin.
fn bare_move_gate(
    branch: &str,
    spelling: BranchSpelling,
    can_alias: bool,
) -> AppResult<Option<String>> {
    match spelling {
        BranchSpelling::Own { tip } => Ok(Some(tip)),
        BranchSpelling::Twin { twin, .. } if can_alias => Err(twin_refusal(branch, &twin)),
        BranchSpelling::Twin { tip, .. } => Ok(Some(tip)),
        // Whatever the disk probe says: git read `branch` through a name it doesn't store,
        // which only aliasing does. The pair named is the variant's first two stored names.
        BranchSpelling::FoldedTwins { first, second } => Err(twin_refusal(&first, &second)),
        BranchSpelling::StoredAs(_) | BranchSpelling::Missing => Ok(None),
    }
}

/// The branch's tip for the exact name, or for a spelling the filesystem aliases to its
/// loose ref (a checkout's `Chore/z` for a stored `chore/z`), never git's ref-search
/// fallback or a tag; a failed exact read, or a failed `show-ref` spawn, is the `Err`.
/// Destructive callers read [`exact_branch_tip`].
pub(crate) async fn branch_tip_sha(repo_path: &str, branch: &str) -> AppResult<Option<String>> {
    if let Some(tip) = exact_branch_tip(repo_path, branch).await? {
        return Ok(Some(tip));
    }
    shown_branch_tip(repo_path, branch).await
}

/// `refs/heads/<name>` as `show-ref --verify` reads it: it opens the loose file by the
/// given spelling (so a case-insensitive filesystem may answer another spelling's file)
/// and, unlike `rev-parse`, searches no other prefix. Any non-zero exit is `None`.
async fn shown_branch_tip(repo_path: &str, name: &str) -> AppResult<Option<String>> {
    let full_ref = branch_full_ref(name)?;
    let out = run_git_raw(
        Some(repo_path),
        &["show-ref", "--verify", "--hash", &full_ref],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(None);
    }
    Ok(full_object_id(out.stdout_lossy().trim()).ok())
}

/// The diverged arm, run with the working-tree lock RELEASED: `worktree
/// add/remove/prune` belong to the worktree-admin domain, which no blocking hold nests
/// with (`update_branch_from`'s dead-holder claim takes it try-only under its
/// working-tree hold), and materializing a whole checkout takes minutes that staging
/// must not queue behind.
///
/// The add is bounded, so a concurrent removal's prune yields an explained `Busy`
/// instead of an interleaved write to `.git/worktrees/`. Every path out of the merge
/// — refusal, conflict, success — reaches the teardown below.
async fn merge_diverged_in_worktree(
    state: &AppState,
    repo_path: &str,
    tmp: &str,
    branch: &str,
    base: &str,
    pins: &UpdatePins,
    marker: Option<crate::git::update_marker::UpdateMarker>,
) -> AppResult<String> {
    // A killed add can still leave a registered entry over a partial directory, so its
    // early return settles the marker rather than dropping it: the checkout it may have
    // left behind needs a recoverable marker exactly as much as a finished one does.
    if let Err(e) = run_git_worktree_admin(
        state,
        repo_path,
        &["worktree", "add", "--quiet", tmp, branch],
        WORKTREE_OP_TIMEOUT,
    )
    .await
    {
        settle_marker(marker, tmp);
        return Err(e);
    }

    let result = verify_pin_and_merge(state, repo_path, tmp, branch, base, pins).await;

    // Try-then-detach is the only teardown shape with no bad arm: a bounded acquire
    // that gave up on `Busy` would leak the throwaway worktree, and a synchronous
    // unbounded one holds a finished update's command hostage for the minutes a
    // node_modules-scale removal can hold the shared admin domain. On both arms the
    // marker outlives the checkout, since the branch stays held until the directory is
    // gone, and `settle_marker` keeps it on disk when the removal did not finish. A
    // quit or crash leaks the directory with its marker still beside it — released, so
    // the next branch operation clears it without waiting out the age gate.
    let domain = state.worktree_admin_lock(repo_path).await;
    match try_acquire_repo_lock(&domain, "a worktree operation") {
        Some(_admin) => {
            remove_tmp_worktree(repo_path, tmp).await;
            settle_marker(marker, tmp);
        }
        None => {
            let (repo, tmp) = (repo_path.to_string(), tmp.to_string());
            tauri::async_runtime::spawn(async move {
                let _admin = acquire_repo_lock_unbounded(&domain, "a worktree operation").await;
                remove_tmp_worktree(&repo, &tmp).await;
                settle_marker(marker, &tmp);
            });
        }
    }

    result
}

/// Drops `marker` after a teardown attempt. Its files go only when the checkout is
/// confirmed gone; a surviving directory keeps them, unlocked, so the age-free claims
/// can recover it on the next branch operation. Deleting them there would leave a
/// markerless holder instead, which nothing may clear until the age gate expires.
fn settle_marker(marker: Option<crate::git::update_marker::UpdateMarker>, tmp: &str) {
    let Some(mut marker) = marker else { return };
    // try_exists: an UNREADABLE answer must retain (the sidecars' deletion is the one
    // destructive direction here); only a confirmed-gone checkout lets them go.
    if std::path::Path::new(tmp).try_exists().unwrap_or(true) {
        marker.retain_for_recovery();
    }
}

/// `worktree remove --force` then `prune`, both best-effort and both lock-free: every
/// caller already holds the worktree-admin domain.
async fn remove_tmp_worktree(repo_path: &str, tmp: &str) {
    let _ = run_git_raw(
        Some(repo_path),
        &["worktree", "remove", "--force", tmp],
        WORKTREE_OP_TIMEOUT,
    )
    .await;
    let _ = run_git_raw(Some(repo_path), &["worktree", "prune"], DEFAULT_TIMEOUT).await;
}

/// Under a fresh working-tree hold: confirm the branch still stands where it was
/// pinned and the base still descends from its pin, then merge `base`'s branch-first
/// rev inside the throwaway worktree at `tmp`. The merge writes the shared
/// `refs/heads/<branch>`, which is why it belongs in this domain. The rev keeps the
/// plain name (and the `Merge branch '<base>'` subject) unless a same-named tag shadows
/// it, when the full ref words the subject instead; the pins are what keep a ref that
/// moved while the worktree materialized from silently changing the operation. The
/// hold covers writers on THIS checkout only — another worktree of the same repo
/// takes its own working-tree lock, and a session-worktree removal deletes refs under
/// the admin hold, so a cross-checkout mover is outside what it promises.
async fn verify_pin_and_merge(
    state: &AppState,
    repo_path: &str,
    tmp: &str,
    branch: &str,
    base: &str,
    pins: &UpdatePins,
) -> AppResult<String> {
    let domain = state.working_tree_lock(repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a branch update").await?;

    // A twin created at the pinned commit while the worktree materialized would pass a
    // plain tip compare, so the tip is read as a bare move reads it.
    if bare_move_tip(repo_path, branch).await?.as_deref() != Some(pins.branch_tip.as_str()) {
        return Err(AppError::Command(format!(
            "{branch} moved while this update was running — try again to see where it stands."
        )));
    }

    // The base check runs in the TMP worktree's cwd — the $GIT_DIR the merge resolves
    // in. gitrevisions takes $GIT_DIR-local names (HEAD, MERGE_HEAD, …) ahead of
    // `refs/heads/`, and `validate_branch_name` admits a literal "HEAD", so a check in
    // the main checkout could pass over a different object than the merge takes.
    //
    // Three arms, so the refusal describes what happened. A base that only
    // fast-forwarded is what a fresh update would merge — the app's own auto-fetch
    // advances a remote-tracking base mid-window — so it proceeds. Exit 1 means the
    // name did not resolve, and phase 1 already resolved it, so that base was deleted:
    // its own wording, since a retry cannot find it either. A rewound or rewritten
    // base, and any OTHER non-zero exit (128 — a vanished or corrupt tmp gitdir,
    // measured git 2.51.1), take the retry wording, which suits a transient state.
    // Both reads and the merge take the base BRANCH, never a same-named tag.
    let base_rev = branch_first_rev(tmp, base).await;
    let base_now = run_git_raw(
        Some(tmp),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base_rev}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if base_now.code == 1 {
        return Err(AppError::Command(format!(
            "{base} was deleted while this update was running — there is nothing to update from."
        )));
    }
    let base_now_sha = base_now.stdout_lossy().trim().to_string();
    if base_now.code != 0 || base_now_sha != pins.base_sha {
        // The ancestor probe needs a resolved sha, so a failed re-resolve skips it
        // and refuses.
        let fast_forwarded = base_now.code == 0
            && run_git_raw(
                Some(tmp),
                &["merge-base", "--is-ancestor", &pins.base_sha, &base_now_sha],
                DEFAULT_TIMEOUT,
            )
            .await
            .is_ok_and(|out| out.code == 0);
        if !fast_forwarded {
            return Err(AppError::Command(format!(
                "{base} moved while this update was running — try again to see where it stands."
            )));
        }
    }

    // The merge keeps the default budget: it rewrites only the differing files, not
    // the whole tree. Lock-free runner — the hold is ours.
    let merged = run_git_raw(
        Some(tmp),
        &["merge", "--no-edit", &base_rev],
        DEFAULT_TIMEOUT,
    )
    .await;
    if merged.as_ref().is_ok_and(|out| out.code == 0) {
        return Ok("merge".to_string());
    }

    // The conflict verdict comes from the INDEX, read before the abort clears it — the
    // exit code cannot carry it: a `pre-merge-commit` hook that declines also exits 1
    // with the auto-merge clean and nothing unmerged, and hooks resolve from the COMMON
    // dir, so the main repo's hooks run in this worktree (measured, git 2.51.1).
    let conflicted = !crate::git::ops::unmerged_paths(tmp).await.is_empty();
    // Undo the half-done merge so the branch ref is left as it was. Every failure path
    // reaches this, the runner's Err included — a timeout that returned early would
    // leave tmp mid-merge.
    let _ = run_git_raw(Some(tmp), &["merge", "--abort"], DEFAULT_TIMEOUT).await;

    // Only a real conflict has a remedy to name; everything else carries git's report.
    if conflicted {
        return Err(AppError::InvalidArgument(format!(
            "{branch} has changes that conflict with {base}. Switch to {branch} to merge and resolve them."
        )));
    }
    Err(match merged {
        Ok(out) => AppError::Command(format!(
            "merging {base} into {branch} failed — try again to see where it stands.\n{}",
            out.full_failure_text()
        )),
        Err(e) => AppError::Command(format!(
            "merging {base} into {branch} failed — try again to see where it stands.\n{e}"
        )),
    })
}

/// Whether a commit is reachable from any remote-tracking ref (`refs/remotes/*`) —
/// i.e. it has been pushed. Gates the History-tab comment surface and GUI Undo's
/// no-upstream check, so a failed run is an Err, never a defaulted "not pushed". The
/// sha is validated (hex) BEFORE spawning git. `--contains` exits 0 while skipping a
/// ref whose tip object is missing, so an empty answer stands only once a plain
/// listing exits 0 (nonzero on a missing tip object). Out of reach here (git 2.51.1):
/// both skip an unparseable ref file with only a warning, and a missing ANCESTOR
/// object makes `--contains` over-report, which errs toward "pushed".
#[tauri::command]
pub async fn commit_on_remote(repo_path: String, sha: String) -> AppResult<bool> {
    crate::git::history::validate_hash(&sha)?;
    let failed = |out: &crate::git::runner::GitOutput| {
        AppError::Command(format!(
            "couldn't check whether {sha} is on a remote.\n{}",
            out.full_failure_text()
        ))
    };
    let out = run_git_raw(
        Some(&repo_path),
        &[
            "for-each-ref",
            "refs/remotes",
            "--contains",
            &sha,
            "--format=%(refname)",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Err(failed(&out));
    }
    if !out.stdout_lossy().trim().is_empty() {
        return Ok(true);
    }
    let tips = run_git_raw(
        Some(&repo_path),
        &["for-each-ref", "refs/remotes", "--format=%(objecttype)"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if tips.code != 0 {
        return Err(failed(&tips));
    }
    Ok(false)
}

/// What git_unpushed_count counted against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnpushedBasis {
    Remotes,
    DefaultBranch,
    OnDefaultBranch,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpushedCount {
    pub count: u32,
    pub basis: UnpushedBasis,
    /// Some only for DefaultBranch and OnDefaultBranch.
    pub default_branch: Option<String>,
    /// The full oid HEAD resolved to when the count was taken, the identity the
    /// frontend pairs the count with its log by; `None` only on an unborn HEAD.
    pub head_oid: Option<String>,
}

/// Commits on `HEAD` the History tab marks "not pushed" on a branch with NO upstream,
/// and what they were counted against. With any object-resolving remote-tracking ref,
/// or any configured remote, it counts `HEAD --not --remotes` (`Remotes`; every
/// commit while nothing was fetched). With no configured remote it counts past the
/// verified local default branch (`DefaultBranch`, detached HEAD included); on that
/// branch itself, or with no verifiable default, every `HEAD` commit counts
/// (`OnDefaultBranch` hides the arrows only; `Unresolved` keeps them). Only an unborn
/// `HEAD` answers 0; any failed run, the remote listing included, is an Err. Spawns:
/// the ref probe, the HEAD read and rev-list, plus the remote listing when no remote
/// ref resolved.
/// The no-remote paths add git_default_branch's up to 4 (no remote to sweep), run
/// concurrently with the HEAD-branch read, then the verify (only when a default
/// resolved).
#[tauri::command]
pub async fn git_unpushed_count(repo_path: String) -> AppResult<UnpushedCount> {
    let failed =
        |text: String| AppError::Command(format!("couldn't count the unpushed commits.\n{text}"));
    // A dangling refs/remotes/*/HEAD symref prints nothing here, matching what
    // `--remotes` can exclude; `--count` applies after that skip (git 2.51.1).
    let probe = run_git_raw(
        Some(&repo_path),
        &[
            "for-each-ref",
            "--count=1",
            "--format=%(objectname)",
            "refs/remotes",
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .map_err(|e| failed(e.to_string()))?;
    if probe.code != 0 {
        return Err(failed(probe.full_failure_text()));
    }
    let has_remote_refs = probe.stdout_lossy().lines().any(|l| !l.trim().is_empty());
    // A configured remote with nothing fetched yet has received none of HEAD, so it
    // keeps the remotes basis; a failed listing errs rather than reading as none.
    let has_remote = has_remote_refs
        || !crate::git::remote::git_remotes(repo_path.clone())
            .await
            .map_err(|e| failed(e.to_string()))?
            .is_empty();

    let mut default_ref = None;
    let (basis, default_branch) = if has_remote {
        (UnpushedBasis::Remotes, None)
    } else {
        // Independent reads, joined so the count's latency after a commit isn't
        // their sum; boxed to keep the command future small.
        let (default, head) = tokio::join!(
            Box::pin(git_default_branch(repo_path.clone())),
            Box::pin(current_branch_name(&repo_path)),
        );
        let default = default.map_err(|e| failed(e.to_string()))?;
        let head = head.map_err(|e| failed(e.to_string()))?;
        match default {
            None => (UnpushedBasis::Unresolved, None),
            Some(name) => {
                // Only git_default_branch's main/master fallback verifies its ref; a
                // remote HEAD's target can name a branch with no local ref.
                let full = format!("refs/heads/{name}");
                let verify = run_git_raw(
                    Some(&repo_path),
                    &["rev-parse", "--verify", "--quiet", &full],
                    DEFAULT_TIMEOUT,
                )
                .await
                .map_err(|e| failed(e.to_string()))?;
                match verify.code {
                    0 => {
                        if head.as_deref() == Some(name.as_str()) {
                            (UnpushedBasis::OnDefaultBranch, Some(name))
                        } else {
                            default_ref = Some(full);
                            (UnpushedBasis::DefaultBranch, Some(name))
                        }
                    }
                    1 => (UnpushedBasis::Unresolved, None),
                    _ => return Err(failed(verify.full_failure_text())),
                }
            }
        }
    };

    // HEAD resolves ONCE and the count runs from that oid, so the oid returned is the
    // commit counted from even when HEAD moves mid-read. Only an unborn HEAD answers 0.
    let resolved = match crate::git::history::read_unless_unborn(
        &repo_path,
        &["rev-parse", "--verify", "HEAD^{commit}"],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(Some(out)) => out,
        Ok(None) => {
            return Ok(UnpushedCount {
                count: 0,
                basis,
                default_branch,
                head_oid: None,
            })
        }
        Err(e) => return Err(failed(e.to_string())),
    };
    let head_oid = resolved.stdout_lossy().trim().to_string();
    if head_oid.is_empty() {
        return Err(failed("HEAD resolved to nothing".into()));
    }
    let mut args = vec!["rev-list", "--count", head_oid.as_str()];
    match (&basis, &default_ref) {
        (UnpushedBasis::Remotes, _) => args.extend(["--not", "--remotes"]),
        (_, Some(full)) => args.extend(["--not", full.as_str()]),
        _ => {}
    }
    let out = run_git_raw(Some(&repo_path), &args, DEFAULT_TIMEOUT)
        .await
        .map_err(|e| failed(e.to_string()))?;
    if out.code != 0 {
        return Err(failed(out.full_failure_text()));
    }
    let stdout = out.stdout_lossy();
    let count = stdout
        .trim()
        .parse()
        .map_err(|_| failed(format!("unexpected rev-list output: {}", stdout.trim())))?;
    Ok(UnpushedCount {
        count,
        basis,
        default_branch,
        head_oid: Some(head_oid),
    })
}

/// A process-unique suffix for the throwaway worktree directory name.
fn unique_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), nanos)
}

/// The `holder` of the publish hold's `Busy`.
const PUBLISH_HOLDER: &str = "a repository publish";

/// The branches repository publishes in this process are pushing: (entry id, repository
/// key, branch). Advisory: a publish's registration and a route's check share no lock, and
/// when `repo_identity` fails on one side only the two key differently, so the hold fails
/// open. Out of reach: the MCP server and a terminal. Branch reset is deliberately not held;
/// a worktree removal that meets the hold keeps the branch without saying why; and each
/// provider reads HEAD again before its push, so a switch between that read and the one
/// this hold registers pushes a branch the hold does not cover.
static PUBLISHING_BRANCHES: std::sync::Mutex<Vec<(u64, String, String)>> =
    std::sync::Mutex::new(Vec::new());
static NEXT_PUBLISHING_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// One registered publish of a branch; dropping it ends the hold.
pub(crate) struct PublishingBranch {
    id: u64,
}

impl Drop for PublishingBranch {
    fn drop(&mut self) {
        publishing_entries().retain(|(id, _, _)| *id != self.id);
    }
}

fn publishing_entries() -> std::sync::MutexGuard<'static, Vec<(u64, String, String)>> {
    PUBLISHING_BRANCHES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The repository identity, else the path as given.
async fn publish_hold_key(repo_path: &str) -> String {
    crate::git::repo::repo_identity(repo_path)
        .await
        .unwrap_or_else(|_| repo_path.to_string())
}

/// Registers a publish of `branch` until the returned guard drops.
pub(crate) async fn hold_publishing_branch(repo_path: &str, branch: &str) -> PublishingBranch {
    let key = publish_hold_key(repo_path).await;
    let id = NEXT_PUBLISHING_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    publishing_entries().push((id, key, branch.to_string()));
    PublishingBranch { id }
}

/// `AppError::Busy { holder: "a repository publish" }` while a publish of this repository
/// is pushing `name`, compared ignoring case.
pub(crate) async fn refuse_while_publishing(repo_path: &str, name: &str) -> AppResult<()> {
    let idle = publishing_entries().is_empty();
    if idle {
        return Ok(());
    }
    let key = publish_hold_key(repo_path).await;
    let held = publishing_entries()
        .iter()
        .any(|(_, k, branch)| *k == key && eq_ignoring_case(branch, name));
    if held {
        return Err(AppError::Busy {
            holder: PUBLISH_HOLDER.into(),
        });
    }
    Ok(())
}

/// [`run_minting_write`]'s leftover-settings rule, under the held config-write mutex: an
/// existing ref is never touched; otherwise a rename (or a create of an unmarked name)
/// removes `branch.<name>` whole, and a create of a marked name unsets every other key of
/// the section, the mark itself never removed and rewritten. A name whose section holds no
/// local key writes nothing, so a mint with no leftovers never contends for the config
/// lock. Any failure is the `Err` and nothing is minted. A rename gets back the records it
/// removed, for [`restore_dropped_branch_settings`]; every other arm gets none.
async fn drop_leftover_branch_settings(
    held: &ConfigWriteHeld,
    repo_path: &str,
    name: &str,
    renaming: bool,
) -> AppResult<Vec<(String, Option<String>)>> {
    if exact_branch_tip(repo_path, name).await?.is_some() {
        return Ok(Vec::new());
    }
    let listed = run_git(
        Some(repo_path),
        &["config", "--local", "--null", "--list"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let listed = listed.stdout_lossy();
    let records = branch_section_records(&listed, name);
    let keys = branch_section_keys(&listed, name);
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    if renaming || !branch_keep_local(repo_path, name).await? {
        let section = format!("branch.{name}");
        let args = ["config", "--remove-section", &section];
        let out = run_git_config_write_held(held, repo_path, &args, DEFAULT_TIMEOUT).await?;
        if out.code == 0 {
            return Ok(if renaming { records } else { Vec::new() });
        }
        // Not found, so nothing was removed and nothing is restored.
        if out.stderr.contains("no such section") {
            return Ok(Vec::new());
        }
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    let mark = keep_local_key(name);
    let mark_variable = mark.rsplit_once('.').map_or("", |(_, variable)| variable);
    for key in keys {
        let variable = key.rsplit_once('.').map_or("", |(_, variable)| variable);
        if variable.eq_ignore_ascii_case(mark_variable) {
            continue;
        }
        let args = ["config", "--local", "--unset-all", &key];
        let out = run_git_config_write_held(held, repo_path, &args, DEFAULT_TIMEOUT).await?;
        // Exit 5: the key is already gone.
        if out.code != 0 && out.code != 5 {
            return Err(AppError::Git {
                code: out.code,
                stderr: out.full_failure_text(),
            });
        }
    }
    Ok(Vec::new())
}

/// Puts back the `branch.<name>` records a rename removed when git refused it or never
/// finished (a spawn error, a timeout), under the same held mutex, while `name` still has
/// no ref (a rename that left a ref there minted its own section). Best-effort and logged:
/// the rename's own failure is the answer.
/// A value-less key comes back as `true`, the same boolean.
async fn restore_dropped_branch_settings(
    held: &ConfigWriteHeld,
    repo_path: &str,
    name: &str,
    dropped: &[(String, Option<String>)],
) {
    if !matches!(exact_branch_tip(repo_path, name).await, Ok(None)) {
        return;
    }
    for (key, value) in dropped {
        let value = value.as_deref().unwrap_or("true");
        let args = ["config", "--local", "--add", key.as_str(), value];
        let restored = run_git_config_write_held(held, repo_path, &args, DEFAULT_TIMEOUT).await;
        if !restored.as_ref().is_ok_and(|out| out.code == 0) {
            eprintln!("gitdesktop: couldn't restore {key} after a refused rename");
        }
    }
}

/// The records of the `[branch "<name>"]` section in a `config --null --list` text, in
/// order: a record is `<key>\n<value>`, or `<key>` alone for a value-less key. The key
/// splits at its first dot (section, any case) and its last (variable); the subsection
/// between may hold dots and must equal `name` exactly, as git compares it.
fn branch_section_records(list_output: &str, name: &str) -> Vec<(String, Option<String>)> {
    let mut records = Vec::new();
    for record in list_output.split('\0') {
        let (key, value) = match record.split_once('\n') {
            Some((key, value)) => (key, Some(value)),
            None => (record, None),
        };
        let Some((section, rest)) = key.split_once('.') else {
            continue;
        };
        let Some((subsection, _)) = rest.rsplit_once('.') else {
            continue;
        };
        if section.eq_ignore_ascii_case("branch") && subsection == name {
            records.push((key.to_string(), value.map(str::to_string)));
        }
    }
    records
}

/// [`branch_section_records`]' keys, each once.
fn branch_section_keys(list_output: &str, name: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for (key, _) in branch_section_records(list_output, name) {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

#[cfg(test)]
type TestHook = std::sync::Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync,
>;

#[cfg(test)]
tokio::task_local! {
    /// Awaited inside [`run_minting_write`] after the leftover-settings cleanup, before git.
    static MINT_CLEANUP_HOOK: TestHook;
    /// Awaited in [`git_branches`] after its `for-each-ref` read, before any reflog spawn.
    static LISTING_REFLOG_HOOK: TestHook;
    /// Awaited in [`git_branches`] after its flag read, before the push-routing read.
    static LISTING_ROUTING_HOOK: TestHook;
}

#[cfg(test)]
async fn run_test_hook(hook: &'static tokio::task::LocalKey<TestHook>) {
    if let Ok(wait) = hook.try_with(|hook| hook()) {
        wait.await;
    }
}

/// One branch's upstream, read from its exact `for-each-ref` line.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BranchUpstream {
    /// Through `parse_upstream_tracking`.
    pub upstream: crate::git::remote::Upstream,
    /// `%(upstream:remotename)`.
    pub remote: String,
    /// `[gone]` in `%(upstream:track)`.
    pub gone: bool,
    /// `%(upstream)`: the full tracking ref, empty when git maps none (a fetch refspec
    /// that does not cover the upstream).
    pub tracking_ref: String,
}

impl BranchUpstream {
    /// The upstream's branch name when it is LIVE: a branch, on a named remote, not gone.
    /// A bare `branch.<b>.merge = <x>` is branch `<x>`.
    pub(crate) fn live_branch(&self) -> Option<&str> {
        match &self.upstream {
            crate::git::remote::Upstream::Branch(up)
                if crate::git::remote::is_named_remote(&self.remote) && !self.gone =>
            {
                Some(up)
            }
            _ => None,
        }
    }
}

/// `Ok(None)`: `branch` fails `validate_branch_name` (no spawn), or has no exact line. A
/// failed run is the `Err`.
pub(crate) async fn read_branch_upstream(
    repo_path: &str,
    branch: &str,
) -> AppResult<Option<BranchUpstream>> {
    if validate_branch_name(branch).is_err() {
        return Ok(None);
    }
    let full_ref = branch_full_ref(branch)?;
    let format = format!(
        "{}%00%(upstream)",
        crate::git::remote::UPSTREAM_TRACKING_FORMAT
    );
    let out = run_git(
        Some(repo_path),
        &["for-each-ref", &format, &full_ref],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(parse_branch_upstream(&out.stdout_lossy(), &full_ref))
}

/// The first line's upstream when its refname is exactly `full_ref` (the pattern also
/// lists `<branch>/…` children, which sort after it).
fn parse_branch_upstream(stdout: &str, full_ref: &str) -> Option<BranchUpstream> {
    let (upstream, remote, gone) = crate::git::remote::parse_upstream_tracking(stdout, full_ref)?;
    let tracking_ref = stdout
        .lines()
        .next()
        .and_then(|line| {
            line.split('\0')
                .nth(crate::git::remote::UPSTREAM_TRACKING_FIELDS)
        })
        .unwrap_or("")
        .to_string();
    Some(BranchUpstream {
        upstream,
        remote,
        gone,
        tracking_ref,
    })
}

/// The target of the `ref: <target>\tHEAD` line of `ls-remote --symref` output: the first
/// line starting `ref: ` must split at its tab into a non-empty target and exactly `HEAD`.
pub(crate) fn parse_symref_head(stdout: &str) -> Option<String> {
    let line = stdout.lines().find(|line| line.starts_with("ref: "))?;
    let (target, name) = line.strip_prefix("ref: ")?.split_once('\t')?;
    (!target.is_empty() && name == "HEAD").then(|| target.to_string())
}

/// Live `ls-remote --symref <remote> HEAD`: the remote's default as a full ref; `Ok(None)`
/// when it printed no symref line. A spawn error, timeout or non-zero exit is the `Err`.
pub(crate) async fn live_remote_default(
    repo_path: &str,
    remote: &str,
) -> AppResult<Option<String>> {
    validate_ref_name(remote)?;
    if !crate::git::remote::is_named_remote(remote) {
        return Err(AppError::InvalidArgument(format!(
            "invalid remote: {remote}"
        )));
    }
    let cred = crate::forge::credential_config_for_remote(repo_path, remote).await?;
    let out = crate::git::remote::run_git_with_creds_once(
        repo_path,
        &cred,
        &["ls-remote", "--symref", remote, "HEAD"],
        REMOTE_READ_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    Ok(parse_symref_head(&out.stdout_lossy()))
}

/// How many refs one reflog read names.
const REFLOG_BATCH: usize = 64;

/// One spawn over at most [`REFLOG_BATCH`] full refs: each ref's subjects, newest first.
/// `--no-show-signature` keeps `log.showSignature` from running gpg per entry; the trailing
/// `--` keeps a tracked path spelled like a ref from failing the read. One missing ref fails
/// the whole call.
async fn read_reflog_subjects(
    repo_path: &str,
    full_refs: &[String],
) -> AppResult<std::collections::HashMap<String, Vec<String>>> {
    let mut args = vec![
        "reflog",
        "show",
        "--no-show-signature",
        "--format=%gD%x09%gs",
    ];
    args.extend(full_refs.iter().map(String::as_str));
    args.push("--");
    let out = run_git(Some(repo_path), &args, DEFAULT_TIMEOUT).await?;
    Ok(parse_reflog_batch(&out.stdout_lossy()))
}

/// `<full ref>@{N}<TAB><subject>` lines into each ref's subjects, in line order; refs may
/// arrive in any order. The selector's ref is the text before its last `@{`; a line without
/// a tab or without `@{` is skipped.
fn parse_reflog_batch(stdout: &str) -> std::collections::HashMap<String, Vec<String>> {
    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for line in stdout.lines() {
        let Some((selector, subject)) = line.split_once('\t') else {
            continue;
        };
        let Some(at) = selector.rfind("@{") else {
            continue;
        };
        map.entry(selector[..at].to_string())
            .or_default()
            .push(subject.to_string());
    }
    map
}

/// `branch`'s earlier names from its reflog subjects (newest first), most recent first.
/// The walk stops at the first `branch: Created from` entry: a rename chain lies above its
/// own creation. Only the whole `Branch: renamed refs/heads/<from> to refs/heads/<to>` form
/// counts, with `<to>` equal to the current name ignoring case (a folding disk can store a
/// folder-case variant).
fn previous_branch_names(subjects: &[String], branch: &str) -> Vec<String> {
    let mut current = branch.to_string();
    let mut names = Vec::new();
    for subject in subjects {
        if subject.starts_with("branch: Created from") {
            break;
        }
        let Some((from, to)) = subject
            .strip_prefix("Branch: renamed refs/heads/")
            .and_then(|rest| rest.split_once(" to refs/heads/"))
        else {
            continue;
        };
        if from.is_empty() || to.is_empty() || from.contains(' ') || to.contains(' ') {
            continue;
        }
        if eq_ignoring_case(to, &current) {
            names.push(from.to_string());
            current = from.to_string();
        }
    }
    names
}

/// A local branch that is a renamed copy of the remote branch it still tracks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenamedCopy {
    pub remote: String,
    pub upstream_branch: String,
    /// True when the local `refs/remotes/<remote>/HEAD` names a ref that exists (the predicate
    /// having answered, it does not name the upstream); false when that symref is absent
    /// or dangling, so the remote's default is unmeasured.
    pub default_measured: bool,
}

/// `Some` only when ALL hold: `branch`'s upstream is LIVE; that branch's name differs from
/// `branch`; that name is, exactly, one of `branch`'s own previous names by its reflog; and
/// the upstream is not measured as the remote's default branch. `None` in every other case
/// (a name failing `validate_branch_name`, no upstream, gone, local `.`, same name, no
/// reflog, a start-point branch of any kind). A failed read is that read's error. Not
/// detected, each read as not a renamed copy: `git branch -c` copies (`Branch:
/// copied …`), rename entries older than the reflog expiry (`gc.reflogExpire`, about 90
/// days by default), and clients writing another subject form. The upstream is read first,
/// so a variant spelling finds no exact line and never reads the reflog.
pub(crate) async fn renamed_copy_of(
    repo_path: &str,
    branch: &str,
) -> AppResult<Option<RenamedCopy>> {
    if validate_branch_name(branch).is_err() {
        return Ok(None);
    }
    let Some(line) = read_branch_upstream(repo_path, branch).await? else {
        return Ok(None);
    };
    let Some(up) = line.live_branch() else {
        return Ok(None);
    };
    if up == branch {
        return Ok(None);
    }
    let target = crate::git::remote::remote_head_target(repo_path, &line.remote).await?;
    if crate::git::remote::upstream_is_remote_default(target.as_deref(), &line.tracking_ref)
        == Some(true)
    {
        return Ok(None);
    }
    let full_ref = branch_full_ref(branch)?;
    let subjects = read_reflog_subjects(repo_path, std::slice::from_ref(&full_ref)).await?;
    let subjects = subjects.get(&full_ref).map_or(&[][..], Vec::as_slice);
    if !previous_branch_names(subjects, branch)
        .iter()
        .any(|name| name == up)
    {
        return Ok(None);
    }
    // `symbolic-ref` prints a dangling target with exit 0, so only a target that exists as
    // that exact ref measures the default; a failed read leaves it unmeasured. Never
    // `rev-parse`: it also resolves a branch or tag spelled like the target.
    let default_measured = match target.filter(|t| !t.is_empty()) {
        Some(remote_head) => run_git_raw(
            Some(repo_path),
            &["show-ref", "--verify", "--quiet", &remote_head],
            DEFAULT_TIMEOUT,
        )
        .await
        .is_ok_and(|out| out.code == 0),
        None => false,
    };
    Ok(Some(RenamedCopy {
        remote: line.remote.clone(),
        upstream_branch: up.to_string(),
        default_measured,
    }))
}

/// Create PR's gate: the renamed copy whose create of `head` into `base` is refused, or
/// None. It refuses, with guidance, a renamed copy ([`renamed_copy_of`]: a reflog rename
/// entry, an upstream under a different name) of an origin branch that is neither `base`
/// nor origin's default; a branch that tracks its start point is never refused here (its
/// reflog holds no rename entry). Every create
/// push on every forge, and the MCP tool's, runs behind it. With no local
/// `refs/remotes/origin/HEAD` the default is read live; that read's failure is the `Err`.
pub(crate) async fn renamed_copy_refusing_create(
    repo_path: &str,
    head: &str,
    base: &str,
) -> AppResult<Option<RenamedCopy>> {
    if validate_branch_name(head).is_err() {
        return Ok(None);
    }
    let Some(copy) = renamed_copy_of(repo_path, head).await? else {
        return Ok(None);
    };
    if copy.remote != "origin" || copy.upstream_branch == base {
        return Ok(None);
    }
    if copy.default_measured {
        return Ok(Some(copy));
    }
    match live_remote_default(repo_path, "origin").await? {
        Some(target)
            if target.strip_prefix("refs/heads/") == Some(copy.upstream_branch.as_str()) =>
        {
            Ok(None)
        }
        _ => Ok(Some(copy)),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::branch_reset_to_upstream_within;
    use super::git_delete_branch_within;
    use super::git_delete_remote_branch_core;
    use super::update_holder_refusal;
    use super::{archive_config_busy, set_branch_archived_core};
    use super::{
        branch_reset_to_upstream, branch_rewrite_status, build_create_branch_args,
        divergence_out_of_range, git_branch_merge_states, git_branches,
        git_checkout_remote_branch_core, git_create_branch_core, git_default_branch,
        git_delete_branch_core, git_rename_branch_core, is_config_lock_contention,
        merge_diverged_in_worktree, parse_cherry_counts, parse_upstream_track,
        refuse_session_rename, update_branch_from, update_worktree_path, validate_branch_name,
        validate_ref_name, BranchRewriteStatus, MergePair, RenameBranchOutcome, UpdatePins,
        RENAMED_CONFIG_LEFT_BEHIND, UPSTREAM_WRITE_FAILED,
    };
    use super::{
        branch_tip_sha, current_branch_name, is_session_holder, name_paths, update_in_holder,
        worktree_holding_branch, HolderMerge, UpdateBranchOutcome,
    };
    use super::{deleted_branch_upstream, exact_branch_tip, exact_ref_field, upstream_display};
    use super::{
        is_unknown_format_atom, push_destination, read_refs_with_fallback,
        read_refs_with_push_destination, PUSH_DESTINATION_ATOMS, UPSTREAM_ATOM_INDEX,
    };
    use super::{DeleteBranchOutcome, DeletePhase, DeletePhaseHook, DELETE_PHASE_HOOK};
    use super::{RenamePhase, RenamePhaseHook, RENAME_PHASE_HOOK};
    use super::{UnpushedBasis, UnpushedCount};
    use crate::error::AppError;
    use crate::git::runner::LOCK_WAIT_TIMEOUT;
    use crate::git::runner::{
        acquire_repo_lock, hold_config_lock, release_config_lock_before_attempt, run_git,
        run_git_raw, CONFIG_WRITE_ATTEMPT_HOOK, CONFIG_WRITE_LOCK_EVENTS, GIT_SPAWN_LOG,
        TEST_GIT_HANG_GUARD,
    };
    use crate::state::AppState;
    use std::collections::HashSet;
    use std::sync::Arc;
    use std::time::Duration;

    async fn git_ok(repo: &str, args: &[&str]) -> bool {
        run_git_raw(Some(repo), args, TEST_GIT_HANG_GUARD)
            .await
            .unwrap()
            .code
            == 0
    }

    fn is_publish_busy<T: std::fmt::Debug>(result: Result<T, AppError>) -> bool {
        matches!(result, Err(AppError::Busy { holder }) if holder == "a repository publish")
    }

    /// While a publish holds `feat`, every route that would rename, delete or archive it
    /// refuses with `Busy` and changes nothing; unarchive, another branch and the hold's
    /// end pass.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_publish_hold_refuses_delete_rename_and_archive_of_its_branch() {
        use super::{delete_branch_ref_at, hold_publishing_branch};
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (g, repo, feat, _head) = delete_fixture("publish-hold").await;
        let wt = g.path().join("hold-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt, "HEAD"]).await;
        run(&repo, &["branch", "other"]).await;
        let state = AppState::default();
        let section = branch_section(&repo, "feat").await;
        {
            let _hold = hold_publishing_branch(&repo, "feat").await;
            assert!(is_publish_busy(delete(&state, &repo, "feat", None).await));
            assert!(is_publish_busy(
                delete_branch_ref_at(&state, &wt, "feat", &feat).await
            ));
            let renamed =
                git_rename_branch_core(&state, repo.clone(), "feat".into(), "renamed".into()).await;
            assert!(is_publish_busy(renamed));
            assert!(is_publish_busy(
                set_branch_archived_core(&repo, "feat", true).await
            ));
            assert!(is_publish_busy(
                set_branch_archived_core(&repo, "FEAT", true).await
            ));
            set_branch_archived_core(&repo, "feat", false)
                .await
                .unwrap();
            set_branch_archived_core(&repo, "other", true)
                .await
                .unwrap();
            assert_eq!(
                full_ref_tip(&repo, "refs/heads/feat").await,
                Some(feat.clone())
            );
            assert_eq!(branch_section(&repo, "feat").await, section);
            assert!(!branch_exists(&repo, "renamed").await);
        }
        set_branch_archived_core(&repo, "feat", true).await.unwrap();
        set_branch_archived_core(&repo, "feat", false)
            .await
            .unwrap();
        git_rename_branch_core(&state, repo.clone(), "feat".into(), "renamed".into())
            .await
            .unwrap();
        delete(&state, &repo, "renamed", None).await.unwrap();
    }

    /// A rename onto a name whose leftover section says `remote = stale` and Keep local
    /// false keeps exactly the renamed branch's own settings.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_rename_drops_the_leftover_section_of_its_new_name() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_g, _base, repo) = keep_local_repo("orphan-rename").await;
        run(&repo, &["branch", "old"]).await;
        run(&repo, &["config", "branch.old.remote", "origin"]).await;
        run(&repo, &["config", "branch.old.merge", "refs/heads/old"]).await;
        super::set_branch_keep_local_core(&repo, "old", true)
            .await
            .unwrap();
        append_config(
            &repo,
            "[branch \"new\"]\n\tremote = stale\n\tgitdesktopLocalOnly = false\n\tleftover = kept\n",
        );
        git_rename_branch_core(
            &AppState::default(),
            repo.clone(),
            "old".into(),
            "new".into(),
        )
        .await
        .unwrap();
        let remotes = run_git_raw(
            Some(&repo),
            &["config", "--get-all", "branch.new.remote"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap()
        .stdout_lossy();
        assert_eq!(remotes, "origin\n");
        assert!(super::branch_keep_local(&repo, "new").await.unwrap());
        assert!(!git_ok(&repo, &["config", "--get", "branch.new.leftover"]).await);
    }

    async fn create_no_track(repo: &str, name: &str, start: Option<&str>) -> Result<(), AppError> {
        git_create_branch_core(
            &AppState::default(),
            repo.to_string(),
            name.to_string(),
            false,
            start.map(str::to_string),
            true,
        )
        .await
    }

    /// A refused rename puts back the destination's leftover section it dropped, a Keep
    /// local mark included: git ran with the source gone, so the new name has no ref.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn a_refused_rename_restores_the_dropped_leftover_settings() {
        use super::{TestHook, MINT_CLEANUP_HOOK};
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store.path());
        let (_g, _base, repo) = keep_local_repo("orphan-rename-refused").await;
        run(&repo, &["branch", "src"]).await;
        append_config(
            &repo,
            "[branch \"dst\"]\n\tremote = stale\n\tgitdesktopLocalOnly = true\n",
        );
        let hook: TestHook = {
            let repo = repo.clone();
            Arc::new(move || {
                let repo = repo.clone();
                Box::pin(async move {
                    run(&repo, &["update-ref", "-d", "refs/heads/src"]).await;
                })
            })
        };
        let state = AppState::default();
        let rename =
            super::git_rename_branch_core(&state, repo.clone(), "src".into(), "dst".into());
        let renamed = MINT_CLEANUP_HOOK.scope(hook.clone(), rename).await;
        assert!(renamed.is_err(), "git refused the rename");
        assert!(!branch_exists(&repo, "dst").await);
        let section = branch_section(&repo, "dst").await;
        assert!(section.contains("branch.dst.remote stale"), "{section}");
        assert!(
            section.contains("branch.dst.gitdesktoplocalonly true"),
            "{section}"
        );

        // A hand-capitalised header is no section `--remove-section` finds: nothing was
        // dropped, so the refused rename adds nothing to it.
        run(&repo, &["branch", "src"]).await;
        append_config(&repo, "[Branch \"dup\"]\n\tremote = stale\n");
        let rename =
            super::git_rename_branch_core(&state, repo.clone(), "src".into(), "dup".into());
        let renamed = MINT_CLEANUP_HOOK.scope(hook, rename).await;
        assert!(renamed.is_err(), "git refused the rename onto dup");
        assert_eq!(
            run(&repo, &["config", "--get-all", "branch.dup.remote"])
                .await
                .trim(),
            "stale"
        );
    }

    /// A rename whose git never ran (its spawn failed) also puts back the destination's
    /// dropped leftover section, and answers that spawn's own error.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn a_rename_that_never_ran_restores_the_dropped_leftover_settings() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store.path());
        let (_g, _base, repo) = keep_local_repo("orphan-rename-unspawned").await;
        run(&repo, &["branch", "src"]).await;
        append_config(
            &repo,
            "[branch \"dst\"]\n\tremote = stale\n\tgitdesktopLocalOnly = true\n",
        );
        // The rename's spawn finds the repository moved away; the next spawn moves it back.
        let away = format!("{repo}-away");
        let steps = Arc::new(AtomicUsize::new(0));
        let log = {
            let (repo, away, steps) = (repo.clone(), away.clone(), steps.clone());
            Arc::new(move |args: &[&str]| match steps.load(SeqCst) {
                0 if args.first() == Some(&"branch") && args.contains(&"--") => {
                    move_dir(&repo, &away);
                    steps.store(1, SeqCst);
                }
                1 => {
                    move_dir(&away, &repo);
                    steps.store(2, SeqCst);
                }
                _ => {}
            })
        };
        let state = AppState::default();
        let rename =
            super::git_rename_branch_core(&state, repo.clone(), "src".into(), "dst".into());
        let renamed = GIT_SPAWN_LOG.scope(log, rename).await;
        assert_eq!(steps.load(SeqCst), 2, "fixture: away and back: {renamed:?}");
        assert!(
            matches!(
                renamed,
                Err(crate::error::AppError::Io(_) | crate::error::AppError::GitNotFound)
            ),
            "{renamed:?}"
        );
        assert!(branch_exists(&repo, "src").await);
        assert!(!branch_exists(&repo, "dst").await);
        let section = branch_section(&repo, "dst").await;
        assert!(section.contains("branch.dst.remote stale"), "{section}");
        assert!(
            section.contains("branch.dst.gitdesktoplocalonly true"),
            "{section}"
        );
    }

    /// Moves a folder, retrying while Windows still holds a handle in it (a scanner, say).
    /// A spawn whose working directory was moved away fails before git runs.
    fn move_dir(from: &str, to: &str) {
        for _ in 0..100 {
            if std::fs::rename(from, to).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("couldn't move {from} to {to}");
    }

    /// A publish of the branch that starts while a rename waits for its locks refuses the
    /// rename inside its hold.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn a_publish_during_a_renames_waits_refuses_it() {
        use super::{RenamePhase, RenamePhaseHook, RENAME_PHASE_HOOK};
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store.path());
        let (_g, _base, repo) = keep_local_repo("rename-publish-late").await;
        run(&repo, &["branch", "src"]).await;
        let held = Arc::new(std::sync::Mutex::new(Vec::new()));
        let hook: RenamePhaseHook = {
            let (repo, held) = (repo.clone(), held.clone());
            Arc::new(move |phase| {
                let (repo, held) = (repo.clone(), held.clone());
                Box::pin(async move {
                    if phase == RenamePhase::BeforeGit {
                        let hold = super::hold_publishing_branch(&repo, "src").await;
                        held.lock().unwrap().push(hold);
                    }
                })
            })
        };
        let state = AppState::default();
        let rename =
            super::git_rename_branch_core(&state, repo.clone(), "src".into(), "dst".into());
        let renamed = RENAME_PHASE_HOOK.scope(hook, rename).await;
        assert!(
            matches!(&renamed, Err(crate::error::AppError::Busy { holder }) if holder == super::PUBLISH_HOLDER),
            "the rename ran under a publish"
        );
        held.lock().unwrap().clear();
        assert!(branch_exists(&repo, "src").await);
        assert!(!branch_exists(&repo, "dst").await);
    }

    /// A publish of the branch that starts before the delete's mutex refuses the delete.
    #[tokio::test]
    async fn a_publish_before_a_deletes_guards_refuses_it() {
        use super::{DeletePhase, DeletePhaseHook, DELETE_PHASE_HOOK};
        let (_g, _base, repo) = keep_local_repo("delete-publish-late").await;
        run(&repo, &["branch", "victim"]).await;
        let tip = full_ref_tip(&repo, "refs/heads/victim").await.unwrap();
        let held = Arc::new(std::sync::Mutex::new(Vec::new()));
        let hook: DeletePhaseHook = {
            let (repo, held) = (repo.clone(), held.clone());
            Arc::new(move |phase| {
                let (repo, held) = (repo.clone(), held.clone());
                Box::pin(async move {
                    if phase == DeletePhase::BeforeGuards {
                        let hold = super::hold_publishing_branch(&repo, "victim").await;
                        held.lock().unwrap().push(hold);
                    }
                })
            })
        };
        let state = AppState::default();
        let delete = super::delete_branch_ref_at(&state, &repo, "victim", &tip);
        let deleted = DELETE_PHASE_HOOK.scope(hook, delete).await;
        assert!(
            matches!(&deleted, Err(crate::error::AppError::Busy { .. })),
            "the delete ran under a publish"
        );
        held.lock().unwrap().clear();
        assert!(branch_exists(&repo, "victim").await);
    }

    /// A branch literally named `@` is its own stored spelling, so the publishing refusal
    /// every push runs passes it, and still reads its Keep local mark.
    #[tokio::test]
    async fn a_branch_named_at_passes_the_publishing_refusal() {
        let (_g, _base, repo) = keep_local_repo("at-spelling").await;
        run(&repo, &["update-ref", "refs/heads/@", "HEAD"]).await;
        assert_eq!(
            super::stored_branch_spelling(&repo, "@").await.unwrap(),
            "@"
        );
        crate::git::remote::refuse_publishing_branch(&repo, "@")
            .await
            .unwrap();
        run(&repo, &["config", "branch.@.gitdesktopLocalOnly", "true"]).await;
        assert!(matches!(
            crate::git::remote::refuse_publishing_branch(&repo, "@").await,
            Err(crate::error::AppError::BranchKeptLocal { .. })
        ));
    }

    /// A create drops a leftover section; with a true mark in it, the mark stays and the
    /// other keys are already gone when git runs (read from the cleanup hook).
    #[tokio::test]
    async fn a_create_drops_leftover_settings_and_keeps_a_true_mark() {
        use super::{TestHook, MINT_CLEANUP_HOOK};
        let (_g, _base, repo) = keep_local_repo("orphan-create").await;
        append_config(
            &repo,
            "[branch \"x\"]\n\tremote = stale\n\tmerge = refs/heads/gone\n\tgitdesktopArchived = true\n",
        );
        create_no_track(&repo, "x", None).await.unwrap();
        assert_eq!(branch_section(&repo, "x").await, "");
        append_config(
            &repo,
            "[branch \"y\"]\n\tremote = stale\n\tmerge = refs/heads/gone\n\tgitdesktopArchived = true\n\tgitdesktopLocalOnly = true\n",
        );
        let seen = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hook: TestHook = {
            let (repo, seen) = (repo.clone(), seen.clone());
            Arc::new(move || {
                let (repo, seen) = (repo.clone(), seen.clone());
                Box::pin(async move {
                    assert!(super::branch_keep_local(&repo, "y").await.unwrap());
                    assert!(!branch_exists(&repo, "y").await, "the hook runs before git");
                    for key in ["remote", "merge", "gitdesktopArchived"] {
                        let key = format!("branch.y.{key}");
                        assert!(!git_ok(&repo, &["config", "--get", &key]).await, "{key}");
                    }
                    seen.store(true, std::sync::atomic::Ordering::SeqCst);
                })
            })
        };
        MINT_CLEANUP_HOOK
            .scope(hook, create_no_track(&repo, "y", None))
            .await
            .unwrap();
        assert!(seen.load(std::sync::atomic::Ordering::SeqCst));
        assert!(branch_exists(&repo, "y").await);
        assert!(super::branch_keep_local(&repo, "y").await.unwrap());
        let section = branch_section(&repo, "y").await;
        assert_eq!(
            section.trim(),
            "branch.y.gitdesktoplocalonly true",
            "{section}"
        );
        // Restore's contract: a mark set before the create survives it, and a failed
        // create leaves the mark in place.
        super::set_branch_keep_local_core(&repo, "z", true)
            .await
            .unwrap();
        create_no_track(&repo, "z", None).await.unwrap();
        assert!(super::branch_keep_local(&repo, "z").await.unwrap());
        super::set_branch_keep_local_core(&repo, "w", true)
            .await
            .unwrap();
        assert!(create_no_track(&repo, "w", Some("no-such-start"))
            .await
            .is_err());
        assert!(!branch_exists(&repo, "w").await);
        assert!(super::branch_keep_local(&repo, "w").await.unwrap());
        // An existing ref is never touched, and an other-case section survives.
        run(&repo, &["branch", "exist"]).await;
        run(&repo, &["config", "branch.exist.remote", "keep"]).await;
        assert!(create_no_track(&repo, "exist", None).await.is_err());
        assert_eq!(
            run(&repo, &["config", "--get", "branch.exist.remote"]).await,
            "keep\n"
        );
        append_config(&repo, "[branch \"Q\"]\n\tremote = other\n");
        create_no_track(&repo, "q", None).await.unwrap();
        assert_eq!(
            run(&repo, &["config", "--get", "branch.Q.remote"]).await,
            "other\n"
        );
    }

    #[test]
    fn branch_section_keys_reads_exact_subsections() {
        use super::branch_section_keys;
        let listed = "branch.feat.v2.remote\norigin\0branch.feat.v2.flag\0branch.X.remote\nother\0\
                      branch.x.merge\nrefs/heads/x\0core.bare\nfalse\0branch.x.merge\nrefs/heads/y\0";
        assert_eq!(
            branch_section_keys(listed, "feat.v2"),
            ["branch.feat.v2.remote", "branch.feat.v2.flag"]
        );
        assert_eq!(branch_section_keys(listed, "x"), ["branch.x.merge"]);
        assert_eq!(branch_section_keys(listed, "X"), ["branch.X.remote"]);
        assert!(branch_section_keys("", "x").is_empty());
    }

    /// A detached sibling at the deleted tip commits after the delete: the delete is put
    /// back and the refusal says the checkout moved, not that the branch is checked out.
    #[tokio::test]
    async fn delete_branch_names_a_sibling_whose_head_only_moved() {
        let (g, repo, feat, _head) = delete_fixture("del-moved").await;
        let wt = g.path().join("moved-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt, "feat"]).await;
        let hook = git_at_phase(
            DeletePhase::AfterDelete,
            &wt,
            &["commit", "-q", "--allow-empty", "-m", "moved"],
        );
        let err = DELETE_PHASE_HOOK
            .scope(hook, delete(&AppState::default(), &repo, "feat", None))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with("feat wasn't deleted: the checkout at ")
                    && m.ends_with(" moved to another commit while the delete ran, and it may \
                                    have been using feat. Try again.")),
            "{err:?}"
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(feat));
    }

    #[test]
    fn previous_branch_names_walks_renames_above_the_creation_entry() {
        use super::previous_branch_names;
        let walk = |subjects: &[&str], branch: &str| {
            let subjects: Vec<String> = subjects.iter().map(|s| s.to_string()).collect();
            previous_branch_names(&subjects, branch)
        };
        let created = "branch: Created from main";
        let renamed = "Branch: renamed refs/heads/old to refs/heads/new";
        assert_eq!(walk(&[renamed, created], "new"), ["old"]);
        assert_eq!(
            walk(
                &[
                    "Branch: renamed refs/heads/mid to refs/heads/new",
                    "Branch: renamed refs/heads/old to refs/heads/mid",
                    created,
                ],
                "new"
            ),
            ["mid", "old"]
        );
        assert_eq!(
            walk(
                &["Branch: renamed refs/heads/new to refs/heads/New", renamed],
                "New"
            ),
            ["new", "old"]
        );
        // A stale rename entry under a creation entry is never reached.
        assert!(walk(&[created, renamed], "new").is_empty());
        assert!(walk(
            &["branch: Created from refs/remotes/origin/topic", renamed],
            "new"
        )
        .is_empty());
        assert_eq!(
            walk(&["commit: x", renamed, "branch: Created from HEAD"], "new"),
            ["old"]
        );
        assert_eq!(
            walk(
                &["Branch: renamed refs/heads/old to refs/heads/Feat/x"],
                "feat/x"
            ),
            ["old"]
        );
        for skipped in [
            "commit: Branch: renamed refs/heads/a to refs/heads/new",
            "branch: renamed refs/heads/a to refs/heads/new",
            "Branch: copied refs/heads/a to refs/heads/new",
            "Branch: renamed refs/heads/a b to refs/heads/new",
            "Branch: renamed refs/heads/ to refs/heads/new",
        ] {
            assert!(walk(&[skipped], "new").is_empty(), "{skipped}");
        }
    }

    #[test]
    fn parse_reflog_batch_groups_each_ref_newest_first() {
        use super::parse_reflog_batch;
        let out = "refs/heads/b@{0}\tBranch: renamed refs/heads/a to refs/heads/b\n\
                   refs/heads/b@{1}\tbranch: Created from main\n\
                   refs/heads/x@{y@{0}\tcommit: a\tb\n\
                   refs/heads/a2@{0}\tcommit: c\n\
                   no tab here\n\
                   refs/heads/q\tno selector\n";
        let map = parse_reflog_batch(out);
        assert_eq!(
            map.get("refs/heads/b").unwrap(),
            &[
                "Branch: renamed refs/heads/a to refs/heads/b",
                "branch: Created from main"
            ]
        );
        assert_eq!(map.get("refs/heads/x@{y").unwrap(), &["commit: a\tb"]);
        assert_eq!(map.get("refs/heads/a2").unwrap(), &["commit: c"]);
        assert_eq!(map.len(), 3, "{map:?}");
        assert!(parse_reflog_batch("").is_empty());
    }

    #[test]
    fn parse_symref_head_reads_only_the_head_symref_line() {
        use super::parse_symref_head;
        let sha = "a".repeat(40);
        let f1 = format!(
            "ref: refs/heads/main\tHEAD\n{sha}\tHEAD\n{sha}\trefs/heads/old\n{sha}\trefs/heads/x/refs/heads/old\n"
        );
        assert_eq!(parse_symref_head(&f1).as_deref(), Some("refs/heads/main"));
        assert_eq!(parse_symref_head(&format!("{sha}\tHEAD\n")), None);
        assert_eq!(
            parse_symref_head("ref: refs/heads/main\trefs/heads/x\n"),
            None
        );
        assert_eq!(parse_symref_head("ref: \tHEAD\n"), None);
    }

    #[test]
    fn parse_branch_upstream_reads_the_exact_line_and_its_tracking_ref() {
        use super::parse_branch_upstream;
        use crate::git::remote::Upstream;
        let own = "refs/heads/p\0refs/heads/p\0origin\0\0refs/remotes/origin/p\n\
                   refs/heads/p/child\0refs/heads/c\0origin\0\0refs/remotes/origin/c\n";
        let line = parse_branch_upstream(own, "refs/heads/p").unwrap();
        assert_eq!(line.upstream, Upstream::Branch("p".into()));
        assert_eq!((line.remote.as_str(), line.gone), ("origin", false));
        assert_eq!(line.tracking_ref, "refs/remotes/origin/p");
        let child_only = "refs/heads/p/child\0refs/heads/c\0origin\0\0refs/remotes/origin/c\n";
        assert_eq!(parse_branch_upstream(child_only, "refs/heads/p"), None);
        let gone = parse_branch_upstream(
            "refs/heads/g\0refs/heads/g\0origin\0[gone]\0\n",
            "refs/heads/g",
        )
        .unwrap();
        assert!(gone.gone && gone.live_branch().is_none());
        assert_eq!(gone.tracking_ref, "");
    }

    /// A repository whose `origin` is itself, never fetched (so no
    /// `refs/remotes/origin/HEAD` until a row pins one), with reflogs on.
    async fn copy_repo(tag: &str) -> (tempfile::TempDir, std::path::PathBuf, String) {
        let (guard, base, repo) = keep_local_repo(tag).await;
        run(&repo, &["config", "core.logAllRefUpdates", "true"]).await;
        run(&repo, &["remote", "add", "origin", &repo]).await;
        (guard, base, repo)
    }

    /// `name` created tracking `origin/<up>`, its tracking ref minted at HEAD.
    async fn tracking_branch(repo: &str, name: &str, up: &str) {
        let tracking = format!("refs/remotes/origin/{up}");
        run(repo, &["update-ref", &tracking, "HEAD"]).await;
        run(repo, &["branch", "--track", name, &tracking]).await;
    }

    /// Pins the local `refs/remotes/origin/HEAD` to `origin/<target>`, or removes it, and
    /// asserts the pin before any row reads it.
    async fn pin_remote_head(repo: &str, target: Option<&str>) {
        if let Some(target) = target {
            let to = format!("refs/remotes/origin/{target}");
            run(repo, &["symbolic-ref", "refs/remotes/origin/HEAD", &to]).await;
        } else {
            let _ = git_ok(repo, &["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]).await;
        }
        let present = git_ok(repo, &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).await;
        assert_eq!(present, target.is_some(), "the remote-HEAD pin");
    }

    #[tokio::test]
    async fn renamed_copy_of_reads_the_reflog_behind_a_live_upstream() {
        use super::{read_branch_upstream, renamed_copy_of, RenamedCopy};
        let (_g, base, repo) = copy_repo("renamed-copy").await;
        let copy = |up: &str, measured: bool| {
            Some(RenamedCopy {
                remote: "origin".into(),
                upstream_branch: up.into(),
                default_measured: measured,
            })
        };
        tracking_branch(&repo, "old", "old").await;
        run(&repo, &["branch", "-m", "old", "new"]).await;
        tracking_branch(&repo, "c1", "c1").await;
        run(&repo, &["branch", "-m", "c1", "mid"]).await;
        run(&repo, &["branch", "-m", "mid", "chain"]).await;
        tracking_branch(&repo, "feat2", "feat1").await;
        tracking_branch(&repo, "hotfix", "release-1.2").await;
        tracking_branch(&repo, "dflt", "dflt").await;
        run(&repo, &["branch", "-m", "dflt", "dcopy"]).await;
        tracking_branch(&repo, "same", "same").await;
        tracking_branch(&repo, "g", "g").await;
        run(&repo, &["branch", "-m", "g", "gone"]).await;
        run(&repo, &["update-ref", "-d", "refs/remotes/origin/g"]).await;
        run(&repo, &["branch", "--track", "lo", "main"]).await;
        run(&repo, &["branch", "-m", "lo", "lo2"]).await;
        tracking_branch(&repo, "feat", "feat").await;
        run(&repo, &["branch", "-M", "feat", "Feat"]).await;
        tracking_branch(&repo, "ob", "ob").await;
        run(&repo, &["config", "branch.ob.merge", "ob"]).await;
        run(&repo, &["branch", "-m", "ob", "nb"]).await;
        run(&repo, &["branch", "par/child"]).await;
        run(&repo, &["config", "core.logAllRefUpdates", "false"]).await;
        tracking_branch(&repo, "nl", "nl").await;
        run(&repo, &["branch", "-m", "nl", "nolog"]).await;

        pin_remote_head(&repo, None).await;
        assert_eq!(
            renamed_copy_of(&repo, "new").await.unwrap(),
            copy("old", false)
        );
        assert_eq!(
            renamed_copy_of(&repo, "chain").await.unwrap(),
            copy("c1", false)
        );
        assert_eq!(
            renamed_copy_of(&repo, "Feat").await.unwrap(),
            copy("feat", false)
        );
        // A bare `branch.<b>.merge = ob` lists with an empty `%(upstream:remoteref)` (and no
        // remote or track) under git 2.51.1, so it reads as untracked: no renamed copy.
        assert_eq!(renamed_copy_of(&repo, "nb").await.unwrap(), None);
        // Unmeasured does not exclude: the default's renamed copy still answers.
        assert_eq!(
            renamed_copy_of(&repo, "dcopy").await.unwrap(),
            copy("dflt", false)
        );
        for none in [
            "feat2", "hotfix", "same", "gone", "lo2", "nolog", "missing", "main", "par",
        ] {
            assert_eq!(renamed_copy_of(&repo, none).await.unwrap(), None, "{none}");
        }
        pin_remote_head(&repo, Some("dflt")).await;
        assert_eq!(renamed_copy_of(&repo, "dcopy").await.unwrap(), None);
        assert_eq!(
            renamed_copy_of(&repo, "new").await.unwrap(),
            copy("old", true)
        );
        // A dangling origin/HEAD: `symbolic-ref --quiet` still prints its target.
        let dangling = "refs/remotes/origin/nope";
        run(
            &repo,
            &["symbolic-ref", "refs/remotes/origin/HEAD", dangling],
        )
        .await;
        assert!(!git_ok(&repo, &["rev-parse", "--verify", "-q", dangling]).await);
        assert_eq!(
            renamed_copy_of(&repo, "new").await.unwrap(),
            copy("old", false),
            "a dangling default is unmeasured"
        );
        // A branch spelled like the target: `rev-parse` resolves it, the exact read does not.
        run(&repo, &["branch", dangling]).await;
        let peel = "refs/remotes/origin/nope^{commit}";
        assert!(git_ok(&repo, &["rev-parse", "--verify", "-q", peel]).await);
        assert_eq!(
            renamed_copy_of(&repo, "new").await.unwrap(),
            copy("old", false),
            "a branch named like the dangling target measures nothing"
        );
        pin_remote_head(&repo, Some("dflt")).await;
        // Validation refuses before any spawn, so a non-repository answers too.
        let nowhere = base.to_string_lossy().into_owned();
        assert_eq!(renamed_copy_of(&nowhere, "a~1").await.unwrap(), None);
        assert!(renamed_copy_of(&nowhere, "new").await.is_err());

        assert_eq!(read_branch_upstream(&repo, "par").await.unwrap(), None);
        run(
            &repo,
            &[
                "config",
                "--replace-all",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/mapped/*",
            ],
        )
        .await;
        run(
            &repo,
            &["update-ref", "refs/remotes/origin/mapped/n", "HEAD"],
        )
        .await;
        run(&repo, &["branch", "n"]).await;
        run(&repo, &["config", "branch.n.remote", "origin"]).await;
        run(&repo, &["config", "branch.n.merge", "refs/heads/n"]).await;
        let mapped = read_branch_upstream(&repo, "n").await.unwrap().unwrap();
        assert_eq!(mapped.tracking_ref, "refs/remotes/origin/mapped/n");
        run(
            &repo,
            &[
                "config",
                "--replace-all",
                "remote.origin.fetch",
                "+refs/heads/main:refs/remotes/origin/main",
            ],
        )
        .await;
        let narrow = read_branch_upstream(&repo, "n").await.unwrap().unwrap();
        assert_eq!(narrow.tracking_ref, "");
    }

    /// One listing: two renamed copies, a stacked branch, a same-name branch and the
    /// measured default's renamed copy, plus the rows' push-destination fields. Deleting a
    /// candidate from the hook fails its chunk's reflog read: those rows read false and the
    /// listing stands.
    #[tokio::test]
    async fn listing_flags_renamed_copies_from_one_batched_reflog_read() {
        use super::{named_push_fields, TestHook, LISTING_REFLOG_HOOK};
        let (_g, _base, repo) = copy_repo("list-renamed").await;
        tracking_branch(&repo, "o1", "o1").await;
        run(&repo, &["branch", "-m", "o1", "n1"]).await;
        tracking_branch(&repo, "o2", "o2").await;
        run(&repo, &["branch", "-m", "o2", "n2"]).await;
        tracking_branch(&repo, "feat2", "feat1").await;
        tracking_branch(&repo, "same", "same").await;
        tracking_branch(&repo, "dflt", "dflt").await;
        run(&repo, &["branch", "-m", "dflt", "dcopy"]).await;
        for (key, value) in [
            ("remote.mir.url", repo.as_str()),
            ("remote.mir.fetch", "+refs/heads/*:refs/remotes/mir/*"),
            ("remote.mir.mirror", "true"),
        ] {
            run(&repo, &["config", key, value]).await;
        }
        run(&repo, &["update-ref", "refs/remotes/mir/m", "HEAD"]).await;
        run(&repo, &["branch", "--track", "m", "refs/remotes/mir/m"]).await;
        pin_remote_head(&repo, Some("dflt")).await;
        let names = ["n1", "n2", "feat2", "same", "dcopy"];
        let flags = |rows: &[crate::git::types::Branch]| -> Vec<bool> {
            names
                .iter()
                .map(|n| {
                    rows.iter()
                        .find(|b| b.name == *n)
                        .unwrap()
                        .renamed_from_upstream
                })
                .collect()
        };
        let rows = git_branches(repo.clone()).await.unwrap();
        assert_eq!(flags(&rows), [true, true, false, false, false]);
        let row = |name: &str| rows.iter().find(|b| b.name == name).unwrap().clone();
        let same = row("same");
        assert_eq!(
            (
                same.named_push_remote.as_deref(),
                same.named_push_branch.as_deref(),
                same.named_push_refused
            ),
            (Some("origin"), Some("same"), false)
        );
        let mirror = row("m");
        assert_eq!(
            (
                mirror.named_push_remote,
                mirror.named_push_branch,
                mirror.named_push_refused
            ),
            (None, None, true)
        );
        assert_eq!(named_push_fields(None), (None, None, false));

        let tip = run(&repo, &["rev-parse", "refs/heads/feat2"])
            .await
            .trim()
            .to_string();
        let hook: TestHook = {
            let repo = repo.clone();
            Arc::new(move || {
                let (repo, tip) = (repo.clone(), tip.clone());
                Box::pin(async move {
                    run(&repo, &["update-ref", "-d", "refs/heads/feat2", &tip]).await;
                })
            })
        };
        let rows = LISTING_REFLOG_HOOK
            .scope(hook, git_branches(repo.clone()))
            .await
            .unwrap();
        assert_eq!(flags(&rows), [false, false, false, false, false]);
    }

    /// A routing read that fails for the repository still lists every row, each with its
    /// push-destination fields unread (`named_push_fields(None)`). The routing hook breaks
    /// `.git/config` for that read alone; the reflog hook restores it.
    #[tokio::test]
    async fn listing_survives_a_failed_routing_read() {
        use super::{TestHook, LISTING_REFLOG_HOOK, LISTING_ROUTING_HOOK};
        let (_g, _base, repo) = copy_repo("list-routing").await;
        tracking_branch(&repo, "o1", "o1").await;
        run(&repo, &["branch", "-m", "o1", "n1"]).await;
        tracking_branch(&repo, "same", "same").await;
        let whole = git_branches(repo.clone()).await.unwrap();
        let config = std::path::Path::new(&repo).join(".git").join("config");
        let saved = std::fs::read(&config).unwrap();
        let file_hook = |bytes: Vec<u8>| -> TestHook {
            let config = config.clone();
            Arc::new(move || {
                let (config, bytes) = (config.clone(), bytes.clone());
                Box::pin(async move { std::fs::write(&config, bytes).unwrap() })
            })
        };
        let broken = [saved.as_slice(), b"[broken\n"].concat();
        let rows = LISTING_ROUTING_HOOK
            .scope(
                file_hook(broken),
                LISTING_REFLOG_HOOK.scope(file_hook(saved.clone()), git_branches(repo.clone())),
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(&config).unwrap(),
            saved,
            "the config restored"
        );
        let names = |rows: &[crate::git::types::Branch]| -> Vec<String> {
            rows.iter().map(|b| b.name.clone()).collect()
        };
        assert_eq!(names(&rows), names(&whole));
        let same = whole.iter().find(|b| b.name == "same").unwrap();
        assert_eq!(
            same.named_push_remote.as_deref(),
            Some("origin"),
            "read whole"
        );
        for row in &rows {
            let wire = serde_json::to_value(row).unwrap();
            assert_eq!(
                (
                    &wire["namedPushRemote"],
                    &wire["namedPushBranch"],
                    &wire["namedPushRefused"]
                ),
                (
                    &serde_json::Value::Null,
                    &serde_json::Value::Null,
                    &serde_json::Value::Bool(false)
                ),
                "{}",
                row.name
            );
        }
        let n1 = rows.iter().find(|b| b.name == "n1").unwrap();
        assert!(
            n1.renamed_from_upstream,
            "the reflog read ran on the restored config"
        );
    }

    // Full decision table for the create-branch argv: checkout × start_point ×
    // no_track (8 cases). The no_track=false rows are a regression guard — their argv
    // must not change.
    #[test]
    fn build_create_branch_args_checkout_no_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", true, None, false),
            vec!["switch", "-c", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_checkout_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", true, Some("main"), false),
            vec!["switch", "-c", "feat", "main"]
        );
    }

    #[test]
    fn build_create_branch_args_checkout_no_start_track_off() {
        assert_eq!(
            build_create_branch_args("feat", true, None, true),
            vec!["switch", "--no-track", "-c", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_checkout_remote_start_track_off() {
        // The motivating case: `git switch --no-track -c feat origin/epic/x`.
        assert_eq!(
            build_create_branch_args("feat", true, Some("origin/epic/x"), true),
            vec!["switch", "--no-track", "-c", "feat", "origin/epic/x"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_no_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", false, None, false),
            vec!["branch", "--", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", false, Some("main"), false),
            vec!["branch", "--", "feat", "main"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_no_start_track_off() {
        // `--no-track` must come BEFORE the `--`.
        assert_eq!(
            build_create_branch_args("feat", false, None, true),
            vec!["branch", "--no-track", "--", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_remote_start_track_off() {
        assert_eq!(
            build_create_branch_args("feat", false, Some("origin/epic/x"), true),
            vec!["branch", "--no-track", "--", "feat", "origin/epic/x"]
        );
    }

    #[test]
    fn validate_ref_name_rejects_glob_and_refspec_metacharacters() {
        // `*` would otherwise glob-match via `for-each-ref refs/heads/*` and
        // mirror-push every branch through a wildcard push refspec.
        for bad in ["*", "feat*", "a?b", "a[b", "a:b", "a\\b", "a b", "x\u{7f}"] {
            assert!(validate_ref_name(bad).is_err(), "should reject {bad:?}");
        }
        assert!(validate_ref_name("").is_err());
        assert!(validate_ref_name("-x").is_err());
    }

    #[test]
    fn validate_ref_name_accepts_names_and_rev_start_points() {
        // Real branch names AND rev-expression start points (this validator guards
        // git_create_branch's start_point too) must keep passing.
        for ok in [
            "feature", "feat/x", "origin/feat", "release-1.0",
            "main~3", "HEAD", "HEAD@{2}", "abc123def",
        ] {
            assert!(validate_ref_name(ok).is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn validate_branch_name_rejects_rev_expressions_ref_name_accepts() {
        // The whole point of the stricter gate: `~`/`^` shapes RESOLVE under
        // `rev-parse --verify refs/heads/…`, so an existence probe alone passes
        // them and the caller proceeds against an ancestor commit.
        // `@{-N}` is the Nth previous branch, which git expands into the name it mints.
        let bad_names = [
            "feature~1",
            "main^",
            "HEAD@{1}",
            "main..other",
            "a^{commit}",
            "@",
            "@{-1}",
            "@{-2}",
        ];
        for bad in bad_names {
            assert!(validate_ref_name(bad).is_ok(), "ref gate accepts {bad:?}");
            assert!(
                validate_branch_name(bad).is_err(),
                "branch gate should reject {bad:?}"
            );
        }
        // Refspec metacharacters stay rejected, and real branch names stay valid.
        assert!(validate_branch_name("a*b").is_err());
        for ok in ["feature", "feat/x", "release-1.0", "fix_123"] {
            assert!(validate_branch_name(ok).is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn parses_ahead_and_behind() {
        assert_eq!(parse_upstream_track("[ahead 1, behind 2]"), (1, 2, false));
    }

    #[test]
    fn parses_ahead_only() {
        assert_eq!(parse_upstream_track("[ahead 1]"), (1, 0, false));
    }

    #[test]
    fn parses_behind_only() {
        assert_eq!(parse_upstream_track("[behind 2]"), (0, 2, false));
    }

    #[test]
    fn gone_upstream_is_zero() {
        // `[gone]` reports the deleted-upstream bit with zeroed counts.
        assert_eq!(parse_upstream_track("[gone]"), (0, 0, true));
    }

    #[test]
    fn empty_or_unparseable_is_zero() {
        assert_eq!(parse_upstream_track(""), (0, 0, false));
        assert_eq!(parse_upstream_track("   "), (0, 0, false));
        assert_eq!(parse_upstream_track("garbage"), (0, 0, false));
    }

    // --- Real-repo test for the `--no-track` seam (temp_dir, git on PATH). ---

    async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, TEST_GIT_HANG_GUARD)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// A unique temp base dir for a test — the returned `TempDir` guard removes it
    /// on Drop, so a panicking or killed run cannot leak the fixture.
    fn temp_base(tag: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-branches-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    /// Whether a `git worktree list --porcelain` listing registers a worktree whose
    /// folder is named `folder`. Compares the last path component: the throwaway
    /// worktrees sit inside [`temp_base`]'s random dir, which can itself contain `folder`.
    fn worktree_listed(porcelain: &str, folder: &str) -> bool {
        crate::git::ops::parse_worktree_paths(porcelain)
            .iter()
            .any(|path| {
                std::path::Path::new(path).file_name() == Some(std::ffi::OsStr::new(folder))
            })
    }

    /// Asserts the listing registers the main checkout at `repo` but no worktree named
    /// `gone`. The positive arm proves the listing parsed, so the negative one tests
    /// something.
    fn assert_worktree_unregistered(porcelain: &str, repo: &std::path::Path, gone: &str) {
        let main = repo
            .file_name()
            .and_then(|name| name.to_str())
            .expect("the main checkout has a folder name");
        assert!(
            worktree_listed(porcelain, main),
            "the main checkout {main} is listed: {porcelain}"
        );
        assert!(
            !worktree_listed(porcelain, gone),
            "the throwaway worktree is unregistered: {porcelain}"
        );
    }

    #[test]
    fn worktree_listed_matches_the_folder_name_only() {
        let main_only = "worktree /tmp/gd-branches-update-deleted-base-wtX3Nv/repo\n\
                         HEAD 0123456789abcdef0123456789abcdef01234567\n\
                         branch refs/heads/main\n\n";
        assert!(worktree_listed(main_only, "repo"));
        assert!(!worktree_listed(main_only, "deleted-base-wt"));
        let with_wt = format!(
            "{main_only}worktree /tmp/gd-branches-update-deleted-base-wtX3Nv/deleted-base-wt/\n\
             HEAD 0123456789abcdef0123456789abcdef01234567\n\
             detached\n\n"
        );
        assert!(worktree_listed(&with_wt, "deleted-base-wt"));
        assert!(!worktree_listed(&with_wt, "base-wt"));
        // Windows `Path` also splits on a backslash.
        #[cfg(windows)]
        assert!(worktree_listed(
            "worktree C:\\t\\deleted-base-wt\n",
            "deleted-base-wt"
        ));
    }

    /// Pins the files ref backend: several tests read or write loose ref, reflog and
    /// lock files, which a machine default of `reftable` would not create.
    async fn init_repo(repo_s: &str, seed_file: &str) {
        run(repo_s, &["-c", "init.defaultRefFormat=files", "init", "-q"]).await;
        run(repo_s, &["config", "user.email", "t@t.local"]).await;
        run(repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(std::path::Path::new(repo_s).join(seed_file), "hello\n").unwrap();
        run(repo_s, &["add", "-A"]).await;
        run(repo_s, &["commit", "-qm", "seed"]).await;
    }

    #[test]
    fn session_branch_name_truth_table() {
        for name in ["gd/session/x", "GD/Session/x", "gd/SESSION/x", "Gd/session/"] {
            assert!(super::is_session_branch_name(name), "{name}");
            let err = super::refuse_session_branch_name(name).unwrap_err();
            assert!(
                matches!(err, AppError::InvalidArgument(message) if message == format!(
                    "\"{name}\" is in gd/session/, which is reserved for agent sessions — choose another name."
                ))
            );
        }
        for name in ["gd/sessions/x", "wip/gd/session/x", "feature/x", "gd/session"] {
            assert!(!super::is_session_branch_name(name), "{name}");
            assert!(super::refuse_session_branch_name(name).is_ok(), "{name}");
        }
    }

    #[tokio::test]
    async fn create_branch_refuses_session_branch_name_any_case() {
        for checkout in [false, true] {
            let (_base, base) = temp_base("create-session-branch-name");
            let repo = base.to_string_lossy().into_owned();
            init_repo(&repo, "r.txt").await;
            let before = run(&repo, &["for-each-ref", "refs/heads"]).await;
            let result = git_create_branch_core(
                &AppState::default(),
                repo.clone(),
                "GD/Session/x".into(),
                checkout,
                None,
                false,
            )
            .await;
            assert!(
                matches!(&result, Err(AppError::InvalidArgument(message)) if message ==
                    "\"GD/Session/x\" is in gd/session/, which is reserved for agent sessions — choose another name."),
                "{result:?}"
            );
            assert_eq!(run(&repo, &["for-each-ref", "refs/heads"]).await, before);
        }
    }

    #[tokio::test]
    async fn checkout_refuses_a_case_alias_of_a_session_branch_name() {
        let (_base, base) = temp_base("checkout-session-case-alias");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["update-ref", "refs/heads/gd/session/x", "HEAD"]).await;
        let head = run(&repo, &["symbolic-ref", "HEAD"]).await;
        // On a case-sensitive filesystem this is a passing control.
        let result = super::git_checkout_branch_core(
            &AppState::default(),
            repo.clone(),
            "GD/Session/x".into(),
        )
        .await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(message)) if message ==
                "\"GD/Session/x\" is in gd/session/, which is reserved for agent sessions — choose another name."),
            "expected session branch refusal, got {result:?}"
        );
        assert_eq!(run(&repo, &["symbolic-ref", "HEAD"]).await, head);
    }

    #[tokio::test]
    async fn checkout_switches_to_an_existing_session_branch_any_case() {
        for packed in [false, true] {
            let (_base, base) = temp_base("checkout-existing-session-branch");
            let repo = base.to_string_lossy().into_owned();
            init_repo(&repo, "r.txt").await;
            run(&repo, &["update-ref", "refs/heads/GD/Session/x", "HEAD"]).await;
            if packed {
                run(&repo, &["pack-refs", "--all"]).await;
            }
            super::git_checkout_branch_core(
                &AppState::default(),
                repo.clone(),
                "GD/Session/x".into(),
            )
            .await
            .expect("existing session branch remains reachable");
            assert_eq!(
                run(&repo, &["symbolic-ref", "HEAD"]).await.trim(),
                "refs/heads/GD/Session/x"
            );
        }
    }

    #[tokio::test]
    async fn checkout_refuses_guessing_a_session_branch_name_any_case() {
        let (_base, base) = temp_base("checkout-guess-session-branch-name");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["remote", "add", "origin", &repo]).await;
        run(&repo, &["update-ref", "refs/remotes/origin/GD/Session/x", "HEAD"]).await;
        let head = run(&repo, &["symbolic-ref", "HEAD"]).await;
        assert!(run(&repo, &["for-each-ref", "refs/heads/GD/Session/x"])
            .await
            .is_empty());
        let result = super::git_checkout_branch_core(
            &AppState::default(),
            repo.clone(),
            "GD/Session/x".into(),
        )
        .await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(message)) if message ==
                "\"GD/Session/x\" is in gd/session/, which is reserved for agent sessions — choose another name."),
            "expected session branch refusal, got {result:?}"
        );
        assert!(run(&repo, &["for-each-ref", "refs/heads/GD/Session/x"])
            .await
            .is_empty());
        assert_eq!(run(&repo, &["symbolic-ref", "HEAD"]).await, head);
    }

    #[tokio::test]
    async fn checkout_remote_refuses_session_branch_name_any_case() {
        let (_base, base) = temp_base("checkout-session-branch-name");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["remote", "add", "origin", &repo]).await;
        run(&repo, &["update-ref", "refs/remotes/origin/GD/Session/x", "HEAD"]).await;
        let head = run(&repo, &["symbolic-ref", "HEAD"]).await;
        let refs = run(&repo, &["for-each-ref", "refs/heads"]).await;
        let result = git_checkout_remote_branch_core(
            &AppState::default(),
            repo.clone(),
            "origin".into(),
            "GD/Session/x".into(),
        )
        .await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(message)) if message ==
                "\"GD/Session/x\" is in gd/session/, which is reserved for agent sessions — choose another name."),
            "{result:?}"
        );
        assert_eq!(run(&repo, &["symbolic-ref", "HEAD"]).await, head);
        assert_eq!(run(&repo, &["for-each-ref", "refs/heads"]).await, refs);
    }

    /// Drives `git_create_branch_core` against a real repo to prove git honors the
    /// `--no-track` placement the argv table pins. Synthesizes a remote-tracking ref
    /// (`refs/remotes/origin/x` via `update-ref`, so nothing is ever fetched) and bases
    /// two branches on it: the `no_track=true` arm must have NO upstream, the control
    /// arm must track `origin/x`. Both use `checkout=false` to keep assertions simple —
    /// the checkout arm shares the same `--no-track` placement per the argv table.
    #[tokio::test]
    async fn create_branch_honors_no_track_against_real_repo() {
        let (_base, base) = temp_base("no-track");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        // A remote named `origin` (URL is the repo's own path — never fetched) and
        // a synthetic remote-tracking ref pointing at HEAD.
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/x", "HEAD"]).await;

        let state = AppState::default();

        // no-track arm: branch `y` from `origin/x` with tracking suppressed.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "y".into(),
            false,
            Some("origin/x".into()),
            true,
        )
        .await
        .expect("create y succeeds");
        // No upstream → `y@{upstream}` fails to resolve.
        assert!(
            run_git(
                Some(&repo_s),
                &["rev-parse", "--abbrev-ref", "y@{upstream}"],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .is_err(),
            "no-track branch y must have no upstream"
        );
        // But it still starts at origin/x's tip.
        assert_eq!(
            run(&repo_s, &["rev-parse", "y"]).await.trim(),
            run(&repo_s, &["rev-parse", "origin/x"]).await.trim(),
            "y should start at origin/x"
        );

        // Pin the tracking mode repo-locally: an ambient global
        // `branch.autoSetupMerge = simple|false` leaves `z` untracked and false-fails
        // this control arm. The `--no-track` arm is immune — the flag overrides config.
        run(&repo_s, &["config", "branch.autoSetupMerge", "true"]).await;

        // control arm: branch `z` from `origin/x` with tracking left on.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "z".into(),
            false,
            Some("origin/x".into()),
            false,
        )
        .await
        .expect("create z succeeds");
        // Upstream resolves and IS origin/x.
        assert_eq!(
            run(&repo_s, &["rev-parse", "--abbrev-ref", "z@{upstream}"])
                .await
                .trim(),
            "origin/x",
            "z should track origin/x"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "z"]).await.trim(),
            run(&repo_s, &["rev-parse", "origin/x"]).await.trim(),
            "z should start at origin/x"
        );

        // A remote-tracking start point spelled as its full ref keeps the short form's
        // tip and tracking, and a LOCAL branch literally named `origin/x` can't
        // capture it.
        std::fs::write(repo.join("r.txt"), "moved\n").unwrap();
        run(&repo_s, &["commit", "-qam", "local work"]).await;
        run(&repo_s, &["branch", "origin/x"]).await;
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "w".into(),
            false,
            Some("refs/remotes/origin/x".into()),
            false,
        )
        .await
        .expect("create w succeeds");
        assert_eq!(
            run(
                &repo_s,
                &["rev-parse", "--symbolic-full-name", "w@{upstream}"]
            )
            .await
            .trim(),
            "refs/remotes/origin/x",
            "w should track origin/x"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/w"]).await,
            run(&repo_s, &["rev-parse", "refs/remotes/origin/x"]).await,
            "w should start at the remote-tracking ref, not the local origin/x"
        );

        // The local twin: `refs/heads/...` reads the branch even where a same-named
        // tag on another commit captures the short form.
        run(&repo_s, &["tag", "origin/x", "refs/remotes/origin/x"]).await;
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "v".into(),
            false,
            Some("refs/heads/origin/x".into()),
            false,
        )
        .await
        .expect("create v succeeds");
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/v"]).await,
            run(&repo_s, &["rev-parse", "refs/heads/origin/x"]).await,
            "v should start at the local branch, not the tag"
        );
        assert_ne!(
            run(&repo_s, &["rev-parse", "refs/heads/v"]).await,
            run(&repo_s, &["rev-parse", "refs/tags/origin/x"]).await,
            "fixture sanity: the tag sits on another commit"
        );
    }

    /// The destination derivation's arms: an explicit push ref, the upstream's own
    /// tracking ref, the standard same-name tracking ref, and everything that stays
    /// unresolved rather than naming a wrong branch.
    #[test]
    fn push_destination_arms() {
        let both = |r: &str, b: &str| (Some(r.to_string()), Some(b.to_string()));
        let none = (None, None);
        let up = "refs/remotes/origin/main";
        // (local, push remote, push remoteref, %(push), %(upstream), upstream remote,
        //  upstream remoteref) → destination
        let cases = [
            // A push remote with its own push refspecs sends them all, as configured:
            // no single destination describes that push.
            (
                (
                    "topic",
                    "origin",
                    "refs/heads/pushed/t",
                    "refs/remotes/origin/pushed/t",
                    up,
                    "origin",
                    "refs/heads/main",
                ),
                none.clone(),
            ),
            (
                (
                    "topic",
                    "origin",
                    "refs/tags/t",
                    "",
                    up,
                    "origin",
                    "refs/heads/main",
                ),
                none.clone(),
            ),
            // The upstream's own tracking ref on the same remote: the upstream branch.
            (
                ("topic", "origin", "", up, up, "origin", "refs/heads/main"),
                both("origin", "main"),
            ),
            // The upstream's tracking ref named for ANOTHER push remote (upstream
            // mode, triangular): git refuses that push.
            (
                ("topic", "second", "", up, up, "origin", "refs/heads/main"),
                none.clone(),
            ),
            // The standard same-name tracking ref.
            (
                (
                    "topic",
                    "origin",
                    "",
                    "refs/remotes/origin/topic",
                    up,
                    "origin",
                    "refs/heads/main",
                ),
                both("origin", "topic"),
            ),
            (
                (
                    "a/b",
                    "fork",
                    "",
                    "refs/remotes/fork/a/b",
                    up,
                    "origin",
                    "refs/heads/main",
                ),
                both("fork", "a/b"),
            ),
            // A remapped fetch refspec's tracking name is never read as the branch.
            (
                (
                    "topic",
                    "origin",
                    "",
                    "refs/remotes/origin/team/topic",
                    "refs/remotes/origin/team/main",
                    "origin",
                    "refs/heads/main",
                ),
                none.clone(),
            ),
            // Remapped, but the destination IS the upstream: read back through it.
            (
                (
                    "topic",
                    "origin",
                    "",
                    "refs/remotes/origin/team/main",
                    "refs/remotes/origin/team/main",
                    "origin",
                    "refs/heads/main",
                ),
                both("origin", "main"),
            ),
            // No destination (simple's cross-name refusal, nothing, a narrow fetch).
            (
                ("topic", "origin", "", "", up, "origin", "refs/heads/main"),
                none.clone(),
            ),
            // No remote, or a local one.
            (
                (
                    "topic",
                    "",
                    "",
                    "refs/remotes/origin/topic",
                    up,
                    "origin",
                    "refs/heads/main",
                ),
                none.clone(),
            ),
            (
                (
                    "topic",
                    ".",
                    "",
                    "refs/heads/main",
                    "",
                    ".",
                    "refs/heads/main",
                ),
                none.clone(),
            ),
            // An upstream that is no branch can't name the destination.
            (
                (
                    "topic",
                    "origin",
                    "",
                    "refs/remotes/origin/pr",
                    "refs/remotes/origin/pr",
                    "origin",
                    "refs/pull/1/head",
                ),
                none.clone(),
            ),
        ];
        for ((local, pr, prr, p, u, ur, urr), want) in cases {
            assert_eq!(
                push_destination(local, pr, prr, p, u, ur, urr),
                want,
                "{local} {pr} {prr} {p} {u}"
            );
        }
    }

    /// git's two real phrasings for a refused format atom (measured live below) are the
    /// retry's trigger; any other failure is not.
    #[test]
    fn unknown_format_atom_phrasings() {
        assert!(is_unknown_format_atom("fatal: unknown field name: pushx"));
        assert!(is_unknown_format_atom(
            "fatal: unrecognized %(push) argument: bogus"
        ));
        assert!(!is_unknown_format_atom("fatal: not a git repository"));
        assert!(!is_unknown_format_atom(
            "fatal: unrecognized %(upstream) argument: bogus"
        ));
    }

    #[test]
    fn upstream_atom_index_names_the_upstream_atom() {
        let atoms: Vec<&str> = PUSH_DESTINATION_ATOMS.split("%00").collect();
        assert_eq!(atoms.get(UPSTREAM_ATOM_INDEX), Some(&"%(upstream)"));
    }

    /// The retry-once, live, over the status read's own format: an extended format this
    /// git rejects (an unknown atom, and a known atom with an unknown argument) re-runs
    /// the base format, so the read still answers with the tracking fields and no push
    /// atoms. A failure of any other kind is an error, not a retry.
    #[tokio::test]
    async fn a_rejected_push_atom_falls_back_to_the_base_read() {
        use crate::git::remote::{parse_upstream_tracking, Upstream, UPSTREAM_TRACKING_FORMAT};
        let (_base, base) = temp_base("push-atom-retry");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        // A tracked branch, so the tracking fields have something to say.
        let main = run(&repo_s, &["symbolic-ref", "--short", "HEAD"])
            .await
            .trim()
            .to_string();
        let refname = run(&repo_s, &["symbolic-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        let tracking = format!("refs/remotes/origin/{main}");
        run(&repo_s, &["update-ref", &tracking, "HEAD"]).await;
        let upstream = format!("--set-upstream-to=origin/{main}");
        run(&repo_s, &["branch", "-q", &upstream]).await;
        // Pinned, so a global remote.pushDefault can't move the push remote read below.
        let push_remote = format!("branch.{main}.pushRemote");
        run(&repo_s, &["config", &push_remote, "origin"]).await;
        let fmt = UPSTREAM_TRACKING_FORMAT;
        let base_text = run(&repo_s, &["for-each-ref", &refname, fmt]).await;
        let tracked = Some((Upstream::Branch(main.clone()), "origin".to_string(), false));
        assert_eq!(parse_upstream_tracking(&base_text, &refname), tracked);
        for bogus in ["%(nosuchatom)", "%(push:bogus)"] {
            // The premise: git itself rejects it with a phrasing the matcher knows.
            let raw = run_git_raw(
                Some(&repo_s),
                &["for-each-ref", &refname, &format!("--format={bogus}")],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
            assert_ne!(raw.code, 0, "{bogus}");
            assert!(
                is_unknown_format_atom(&raw.stderr),
                "{bogus}: {}",
                raw.stderr
            );
            let extended = format!("{fmt}%00{bogus}");
            let text = read_refs_with_fallback(&repo_s, &refname, &extended, fmt)
                .await
                .expect("the fallback answers");
            assert_eq!(text, base_text, "{bogus}");
            assert_eq!(parse_upstream_tracking(&text, &refname), tracked, "{bogus}");
        }
        // The real extended read answers with the atoms on this git: the tracking
        // fields unchanged, the push remote after them.
        let text = read_refs_with_push_destination(&repo_s, &refname, fmt)
            .await
            .unwrap();
        assert_eq!(parse_upstream_tracking(&text, &refname), tracked);
        let line = text.lines().next().unwrap();
        // The base format's fields plus the push atoms, whatever their values.
        let base_fields = crate::git::remote::UPSTREAM_TRACKING_FIELDS;
        let push_atoms = PUSH_DESTINATION_ATOMS.split("%00").count();
        assert_eq!(
            line.split('\0').count(),
            base_fields + push_atoms,
            "{line:?}"
        );
        assert_eq!(
            line.split('\0').nth(base_fields),
            Some("origin"),
            "{line:?}"
        );
        // Not a format refusal: no retry, an error.
        let missing = base.join("not-a-repo");
        std::fs::create_dir_all(&missing).unwrap();
        read_refs_with_push_destination(&missing.to_string_lossy(), &refname, fmt)
            .await
            .expect_err("a broken repository is an error");
    }

    /// `git_branches` must surface git's authoritative `%(upstream:remotename)`
    /// on each branch: a tracked branch carries its remote, an untracked one
    /// carries none. This is the single source of truth the UI reads instead of
    /// re-deriving the remote from the upstream string.
    #[tokio::test]
    async fn git_branches_reports_upstream_remote() {
        let (_base, base) = temp_base("upstream-remote");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        // A remote named `origin` (URL is the repo's own path — never fetched) and
        // a synthetic remote-tracking ref pointing at HEAD.
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/x", "HEAD"]).await;

        let state = AppState::default();
        // Pin tracking mode repo-locally so an ambient global
        // `branch.autoSetupMerge = simple|false` can't leave `tracked` untracked.
        run(&repo_s, &["config", "branch.autoSetupMerge", "true"]).await;
        // Tracked branch `tracked` → tracks origin/x.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "tracked".into(),
            false,
            Some("origin/x".into()),
            false,
        )
        .await
        .expect("create tracked succeeds");
        // Untracked branch `solo` → based on the same ref with tracking suppressed.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "solo".into(),
            false,
            Some("origin/x".into()),
            true,
        )
        .await
        .expect("create solo succeeds");

        let branches = git_branches(repo_s.clone()).await.expect("list branches");
        let tracked = branches
            .iter()
            .find(|b| b.name == "tracked")
            .expect("tracked branch present");
        assert_eq!(
            tracked.upstream_remote.as_deref(),
            Some("origin"),
            "a tracked branch carries its upstream's remote"
        );
        let solo = branches
            .iter()
            .find(|b| b.name == "solo")
            .expect("solo branch present");
        assert_eq!(
            solo.upstream_remote, None,
            "an untracked branch carries no upstream remote"
        );
    }

    /// Every row names its branch exactly, however git would shorten it: a branch
    /// shadowed by a same-named tag, and one whose `heads/<name>` is itself taken by a
    /// branch (git then answers the full ref). The archive flag, keyed by name, follows.
    #[tokio::test]
    async fn git_branches_names_branches_shadowed_by_tags() {
        let (_base, base) = temp_base("list-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "shadowed"]).await;
        run(&repo_s, &["tag", "shadowed"]).await;
        run(&repo_s, &["branch", "ambiguous"]).await;
        run(&repo_s, &["tag", "ambiguous"]).await;
        run(&repo_s, &["branch", "heads/ambiguous"]).await;
        set_branch_archived_core(&repo_s, "shadowed", true)
            .await
            .expect("archive shadowed");

        let branches = git_branches(repo_s.clone()).await.expect("list branches");
        let mut names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        names.sort_unstable();
        assert!(
            names.contains(&"shadowed")
                && names.contains(&"ambiguous")
                && names.contains(&"heads/ambiguous"),
            "{names:?}"
        );
        assert!(
            !names
                .iter()
                .any(|n| *n == "heads/shadowed" || n.starts_with("refs/")),
            "{names:?}"
        );
        let shadowed = branches.iter().find(|b| b.name == "shadowed").unwrap();
        assert!(
            shadowed.archived,
            "the archive flag is keyed by the real name"
        );
    }

    /// A remote-tracking ref shortened past `<remote>/<branch>` by a tag named
    /// `origin/main` still splits into that remote and branch, and the remote's
    /// symbolic HEAD stays out of the list.
    #[tokio::test]
    async fn git_remote_branches_split_refs_shadowed_by_a_tag() {
        let (_base, base) = temp_base("remote-list-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        run(
            &repo_s,
            &["update-ref", "refs/remotes/origin/feat/x", "HEAD"],
        )
        .await;
        run(
            &repo_s,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        )
        .await;
        run(&repo_s, &["tag", "origin/main"]).await;

        let rows = super::git_remote_branches(repo_s.clone())
            .await
            .expect("list remote branches");
        let mut pairs: Vec<(String, String)> =
            rows.into_iter().map(|b| (b.remote, b.name)).collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("origin".to_string(), "feat/x".to_string()),
                ("origin".to_string(), "main".to_string()),
            ]
        );
    }

    /// The split takes the longest configured remote followed by `/`, whatever the
    /// list's order, and falls back to the first `/` (the rule Compare's
    /// `splitRemoteDisplay` applies).
    #[test]
    fn split_remote_tracking_takes_the_longest_configured_remote() {
        type Case<'a> = (&'a str, &'a [String], Option<(&'a str, &'a str)>);
        let list = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let slash_remote = list(&["origin", "team/fork"]);
        let longer_first = list(&["team/fork", "team"]);
        let shorter_first = list(&["team", "team/fork"]);
        let only_slash = list(&["team/fork"]);
        let cases: &[Case] = &[
            ("origin/main", &slash_remote, Some(("origin", "main"))),
            ("origin/feat/x", &slash_remote, Some(("origin", "feat/x"))),
            ("team/fork/Feat", &slash_remote, Some(("team/fork", "Feat"))),
            (
                "team/fork/gd/session/abc",
                &slash_remote,
                Some(("team/fork", "gd/session/abc")),
            ),
            ("ghost/x/y", &slash_remote, Some(("ghost", "x/y"))),
            ("team/fork/x", &shorter_first, Some(("team/fork", "x"))),
            ("team/other", &shorter_first, Some(("team", "other"))),
            ("team/fork/x", &longer_first, Some(("team/fork", "x"))),
            ("team/other", &longer_first, Some(("team", "other"))),
            ("team/fork", &only_slash, Some(("team", "fork"))),
            ("lonely", &slash_remote, None),
        ];
        for (rest, remotes, want) in cases {
            assert_eq!(
                super::split_remote_tracking(rest, remotes),
                *want,
                "{rest} against {remotes:?}"
            );
        }
    }

    /// A remote whose name holds `/` lists its branches under its whole name, its
    /// session branches keep their full `gd/session/*` name, and its symbolic HEAD
    /// stays out of the list.
    #[tokio::test]
    async fn git_remote_branches_split_at_a_slash_named_remote() {
        let (_base, base) = temp_base("remote-list-slash-remote");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["remote", "add", "team/fork", &repo_s]).await;
        for refname in [
            "refs/remotes/origin/main",
            "refs/remotes/team/fork/Feat",
            "refs/remotes/team/fork/gd/session/abc",
        ] {
            run(&repo_s, &["update-ref", refname, "HEAD"]).await;
        }
        run(
            &repo_s,
            &[
                "symbolic-ref",
                "refs/remotes/team/fork/HEAD",
                "refs/remotes/team/fork/Feat",
            ],
        )
        .await;

        let rows = super::git_remote_branches(repo_s.clone())
            .await
            .expect("list remote branches");
        let mut pairs: Vec<(String, String)> =
            rows.into_iter().map(|b| (b.remote, b.name)).collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("origin".to_string(), "main".to_string()),
                ("team/fork".to_string(), "Feat".to_string()),
                ("team/fork".to_string(), "gd/session/abc".to_string()),
            ]
        );
    }

    /// The tracking checkout starts from the remote-tracking ref itself: a tag named
    /// `origin/<branch>` makes the bare `origin/<branch>` ambiguous, and git refuses it.
    #[tokio::test]
    async fn checkout_remote_branch_tracks_the_remote_ref_shadowed_by_a_tag() {
        let (_base, base) = temp_base("checkout-remote-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        // The tag sits on the seed commit, the remote branch one commit past it.
        run(&repo_s, &["tag", "origin/landing"]).await;
        std::fs::write(repo.join("r.txt"), "remote\n").unwrap();
        run(&repo_s, &["commit", "-qam", "remote work"]).await;
        run(
            &repo_s,
            &["update-ref", "refs/remotes/origin/landing", "HEAD"],
        )
        .await;
        run(&repo_s, &["reset", "-q", "--hard", "HEAD~1"]).await;

        let state = AppState::default();
        git_checkout_remote_branch_core(&state, repo_s.clone(), "origin".into(), "landing".into())
            .await
            .expect("the tracking checkout succeeds");
        assert_eq!(
            run(&repo_s, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/landing"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/landing"]).await,
            run(&repo_s, &["rev-parse", "refs/remotes/origin/landing"]).await,
            "the branch starts at the remote ref, never the tag"
        );
        assert_eq!(
            tracking_of(&repo_s, "landing").await,
            (Some("origin".into()), Some("refs/heads/landing".into()))
        );
    }

    fn branch_divergence_tuples(rows: &[super::BranchDivergence]) -> Vec<(String, u32, u32)> {
        rows.iter()
            .map(|d| (d.name.clone(), d.ahead, d.behind))
            .collect()
    }

    #[test]
    fn branch_divergence_parses_ahead_behind() {
        let Some(rows) = super::parse_ahead_behind(
            "base",
            "refs/heads/x 3 5\n\nrefs/heads/base 7 9\nrefs/heads/feat/x 0 0\n",
        ) else {
            panic!("valid ahead/behind rows must parse");
        };
        assert_eq!(
            branch_divergence_tuples(&rows),
            vec![
                ("x".to_string(), 3, 5),
                ("base".to_string(), 0, 0),
                ("feat/x".to_string(), 0, 0),
            ]
        );
        assert!(super::parse_ahead_behind("base", "").is_some_and(|rows| rows.is_empty()));
    }

    #[test]
    fn branch_divergence_preserves_non_ascii_whitespace_in_names() {
        let Some(rows) = super::parse_ahead_behind(
            "base",
            "refs/heads/nb\u{a0}sp 3 5\nrefs/heads/tr\u{a0} 7 9\n",
        ) else {
            panic!("branch names with non-ASCII whitespace must parse");
        };
        assert_eq!(
            branch_divergence_tuples(&rows),
            vec![
                ("nb\u{a0}sp".to_string(), 3, 5),
                ("tr\u{a0}".to_string(), 7, 9)
            ]
        );
    }

    #[test]
    fn branch_divergence_rejects_malformed_ahead_behind() {
        for invalid in [
            "refs/heads/x 3",
            "refs/heads/x 3 5 extra",
            "refs/heads/x 3 5 7",
            "refs/heads/x nope 5",
            "refs/heads/x 3 nope",
            "refs/tags/x 3 5",
            "refs/heads/ 3 5",
            "refs/heads/x 4294967296 5",
            "refs/heads/x 3 4294967296",
            "refs/heads/base nope 5",
        ] {
            let stdout = format!("refs/heads/valid 1 2\n{invalid}\n");
            assert!(
                super::parse_ahead_behind("base", &stdout).is_none(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn branch_divergence_parses_git_version() {
        for (stdout, expected) in [
            ("git version 2.51.1.windows.1\n", Some((2, 51))),
            ("git version 2.39.5 (Apple Git-154)", Some((2, 39))),
            ("git version 2.40.0.123.gabc", Some((2, 40))),
            ("git version 2.41.0", Some((2, 41))),
            ("", None),
            ("not git", None),
        ] {
            assert_eq!(super::parse_git_version(stdout), expected, "{stdout}");
        }
    }

    #[tokio::test]
    async fn branch_divergence_single_spawn_matches_per_branch() -> super::AppResult<()> {
        let (_dir, path) = temp_base("divergence-single-spawn");
        let repo = path.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["branch", "-m", "base"]).await;
        run(&repo, &["branch", "behind"]).await;
        run(&repo, &["branch", "diverged"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "base one"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "base two"]).await;
        run(&repo, &["branch", "at-tip"]).await;
        run(&repo, &["switch", "-qc", "ahead"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "ahead work"]).await;
        run(&repo, &["branch", "feat/x"]).await;
        run(&repo, &["switch", "-q", "diverged"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "diverged work"]).await;

        let expected = vec![
            ("ahead".to_string(), 1, 0),
            ("at-tip".to_string(), 0, 0),
            ("base".to_string(), 0, 0),
            ("behind".to_string(), 0, 2),
            ("diverged".to_string(), 1, 2),
            ("feat/x".to_string(), 1, 0),
        ];
        let base_rev = super::branch_first_rev(&repo, "base").await;
        let fallback = super::divergence_per_branch(&repo, "base", &base_rev).await?;
        let rows = super::git_branch_divergence(repo.clone(), "base".into()).await?;
        assert_eq!(
            branch_divergence_tuples(&rows),
            branch_divergence_tuples(&fallback)
        );
        assert_eq!(branch_divergence_tuples(&fallback), expected);

        if super::ahead_behind_supported().await {
            let fast = super::divergence_single_spawn(&repo, "base", &base_rev).await?;
            assert!(
                fast.is_some(),
                "supported git must use the single-spawn path"
            );
            if let Some(rows) = fast {
                assert_eq!(branch_divergence_tuples(&rows), expected);
            }
        }
        Ok(())
    }

    #[tokio::test]
    async fn branch_divergence_unresolvable_base_falls_back_to_all_zero() -> super::AppResult<()> {
        let (_dir, path) = temp_base("divergence-missing-base");
        let repo = path.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["branch", "-m", "base"]).await;
        run(&repo, &["branch", "sibling"]).await;

        let base = "missing-base";
        super::validate_ref_name(base)?;
        let base_rev = super::branch_first_rev(&repo, base).await;
        assert!(super::divergence_single_spawn(&repo, base, &base_rev)
            .await?
            .is_none());
        let rows = super::git_branch_divergence(repo, base.into()).await?;
        assert_eq!(
            branch_divergence_tuples(&rows),
            vec![("base".to_string(), 0, 0), ("sibling".to_string(), 0, 0)]
        );
        Ok(())
    }

    #[tokio::test]
    async fn branch_divergence_percent_base_refuses_fast_path() -> super::AppResult<()> {
        let (_dir, path) = temp_base("divergence-percent-base");
        let repo = path.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        let base = "odd%base";
        run(&repo, &["branch", "-m", base]).await;
        run(&repo, &["branch", "sibling"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "base one"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "base two"]).await;
        run(&repo, &["switch", "-q", "sibling"]).await;
        run(&repo, &["commit", "--allow-empty", "-qm", "sibling work"]).await;

        super::validate_ref_name(base)?;
        let base_rev = super::branch_first_rev(&repo, base).await;
        assert!(super::divergence_single_spawn(&repo, base, &base_rev)
            .await?
            .is_none());
        let fallback = super::divergence_per_branch(&repo, base, &base_rev).await?;
        let rows = super::git_branch_divergence(repo, base.into()).await?;
        assert_eq!(
            branch_divergence_tuples(&rows),
            branch_divergence_tuples(&fallback)
        );
        assert_eq!(
            branch_divergence_tuples(&fallback),
            vec![
                ("odd%base".to_string(), 0, 0),
                ("sibling".to_string(), 1, 2)
            ]
        );
        Ok(())
    }

    #[tokio::test]
    async fn branch_divergence_empty_repo_reports_no_rows() -> super::AppResult<()> {
        let (_dir, path) = temp_base("divergence-empty-repo");
        let repo = path.to_string_lossy().into_owned();
        run(&repo, &["init", "-q"]).await;
        let rows = super::git_branch_divergence(repo, "base".into()).await?;
        assert!(rows.is_empty());
        Ok(())
    }

    /// Rows are named by the real branch and measured through its full ref, and the
    /// base is read as a branch too: a bare `feature` or base name would resolve to the
    /// same-named tag (gitrevisions checks tags first) and report the tag's counts.
    #[tokio::test]
    async fn branch_divergence_names_and_measures_branches_shadowed_by_tags() {
        let (_base, base) = temp_base("divergence-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        // Both tags stay on the seed while both branches move past it.
        run(&repo_s, &["tag", &main]).await;
        run(&repo_s, &["switch", "-qc", "feature"]).await;
        run(&repo_s, &["tag", "feature"]).await;
        std::fs::write(repo.join("f.txt"), "f\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "feature work"]).await;
        run(&repo_s, &["switch", "-q", &main]).await;
        std::fs::write(repo.join("m.txt"), "m\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "base work"]).await;

        let rows = super::git_branch_divergence(repo_s.clone(), main.clone())
            .await
            .expect("measure divergence");
        let mut got: Vec<(String, u32, u32)> = rows
            .into_iter()
            .map(|d| (d.name, d.ahead, d.behind))
            .collect();
        got.sort();
        let mut want = vec![("feature".to_string(), 1, 1), (main.clone(), 0, 0)];
        want.sort();
        assert_eq!(got, want);
    }

    /// `git clone -o upstream` writes `refs/remotes/upstream/HEAD` and no origin ref
    /// at all, so resolution has to consult whatever remotes the repo actually has.
    /// The source branch is named `trunk` — a name the local main/master fallback
    /// can never produce, so only the remote HEAD can satisfy this.
    #[tokio::test]
    async fn default_branch_resolves_a_clone_whose_remote_isnt_origin() {
        let (_base, base) = temp_base("default-branch-upstream");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let src_s = src.to_string_lossy().into_owned();
        init_repo(&src_s, "r.txt").await;
        run(&src_s, &["branch", "-m", "trunk"]).await;

        let clone_s = base.join("clone").to_string_lossy().into_owned();
        run_git(
            None,
            &["clone", "-q", "-o", "upstream", &src_s, &clone_s],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .expect("local clone succeeds");

        assert_eq!(
            git_default_branch(clone_s).await.expect("resolves"),
            Some("trunk".to_string()),
            "the only remote's HEAD answers even when it isn't named origin"
        );
    }

    /// With several remotes, origin still wins — it is tried before the others
    /// regardless of where `git remote` lists it.
    #[tokio::test]
    async fn default_branch_prefers_origin_over_other_remotes() {
        let (_base, base) = temp_base("default-branch-origin-wins");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        // URLs are the repo's own path — nothing is ever fetched; the HEAD symrefs
        // are written by hand, exactly as a clone would leave them. `canonical` sorts
        // before `origin`, so it is the remote a naive "first listed wins" would pick.
        for remote in ["canonical", "origin"] {
            run(&repo_s, &["remote", "add", remote, &repo_s]).await;
            let head = format!("refs/remotes/{remote}/{remote}-head");
            run(&repo_s, &["update-ref", &head, "HEAD"]).await;
            run(
                &repo_s,
                &[
                    "symbolic-ref",
                    &format!("refs/remotes/{remote}/HEAD"),
                    &head,
                ],
            )
            .await;
        }
        assert!(
            run(&repo_s, &["remote"])
                .await
                .trim()
                .starts_with("canonical"),
            "fixture must list a non-origin remote first for this to discriminate"
        );

        assert_eq!(
            git_default_branch(repo_s).await.expect("resolves"),
            Some("origin-head".to_string()),
            "origin's HEAD wins over another remote's"
        );
    }

    /// No remote HEAD to read: local `main`/`master` answer, anything else is `None`.
    /// A remote whose HEAD symref was never written (a hand-added one) must fall
    /// through here rather than reaching for the network.
    #[tokio::test]
    async fn default_branch_falls_back_to_local_names() {
        let (_base, base) = temp_base("default-branch-fallback");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "-m", "master"]).await;
        assert_eq!(
            git_default_branch(repo_s.clone()).await.expect("resolves"),
            Some("master".to_string()),
            "a remote-less repo falls back to its local master"
        );

        run(&repo_s, &["remote", "add", "upstream", &repo_s]).await;
        run(&repo_s, &["branch", "-m", "topic"]).await;
        assert_eq!(
            git_default_branch(repo_s).await.expect("resolves"),
            None,
            "a remote with no HEAD symref and no main/master resolves to nothing"
        );
    }

    /// "Update from main" on the branch you are ON merges in place, so a conflict
    /// is a PAUSED merge in the user's own checkout — the app has to hand back
    /// git's CONFLICT list and leave the tree mid-merge for the banner to drive.
    /// The conflicted merge writes all of that to stdout with stderr EMPTY, which
    /// is what a stderr-only error turned into "git exited with code 1".
    #[tokio::test]
    async fn update_branch_from_in_place_conflict_names_the_paused_merge() {
        let (_base, base) = temp_base("update-in-place-conflict");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;

        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["switch", "-qc", "feature"]).await;
        std::fs::write(repo.join("a.txt"), "feature-side\n").unwrap();
        run(&repo_s, &["commit", "-qam", "feature edit"]).await;
        run(&repo_s, &["switch", "-q", &main]).await;
        std::fs::write(repo.join("a.txt"), "main-side\n").unwrap();
        run(&repo_s, &["commit", "-qam", "main edit"]).await;

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, &main, "feature", &HashSet::new(), None)
            .await
            .unwrap_err();
        let AppError::Conflict { op, paths, report } = &err else {
            panic!("expected a conflict error, got {err:?}");
        };
        assert_eq!(op, "merge");
        assert_eq!(paths, &vec!["a.txt".to_string()]);
        assert!(
            report.contains("CONFLICT (content): Merge conflict in a.txt"),
            "git's conflict list must survive: {report}"
        );
        assert!(
            crate::git::ops::op_state(&repo_s).await.unwrap().merging,
            "the merge is left in progress for the conflict banner to finish"
        );
    }

    /// End-to-end: a real `branch -m` through the core carries the branch's reviewer
    /// note to the new name. Both the deposit and the assertion go through
    /// `review_notes::store_path`, whose cfg(test) arm keeps them off the developer's
    /// real store; the identity key is this fixture's own git dir, so the shared test
    /// store file can't collide with another test's entries.
    // Every test that reaches the rename core holds the local-PR store's serializing guard
    // across its awaits: the core's lock file and moves resolve through that store's
    // process-wide override (each `#[tokio::test]` owns a current-thread runtime).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn rename_carries_the_reviewer_note_to_the_new_branch() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_base, base) = temp_base("rename-review-note");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        // Branch names no other test uses: the marker root override is process-wide.
        run(&repo_s, &["branch", "rename-note-src"]).await;

        let identity = crate::git::repo::repo_identity(&repo_s).await.unwrap();
        crate::review_notes::set(&identity, "rename-note-src", "look at the migration")
            .await
            .expect("deposit the note");

        let state = AppState::default();
        git_rename_branch_core(
            &state,
            repo_s.clone(),
            "rename-note-src".into(),
            "rename-note-dst".into(),
        )
        .await
        .expect("rename succeeds");

        assert!(
            run(&repo_s, &["branch", "--list", "rename-note-dst"])
                .await
                .contains("rename-note-dst"),
            "the branch itself was renamed"
        );
        assert_eq!(
            crate::review_notes::note_body(&identity, "rename-note-dst").as_deref(),
            Some("look at the migration"),
            "the note reads back under the new name"
        );
        assert_eq!(
            crate::review_notes::note_body(&identity, "rename-note-src"),
            None,
            "and is gone under the old one"
        );
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn rename_succeeds_without_migrating_notes_when_identity_is_unavailable() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let (_base, base) = temp_base("rename-identity-error");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        // Branch names no other test uses: the marker root override is process-wide.
        run(&repo, &["branch", "rename-identity-src"]).await;
        let identity = crate::git::repo::repo_identity(&repo).await.unwrap();
        crate::review_notes::set(&identity, "rename-identity-src", "keep this note")
            .await
            .unwrap();
        let state = AppState::default();
        crate::git::repo::TEST_IDENTITY_ERROR
            .scope(
                || AppError::Timeout(30),
                git_rename_branch_core(
                    &state,
                    repo.clone(),
                    "rename-identity-src".into(),
                    "rename-identity-dst".into(),
                ),
            )
            .await
            .expect("identity failure does not turn a completed rename into an error");
        assert!(run(&repo, &["branch", "--list", "rename-identity-dst"])
            .await
            .contains("rename-identity-dst"));
        assert!(run(&repo, &["branch", "--list", "rename-identity-src"])
            .await
            .trim()
            .is_empty());
        assert_eq!(
            crate::review_notes::note_body(&identity, "rename-identity-src").as_deref(),
            Some("keep this note")
        );
        assert_eq!(
            crate::review_notes::note_body(&identity, "rename-identity-dst"),
            None
        );
        assert_eq!(
            crate::review_notes::note_body(&repo, "rename-identity-dst"),
            None
        );
    }

    /// Both directions refused, any case, the old name first; ordinary names pass.
    #[test]
    fn rename_refuses_the_agent_session_namespace_both_ways() {
        let refusal = |old: &str, new: &str| match refuse_session_rename(old, new) {
            Err(AppError::InvalidArgument(m)) => m,
            other => panic!("{old} -> {new}: expected a refusal, got {other:?}"),
        };
        assert_eq!(
            refusal("gd/session/abc", "feature"),
            "\"gd/session/abc\" is an agent-session branch — renaming it would break its session's Resume."
        );
        assert_eq!(
            refusal("feature", "gd/session/abc"),
            "\"gd/session/abc\" is in gd/session/, which is reserved for agent sessions — choose another name."
        );
        assert_eq!(
            refusal("feature", "GD/Session/x"),
            "\"GD/Session/x\" is in gd/session/, which is reserved for agent sessions — choose another name."
        );
        assert!(refusal("Gd/SESSION/a", "gd/session/b")
            .starts_with("\"Gd/SESSION/a\" is an agent-session"));
        for (old, new) in [
            ("feature", "renamed"),
            ("gd/sessions/x", "gd/session"),
            ("feat/x", "feat/y"),
        ] {
            assert!(refuse_session_rename(old, new).is_ok(), "{old} -> {new}");
        }
    }

    /// The guard runs before git: a refused rename leaves the branch where it was.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_session_rename_is_refused_before_git_runs() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let (_base, base) = temp_base("rename-session");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "feature"]).await;
        let state = AppState::default();
        let err = git_rename_branch_core(
            &state,
            repo_s.clone(),
            "feature".into(),
            "GD/Session/x".into(),
        )
        .await
        .expect_err("renaming into the namespace is refused");
        assert!(matches!(err, AppError::InvalidArgument(_)), "{err:?}");
        assert!(run(&repo_s, &["branch", "--list", "feature"])
            .await
            .contains("feature"));
    }

    #[test]
    fn rename_outcome_serializes_its_warning_in_camel_case() {
        let some = RenameBranchOutcome {
            warning: Some("Some local pull requests may still point at feat/x.".into()),
        };
        assert_eq!(
            serde_json::to_string(&some).unwrap(),
            r#"{"warning":"Some local pull requests may still point at feat/x."}"#
        );
        let none = RenameBranchOutcome { warning: None };
        assert_eq!(serde_json::to_string(&none).unwrap(), r#"{"warning":null}"#);
    }

    /// Open local PRs follow a real rename through the core; closed ones and the reply's
    /// warning stay as they were.
    // The serializing guard spans the awaits on purpose — it keeps the store override
    // installed for the whole body (each `#[tokio::test]` owns a current-thread runtime).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn rename_carries_open_local_prs_to_the_new_branch() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_base, base) = temp_base("rename-local-prs");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "feat/x"]).await;
        let identity = crate::git::repo::repo_identity(&repo_s).await.unwrap();
        let open = crate::local_prs::create(&identity, "Open", "", "main", "feat/x")
            .await
            .unwrap();
        let closed = crate::local_prs::create(&identity, "Closed", "", "main", "feat/x")
            .await
            .unwrap();
        let (open_id, closed_id) = (
            open["id"].as_str().unwrap().to_string(),
            closed["id"].as_str().unwrap().to_string(),
        );
        crate::local_prs::set_status(&identity, &closed_id, "closed")
            .await
            .unwrap();

        let state = AppState::default();
        let outcome =
            git_rename_branch_core(&state, repo_s.clone(), "feat/x".into(), "feat/y".into())
                .await
                .expect("rename succeeds");
        assert_eq!(outcome.warning, None);
        assert_eq!(
            crate::local_prs::get(&identity, &open_id).unwrap()["head"],
            "feat/y"
        );
        assert_eq!(
            crate::local_prs::get(&identity, &closed_id).unwrap()["head"],
            "feat/x"
        );
    }

    /// A migration that cannot run never fails the completed rename; it rides back as the
    /// warning both surfaces show.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_failed_local_pr_migration_returns_the_warning() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let (_base, base) = temp_base("rename-local-prs-fail");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "feat/x"]).await;
        let state = AppState::default();
        let outcome = crate::git::repo::TEST_IDENTITY_ERROR
            .scope(
                || AppError::Timeout(30),
                git_rename_branch_core(&state, repo_s.clone(), "feat/x".into(), "feat/y".into()),
            )
            .await
            .expect("the rename itself succeeds");
        assert_eq!(
            outcome.warning.as_deref(),
            Some("Some local pull requests may still point at feat/x.")
        );
        assert!(run(&repo_s, &["branch", "--list", "feat/y"])
            .await
            .contains("feat/y"));
    }

    /// A hook that, at `at`, signals `reached` and then waits (bounded) for `released`:
    /// a second rename racing unserialized finishes inside that window, a serialized one
    /// cannot start its git step until the held rename has released its rename lock.
    fn hold_rename_at(
        at: RenamePhase,
        reached: Arc<tokio::sync::Notify>,
        released: Arc<tokio::sync::Notify>,
    ) -> RenamePhaseHook {
        Arc::new(move |phase| {
            let (reached, released) = (reached.clone(), released.clone());
            Box::pin(async move {
                if phase == at {
                    reached.notify_one();
                    let _ = tokio::time::timeout(Duration::from_secs(1), released.notified()).await;
                }
            })
        })
    }

    /// Renames `a → b` held at `at`, starts `b → c` once it is held there, and asserts the
    /// chain lands whole: the branch, its open local PR, and its reviewer note all on `c`.
    /// The caller holds the local-PR store override.
    async fn assert_chained_renames_serialize(at: RenamePhase, tag: &str) {
        let (_base, base) = temp_base(tag);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "a"]).await;
        let identity = crate::git::repo::repo_identity(&repo_s).await.unwrap();
        let pr = crate::local_prs::create(&identity, "Chained", "", "main", "a")
            .await
            .unwrap();
        let pr_id = pr["id"].as_str().unwrap().to_string();
        crate::review_notes::set(&identity, "a", "follow the chain")
            .await
            .unwrap();

        let reached = Arc::new(tokio::sync::Notify::new());
        let released = Arc::new(tokio::sync::Notify::new());
        let state = AppState::default();
        let first = RENAME_PHASE_HOOK.scope(
            hold_rename_at(at, reached.clone(), released.clone()),
            git_rename_branch_core(&state, repo_s.clone(), "a".into(), "b".into()),
        );
        let second = async {
            reached.notified().await;
            let out = git_rename_branch_core(&state, repo_s.clone(), "b".into(), "c".into()).await;
            released.notify_one();
            out
        };
        let (first, second) =
            tokio::time::timeout(TEST_GIT_HANG_GUARD, async { tokio::join!(first, second) })
                .await
                .expect("neither rename deadlocks");
        first.expect("a -> b succeeds");
        second.expect("b -> c succeeds once a -> b is done");

        assert!(run(&repo_s, &["branch", "--list", "c"]).await.contains('c'));
        assert!(run(&repo_s, &["branch", "--list", "a", "b"])
            .await
            .trim()
            .is_empty());
        assert_eq!(
            crate::local_prs::get(&identity, &pr_id).unwrap()["head"],
            "c",
            "the local PR follows the whole chain"
        );
        assert_eq!(
            crate::review_notes::note_body(&identity, "c").as_deref(),
            Some("follow the chain")
        );
        assert_eq!(crate::review_notes::note_body(&identity, "b"), None);
        assert_eq!(crate::review_notes::note_body(&identity, "a"), None);
    }

    /// The second rename starts in the first one's gap (git done, moves pending): its
    /// git step must wait, or its moves find nothing under `b` and the first's land on a
    /// name that no longer exists.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_rename_started_in_anothers_gap_waits_for_its_moves() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        assert_chained_renames_serialize(RenamePhase::BeforeMoves, "rename-chain-gap").await;
    }

    /// The second rename starts while the first holds the rename lock but has not run git:
    /// it must queue behind the whole first rename, not race its git step.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_rename_started_before_anothers_git_step_queues_behind_it() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        assert_chained_renames_serialize(RenamePhase::BeforeGit, "rename-chain-pre-git").await;
    }

    /// A repo holding branch `feat/x`, for the rename-lock tests below.
    async fn repo_with_feat_x(tag: &str) -> (tempfile::TempDir, String) {
        let (base_dir, base) = temp_base(tag);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "feat/x"]).await;
        (base_dir, repo_s)
    }

    /// A rename lock another process holds (a handle of the test's own stands in) makes a
    /// rename wait out its budget, then refuse as busy BEFORE git runs. The hold's file is
    /// backdated past the 10 s age the store lock evicts by; nothing reads an OS lock's
    /// age, so the holder keeps it.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_rename_lock_held_elsewhere_waits_then_refuses_before_git() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_base, repo_s) = repo_with_feat_x("rename-lock-busy").await;
        let identity = crate::git::repo::repo_identity(&repo_s).await.unwrap();
        let held = crate::local_prs::tests::hold_rename_lock_elsewhere(&identity);
        held.set_modified(std::time::SystemTime::now() - Duration::from_secs(60))
            .unwrap();

        let wait = Duration::from_millis(400);
        let started = std::time::Instant::now();
        let state = AppState::default();
        let err = crate::local_prs::RENAME_LOCK_WAIT
            .scope(
                wait,
                git_rename_branch_core(&state, repo_s.clone(), "feat/x".into(), "feat/y".into()),
            )
            .await
            .expect_err("a held rename lock refuses the rename");
        assert!(started.elapsed() >= wait, "refused before its wait ran out");
        assert!(
            matches!(&err, AppError::Busy { holder } if holder == "another branch rename"),
            "{err:?}"
        );
        assert!(run(&repo_s, &["branch", "--list", "feat/x"])
            .await
            .contains("feat/x"));
        assert!(run(&repo_s, &["branch", "--list", "feat/y"])
            .await
            .trim()
            .is_empty());
        assert!(
            !crate::local_prs::tests::rename_lock_takeable(&identity, Duration::ZERO),
            "the aged hold is still its holder's"
        );
        drop(held);
        assert!(crate::local_prs::tests::rename_lock_takeable(
            &identity,
            Duration::from_secs(5)
        ));
    }

    /// A local-PR write from another task lands while a rename is held before its git
    /// step, with the store's cross-process lock free: the rename lock orders renames
    /// only, so no store writer in any process queues behind a rename's git work.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_local_pr_write_during_a_rename_is_not_held_behind_its_git_step() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_base, repo_s) = repo_with_feat_x("rename-lock-store-free").await;
        let identity = crate::git::repo::repo_identity(&repo_s).await.unwrap();

        let reached = Arc::new(tokio::sync::Notify::new());
        let released = Arc::new(tokio::sync::Notify::new());
        let state = AppState::default();
        let rename = RENAME_PHASE_HOOK.scope(
            hold_rename_at(RenamePhase::BeforeGit, reached.clone(), released.clone()),
            git_rename_branch_core(&state, repo_s.clone(), "feat/x".into(), "feat/y".into()),
        );
        let writer = async {
            reached.notified().await;
            let store = crate::local_prs::store_path().unwrap();
            let store_lock_free = tokio::task::spawn_blocking(move || {
                crate::store_lock::lock_store(&store).acquired()
            })
            .await
            .unwrap();
            let written = tokio::time::timeout(
                Duration::from_secs(5),
                crate::local_prs::create(&identity, "During", "", "main", "feat/x"),
            )
            .await;
            released.notify_one();
            (store_lock_free, written)
        };
        let (renamed, (store_lock_free, written)) =
            tokio::time::timeout(TEST_GIT_HANG_GUARD, async { tokio::join!(rename, writer) })
                .await
                .expect("neither side hangs");
        renamed.expect("the rename succeeds");
        assert!(
            store_lock_free,
            "the store lock is not held across the rename's git step"
        );
        let pr = written
            .expect("the write completes during the rename")
            .unwrap();
        assert_eq!(
            crate::local_prs::get(&identity, pr["id"].as_str().unwrap()).unwrap()["head"],
            "feat/y",
            "written before the move, so the move carried it"
        );
    }

    /// The rename lock is free again however a rename ends: a success, a git failure, and
    /// a success whose local-PR move failed on a malformed store.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn the_rename_lock_is_released_after_every_outcome() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_base, repo_s) = repo_with_feat_x("rename-lock-release").await;
        let identity = crate::git::repo::repo_identity(&repo_s).await.unwrap();
        let state = AppState::default();
        let takeable =
            || crate::local_prs::tests::rename_lock_takeable(&identity, Duration::from_secs(5));

        git_rename_branch_core(&state, repo_s.clone(), "feat/x".into(), "feat/y".into())
            .await
            .expect("the rename succeeds");
        assert!(takeable(), "released after a success");

        let err = git_rename_branch_core(&state, repo_s.clone(), "missing".into(), "other".into())
            .await
            .expect_err("git refuses a missing branch");
        assert!(matches!(err, AppError::Git { .. }), "{err:?}");
        assert!(takeable(), "released after a git failure");

        std::fs::write(crate::local_prs::store_path().unwrap(), "{ not json").unwrap();
        let outcome =
            git_rename_branch_core(&state, repo_s.clone(), "feat/y".into(), "feat/z".into())
                .await
                .expect("a failed move never fails the rename");
        assert!(outcome.warning.is_some(), "the move failed");
        assert!(takeable(), "released after a failed move");
    }

    /// The rename lock is per repository: with repo A's held (its in-process mutex and its
    /// file), a rename in repo B completes inside its own wait budget, and A's stays held.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn renames_in_two_repositories_never_contend() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_a_base, repo_a) = repo_with_feat_x("rename-lock-repo-a").await;
        let (_b_base, repo_b) = repo_with_feat_x("rename-lock-repo-b").await;
        let identity_a = crate::git::repo::repo_identity(&repo_a).await.unwrap();
        let held_a = crate::local_prs::lock_for_rename(&identity_a)
            .await
            .unwrap();

        let wait = Duration::from_secs(5);
        let started = std::time::Instant::now();
        let state = AppState::default();
        crate::local_prs::RENAME_LOCK_WAIT
            .scope(
                wait,
                git_rename_branch_core(&state, repo_b.clone(), "feat/x".into(), "feat/y".into()),
            )
            .await
            .expect("repo A's held lock never queues repo B's rename");
        assert!(started.elapsed() < wait, "B never waited out its budget");
        assert!(run(&repo_b, &["branch", "--list", "feat/y"])
            .await
            .contains("feat/y"));
        assert!(
            !crate::local_prs::tests::rename_lock_takeable(&identity_a, Duration::ZERO),
            "A's lock is still held"
        );
        drop(held_a);
    }

    /// A lock file that can't be opened never refuses the rename: git renames the branch,
    /// and the local-PR move, whose store in that same directory can't be read either,
    /// returns its warning. Both paths are occupied by directories, which no platform opens
    /// as a file (a path under a FILE reads as not-found on Windows, an empty store).
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn an_unusable_rename_lock_file_renames_and_warns() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_base, repo_s) = repo_with_feat_x("rename-lock-unusable").await;
        let identity = crate::git::repo::repo_identity(&repo_s).await.unwrap();
        std::fs::create_dir_all(crate::local_prs::tests::rename_lock_file(&identity)).unwrap();
        std::fs::create_dir_all(crate::local_prs::store_path().unwrap()).unwrap();

        let state = AppState::default();
        let outcome =
            git_rename_branch_core(&state, repo_s.clone(), "feat/x".into(), "feat/y".into())
                .await
                .expect("an unusable lock file never refuses the rename");
        assert_eq!(
            outcome.warning.as_deref(),
            Some("Some local pull requests may still point at feat/x.")
        );
        assert!(run(&repo_s, &["branch", "--list", "feat/y"])
            .await
            .contains("feat/y"));
        assert!(run(&repo_s, &["branch", "--list", "feat/x"])
            .await
            .trim()
            .is_empty());
    }

    /// A rename that passed the update check, then waited on the rename lock, re-checks
    /// once it holds the lock: an update of its branch that started during the wait refuses
    /// it before git runs. The rename is driven until it holds its in-process mutex, which
    /// it takes only after the early check, while another handle holds the file.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_rename_that_waited_refuses_an_update_started_during_the_wait() {
        use crate::git::update_marker as marker;
        let _serialized_store = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override_store = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        // A branch name no other test uses: the marker root override is process-wide.
        let branch = "rename-waits-update";
        let (_base, base) = temp_base("rename-lock-wait-update");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", branch]).await;
        let (_serialized, _override, root) = holder_marker_root(&repo_s);
        let identity = crate::git::repo::repo_identity(&repo_s).await.unwrap();
        let held = crate::local_prs::tests::hold_rename_lock_elsewhere(&identity);

        let state = AppState::default();
        let mut rename = std::pin::pin!(crate::local_prs::RENAME_LOCK_WAIT.scope(
            Duration::from_secs(20),
            git_rename_branch_core(&state, repo_s.clone(), branch.into(), "renamed".into()),
        ));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !crate::local_prs::tests::rename_mutex_held(&identity) {
            let polled = std::future::poll_fn(|cx| {
                std::task::Poll::Ready(std::future::Future::poll(rename.as_mut(), cx))
            })
            .await;
            assert!(polled.is_pending(), "the rename waits on the held lock");
            assert!(
                std::time::Instant::now() < deadline,
                "the rename never reached the lock"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let _live = marker::UpdateMarker::create_for(&root.join("gd-update-live"), branch)
            .expect("the marker mints");
        drop(held);

        let err = tokio::time::timeout(TEST_GIT_HANG_GUARD, rename)
            .await
            .expect("the rename settles once the lock is free")
            .expect_err("an update that started during the wait refuses the rename");
        assert_eq!(
            err.to_string(),
            marker::branch_update_refusal(branch).to_string()
        );
        assert!(!run(&repo_s, &["branch", "--list", branch])
            .await
            .trim()
            .is_empty());
        assert!(run(&repo_s, &["branch", "--list", "renamed"])
            .await
            .trim()
            .is_empty());
    }

    // --- Rewrite-aware divergence (`git_branch_rewrite_status`). ---

    /// Builds the shape a server-side rebase leaves behind and returns the local
    /// clone's path: a bare `remote`, a `server` clone that rebases `feature` onto
    /// an advanced `main` and force-pushes it, and a `local` clone that has the
    /// PRE-rebase commits on `feature` plus a fetched view of the rewritten
    /// upstream. `local/feature` ends up 2 ahead / 3 behind `origin/feature`, with
    /// both of its commits patch-equal to the rewritten pair.
    async fn server_rebase_fixture(base: &std::path::Path) -> String {
        let remote_s = base.join("remote").to_string_lossy().into_owned();
        run_git(
            None,
            &[
                "-c",
                "init.defaultRefFormat=files",
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                &remote_s,
            ],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .expect("init bare remote");

        let server = base.join("server");
        let server_s = server.to_string_lossy().into_owned();
        run_git(
            None,
            &[
                "-c",
                "init.defaultRefFormat=files",
                "clone",
                "-q",
                &remote_s,
                &server_s,
            ],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .expect("clone server");
        run(&server_s, &["config", "user.email", "t@t.local"]).await;
        run(&server_s, &["config", "user.name", "T"]).await;
        std::fs::write(server.join("seed.txt"), "seed\n").unwrap();
        run(&server_s, &["add", "-A"]).await;
        run(&server_s, &["commit", "-qm", "seed"]).await;
        run(&server_s, &["push", "-q", "origin", "main"]).await;

        let local = base.join("local");
        let local_s = local.to_string_lossy().into_owned();
        run(&remote_s, &["symbolic-ref", "HEAD", "refs/heads/main"]).await;
        run_git(
            None,
            &[
                "-c",
                "init.defaultRefFormat=files",
                "clone",
                "-q",
                &remote_s,
                &local_s,
            ],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .expect("clone local");
        run(&local_s, &["config", "user.email", "t@t.local"]).await;
        run(&local_s, &["config", "user.name", "T"]).await;
        run(&local_s, &["switch", "-qc", "feature"]).await;
        for n in ["one", "two"] {
            std::fs::write(local.join(format!("{n}.txt")), format!("{n}\n")).unwrap();
            run(&local_s, &["add", "-A"]).await;
            run(&local_s, &["commit", "-qm", &format!("feat {n}")]).await;
        }
        run(&local_s, &["push", "-q", "-u", "origin", "feature"]).await;

        // The server advances main, rebases feature onto it, and force-pushes —
        // GitHub's "Update branch → rebase" in miniature.
        run(&server_s, &["fetch", "-q", "origin"]).await;
        std::fs::write(server.join("main.txt"), "main moved\n").unwrap();
        run(&server_s, &["add", "-A"]).await;
        run(&server_s, &["commit", "-qm", "main moves"]).await;
        run(&server_s, &["push", "-q", "origin", "main"]).await;
        run(&server_s, &["switch", "-qc", "feature", "origin/feature"]).await;
        run(&server_s, &["rebase", "-q", "main"]).await;
        run(&server_s, &["push", "-q", "--force", "origin", "feature"]).await;

        run(&local_s, &["fetch", "-q", "origin"]).await;
        local_s
    }

    /// The motivating case: the remote rebased this branch. Nothing local is
    /// unique (both commits have patch-twins upstream) and the rewritten upstream
    /// tip was never in the branch's reflog, so the verdict is a rewrite and a
    /// reset-to-upstream is safe to offer.
    #[tokio::test]
    async fn rewrite_status_detects_a_server_side_rebase() {
        let (_base, base) = temp_base("rewrite-server-rebase");
        let local_s = server_rebase_fixture(&base).await;

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.remote_rewritten,
            Some(true),
            "the rewritten upstream tip is absent from the branch's reflog"
        );
        assert_eq!(
            st.local_only, 0,
            "every local commit has a patch-equivalent upstream — nothing unique to lose"
        );
        assert_eq!(
            st.remote_only, 1,
            "only the commit the server added to main is genuinely remote-only"
        );
        // `--cherry-mark` counts BOTH members of each matched pair.
        assert_eq!(st.patch_equal, 4, "two commits matched on two sides");
        assert_eq!(st.upstream.as_deref(), Some("origin/feature"));
        assert_eq!(
            st.upstream_tip.as_deref(),
            Some(run(&local_s, &["rev-parse", "origin/feature"]).await.trim()),
            "the tip a confirmed reset would land on"
        );
    }

    /// NEGATIVE CONTROL for the reflog containment probe. The rewrite verdict must
    /// come from the reflog walk and nothing else: with the branch's reflog removed,
    /// the same fixture — identical counts — must stop claiming a rewrite rather
    /// than fall back to inferring one from `local_only == 0`.
    #[tokio::test]
    async fn rewrite_status_without_a_reflog_refuses_to_guess() {
        let (_base, base) = temp_base("rewrite-no-reflog");
        let local_s = server_rebase_fixture(&base).await;
        std::fs::remove_file(
            std::path::Path::new(&local_s)
                .join(".git")
                .join("logs")
                .join("refs")
                .join("heads")
                .join("feature"),
        )
        .expect("drop the branch reflog");

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.remote_rewritten, None,
            "no reflog to walk proves nothing — the UI must stay ordinary"
        );
        assert_eq!(
            (st.local_only, st.remote_only),
            (0, 1),
            "the counts are unchanged, so only the reflog can be driving the verdict"
        );
    }

    /// A commit made locally AFTER the rewrite lands is unique work: `local_only`
    /// must rise above zero so the UI withholds the reset offer.
    #[tokio::test]
    async fn rewrite_status_counts_genuinely_local_commits() {
        let (_base, base) = temp_base("rewrite-local-work");
        let local_s = server_rebase_fixture(&base).await;
        std::fs::write(
            std::path::Path::new(&local_s).join("mine.txt"),
            "unique\n",
        )
        .unwrap();
        run(&local_s, &["add", "-A"]).await;
        run(&local_s, &["commit", "-qm", "my own work"]).await;

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.local_only, 1,
            "the new commit has no patch-twin upstream — resetting would destroy it"
        );
        assert_eq!(st.remote_rewritten, Some(true));
    }

    /// Tags named like the branch (sitting on the upstream tip) and like its upstream
    /// must not stand in for either: a bare `feature` in the range resolves to the tag,
    /// collapsing the local side to zero, which is half of the reset offer's unlock.
    #[tokio::test]
    async fn rewrite_status_reads_the_branch_not_a_same_named_tag() {
        let (_base, base) = temp_base("rewrite-tag-shadow");
        let local_s = server_rebase_fixture(&base).await;
        std::fs::write(std::path::Path::new(&local_s).join("mine.txt"), "unique\n").unwrap();
        run(&local_s, &["add", "-A"]).await;
        run(&local_s, &["commit", "-qm", "my own work"]).await;
        run(&local_s, &["tag", "feature", "origin/feature"]).await;
        run(&local_s, &["tag", "origin/feature", "main"]).await;

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            (st.local_only, st.remote_only, st.remote_rewritten),
            (1, 1, Some(true)),
            "the branch's own unique commit still withholds the reset offer"
        );
        assert_eq!(st.upstream.as_deref(), Some("origin/feature"));
        assert_eq!(
            st.upstream_tip.as_deref(),
            Some(
                run(&local_s, &["rev-parse", "refs/remotes/origin/feature"])
                    .await
                    .trim()
            )
        );
    }

    /// The reflog walked is the BRANCH's only. A bare name walks `refs/heads/<name>`'s
    /// reflog when it has one, but with none it falls back to whichever same-named ref
    /// does — here a tag created at the upstream tip under tag reflogs, which would
    /// clear a branch that never saw that tip instead of refusing to guess.
    #[tokio::test]
    async fn rewrite_status_walks_the_branch_reflog_not_a_same_named_tags() {
        let (_base, base) = temp_base("rewrite-tag-reflog");
        let local_s = server_rebase_fixture(&base).await;
        std::fs::remove_file(
            std::path::Path::new(&local_s)
                .join(".git")
                .join("logs")
                .join("refs")
                .join("heads")
                .join("feature"),
        )
        .expect("drop the branch reflog");
        run(&local_s, &["config", "core.logAllRefUpdates", "always"]).await;
        run(&local_s, &["tag", "feature", "refs/remotes/origin/feature"]).await;
        assert!(
            !run(&local_s, &["reflog", "show", "refs/tags/feature"])
                .await
                .trim()
                .is_empty(),
            "fixture sanity: the tag carries a reflog holding the upstream tip"
        );

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.remote_rewritten, None,
            "the branch has no reflog to walk, so nothing is provable"
        );
    }

    /// The discriminating positive case: a branch whose reflog DOES hold the
    /// upstream tip (it was created there and only moved forward). Without this,
    /// a probe that answered "rewritten" for every branch with a reflog would go
    /// unnoticed — the rewrite tests alone can't tell the two apart.
    #[tokio::test]
    async fn rewrite_status_clears_a_branch_that_has_seen_its_upstream() {
        let (_base, base) = temp_base("rewrite-seen-upstream");
        let local_s = server_rebase_fixture(&base).await;
        // Adopt the rewritten upstream, then commit on top: the branch is now
        // plainly ahead, and its reflog holds the current upstream tip.
        run(&local_s, &["reset", "-q", "--hard", "origin/feature"]).await;
        std::fs::write(
            std::path::Path::new(&local_s).join("after.txt"),
            "after\n",
        )
        .unwrap();
        run(&local_s, &["add", "-A"]).await;
        run(&local_s, &["commit", "-qm", "after the rebase"]).await;

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.remote_rewritten,
            Some(false),
            "the upstream tip is in this branch's reflog — nothing was rewritten under it"
        );
        assert_eq!((st.local_only, st.remote_only), (1, 0));
    }

    /// ORDINARY divergence — a teammate pushed while you committed, no rewrite
    /// anywhere. The reflog verdict reads `Some(true)` here too (you have never
    /// been at that remote tip), which is exactly why no surface may treat the
    /// verdict alone as a rewrite: what separates the two is `patchEqual`, zero
    /// here and non-zero whenever commits were actually replayed.
    #[tokio::test]
    async fn rewrite_status_says_true_for_ordinary_divergence_with_no_twins() {
        let (_base, base) = temp_base("rewrite-ordinary");
        let local_s = server_rebase_fixture(&base).await;
        // Start from a synced state, then diverge for real: one commit each side
        // of `feature`, touching different files so nothing is patch-equal.
        run(&local_s, &["reset", "-q", "--hard", "origin/feature"]).await;
        let server_s = base.join("server").to_string_lossy().into_owned();
        std::fs::write(base.join("server").join("theirs.txt"), "theirs\n").unwrap();
        run(&server_s, &["add", "-A"]).await;
        run(&server_s, &["commit", "-qm", "their work"]).await;
        run(&server_s, &["push", "-q", "origin", "feature"]).await;
        std::fs::write(
            std::path::Path::new(&local_s).join("mine.txt"),
            "mine\n",
        )
        .unwrap();
        run(&local_s, &["add", "-A"]).await;
        run(&local_s, &["commit", "-qm", "my work"]).await;
        run(&local_s, &["fetch", "-q", "origin"]).await;

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.remote_rewritten,
            Some(true),
            "an unseen remote tip reads the same whether or not anything was rewritten"
        );
        assert_eq!((st.local_only, st.remote_only), (1, 1));
        assert_eq!(
            st.patch_equal, 0,
            "no patch twins — the discriminator between this and a rewrite"
        );
    }

    /// A branch with no upstream has nothing to be rewritten against, and the
    /// answer must be the same "nothing provable" shape as a failed probe.
    #[tokio::test]
    async fn rewrite_status_without_an_upstream_is_unknown() {
        let (_base, base) = temp_base("rewrite-no-upstream");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["switch", "-qc", "solo"]).await;

        let st = branch_rewrite_status(&repo_s, "solo")
            .await
            .expect("status resolves");
        assert_eq!(st.remote_rewritten, None);
        assert_eq!(st.upstream, None);
        assert_eq!(st.upstream_tip, None);
    }

    /// The wire names the TS `BranchRewriteStatus` mirror reads. `rename_all` does
    /// NOT cover a struct's fields by inheritance from anywhere else, so the
    /// camelCase keys are pinned here or the frontend reads `undefined` silently.
    #[test]
    fn rewrite_status_serializes_to_the_camel_case_wire_shape() {
        let json = serde_json::to_string(&BranchRewriteStatus {
            remote_rewritten: Some(true),
            local_only: 0,
            remote_only: 1,
            patch_equal: 4,
            upstream: Some("origin/feature".into()),
            upstream_tip: Some("abc123".into()),
            local_tip: Some("def456".into()),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"remoteRewritten":true,"localOnly":0,"remoteOnly":1,"patchEqual":4,"upstream":"origin/feature","upstreamTip":"abc123","localTip":"def456"}"#
        );
        assert_eq!(
            serde_json::to_string(&BranchRewriteStatus::unknown()).unwrap(),
            r#"{"remoteRewritten":null,"localOnly":0,"remoteOnly":0,"patchEqual":0,"upstream":null,"upstreamTip":null,"localTip":null}"#
        );
    }

    /// A measured status carries the branch's own tip, the sha a confirmed reset pins.
    #[tokio::test]
    async fn rewrite_status_carries_the_measured_local_tip() {
        let (_base, base) = temp_base("rewrite-local-tip");
        let local_s = server_rebase_fixture(&base).await;
        run(&local_s, &["tag", "feature", "main"]).await;

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");

        assert_eq!(
            st.local_tip,
            Some(local_tip(&local_s, "feature").await),
            "the branch's tip, never a same-named tag's"
        );
    }

    /// The branch's own tip, read through the full ref so no same-named tag answers.
    async fn local_tip(repo: &str, branch: &str) -> String {
        branch_tip_sha(repo, branch)
            .await
            .expect("the tip reads")
            .expect("the branch exists")
    }

    /// Lands one commit on `branch` without checking it out, as a terminal or
    /// another process would, and returns the new tip.
    async fn commit_onto_idle_branch(repo: &str, branch: &str, subject: &str) -> String {
        let parent = local_tip(repo, branch).await;
        let tree = format!("{parent}^{{tree}}");
        let commit = run(repo, &["commit-tree", &tree, "-p", &parent, "-m", subject])
            .await
            .trim()
            .to_string();
        run(repo, &["branch", "-f", "--", branch, &commit]).await;
        commit
    }

    /// The non-current-branch remedy moves the ref and leaves the working tree —
    /// and the branch you are actually on — untouched.
    #[tokio::test]
    async fn reset_to_upstream_moves_an_idle_branch() {
        let (_base, base) = temp_base("reset-upstream-idle");
        let local_s = server_rebase_fixture(&base).await;
        // Step off `feature` so it is idle; `main` tracks origin/main already.
        run(&local_s, &["switch", "-q", "main"]).await;
        let target = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();
        let head_before = run(&local_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        let local = local_tip(&local_s, "feature").await;
        let state = AppState::default();
        branch_reset_to_upstream(&state, &local_s, "feature", &target, &local)
            .await
            .expect("reset succeeds");

        assert_eq!(
            run(&local_s, &["rev-parse", "feature"]).await.trim(),
            target,
            "the branch now points at the upstream tip"
        );
        assert_eq!(
            run(&local_s, &["rev-parse", "HEAD"]).await.trim(),
            head_before,
            "the checked-out branch never moved"
        );
        assert_eq!(
            run(
                &local_s,
                &["reflog", "show", "-1", "--format=%gs", "refs/heads/feature"]
            )
            .await
            .trim(),
            format!("branch: Reset to {target}"),
            "the reflog entry reads as `branch -f` wrote it, the recovery path"
        );
    }

    /// The user confirmed against the branch's tip then; an outside commit landed on
    /// the branch before the reset ran. The reset must keep it, and a re-measured tip
    /// is the success twin.
    #[tokio::test]
    async fn reset_to_upstream_refuses_when_the_branch_itself_moved() {
        let (_base, base) = temp_base("reset-upstream-local-moved");
        let local_s = server_rebase_fixture(&base).await;
        run(&local_s, &["switch", "-q", "main"]).await;
        // A branch name no other test uses: a parallel test's live update marker on a
        // shared name would refuse this one first.
        let branch = "feature-local-moved";
        run(&local_s, &["branch", "-m", "feature", branch]).await;
        let target = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();
        let measured = local_tip(&local_s, branch).await;
        let outside = commit_onto_idle_branch(&local_s, branch, "outside").await;

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &local_s, branch, &target, &measured)
            .await
            .expect_err("a branch that moved since the confirm must refuse");
        assert!(
            matches!(&err, AppError::Git { stderr, .. }
                if *stderr == format!("{branch} changed since you confirmed — nothing was reset.")),
            "got {err:?}"
        );
        assert_eq!(
            local_tip(&local_s, branch).await,
            outside,
            "the outside commit is kept"
        );

        branch_reset_to_upstream(&state, &local_s, branch, &target, &outside)
            .await
            .expect("the re-measured tip resets");
        assert_eq!(local_tip(&local_s, branch).await, target);
    }

    #[tokio::test]
    async fn reset_to_upstream_local_tip_compare_is_full_hash_in_sha256_repos() {
        let (_base, base) = temp_base("reset-upstream-sha256");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q", "--object-format=sha256"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(repo.join("a.txt"), "a\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "seed"]).await;
        // Unique names, as above: an update marker is matched by branch name.
        let (branch, up) = ("feature-sha256-pin", "up-sha256-pin");
        run(&repo_s, &["branch", up]).await;
        run(&repo_s, &["branch", branch]).await;
        run(&repo_s, &["branch", "--set-upstream-to", up, branch]).await;
        let target = commit_onto_idle_branch(&repo_s, up, "upstream moves").await;
        let local = local_tip(&repo_s, branch).await;
        assert_eq!(local.len(), 64, "a sha256 oid");

        let state = AppState::default();
        // Same 63-char prefix, different last digit: only a full compare tells them apart.
        let last = if local.ends_with('0') { '1' } else { '0' };
        for stale in [format!("{}{last}", &local[..63]), local[..40].to_string()] {
            let err = branch_reset_to_upstream(&state, &repo_s, branch, &target, &stale)
                .await
                .expect_err("a near-miss pin refuses");
            assert!(
                matches!(&err, AppError::Git { stderr, .. }
                    if stderr.contains("changed since you confirmed")),
                "got {err:?}"
            );
            assert_eq!(local_tip(&repo_s, branch).await, local);
        }

        branch_reset_to_upstream(&state, &repo_s, branch, &target, &local)
            .await
            .expect("the full oid matches");
        assert_eq!(local_tip(&repo_s, branch).await, target);
    }

    /// A repo whose `branch` is `ahead` commits past a base and tracks a local `up`
    /// branch one conflicting commit past it; `branch` is NOT checked out. Returns
    /// (repo, base, up's tip).
    async fn diverged_local_upstream(
        base: &std::path::Path,
        branch: &str,
        up: &str,
        ahead: usize,
    ) -> (String, String, String) {
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        let fork = run(&repo_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["branch", up]).await;
        run(&repo_s, &["switch", "-qc", branch]).await;
        for n in 0..ahead {
            std::fs::write(repo.join("a.txt"), format!("mine {n}\n")).unwrap();
            run(&repo_s, &["commit", "-qam", &format!("mine {n}")]).await;
        }
        run(&repo_s, &["switch", "-q", up]).await;
        std::fs::write(repo.join("a.txt"), "theirs\n").unwrap();
        run(&repo_s, &["commit", "-qam", "theirs"]).await;
        let up_tip = local_tip(&repo_s, up).await;
        run(&repo_s, &["switch", "-q", "--detach"]).await;
        run(&repo_s, &["branch", "--set-upstream-to", up, branch]).await;
        (repo_s, fork, up_tip)
    }

    /// A linked worktree stopped mid-rebase of the branch reads as detached in
    /// `worktree list`, and `update-ref` would move the ref under it. The refusal
    /// names that worktree; once the worktree is gone, the reset runs.
    #[tokio::test]
    async fn reset_to_upstream_refuses_a_branch_being_rebased_in_a_worktree() {
        let (_base, base) = temp_base("reset-upstream-rebasing");
        let (branch, up) = ("feature-rebasing", "up-rebasing");
        let (repo_s, _fork, target) = diverged_local_upstream(&base, branch, up, 1).await;
        let wt_s = base.join("wt").to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-q", &wt_s, branch]).await;
        let rebase = run_git_raw(Some(&wt_s), &["rebase", up], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        assert_ne!(
            rebase.code, 0,
            "fixture sanity: the rebase stops on a conflict"
        );
        let local = local_tip(&repo_s, branch).await;

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &repo_s, branch, &target, &local)
            .await
            .expect_err("a branch mid-rebase must refuse");
        let AppError::Command(msg) = &err else {
            panic!("expected the actionable refusal, got {err:?}");
        };
        let named = msg
            .split_once(" at ")
            .and_then(|(_, rest)| rest.split_once(" — "))
            .map(|(path, _)| path)
            .unwrap_or_default();
        assert!(msg.contains("being rebased"), "{msg}");
        assert_eq!(
            crate::git::worktree::canonical_wt_path(named),
            crate::git::worktree::canonical_wt_path(&wt_s),
            "the refusal names the rebasing worktree: {msg}"
        );
        assert_eq!(
            local_tip(&repo_s, branch).await,
            local,
            "the ref is unmoved"
        );

        run(&wt_s, &["rebase", "--abort"]).await;
        run(&repo_s, &["worktree", "remove", "--force", &wt_s]).await;
        branch_reset_to_upstream(&state, &repo_s, branch, &target, &local)
            .await
            .expect("with no rebase in the way, the reset runs");
        assert_eq!(local_tip(&repo_s, branch).await, target);
    }

    /// The bisect twin: a worktree bisecting the branch has detached onto a midpoint.
    #[tokio::test]
    async fn reset_to_upstream_refuses_a_branch_being_bisected_in_a_worktree() {
        let (_base, base) = temp_base("reset-upstream-bisecting");
        let (branch, up) = ("feature-bisecting", "up-bisecting");
        let (repo_s, fork, target) = diverged_local_upstream(&base, branch, up, 3).await;
        let wt_s = base.join("wt").to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-q", &wt_s, branch]).await;
        run(&wt_s, &["bisect", "start", branch, &fork]).await;
        assert!(
            worktree_holding_branch(&repo_s, branch).await.is_none(),
            "fixture sanity: the bisect detached the worktree"
        );
        let local = local_tip(&repo_s, branch).await;

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &repo_s, branch, &target, &local)
            .await
            .expect_err("a branch mid-bisect must refuse");
        assert!(
            matches!(&err, AppError::Command(m) if m.contains("being bisected")),
            "got {err:?}"
        );
        assert_eq!(
            local_tip(&repo_s, branch).await,
            local,
            "the ref is unmoved"
        );

        run(&wt_s, &["bisect", "reset"]).await;
        run(&repo_s, &["worktree", "remove", "--force", &wt_s]).await;
        branch_reset_to_upstream(&state, &repo_s, branch, &target, &local)
            .await
            .expect("with no bisect in the way, the reset runs");
        assert_eq!(local_tip(&repo_s, branch).await, target);
    }

    /// A stacked `rebase --update-refs` of the TOP branch, stopped in a linked worktree,
    /// will move the bottom branch too: git lists it in `rebase-merge/update-refs` and
    /// `branch -f` refuses it, so the reset refuses it as well.
    #[tokio::test]
    async fn reset_to_upstream_refuses_a_branch_a_stacked_rebase_will_move() {
        let (_base, base) = temp_base("reset-upstream-update-refs");
        let (bottom, top, up) = ("stack-bottom-pin", "stack-top-pin", "up-update-refs");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", up]).await;
        run(&repo_s, &["switch", "-qc", bottom]).await;
        std::fs::write(repo.join("b.txt"), "bottom\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "bottom"]).await;
        run(&repo_s, &["switch", "-qc", top]).await;
        std::fs::write(repo.join("a.txt"), "mine\n").unwrap();
        run(&repo_s, &["commit", "-qam", "top"]).await;
        run(&repo_s, &["switch", "-q", up]).await;
        std::fs::write(repo.join("a.txt"), "theirs\n").unwrap();
        run(&repo_s, &["commit", "-qam", "theirs"]).await;
        let target = local_tip(&repo_s, up).await;
        run(&repo_s, &["switch", "-q", "--detach"]).await;
        run(&repo_s, &["branch", "--set-upstream-to", up, bottom]).await;
        let wt_s = base.join("wt").to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-q", &wt_s, top]).await;
        let rebase = run_git_raw(
            Some(&wt_s),
            &["rebase", "--update-refs", up],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_ne!(rebase.code, 0, "fixture sanity: the top commit conflicts");
        let local = local_tip(&repo_s, bottom).await;

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &repo_s, bottom, &target, &local)
            .await
            .expect_err("a branch a stacked rebase will move must refuse");
        assert!(
            matches!(&err, AppError::Command(m)
                if m.contains("is part of a rebase in the worktree at")),
            "got {err:?}"
        );
        assert_eq!(
            local_tip(&repo_s, bottom).await,
            local,
            "the ref is unmoved"
        );

        run(&wt_s, &["rebase", "--abort"]).await;
        run(&repo_s, &["worktree", "remove", "--force", &wt_s]).await;
        branch_reset_to_upstream(&state, &repo_s, bottom, &target, &local)
            .await
            .expect("with no rebase in the way, the reset runs");
        assert_eq!(local_tip(&repo_s, bottom).await, target);
    }

    /// The rebase stopped in THIS checkout reads "here", as the checked-out refusal
    /// does; once it is aborted and HEAD detached again, the reset runs.
    #[tokio::test]
    async fn reset_to_upstream_says_here_for_a_rebase_in_this_checkout() {
        let (_base, base) = temp_base("reset-upstream-rebasing-here");
        let (branch, up) = ("feature-rebasing-here", "up-rebasing-here");
        let (repo_s, _fork, target) = diverged_local_upstream(&base, branch, up, 1).await;
        run(&repo_s, &["switch", "-q", branch]).await;
        let rebase = run_git_raw(Some(&repo_s), &["rebase", up], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        assert_ne!(
            rebase.code, 0,
            "fixture sanity: the rebase stops on a conflict"
        );
        let local = local_tip(&repo_s, branch).await;

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &repo_s, branch, &target, &local)
            .await
            .expect_err("a branch mid-rebase here must refuse");
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with(&format!("{branch} is being rebased here — "))),
            "got {err:?}"
        );

        run(&repo_s, &["rebase", "--abort"]).await;
        run(&repo_s, &["switch", "-q", "--detach"]).await;
        branch_reset_to_upstream(&state, &repo_s, branch, &target, &local)
            .await
            .expect("with no rebase in the way, the reset runs");
        assert_eq!(local_tip(&repo_s, branch).await, target);
    }

    /// A stray FILE under `<common>/worktrees/` is skipped, as git's own listing skips
    /// it, rather than failing every reset closed.
    #[tokio::test]
    async fn reset_to_upstream_skips_a_stray_file_among_the_worktree_admin_dirs() {
        let (_base, base) = temp_base("reset-upstream-stray-admin");
        let (branch, up) = ("feature-stray-admin", "up-stray-admin");
        let (repo_s, _fork, target) = diverged_local_upstream(&base, branch, up, 1).await;
        let admins = std::path::Path::new(&repo_s).join(".git").join("worktrees");
        std::fs::create_dir_all(&admins).unwrap();
        std::fs::write(admins.join("stray"), "not a worktree\n").unwrap();
        let local = local_tip(&repo_s, branch).await;

        let state = AppState::default();
        branch_reset_to_upstream(&state, &repo_s, branch, &target, &local)
            .await
            .expect("a stray file is not a worktree");
        assert_eq!(local_tip(&repo_s, branch).await, target);
    }

    /// A stale ref lock fails the compare-and-swap with the branch unmoved: that is
    /// git's own error, never "changed since you confirmed". Clearing it is the twin.
    #[tokio::test]
    async fn reset_to_upstream_keeps_gits_error_for_a_stale_ref_lock() {
        let (_base, base) = temp_base("reset-upstream-ref-lock");
        let (branch, up) = ("feature-ref-lock", "up-ref-lock");
        let (repo_s, _fork, target) = diverged_local_upstream(&base, branch, up, 1).await;
        let local = local_tip(&repo_s, branch).await;
        let lock = std::path::Path::new(&repo_s)
            .join(".git")
            .join("refs")
            .join("heads")
            .join(format!("{branch}.lock"));
        std::fs::write(&lock, "").unwrap();

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &repo_s, branch, &target, &local)
            .await
            .expect_err("a held ref lock fails the swap");
        assert!(
            matches!(&err, AppError::Git { stderr, .. }
                if stderr.contains(".lock") && !stderr.contains("changed since you confirmed")),
            "git's own error: {err:?}"
        );
        assert_eq!(
            local_tip(&repo_s, branch).await,
            local,
            "the ref is unmoved"
        );

        std::fs::remove_file(&lock).unwrap();
        branch_reset_to_upstream(&state, &repo_s, branch, &target, &local)
            .await
            .expect("with the lock gone, the reset runs");
        assert_eq!(local_tip(&repo_s, branch).await, target);
    }

    /// The pre-mutation guard: a branch checked out in ANOTHER worktree can't be
    /// force-updated, and the refusal has to name the worktree holding it.
    #[tokio::test]
    async fn reset_to_upstream_refuses_and_names_the_holding_worktree() {
        let (_base, base) = temp_base("reset-upstream-worktree");
        let local_s = server_rebase_fixture(&base).await;
        run(&local_s, &["switch", "-q", "main"]).await;
        let wt = base.join("wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&local_s, &["worktree", "add", "--quiet", &wt_s, "feature"]).await;
        let before = run(&local_s, &["rev-parse", "feature"]).await.trim().to_string();
        let target = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();

        let local = local_tip(&local_s, "feature").await;
        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &local_s, "feature", &target, &local)
            .await
            .expect_err("a branch held by a worktree can't be reset");
        let AppError::Command(msg) = &err else {
            panic!("expected an actionable Command error, got {err:?}");
        };
        // The PATH, not the word "worktree": the message has to be actionable, and
        // asserting the noun would pass on a message that never says where.
        //
        // Compared against the path GIT reports, not the fixture's own spelling of
        // it: a Windows runner hands out 8.3 temp paths (`RUNNER~1`) and macOS
        // tempdirs sit behind the `/var` → `/private/var` symlink, so the two are
        // routinely different spellings of one directory. The message quotes git's
        // spelling, so that is what an exact containment check has to use — and the
        // canonical compare below proves it IS this fixture's worktree.
        let porcelain = run(&local_s, &["worktree", "list", "--porcelain"]).await;
        let reported = crate::git::ops::parse_worktree_paths(&porcelain)
            .into_iter()
            .zip(crate::git::ops::parse_worktree_branches(&porcelain))
            .find(|(_, b)| b == "feature")
            .map(|(p, _)| p)
            .expect("git lists a worktree holding feature");
        assert_eq!(
            crate::git::worktree::canonical_wt_path(&reported),
            crate::git::worktree::canonical_wt_path(&wt_s),
            "fixture sanity: git's worktree IS the one this test created"
        );
        assert!(
            msg.contains("feature") && msg.contains(&reported),
            "the refusal must name the branch and the holding worktree's path: {msg}"
        );
        assert_eq!(
            run(&local_s, &["rev-parse", "feature"]).await.trim(),
            before,
            "and the branch must not have moved"
        );

        let _ = run_git(
            Some(&local_s),
            &["worktree", "remove", "--force", &wt_s],
            TEST_GIT_HANG_GUARD,
        )
        .await;
    }

    /// The stale-evidence guard. A background fetch can move the upstream while
    /// the confirmation sits open, and `branch -f` would then land somewhere the
    /// user never saw — so the measured sha has to survive a re-resolve.
    #[tokio::test]
    async fn reset_to_upstream_refuses_a_tip_that_moved_since_it_was_measured() {
        let (_base, base) = temp_base("reset-upstream-moved");
        let local_s = server_rebase_fixture(&base).await;
        run(&local_s, &["switch", "-q", "main"]).await;
        let measured = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();
        let before = run(&local_s, &["rev-parse", "feature"]).await.trim().to_string();

        // The server pushes again; a background fetch picks it up mid-dialog.
        let server_s = base.join("server").to_string_lossy().into_owned();
        std::fs::write(base.join("server").join("later.txt"), "later\n").unwrap();
        run(&server_s, &["add", "-A"]).await;
        run(&server_s, &["commit", "-qm", "later work"]).await;
        run(&server_s, &["push", "-q", "origin", "feature"]).await;
        run(&local_s, &["fetch", "-q", "origin"]).await;
        assert_ne!(
            run(&local_s, &["rev-parse", "origin/feature"]).await.trim(),
            measured,
            "fixture must actually move the upstream for this to discriminate"
        );

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &local_s, "feature", &measured, &before)
            .await
            .expect_err("a moved upstream must refuse");
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("moved")),
            "the refusal must say the upstream moved, got {err:?}"
        );
        assert_eq!(
            run(&local_s, &["rev-parse", "feature"]).await.trim(),
            before,
            "and the branch must not have moved"
        );
    }

    /// REGRESSION GUARD for the CI-only failure: the caller's spelling of the repo
    /// path and git's differ, so a normalize-only self-exclusion doesn't recognize
    /// this checkout and reports the branch as held by a "linked" worktree that is
    /// really this one — the wrong remedy.
    ///
    /// The divergence comes from passing the CANONICALIZED path while git reports
    /// its own spelling. That discriminates on Windows, where `canonicalize` adds
    /// the `\\?\` verbatim prefix and `normalize_wt_path` leaves it in place
    /// (locally verified: reverting the self-exclusion to normalize-only fails this
    /// test right here). On macOS and Linux it does NOT discriminate — canonical is
    /// the same side git already resolves to, so both spellings agree and this
    /// degrades to a duplicate of the test above. Inconclusive-by-platform, so the
    /// assertion is on the ARM rather than on any path string.
    #[tokio::test]
    async fn reset_to_upstream_recognizes_its_own_checkout_under_another_spelling() {
        let (_base, base) = temp_base("reset-upstream-spelling");
        let local_s = server_rebase_fixture(&base).await;
        let target = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();
        // The same directory, spelled the way the OS resolves it.
        let resolved = std::fs::canonicalize(&local_s).expect("repo resolves");
        let resolved_s = resolved.to_string_lossy().into_owned();

        let local = local_tip(&local_s, "feature").await;
        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &resolved_s, "feature", &target, &local)
            .await
            .expect_err("feature is checked out in this very repo");
        let AppError::Command(msg) = &err else {
            panic!("expected an actionable Command error, got {err:?}");
        };
        assert!(
            msg.contains("sync controls"),
            "must take the checked-out-HERE arm, not the linked-worktree one: {msg}"
        );
    }

    /// The self-checkout arm of the same guard: `branch -f` can't touch the branch
    /// you are ON, and the refusal has to point at the surface that CAN.
    #[tokio::test]
    async fn reset_to_upstream_refuses_the_branch_checked_out_here() {
        let (_base, base) = temp_base("reset-upstream-current");
        let local_s = server_rebase_fixture(&base).await;
        // `feature` is the checked-out branch of this very repo path.
        let target = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();
        let before = run(&local_s, &["rev-parse", "feature"]).await.trim().to_string();

        let local = local_tip(&local_s, "feature").await;
        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &local_s, "feature", &target, &local)
            .await
            .expect_err("the current branch can't take a ref-only reset");
        let AppError::Command(msg) = &err else {
            panic!("expected an actionable Command error, got {err:?}");
        };
        assert!(
            msg.contains("feature") && msg.contains("sync controls"),
            "the refusal must name the branch and the surface that handles it: {msg}"
        );
        assert_eq!(
            run(&local_s, &["rev-parse", "feature"]).await.trim(),
            before,
            "and the branch must not have moved"
        );
    }

    /// A tag sharing the current branch's name must not cost the worded refusal:
    /// the guard still recognizes `feature` as the branch checked out here.
    #[tokio::test]
    async fn reset_to_upstream_refuses_the_current_branch_shadowed_by_a_tag() {
        let (_base, base) = temp_base("reset-upstream-tag-shadow");
        let local_s = server_rebase_fixture(&base).await;
        run(&local_s, &["tag", "feature"]).await;
        let target = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();

        let local = local_tip(&local_s, "feature").await;
        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &local_s, "feature", &target, &local)
            .await
            .expect_err("the current branch can't take a ref-only reset");
        let AppError::Command(msg) = &err else {
            panic!("expected the actionable Command refusal, not git's own, got {err:?}");
        };
        assert!(msg.contains("sync controls"), "{msg}");
    }

    /// The remote's default branch stays undeletable when a tag or local branch named
    /// `<remote>/<branch>` makes `symbolic-ref --short` answer `remotes/origin/main`.
    /// Refused before any push, so the bare remote is never contacted.
    #[tokio::test]
    async fn delete_remote_branch_refuses_the_default_shadowed_by_a_tag() {
        let (_base, base) = temp_base("delete-remote-default-tag-shadow");
        let remote_s = base.join("remote").to_string_lossy().into_owned();
        run_git(
            None,
            &["init", "-q", "--bare", &remote_s],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .expect("init bare remote");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &remote_s]).await;
        // The local symref layout is written by hand as a clone leaves it; the
        // bare remote stays empty on purpose, so the local guard is what refuses.
        run(&repo_s, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        run(
            &repo_s,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        )
        .await;
        run(&repo_s, &["tag", "origin/main"]).await;

        let state = AppState::default();
        let err = git_delete_remote_branch_core(
            &state,
            repo_s.clone(),
            "origin".to_string(),
            "main".to_string(),
        )
        .await
        .expect_err("the remote's default branch can't be deleted from here");
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("default branch")),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn delete_remote_branch_preserves_a_same_named_tag() {
        let (_base, base) = temp_base("delete-remote-twin");
        let remote_s = base.join("remote").to_string_lossy().into_owned();
        run_git(
            None,
            &["init", "-q", "--bare", &remote_s],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &remote_s]).await;
        run(&repo_s, &["branch", "twin"]).await;
        run(&repo_s, &["tag", "twin"]).await;
        run(
            &repo_s,
            &["push", "-q", "origin", "refs/heads/twin", "refs/tags/twin"],
        )
        .await;

        let result = git_delete_remote_branch_core(
            &AppState::default(),
            repo_s,
            "origin".into(),
            "twin".into(),
        )
        .await;
        assert!(result.is_ok(), "{result:?}");
        let refs = run(&remote_s, &["for-each-ref", "--format=%(refname)"]).await;
        assert!(!refs.lines().any(|name| name == "refs/heads/twin"));
        assert!(refs.lines().any(|name| name == "refs/tags/twin"));
    }

    #[tokio::test]
    async fn delete_remote_branch_preserves_a_tag_when_branch_is_already_gone() {
        let (_base, base) = temp_base("delete-remote-solo");
        let remote_s = base.join("remote").to_string_lossy().into_owned();
        run_git(
            None,
            &["init", "-q", "--bare", &remote_s],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &remote_s]).await;
        run(&repo_s, &["tag", "solo"]).await;
        run(&repo_s, &["push", "-q", "origin", "refs/tags/solo"]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/solo", "HEAD"]).await;

        let result = git_delete_remote_branch_core(
            &AppState::default(),
            repo_s.clone(),
            "origin".into(),
            "solo".into(),
        )
        .await;
        assert!(result.is_ok(), "{result:?}");
        let refs = run(&remote_s, &["for-each-ref", "--format=%(refname)"]).await;
        assert!(refs.lines().any(|name| name == "refs/tags/solo"));
        assert!(!refs.lines().any(|name| name == "refs/heads/solo"));
        assert!(run(&repo_s, &["for-each-ref", "refs/remotes/origin/solo"])
            .await
            .is_empty());
    }

    /// A malformed (but exit-0) counts line must NOT default to zeros: `local_only
    /// == 0` is half the pair that unlocks the destructive reset offer, so a
    /// fabricated one is the worst answer this type can give. Every shape that
    /// isn't three integers has to answer `None`, which the caller turns into the
    /// whole "nothing provable" status.
    #[test]
    fn cherry_counts_parse_is_all_three_or_nothing() {
        assert_eq!(parse_cherry_counts("0\t3\t4\n"), Some((0, 3, 4)));
        assert_eq!(parse_cherry_counts(" 1 2 3 "), Some((1, 2, 3)));
        // A trailing field is ignored — git prints exactly three.
        assert_eq!(parse_cherry_counts("1\t2\t3\t9"), Some((1, 2, 3)));
        for bad in [
            "",                 // empty (a silenced failure)
            "0\t3",             // truncated — the fabrication risk
            "not-a-number",     // wrong shape entirely
            "0\tx\t4",          // one unreadable field
            "-1\t2\t3",         // negative can't be a u32 count
            "0\t3\t",           // trailing separator, third field missing
        ] {
            assert_eq!(
                parse_cherry_counts(bad),
                None,
                "{bad:?} must not yield counts"
            );
        }
    }

    /// The size gate in front of the patch-id walk, both arms. Building a real
    /// fixture at these scales costs far more than the seam is worth, so the
    /// thresholds are pinned on the parse that reads them; the spawn feeding it is
    /// a plain `rev-list --left-right --count`, whose two-integer shape this
    /// mirrors. An unreadable reply must gate OUT, matching the "never guess"
    /// direction the counts parse takes.
    ///
    /// The asymmetry is the point: a big REMOTE side must stay admissible, because
    /// that is the motivating shape (a branch forked far back, rebased by the
    /// remote) — a combined bound would refuse exactly the case the feature exists
    /// for.
    #[test]
    fn divergence_gate_bounds_the_local_side_for_copy_and_the_sum_for_cost() {
        // The reported scenario: 3 local commits, ~253 remote. Must be ADMITTED.
        assert!(
            !divergence_out_of_range("3\t253", 200, 1000),
            "a far-forked branch the remote rebased is the motivating case, not an \
             excluded one"
        );
        assert!(!divergence_out_of_range("200\t800", 200, 1000), "both at the limits runs");
        assert!(!divergence_out_of_range("0\t0", 200, 1000), "in sync runs");

        // Copy bound: the LOCAL side is the N in "all N commits are already upstream".
        assert!(
            divergence_out_of_range("201\t0", 200, 1000),
            "one local commit past the copy bound gates out"
        );
        // Cost bound: the sum alone, regardless of how one-sided it is.
        assert!(
            divergence_out_of_range("1\t1000", 200, 1000),
            "one commit past the total cost bound gates out"
        );
        assert!(
            !divergence_out_of_range("1\t999", 200, 1000),
            "and just inside it still runs"
        );

        for bad in ["", "x\t1", "12", "not a count"] {
            assert!(
                divergence_out_of_range(bad, 200, 1000),
                "{bad:?} is unreadable and must gate out"
            );
        }
    }

    /// `git_branch_merge_states` answers a SHAPE, never an error: a name the branch
    /// gate refuses reads as `merged: false, head_exists: false`. The rows that
    /// discriminate are the ones `rev-parse --verify refs/heads/<name>` RESOLVES
    /// (`feature~1`, `<base>^`, `feature^{commit}`) — ungated, those report a live
    /// branch and an ancestor-merged verdict for a ref no branch is at.
    #[tokio::test]
    async fn branch_merge_states_refuse_rev_expressions_as_unmerged_and_absent() {
        let (_base, base_dir) = temp_base("merge-states-revs");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;

        // Two commits on the base branch, so `<base>^` resolves; `landed` sits at
        // that tip (merged), `feature` one commit past it (not merged).
        let base = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        std::fs::write(repo.join("a.txt"), "second\n").unwrap();
        run(&repo_s, &["commit", "-qam", "second"]).await;
        run(&repo_s, &["branch", "landed"]).await;
        run(&repo_s, &["switch", "-qc", "feature"]).await;
        std::fs::write(repo.join("a.txt"), "feature\n").unwrap();
        run(&repo_s, &["commit", "-qam", "feature edit"]).await;
        run(&repo_s, &["switch", "-q", &base]).await;

        let pair = |b: &str, h: &str| MergePair {
            base: b.to_string(),
            head: h.to_string(),
        };
        // The probe itself works: a merged branch and an unmerged one, both live.
        let states = git_branch_merge_states(
            repo_s.clone(),
            vec![pair(&base, "landed"), pair(&base, "feature")],
        )
        .await
        .expect("real pairs resolve");
        assert_eq!((states[0].merged, states[0].head_exists), (true, true));
        assert_eq!((states[1].merged, states[1].head_exists), (false, true));

        // HEAD side: every rev shape and refspec metacharacter reads absent.
        for head in [
            "feature~1",
            &format!("{base}^"),
            "feature^{commit}",
            "HEAD@{1}",
            &format!("{base}..feature"),
            "@",
            "a*b",
            "a:b",
        ] {
            let states = git_branch_merge_states(repo_s.clone(), vec![pair(&base, head)])
                .await
                .expect("a refused name is a shape, not an error");
            assert_eq!(
                (states[0].merged, states[0].head_exists),
                (false, false),
                "head {head:?}"
            );
        }

        // BASE side: the head stays live, but nothing may be reported merged INTO a
        // rev expression. `feature~1` and `feature^{commit}` both have `landed` as
        // an ancestor, so an ungated base flips `merged` to true.
        for bad_base in ["feature~1", "feature^{commit}", "@", "a*b"] {
            let states = git_branch_merge_states(repo_s.clone(), vec![pair(bad_base, "landed")])
                .await
                .expect("a refused base is a shape, not an error");
            assert_eq!(
                (states[0].merged, states[0].head_exists),
                (false, true),
                "base {bad_base:?}"
            );
        }
    }

    /// The branch-first read: an unambiguous branch keeps its name, a shadowed one
    /// becomes its full ref, and names of no local branch pass through untouched.
    #[tokio::test]
    async fn branch_first_rev_qualifies_only_a_shadowed_branch() {
        let (_base, base_dir) = temp_base("branch-first-rev");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "plain"]).await;
        run(&repo_s, &["branch", "shadowed"]).await;
        run(&repo_s, &["tag", "shadowed"]).await;
        run(&repo_s, &["tag", "v1"]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        // A branch literally named `refs/heads/plain` must not capture that full ref.
        run(
            &repo_s,
            &["update-ref", "refs/heads/refs/heads/plain", "HEAD"],
        )
        .await;

        let mut got = Vec::new();
        for name in [
            "plain",
            "shadowed",
            "v1",
            "origin/main",
            "HEAD~0",
            "nope",
            "refs/heads/plain",
        ] {
            got.push(super::branch_first_rev(&repo_s, name).await);
        }
        assert_eq!(
            got,
            [
                "plain",
                "refs/heads/shadowed",
                "v1",
                "origin/main",
                "HEAD~0",
                "nope",
                "refs/heads/plain"
            ]
        );
    }

    /// A local PR's head is measured as the BRANCH: a same-named tag already merged
    /// into the base must not report an unmerged branch as merged.
    #[tokio::test]
    async fn branch_merge_states_measure_a_head_shadowed_by_a_tag() {
        let (_base, base_dir) = temp_base("merge-states-shadow");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        let base = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["tag", "feature"]).await;
        run(&repo_s, &["switch", "-qc", "feature"]).await;
        std::fs::write(repo.join("a.txt"), "feature\n").unwrap();
        run(&repo_s, &["commit", "-qam", "feature edit"]).await;
        run(&repo_s, &["switch", "-q", &base]).await;

        let states = git_branch_merge_states(
            repo_s.clone(),
            vec![MergePair {
                base: base.clone(),
                head: "feature".into(),
            }],
        )
        .await
        .unwrap();
        assert_eq!((states[0].merged, states[0].head_exists), (false, true));
    }

    /// The throwaway checkout is minted as a direct child of the SAME root the marker
    /// guards read, with a unique `gd-update-` name — which is what keeps it out of the
    /// worktree manager and inside `is_managed_update_worktree`'s scope. That root being
    /// the app-data one in production is `root_for`'s non-test arm, pinned by
    /// `ops::worktree_root_dir_uses_the_shipped_bundle_identifier`. Shape only: resolving
    /// a path creates nothing.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // root override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_worktree_path_sits_directly_under_the_marker_root() {
        use crate::git::update_marker as marker;
        let (_temp, root) = temp_base("mint-root");
        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);

        let repo = "C:\\repos\\app";
        let first = update_worktree_path(repo).await.expect("update path resolves");
        assert_eq!(first.parent(), Some(root.as_path()));
        let name = first
            .file_name()
            .and_then(|s| s.to_str())
            .expect("the mint has a basename");
        assert!(name.starts_with("gd-update-"), "{name}");
        assert!(
            marker::is_managed_update_worktree(repo, &first.to_string_lossy()).await,
            "the mint must land inside the scope its own guards enforce"
        );
        assert_ne!(
            first,
            update_worktree_path(repo).await.expect("update path resolves"),
            "two mints in one process must not collide"
        );
    }

    /// `update_branch_from` merges into `refs/heads/<branch>` and merges `<base>`,
    /// so both must name a BRANCH: a rev expression would resolve and merge an
    /// ancestor. Asserts the gate's MESSAGE — the function raises `InvalidArgument`
    /// for a self-update too, which a variant-only match could not tell apart.
    #[tokio::test]
    async fn update_branch_from_rejects_rev_expressions_on_both_sides() {
        let (_base, base_dir) = temp_base("update-from-revs");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "feature"]).await;

        let state = AppState::default();
        for bad in [
            "feature~1",
            "main^",
            "HEAD@{1}",
            "main..other",
            "a^{commit}",
            "@",
            "a*b",
        ] {
            for (branch, base) in [(bad, "feature"), ("feature", bad)] {
                let err = update_branch_from(&state, &repo_s, branch, base, &HashSet::new(), None)
                    .await
                    .unwrap_err();
                assert!(
                    matches!(&err, AppError::InvalidArgument(m) if m.contains("invalid branch name")),
                    "{branch:?} from {base:?} got: {err:?}"
                );
            }
        }
    }

    /// Updating the CURRENT branch merges in place even when a tag shares its name;
    /// missing that arm sends the update to a throwaway checkout of a branch that is
    /// already checked out here.
    #[tokio::test]
    async fn update_branch_from_merges_a_current_branch_shadowed_by_a_tag_in_place() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-tag-shadow").await;
        run(&repo_s, &["switch", "-q", "feature"]).await;
        run(&repo_s, &["tag", "feature"]).await;

        let state = AppState::default();
        let outcome = update_branch_from(&state, &repo_s, "feature", &main, &HashSet::new(), None)
            .await
            .expect("the in-place merge succeeds");
        assert_eq!(outcome.outcome, "merge");
        assert_eq!(
            run(&repo_s, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/feature"
        );
        assert!(
            repo.join("base.txt").exists(),
            "the base's work is merged in"
        );
    }

    /// An unborn current branch is still refused: `symbolic-ref` names it, but there
    /// is nothing to merge INTO, and an in-place merge would quietly adopt `base`'s
    /// history as the branch's first commit.
    #[tokio::test]
    async fn update_branch_from_refuses_an_unborn_current_branch() {
        let (_base, base_dir) = temp_base("update-unborn");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        run(&repo_s, &["symbolic-ref", "HEAD", "refs/heads/fresh"]).await;
        // A commit for `other` alone, written without moving HEAD off its unborn branch.
        let tree = run(&repo_s, &["write-tree"]).await.trim().to_string();
        let commit = run(&repo_s, &["commit-tree", &tree, "-m", "other"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["update-ref", "refs/heads/other", &commit]).await;

        let state = AppState::default();
        update_branch_from(&state, &repo_s, "fresh", "other", &HashSet::new(), None)
            .await
            .expect_err("an unborn branch has nothing to update");
        let head = run_git_raw(
            Some(&repo_s),
            &["rev-parse", "--verify", "-q", "HEAD"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_ne!(head.code, 0, "HEAD is still unborn");
    }

    /// A repo whose `feature` branch has diverged from the default branch — each side
    /// adds a file the other doesn't have, so the merge itself succeeds. Returns the
    /// temp guard, the repo directory, its path as a string, and the default branch.
    async fn diverged_repo(tag: &str) -> (tempfile::TempDir, std::path::PathBuf, String, String) {
        let (guard, base_dir) = temp_base(tag);
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "seed.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        run(&repo_s, &["switch", "-qc", "feature"]).await;
        std::fs::write(repo.join("feature.txt"), "feature\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "feature work"]).await;

        run(&repo_s, &["switch", "-q", &main]).await;
        std::fs::write(repo.join("base.txt"), "base\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "base work"]).await;

        (guard, repo, repo_s, main)
    }

    /// The window the admin prologue opens: while the throwaway worktree materializes,
    /// nothing holds the working-tree lock, so `branch` can move under the update. The
    /// tip pinned before that window is what catches it — a mismatch refuses, leaves
    /// the ref where it stands, and still tears the worktree down.
    #[tokio::test]
    async fn update_branch_from_refuses_a_branch_that_moved_under_it() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-stale-pin").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let base_sha = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("stale-pin-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        // A real commit that simply isn't feature's tip — the shape a branch someone
        // moved mid-update leaves behind.
        let err = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &UpdatePins {
                branch_tip: base_sha.clone(),
                base_sha,
            },
            None,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m) if m.contains("moved while this update was running")),
            "{err:?}"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "a refused update leaves the branch exactly where it was"
        );
        let list = run(&repo_s, &["worktree", "list", "--porcelain"]).await;
        assert_worktree_unregistered(&list, &repo, "stale-pin-wt");
        assert!(!tmp.exists(), "and its directory is gone");
    }

    /// The three cheap arms touch no worktree admin, so a removal holding that domain
    /// must not delay them. A zero budget takes the FREE admin lock deterministically
    /// and refuses a held one.
    #[tokio::test]
    async fn cheap_update_arms_run_while_the_worktree_admin_domain_is_held() {
        let (_guard, _repo, repo_s, main) = diverged_repo("update-admin-free").await;
        run(&repo_s, &["branch", "level", &main]).await;
        run(&repo_s, &["branch", "behind", &format!("{main}~1")]).await;

        let state = AppState::default();
        let _admin = acquire_repo_lock(
            &state.worktree_admin_lock(&repo_s).await,
            Duration::ZERO,
            "a worktree removal",
        )
        .await
        .expect("the admin domain is free");

        assert_eq!(
            update_branch_from(&state, &repo_s, "level", &main, &HashSet::new(), None)
                .await
                .expect("up-to-date needs no worktree")
                .outcome,
            "up-to-date"
        );
        assert_eq!(
            update_branch_from(&state, &repo_s, "behind", &main, &HashSet::new(), None)
                .await
                .expect("a fast-forward needs no worktree")
                .outcome,
            "fast-forward"
        );
        // Last, since it moves the default branch: `branch == current` merges in place.
        assert_eq!(
            update_branch_from(&state, &repo_s, &main, "feature", &HashSet::new(), None)
                .await
                .expect("an in-place merge needs no worktree")
                .outcome,
            "merge"
        );
    }

    // --- Every update arm reads `branch` and `base` as BRANCHES. A same-named tag on
    // another commit would otherwise win each rev position (gitrevisions checks
    // refs/tags before refs/heads), and `fetch .` resolves its source the same way.

    /// The in-place arm merges the base BRANCH, never a same-named tag behind it.
    #[tokio::test]
    async fn update_in_place_merges_the_base_branch_not_its_tag() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-in-place-base-tag").await;
        run(&repo_s, &["tag", &main, "HEAD~1"]).await;
        run(&repo_s, &["switch", "-q", "feature"]).await;

        let state = AppState::default();
        let outcome = update_branch_from(&state, &repo_s, "feature", &main, &HashSet::new(), None)
            .await
            .expect("the in-place merge succeeds");
        assert_eq!(outcome.outcome, "merge");
        assert!(
            repo.join("base.txt").exists(),
            "the base branch's work is merged in"
        );
    }

    /// An in-place update that brings nothing in says so, whatever `merge.ff` says,
    /// and leaves HEAD where it was.
    #[tokio::test]
    async fn update_in_place_reports_up_to_date_when_nothing_is_merged() {
        for ff in ["true", "false"] {
            let (_guard, _repo, repo_s, main) = diverged_repo("update-in-place-current").await;
            run(&repo_s, &["config", "merge.ff", ff]).await;
            run(&repo_s, &["branch", "older", &format!("{main}~1")]).await;
            let before = run(&repo_s, &["rev-parse", "HEAD"]).await;

            let state = AppState::default();
            let outcome =
                update_branch_from(&state, &repo_s, &main, "older", &HashSet::new(), None)
                    .await
                    .expect("an in-place update of a current branch succeeds");
            assert_eq!(outcome.outcome, "up-to-date", "merge.ff={ff}");
            assert_eq!(
                run(&repo_s, &["rev-parse", "HEAD"]).await,
                before,
                "merge.ff={ff}: no commit is made"
            );
        }
    }

    /// A current branch strictly behind `base` reports what git did: a fast-forward
    /// under `merge.ff=true`, a merge commit under `merge.ff=false`.
    #[tokio::test]
    async fn update_in_place_reports_the_fast_forward_or_merge_git_made() {
        for (ff, expected) in [("true", "fast-forward"), ("false", "merge")] {
            let (_guard, _repo, repo_s, main) = diverged_repo("update-in-place-behind").await;
            run(&repo_s, &["config", "merge.ff", ff]).await;
            let base_tip = run(&repo_s, &["rev-parse", "HEAD"])
                .await
                .trim()
                .to_string();
            run(&repo_s, &["switch", "-qc", "behind", &format!("{main}~1")]).await;

            let state = AppState::default();
            let outcome =
                update_branch_from(&state, &repo_s, "behind", &main, &HashSet::new(), None)
                    .await
                    .expect("an in-place update of a current branch succeeds");
            assert_eq!(outcome.outcome, expected, "merge.ff={ff}");
            let head = run(&repo_s, &["rev-parse", "HEAD"])
                .await
                .trim()
                .to_string();
            if expected == "fast-forward" {
                assert_eq!(head, base_tip, "the branch sits on base's tip");
            } else {
                assert_ne!(head, base_tip, "git made a merge commit");
                assert_eq!(
                    run(&repo_s, &["rev-parse", "HEAD^2"]).await.trim(),
                    base_tip,
                    "whose second parent is base's tip"
                );
            }
        }
    }

    /// Only two successful reads may claim "up-to-date" or "fast-forward".
    #[test]
    fn update_in_place_outcome_keeps_merge_on_a_failed_read() {
        use super::in_place_outcome as outcome;
        assert_eq!(outcome(Some("a"), Some("a"), Some("b")), "up-to-date");
        assert_eq!(outcome(Some("a"), Some("b"), Some("b")), "fast-forward");
        assert_eq!(outcome(Some("a"), Some("c"), Some("b")), "merge");
        assert_eq!(outcome(None, Some("a"), Some("a")), "merge");
        assert_eq!(outcome(Some("a"), None, None), "merge");
        assert_eq!(outcome(Some("a"), Some("b"), None), "merge");
    }

    /// The up-to-date probe: a base tag that IS an ancestor of the branch must not
    /// report a branch that lacks the base's work as already up to date.
    #[tokio::test]
    async fn update_up_to_date_probe_reads_the_base_branch_not_its_tag() {
        let (_guard, _repo, repo_s, main) = diverged_repo("update-uptodate-base-tag").await;
        let main_tip = run(&repo_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["branch", "behind", "HEAD~1"]).await;
        run(&repo_s, &["tag", &main, "HEAD~1"]).await;

        let state = AppState::default();
        assert_eq!(
            update_branch_from(&state, &repo_s, "behind", &main, &HashSet::new(), None)
                .await
                .expect("the update succeeds")
                .outcome,
            "fast-forward"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/behind"])
                .await
                .trim(),
            main_tip
        );
    }

    /// The fast-forward probe: a tag named like the BRANCH, off the base's history,
    /// must not turn a plain fast-forward into a merge.
    #[tokio::test]
    async fn update_fast_forward_probe_reads_the_branch_not_its_tag() {
        let (_guard, _repo, repo_s, main) = diverged_repo("update-ff-branch-tag").await;
        let main_tip = run(&repo_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["branch", "behind", "HEAD~1"]).await;
        run(&repo_s, &["tag", "behind", "refs/heads/feature"]).await;

        let state = AppState::default();
        assert_eq!(
            update_branch_from(&state, &repo_s, "behind", &main, &HashSet::new(), None)
                .await
                .expect("the update succeeds")
                .outcome,
            "fast-forward"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/behind"])
                .await
                .trim(),
            main_tip
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/tags/behind"]).await,
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await,
            "the tag is never moved"
        );
    }

    /// The fast-forward MOVE: `fetch .` resolves its source tag-first too, so a base
    /// tag between the branch and the base tip would land the branch on the tag.
    #[tokio::test]
    async fn update_fast_forward_moves_to_the_base_branch_not_its_tag() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-ff-base-tag").await;
        run(&repo_s, &["branch", "behind", "HEAD~1"]).await;
        run(&repo_s, &["tag", &main]).await;
        std::fs::write(repo.join("more.txt"), "more\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "more base work"]).await;
        let main_tip = run(&repo_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();

        let state = AppState::default();
        assert_eq!(
            update_branch_from(&state, &repo_s, "behind", &main, &HashSet::new(), None)
                .await
                .expect("the update succeeds")
                .outcome,
            "fast-forward"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/behind"])
                .await
                .trim(),
            main_tip
        );
    }

    /// The diverged arm: the base pin, its re-check and the throwaway merge all read
    /// the base BRANCH. A same-named tag on an unrelated side commit would otherwise be
    /// what lands on the branch.
    // The serializing guard MUST span the awaits — it keeps the process-wide root
    // override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_diverged_merge_takes_the_base_branch_not_its_tag() {
        use crate::git::update_marker as marker;
        let (_guard, repo, repo_s, main) = diverged_repo("update-diverged-base-tag").await;
        run(&repo_s, &["switch", "-qc", "side", "HEAD~1"]).await;
        std::fs::write(repo.join("side.txt"), "side\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "side work"]).await;
        run(&repo_s, &["tag", &main]).await;
        run(&repo_s, &["switch", "-q", &main]).await;
        let root = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        // A name no other test uses: the override root is process-wide.
        run(&repo_s, &["branch", "-m", "feature", "update-base-tag"]).await;

        let state = AppState::default();
        assert_eq!(
            update_branch_from(
                &state,
                &repo_s,
                "update-base-tag",
                &main,
                &HashSet::new(),
                None
            )
            .await
            .expect("the update succeeds")
            .outcome,
            "merge"
        );
        let files = run(
            &repo_s,
            &["ls-tree", "--name-only", "refs/heads/update-base-tag"],
        )
        .await;
        assert!(
            files.contains("base.txt"),
            "the base branch is merged: {files}"
        );
        assert!(
            !files.contains("side.txt"),
            "the tag's commit is not: {files}"
        );
    }

    // --- "Update from <default>" sends the default's `%(upstream:short)` as `base`
    // when the local default is behind it, so a remote-tracking base reaches every arm.

    /// Mints `refs/remotes/origin/<main>` one commit AHEAD of local `main` (a new
    /// `remote.txt`), as a fetch would, leaving `main` where it is. Returns its sha.
    async fn mint_origin_ahead(repo: &std::path::Path, repo_s: &str, main: &str) -> String {
        run(repo_s, &["switch", "-qc", "remote-tip", main]).await;
        std::fs::write(repo.join("remote.txt"), "remote\n").unwrap();
        run(repo_s, &["add", "-A"]).await;
        run(repo_s, &["commit", "-qm", "remote work"]).await;
        let sha = run(repo_s, &["rev-parse", "HEAD"]).await.trim().to_string();
        run(
            repo_s,
            &["update-ref", &format!("refs/remotes/origin/{main}"), &sha],
        )
        .await;
        run(repo_s, &["switch", "-q", main]).await;
        run(repo_s, &["branch", "-qD", "remote-tip"]).await;
        sha
    }

    /// The fast-forward arm (`fetch .`) of a branch that is NOT checked out takes a
    /// remote-tracking base, and the local default stays where it was.
    #[tokio::test]
    async fn update_branch_from_accepts_a_remote_tracking_base() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-remote-ff").await;
        run(&repo_s, &["branch", "behind", "HEAD~1"]).await;
        let main_tip = run(&repo_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        let remote = mint_origin_ahead(&repo, &repo_s, &main).await;

        let state = AppState::default();
        let base = format!("origin/{main}");
        let outcome = update_branch_from(&state, &repo_s, "behind", &base, &HashSet::new(), None)
            .await
            .expect("the update succeeds");
        assert_eq!(outcome.outcome, "fast-forward");
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/behind"])
                .await
                .trim(),
            remote,
            "the branch lands on the remote-tracking tip"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", &main]).await.trim(),
            main_tip,
            "the local default is never moved"
        );
    }

    /// The in-place arm merges the remote-tracking tip into the checked-out branch.
    #[tokio::test]
    async fn update_branch_from_remote_tracking_base_merges_in_place() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-remote-in-place").await;
        let remote = mint_origin_ahead(&repo, &repo_s, &main).await;
        run(&repo_s, &["switch", "-q", "feature"]).await;

        let state = AppState::default();
        let base = format!("origin/{main}");
        let outcome = update_branch_from(&state, &repo_s, "feature", &base, &HashSet::new(), None)
            .await
            .expect("the in-place merge succeeds");
        assert_eq!(outcome.outcome, "merge");
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature^2"])
                .await
                .trim(),
            remote,
            "the merge's second parent is the remote-tracking tip"
        );
        assert!(repo.join("remote.txt").exists(), "its work is merged in");
    }

    /// The up-to-date probe reads the remote-tracking ref: a branch that contains it
    /// is up to date even though it lacks the local default's newer commit.
    #[tokio::test]
    async fn update_branch_from_up_to_date_against_remote_tracking_base() {
        let (_guard, _repo, repo_s, main) = diverged_repo("update-remote-uptodate").await;
        let seed = run(&repo_s, &["rev-parse", "HEAD~1"])
            .await
            .trim()
            .to_string();
        run(
            &repo_s,
            &["update-ref", &format!("refs/remotes/origin/{main}"), &seed],
        )
        .await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();

        let state = AppState::default();
        let base = format!("origin/{main}");
        let outcome = update_branch_from(&state, &repo_s, "feature", &base, &HashSet::new(), None)
            .await
            .expect("the update succeeds");
        assert_eq!(outcome.outcome, "up-to-date");
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"])
                .await
                .trim(),
            feature_tip
        );
    }

    /// A LOCAL branch literally named `origin/<main>` would capture the short form, so
    /// git reports the upstream disambiguated (`remotes/origin/<main>`) and the UI
    /// sends that string verbatim. Exercises the fast-forward arm of a branch that is
    /// not checked out: the branch lands on the remote-tracking tip, never on the
    /// local look-alike's (which it could fast-forward to as well).
    #[tokio::test]
    async fn update_branch_from_base_is_not_captured_by_a_local_branch() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-remote-shadowed").await;
        let remote = mint_origin_ahead(&repo, &repo_s, &main).await;
        // Never contacted: the remote exists only so the upstream resolves.
        let nowhere = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("origin.git");
        run(
            &repo_s,
            &["remote", "add", "origin", &nowhere.to_string_lossy()],
        )
        .await;
        run(&repo_s, &["branch", "tracker", "HEAD~1"]).await;
        run(
            &repo_s,
            &[
                "branch",
                "-q",
                &format!("--set-upstream-to=origin/{main}"),
                "tracker",
            ],
        )
        .await;
        async fn upstream_short(repo_s: &str) -> String {
            run(
                repo_s,
                &[
                    "for-each-ref",
                    "--format=%(upstream:short)",
                    "refs/heads/tracker",
                ],
            )
            .await
            .trim()
            .to_string()
        }
        assert_eq!(upstream_short(&repo_s).await, format!("origin/{main}"));
        run(
            &repo_s,
            &["branch", &format!("origin/{main}"), "refs/heads/feature"],
        )
        .await;
        let lookalike = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        // The premise: the short form git reports once the local branch exists.
        let base = upstream_short(&repo_s).await;
        assert_eq!(base, format!("remotes/origin/{main}"));

        let state = AppState::default();
        let outcome = update_branch_from(&state, &repo_s, "tracker", &base, &HashSet::new(), None)
            .await
            .expect("the update succeeds");
        assert_eq!(outcome.outcome, "fast-forward");
        let tip = run(&repo_s, &["rev-parse", "refs/heads/tracker"])
            .await
            .trim()
            .to_string();
        assert_eq!(tip, remote, "the remote-tracking tip is what lands");
        assert_ne!(tip, lookalike, "never the local look-alike's tip");
        assert_eq!(
            run(
                &repo_s,
                &["rev-parse", &format!("refs/heads/origin/{main}")]
            )
            .await
            .trim(),
            lookalike,
            "the look-alike branch is never moved"
        );
    }

    /// [`diverged_repo`]'s conflicting twin: both branches rewrite the SAME line of the
    /// seed file, so their merge stops with unmerged entries instead of succeeding.
    async fn conflicting_repo(tag: &str) -> (tempfile::TempDir, std::path::PathBuf, String, String) {
        let (guard, base_dir) = temp_base(tag);
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "seed.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        run(&repo_s, &["switch", "-qc", "feature"]).await;
        std::fs::write(repo.join("seed.txt"), "feature side\n").unwrap();
        run(&repo_s, &["commit", "-qam", "feature edit"]).await;

        run(&repo_s, &["switch", "-q", &main]).await;
        std::fs::write(repo.join("seed.txt"), "main side\n").unwrap();
        run(&repo_s, &["commit", "-qam", "main edit"]).await;

        (guard, repo, repo_s, main)
    }

    /// The diverged path's conflict arm. The merge happens in the throwaway worktree,
    /// so the user's checkout never sees it and the branch ref stays put — the refusal
    /// is the whole outcome, and it has to name the remedy that does apply.
    #[tokio::test]
    async fn a_diverged_update_refuses_a_conflicting_merge_and_leaves_the_branch() {
        let (_guard, repo, repo_s, main) = conflicting_repo("update-conflict").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("conflict-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        let err = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &UpdatePins {
                branch_tip: feature_tip.clone(),
                base_sha: pinned_base,
            },
            None,
        )
        .await
        .unwrap_err();
        let AppError::InvalidArgument(message) = &err else {
            panic!("a conflicting merge must take the conflict refusal: {err:?}");
        };
        assert_eq!(
            message,
            &format!(
                "feature has changes that conflict with {main}. \
                 Switch to feature to merge and resolve them."
            )
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "the abort leaves the branch exactly where it was"
        );
        let list = run(&repo_s, &["worktree", "list", "--porcelain"]).await;
        assert_worktree_unregistered(&list, &repo, "conflict-wt");
        assert!(!tmp.exists(), "and its directory is gone");
    }

    /// The case an exit-code verdict gets wrong: a `pre-merge-commit` hook that
    /// declines exits 1 — the conflict's code — with the auto-merge clean and nothing
    /// unmerged. Hooks resolve from the COMMON dir, so the main repo's hook runs inside
    /// the throwaway worktree. A hook that failed to fire trips the sentinel assertion
    /// below rather than passing as a clean merge.
    #[tokio::test]
    async fn a_declined_merge_hook_is_not_reported_as_a_conflict() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-declined-hook").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        let base_dir = repo.parent().expect("the repo lives under the temp base");
        // The hook stamps a sentinel before declining, so a host `core.hooksPath` that
        // suppressed it fails this test by its real cause rather than as a merge that
        // unexpectedly succeeded. Forward slashes: the script runs under `sh`, where a
        // Windows backslash is an escape character.
        let sentinel = base_dir.join("hook-fired");
        let hook = repo.join(".git").join("hooks").join("pre-merge-commit");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\necho fired > \"{}\"\nexit 1\n",
                sentinel.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        // git IGNORES a hook without the executable bit on POSIX, which would let the
        // merge succeed and leave this test asserting nothing.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let tmp = base_dir.join("declined-hook-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        let result = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &UpdatePins {
                branch_tip: feature_tip.clone(),
                base_sha: pinned_base,
            },
            None,
        )
        .await;
        assert!(
            sentinel.exists(),
            "the pre-merge-commit hook never fired — check core.hooksPath"
        );
        let err = result.expect_err("the declined hook stops the merge");
        let AppError::Command(message) = &err else {
            panic!("a clean auto-merge must never be reported as a conflict: {err:?}");
        };
        assert!(
            message.starts_with(&format!("merging {main} into feature failed")),
            "{message}"
        );
        assert!(
            message.contains("Not committing merge"),
            "git's own report rides along: {message}"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "the abort leaves the branch exactly where it was"
        );
        let list = run(&repo_s, &["worktree", "list", "--porcelain"]).await;
        assert_worktree_unregistered(&list, &repo, "declined-hook-wt");
        assert!(!tmp.exists(), "and its directory is gone");
    }

    /// A merge that fails for a reason other than a conflict must not claim one: the
    /// conflict wording names a remedy — switch and resolve — that a hook, a timeout
    /// or unrelated histories give the user no way to act on. Unrelated histories are
    /// the deterministic shape: git refuses before merging anything, so the index has
    /// no unmerged entries and the verdict falls to the report-carrying refusal.
    #[tokio::test]
    async fn a_failed_merge_that_is_not_a_conflict_carries_gits_own_report() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-merge-failure").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();

        // An orphan branch shares no history with `feature`, so git refuses the merge
        // outright rather than conflicting.
        run(&repo_s, &["switch", "-q", "--orphan", "alien"]).await;
        std::fs::write(repo.join("alien.txt"), "alien\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "alien root"]).await;
        let alien_tip = run(&repo_s, &["rev-parse", "refs/heads/alien"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["switch", "-q", &main]).await;

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("merge-failure-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        let err = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            "alien",
            &UpdatePins {
                branch_tip: feature_tip.clone(),
                base_sha: alien_tip,
            },
            None,
        )
        .await
        .unwrap_err();
        let AppError::Command(message) = &err else {
            panic!("a non-conflict failure must not be the conflict refusal: {err:?}");
        };
        assert!(
            message.starts_with("merging alien into feature failed"),
            "{message}"
        );
        assert!(
            message.contains("refusing to merge unrelated histories"),
            "git's own report rides along: {message}"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "a failed merge leaves the branch exactly where it was"
        );
        assert!(!tmp.exists(), "the throwaway worktree is torn down");
    }

    /// The base's half of the pin, on its refusing side. Merging by NAME is what keeps
    /// git's own merge subject, so the sha the name resolves to has to be checked — a
    /// base whose pinned commit is no longer an ancestor is a different operation than
    /// the one the user asked for, and is refused rather than quietly merged.
    #[tokio::test]
    async fn a_diverged_update_refuses_a_base_rewritten_under_it() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-rewritten-base").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        // `--amend` REPLACES the base tip rather than advancing it, so the pinned
        // commit stops being an ancestor — the only move that invalidates the plan.
        run(&repo_s, &["commit", "-q", "--amend", "-m", "base work, reworded"]).await;
        let moved_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();
        assert_ne!(pinned_base, moved_base, "the fixture must rewrite the base");

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("moved-base-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        let err = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &UpdatePins {
                branch_tip: feature_tip.clone(),
                base_sha: pinned_base,
            },
            None,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with(&format!("{main} moved while this update was running"))),
            "{err:?}"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "a refused update leaves the branch exactly where it was"
        );
        let list = run(&repo_s, &["worktree", "list", "--porcelain"]).await;
        assert_worktree_unregistered(&list, &repo, "moved-base-wt");
        assert!(!tmp.exists(), "and its directory is gone");
    }

    /// A base that stops resolving was deleted, not moved: phase 1 resolved the name,
    /// so "try again to see where it stands" would point the user at a retry that
    /// cannot succeed. Paired with the rewritten-base test, which keeps the "moved"
    /// wording, so the two messages discriminate. Driven at the predicate, because a
    /// base deleted mid-window is not a schedulable event.
    #[tokio::test]
    async fn a_diverged_update_reports_a_base_deleted_under_it() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-deleted-base").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        // HEAD has to leave the base branch before git will delete it.
        run(&repo_s, &["switch", "-qc", "spare"]).await;
        run(&repo_s, &["branch", "-D", &main]).await;

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("deleted-base-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        let err = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &UpdatePins {
                branch_tip: feature_tip.clone(),
                base_sha: pinned_base,
            },
            None,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with(&format!("{main} was deleted while this update was running"))),
            "{err:?}"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "a refused update leaves the branch exactly where it was"
        );
        let list = run(&repo_s, &["worktree", "list", "--porcelain"]).await;
        assert_worktree_unregistered(&list, &repo, "deleted-base-wt");
        assert!(!tmp.exists(), "and its directory is gone");
    }

    /// The base's tolerant side. The app's own auto-fetch advances a remote-tracking
    /// base while the throwaway worktree materializes, and a base that only
    /// fast-forwarded is what a fresh update would merge — refusing it would make
    /// "Update from origin/…" intermittently unusable on an active repo.
    #[tokio::test]
    async fn a_diverged_update_tolerates_a_base_that_fast_forwarded() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-ff-base").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        // The base gains a commit after the pin — a fast-forward, the shape a fetch
        // of a moving remote-tracking branch leaves behind.
        std::fs::write(repo.join("later.txt"), "later\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "base work later"]).await;
        let moved_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();
        assert_ne!(pinned_base, moved_base, "the fixture must move the base");

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("ff-base-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        let outcome = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &UpdatePins {
                branch_tip: feature_tip,
                base_sha: pinned_base,
            },
            None,
        )
        .await
        .expect("a fast-forwarded base still merges");
        assert_eq!(outcome, "merge");

        // Point-of-execution semantics: the NEWER base commit is what landed.
        let merged_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let reachable = run_git_raw(
            Some(&repo_s),
            &["merge-base", "--is-ancestor", &moved_base, &merged_tip],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_eq!(
            reachable.code, 0,
            "the commit the base gained after the pin is in the merge: {}",
            reachable.stderr
        );
        assert!(!tmp.exists(), "the throwaway worktree is torn down");
    }

    /// The happy path: both pins hold, so the merge runs by NAME and the branch gets
    /// git's own `Merge branch '<base>'` subject over the pinned commit.
    #[tokio::test]
    async fn a_diverged_update_merges_the_pinned_base_by_name() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-pinned-base").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("pinned-base-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        let outcome = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &UpdatePins {
                branch_tip: feature_tip,
                base_sha: pinned_base.clone(),
            },
            None,
        )
        .await
        .expect("an unmoved base merges cleanly");
        assert_eq!(outcome, "merge");

        let merged_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let parents = run(&repo_s, &["rev-list", "--parents", "-n", "1", &merged_tip]).await;
        assert!(
            parents.contains(pinned_base.as_str()),
            "the pinned base is a parent of the merge: {parents}"
        );
        // Exit 0 specifically: `is_ancestor` answers 1 for "no", and 128 for a bad
        // argument, so anything but 0 has to fail this.
        let reachable = run_git_raw(
            Some(&repo_s),
            &["merge-base", "--is-ancestor", &pinned_base, &merged_tip],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_eq!(
            reachable.code, 0,
            "the pinned base is reachable from the merge: {}",
            reachable.stderr
        );
        // Merging by name is the whole reason for the base pin: a sha argument would
        // have written `Merge commit '<sha>'` here instead.
        let subject = run(&repo_s, &["log", "-1", "--format=%s", &merged_tip]).await;
        assert!(
            subject.trim().starts_with(&format!("Merge branch '{main}'")),
            "git's own merge subject survives: {subject}"
        );
        assert!(!tmp.exists(), "the throwaway worktree is torn down");
    }

    /// The diverged arm end to end, from the public core: the merge lands on `feature`
    /// while `main` stays checked out, and the update leaves nothing behind — no
    /// checkout, no marker pair, no worktree registration. The regression net for the
    /// whole marker path, every step of which resolves its root asynchronously.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // root override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_diverged_update_leaves_no_trace_in_the_marker_root() {
        use crate::git::update_marker as marker;
        let (_guard, repo, repo_s, main) = diverged_repo("update-e2e").await;
        let root = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();

        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        // A branch name no other test uses: the override root is process-wide, and this
        // test holds a LIVE marker for the length of a real merge, which would refuse a
        // parallel test's guard on a shared name.
        run(&repo_s, &["branch", "-m", "feature", "update-e2e"]).await;

        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/update-e2e"])
            .await
            .trim()
            .to_string();
        let base_tip = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();
        assert_eq!(
            run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
                .await
                .trim(),
            main,
            "the fixture must update a branch that is NOT the current one"
        );

        let state = AppState::default();
        let outcome =
            update_branch_from(&state, &repo_s, "update-e2e", &main, &HashSet::new(), None)
                .await
                .expect("a diverged update merges");
        assert_eq!(outcome.outcome, "merge");

        // A merge commit carrying exactly the two tips the update pinned.
        let merged = run(
            &repo_s,
            &["rev-list", "--parents", "-n", "1", "refs/heads/update-e2e"],
        )
        .await;
        let parents: Vec<&str> = merged.split_whitespace().skip(1).collect();
        assert_eq!(
            parents,
            vec![feature_tip.as_str(), base_tip.as_str()],
            "the updated branch merges its old tip and base, in that order: {merged}"
        );

        let leftovers: Vec<String> = std::fs::read_dir(&root)
            .expect("the marker root is readable")
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|name| name.starts_with("gd-update-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no checkout and no marker pair survive the update: {leftovers:?}"
        );
        assert!(
            !run(&repo_s, &["worktree", "list", "--porcelain"])
                .await
                .contains("gd-update-"),
            "and git holds no registration for it either"
        );
    }

    // --- The holder arm: a branch checked out in ANOTHER checkout is updated inside it.
    // Each test names its branch uniquely, since the marker guards read a process-wide
    // root a concurrently running sibling may have overridden.

    /// A repo whose `branch` is checked out in a LINKED worktree beside it. Returns the
    /// temp guard, the repo path, the default branch, the holder's path, and the holder
    /// as `worktree list --porcelain` spells it.
    async fn held_branch_repo(
        tag: &str,
        branch: &str,
    ) -> (tempfile::TempDir, String, String, String, String) {
        let (guard, base_dir) = temp_base(tag);
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "seed.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        let holder_s = base_dir.join("holder").to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-q", "-b", branch, &holder_s]).await;
        let porcelain = worktree_holding_branch(&repo_s, branch)
            .await
            .expect("the linked worktree holds the branch");
        (guard, repo_s, main, holder_s, porcelain)
    }

    /// Points the marker root, where the holder arm mints its update marker, at a
    /// `worktrees` dir beside `repo`. The guards must span the test's awaits; bound in
    /// order, they drop override first, then the serializing lock.
    fn holder_marker_root(
        repo: &str,
    ) -> (
        std::sync::MutexGuard<'static, ()>,
        crate::git::update_marker::TestRootOverride,
        std::path::PathBuf,
    ) {
        use crate::git::update_marker as marker;
        let root = std::path::Path::new(repo)
            .parent()
            .unwrap()
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let serialized = marker::test_root_lock();
        let installed = marker::TestRootOverride::set(&root);
        (serialized, installed, root)
    }

    /// The `gd-update-*` entries under a marker root: a settled holder update leaves none.
    fn marker_leftovers(root: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(root)
            .expect("the marker root is readable")
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|name| name.starts_with("gd-update-"))
            .collect()
    }

    async fn commit_file(dir: &str, file: &str, body: &str) {
        std::fs::write(std::path::Path::new(dir).join(file), body).unwrap();
        run(dir, &["add", "-A"]).await;
        run(dir, &["commit", "-qm", file]).await;
    }

    async fn tip(repo: &str, branch: &str) -> String {
        branch_tip_sha(repo, branch)
            .await
            .expect("the tip read runs")
            .expect("the branch exists")
    }

    /// Asserts a holder-arm refusal's structured fields, and that its message closes on
    /// the sentence every one of them ends with; returns the message.
    fn expect_branch_held(err: &AppError, reason: &str, holder: &str, branch: &str) -> String {
        let AppError::BranchHeld {
            message,
            holder: named,
            branch: held,
            reason: why,
        } = err
        else {
            panic!("expected a BranchHeld refusal, got {err:?}");
        };
        assert_eq!(
            (why.as_str(), named.as_str(), held.as_str()),
            (reason, holder, branch)
        );
        assert!(
            message.ends_with(&format!("{branch} is unchanged.")),
            "{message}"
        );
        message.clone()
    }

    /// The fast-forward a held branch used to die on (`fetch .` refuses it) runs inside
    /// the holder, and the holder's index and tree advance with its HEAD.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_held_branch_fast_forwards_inside_its_holder() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-ff", "held-ff").await;
        let (_serialized, _override, root) = holder_marker_root(&repo_s);
        commit_file(&repo_s, "base.txt", "base\n").await;
        let main_tip = tip(&repo_s, &main).await;

        let state = AppState::default();
        let outcome = update_branch_from(&state, &repo_s, "held-ff", &main, &HashSet::new(), None)
            .await
            .expect("a held fast-forward succeeds");
        assert_eq!(outcome.outcome, "fast-forward");
        assert_eq!(outcome.holder.as_deref(), Some(porcelain.as_str()));

        assert_eq!(run(&holder, &["rev-parse", "HEAD"]).await.trim(), main_tip);
        assert_eq!(
            run(&holder, &["status", "--porcelain"]).await,
            "",
            "the holder's index and tree advanced with its HEAD"
        );
        assert!(std::path::Path::new(&holder).join("base.txt").exists());
        assert_eq!(
            current_branch_name(&repo_s).await.unwrap(),
            Some(main.clone()),
            "the active checkout stays where it was"
        );
        assert_eq!(tip(&repo_s, &main).await, main_tip);
        assert_eq!(run(&repo_s, &["status", "--porcelain"]).await, "");
        assert!(
            marker_leftovers(&root).is_empty(),
            "the update's marker is settled: {:?}",
            marker_leftovers(&root)
        );
    }

    /// A diverged held branch merges inside a clean, idle holder, titled as the unheld
    /// arms title theirs rather than by the pinned sha.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_held_diverged_branch_merges_inside_a_clean_holder() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-merge", "held-merge").await;
        let (_serialized, _override, root) = holder_marker_root(&repo_s);
        commit_file(&holder, "feature.txt", "feature\n").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let (held_tip, main_tip) = (tip(&repo_s, "held-merge").await, tip(&repo_s, &main).await);

        let state = AppState::default();
        let outcome =
            update_branch_from(&state, &repo_s, "held-merge", &main, &HashSet::new(), None)
                .await
                .expect("a held diverged update merges");
        assert_eq!(outcome.outcome, "merge");
        assert_eq!(outcome.holder.as_deref(), Some(porcelain.as_str()));

        let merged = run(
            &repo_s,
            &["rev-list", "--parents", "-n", "1", "refs/heads/held-merge"],
        )
        .await;
        let parents: Vec<&str> = merged.split_whitespace().skip(1).collect();
        assert_eq!(parents, vec![held_tip.as_str(), main_tip.as_str()]);
        assert_eq!(
            run(
                &repo_s,
                &["log", "-1", "--format=%s", "refs/heads/held-merge"]
            )
            .await
            .trim(),
            format!("Merge branch '{main}' into held-merge")
        );
        assert_eq!(run(&holder, &["status", "--porcelain"]).await, "");
        assert!(std::path::Path::new(&holder).join("base.txt").exists());
        assert!(marker_leftovers(&root).is_empty());
    }

    /// An agent session's worktree is never updated from outside it, matched on the
    /// path exactly as the porcelain spells it.
    #[tokio::test]
    async fn a_branch_held_by_a_session_worktree_is_refused() {
        let (_guard, repo_s, main, _holder, porcelain) =
            held_branch_repo("held-session", "held-session").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let held_tip = tip(&repo_s, "held-session").await;

        let state = AppState::default();
        let sessions = HashSet::from([porcelain.clone()]);
        let err = update_branch_from(&state, &repo_s, "held-session", &main, &sessions, None)
            .await
            .unwrap_err();
        expect_branch_held(&err, "session", &porcelain, "held-session");
        assert_eq!(tip(&repo_s, "held-session").await, held_tip);
    }

    /// The app-data root backstops an app-internal checkout the registry doesn't list (a
    /// lost session entry, a pre-marker hidden update): a holder under it is refused as
    /// a session's, with the registry empty and the branch not `gd/session/*`.
    #[tokio::test]
    async fn a_branch_held_under_the_app_data_root_is_refused() {
        let (_guard, repo_s, main, _holder, porcelain) =
            held_branch_repo("held-app-data", "held-app-data").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let held_tip = tip(&repo_s, "held-app-data").await;
        // The holder's parent in the porcelain's own spelling stands in for the root.
        let parent = std::path::Path::new(&porcelain).parent().unwrap();
        let root = crate::git::worktree::normalize_wt_path(&parent.to_string_lossy());

        let state = AppState::default();
        let err = update_branch_from(
            &state,
            &repo_s,
            "held-app-data",
            &main,
            &HashSet::new(),
            Some(&root),
        )
        .await
        .unwrap_err();
        expect_branch_held(&err, "session", &porcelain, "held-app-data");
        assert_eq!(tip(&repo_s, "held-app-data").await, held_tip);
    }

    /// Each arm of the session match, and the separator that keeps a SIBLING of the
    /// app-data root from passing as inside it.
    #[test]
    fn session_holder_matches_each_arm_but_not_a_root_sibling() {
        let none = HashSet::new();
        let registry = HashSet::from(["C:/S/One".to_string()]);
        let root = Some("c:/app/wts");
        assert!(is_session_holder(r"c:\s\one", "topic", &registry, None));
        assert!(is_session_holder("C:/x", "gd/session/x", &none, None));
        assert!(is_session_holder("C:/x", "GD/Session/x", &none, None));
        assert!(!is_session_holder("C:/x", "wip/gd/session/x", &none, None));
        assert!(!is_session_holder("C:/x", "gd/session", &none, None));
        assert!(is_session_holder("C:/App/wts/h/wt", "topic", &none, root));
        assert!(!is_session_holder("C:/App/wtsx/wt", "topic", &none, root));
        assert!(!is_session_holder("C:/x", "topic", &none, root));
    }

    /// A holder that merged the base and committed between the first read and its lock says
    /// "up-to-date", not git's no-op dressed as an update. Driven through the holder arm
    /// directly, since the outer read would already answer it.
    #[tokio::test]
    async fn a_holder_already_containing_the_base_reports_up_to_date() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-current", "held-current").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let base_sha = tip(&repo_s, &main).await;
        run(&holder, &["merge", "-q", "--ff-only", &base_sha]).await;
        commit_file(&holder, "more.txt", "more\n").await;
        let held_tip = tip(&repo_s, "held-current").await;

        let state = AppState::default();
        for merge in [
            HolderMerge::FastForward,
            HolderMerge::Merge { subject: None },
        ] {
            let outcome =
                update_in_holder(&state, &porcelain, "held-current", &main, &base_sha, merge)
                    .await
                    .expect("a holder already containing the base is not an error");
            assert_eq!(outcome.outcome, "up-to-date");
            assert_eq!(outcome.holder.as_deref(), Some(porcelain.as_str()));
        }
        assert_eq!(tip(&repo_s, "held-current").await, held_tip);
    }

    /// A holder that committed between the first read and its lock takes the merge into
    /// its HEAD as it now stands, so that commit is kept under the result. Driven through
    /// the holder arm directly, as the first read's tip is not passed down.
    #[tokio::test]
    async fn a_holder_that_committed_after_the_first_read_takes_the_merge() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-committed", "held-committed").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let base_sha = tip(&repo_s, &main).await;
        commit_file(&holder, "later.txt", "later\n").await;
        let committed = tip(&repo_s, "held-committed").await;

        let outcome = update_in_holder(
            &AppState::default(),
            &porcelain,
            "held-committed",
            &main,
            &base_sha,
            HolderMerge::Merge { subject: None },
        )
        .await
        .expect("a holder that moved on its own branch is merged into");
        assert_eq!(outcome.outcome, "merge");
        let merged = tip(&repo_s, "held-committed").await;
        for kept in [&committed, &base_sha] {
            let ancestor = run_git_raw(
                Some(&repo_s),
                &["merge-base", "--is-ancestor", kept, &merged],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
            assert_eq!(ancestor.code, 0, "{kept} is under the result {merged}");
        }
        assert_eq!(run(&holder, &["rev-parse", "HEAD"]).await.trim(), merged);
    }

    /// A holder paused mid-merge is refused by name and left paused.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_holder_mid_operation_is_refused() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-midop", "held-midop").await;
        let (_serialized, _override, _root) = holder_marker_root(&repo_s);
        commit_file(&repo_s, "base.txt", "base\n").await;
        run(&holder, &["merge", "--no-commit", "--no-ff", &main]).await;
        let held_tip = tip(&repo_s, "held-midop").await;

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, "held-midop", &main, &HashSet::new(), None)
            .await
            .unwrap_err();
        let message = expect_branch_held(&err, "mid-op", &porcelain, "held-midop");
        assert!(message.contains("in the middle of a merge"), "{message}");
        assert_eq!(tip(&repo_s, "held-midop").await, held_tip);
        assert!(crate::git::ops::op_state(&holder).await.unwrap().merging);
    }

    /// Tracked changes in the holder refuse the update and survive it untouched.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_holder_with_tracked_changes_is_refused() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-dirty", "held-dirty").await;
        let (_serialized, _override, _root) = holder_marker_root(&repo_s);
        commit_file(&repo_s, "base.txt", "base\n").await;
        let seed = std::path::Path::new(&holder).join("seed.txt");
        std::fs::write(&seed, "work in progress\n").unwrap();
        let held_tip = tip(&repo_s, "held-dirty").await;

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, "held-dirty", &main, &HashSet::new(), None)
            .await
            .unwrap_err();
        expect_branch_held(&err, "dirty", &porcelain, "held-dirty");
        assert_eq!(tip(&repo_s, "held-dirty").await, held_tip);
        assert_eq!(
            std::fs::read_to_string(&seed).unwrap(),
            "work in progress\n"
        );
    }

    /// Untracked files alone don't make the holder dirty: the update proceeds and
    /// leaves them where they were.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_holder_with_only_untracked_files_still_updates() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-untracked", "held-untracked").await;
        let (_serialized, _override, _root) = holder_marker_root(&repo_s);
        commit_file(&repo_s, "base.txt", "base\n").await;
        let scratch = std::path::Path::new(&holder).join("scratch.txt");
        std::fs::write(&scratch, "notes\n").unwrap();

        let state = AppState::default();
        let outcome = update_branch_from(
            &state,
            &repo_s,
            "held-untracked",
            &main,
            &HashSet::new(),
            None,
        )
        .await
        .expect("untracked files don't block the update");
        assert_eq!(outcome.outcome, "fast-forward");
        assert_eq!(outcome.holder.as_deref(), Some(porcelain.as_str()));
        assert_eq!(
            tip(&repo_s, "held-untracked").await,
            tip(&repo_s, &main).await
        );
        assert!(scratch.exists());
    }

    /// An IGNORED file in the holder at a path the base tracks must be refused rather than
    /// silently overwritten (git's default), and survive byte for byte. `diverge` gives the
    /// holder its own commit first, so the update takes the merge arm, not the ff one.
    #[allow(clippy::await_holding_lock)]
    async fn assert_ignored_file_survives(branch: &str, diverge: bool) {
        let (_guard, repo_s, main, holder, porcelain) = held_branch_repo(branch, branch).await;
        let (_serialized, _override, _root) = holder_marker_root(&repo_s);
        if diverge {
            commit_file(&holder, "feature.txt", "feature\n").await;
        }
        let holder_dir = std::path::Path::new(&holder);
        std::fs::write(holder_dir.join(".gitignore"), "build.log\n").unwrap();
        let ignored = holder_dir.join("build.log");
        std::fs::write(&ignored, "local build output\n").unwrap();
        commit_file(&repo_s, "build.log", "tracked by the base\n").await;
        let held_tip = tip(&repo_s, branch).await;

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, branch, &main, &HashSet::new(), None)
            .await
            .unwrap_err();
        expect_failed_naming(&err, &porcelain, branch, "build.log");
        assert_eq!(
            std::fs::read_to_string(&ignored).unwrap(),
            "local build output\n"
        );
        assert_eq!(tip(&repo_s, branch).await, held_tip);
        assert!(!crate::git::ops::op_state(&holder).await.unwrap().merging);
    }

    /// Asserts the holder arm's `failed` refusal for `holder`, naming `path`, with the
    /// unchanged-branch sentence closing line 1 (the toast's summary) ahead of any git text.
    fn expect_failed_naming(err: &AppError, holder: &str, branch: &str, path: &str) {
        let AppError::BranchHeld {
            message,
            holder: named,
            branch: held,
            reason,
        } = err
        else {
            panic!("expected a BranchHeld refusal, got {err:?}");
        };
        assert_eq!(
            (reason.as_str(), named.as_str(), held.as_str()),
            ("failed", holder, branch)
        );
        assert!(
            message
                .lines()
                .next()
                .is_some_and(|l| l.ends_with(&format!("{branch} is unchanged."))),
            "{message}"
        );
        assert!(
            message.contains(path),
            "the refusal names the file: {message}"
        );
    }

    #[tokio::test]
    async fn a_holder_ignored_file_the_base_tracks_is_never_overwritten() {
        assert_ignored_file_survives("held-ignored", false).await;
    }

    #[tokio::test]
    async fn a_diverged_holder_ignored_file_the_base_tracks_is_never_overwritten() {
        assert_ignored_file_survives("held-ignored-merge", true).await;
    }

    /// The holder deleted a path the base then modified, and an ignored file now sits
    /// there: the modify/delete conflict would leave the base's version over it, and the
    /// abort would then delete it.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_holder_ignored_file_at_a_path_it_deleted_is_never_overwritten() {
        let branch = "held-ignored-md";
        let (_guard, repo_s, main, holder, porcelain) = held_branch_repo(branch, branch).await;
        let (_serialized, _override, _root) = holder_marker_root(&repo_s);
        run(&holder, &["rm", "-q", "seed.txt"]).await;
        run(&holder, &["commit", "-qm", "holder deletes seed"]).await;
        let holder_dir = std::path::Path::new(&holder);
        std::fs::write(holder_dir.join(".gitignore"), "seed.txt\n").unwrap();
        let ignored = holder_dir.join("seed.txt");
        std::fs::write(&ignored, "local data\n").unwrap();
        commit_file(&repo_s, "seed.txt", "base modified\n").await;
        let held_tip = tip(&repo_s, branch).await;

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, branch, &main, &HashSet::new(), None)
            .await
            .unwrap_err();
        expect_failed_naming(&err, &porcelain, branch, "seed.txt");
        assert_eq!(std::fs::read_to_string(&ignored).unwrap(), "local data\n");
        assert_eq!(tip(&repo_s, branch).await, held_tip);
        assert!(!crate::git::ops::op_state(&holder).await.unwrap().merging);
    }

    /// An ignored DIRECTORY where the base adds a file: the merge would replace the whole
    /// directory with that file.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_holder_ignored_directory_the_base_adds_a_file_over_is_kept() {
        let branch = "held-ignored-dir";
        let (_guard, repo_s, main, holder, porcelain) = held_branch_repo(branch, branch).await;
        let (_serialized, _override, _root) = holder_marker_root(&repo_s);
        commit_file(&holder, "feature.txt", "feature\n").await;
        let holder_dir = std::path::Path::new(&holder);
        std::fs::write(holder_dir.join(".gitignore"), "build/\n").unwrap();
        let artifact = holder_dir.join("build").join("out.txt");
        std::fs::create_dir_all(holder_dir.join("build")).unwrap();
        std::fs::write(&artifact, "artifact\n").unwrap();
        commit_file(&repo_s, "build", "tracked build file\n").await;
        let held_tip = tip(&repo_s, branch).await;

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, branch, &main, &HashSet::new(), None)
            .await
            .unwrap_err();
        expect_failed_naming(&err, &porcelain, branch, "build/");
        assert_eq!(std::fs::read_to_string(&artifact).unwrap(), "artifact\n");
        assert_eq!(tip(&repo_s, branch).await, held_tip);
        assert!(!crate::git::ops::op_state(&holder).await.unwrap().merging);
    }

    /// An ignored FILE `a` where the base adds `a/b`: the update would replace the file
    /// with a directory, so it is refused by the ancestor's name. `diverge` picks the
    /// merge arm over the fast-forward one.
    #[allow(clippy::await_holding_lock)]
    async fn assert_ignored_ancestor_survives(branch: &str, diverge: bool) {
        let (_guard, repo_s, main, holder, porcelain) = held_branch_repo(branch, branch).await;
        let (_serialized, _override, _root) = holder_marker_root(&repo_s);
        if diverge {
            commit_file(&holder, "feature.txt", "feature\n").await;
        }
        let holder_dir = std::path::Path::new(&holder);
        std::fs::write(holder_dir.join(".gitignore"), "a\n").unwrap();
        let ignored = holder_dir.join("a");
        std::fs::write(&ignored, "local notes\n").unwrap();
        std::fs::create_dir_all(std::path::Path::new(&repo_s).join("a")).unwrap();
        commit_file(&repo_s, "a/b", "tracked under a\n").await;
        let held_tip = tip(&repo_s, branch).await;

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, branch, &main, &HashSet::new(), None)
            .await
            .unwrap_err();
        expect_failed_naming(&err, &porcelain, branch, "a");
        // `a` is too short for the helper's substring check to mean anything on its own.
        assert!(
            err.to_string()
                .lines()
                .any(|l| l.trim() == "a" || l.contains("ignored files there: a.")),
            "the refusal names `a` itself: {err}"
        );
        assert_eq!(std::fs::read_to_string(&ignored).unwrap(), "local notes\n");
        assert_eq!(tip(&repo_s, branch).await, held_tip);
        assert!(!crate::git::ops::op_state(&holder).await.unwrap().merging);
    }

    #[tokio::test]
    async fn a_diverged_holder_ignored_file_the_base_adds_a_directory_over_is_kept() {
        assert_ignored_ancestor_survives("held-ignored-anc", true).await;
    }

    #[tokio::test]
    async fn a_holder_ignored_file_the_base_adds_a_directory_over_is_kept() {
        assert_ignored_ancestor_survives("held-ignored-anc-ff", false).await;
    }

    /// A folder that is not ignored itself but holds only ignored files, where the base
    /// adds a file of the folder's name: the merge would remove the folder, ignored
    /// contents and all.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_holder_folder_of_ignored_files_the_base_adds_a_file_over_is_kept() {
        let branch = "held-ignored-folder";
        let (_guard, repo_s, main, holder, porcelain) = held_branch_repo(branch, branch).await;
        let (_serialized, _override, _root) = holder_marker_root(&repo_s);
        commit_file(&holder, "feature.txt", "feature\n").await;
        let holder_dir = std::path::Path::new(&holder);
        std::fs::write(holder_dir.join(".gitignore"), "*.log\n").unwrap();
        std::fs::create_dir_all(holder_dir.join("logs")).unwrap();
        let local = holder_dir.join("logs").join("run.log");
        std::fs::write(&local, "local log\n").unwrap();
        commit_file(&repo_s, "logs", "tracked logs file\n").await;
        let held_tip = tip(&repo_s, branch).await;

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, branch, &main, &HashSet::new(), None)
            .await
            .unwrap_err();
        expect_failed_naming(&err, &porcelain, branch, "logs/run.log");
        assert_eq!(std::fs::read_to_string(&local).unwrap(), "local log\n");
        assert_eq!(tip(&repo_s, branch).await, held_tip);
        assert!(!crate::git::ops::op_state(&holder).await.unwrap().merging);
    }

    /// A file the base adds INSIDE an ignored directory destroys nothing there, so a
    /// directory ancestor never refuses the merge, and the ignored contents stay put.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_base_file_inside_an_ignored_directory_still_merges() {
        let branch = "held-ignored-inside";
        let (_guard, repo_s, main, holder, porcelain) = held_branch_repo(branch, branch).await;
        let (_serialized, _override, _root) = holder_marker_root(&repo_s);
        commit_file(&holder, "feature.txt", "feature\n").await;
        let holder_dir = std::path::Path::new(&holder);
        std::fs::write(holder_dir.join(".gitignore"), "logs/\n").unwrap();
        std::fs::create_dir_all(holder_dir.join("logs")).unwrap();
        let local = holder_dir.join("logs").join("run.log");
        std::fs::write(&local, "local log\n").unwrap();
        std::fs::create_dir_all(std::path::Path::new(&repo_s).join("logs")).unwrap();
        commit_file(&repo_s, "logs/keep.txt", "tracked\n").await;

        let state = AppState::default();
        let outcome = update_branch_from(&state, &repo_s, branch, &main, &HashSet::new(), None)
            .await
            .expect("a directory ancestor does not block the merge");
        assert_eq!(outcome.outcome, "merge");
        assert_eq!(outcome.holder.as_deref(), Some(porcelain.as_str()));
        assert_eq!(std::fs::read_to_string(&local).unwrap(), "local log\n");
        assert!(holder_dir.join("logs").join("keep.txt").exists());
    }

    /// A conflicting merge inside the holder is aborted: no MERGE_HEAD, a clean tree, the
    /// branch where it stood, and the conflicting file named.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_conflicting_held_merge_is_aborted_and_refused() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-conflict", "held-conflict").await;
        let (_serialized, _override, _root) = holder_marker_root(&repo_s);
        commit_file(&holder, "seed.txt", "holder side\n").await;
        commit_file(&repo_s, "seed.txt", "main side\n").await;
        let held_tip = tip(&repo_s, "held-conflict").await;

        let state = AppState::default();
        let err = update_branch_from(
            &state,
            &repo_s,
            "held-conflict",
            &main,
            &HashSet::new(),
            None,
        )
        .await
        .unwrap_err();
        let message = expect_branch_held(&err, "conflict", &porcelain, "held-conflict");
        assert!(message.contains("seed.txt"), "{message}");
        assert!(message.contains(&porcelain), "{message}");
        assert!(!crate::git::ops::op_state(&holder).await.unwrap().merging);
        assert_eq!(run(&holder, &["status", "--porcelain"]).await, "");
        assert_eq!(tip(&repo_s, "held-conflict").await, held_tip);
    }

    /// A holder update holds the throwaway arm's marker for its whole run: a rename and a
    /// second update of the branch are both turned away while it is live, and nothing is
    /// left once it settles. Holding the holder's lock here parks the first update inside
    /// that window.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_holder_update_holds_its_marker_against_a_rename_and_a_second_update() {
        use crate::git::update_marker as marker;
        // The store guard first, then the marker root's: the order every test taking both
        // uses.
        let _serialized_store = crate::local_prs::tests::store_dir_lock();
        let (_guard, repo_s, main, _holder, porcelain) =
            held_branch_repo("held-marker", "held-marker").await;
        let (_serialized, _override, root) = holder_marker_root(&repo_s);
        commit_file(&repo_s, "base.txt", "base\n").await;
        let main_tip = tip(&repo_s, &main).await;

        let state = AppState::default();
        let holder_lock = acquire_repo_lock(
            &state.working_tree_lock(&porcelain).await,
            Duration::ZERO,
            "a test hold",
        )
        .await
        .expect("the holder's lock is free");
        let none = HashSet::new();
        let first = update_branch_from(&state, &repo_s, "held-marker", &main, &none, None);
        let contenders = async {
            // Bounded well inside the first update's 10 s wait for the holder's lock.
            for _ in 0..500 {
                if marker_leftovers(&root).iter().any(|n| n.ends_with(".lock")) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let second = update_branch_from(&state, &repo_s, "held-marker", &main, &none, None)
                .await
                .expect_err("a second update of the branch is turned away");
            let renamed = git_rename_branch_core(
                &state,
                repo_s.clone(),
                "held-marker".into(),
                "held-renamed".into(),
            )
            .await
            .expect_err("a rename mid-update is refused");
            drop(holder_lock);
            (second.to_string(), renamed.to_string())
        };
        let (first, (second, renamed)) = tokio::join!(first, contenders);

        let expected = marker::branch_update_refusal("held-marker").to_string();
        assert_eq!(second, expected);
        assert_eq!(renamed, expected);
        let first = first.expect("the first update completes once the holder is free");
        assert_eq!(first.outcome, "fast-forward");
        assert_eq!(tip(&repo_s, "held-marker").await, main_tip);
        assert!(
            marker_leftovers(&root).is_empty(),
            "{:?}",
            marker_leftovers(&root)
        );
    }

    /// A LOCKED worktree whose folder is gone still lists and still holds its branch: the
    /// update names the missing folder instead of surfacing a raw OS error.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_locked_holder_whose_folder_is_gone_is_named() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-gone", "held-gone").await;
        let (_serialized, _override, root) = holder_marker_root(&repo_s);
        commit_file(&repo_s, "base.txt", "base\n").await;
        let held_tip = tip(&repo_s, "held-gone").await;
        run(&repo_s, &["worktree", "lock", &holder]).await;
        std::fs::remove_dir_all(&holder).unwrap();
        assert_eq!(
            worktree_holding_branch(&repo_s, "held-gone").await,
            Some(porcelain.clone()),
            "the locked entry still holds the branch"
        );

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, "held-gone", &main, &HashSet::new(), None)
            .await
            .unwrap_err();
        let AppError::Command(message) = &err else {
            panic!("expected the missing-folder refusal, got {err:?}");
        };
        assert!(message.contains(&porcelain), "{message}");
        assert!(message.contains("folder is missing"), "{message}");
        assert!(message.ends_with("held-gone is unchanged."), "{message}");
        assert_eq!(tip(&repo_s, "held-gone").await, held_tip);
        assert!(marker_leftovers(&root).is_empty());
    }

    /// A holder that switched away between the lookup and its lock is refused; driven
    /// through the holder arm directly, since a fresh lookup would no longer find it.
    #[tokio::test]
    async fn a_holder_that_switched_branches_is_refused() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-moved", "held-moved").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let (held_tip, base_sha) = (tip(&repo_s, "held-moved").await, tip(&repo_s, &main).await);
        run(&holder, &["switch", "-qc", "elsewhere"]).await;

        let state = AppState::default();
        let err = update_in_holder(
            &state,
            &porcelain,
            "held-moved",
            &main,
            &base_sha,
            HolderMerge::FastForward,
        )
        .await
        .unwrap_err();
        let message = expect_branch_held(&err, "moved", &porcelain, "held-moved");
        assert!(
            message.contains("switched away from held-moved"),
            "{message}"
        );
        assert_eq!(tip(&repo_s, "held-moved").await, held_tip);
        assert_eq!(
            run(&holder, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/elsewhere"
        );
    }

    #[test]
    fn name_paths_names_three_then_counts_the_rest() {
        let paths = |n: usize| (1..=n).map(|i| format!("f{i}")).collect::<Vec<_>>();
        assert_eq!(name_paths(&paths(1)), "f1");
        assert_eq!(name_paths(&paths(3)), "f1, f2, f3");
        assert_eq!(name_paths(&paths(5)), "f1, f2, f3 and 2 more");
    }

    /// The update UI reads both keys; `holder` must serialize as an explicit null on
    /// every arm that ran in no other checkout.
    #[test]
    fn update_outcome_serializes_to_the_pinned_wire_shape() {
        let held = UpdateBranchOutcome {
            outcome: "fast-forward".to_string(),
            holder: Some("C:/path/to/wt".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&held).unwrap(),
            r#"{"outcome":"fast-forward","holder":"C:/path/to/wt"}"#
        );
        assert_eq!(
            serde_json::to_string(&UpdateBranchOutcome::unheld("merge")).unwrap(),
            r#"{"outcome":"merge","holder":null}"#
        );
    }

    /// A repo with `feature` tracking the default branch through the local `.` remote,
    /// so `feature@{upstream}` resolves without a network or a second repo. Returns the
    /// temp guard, the repo path, and the upstream tip.
    async fn repo_with_local_upstream(tag: &str) -> (tempfile::TempDir, String, String) {
        let (guard, base_dir) = temp_base(tag);
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["branch", "feature"]).await;
        // One call sets both `branch.feature.remote` (`.`) and `.merge`, which keeps
        // any `refs/heads/<name>` template out of this fixture entirely.
        run(&repo_s, &["branch", "--set-upstream-to", &main, "feature"]).await;
        let tip = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();
        (guard, repo_s, tip)
    }

    /// The PRE-ADD window: an update has minted its marker but its `worktree add` has
    /// not registered anything yet, so `worktree list` is empty. Both porcelain-only
    /// sites must still refuse — without this guard a delete succeeds here and the
    /// update dies moments later on a missing ref.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // root override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_live_marker_refuses_delete_and_reset_before_the_checkout_exists() {
        use crate::git::update_marker as marker;
        let (_guard, repo_s, tip) = repo_with_local_upstream("premint-guard").await;
        let root = std::path::Path::new(&repo_s)
            .parent()
            .unwrap()
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();

        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        // A branch name no other test uses: the override root is process-wide, and the
        // LIVE marker below would refuse a parallel test's guard on a shared name.
        let branch = "feature-live-refusal";
        run(&repo_s, &["branch", "-m", "feature", branch]).await;
        // Minted, not yet added: nothing is in the worktree registry.
        let _live = marker::UpdateMarker::create_for(&root.join("gd-update-live"), branch)
            .expect("the marker mints");

        let state = AppState::default();
        let expected = marker::branch_update_refusal(branch).to_string();
        let deleted = git_delete_branch_core(&state, repo_s.clone(), branch.into(), None)
            .await
            .expect_err("a delete during the pre-add window is refused");
        assert_eq!(deleted.to_string(), expected);
        let local = local_tip(&repo_s, branch).await;
        let reset = branch_reset_to_upstream(&state, &repo_s, branch, &tip, &local)
            .await
            .expect_err("a reset during the pre-add window is refused");
        assert_eq!(reset.to_string(), expected);
        assert!(
            !run(&repo_s, &["branch", "--list", branch])
                .await
                .trim()
                .is_empty(),
            "and the branch is still there"
        );
    }

    /// A reset to upstream sweeps a dead update's registered checkout BEFORE taking the
    /// working-tree hold: with that hold held elsewhere, the reset times out Busy and
    /// the checkout is already gone. Released, the reset then proceeds.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // root override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_released_update_holder_is_swept_before_a_reset_to_upstream() {
        use crate::git::update_marker as marker;
        let (_guard, repo_s, _seed) = repo_with_local_upstream("reset-swept-holder").await;
        let root = std::path::Path::new(&repo_s)
            .parent()
            .unwrap()
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();

        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        // A branch name no other test uses: the override root is process-wide.
        let branch = "feature-reset-swept-holder";
        run(&repo_s, &["branch", "-m", "feature", branch]).await;
        let dead = root.join("gd-update-reset-crashed");
        let dead_s = dead.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "--quiet", &dead_s, branch]).await;
        marker::write_released_marker(&root, "gd-update-reset-crashed", branch);
        // The upstream moves past the branch, so the reset below really moves the ref.
        std::fs::write(
            std::path::Path::new(&repo_s).join("a.txt"),
            "upstream moved\n",
        )
        .unwrap();
        run(&repo_s, &["commit", "-qam", "upstream moves"]).await;
        let tip = run(
            &repo_s,
            &["rev-parse", &format!("{branch}@{{upstream}}^{{commit}}")],
        )
        .await
        .trim()
        .to_string();
        let local = local_tip(&repo_s, branch).await;
        assert_ne!(local, tip, "fixture sanity: the reset has somewhere to go");

        let state = AppState::default();
        let domain = state.working_tree_lock(&repo_s).await;
        let held = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a test hold")
            .await
            .expect("the test takes the hold");
        let err =
            branch_reset_to_upstream_within(&state, &repo_s, branch, &tip, &local, Duration::ZERO)
                .await
                .expect_err("the reset meets the held working tree");
        assert!(matches!(err, AppError::Busy { .. }), "got {err:?}");
        assert!(
            !dead.exists(),
            "the orphaned checkout was removed before the hold was needed"
        );
        drop(held);

        branch_reset_to_upstream(&state, &repo_s, branch, &tip, &local)
            .await
            .expect("with the hold free, the reset proceeds");
        assert_eq!(local_tip(&repo_s, branch).await, tip);
    }

    /// The in-hold classification names an update's hidden checkout without claiming
    /// it: live reads as updating, dead as interrupted (its checkout left in place for
    /// a retry to sweep outside the hold), and anything else leaves the caller's
    /// generic message.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // root override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_holder_refusal_classifies_without_claiming() {
        use crate::git::update_marker as marker;
        let (_guard, repo_s, _tip) = repo_with_local_upstream("holder-classify").await;
        let root = std::path::Path::new(&repo_s)
            .parent()
            .unwrap()
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();

        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        let branch = "feature-holder-classify";
        run(&repo_s, &["branch", "-m", "feature", branch]).await;
        let state = AppState::default();

        let dead = root.join("gd-update-classify-dead");
        let dead_s = dead.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "--quiet", &dead_s, branch]).await;
        marker::write_released_marker(&root, "gd-update-classify-dead", branch);
        let verdict = update_holder_refusal(&state, &repo_s, branch, &dead_s).await;
        assert_eq!(
            verdict.map(|e| e.to_string()),
            Some(marker::interrupted_update_refusal(branch).to_string())
        );
        assert!(dead.exists(), "nothing is claimed under the hold");
        run(&repo_s, &["worktree", "remove", "--force", &dead_s]).await;

        let live = root.join("gd-update-classify-live");
        let _live = marker::UpdateMarker::create_for(&live, branch).expect("the marker mints");
        let verdict = update_holder_refusal(&state, &repo_s, branch, &live.to_string_lossy()).await;
        assert_eq!(
            verdict.map(|e| e.to_string()),
            Some(marker::branch_update_refusal(branch).to_string())
        );

        // Named and marked like an update's checkout, with a released lock beside it,
        // but outside the update roots: only the root check can turn it away.
        let users_own_parent = std::path::Path::new(&repo_s)
            .parent()
            .unwrap()
            .join("users-own");
        std::fs::create_dir_all(&users_own_parent).unwrap();
        marker::write_released_marker(&users_own_parent, "gd-update-users-own", branch);
        let users_own = users_own_parent.join("gd-update-users-own");
        assert!(
            update_holder_refusal(&state, &repo_s, branch, &users_own.to_string_lossy())
                .await
                .is_none(),
            "a checkout outside the update roots keeps the generic message"
        );
    }

    /// The post-add half, both outcomes. A RELEASED marker over a registered checkout is
    /// claimed age-free and the delete then succeeds; a MARKERLESS one (a pre-marker
    /// build's checkout, which may still be running) is left alone and takes the
    /// pre-existing generic message naming the holding worktree.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // root override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_registered_holder_is_claimed_when_released_and_left_when_markerless() {
        use crate::git::update_marker as marker;
        let (_guard, repo_s, _tip) = repo_with_local_upstream("registered-holder").await;
        let root = std::path::Path::new(&repo_s)
            .parent()
            .unwrap()
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();

        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        // A branch name no other test uses, as in the pre-add guard test: the override
        // root is process-wide, so a shared name lets a parallel test's marker decide
        // this one's verdict.
        let branch = "feature-registered-holder";
        run(&repo_s, &["branch", "-m", "feature", branch]).await;
        let state = AppState::default();

        // MARKERLESS: registered, no sidecars — the generic message, unchanged.
        let bare = root.join("gd-update-premarker");
        let bare_s = bare.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "--quiet", &bare_s, branch]).await;
        let err = git_delete_branch_core(&state, repo_s.clone(), branch.into(), None)
            .await
            .expect_err("a markerless holder still blocks the delete");
        assert!(
            err.to_string()
                .starts_with(&format!("{branch} is checked out in the worktree at"))
                && err.to_string().ends_with(&format!(
                    "(or switch it to another branch) before deleting {branch}."
                )),
            "the pre-marker path keeps its original wording: {err}"
        );
        assert!(bare.exists(), "and its checkout is untouched");
        run(&repo_s, &["worktree", "remove", "--force", &bare_s]).await;

        // RELEASED: registered, sidecars present, lock free — claimed with no age gate.
        // The pair is WRITTEN, not minted-and-dropped: a crashed update's lock is
        // released by the OS, and on Linux `drop` cannot be relied on to release one in
        // a process-spawning test binary (see `write_released_marker`).
        let dead = root.join("gd-update-crashed");
        let dead_s = dead.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "--quiet", &dead_s, branch]).await;
        marker::write_released_marker(&root, "gd-update-crashed", branch);

        git_delete_branch_core(&state, repo_s.clone(), branch.into(), None)
            .await
            .expect("a released holder is cleared and the delete proceeds");
        assert!(!dead.exists(), "the orphaned checkout was removed");
        assert!(
            run(&repo_s, &["branch", "--list", branch])
                .await
                .trim()
                .is_empty(),
            "and the branch it was holding is gone"
        );
    }

    async fn archived_flag(repo: &str, branch: &str) -> Option<String> {
        let key = format!("branch.{branch}.gitdesktopArchived");
        let out = run_git_raw(Some(repo), &["config", "--get", &key], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        (out.code == 0).then(|| out.stdout_lossy().trim().to_string())
    }

    /// A config lock another writer releases within the retry delay is ridden out on
    /// the real path. Whether the first attempt lands inside the hold depends on spawn
    /// timing; the scripted retry-policy test in `runner` is what pins the policy.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_briefly_held_config_lock_is_ridden_out() {
        let (_base, base) = temp_base("archive-transient-lock");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "feature"]).await;

        let lock = repo.join(".git").join("config.lock");
        std::fs::write(&lock, b"").unwrap();
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            std::fs::remove_file(&lock).unwrap();
        });
        set_branch_archived_core(&repo_s, "feature", true)
            .await
            .expect("the retry lands after the other writer lets go");
        release.await.unwrap();
        assert_eq!(
            archived_flag(&repo_s, "feature").await.as_deref(),
            Some("true")
        );
    }

    /// A config lock held through the retry surfaces the user-register refusal, never
    /// git's lock-file error; released, the same call succeeds, and an unarchive of an
    /// unset flag stays a success.
    #[tokio::test]
    async fn a_held_config_lock_reads_as_try_again_not_a_raw_git_error() {
        let (_base, base) = temp_base("archive-config-lock");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "feature"]).await;

        let lock = repo.join(".git").join("config.lock");
        std::fs::write(&lock, b"").unwrap();
        for archived in [true, false] {
            let err = set_branch_archived_core(&repo_s, "feature", archived)
                .await
                .expect_err("a lock held through the retry refuses");
            assert_eq!(
                err.to_string(),
                archive_config_busy("feature", archived).to_string()
            );
            assert!(!err.to_string().contains("config.lock"), "{err}");
        }

        std::fs::remove_file(&lock).unwrap();
        set_branch_archived_core(&repo_s, "feature", true)
            .await
            .expect("the lock released, the archive lands");
        assert_eq!(
            archived_flag(&repo_s, "feature").await.as_deref(),
            Some("true")
        );
        for _ in 0..2 {
            set_branch_archived_core(&repo_s, "feature", false)
                .await
                .expect("unarchiving, twice, succeeds");
        }
        assert_eq!(archived_flag(&repo_s, "feature").await, None);
    }

    /// A flag that somehow carries two values (a hand edit, another tool) is fully
    /// cleared: plain `--unset` exits 5 on it, the same code as "not set", and removes
    /// nothing.
    #[tokio::test]
    async fn unarchiving_clears_a_multi_valued_flag() {
        let (_base, base) = temp_base("archive-multi-value");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "feature"]).await;
        for _ in 0..2 {
            run(
                &repo_s,
                &[
                    "config",
                    "--add",
                    "branch.feature.gitdesktopArchived",
                    "true",
                ],
            )
            .await;
        }
        assert!(git_branches(repo_s.clone())
            .await
            .unwrap()
            .iter()
            .any(|b| b.name == "feature" && b.archived));

        set_branch_archived_core(&repo_s, "feature", false)
            .await
            .expect("unarchiving a multi-valued flag succeeds");
        assert!(git_branches(repo_s.clone())
            .await
            .unwrap()
            .iter()
            .any(|b| b.name == "feature" && !b.archived));
    }

    /// A repo whose `branch` carries BOTH an upstream and the archived flag, so a stale
    /// `branch.<name>` section has something to show, plus a remote-tracking ref
    /// `origin/<tracked>` (synthesized, never fetched) at a commit whose tree DIFFERS
    /// from HEAD's, so a test can tell a moved working tree from an untouched one.
    async fn repo_with_branch_settings(
        tag: &str,
        branch: &str,
        tracked: &str,
    ) -> (tempfile::TempDir, std::path::PathBuf, String) {
        let (guard, base) = temp_base(tag);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        run(&repo_s, &["branch", branch]).await;
        run(
            &repo_s,
            &["branch", "--set-upstream-to", main.trim(), branch],
        )
        .await;
        let flag = format!("branch.{branch}.gitdesktopArchived");
        run(&repo_s, &["config", &flag, "true"]).await;
        let nowhere = base.join("nowhere.git").to_string_lossy().into_owned();
        run(&repo_s, &["remote", "add", "origin", &nowhere]).await;
        run(&repo_s, &["switch", "-q", "-c", "remote-side"]).await;
        std::fs::write(repo.join("a.txt"), "remote\n").unwrap();
        std::fs::write(repo.join("remote.txt"), "remote\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "remote side"]).await;
        let tracking = format!("refs/remotes/origin/{tracked}");
        run(&repo_s, &["update-ref", &tracking, "HEAD"]).await;
        run(&repo_s, &["switch", "-q", main.trim()]).await;
        run(&repo_s, &["branch", "-q", "-D", "remote-side"]).await;
        (guard, repo, repo_s)
    }

    /// `git status --porcelain`, so a test can tell staged leftovers from a clean switch.
    async fn porcelain(repo: &str) -> String {
        run(repo, &["status", "--porcelain"]).await
    }

    /// `a.txt` as the working tree holds it, line endings aside.
    fn seed_file(repo: &std::path::Path) -> String {
        std::fs::read_to_string(repo.join("a.txt"))
            .unwrap()
            .trim()
            .to_string()
    }

    /// Every `branch.<name>.*` entry, empty when the section is gone.
    async fn branch_section(repo: &str, branch: &str) -> String {
        let pattern = format!(r"^branch\.{branch}\.");
        run_git_raw(
            Some(repo),
            &["config", "--get-regexp", &pattern],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap()
        .stdout_lossy()
    }

    async fn branch_exists(repo: &str, name: &str) -> bool {
        !run(repo, &["branch", "--list", name])
            .await
            .trim()
            .is_empty()
    }

    /// The premise the rename and tracking repairs rest on (git 2.51.1): each command
    /// finishes its ref change BEFORE losing `.git/config.lock`, so re-running it is
    /// never the fix. The `branch -D` row (it even exits 0) is a git-behaviour canary
    /// only: no production path runs `branch -D`. A git that changes any shape fails
    /// here first.
    #[tokio::test]
    async fn git_lands_the_ref_change_before_losing_the_config_lock() {
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-shapes", "shape", "shape-remote").await;
        run(&repo_s, &["branch", "shape-gone"]).await;
        run(
            &repo_s,
            &["config", "branch.shape-gone.gitdesktopArchived", "true"],
        )
        .await;
        let lock = hold_config_lock(&repo);
        let raw = |args: &'static [&'static str]| {
            let repo_s = repo_s.clone();
            async move {
                run_git_raw(Some(&repo_s), args, TEST_GIT_HANG_GUARD)
                    .await
                    .unwrap()
            }
        };

        let deleted = raw(&["branch", "-D", "--", "shape-gone"]).await;
        assert_eq!(deleted.code, 0, "{}", deleted.stderr);
        assert!(
            is_config_lock_contention(&deleted.stderr),
            "{}",
            deleted.stderr
        );
        assert!(!branch_exists(&repo_s, "shape-gone").await);
        assert!(!branch_section(&repo_s, "shape-gone").await.is_empty());

        let renamed = raw(&["branch", "-m", "--", "shape", "shape-moved"]).await;
        assert_eq!(renamed.code, 128);
        assert!(
            renamed.stderr.contains(RENAMED_CONFIG_LEFT_BEHIND),
            "{}",
            renamed.stderr
        );
        assert!(branch_exists(&repo_s, "shape-moved").await);
        assert!(!branch_section(&repo_s, "shape").await.is_empty());

        // Both switch forms: the branch is created AND the index and working tree move
        // to its tip, but HEAD stays put, so the move reads as staged changes on the
        // old branch. A plain `branch` from the same start point leaves the tree alone.
        let head = run(&repo_s, &["symbolic-ref", "HEAD"]).await;
        let cases: [(&'static [&'static str], &str); 3] = [
            (
                &[
                    "switch",
                    "--track",
                    "-c",
                    "shape-remote",
                    "origin/shape-remote",
                ],
                "shape-remote",
            ),
            (
                &["switch", "-c", "shape-create", "origin/shape-remote"],
                "shape-create",
            ),
            (
                &["branch", "shape-plain", "origin/shape-remote"],
                "shape-plain",
            ),
        ];
        for (args, created) in cases {
            let out = raw(args).await;
            assert_eq!(out.code, 1, "{args:?}: {}", out.stderr);
            assert!(out.stderr.contains(UPSTREAM_WRITE_FAILED), "{}", out.stderr);
            assert!(branch_exists(&repo_s, created).await, "{args:?} created");
            assert_eq!(
                run(&repo_s, &["symbolic-ref", "HEAD"]).await,
                head,
                "{args:?}"
            );
            if args[0] == "switch" {
                assert_eq!(seed_file(&repo), "remote", "{args:?} moved the tree");
                let staged = porcelain(&repo_s).await;
                assert!(
                    staged.contains("M  a.txt") && staged.contains("A  remote.txt"),
                    "{args:?} left the move staged on the old branch: {staged}"
                );
                run(&repo_s, &["reset", "-q", "--hard"]).await;
            } else {
                assert_eq!(seed_file(&repo), "hello", "{args:?} left the tree alone");
                assert_eq!(porcelain(&repo_s).await, "", "{args:?}");
            }
        }
        std::fs::remove_file(&lock).unwrap();
    }

    /// The ref delete leaves `.git/config` alone, and the `branch.<name>` section drop
    /// rides out a held config lock through the repair's retry: both are gone.
    #[tokio::test]
    async fn a_delete_under_a_held_config_lock_still_drops_the_branch_settings() {
        let branch = "cfg-lock-delete";
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-delete", branch, "unused").await;
        assert!(!branch_section(&repo_s, branch).await.is_empty());
        let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&repo), 2);

        let state = AppState::default();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_delete_branch_core(&state, repo_s.clone(), branch.into(), None),
            )
            .await
            .expect("the delete succeeds");
        assert!(!branch_exists(&repo_s, branch).await);
        assert_eq!(
            branch_section(&repo_s, branch).await,
            "",
            "no stale section"
        );
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// A repo on its default branch with `feat` at the seed commit carrying an upstream
    /// and the Keep local mark, and `main_tip` one commit past it on the checked-out
    /// branch. Reflogs are pinned on, so a global `core.logAllRefUpdates` can't hide one.
    /// Returns (guard, repo, feat's tip, the checked-out branch's tip).
    async fn delete_fixture(tag: &str) -> (tempfile::TempDir, String, String, String) {
        let (guard, base) = temp_base(tag);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["config", "core.logAllRefUpdates", "true"]).await;
        run(&repo_s, &["branch", "feat"]).await;
        for (key, value) in [
            ("remote", "origin"),
            ("merge", "refs/heads/feat"),
            ("gitdesktopLocalOnly", "true"),
        ] {
            run(&repo_s, &["config", &format!("branch.feat.{key}"), value]).await;
        }
        std::fs::write(repo.join("a.txt"), "next\n").unwrap();
        run(&repo_s, &["commit", "-qam", "next"]).await;
        let feat = full_ref_tip(&repo_s, "refs/heads/feat").await.unwrap();
        let head = full_ref_tip(&repo_s, "HEAD").await.unwrap();
        (guard, repo_s, feat, head)
    }

    async fn full_ref_tip(repo: &str, rev: &str) -> Option<String> {
        let out = run_git_raw(
            Some(repo),
            &["rev-parse", "--verify", "--quiet", rev],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        (out.code == 0).then(|| out.stdout_lossy().trim().to_string())
    }

    async fn reflog_exists(repo: &str, full_ref: &str) -> bool {
        run_git_raw(
            Some(repo),
            &["reflog", "exists", full_ref],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap()
        .code
            == 0
    }

    async fn delete(
        state: &AppState,
        repo: &str,
        name: &str,
        pin: Option<&str>,
    ) -> Result<DeleteBranchOutcome, AppError> {
        git_delete_branch_core(state, repo.into(), name.into(), pin.map(str::to_string)).await
    }

    /// A hook that runs `git <args>` in `repo` once, at `at`.
    fn git_at_phase(at: DeletePhase, repo: &str, args: &[&str]) -> DeletePhaseHook {
        let repo = repo.to_string();
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        Arc::new(move |phase| {
            let (repo, args) = (repo.clone(), args.clone());
            Box::pin(async move {
                if phase == at {
                    let args: Vec<&str> = args.iter().map(String::as_str).collect();
                    run(&repo, &args).await;
                }
            })
        })
    }

    #[tokio::test]
    async fn delete_branch_returns_the_tip_and_drops_ref_reflog_and_settings() {
        let (_g, repo, feat, _head) = delete_fixture("del-plain").await;
        assert!(
            reflog_exists(&repo, "refs/heads/feat").await,
            "fixture sanity"
        );
        assert!(
            !branch_section(&repo, "feat").await.is_empty(),
            "fixture sanity"
        );

        let outcome = delete(&AppState::default(), &repo, "feat", None).await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat,
                kept_local: true,
                upstream: None,
            }
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, None);
        assert!(!reflog_exists(&repo, "refs/heads/feat").await);
        assert_eq!(branch_section(&repo, "feat").await, "");
    }

    #[tokio::test]
    async fn delete_branch_with_a_matching_pin_deletes_in_either_letter_case() {
        let (_g, repo, feat, _head) = delete_fixture("del-pin-match").await;
        run(&repo, &["branch", "feat-upper", "feat"]).await;
        let state = AppState::default();

        let outcome = delete(&state, &repo, "feat", Some(&feat)).await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat.clone(),
                kept_local: true,
                upstream: None,
            }
        );
        let outcome = delete(&state, &repo, "feat-upper", Some(&feat.to_uppercase())).await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat.clone(),
                kept_local: false,
                upstream: None,
            }
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, None);
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat-upper").await, None);
    }

    /// The branch is one commit past the pin: nothing is deleted, and the outcome names
    /// both commits.
    #[tokio::test]
    async fn delete_branch_with_a_stale_pin_deletes_nothing() {
        let (_g, repo, feat, head) = delete_fixture("del-pin-stale").await;
        run(&repo, &["branch", "-f", "feat", &head]).await;

        let outcome = delete(&AppState::default(), &repo, "feat", Some(&feat)).await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::TipMoved {
                expected: feat,
                actual: head.clone()
            }
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(head));
        assert!(reflog_exists(&repo, "refs/heads/feat").await);
        assert!(!branch_section(&repo, "feat").await.is_empty());
    }

    #[tokio::test]
    async fn delete_branch_refuses_a_pin_that_is_not_a_full_id() {
        let (_g, repo, feat, _head) = delete_fixture("del-pin-bad").await;
        let state = AppState::default();
        for pin in [&feat[..12], "", &"g".repeat(40)] {
            let err = delete(&state, &repo, "feat", Some(pin)).await.unwrap_err();
            assert!(
                matches!(&err, AppError::InvalidArgument(m) if m.contains("full commit id")),
                "{pin:?}: {err:?}"
            );
        }
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(feat));
    }

    /// A rev expression over a real branch resolves under `refs/heads/` to another
    /// commit, so it is refused as a branch name, pinned or not, and nothing is deleted.
    #[tokio::test]
    async fn delete_branch_refuses_a_rev_expression_name() {
        let (_g, repo, _feat, head) = delete_fixture("del-rev-name").await;
        // One commit past its first tip, so `feat~1`, `feat^` and `feat@{1}` all resolve.
        run(&repo, &["branch", "-f", "feat", &head]).await;
        let state = AppState::default();
        for name in ["feat~1", "feat^", "feat@{1}", "feat..HEAD"] {
            for pin in [Some(head.as_str()), None] {
                let err = delete(&state, &repo, name, pin).await.unwrap_err();
                assert!(
                    matches!(&err, AppError::InvalidArgument(m) if *m == format!("invalid branch name: {name}")),
                    "{name} pin={pin:?}: {err:?}"
                );
            }
        }
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(head));
    }

    #[tokio::test]
    async fn delete_branch_of_a_missing_branch_is_git_not_found() {
        let (_g, repo, _feat, _head) = delete_fixture("del-missing").await;
        let err = delete(&AppState::default(), &repo, "nope", None)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Git { code: 1, stderr } if stderr == "error: branch 'nope' not found"),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn delete_branch_compares_and_deletes_a_packed_ref() {
        let (_g, repo, feat, head) = delete_fixture("del-packed").await;
        run(&repo, &["pack-refs", "--all"]).await;
        let state = AppState::default();

        let outcome = delete(&state, &repo, "feat", Some(&head)).await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::TipMoved {
                expected: head,
                actual: feat.clone()
            }
        );
        assert_eq!(
            full_ref_tip(&repo, "refs/heads/feat").await,
            Some(feat.clone())
        );
        let outcome = delete(&state, &repo, "feat", Some(&feat)).await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat,
                kept_local: true,
                upstream: None,
            }
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, None);
    }

    /// A tag named like the branch, at another commit, neither answers the tip read nor
    /// goes with the branch.
    #[tokio::test]
    async fn delete_branch_leaves_a_same_named_tag() {
        let (_g, repo, feat, head) = delete_fixture("del-tag").await;
        run(&repo, &["tag", "feat", &head]).await;

        let outcome = delete(&AppState::default(), &repo, "feat", None).await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat,
                kept_local: true,
                upstream: None,
            }
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, None);
        assert_eq!(full_ref_tip(&repo, "refs/tags/feat").await, Some(head));
    }

    #[tokio::test]
    async fn delete_branch_of_a_symbolic_ref_deletes_the_alias_only() {
        let (_g, repo, feat, _head) = delete_fixture("del-symref").await;
        run(
            &repo,
            &["symbolic-ref", "refs/heads/alias", "refs/heads/feat"],
        )
        .await;

        let outcome = delete(&AppState::default(), &repo, "alias", None).await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat.clone(),
                kept_local: false,
                upstream: None,
            }
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/alias").await, None);
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(feat));
    }

    #[test]
    fn exact_ref_field_reads_only_the_line_naming_the_ref() {
        let full_ref = "refs/heads/feat";
        assert_eq!(
            exact_ref_field("refs/heads/feat\0abc\n", full_ref),
            Some("abc")
        );
        assert_eq!(
            exact_ref_field("refs/heads/feat/sub\0abc\nrefs/heads/feat\0def\n", full_ref),
            Some("def")
        );
        for other in [
            "refs/heads/feat/sub\0abc\n",
            "refs/heads/Feat\0abc\n",
            "refs/heads/feature\0abc\n",
            "",
        ] {
            assert_eq!(exact_ref_field(other, full_ref), None, "{other:?}");
        }
        assert_eq!(exact_ref_field("refs/heads/feat\0\n", full_ref), Some(""));
        assert_eq!(exact_ref_field("refs/heads/feat\n", full_ref), Some(""));
    }

    /// A loose ref file answers for any spelling on a case-insensitive filesystem; the
    /// exact read does not, so a case variant is not found, pinned or not, and the real
    /// branch, its ref file and HEAD are untouched. On a case-sensitive filesystem this
    /// is a passing control.
    #[tokio::test]
    async fn delete_branch_reads_a_case_variant_as_not_found() {
        let (_g, repo, feat, head) = delete_fixture("del-case-variant").await;
        let current = current_branch_name(&repo).await.unwrap().unwrap();
        let head_ref = run(&repo, &["symbolic-ref", "HEAD"]).await;
        let heads = std::path::Path::new(&repo)
            .join(".git")
            .join("refs")
            .join("heads");
        assert!(heads.join(&current).is_file() && heads.join("feat").is_file());
        let state = AppState::default();

        let current_variant = current.to_uppercase();
        for (variant, pin) in [
            (current_variant.as_str(), None),
            (current_variant.as_str(), Some(head.as_str())),
            ("FEAT", None),
            ("FEAT", Some(feat.as_str())),
        ] {
            let err = delete(&state, &repo, variant, pin).await.unwrap_err();
            let expected = format!("error: branch '{variant}' not found");
            assert!(
                matches!(&err, AppError::Git { code: 1, stderr } if *stderr == expected),
                "{variant} pinned {pin:?}: {err:?}"
            );
        }
        assert_eq!(run(&repo, &["symbolic-ref", "HEAD"]).await, head_ref);
        assert_eq!(full_ref_tip(&repo, "HEAD").await, Some(head));
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(feat));
        assert!(heads.join(&current).is_file() && heads.join("feat").is_file());
    }

    /// git's ref-search fallback resolves `refs/heads/feat2` through
    /// `refs/heads/refs/heads/feat2` or `refs/tags/refs/heads/feat2`; the exact read
    /// never does, so the pinned delete answers not found, never a moved tip.
    #[tokio::test]
    async fn delete_branch_never_reads_a_ref_search_fallback() {
        for fallback in ["refs/heads/refs/heads/feat2", "refs/tags/refs/heads/feat2"] {
            let (_g, repo, seed, head) = delete_fixture("del-fallback").await;
            run(&repo, &["update-ref", fallback, "HEAD"]).await;
            assert_eq!(
                full_ref_tip(&repo, "refs/heads/feat2").await,
                Some(head.clone()),
                "fixture sanity: rev-parse takes the fallback"
            );

            let err = delete(&AppState::default(), &repo, "feat2", Some(&seed))
                .await
                .unwrap_err();
            assert!(
                matches!(&err, AppError::Git { code: 1, stderr }
                    if stderr == "error: branch 'feat2' not found"),
                "{fallback}: {err:?}"
            );
            assert_eq!(full_ref_tip(&repo, fallback).await, Some(head));
        }
    }

    #[tokio::test]
    async fn exact_branch_tip_reads_a_packed_ref() {
        let (_g, repo, feat, _head) = delete_fixture("tip-packed").await;
        run(&repo, &["pack-refs", "--all"]).await;
        let loose = std::path::Path::new(&repo).join(".git/refs/heads/feat");
        assert!(!loose.exists(), "fixture sanity: feat is packed only");
        assert_eq!(exact_branch_tip(&repo, "feat").await.unwrap(), Some(feat));
    }

    /// `for-each-ref refs/heads/topic` lists `topic/x` too; only an exact line counts.
    #[tokio::test]
    async fn exact_branch_tip_reads_no_branch_for_a_slash_prefix() {
        let (_g, repo, feat, _head) = delete_fixture("tip-slash-prefix").await;
        run(&repo, &["branch", "topic/x", &feat]).await;
        assert_eq!(exact_branch_tip(&repo, "topic").await.unwrap(), None);
        assert_eq!(
            exact_branch_tip(&repo, "topic/x").await.unwrap(),
            Some(feat)
        );
    }

    /// A dangling symbolic ref reads as missing, so its delete is not found and the alias
    /// stays a symbolic ref.
    #[tokio::test]
    async fn delete_branch_leaves_a_dangling_symbolic_ref() {
        let (_g, repo, _feat, _head) = delete_fixture("del-dangling").await;
        run(
            &repo,
            &["symbolic-ref", "refs/heads/dangling", "refs/heads/missing"],
        )
        .await;
        assert_eq!(exact_branch_tip(&repo, "dangling").await.unwrap(), None);

        let err = delete(&AppState::default(), &repo, "dangling", None)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Git { code: 1, stderr }
                if stderr == "error: branch 'dangling' not found"),
            "{err:?}"
        );
        assert_eq!(
            run(&repo, &["symbolic-ref", "refs/heads/dangling"])
                .await
                .trim(),
            "refs/heads/missing"
        );
    }

    #[tokio::test]
    async fn exact_branch_tip_fails_outside_a_repository() {
        let (_g, base) = temp_base("tip-no-repo");
        let dir = base.to_string_lossy().into_owned();
        assert!(exact_branch_tip(&dir, "feat").await.is_err());
    }

    #[test]
    fn git_dirs_need_exactly_two_lines() {
        for text in [
            "C:/r/.git\nC:/r/.git/worktrees/w\n",
            "C:/r/.git\r\nC:/r/.git/worktrees/w\r\n",
            "C:/r/.git\nC:/r/.git/worktrees/w",
        ] {
            let dirs = super::parse_git_dirs(text).unwrap();
            assert_eq!(
                dirs.common,
                std::path::PathBuf::from("C:/r/.git"),
                "{text:?}"
            );
            assert_eq!(
                dirs.own_admin,
                crate::git::worktree::canonical_wt_path("C:/r/.git/worktrees/w"),
                "{text:?}"
            );
        }
        for text in [
            "",
            "C:/r/.git\n",
            "C:/r/.git\n\n",
            "\nC:/r/.git\n",
            "\r\nC:/r/.git\n",
            // A repository path holding a newline: three lines, which no split can trust.
            "/tmp/a\nb/.git\n/tmp/a\nb/.git\n",
            "/tmp/a\nb/.git\n/tmp/a\n",
            "C:/r/.git\nC:/r/.git/worktrees/w\n\n",
        ] {
            let err = super::parse_git_dirs(text).err().expect(text);
            assert!(
                matches!(&err, AppError::Command(m)
                    if m == "git did not report this checkout's git directory."),
                "{text:?}: {err:?}"
            );
        }
    }

    /// Two branches that differ only in case coexist once one is packed: each name
    /// reads and deletes its own ref. On a case-sensitive filesystem these are two
    /// ordinary branches, a passing control.
    #[tokio::test]
    async fn case_twins_each_read_and_delete_their_own_ref() {
        let (_g, repo, feat, head) = delete_fixture("del-case-twins").await;
        run(&repo, &["pack-refs", "--all"]).await;
        run(&repo, &["update-ref", "refs/heads/Feat", &head]).await;
        let listing = |repo: String| async move {
            run(
                &repo,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads",
                ],
            )
            .await
        };
        let listed = listing(repo.clone()).await;
        let (feat_line, twin_line) = (
            format!("{} {feat}", "refs/heads/feat"),
            format!("{} {head}", "refs/heads/Feat"),
        );
        assert!(
            listed.lines().any(|l| l == feat_line) && listed.lines().any(|l| l == twin_line),
            "fixture sanity: {listed}"
        );

        assert_eq!(
            exact_branch_tip(&repo, "feat").await.unwrap(),
            Some(feat.clone())
        );
        assert_eq!(
            exact_branch_tip(&repo, "Feat").await.unwrap(),
            Some(head.clone())
        );
        // Config subsections are case-sensitive, so the twin's settings are its own.
        let feat_section = branch_section(&repo, "feat").await;
        for key in [
            "remote origin",
            "merge refs/heads/feat",
            "gitdesktoplocalonly true",
        ] {
            assert!(
                feat_section
                    .lines()
                    .any(|l| l == format!("branch.feat.{key}")),
                "fixture sanity: {feat_section}"
            );
        }
        let outcome = delete(&AppState::default(), &repo, "Feat", None).await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: head,
                kept_local: false,
                upstream: None,
            }
        );
        let listed = listing(repo.clone()).await;
        assert!(listed.lines().any(|l| l == feat_line), "{listed}");
        assert!(!listed.lines().any(|l| l == twin_line), "{listed}");
        let packed =
            std::fs::read_to_string(std::path::Path::new(&repo).join(".git/packed-refs")).unwrap();
        assert!(
            packed
                .lines()
                .any(|l| l == format!("{feat} {}", "refs/heads/feat")),
            "{packed}"
        );
        assert_eq!(branch_section(&repo, "feat").await, feat_section);
    }

    /// Whether `name` is aliased in `repo`: `for-each-ref` lists no ref of that exact
    /// spelling, yet `show-ref --verify` answers, as it does on a case-insensitive
    /// filesystem that resolves the spelling to another name's loose file.
    pub(crate) async fn is_aliased(repo: &str, name: &str) -> bool {
        let full_ref = super::branch_full_ref(name).unwrap();
        let listed = run(repo, &["for-each-ref", "--format=%(refname)", &full_ref]).await;
        let shown = run_git_raw(
            Some(repo),
            &["show-ref", "--verify", "--quiet", &full_ref],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        listed.trim().is_empty() && shown.code == 0
    }

    /// `delete_fixture` plus a `chore/x` branch, so a later `Chore/z` lands in the existing
    /// `chore/` folder and is listed as `chore/z`.
    async fn aliasing_fixture(tag: &str) -> (tempfile::TempDir, String) {
        let (g, repo, _feat, _head) = delete_fixture(tag).await;
        run(&repo, &["branch", "chore/x"]).await;
        (g, repo)
    }

    /// HEAD on `Chore/z` while the ref is stored as `chore/z`: the listed name is the
    /// current branch, so its delete is refused, pinned or not, and in the pass after
    /// `update-ref` too. Returns early on a case-sensitive filesystem or a non-files ref
    /// backend, where `Chore/z` is a ref of its own and the shape cannot arise.
    #[tokio::test]
    async fn delete_branch_refuses_the_stored_spelling_of_the_checked_out_branch() {
        let (_g, repo) = aliasing_fixture("del-alias-current").await;
        run(&repo, &["switch", "-q", "-c", "Chore/z"]).await;
        std::fs::write(std::path::Path::new(&repo).join("z.txt"), "z\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "z"]).await;
        if !is_aliased(&repo, "Chore/z").await {
            return;
        }
        let tip = exact_branch_tip(&repo, "chore/z").await.unwrap().unwrap();
        let loose = std::path::Path::new(&repo).join(".git/refs/heads/chore/z");
        let refused =
            "chore/z is checked out here — switch to another branch before deleting chore/z.";
        let state = AppState::default();

        for pin in [None, Some(tip.as_str())] {
            let err = delete(&state, &repo, "chore/z", pin).await.unwrap_err();
            assert!(
                matches!(&err, AppError::Command(m) if m == refused),
                "pinned {pin:?}: {err:?}"
            );
            assert!(loose.is_file());
            assert_eq!(
                run(&repo, &["symbolic-ref", "HEAD"]).await.trim(),
                "refs/heads/Chore/z"
            );
            assert_eq!(full_ref_tip(&repo, "HEAD").await, Some(tip.clone()));
        }

        // The pass after the delete: HEAD lands on the aliased spelling meanwhile.
        run(&repo, &["switch", "-q", "--detach"]).await;
        let hook = git_at_phase(
            DeletePhase::BeforeDelete,
            &repo,
            &["symbolic-ref", "HEAD", "refs/heads/Chore/z"],
        );
        let err = DELETE_PHASE_HOOK
            .scope(hook, delete(&state, &repo, "chore/z", Some(&tip)))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m) if m == refused),
            "{err:?}"
        );
        assert_eq!(
            full_ref_tip(&repo, "HEAD").await,
            Some(tip.clone()),
            "not unborn"
        );
        assert_eq!(exact_branch_tip(&repo, "chore/z").await.unwrap(), Some(tip));
    }

    /// The same shape held by a linked worktree whose porcelain line says
    /// `branch refs/heads/Chore/z`, before the delete and in the pass after it. Returns
    /// early on a case-sensitive filesystem or a non-files ref backend, as above.
    #[tokio::test]
    async fn delete_branch_refuses_the_stored_spelling_a_sibling_worktree_holds() {
        let (g, repo) = aliasing_fixture("del-alias-sibling").await;
        let wt = g.path().join("alias-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "-b", "Chore/z", &wt]).await;
        if !is_aliased(&repo, "Chore/z").await {
            return;
        }
        let tip = exact_branch_tip(&repo, "chore/z").await.unwrap().unwrap();
        let held = |err: &AppError| {
            matches!(err, AppError::Command(m)
                if m.starts_with("chore/z is checked out in the worktree at")
                    && m.contains("alias-wt")
                    && m.ends_with("before deleting chore/z."))
        };
        let state = AppState::default();

        for pin in [None, Some(tip.as_str())] {
            let err = delete(&state, &repo, "chore/z", pin).await.unwrap_err();
            assert!(held(&err), "pinned {pin:?}: {err:?}");
            assert_eq!(
                exact_branch_tip(&repo, "chore/z").await.unwrap(),
                Some(tip.clone())
            );
            assert_eq!(
                run(&wt, &["symbolic-ref", "HEAD"]).await.trim(),
                "refs/heads/Chore/z"
            );
        }

        // The pass after the delete: the sibling lands on the aliased spelling meanwhile.
        run(&wt, &["switch", "-q", "--detach"]).await;
        let hook = git_at_phase(
            DeletePhase::BeforeDelete,
            &wt,
            &["symbolic-ref", "HEAD", "refs/heads/Chore/z"],
        );
        let err = DELETE_PHASE_HOOK
            .scope(hook, delete(&state, &repo, "chore/z", Some(&tip)))
            .await
            .unwrap_err();
        assert!(held(&err), "{err:?}");
        assert_eq!(
            full_ref_tip(&wt, "HEAD").await,
            Some(tip.clone()),
            "not unborn"
        );
        assert_eq!(exact_branch_tip(&repo, "chore/z").await.unwrap(), Some(tip));
    }

    /// `branch_tip_sha` answers an aliased spelling through the loose file, never git's
    /// ref-search fallback or a tag. Returns early on a case-sensitive filesystem or a
    /// non-files ref backend, as above.
    #[tokio::test]
    async fn branch_tip_sha_reads_an_aliased_spelling() {
        let (_g, repo) = aliasing_fixture("tip-alias").await;
        run(&repo, &["branch", "Chore/z"]).await;
        run(&repo, &["update-ref", "refs/heads/refs/heads/Fb", "HEAD"]).await;
        run(&repo, &["tag", "Tg"]).await;
        if !is_aliased(&repo, "Chore/z").await {
            return;
        }
        let tip = full_ref_tip(&repo, "HEAD").await.unwrap();
        assert_eq!(
            full_ref_tip(&repo, "refs/heads/Fb").await,
            Some(tip.clone()),
            "fixture sanity: rev-parse takes the fallback"
        );

        assert_eq!(
            branch_tip_sha(&repo, "Chore/z").await.unwrap(),
            Some(tip.clone())
        );
        assert_eq!(branch_tip_sha(&repo, "chore/z").await.unwrap(), Some(tip));
        assert_eq!(branch_tip_sha(&repo, "Nope").await.unwrap(), None);
        assert_eq!(branch_tip_sha(&repo, "Fb").await.unwrap(), None);
        assert_eq!(branch_tip_sha(&repo, "Tg").await.unwrap(), None);
    }

    /// HEAD on `Chore/z` (stored as `chore/z`) at `z1`, with `up` one commit ahead and set
    /// as `chore/z`'s upstream. Returns (guard, repo, z1, up's tip), or `None` on a
    /// case-sensitive filesystem or a non-files ref backend, where `Chore/z` is a ref of
    /// its own.
    async fn aliased_current_fixture(
        tag: &str,
    ) -> Option<(tempfile::TempDir, String, String, String)> {
        let (g, repo) = aliasing_fixture(tag).await;
        let commit = |repo: String, file: &'static str| async move {
            std::fs::write(std::path::Path::new(&repo).join(file), "z\n").unwrap();
            run(&repo, &["add", "-A"]).await;
            run(&repo, &["commit", "-qm", file]).await;
        };
        run(&repo, &["switch", "-q", "-c", "Chore/z"]).await;
        commit(repo.clone(), "z1.txt").await;
        run(&repo, &["switch", "-q", "-c", "up"]).await;
        commit(repo.clone(), "z2.txt").await;
        run(&repo, &["switch", "-q", "Chore/z"]).await;
        if !is_aliased(&repo, "Chore/z").await {
            return None;
        }
        assert_eq!(
            run(&repo, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/Chore/z",
            "fixture sanity"
        );
        run(&repo, &["config", "branch.chore/z.remote", "."]).await;
        run(&repo, &["config", "branch.chore/z.merge", "refs/heads/up"]).await;
        let z1 = full_ref_tip(&repo, "HEAD").await.unwrap();
        let up = full_ref_tip(&repo, "refs/heads/up").await.unwrap();
        Some((g, repo, z1, up))
    }

    /// The reset asked about the stored spelling of the checked-out branch takes the
    /// current branch's refusal, so the ref never moves under the working tree. Returns
    /// early on a case-sensitive filesystem or a non-files ref backend, as above.
    #[tokio::test]
    async fn reset_to_upstream_refuses_the_stored_spelling_of_the_checked_out_branch() {
        let Some((_g, repo, z1, up)) = aliased_current_fixture("reset-alias-current").await else {
            return;
        };
        let err = branch_reset_to_upstream(&AppState::default(), &repo, "chore/z", &up, &z1)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m) if m == "chore/z is checked out here — use \
                Reset to chore/z's upstream from the sync controls, which moves your working \
                tree with it."),
            "{err:?}"
        );
        assert_eq!(full_ref_tip(&repo, "HEAD").await, Some(z1));
        assert!(!std::path::Path::new(&repo).join("z2.txt").exists());
    }

    /// The update asked about the stored spelling of the checked-out branch merges in
    /// place, so HEAD's commit and the working tree move together. Returns early on a
    /// case-sensitive filesystem or a non-files ref backend, as above.
    #[tokio::test]
    async fn update_branch_from_merges_the_stored_spelling_of_the_checked_out_branch_in_place() {
        let Some((_g, repo, _z1, up)) = aliased_current_fixture("update-alias-current").await
        else {
            return;
        };
        let outcome = update_branch_from(
            &AppState::default(),
            &repo,
            "chore/z",
            "up",
            &HashSet::new(),
            None,
        )
        .await;
        assert!(outcome.is_ok(), "{outcome:?}");
        assert_eq!(full_ref_tip(&repo, "HEAD").await, Some(up));
        assert!(std::path::Path::new(&repo).join("z2.txt").is_file());
        assert_eq!(run(&repo, &["status", "--porcelain"]).await.trim(), "");
        assert_eq!(
            run(&repo, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/Chore/z"
        );
    }

    /// A rebase stopped on `Chore/z` (stored as `chore/z`) records `refs/heads/Chore/z` as
    /// its head-name, and HEAD is detached, so only the operation guard stands between a
    /// delete of the listed `chore/z` and the ref: it refuses as for the exact name.
    /// Returns early on a case-sensitive filesystem or a non-files ref backend, where
    /// `Chore/z` is a ref of its own.
    #[tokio::test]
    async fn delete_branch_refuses_the_stored_spelling_of_a_branch_being_rebased() {
        let Some((_g, repo, z1, _up)) = aliased_current_fixture("del-alias-rebase").await else {
            return;
        };
        run(&repo, &["switch", "-q", "-c", "base", "HEAD~1"]).await;
        std::fs::write(std::path::Path::new(&repo).join("z1.txt"), "base\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "base z1"]).await;
        run(&repo, &["switch", "-q", "Chore/z"]).await;
        let rebase = run_git_raw(Some(&repo), &["rebase", "base"], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        assert_ne!(
            rebase.code, 0,
            "fixture sanity: the rebase stops on a conflict"
        );
        let head_name = std::path::Path::new(&repo).join(".git/rebase-merge/head-name");
        assert_eq!(
            std::fs::read_to_string(head_name).unwrap().trim_end(),
            "refs/heads/Chore/z",
            "fixture sanity"
        );
        let state = AppState::default();

        for pin in [None, Some(z1.as_str())] {
            let err = delete(&state, &repo, "chore/z", pin).await.unwrap_err();
            assert!(
                matches!(&err, AppError::Command(m) if m == "chore/z is being rebased here — \
                    finish or abort that rebase before deleting chore/z."),
                "pinned {pin:?}: {err:?}"
            );
            assert_eq!(
                exact_branch_tip(&repo, "chore/z").await.unwrap(),
                Some(z1.clone())
            );
        }
    }

    /// A bisect started on `Chore/z` (stored as `chore/z`) records `Chore/z` in
    /// `BISECT_START` and detaches HEAD at its first step, so a delete of the listed
    /// `chore/z` takes the bisect refusal. Returns early on a case-sensitive filesystem or
    /// a non-files ref backend, where `Chore/z` is a ref of its own.
    #[tokio::test]
    async fn delete_branch_refuses_the_stored_spelling_of_a_branch_being_bisected() {
        let Some((_g, repo, _z1, _up)) = aliased_current_fixture("del-alias-bisect").await else {
            return;
        };
        for file in ["z3.txt", "z4.txt"] {
            std::fs::write(std::path::Path::new(&repo).join(file), "z\n").unwrap();
            run(&repo, &["add", "-A"]).await;
            run(&repo, &["commit", "-qm", file]).await;
        }
        let tip = full_ref_tip(&repo, "HEAD").await.unwrap();
        run(&repo, &["bisect", "start", "Chore/z", "HEAD~3"]).await;
        let start = std::path::Path::new(&repo).join(".git/BISECT_START");
        assert_eq!(
            std::fs::read_to_string(start).unwrap().trim_end(),
            "Chore/z",
            "fixture sanity"
        );
        let detached = run_git_raw(
            Some(&repo),
            &["symbolic-ref", "-q", "HEAD"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_ne!(detached.code, 0, "fixture sanity: the bisect detached HEAD");
        let state = AppState::default();

        for pin in [None, Some(tip.as_str())] {
            let err = delete(&state, &repo, "chore/z", pin).await.unwrap_err();
            assert!(
                matches!(&err, AppError::Command(m) if m == "chore/z is being bisected here — \
                    end that bisect (git bisect reset) before deleting chore/z."),
                "pinned {pin:?}: {err:?}"
            );
            assert_eq!(
                exact_branch_tip(&repo, "chore/z").await.unwrap(),
                Some(tip.clone())
            );
        }
    }

    #[test]
    fn eq_ignoring_case_folds_non_ascii_letters() {
        for (a, b, same) in [
            ("É/z", "é/z", true),
            ("Chore/z", "chore/z", true),
            ("é/z", "e/z", false),
            ("feat", "fear", false),
            // Measured on NTFS: a capital sigma aliases the medial one, never the final.
            ("AΣ", "aσ", true),
            ("AΣ", "aς", false),
            ("aσ", "aς", false),
        ] {
            assert_eq!(super::eq_ignoring_case(a, b), same, "{a} vs {b}");
        }
    }

    /// `delete_fixture` plus `<dir>/x`, then `held` (the stored `<dir>/z` or its
    /// capitalized spelling) checked out at `z1` in a linked worktree when `linked`, else
    /// here, with `up` one commit ahead. Returns (guard, repo, checkout, z1, up), or
    /// `None` when the capitalized spelling is not aliased: a case-sensitive filesystem,
    /// or a non-files ref backend (`GIT_DEFAULT_REF_FORMAT` beats the fixture's `-c` pin).
    async fn held_spelling_fixture(
        tag: &str,
        dir: &str,
        held: &str,
        linked: bool,
    ) -> Option<(tempfile::TempDir, String, String, String, String)> {
        let (g, repo, _feat, _head) = delete_fixture(tag).await;
        run(&repo, &["branch", &format!("{dir}/x")]).await;
        let aliased = format!("{}{}/z", dir[..1].to_uppercase(), &dir[1..]);
        let checkout = if linked {
            let wt = g.path().join("held-wt").to_string_lossy().into_owned();
            run(&repo, &["worktree", "add", "-q", "-b", held, &wt]).await;
            wt
        } else {
            run(&repo, &["switch", "-q", "-c", held]).await;
            repo.clone()
        };
        let commit = |at: String, file: &'static str| async move {
            std::fs::write(std::path::Path::new(&at).join(file), "z\n").unwrap();
            run(&at, &["add", "-A"]).await;
            run(&at, &["commit", "-qm", file]).await;
        };
        commit(checkout.clone(), "z1.txt").await;
        run(&checkout, &["switch", "-q", "-c", "up"]).await;
        commit(checkout.clone(), "z2.txt").await;
        run(&checkout, &["switch", "-q", held]).await;
        if !is_aliased(&repo, &aliased).await {
            return None;
        }
        let z1 = full_ref_tip(&checkout, "HEAD").await.unwrap();
        let up = full_ref_tip(&repo, "refs/heads/up").await.unwrap();
        Some((g, repo, checkout, z1, up))
    }

    /// A checkout (this one, then a sibling) on the stored `chore/z` while the reset names
    /// the aliased `Chore/z`: no guard matches, so the exact tip read refuses as moved
    /// rather than `update-ref` writing `chore/z`'s file under that checkout. Returns
    /// early on a case-sensitive filesystem or a non-files ref backend.
    #[tokio::test]
    async fn reset_to_upstream_refuses_an_aliased_spelling_of_a_checked_out_branch() {
        for linked in [false, true] {
            let Some((_g, repo, checkout, z1, up)) =
                held_spelling_fixture("reset-alias-target", "chore", "chore/z", linked).await
            else {
                return;
            };
            run(&repo, &["config", "branch.Chore/z.remote", "."]).await;
            run(&repo, &["config", "branch.Chore/z.merge", "refs/heads/up"]).await;
            let err = branch_reset_to_upstream(&AppState::default(), &repo, "Chore/z", &up, &z1)
                .await
                .unwrap_err();
            assert!(
                matches!(&err, AppError::Git { stderr, .. }
                    if stderr == "Chore/z changed since you confirmed — nothing was reset."),
                "linked {linked}: {err:?}"
            );
            assert_eq!(
                exact_branch_tip(&repo, "chore/z").await.unwrap(),
                Some(z1.clone())
            );
            assert_eq!(full_ref_tip(&checkout, "HEAD").await, Some(z1));
            assert!(!std::path::Path::new(&checkout).join("z2.txt").exists());
            assert_eq!(run(&checkout, &["status", "--porcelain"]).await.trim(), "");
        }
    }

    /// A checkout (this one, then a sibling) on `Chore/z` with `chore/z` packed after the
    /// checkout, so its HEAD reads no ref now: a bare write of `chore/z` would make a loose
    /// file that HEAD then reads, so the reset still refuses as checked out and writes
    /// nothing. Returns early on a case-sensitive filesystem or a non-files ref backend.
    #[tokio::test]
    async fn reset_to_upstream_refuses_a_checkout_whose_branch_was_packed_after_it() {
        for linked in [false, true] {
            let Some((_g, repo, checkout, z1, up)) =
                held_spelling_fixture("reset-packed-holder", "chore", "Chore/z", linked).await
            else {
                return;
            };
            run(&repo, &["config", "branch.chore/z.remote", "."]).await;
            run(&repo, &["config", "branch.chore/z.merge", "refs/heads/up"]).await;
            run(&repo, &["pack-refs", "--all"]).await;
            assert_eq!(
                full_ref_tip(&checkout, "HEAD").await,
                None,
                "fixture sanity: HEAD reads no ref"
            );
            let err = branch_reset_to_upstream(&AppState::default(), &repo, "chore/z", &up, &z1)
                .await
                .unwrap_err();
            let refused = match &err {
                AppError::Command(m) if linked => {
                    m.starts_with("chore/z is checked out in the worktree at ")
                        && m.ends_with("before resetting chore/z.")
                }
                AppError::Command(m) => {
                    m == "chore/z is checked out here — use Reset to chore/z's upstream from \
                          the sync controls, which moves your working tree with it."
                }
                _ => false,
            };
            assert!(refused, "linked {linked}: {err:?}");
            assert_eq!(
                exact_branch_tip(&repo, "chore/z").await.unwrap(),
                Some(z1.clone())
            );
            assert_eq!(
                full_ref_tip(&checkout, "HEAD").await,
                None,
                "linked {linked}"
            );
        }
    }

    /// A rebase stopped on `Chore/z` with `chore/z` packed mid-rebase: the recorded
    /// spelling reads no ref, but a bare write would make one it reads, so the reset gets
    /// the in-operation refusal and the ref stays. Returns early on a case-sensitive
    /// filesystem or a non-files ref backend.
    #[tokio::test]
    async fn reset_to_upstream_refuses_a_rebase_whose_branch_was_packed_mid_rebase() {
        let Some((_g, repo, z1, up)) = aliased_current_fixture("reset-packed-rebase").await else {
            return;
        };
        run(&repo, &["switch", "-q", "-c", "base", "HEAD~1"]).await;
        std::fs::write(std::path::Path::new(&repo).join("z1.txt"), "base\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "base z1"]).await;
        run(&repo, &["switch", "-q", "Chore/z"]).await;
        let rebase = run_git_raw(Some(&repo), &["rebase", "base"], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        assert_ne!(
            rebase.code, 0,
            "fixture sanity: the rebase stops on a conflict"
        );
        run(&repo, &["pack-refs", "--all"]).await;
        assert!(
            !is_aliased(&repo, "Chore/z").await,
            "fixture sanity: the recorded spelling reads no ref"
        );
        let err = branch_reset_to_upstream(&AppState::default(), &repo, "chore/z", &up, &z1)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m) if m == "chore/z is being rebased here — \
                finish or abort that rebase before resetting chore/z."),
            "{err:?}"
        );
        assert_eq!(exact_branch_tip(&repo, "chore/z").await.unwrap(), Some(z1));
    }

    /// The update names the aliased `<Dir>/z` while the branch is stored as `<dir>/z`: it
    /// acts on the stored branch. Held here, it merges in place (HEAD, the ref, the index
    /// and the tree move together); held by a sibling, it runs inside that sibling; held
    /// nowhere, the stored ref fast-forwards and no second ref appears. The sibling's
    /// holder arm mints a marker under the process-wide root override, so its branch is
    /// one no other test uses. Returns early on a case-sensitive filesystem or a non-files
    /// ref backend.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_branch_from_acts_on_the_stored_spelling_of_an_aliased_target() {
        for (dir, linked, held) in [
            ("chore", false, true),
            ("sib", true, true),
            ("chore", false, false),
        ] {
            let stored = format!("{dir}/z");
            let aliased = format!("{}{}/z", dir[..1].to_uppercase(), &dir[1..]);
            let Some((_g, repo, checkout, _z1, up)) =
                held_spelling_fixture("update-alias-target", dir, &stored, linked).await
            else {
                return;
            };
            if !held {
                run(&repo, &["switch", "-q", "up"]).await;
            }
            let main_head = full_ref_tip(&repo, "HEAD").await;
            // Unpacked into two bindings: held as one tuple, the lock would drop before
            // the override it serializes.
            let (_serialized, _override) = linked
                .then(|| holder_marker_root(&repo))
                .map(|(lock, installed, _)| (lock, installed))
                .unzip();
            let outcome = update_branch_from(
                &AppState::default(),
                &repo,
                &aliased,
                "up",
                &HashSet::new(),
                None,
            )
            .await;
            let case = format!("{aliased}, linked {linked}, held {held}");
            let outcome = outcome.unwrap_or_else(|e| panic!("{case}: {e:?}"));
            assert_eq!(outcome.outcome, "fast-forward", "{case}");
            assert_eq!(outcome.holder.is_some(), linked, "{case}");
            let listed = run(
                &repo,
                &["for-each-ref", "--format=%(refname)", "refs/heads/"],
            )
            .await;
            let names: Vec<&str> = listed
                .lines()
                .filter_map(|l| l.strip_prefix("refs/heads/"))
                .collect();
            assert!(names.contains(&stored.as_str()), "{case}: {names:?}");
            assert!(!names.contains(&aliased.as_str()), "{case}: {names:?}");
            assert_eq!(
                exact_branch_tip(&repo, &stored).await.unwrap(),
                Some(up.clone()),
                "{case}"
            );
            if held {
                assert_eq!(full_ref_tip(&checkout, "HEAD").await, Some(up), "{case}");
                assert!(std::path::Path::new(&checkout).join("z2.txt").is_file());
                assert_eq!(run(&checkout, &["status", "--porcelain"]).await.trim(), "");
                let symref = run(&checkout, &["symbolic-ref", "HEAD"]).await;
                assert_eq!(
                    symref.trim().strip_prefix("refs/heads/"),
                    Some(stored.as_str())
                );
            }
            if linked || !held {
                assert_eq!(full_ref_tip(&repo, "HEAD").await, main_head, "{case}");
            }
        }
    }

    /// A sibling on `Upd/z` holds the stored `upd/z`, so the update runs inside it: its
    /// HEAD and tree move together. Returns early on a case-sensitive filesystem or a
    /// non-files ref backend.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_branch_from_updates_an_aliased_sibling_in_place() {
        let Some((_g, repo, wt, _z1, up)) =
            held_spelling_fixture("update-alias-sibling", "upd", "Upd/z", true).await
        else {
            return;
        };
        // The holder arm mints an update marker under the process-wide root override, so
        // the branch name is one no other test uses.
        let (_serialized, _override, _root) = holder_marker_root(&repo);
        let outcome = update_branch_from(
            &AppState::default(),
            &repo,
            "upd/z",
            "up",
            &HashSet::new(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(outcome.outcome, "fast-forward");
        assert!(outcome.holder.is_some(), "{outcome:?}");
        assert_eq!(full_ref_tip(&wt, "HEAD").await, Some(up));
        assert!(std::path::Path::new(&wt).join("z2.txt").is_file());
        assert_eq!(run(&wt, &["status", "--porcelain"]).await.trim(), "");
        assert_eq!(
            run(&wt, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/Upd/z"
        );
    }

    /// HEAD on `É/z` while the ref is stored as `é/z`: refused up front (the reflog
    /// survives, so nothing was deleted and put back), and when HEAD lands there after the
    /// first guard pass, the delete is put back and HEAD resolves as before. Returns early
    /// on a case-sensitive filesystem or a non-files ref backend.
    #[tokio::test]
    async fn delete_branch_puts_back_a_ref_under_a_non_ascii_case_variant_checkout() {
        let (_g, repo, _feat, head) = delete_fixture("del-alias-nonascii").await;
        run(&repo, &["branch", "é/z"]).await;
        if !is_aliased(&repo, "É/z").await {
            return;
        }
        let refused = "é/z is checked out here — switch to another branch before deleting é/z.";
        let state = AppState::default();

        run(&repo, &["symbolic-ref", "HEAD", "refs/heads/É/z"]).await;
        let err = delete(&state, &repo, "é/z", None).await.unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m) if m == refused),
            "{err:?}"
        );
        // A put-back starts a fresh reflog, so the creation entry proves no delete ran.
        let reflog = run(&repo, &["reflog", "show", "--format=%gs", "refs/heads/é/z"]).await;
        assert!(
            reflog.contains("branch: Created from"),
            "never deleted: {reflog}"
        );

        run(&repo, &["switch", "-q", "--detach"]).await;
        let hook = git_at_phase(
            DeletePhase::BeforeDelete,
            &repo,
            &["symbolic-ref", "HEAD", "refs/heads/É/z"],
        );
        let err = DELETE_PHASE_HOOK
            .scope(hook, delete(&state, &repo, "é/z", Some(&head)))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m) if m == refused),
            "{err:?}"
        );
        assert_eq!(
            exact_branch_tip(&repo, "é/z").await.unwrap(),
            Some(head.clone())
        );
        assert_eq!(full_ref_tip(&repo, "HEAD").await, Some(head));
    }

    /// `Feat` packed at the seed and `feat` loose at `head`: a checkout on `Feat` reads
    /// `feat`'s loose file. Refused up front (the reflog survives), and when HEAD lands on
    /// `Feat` after the first guard pass, only the HEAD compare sees it (with the loose
    /// file gone, `Feat` reads its own packed ref): the delete is put back and HEAD
    /// resolves to `head` again. Returns early on a case-sensitive filesystem or a
    /// non-files ref backend, where the two never share a file.
    #[tokio::test]
    async fn delete_branch_puts_back_the_loose_twin_under_a_packed_twin_checkout() {
        let Some((_g, repo, _seed, head, _up)) =
            packed_twin_fixture("del-packed-twin", false).await
        else {
            return;
        };
        let refused = "feat is checked out here — switch to another branch before deleting feat.";
        let state = AppState::default();

        run(&repo, &["symbolic-ref", "HEAD", "refs/heads/Feat"]).await;
        let err = delete(&state, &repo, "feat", None).await.unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m) if m == refused),
            "{err:?}"
        );
        // A put-back starts a fresh reflog, so the twin's own entry proves no delete ran.
        let reflog = run(
            &repo,
            &["reflog", "show", "--format=%gs", "refs/heads/feat"],
        )
        .await;
        assert!(reflog.contains("loose twin"), "never deleted: {reflog}");

        run(&repo, &["switch", "-q", "--detach"]).await;
        let hook = git_at_phase(
            DeletePhase::BeforeDelete,
            &repo,
            &["symbolic-ref", "HEAD", "refs/heads/Feat"],
        );
        let err = DELETE_PHASE_HOOK
            .scope(hook, delete(&state, &repo, "feat", Some(&head)))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m) if m == refused),
            "{err:?}"
        );
        assert_eq!(
            exact_branch_tip(&repo, "feat").await.unwrap(),
            Some(head.clone())
        );
        assert_eq!(full_ref_tip(&repo, "HEAD").await, Some(head));
    }

    /// `delete_fixture` with `Feat` packed at the seed and `feat` loose at the next commit,
    /// or back at the seed when `same`, created with the reflog message "loose twin", plus
    /// `up`, a child of the next commit, as `Feat`'s upstream. Returns (guard, repo, seed,
    /// feat's tip, up), or `None` when raw git reads the two apart: a case-sensitive
    /// filesystem or a non-files ref backend.
    async fn packed_twin_fixture(
        tag: &str,
        same: bool,
    ) -> Option<(tempfile::TempDir, String, String, String, String)> {
        let (g, repo, seed, head) = delete_fixture(tag).await;
        run(&repo, &["pack-refs", "--all"]).await;
        run(&repo, &["update-ref", "refs/heads/Feat", &seed]).await;
        run(&repo, &["pack-refs", "--all"]).await;
        run(&repo, &["update-ref", "-d", "refs/heads/feat", &seed]).await;
        run(
            &repo,
            &["update-ref", "-m", "loose twin", "refs/heads/feat", &head],
        )
        .await;
        let shown = run(
            &repo,
            &["show-ref", "--verify", "--hash", "refs/heads/Feat"],
        )
        .await;
        let listed = run(
            &repo,
            &["for-each-ref", "--format=%(objectname)", "refs/heads/Feat"],
        )
        .await;
        if shown.trim() != head || listed.trim() != seed {
            return None;
        }
        let tree = format!("{head}^{{tree}}");
        let up = run(&repo, &["commit-tree", &tree, "-p", &head, "-m", "up"]).await;
        let up = up.trim().to_string();
        run(&repo, &["update-ref", "refs/heads/up", &up]).await;
        run(&repo, &["config", "branch.Feat.remote", "."]).await;
        run(&repo, &["config", "branch.Feat.merge", "refs/heads/up"]).await;
        let tip = if same {
            run(&repo, &["update-ref", "refs/heads/feat", &seed, &head]).await;
            seed.clone()
        } else {
            head
        };
        Some((g, repo, seed, tip, up))
    }

    /// `feat` checked out here, or in a linked worktree when `linked`; the checkout's path.
    async fn twin_checkout(g: &tempfile::TempDir, repo: &str, linked: bool) -> String {
        if linked {
            let wt = g.path().join("twin-wt").to_string_lossy().into_owned();
            run(repo, &["worktree", "add", "-q", &wt, "feat"]).await;
            wt
        } else {
            run(repo, &["switch", "-q", "feat"]).await;
            repo.to_string()
        }
    }

    /// Both twins at their fixture tips, the checkout's HEAD at `head` over a clean tree,
    /// and the loose file still named `feat`, all read through raw git and the disk.
    async fn assert_twins_intact(repo: &str, checkout: &str, seed: &str, tip: &str, head: &str) {
        let listed = run(
            repo,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads/",
            ],
        )
        .await;
        assert!(
            listed.contains(&format!("refs/heads/Feat {seed}")),
            "{listed}"
        );
        assert!(
            listed.contains(&format!("refs/heads/feat {tip}")),
            "{listed}"
        );
        assert_eq!(full_ref_tip(checkout, "HEAD").await.as_deref(), Some(head));
        assert_eq!(run(checkout, &["status", "--porcelain"]).await.trim(), "");
        let loose: Vec<String> =
            std::fs::read_dir(std::path::Path::new(repo).join(".git/refs/heads"))
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
        assert!(loose.iter().any(|n| n == "feat"), "{loose:?}");
        assert!(!loose.iter().any(|n| n == "Feat"), "{loose:?}");
    }

    const TWIN_REFUSAL: &str = "Feat and feat differ only in letter case, which this disk \
        can't keep apart. Rename one of them, then try again.";

    /// A reset of `Feat` while `feat`, sharing its loose file, is checked out (here, then
    /// in a sibling) is refused as twins and changes nothing. Returns early on a
    /// case-sensitive filesystem or a non-files ref backend.
    #[tokio::test]
    async fn reset_to_upstream_refuses_a_case_twin_of_a_checked_out_branch() {
        for linked in [false, true] {
            let Some((g, repo, seed, tip, up)) = packed_twin_fixture("reset-twin", false).await
            else {
                return;
            };
            let checkout = twin_checkout(&g, &repo, linked).await;
            let err = branch_reset_to_upstream(&AppState::default(), &repo, "Feat", &up, &seed)
                .await
                .unwrap_err();
            assert!(
                matches!(&err, AppError::Command(m) if m == TWIN_REFUSAL),
                "linked {linked}: {err:?}"
            );
            assert_twins_intact(&repo, &checkout, &seed, &tip, &tip).await;
        }
    }

    /// The reset with `feat` checked out at `Feat`'s own commit: git's old-value check
    /// passes, so only the twin refusal keeps `update-ref` off `feat`'s file, with
    /// `core.ignorecase` true and set false (the disk folds case either way). The refs are
    /// asserted before the verdict, so a write shows as the move it made. Returns early on
    /// a case-sensitive filesystem or a non-files ref backend.
    #[tokio::test]
    async fn reset_to_upstream_refuses_a_case_twin_at_the_same_commit() {
        for ignorecase in ["false", "true"] {
            let Some((g, repo, seed, tip, up)) = packed_twin_fixture("reset-twin-same", true).await
            else {
                return;
            };
            run(&repo, &["config", "core.ignorecase", ignorecase]).await;
            let checkout = twin_checkout(&g, &repo, false).await;
            let result =
                branch_reset_to_upstream(&AppState::default(), &repo, "Feat", &up, &seed).await;
            assert_twins_intact(&repo, &checkout, &seed, &tip, &tip).await;
            assert!(
                matches!(&result, Err(AppError::Command(m)) if m == TWIN_REFUSAL),
                "ignorecase {ignorecase}: {result:?}"
            );
        }
    }

    /// The update with `feat` checked out at `Feat`'s own commit and `up` ahead of both:
    /// `fetch .`'s old value matches too, so only the twin refusal keeps it off `feat`'s
    /// file, with `core.ignorecase` true and set false. The refs are asserted before the
    /// verdict, so a write shows as the move it made. Returns early on a case-sensitive
    /// filesystem or a non-files ref backend.
    #[tokio::test]
    async fn update_branch_from_refuses_a_case_twin_at_the_same_commit() {
        for ignorecase in ["false", "true"] {
            let Some((g, repo, seed, tip, _up)) =
                packed_twin_fixture("update-twin-same", true).await
            else {
                return;
            };
            run(&repo, &["config", "core.ignorecase", ignorecase]).await;
            let checkout = twin_checkout(&g, &repo, false).await;
            let outcome = update_branch_from(
                &AppState::default(),
                &repo,
                "Feat",
                "up",
                &HashSet::new(),
                None,
            )
            .await;
            assert_twins_intact(&repo, &checkout, &seed, &tip, &tip).await;
            assert!(
                matches!(&outcome, Err(AppError::Command(m)) if m == TWIN_REFUSAL),
                "ignorecase {ignorecase}: {outcome:?}"
            );
        }
    }

    /// An update of `Feat` from `up`, a descendant of both twins, while `feat` is checked
    /// out (here, then in a sibling): refused as twins before `fetch .` could fast-forward
    /// `feat`'s file under that checkout. Returns early on a case-sensitive filesystem or a
    /// non-files ref backend.
    #[tokio::test]
    async fn update_branch_from_refuses_a_case_twin_of_a_checked_out_branch() {
        for linked in [false, true] {
            let Some((g, repo, seed, tip, _up)) = packed_twin_fixture("update-twin", false).await
            else {
                return;
            };
            let checkout = twin_checkout(&g, &repo, linked).await;
            let outcome = update_branch_from(
                &AppState::default(),
                &repo,
                "Feat",
                "up",
                &HashSet::new(),
                None,
            )
            .await;
            assert!(
                matches!(&outcome, Err(AppError::Command(m)) if m == TWIN_REFUSAL),
                "linked {linked}: {outcome:?}"
            );
            assert_twins_intact(&repo, &checkout, &seed, &tip, &tip).await;
        }
    }

    /// The bare-move verdict for each class: a twin is refused only where refs can alias,
    /// and a name without an exact ref has no tip to compare against.
    #[test]
    fn bare_move_gate_refuses_a_twin_only_where_refs_can_alias() {
        use super::{bare_move_gate, BranchSpelling};
        let own = || BranchSpelling::Own { tip: "a".into() };
        let twin = || BranchSpelling::Twin {
            tip: "a".into(),
            twin: "feat".into(),
        };
        for can_alias in [true, false] {
            assert_eq!(
                bare_move_gate("Feat", own(), can_alias).unwrap(),
                Some("a".to_string())
            );
            assert_eq!(
                bare_move_gate("Feat", BranchSpelling::StoredAs("feat".into()), can_alias).unwrap(),
                None
            );
            assert_eq!(
                bare_move_gate("Feat", BranchSpelling::Missing, can_alias).unwrap(),
                None
            );
            let folded = BranchSpelling::FoldedTwins {
                first: "Feat".into(),
                second: "feat".into(),
            };
            assert!(matches!(
                bare_move_gate("FEAT", folded, can_alias),
                Err(AppError::Command(m)) if m == TWIN_REFUSAL
            ));
        }
        assert!(matches!(
            bare_move_gate("Feat", twin(), true),
            Err(AppError::Command(m)) if m == TWIN_REFUSAL
        ));
        assert_eq!(
            bare_move_gate("Feat", twin(), false).unwrap(),
            Some("a".to_string())
        );
    }

    /// Another spelling is stored as a branch only where git reads a ref by it: a loose
    /// stored name read by the capitalized spelling is `StoredAs`, while a packed-only one
    /// (whose lookup never folds case, standing in for a case-sensitive disk) is
    /// `Missing`. Returns early on a case-sensitive filesystem or a non-files ref backend.
    #[tokio::test]
    async fn branch_spelling_takes_another_spelling_only_where_git_reads_it() {
        let (_g, repo, _feat, _head) = delete_fixture("spelling-read").await;
        run(&repo, &["branch", "solo"]).await;
        run(&repo, &["pack-refs", "--all"]).await;
        run(&repo, &["branch", "loose"]).await;
        if !is_aliased(&repo, "LOOSE").await {
            return;
        }
        assert_eq!(
            super::branch_spelling(&repo, "LOOSE", false).await.unwrap(),
            super::BranchSpelling::StoredAs("loose".to_string())
        );
        for find_twin in [false, true] {
            assert_eq!(
                super::branch_spelling(&repo, "SOLO", find_twin)
                    .await
                    .unwrap(),
                super::BranchSpelling::Missing,
                "find_twin {find_twin}"
            );
        }
        assert_eq!(
            super::stored_branch_spelling(&repo, "SOLO").await.unwrap(),
            "SOLO"
        );
    }

    /// A case-only holder spelling with no exact ref that reads none, as `SOLO` over the
    /// packed-only `solo`, holds it exactly where refs can alias (true on this machine's
    /// disk); a loose `loose` read as `LOOSE` holds. The loose row returns early on a
    /// case-sensitive filesystem or a non-files ref backend.
    #[tokio::test]
    async fn holds_branch_needs_a_ref_read_by_the_holder_spelling() {
        let (_g, repo, _feat, _head) = delete_fixture("holds-read").await;
        run(&repo, &["branch", "solo"]).await;
        run(&repo, &["pack-refs", "--all"]).await;
        run(&repo, &["branch", "loose"]).await;
        assert!(
            !is_aliased(&repo, "SOLO").await,
            "fixture sanity: no ref reads as SOLO"
        );
        let can_alias = super::refs_can_alias(&repo).await;
        assert_eq!(super::holds_branch(&repo, "SOLO", "solo").await, can_alias);
        assert!(super::holds_branch(&repo, "solo", "solo").await);
        if !is_aliased(&repo, "LOOSE").await {
            return;
        }
        assert!(can_alias, "a disk that aliases LOOSE folds case");
        assert!(super::holds_branch(&repo, "SOLO", "solo").await);
        assert!(super::holds_branch(&repo, "LOOSE", "loose").await);
    }

    /// The case-only holder verdict over each read outcome, the case-sensitive rows
    /// included, which this machine's disk can't produce.
    #[test]
    fn holder_spelling_holds_by_exact_ref_loose_read_and_disk() {
        use super::holder_spelling_holds;
        let spawn_failed = || Err(AppError::Command("spawn failed".into()));
        for can_alias in [false, true] {
            assert!(!holder_spelling_holds(
                Some("a"),
                &Ok(Some("a".into())),
                can_alias
            ));
            assert!(holder_spelling_holds(
                Some("a"),
                &Ok(Some("b".into())),
                can_alias
            ));
            assert!(holder_spelling_holds(Some("a"), &Ok(None), can_alias));
            assert!(holder_spelling_holds(Some("a"), &spawn_failed(), can_alias));
            assert!(holder_spelling_holds(
                None,
                &Ok(Some("b".into())),
                can_alias
            ));
            assert!(holder_spelling_holds(None, &spawn_failed(), can_alias));
        }
        assert!(!holder_spelling_holds(None, &Ok(None), false));
        assert!(holder_spelling_holds(None, &Ok(None), true));
    }

    /// A sibling on the unborn `HOLLOW` (index emptied, so no other guard stops a merge
    /// there) beside the packed-only `hollow`: where refs can alias it holds `hollow`, and
    /// its leaf differs from `hollow`'s, so the update refuses with the other-spelling
    /// sentence by the leaf clause and `hollow` stays at its seed; where they can't, it is
    /// independent and the bare fast-forward moves `hollow`. The unreadable-HEAD clause is
    /// pinned by the folder-variant test below.
    /// Either way no `HOLLOW` ref is made and the sibling stays unborn. The holder arm
    /// mints a marker under the process-wide root override, so the branch is one no other
    /// test uses.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_branch_from_never_merges_into_an_unborn_case_variant_sibling() {
        let (g, repo, seed, head) = delete_fixture("update-unborn-variant").await;
        run(&repo, &["branch", "hollow", &seed]).await;
        run(&repo, &["branch", "hollow-base", &head]).await;
        run(&repo, &["pack-refs", "--all"]).await;
        let wt = g.path().join("unborn-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt]).await;
        run(&wt, &["symbolic-ref", "HEAD", "refs/heads/HOLLOW"]).await;
        run(&wt, &["rm", "-rfq", "."]).await;
        let listed = run(&repo, &["worktree", "list", "--porcelain"]).await;
        assert!(
            listed.lines().any(|l| l == "branch refs/heads/HOLLOW"),
            "fixture sanity: the sibling lists the unborn spelling: {listed}"
        );
        assert_eq!(
            full_ref_tip(&wt, "HEAD").await,
            None,
            "fixture sanity: unborn"
        );
        let can_alias = super::refs_can_alias(&repo).await;
        assert_eq!(
            super::worktree_holding_branch_checked(&repo, "hollow")
                .await
                .unwrap()
                .is_some(),
            can_alias
        );

        let (_serialized, _override, _root) = holder_marker_root(&repo);
        let outcome = update_branch_from(
            &AppState::default(),
            &repo,
            "hollow",
            "hollow-base",
            &HashSet::new(),
            None,
        )
        .await;
        assert_eq!(
            exact_branch_tip(&repo, "HOLLOW").await.unwrap(),
            None,
            "{outcome:?}"
        );
        assert_eq!(full_ref_tip(&wt, "HEAD").await, None, "{outcome:?}");
        assert_eq!(
            run(&wt, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/HOLLOW"
        );
        if can_alias {
            let Err(err) = &outcome else {
                panic!("{outcome:?}");
            };
            let holder = super::worktree_holding_branch_checked(&repo, "hollow")
                .await
                .unwrap()
                .unwrap();
            let message = expect_branch_held(err, "moved", &holder, "hollow");
            assert_eq!(
                message,
                super::other_spelling_message(&holder, "HOLLOW", "hollow")
            );
            assert_eq!(exact_branch_tip(&repo, "hollow").await.unwrap(), Some(seed));
        } else {
            assert!(
                matches!(&outcome, Ok(done) if done.holder.is_none()),
                "{outcome:?}"
            );
            assert_eq!(exact_branch_tip(&repo, "hollow").await.unwrap(), Some(head));
        }
    }

    /// A sibling on `Hollow/x`, checked out over a `hollow/x` that was packed afterwards
    /// while a loose `hollow/y` keeps the folder, differs only in a folder, so the leaf
    /// clause passes it, but its HEAD resolves to no commit there: the update refuses with
    /// the other-spelling sentence by the unreadable-HEAD clause and writes nothing. Returns
    /// early where refs can't alias (a case-sensitive filesystem, or a non-files ref
    /// backend), where the sibling does not hold `hollow/x`. The holder arm mints a marker
    /// under the process-wide root override, so the branch is one no other test uses.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_branch_from_never_merges_into_an_unreadable_folder_variant_sibling() {
        let (g, repo, seed, head) = delete_fixture("update-unreadable-folder").await;
        run(&repo, &["branch", "hollow/x", &seed]).await;
        run(&repo, &["branch", "hollow/x-base", &head]).await;
        let wt = g.path().join("folder-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt]).await;
        run(&wt, &["symbolic-ref", "HEAD", "refs/heads/Hollow/x"]).await;
        run(&repo, &["pack-refs", "--all"]).await;
        run(&repo, &["update-ref", "refs/heads/hollow/y", &seed]).await;
        run(&wt, &["rm", "-rfq", "."]).await;
        assert_eq!(
            full_ref_tip(&wt, "HEAD").await,
            None,
            "fixture sanity: unreadable"
        );
        if !super::refs_can_alias(&repo).await {
            return;
        }
        let holder = super::worktree_holding_branch_checked(&repo, "hollow/x")
            .await
            .unwrap()
            .expect("fixture sanity: the sibling holds hollow/x");

        let (_serialized, _override, _root) = holder_marker_root(&repo);
        let outcome = update_branch_from(
            &AppState::default(),
            &repo,
            "hollow/x",
            "hollow/x-base",
            &HashSet::new(),
            None,
        )
        .await;
        let Err(err) = &outcome else {
            panic!("{outcome:?}");
        };
        let message = expect_branch_held(err, "moved", &holder, "hollow/x");
        assert_eq!(
            message,
            super::other_spelling_message(&holder, "Hollow/x", "hollow/x")
        );
        assert_eq!(
            exact_branch_tip(&repo, "hollow/x").await.unwrap(),
            Some(seed)
        );
        assert_eq!(exact_branch_tip(&repo, "Hollow/x").await.unwrap(), None);
        assert_eq!(full_ref_tip(&wt, "HEAD").await, None, "still unreadable");
        assert_eq!(
            run(&wt, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/Hollow/x"
        );
    }

    /// `delete_fixture`'s repo with `branch` (a name no other test uses) at feat's tip and
    /// carrying an upstream, `<branch>-base` past it, and a checkout on `variant`, which
    /// differs from `branch` in its leaf's case: a linked worktree when `linked`, else the
    /// main checkout. With `packed`, `branch` is packed at that commit and loose one commit
    /// later. Returns (guard, repo, checkout, branch's tip), or `None` where `variant` does
    /// not read `branch`'s loose file (a case-sensitive filesystem, or a non-files ref
    /// backend).
    async fn leaf_variant_fixture(
        tag: &str,
        branch: &str,
        variant: &str,
        linked: bool,
        packed: bool,
    ) -> Option<(tempfile::TempDir, String, String, String)> {
        let (g, repo, seed, head) = delete_fixture(tag).await;
        let full = super::branch_full_ref(branch).unwrap();
        run(&repo, &["branch", branch, &seed]).await;
        for (key, value) in [("remote", "origin"), ("merge", full.as_str())] {
            run(&repo, &["config", &format!("branch.{branch}.{key}"), value]).await;
        }
        let tip = if packed {
            run(&repo, &["pack-refs", "--all"]).await;
            run(&repo, &["update-ref", &full, &head]).await;
            head
        } else {
            seed
        };
        commit_file(&repo, "leaf.txt", "base\n").await;
        run(&repo, &["branch", &format!("{branch}-base")]).await;
        let checkout = if linked {
            let wt = g.path().join("leaf-wt").to_string_lossy().into_owned();
            run(&repo, &["worktree", "add", "-q", "--detach", &wt, &full]).await;
            wt
        } else {
            run(&repo, &["switch", "-q", "--detach", &full]).await;
            repo.clone()
        };
        let variant_ref = super::branch_full_ref(variant).unwrap();
        run(&checkout, &["symbolic-ref", "HEAD", &variant_ref]).await;
        if !is_aliased(&repo, variant).await {
            return None;
        }
        Some((g, repo, checkout, tip))
    }

    /// Asserts nothing was written through `variant`: `branch` is still listed by its own
    /// spelling, at `tip`, with its upstream config, and no `variant` ref is listed.
    async fn assert_leaf_variant_untouched(
        repo: &str,
        branch: &str,
        variant: &str,
        tip: &str,
        outcome: &str,
    ) {
        let listed = run(
            repo,
            &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        )
        .await;
        let full = super::branch_full_ref(branch).unwrap();
        assert!(listed.lines().any(|l| l == full), "{listed}\n{outcome}");
        assert_eq!(
            exact_branch_tip(repo, branch).await.unwrap().as_deref(),
            Some(tip),
            "{outcome}"
        );
        assert_eq!(
            exact_branch_tip(repo, variant).await.unwrap(),
            None,
            "{outcome}"
        );
        for (key, value) in [("remote", "origin"), ("merge", full.as_str())] {
            let got = run(
                repo,
                &["config", "--get", &format!("branch.{branch}.{key}")],
            )
            .await;
            assert_eq!(got.trim(), value, "{outcome}");
        }
    }

    /// A linked worktree on `Leafheld` holds the stored `leafheld` and its HEAD is at the
    /// tip, but a merge there would write `refs/heads/Leafheld`: renaming a loose-only
    /// `leafheld`, or leaving a packed one behind beside a new twin. The update refuses with
    /// the other-spelling sentence. Returns early on a case-sensitive filesystem or a
    /// non-files ref backend. The holder arm mints a marker under the process-wide root
    /// override, so the branch is one no other test uses.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_branch_from_never_merges_through_a_leaf_variant_holder() {
        for packed in [false, true] {
            let Some((_g, repo, wt, tip)) = leaf_variant_fixture(
                &format!("leaf-holder-{packed}"),
                "leafheld",
                "Leafheld",
                true,
                packed,
            )
            .await
            else {
                return;
            };
            let (_serialized, _override, _root) = holder_marker_root(&repo);
            let outcome = update_branch_from(
                &AppState::default(),
                &repo,
                "leafheld",
                "leafheld-base",
                &HashSet::new(),
                None,
            )
            .await;
            let shown = format!("packed {packed}: {outcome:?}");
            assert_leaf_variant_untouched(&repo, "leafheld", "Leafheld", &tip, &shown).await;
            let Err(err) = &outcome else {
                panic!("{shown}");
            };
            let holder = super::worktree_holding_branch_checked(&repo, "leafheld")
                .await
                .unwrap()
                .unwrap();
            let message = expect_branch_held(err, "moved", &holder, "leafheld");
            assert_eq!(
                message,
                super::other_spelling_message(&holder, "Leafheld", "leafheld")
            );
            assert_eq!(full_ref_tip(&wt, "HEAD").await, Some(tip), "{shown}");
        }
    }

    /// The main checkout on `Leafhere` holds the stored `leafhere`, so the update would
    /// merge in place and write `refs/heads/Leafhere`, renaming the branch: it refuses
    /// with the other-spelling sentence instead. Returns early on a case-sensitive
    /// filesystem or a non-files ref backend.
    #[tokio::test]
    async fn update_branch_from_never_merges_in_place_through_a_leaf_variant() {
        let Some((_g, repo, _, tip)) =
            leaf_variant_fixture("leaf-in-place", "leafhere", "Leafhere", false, false).await
        else {
            return;
        };
        let outcome = update_branch_from(
            &AppState::default(),
            &repo,
            "leafhere",
            "leafhere-base",
            &HashSet::new(),
            None,
        )
        .await;
        let shown = format!("{outcome:?}");
        assert_leaf_variant_untouched(&repo, "leafhere", "Leafhere", &tip, &shown).await;
        let expected = super::other_spelling_message(&repo, "Leafhere", "leafhere");
        assert!(
            matches!(&outcome, Err(AppError::Command(m)) if *m == expected),
            "{shown}"
        );
        assert_eq!(full_ref_tip(&repo, "HEAD").await, Some(tip));
        assert_eq!(run(&repo, &["status", "--porcelain"]).await.trim(), "");
    }

    /// The stored loose `feat`, with a linked worktree on its case variant `Feat` stopped
    /// mid-rebase onto the main branch, so the rebase records `refs/heads/Feat` and the
    /// worktree lists as detached. `ahead` descends from `feat`; `aside` has diverged from
    /// it. Returns (guard, repo, worktree, feat's tip), or `None` where `Feat` does not
    /// read `feat`'s loose file (a case-sensitive filesystem, or a non-files ref backend).
    async fn variant_rebase_fixture(
        tag: &str,
    ) -> Option<(tempfile::TempDir, String, String, String)> {
        let (g, repo, seed, _head) = delete_fixture(tag).await;
        if !is_aliased(&repo, "Feat").await {
            return None;
        }
        let main = run(&repo, &["symbolic-ref", "--short", "HEAD"]).await;
        let main = main.trim();
        for (branch, from, file, body) in [
            ("feat", "feat", "a.txt", "feat\n"),
            ("ahead", "feat", "b.txt", "ahead\n"),
            ("aside", seed.as_str(), "c.txt", "aside\n"),
        ] {
            if branch == from {
                run(&repo, &["switch", "-q", branch]).await;
            } else {
                run(&repo, &["switch", "-q", "-c", branch, from]).await;
            }
            commit_file(&repo, file, body).await;
        }
        run(&repo, &["switch", "-q", main]).await;
        let feat = tip(&repo, "feat").await;
        let wt = g.path().join("rebase-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt, "feat"]).await;
        run(&wt, &["symbolic-ref", "HEAD", "refs/heads/Feat"]).await;
        let rebase = run_git_raw(Some(&wt), &["rebase", main], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        assert_ne!(
            rebase.code, 0,
            "fixture sanity: the rebase stops on a conflict"
        );
        let head_name = run(&wt, &["rev-parse", "--git-path", "rebase-merge/head-name"]).await;
        let head_name = std::path::Path::new(&wt).join(head_name.trim());
        assert_eq!(
            std::fs::read_to_string(head_name).unwrap().trim(),
            "refs/heads/Feat",
            "fixture sanity: the rebase records the variant"
        );
        Some((g, repo, wt, feat))
    }

    /// Asserts the update was refused by the rebase recorded on `Feat`, `feat` is where it
    /// was, and the rebase is still stopped.
    async fn assert_refused_by_variant_rebase(
        outcome: crate::error::AppResult<UpdateBranchOutcome>,
        repo: &str,
        wt: &str,
        feat: &str,
    ) {
        assert!(
            matches!(&outcome, Err(AppError::Command(m)) if m.starts_with("feat is being rebased in the worktree at ")
                && m.ends_with(" — finish or abort that rebase before updating feat.")),
            "{outcome:?}"
        );
        assert_eq!(tip(repo, "feat").await, feat, "the ref is unmoved");
        assert!(crate::git::ops::op_state(wt).await.unwrap().rebasing);
    }

    /// A fast-forward of `feat` while a rebase is stopped on its case variant `Feat`:
    /// git's own `fetch` test is keyed on spelling and would move the ref, so the update
    /// refuses first. Returns early on a case-sensitive filesystem or a non-files ref
    /// backend.
    #[tokio::test]
    async fn update_branch_from_refuses_a_fast_forward_under_a_variant_rebase() {
        let Some((_g, repo, wt, feat)) = variant_rebase_fixture("update-ff-variant").await else {
            return;
        };
        let outcome = update_branch_from(
            &AppState::default(),
            &repo,
            "feat",
            "ahead",
            &HashSet::new(),
            None,
        )
        .await;
        assert_refused_by_variant_rebase(outcome, &repo, &wt, &feat).await;
    }

    /// The diverged twin: the throwaway checkout's merge would move `feat` under the
    /// rebase stopped on `Feat`, so the update refuses before the `worktree add`. The
    /// marker root is overridden in case the arm runs. Returns early on a case-sensitive
    /// filesystem or a non-files ref backend.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_branch_from_refuses_a_diverged_merge_under_a_variant_rebase() {
        let Some((_g, repo, wt, feat)) = variant_rebase_fixture("update-merge-variant").await
        else {
            return;
        };
        let (_serialized, _override, _root) = holder_marker_root(&repo);
        let outcome = update_branch_from(
            &AppState::default(),
            &repo,
            "feat",
            "aside",
            &HashSet::new(),
            None,
        )
        .await;
        assert_refused_by_variant_rebase(outcome, &repo, &wt, &feat).await;
    }

    /// The reftable arm over each layout: only git's reftable layout (a `refs/heads` stub
    /// file beside a `reftable/tables.list` file) reads as reftable and never aliases;
    /// every near miss, a missing `refs` included, answers as the disk folds (true on a
    /// case-insensitive one, and for a missing `refs` on any). A probe the OS can't run
    /// (a path with a NUL) is the `Err`, never "can alias".
    #[test]
    fn refs_can_alias_at_reads_reftable_only_from_its_layout() {
        use super::{is_reftable_store, refs_can_alias_at, refs_dir_folds_case};
        // `heads`: "file", "dir" or "" (no `refs` at all); `tables`: "file", "dir" (a
        // `tables.list` directory), "empty" (a bare `reftable` folder) or "".
        let (_g, base) = temp_base("reftable-layout");
        let layout = |name: &str, heads: &str, tables: &str| {
            let common = base.join(name);
            std::fs::create_dir_all(&common).unwrap();
            let refs = common.join("refs");
            match heads {
                "file" => {
                    std::fs::create_dir_all(&refs).unwrap();
                    std::fs::write(refs.join("heads"), "stub\n").unwrap();
                }
                "dir" => std::fs::create_dir_all(refs.join("heads")).unwrap(),
                _ => {}
            }
            let reftable = common.join("reftable");
            match tables {
                "file" => {
                    std::fs::create_dir_all(&reftable).unwrap();
                    std::fs::write(reftable.join("tables.list"), "").unwrap();
                }
                "dir" => std::fs::create_dir_all(reftable.join("tables.list")).unwrap(),
                "empty" => std::fs::create_dir_all(&reftable).unwrap(),
                _ => {}
            }
            common
        };
        let common = layout("reftable", "file", "file");
        assert!(is_reftable_store(&common));
        assert!(!refs_can_alias_at(&common).unwrap());
        for (name, heads, tables) in [
            ("stray-tables", "dir", "file"),
            ("stub-only", "file", ""),
            ("files", "dir", ""),
            ("empty-reftable", "dir", "empty"),
            ("stub-empty-reftable", "file", "empty"),
            ("tables-dir", "file", "dir"),
            ("no-refs", "", "file"),
        ] {
            let common = layout(name, heads, tables);
            assert!(!is_reftable_store(&common), "{name}");
            assert_eq!(
                refs_can_alias_at(&common).unwrap(),
                refs_dir_folds_case(&common).unwrap(),
                "{name}"
            );
        }
        assert!(refs_can_alias_at(&base.join("no-refs")).unwrap());
        assert!(refs_can_alias_at(&base.join("bad\0name")).is_err());
    }

    /// A reftable repository never aliases ref names, on any disk: an unborn checkout on
    /// `Feat` does not hold the stored `feat`, and the case twin `Topic` beside `topic`
    /// passes the bare-move gate at its own tip. Returns early when this git can't create
    /// a reftable repository.
    #[tokio::test]
    async fn a_reftable_repository_never_aliases_ref_names() {
        let (_g, base) = temp_base("reftable-alias");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.to_string_lossy().into_owned();
        let init = run_git_raw(
            Some(&repo),
            &["init", "-q", "--ref-format=reftable"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        if init.code != 0 {
            eprintln!("note: this git can't create a reftable repo; skipping");
            return;
        }
        run(&repo, &["config", "user.email", "t@t.local"]).await;
        run(&repo, &["config", "user.name", "T"]).await;
        commit_file(&repo, "a.txt", "seed\n").await;
        let seed = full_ref_tip(&repo, "HEAD").await.unwrap();
        run(&repo, &["branch", "feat"]).await;
        assert!(!super::refs_can_alias(&repo).await);

        let wt = base.join("unborn-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt]).await;
        run(&wt, &["symbolic-ref", "HEAD", "refs/heads/Feat"]).await;
        assert!(!super::refs_can_alias(&wt).await);
        assert!(!super::holds_branch(&repo, "Feat", "feat").await);
        assert_eq!(
            super::worktree_holding_branch_checked(&repo, "feat")
                .await
                .unwrap(),
            None
        );

        run(&repo, &["branch", "topic"]).await;
        commit_file(&repo, "b.txt", "next\n").await;
        let next = full_ref_tip(&repo, "HEAD").await.unwrap();
        run(&repo, &["branch", "Topic"]).await;
        assert!(matches!(
            super::branch_spelling(&repo, "Topic", true).await.unwrap(),
            super::BranchSpelling::Twin { .. }
        ));
        assert_eq!(
            super::bare_move_tip(&repo, "Topic").await.unwrap(),
            Some(next)
        );
        assert_eq!(
            super::bare_move_tip(&repo, "topic").await.unwrap(),
            Some(seed)
        );
    }

    /// The in-place verdict: the exact name merges; another spelling `holds_branch` accepts
    /// merges only where the store's names alias and HEAD is the branch's tip, is another
    /// branch where they can't, and is refused where HEAD is elsewhere or unresolved.
    #[test]
    fn in_place_gate_merges_another_spelling_only_where_names_alias_at_the_tip() {
        use super::{in_place_gate, InPlace};
        let (a, b) = (Some("a"), Some("b"));
        for (exact, holds, alias, head, tip, want) in [
            (true, true, false, None, None, InPlace::Merge),
            (false, false, true, a, a, InPlace::NotHeld),
            (false, true, false, a, a, InPlace::NotHeld),
            (false, true, true, a, b, InPlace::Moved),
            (false, true, true, None, None, InPlace::Moved),
            (false, true, true, None, a, InPlace::Moved),
            (false, true, true, a, a, InPlace::Merge),
        ] {
            assert_eq!(
                in_place_gate(exact, holds, alias, head, tip),
                want,
                "exact {exact} holds {holds} alias {alias} head {head:?} tip {tip:?}"
            );
        }
    }

    /// In a reftable repository `Topic/x` and `topic/x` are two branches: the strict alias
    /// read and [`super::spelling_reaches_branch`] both say so, and with HEAD on `Topic/x`
    /// an update of `topic/x` falls through to the requested branch, which moves alone;
    /// `Topic/x`, HEAD and the tree are unchanged. `holds_branch` already answers false
    /// here, so the in-place gate's conjuncts are left to its truth table. Returns early
    /// when this git can't create a reftable repository.
    #[tokio::test]
    async fn update_branch_from_updates_the_requested_branch_beside_a_folder_variant_where_names_cannot_alias(
    ) {
        let (_g, base) = temp_base("reftable-in-place");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.to_string_lossy().into_owned();
        let init = run_git_raw(
            Some(&repo),
            &["init", "-q", "--ref-format=reftable"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        if init.code != 0 {
            eprintln!("note: this git can't create a reftable repo; skipping");
            return;
        }
        run(&repo, &["config", "user.email", "t@t.local"]).await;
        run(&repo, &["config", "user.name", "T"]).await;
        commit_file(&repo, "a.txt", "seed\n").await;
        let seed = full_ref_tip(&repo, "HEAD").await.unwrap();
        run(&repo, &["branch", "topic/x"]).await;
        run(&repo, &["switch", "-q", "-c", "up"]).await;
        commit_file(&repo, "u.txt", "up\n").await;
        let up = full_ref_tip(&repo, "HEAD").await.unwrap();
        run(&repo, &["switch", "-q", "-c", "Topic/x", &seed]).await;
        commit_file(&repo, "t.txt", "mine\n").await;
        let mine = full_ref_tip(&repo, "HEAD").await.unwrap();
        assert!(!super::refs_can_alias_strict(&repo).await.unwrap());
        assert!(!super::spelling_reaches_branch(&repo, "Topic/x", "topic/x")
            .await
            .unwrap());

        let outcome = update_branch_from(
            &AppState::default(),
            &repo,
            "topic/x",
            "up",
            &HashSet::new(),
            None,
        )
        .await;
        assert!(outcome.is_ok(), "{outcome:?}");
        assert_eq!(full_ref_tip(&repo, "refs/heads/topic/x").await, Some(up));
        assert_eq!(
            full_ref_tip(&repo, "refs/heads/Topic/x").await,
            Some(mine.clone())
        );
        assert_eq!(full_ref_tip(&repo, "HEAD").await, Some(mine));
        assert_eq!(
            run(&repo, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/Topic/x"
        );
        assert!(!std::path::Path::new(&repo).join("u.txt").exists());
        assert_eq!(run(&repo, &["status", "--porcelain"]).await.trim(), "");
    }

    /// The update names `Chore/z` while `chore/z`, checked out here, is stored packed only,
    /// which no other spelling reads: the unknown-branch refusal, and the stored ref, HEAD
    /// and the tree are unchanged. Returns early on a case-sensitive filesystem or a
    /// non-files ref backend.
    #[tokio::test]
    async fn update_branch_from_never_swaps_in_a_packed_only_stored_spelling() {
        let Some((_g, repo, checkout, z1, _up)) =
            held_spelling_fixture("update-packed-spelling", "chore", "chore/z", false).await
        else {
            return;
        };
        run(&repo, &["pack-refs", "--all"]).await;
        let outcome = update_branch_from(
            &AppState::default(),
            &repo,
            "Chore/z",
            "up",
            &HashSet::new(),
            None,
        )
        .await;
        assert_eq!(
            exact_branch_tip(&repo, "chore/z").await.unwrap(),
            Some(z1.clone())
        );
        assert_eq!(full_ref_tip(&checkout, "HEAD").await, Some(z1));
        assert_eq!(run(&checkout, &["status", "--porcelain"]).await.trim(), "");
        assert!(
            matches!(&outcome, Err(AppError::InvalidArgument(m))
                if m == "unknown branch: Chore/z"),
            "{outcome:?}"
        );
    }

    /// The classifier reads the packed-twin fixture as twins (and a third spelling, which
    /// git reads through the loose twin, as folded twins), and the disk probe says refs
    /// can alias here whatever `core.ignorecase` says, so the bare-move gate refuses both
    /// twins with the key set false too (the move itself is not run). Returns early on a
    /// case-sensitive filesystem or a non-files ref backend.
    #[tokio::test]
    async fn bare_move_gate_refuses_a_twin_where_the_disk_folds_case() {
        let Some((_g, repo, seed, _tip, _up)) = packed_twin_fixture("twin-gate", false).await
        else {
            return;
        };
        assert_eq!(
            super::branch_spelling(&repo, "Feat", true).await.unwrap(),
            super::BranchSpelling::Twin {
                tip: seed.clone(),
                twin: "feat".to_string()
            }
        );
        assert_eq!(
            super::branch_spelling(&repo, "Feat", false).await.unwrap(),
            super::BranchSpelling::Own { tip: seed.clone() }
        );
        for find_twin in [false, true] {
            assert_eq!(
                super::branch_spelling(&repo, "FEAT", find_twin)
                    .await
                    .unwrap(),
                super::BranchSpelling::FoldedTwins {
                    first: "Feat".to_string(),
                    second: "feat".to_string()
                },
                "find_twin {find_twin}"
            );
        }
        assert!(matches!(
            super::bare_move_tip(&repo, "FEAT").await,
            Err(AppError::Command(m)) if m == TWIN_REFUSAL
        ));
        assert_eq!(
            super::branch_spelling(&repo, "UP", false).await.unwrap(),
            super::BranchSpelling::StoredAs("up".to_string())
        );
        assert!(matches!(
            super::bare_move_tip(&repo, "Feat").await,
            Err(AppError::Command(m)) if m == TWIN_REFUSAL
        ));
        assert!(super::bare_move_tip(&repo, "up").await.unwrap().is_some());
        assert!(super::refs_can_alias(&repo).await);
        run(&repo, &["config", "core.ignorecase", "false"]).await;
        assert!(super::refs_can_alias(&repo).await);
        for name in ["Feat", "feat"] {
            assert!(
                matches!(
                    super::bare_move_tip(&repo, name).await,
                    Err(AppError::Command(m)) if m.contains("differ only in letter case")
                ),
                "{name}"
            );
        }
    }

    /// A twin created at the pinned commit while the throwaway worktree materialized:
    /// git's old-value check can't tell it from the pinned tip, so the verify refuses it as
    /// a twin, nothing is merged, both refs stand and the worktree is torn down. Driven
    /// through `merge_diverged_in_worktree` with the twin made before the call, since no
    /// seam stops between its add and its verify. Returns early on a case-sensitive
    /// filesystem or a non-files ref backend.
    #[tokio::test]
    async fn update_diverged_arm_refuses_a_twin_created_at_the_pinned_commit() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-twin-window").await;
        run(&repo_s, &["pack-refs", "--all"]).await;
        let feature_tip = full_ref_tip(&repo_s, "refs/heads/feature").await.unwrap();
        let main_tip = full_ref_tip(&repo_s, &main).await.unwrap();
        // Loose at another commit first, so raw reads show whether the two spellings share
        // a file, then moved onto the pinned commit.
        run(&repo_s, &["update-ref", "refs/heads/Feature", &main_tip]).await;
        let shown = run(
            &repo_s,
            &["show-ref", "--verify", "--hash", "refs/heads/feature"],
        )
        .await;
        let listed = run(
            &repo_s,
            &[
                "for-each-ref",
                "--format=%(objectname)",
                "refs/heads/feature",
            ],
        )
        .await;
        if shown.trim() != main_tip || listed.trim() != feature_tip {
            return;
        }
        run(
            &repo_s,
            &["update-ref", "refs/heads/Feature", &feature_tip, &main_tip],
        )
        .await;

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("twin-window-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let pins = UpdatePins {
            branch_tip: feature_tip.clone(),
            base_sha: main_tip,
        };
        let result = merge_diverged_in_worktree(
            &AppState::default(),
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &pins,
            None,
        )
        .await;
        let refs = run(
            &repo_s,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads/",
            ],
        )
        .await;
        assert!(
            refs.contains(&format!("refs/heads/feature {feature_tip}")),
            "{refs}"
        );
        assert!(
            refs.contains(&format!("refs/heads/Feature {feature_tip}")),
            "{refs}"
        );
        assert!(
            matches!(&result, Err(AppError::Command(m))
                if m == "feature and Feature differ only in letter case, which this disk \
                    can't keep apart. Rename one of them, then try again."),
            "{result:?}"
        );
        let list = run(&repo_s, &["worktree", "list", "--porcelain"]).await;
        assert_worktree_unregistered(&list, &repo, "twin-window-wt");
        assert!(!tmp.exists(), "and its directory is gone");
    }

    /// The HEAD compare, alone: an entry that keeps its path and branch line but whose HEAD
    /// changed counts as moved only when it was at the deleted tip; a new worktree on an
    /// unrelated branch and a bare entry don't.
    #[test]
    fn head_moved_in_reads_a_changed_head_under_an_unchanged_branch_line() {
        use super::{head_moved_in, ListedHead};
        let entry = |path: &str, head: Option<&str>, branch: Option<&str>| ListedHead {
            path: path.to_string(),
            head: head.map(str::to_string),
            branch: branch.map(str::to_string),
        };
        let before = vec![
            entry("/r", Some("a"), Some("refs/heads/main")),
            entry("/bare", None, None),
        ];
        let moved = vec![
            entry("/r", Some("b"), Some("refs/heads/main")),
            entry("/bare", None, None),
        ];
        use super::HeadMove;
        assert_eq!(
            head_moved_in(&before, &moved, "feat", "a"),
            Some(("/r", HeadMove::Moved))
        );
        assert_eq!(head_moved_in(&before, &moved, "feat", "t"), None);
        // One stanza that both arrived and moved is named as arrived.
        let both = vec![
            entry("/r", Some("b"), Some("refs/heads/Feat")),
            entry("/bare", None, None),
        ];
        assert_eq!(
            head_moved_in(&before, &both, "feat", "a"),
            Some(("/r", HeadMove::Arrived))
        );
        // Across stanzas an arrival outranks an earlier stanza that only moved.
        let before_two = vec![
            entry("/r", Some("a"), Some("refs/heads/main")),
            entry("/s", Some("c"), Some("refs/heads/other")),
        ];
        let across = vec![
            entry("/r", Some("b"), Some("refs/heads/main")),
            entry("/s", Some("c"), Some("refs/heads/feat")),
        ];
        assert_eq!(
            head_moved_in(&before_two, &across, "feat", "a"),
            Some(("/s", HeadMove::Arrived))
        );
        let added = vec![
            entry("/r", Some("a"), Some("refs/heads/main")),
            entry("/bare", None, None),
            entry("/other", Some("c"), Some("refs/heads/other")),
        ];
        assert_eq!(head_moved_in(&before, &added, "feat", "a"), None);
        let bare_new = vec![
            entry("/r", Some("a"), Some("refs/heads/main")),
            entry("/bare", None, None),
            entry("/bare2", None, None),
        ];
        assert_eq!(head_moved_in(&before, &bare_new, "feat", "a"), None);
    }

    /// The packed-twin shape in a sibling, detached at `feat`'s tip (its HEAD then reads
    /// `Feat`'s packed ref after the delete) or at the seed (its HEAD reads the same
    /// commit, only its branch line changes) until it lands on `Feat` after the first
    /// guard pass: the delete is put back with the sibling's refusal, and its HEAD resolves
    /// as before. Returns early on a case-sensitive filesystem or a non-files ref backend.
    #[tokio::test]
    async fn delete_branch_puts_back_the_loose_twin_under_a_packed_twin_sibling() {
        for detached_at_tip in [true, false] {
            let Some((g, repo, seed, tip, _up)) = packed_twin_fixture("del-twin-sib", false).await
            else {
                return;
            };
            let start = if detached_at_tip { tip.clone() } else { seed };
            let wt = g.path().join("twin-wt").to_string_lossy().into_owned();
            run(&repo, &["worktree", "add", "-q", "--detach", &wt, &start]).await;
            let hook = git_at_phase(
                DeletePhase::BeforeDelete,
                &wt,
                &["symbolic-ref", "HEAD", "refs/heads/Feat"],
            );
            let err = DELETE_PHASE_HOOK
                .scope(
                    hook,
                    delete(&AppState::default(), &repo, "feat", Some(&tip)),
                )
                .await
                .unwrap_err();
            assert!(
                matches!(&err, AppError::Command(m)
                    if m.starts_with("feat is checked out in the worktree at ")
                        && m.contains("twin-wt")),
                "at tip {detached_at_tip}: {err:?}"
            );
            assert_eq!(
                exact_branch_tip(&repo, "feat").await.unwrap(),
                Some(tip.clone())
            );
            assert_eq!(full_ref_tip(&wt, "HEAD").await, Some(tip));
        }
    }

    /// A worktree added on `Feat` after the first guard pass reads `feat`'s loose file:
    /// the second pass sees a new checkout on a case variant of the name, so the delete is
    /// put back with that worktree's refusal. Returns early on a case-sensitive filesystem
    /// or a non-files ref backend.
    #[tokio::test]
    async fn delete_branch_puts_back_the_loose_twin_under_a_worktree_added_on_its_twin() {
        let Some((g, repo, _seed, tip, _up)) = packed_twin_fixture("del-twin-add", false).await
        else {
            return;
        };
        let wt = g.path().join("added-wt").to_string_lossy().into_owned();
        let hook = git_at_phase(
            DeletePhase::BeforeDelete,
            &repo,
            &["worktree", "add", "-q", &wt, "Feat"],
        );
        let err = DELETE_PHASE_HOOK
            .scope(
                hook,
                delete(&AppState::default(), &repo, "feat", Some(&tip)),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with("feat is checked out in the worktree at ")
                    && m.contains("added-wt")),
            "{err:?}"
        );
        assert_eq!(
            exact_branch_tip(&repo, "feat").await.unwrap(),
            Some(tip.clone())
        );
        assert_eq!(full_ref_tip(&wt, "HEAD").await, Some(tip));
    }

    /// A bisect started on `Feat`, a real twin with its own loose ref beside the packed
    /// `feat`: the recorded spelling resolves to not holding, so the operation check
    /// clears `feat` while it still refuses `Feat`. On a case-sensitive filesystem these
    /// are two ordinary branches, the same answers.
    #[tokio::test]
    async fn operation_check_passes_a_recorded_twin_that_reads_its_own_ref() {
        let (_g, repo, _feat, _head) = delete_fixture("op-twin-bisect").await;
        run(&repo, &["pack-refs", "--all"]).await;
        run(&repo, &["switch", "-q", "-c", "Feat"]).await;
        for file in ["t1.txt", "t2.txt", "t3.txt"] {
            std::fs::write(std::path::Path::new(&repo).join(file), "t\n").unwrap();
            run(&repo, &["add", "-A"]).await;
            run(&repo, &["commit", "-qm", file]).await;
        }
        let twin = exact_branch_tip(&repo, "Feat").await.unwrap();
        assert!(twin.is_some(), "fixture sanity");
        assert_eq!(super::shown_branch_tip(&repo, "Feat").await.unwrap(), twin);
        run(&repo, &["bisect", "start", "HEAD", "HEAD~3"]).await;
        let start = std::path::Path::new(&repo).join(".git/BISECT_START");
        assert_eq!(
            std::fs::read_to_string(start).unwrap().trim_end(),
            "Feat",
            "fixture sanity"
        );
        assert_eq!(
            super::branch_operation_refusal(&repo, "feat", "deleting")
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            super::branch_operation_refusal(&repo, "Feat", "deleting")
                .await
                .unwrap()
                .as_deref(),
            Some("Feat is being bisected here — end that bisect (git bisect reset) before deleting Feat.")
        );
    }

    /// A tip read that fails leaves the rewrite verdict unknown, as every other failed
    /// read there does: the hook breaks `packed-refs` as the `for-each-ref` spawns.
    #[tokio::test]
    async fn rewrite_status_answers_unknown_when_the_tip_read_fails() {
        let (_g, repo, _feat, _head) = delete_fixture("rewrite-tip-fails").await;
        // A local upstream, so the upstream reads answer and the tip read is reached.
        let current = current_branch_name(&repo).await.unwrap().unwrap();
        run(&repo, &["config", "branch.feat.remote", "."]).await;
        let merge = super::branch_full_ref(&current).unwrap();
        run(&repo, &["config", "branch.feat.merge", &merge]).await;
        let packed = std::path::Path::new(&repo).join(".git/packed-refs");
        let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&fired);
        let hook = Arc::new(move |args: &[&str]| {
            if args.first() == Some(&"for-each-ref") {
                std::fs::write(&packed, "garbage line\n").unwrap();
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });

        let status = GIT_SPAWN_LOG
            .scope(hook, branch_rewrite_status(&repo, "feat"))
            .await;
        assert!(
            fired.load(std::sync::atomic::Ordering::SeqCst),
            "the tip read ran"
        );
        assert_eq!(
            serde_json::to_value(status.unwrap()).unwrap(),
            serde_json::to_value(BranchRewriteStatus::unknown()).unwrap()
        );
    }

    #[tokio::test]
    async fn delete_branch_refuses_the_checked_out_branch() {
        let (_g, repo, _feat, head) = delete_fixture("del-current").await;
        let current = current_branch_name(&repo).await.unwrap().unwrap();

        let err = delete(&AppState::default(), &repo, &current, None)
            .await
            .unwrap_err();
        let expected = format!(
            "{current} is checked out here — switch to another branch before deleting {current}."
        );
        assert!(
            matches!(&err, AppError::Command(m) if *m == expected),
            "{err:?}"
        );
        assert_eq!(local_tip(&repo, &current).await, head);
    }

    /// A linked worktree stopped mid-rebase of the branch reads as detached, so only the
    /// app's own rebase guard stands between it and the delete. The reset's twin keeps
    /// its own verb.
    #[tokio::test]
    async fn delete_branch_refuses_a_branch_being_rebased_in_a_worktree() {
        let (_base, base) = temp_base("del-rebasing");
        let (branch, up) = ("feature-del-rebasing", "up-del-rebasing");
        let (repo_s, _fork, target) = diverged_local_upstream(&base, branch, up, 1).await;
        let wt_s = base.join("wt").to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-q", &wt_s, branch]).await;
        let rebase = run_git_raw(Some(&wt_s), &["rebase", up], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        assert_ne!(rebase.code, 0, "fixture sanity: the rebase stops");
        let local = local_tip(&repo_s, branch).await;

        let state = AppState::default();
        let err = delete(&state, &repo_s, branch, None).await.unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m) if m.contains("is being rebased")
                && m.ends_with(&format!("finish or abort that rebase before deleting {branch}."))),
            "{err:?}"
        );
        assert_eq!(local_tip(&repo_s, branch).await, local, "the ref is intact");

        let err = branch_reset_to_upstream(&state, &repo_s, branch, &target, &local)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.ends_with(&format!("finish or abort that rebase before resetting {branch}."))),
            "{err:?}"
        );
    }

    /// A marker keeps the name's own whitespace, so `tr\u{a0}` (or a bisect's leading
    /// `\u{a0}lead`) matches only itself. The markers are hand-written, so no ref with
    /// such a name is needed.
    #[tokio::test]
    async fn operation_refusal_keeps_non_ascii_whitespace_in_marker_names() {
        let (_base, base) = temp_base("op-refusal-nbsp");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        let oid = full_ref_tip(&repo_s, "HEAD").await.unwrap();
        let head_name = "refs/heads/tr\u{a0}\n".to_string();
        let cases = [
            (
                "rebase-merge/head-name",
                head_name.clone(),
                "tr\u{a0}",
                "tr",
                "is being rebased",
            ),
            (
                "rebase-apply/head-name",
                head_name,
                "tr\u{a0}",
                "tr",
                "is being rebased",
            ),
            (
                "rebase-merge/update-refs",
                format!("refs/heads/tr\u{a0}\n{oid}\n{oid}\n"),
                "tr\u{a0}",
                "tr",
                "is part of a rebase",
            ),
            (
                "BISECT_START",
                "\u{a0}lead\n".to_string(),
                "\u{a0}lead",
                "lead",
                "is being bisected",
            ),
        ];
        for (marker, body, named, trimmed, what) in cases {
            let path = repo.join(".git").join(marker);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, body).unwrap();
            let hit = super::branch_operation_refusal(&repo_s, named, "deleting")
                .await
                .unwrap();
            assert!(
                hit.as_deref()
                    .is_some_and(|m| m.starts_with(&format!("{named} {what} here"))),
                "{marker}: {hit:?}"
            );
            let miss = super::branch_operation_refusal(&repo_s, trimmed, "deleting")
                .await
                .unwrap();
            assert_eq!(miss, None, "{marker}");
            std::fs::remove_file(&path).unwrap();
        }
    }

    /// A worktree that checks the branch out after the pre-hold probe is caught by the
    /// probe under the hold.
    #[tokio::test]
    async fn delete_branch_refuses_a_checkout_made_after_the_first_probe() {
        let (g, repo, feat, _head) = delete_fixture("del-late-checkout").await;
        let wt = g.path().join("wt").to_string_lossy().into_owned();
        let hook = git_at_phase(
            DeletePhase::BeforeGuards,
            &repo,
            &["worktree", "add", "-q", &wt, "feat"],
        );

        let state = AppState::default();
        let err = DELETE_PHASE_HOOK
            .scope(hook, delete(&state, &repo, "feat", None))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with("feat is checked out in the worktree at")
                    && m.ends_with("before deleting feat.")),
            "{err:?}"
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(feat));
    }

    /// The ref moves between the guards and the delete: git's compare refuses, a pinned
    /// caller gets where it is now, an unpinned one the moved-ref error, and a ref
    /// deleted there reads as not found.
    #[tokio::test]
    async fn delete_branch_compare_and_delete_survives_a_ref_moved_under_the_hold() {
        let (_g, repo, feat, head) = delete_fixture("del-moved").await;
        let state = AppState::default();
        let mover = || {
            git_at_phase(
                DeletePhase::BeforeDelete,
                &repo,
                &["update-ref", "refs/heads/feat", &head],
            )
        };

        let outcome = DELETE_PHASE_HOOK
            .scope(mover(), delete(&state, &repo, "feat", Some(&feat)))
            .await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::TipMoved {
                expected: feat.clone(),
                actual: head.clone()
            }
        );
        assert_eq!(
            full_ref_tip(&repo, "refs/heads/feat").await,
            Some(head.clone())
        );
        assert!(!branch_section(&repo, "feat").await.is_empty());

        run(&repo, &["update-ref", "refs/heads/feat", &feat]).await;
        let err = DELETE_PHASE_HOOK
            .scope(mover(), delete(&state, &repo, "feat", None))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Git { code: 1, stderr }
                if stderr == "feat changed since you confirmed — nothing was deleted."),
            "{err:?}"
        );
        assert_eq!(
            full_ref_tip(&repo, "refs/heads/feat").await,
            Some(head.clone())
        );

        let remover = git_at_phase(
            DeletePhase::BeforeDelete,
            &repo,
            &["update-ref", "-d", "refs/heads/feat"],
        );
        let err = DELETE_PHASE_HOOK
            .scope(remover, delete(&state, &repo, "feat", Some(&head)))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Git { code: 1, stderr }
                if stderr == "error: branch 'feat' not found"),
            "{err:?}"
        );
    }

    /// A move written into `packed-refs` under the hold: the mismatch git's own compare
    /// sees is the packed value, and nothing is deleted.
    #[tokio::test]
    async fn delete_branch_compare_and_delete_reads_a_packed_ref_moved_under_the_hold() {
        let (g, repo, feat, head) = delete_fixture("del-packed-moved").await;
        run(&repo, &["pack-refs", "--all"]).await;
        let mover: DeletePhaseHook = {
            let (repo, head) = (repo.clone(), head.clone());
            Arc::new(move |phase| {
                let (repo, head) = (repo.clone(), head.clone());
                Box::pin(async move {
                    if phase == DeletePhase::BeforeDelete {
                        run(&repo, &["update-ref", "refs/heads/feat", &head]).await;
                        run(&repo, &["pack-refs", "--all"]).await;
                    }
                })
            })
        };

        let outcome = DELETE_PHASE_HOOK
            .scope(
                mover,
                delete(&AppState::default(), &repo, "feat", Some(&feat)),
            )
            .await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::TipMoved {
                expected: feat,
                actual: head.clone()
            }
        );
        let loose = g.path().join("repo/.git/refs/heads/feat");
        assert!(!loose.exists(), "fixture sanity: the moved ref is packed");
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(head));
        assert!(!branch_section(&repo, "feat").await.is_empty());
    }

    /// One pass of the delete's guards lists the worktrees once for both the holder and
    /// the operation check, and the git dirs are read once for both passes; the pass after
    /// `update-ref` still lists the worktrees and reads HEAD afresh. The outcome's two
    /// facts are read once each, between the first pass and the delete.
    #[tokio::test]
    async fn delete_branch_guards_share_their_reads_within_a_pass() {
        let (_g, repo, _feat, _head) = delete_fixture("del-spawn-log").await;
        let log = Arc::new(std::sync::Mutex::new(Vec::<Vec<String>>::new()));
        let sink = Arc::clone(&log);
        let hook = Arc::new(move |args: &[&str]| {
            let argv = args.iter().map(|a| a.to_string()).collect();
            sink.lock().unwrap().push(argv);
        });
        let outcome = GIT_SPAWN_LOG
            .scope(hook, delete(&AppState::default(), &repo, "feat", None))
            .await;
        assert!(
            matches!(outcome, Ok(DeleteBranchOutcome::Deleted { .. })),
            "{outcome:?}"
        );
        let log = log.lock().unwrap().clone();
        let all = log.iter().map(|argv| argv.join(" ")).collect::<Vec<_>>();
        let is = |argv: &[String], lead: &[&str]| {
            argv.len() >= lead.len() && argv.iter().zip(lead).all(|(a, b)| a == b)
        };
        let lists: Vec<usize> = (0..log.len())
            .filter(|&i| is(&log[i], &["worktree", "list", "--porcelain"]))
            .collect();
        let delete_at = log
            .iter()
            .position(|argv| is(argv, &["update-ref", "--no-deref", "-d"]))
            .expect("the delete ran");
        // Every git-dir read is the folded one; the lock and marker roots' own
        // `--git-common-dir` reads are not the guards'.
        let git_dirs: Vec<&Vec<String>> = log
            .iter()
            .filter(|argv| {
                is(argv, &["rev-parse"]) && argv.iter().any(|a| a == "--absolute-git-dir")
            })
            .collect();
        let folded = [
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
            "--absolute-git-dir",
        ];
        let heads = log
            .iter()
            .filter(|argv| is(argv, &["symbolic-ref", "-q", "HEAD"]))
            .count();
        assert!(
            git_dirs.len() == 1 && git_dirs[0].as_slice() == folded,
            "one folded git-dir read for both passes: {all:#?}"
        );
        assert_eq!(
            lists.len(),
            3,
            "the pre-hold list, then one per pass: {all:#?}"
        );
        assert!(
            *lists.last().unwrap() > delete_at,
            "the pass after the delete lists the worktrees again: {all:#?}"
        );
        assert_eq!(heads, 2, "one HEAD read per pass: {all:#?}");
        let facts: Vec<usize> = (0..log.len())
            .filter(|&i| {
                is(
                    &log[i],
                    &[
                        "config",
                        "--type=bool",
                        "--get",
                        "branch.feat.gitdesktopLocalOnly",
                    ],
                ) || is(
                    &log[i],
                    &["for-each-ref", "--format=%(refname)%00%(upstream)"],
                )
            })
            .collect();
        assert!(
            facts.len() == 2 && facts.iter().all(|&i| i > lists[1] && i < delete_at),
            "the mark and upstream reads, once each, after the first pass and before the \
             delete: {all:#?}"
        );
    }

    /// A sibling worktree switching onto the branch between the guards and the delete is
    /// seen by the reads after it: the branch goes back at its tip with its settings and
    /// a fresh reflog, and that checkout is on it again rather than unborn.
    #[tokio::test]
    async fn delete_branch_puts_back_a_branch_a_sibling_checked_out_before_the_delete() {
        let (g, repo, feat, _head) = delete_fixture("del-sibling-late").await;
        let wt = g.path().join("sibling-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt, "HEAD"]).await;
        let hook = git_at_phase(DeletePhase::BeforeDelete, &wt, &["switch", "-q", "feat"]);

        let outcome = DELETE_PHASE_HOOK
            .scope(hook, delete(&AppState::default(), &repo, "feat", None))
            .await;
        assert_eq!(
            full_ref_tip(&wt, "HEAD").await,
            Some(feat.clone()),
            "not unborn"
        );
        let err = outcome.unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with("feat is checked out in the worktree at")
                    && m.contains("sibling-wt")
                    && m.ends_with("before deleting feat.")),
            "{err:?}"
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(feat));
        assert!(!branch_section(&repo, "feat").await.is_empty());
        assert_eq!(
            run(
                &repo,
                &["reflog", "show", "--format=%gs", "refs/heads/feat"]
            )
            .await
            .trim(),
            "restored: in use during delete"
        );
    }

    /// A sibling worktree on another branch, at another commit, that commits between the
    /// guards and the delete was never reading the deleted ref, so the delete lands.
    #[tokio::test]
    async fn delete_branch_lands_past_a_commit_in_an_unrelated_sibling() {
        let (g, repo, feat, head) = delete_fixture("del-sibling-commit").await;
        assert_ne!(feat, head, "fixture sanity");
        let wt = g.path().join("busy-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "-b", "busy", &wt, "HEAD"]).await;
        let hook = git_at_phase(
            DeletePhase::BeforeDelete,
            &wt,
            &["commit", "--allow-empty", "-qm", "sibling work"],
        );

        let outcome = DELETE_PHASE_HOOK
            .scope(hook, delete(&AppState::default(), &repo, "feat", None))
            .await;
        assert!(
            matches!(&outcome, Ok(DeleteBranchOutcome::Deleted { tip, .. }) if *tip == feat),
            "{outcome:?}"
        );
        assert_eq!(exact_branch_tip(&repo, "feat").await.unwrap(), None);
        assert_ne!(
            full_ref_tip(&wt, "HEAD").await,
            Some(head),
            "the sibling committed"
        );
    }

    /// A switch in the repository itself (a terminal's, which the app's hold does not
    /// exclude) between the guards and the delete puts the branch back.
    #[tokio::test]
    async fn delete_branch_puts_back_a_branch_checked_out_here_before_the_delete() {
        let (_g, repo, feat, _head) = delete_fixture("del-here-late").await;
        let hook = git_at_phase(DeletePhase::BeforeDelete, &repo, &["switch", "-q", "feat"]);

        let err = DELETE_PHASE_HOOK
            .scope(hook, delete(&AppState::default(), &repo, "feat", None))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with("feat is checked out here")
                    && m.ends_with("before deleting feat.")),
            "{err:?}"
        );
        assert_eq!(
            full_ref_tip(&repo, "refs/heads/feat").await,
            Some(feat.clone())
        );
        assert_eq!(full_ref_tip(&repo, "HEAD").await, Some(feat));
    }

    /// The sibling's unborn checkout commits before the restore, re-creating the name at a
    /// new root commit: the restore never overwrites it, the delete stands, and the
    /// settings stay for the live branch.
    #[tokio::test]
    async fn delete_branch_stands_when_the_name_is_taken_again_before_the_restore() {
        let (g, repo, feat, _head) = delete_fixture("del-retaken").await;
        let wt = g.path().join("sibling-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt, "HEAD"]).await;
        let hook: DeletePhaseHook = {
            let wt = wt.clone();
            Arc::new(move |phase| {
                let wt = wt.clone();
                Box::pin(async move {
                    match phase {
                        DeletePhase::BeforeDelete => {
                            run(&wt, &["switch", "-q", "feat"]).await;
                        }
                        // The unborn checkout still has feat's tree staged.
                        DeletePhase::AfterDelete => {
                            run(&wt, &["commit", "-qm", "retaken"]).await;
                        }
                        DeletePhase::BeforeGuards => {}
                    }
                })
            })
        };

        let outcome = DELETE_PHASE_HOOK
            .scope(hook, delete(&AppState::default(), &repo, "feat", None))
            .await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat.clone(),
                kept_local: true,
                upstream: None,
            }
        );
        let now = full_ref_tip(&repo, "refs/heads/feat")
            .await
            .expect("the sibling's commit re-created feat");
        assert_ne!(now, feat);
        let subject = run(&repo, &["log", "-1", "--format=%s", "refs/heads/feat"]).await;
        assert_eq!(subject.trim(), "retaken");
        assert_eq!(full_ref_tip(&wt, "HEAD").await, Some(now));
        assert!(!branch_section(&repo, "feat").await.is_empty());
    }

    /// The put-back fails on a stale ref lock (files backend): the delete stands and the
    /// `branch.feat` section is kept whole, mark and upstream included.
    #[tokio::test]
    async fn delete_branch_keeps_the_settings_when_the_put_back_fails() {
        let (g, repo, feat, _head) = delete_fixture("del-putback-fails").await;
        run(
            &repo,
            &["remote", "add", "origin", "https://example.invalid/r.git"],
        )
        .await;
        let section = branch_section(&repo, "feat").await;
        let wt = g.path().join("sibling-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt, "HEAD"]).await;
        let lock = g.path().join("repo/.git/refs/heads/feat.lock");
        let hook: DeletePhaseHook = {
            let (wt, lock) = (wt.clone(), lock.clone());
            Arc::new(move |phase| {
                let (wt, lock) = (wt.clone(), lock.clone());
                Box::pin(async move {
                    match phase {
                        DeletePhase::BeforeDelete => {
                            run(&wt, &["switch", "-q", "feat"]).await;
                        }
                        DeletePhase::AfterDelete => std::fs::write(&lock, b"").unwrap(),
                        DeletePhase::BeforeGuards => {}
                    }
                })
            })
        };

        let outcome = DELETE_PHASE_HOOK
            .scope(hook, delete(&AppState::default(), &repo, "feat", None))
            .await;
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat,
                kept_local: true,
                upstream: Some("origin/feat".into()),
            }
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, None);
        assert_eq!(
            run(&wt, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/feat"
        );
        assert_eq!(branch_section(&repo, "feat").await, section);
    }

    #[test]
    fn upstream_display_strips_exactly_the_remote_or_local_prefix() {
        assert_eq!(
            upstream_display("refs/remotes/origin/x"),
            Some("origin/x".to_string())
        );
        assert_eq!(
            upstream_display("refs/heads/main"),
            Some("main".to_string())
        );
        for other in [
            "",
            "refs/remotes/",
            "refs/heads/",
            "refs/tags/x",
            "refs/pull/1/head",
        ] {
            assert_eq!(upstream_display(other), None, "{other:?}");
        }
    }

    /// The Keep local mark the delete removed: set, unset, and a value git can't read as
    /// a bool, which answers `true` without failing the delete.
    #[tokio::test]
    async fn delete_branch_reports_the_keep_local_mark_it_removed() {
        let (_g, repo, feat, _head) = delete_fixture("del-facts-mark").await;
        run(&repo, &["branch", "plain", "feat"]).await;
        run(&repo, &["branch", "junk", "feat"]).await;
        run(
            &repo,
            &["config", "branch.junk.gitdesktopLocalOnly", "maybe"],
        )
        .await;
        let state = AppState::default();
        for (name, kept_local) in [("feat", true), ("plain", false), ("junk", true)] {
            assert_eq!(
                delete(&state, &repo, name, None).await.unwrap(),
                DeleteBranchOutcome::Deleted {
                    tip: feat.clone(),
                    kept_local,
                    upstream: None,
                },
                "{name}"
            );
            assert!(!branch_exists(&repo, name).await, "{name}");
        }
    }

    /// The upstream the delete removed, in display form: a remote one with no tracking
    /// ref, the same beside a tag named like its short form, a local one, and none.
    #[tokio::test]
    async fn delete_branch_reports_the_upstream_it_removed() {
        let (_g, repo, feat, _head) = delete_fixture("del-facts-upstream").await;
        run(
            &repo,
            &["remote", "add", "origin", "https://example.invalid/r.git"],
        )
        .await;
        let main_ref = run(&repo, &["symbolic-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        let main = main_ref.strip_prefix("refs/heads/").unwrap().to_string();
        for name in ["tracked", "tagged", "local", "untracked", "topic/x"] {
            run(&repo, &["branch", name, "feat"]).await;
        }
        for (name, remote, merge) in [
            ("tracked", "origin", "refs/heads/tracked"),
            ("tagged", "origin", "refs/heads/tagged"),
            ("local", ".", main_ref.as_str()),
            ("topic/x", "origin", "refs/heads/topic/x"),
        ] {
            run(&repo, &["config", &format!("branch.{name}.remote"), remote]).await;
            run(&repo, &["config", &format!("branch.{name}.merge"), merge]).await;
        }
        run(&repo, &["tag", "origin/tagged", "feat"]).await;

        // The pattern lists `topic/x` for `topic`; only the exact line answers.
        assert_eq!(
            deleted_branch_upstream(&repo, "refs/heads/topic").await,
            None
        );
        assert_eq!(
            deleted_branch_upstream(&repo, "refs/heads/topic/x").await,
            Some("origin/topic/x".to_string())
        );
        let state = AppState::default();
        for (name, upstream) in [
            ("tracked", Some("origin/tracked".to_string())),
            ("tagged", Some("origin/tagged".to_string())),
            ("local", Some(main.clone())),
            ("untracked", None),
        ] {
            assert_eq!(
                delete(&state, &repo, name, None).await.unwrap(),
                DeleteBranchOutcome::Deleted {
                    tip: feat.clone(),
                    kept_local: false,
                    upstream,
                },
                "{name}"
            );
        }
    }

    /// A mark and an upstream written after the caller's last look, between the guards
    /// and the delete, are the ones the outcome carries.
    #[tokio::test]
    async fn delete_branch_reports_facts_written_just_before_the_delete() {
        let (_g, repo, feat, _head) = delete_fixture("del-facts-late").await;
        run(
            &repo,
            &["remote", "add", "origin", "https://example.invalid/r.git"],
        )
        .await;
        run(&repo, &["branch", "late", "feat"]).await;
        let hook: DeletePhaseHook = {
            let repo = repo.clone();
            Arc::new(move |phase| {
                let repo = repo.clone();
                Box::pin(async move {
                    if phase == DeletePhase::BeforeDelete {
                        for (key, value) in [
                            ("gitdesktopLocalOnly", "true"),
                            ("remote", "origin"),
                            ("merge", "refs/heads/late"),
                        ] {
                            run(&repo, &["config", &format!("branch.late.{key}"), value]).await;
                        }
                    }
                })
            })
        };

        let outcome = DELETE_PHASE_HOOK
            .scope(hook, delete(&AppState::default(), &repo, "late", None))
            .await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat,
                kept_local: true,
                upstream: Some("origin/late".into()),
            }
        );
    }

    /// A bisect started on the branch between the guards and the delete, with no checkout
    /// holding it, is seen by the operation read after the delete: the branch goes back.
    #[tokio::test]
    async fn delete_branch_puts_back_a_branch_an_operation_claimed_before_the_delete() {
        let (g, repo, feat, _head) = delete_fixture("del-op-late").await;
        let marker = g.path().join("repo/.git/BISECT_START");
        let hook: DeletePhaseHook = Arc::new(move |phase| {
            let marker = marker.clone();
            Box::pin(async move {
                if phase == DeletePhase::BeforeDelete {
                    std::fs::write(&marker, "feat\n").unwrap();
                }
            })
        });

        let err = DELETE_PHASE_HOOK
            .scope(hook, delete(&AppState::default(), &repo, "feat", None))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with("feat is being bisected here")
                    && m.ends_with("end that bisect (git bisect reset) before deleting feat.")),
            "{err:?}"
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(feat));
    }

    /// A slash-named branch goes like a plain one: ref, reflog and settings, plus the
    /// parent directories the files backend leaves empty.
    #[tokio::test]
    async fn delete_branch_of_a_slash_named_branch_drops_ref_reflog_and_empty_parents() {
        let (g, repo, feat, _head) = delete_fixture("del-slash").await;
        run(&repo, &["branch", "topic/x", "feat"]).await;
        run(
            &repo,
            &["config", "branch.topic/x.gitdesktopLocalOnly", "true"],
        )
        .await;
        let git_dir = g.path().join("repo/.git");
        assert!(
            git_dir.join("refs/heads/topic/x").is_file()
                && reflog_exists(&repo, "refs/heads/topic/x").await,
            "fixture sanity"
        );

        let outcome = delete(&AppState::default(), &repo, "topic/x", None).await;
        assert_eq!(
            outcome.unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat,
                kept_local: true,
                upstream: None,
            }
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/topic/x").await, None);
        assert!(!reflog_exists(&repo, "refs/heads/topic/x").await);
        assert_eq!(branch_section(&repo, "topic/x").await, "");
        assert!(!git_dir.join("refs/heads/topic").exists(), "empty ref dir");
        assert!(
            !git_dir.join("logs/refs/heads/topic").exists(),
            "empty log dir"
        );
    }

    /// A checkout made while the delete waits on the config-write mutex is still seen:
    /// the guards run once the mutex is held, so the delete refuses and the ref stays.
    #[tokio::test]
    async fn delete_branch_refuses_a_checkout_made_while_it_waits_on_the_config_mutex() {
        let (g, repo, feat, _head) = delete_fixture("del-mutex-wait").await;
        let wt = g.path().join("wt").to_string_lossy().into_owned();
        let (held_tx, held_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let holder = tokio::spawn({
            let repo = repo.clone();
            async move {
                crate::git::runner::with_config_write_lock(&repo, |_held| async move {
                    let _ = held_tx.send(());
                    let _ = release_rx.await;
                })
                .await
            }
        });
        held_rx.await.expect("the test holds the mutex");

        let (waiting_tx, waiting_rx) = tokio::sync::oneshot::channel::<()>();
        let waiting_tx = std::sync::Mutex::new(Some(waiting_tx));
        let events: Arc<dyn Fn(&'static str) + Send + Sync> = Arc::new(move |event| {
            if event == "waiting" {
                if let Some(tx) = waiting_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        });
        let deleter = tokio::spawn({
            let repo = repo.clone();
            CONFIG_WRITE_LOCK_EVENTS.scope(events, async move {
                delete(&AppState::default(), &repo, "feat", None).await
            })
        });
        waiting_rx.await.expect("the delete reached the mutex");
        run(&repo, &["worktree", "add", "-q", &wt, "feat"]).await;
        release_tx.send(()).unwrap();
        holder.await.unwrap();

        let err = tokio::time::timeout(Duration::from_secs(60), deleter)
            .await
            .expect("the delete finishes once released")
            .unwrap()
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with("feat is checked out in the worktree at")
                    && m.ends_with("before deleting feat.")),
            "{err:?}"
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(feat));
    }

    /// Holds `repo`'s config-write mutex from another task until the sender fires.
    pub(crate) async fn hold_config_mutex(
        repo: &str,
    ) -> (
        tokio::task::JoinHandle<()>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (held_tx, held_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let repo = repo.to_string();
        let holder = tokio::spawn(async move {
            crate::git::runner::with_config_write_lock(&repo, |_held| async move {
                let _ = held_tx.send(());
                let _ = release_rx.await;
            })
            .await
        });
        held_rx.await.expect("the test holds the mutex");
        (holder, release_tx)
    }

    /// A [`CONFIG_WRITE_LOCK_EVENTS`] hook that fires the receiver at the first
    /// "waiting"; dropped unfired, the receiver errs instead of hanging.
    pub(crate) fn on_first_waiting() -> (
        Arc<dyn Fn(&'static str) + Send + Sync>,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let tx = std::sync::Mutex::new(Some(tx));
        let hook = move |event| {
            if event == "waiting" {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        };
        (Arc::new(hook), rx)
    }

    /// The branch `repo`'s HEAD names, `None` when detached.
    async fn symbolic_head(repo: &str) -> Option<String> {
        let out = run_git_raw(
            Some(repo),
            &["symbolic-ref", "-q", "HEAD"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        (out.code == 0).then(|| out.stdout_lossy().trim().to_string())
    }

    /// A plain switch in a linked worktree queues on the config-write mutex (held here
    /// through the main checkout, which shares it) with HEAD unmoved, then lands.
    #[tokio::test]
    async fn checkout_waits_on_the_config_mutex_before_moving_head() {
        let (g, repo, _feat, _head) = delete_fixture("switch-mutex").await;
        let wt = g.path().join("wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt]).await;
        let (holder, release) = hold_config_mutex(&repo).await;

        let (events, waiting) = on_first_waiting();
        let switch = tokio::spawn({
            let wt = wt.clone();
            CONFIG_WRITE_LOCK_EVENTS.scope(events, async move {
                super::git_checkout_branch_core(&AppState::default(), wt, "feat".into()).await
            })
        });
        waiting.await.expect("the switch reached the mutex");
        assert_eq!(
            symbolic_head(&wt).await,
            None,
            "HEAD moved before the mutex"
        );
        release.send(()).unwrap();
        holder.await.unwrap();

        tokio::time::timeout(TEST_GIT_HANG_GUARD, switch)
            .await
            .expect("the switch finishes once released")
            .unwrap()
            .unwrap();
        assert_eq!(symbolic_head(&wt).await.as_deref(), Some("refs/heads/feat"));
    }

    /// A switch onto the branch a delete is parked on (inside the mutex) waits for the
    /// delete, then fails on the missing name, leaving its checkout where it was.
    #[tokio::test]
    async fn checkout_queued_behind_a_parked_delete_finds_the_branch_gone() {
        let (g, repo, feat, _head) = delete_fixture("switch-behind-delete").await;
        let wt = g.path().join("wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt]).await;
        let wt_head = full_ref_tip(&wt, "HEAD").await;
        let state = Arc::new(AppState::default());

        let (parked_tx, parked_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let slots = Arc::new(std::sync::Mutex::new((Some(parked_tx), Some(release_rx))));
        let hook: DeletePhaseHook = Arc::new(move |phase| {
            let slots = Arc::clone(&slots);
            Box::pin(async move {
                if phase != DeletePhase::BeforeDelete {
                    return;
                }
                let (parked, release) = {
                    let mut slots = slots.lock().unwrap();
                    (slots.0.take(), slots.1.take())
                };
                if let (Some(parked), Some(release)) = (parked, release) {
                    let _ = parked.send(());
                    let _ = release.await;
                }
            })
        });
        let deleter = tokio::spawn({
            let (state, repo) = (Arc::clone(&state), repo.clone());
            DELETE_PHASE_HOOK.scope(
                hook,
                async move { delete(&state, &repo, "feat", None).await },
            )
        });
        parked_rx.await.expect("the delete parked inside the mutex");

        let (events, waiting) = on_first_waiting();
        let switch = tokio::spawn({
            let (state, wt) = (Arc::clone(&state), wt.clone());
            CONFIG_WRITE_LOCK_EVENTS.scope(events, async move {
                super::git_checkout_branch_core(&state, wt, "feat".into()).await
            })
        });
        waiting.await.expect("the switch queued behind the delete");
        release_tx.send(()).unwrap();

        assert_eq!(
            deleter.await.unwrap().unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat,
                kept_local: true,
                upstream: None,
            }
        );
        let err = tokio::time::timeout(TEST_GIT_HANG_GUARD, switch)
            .await
            .expect("the switch finishes once the delete does")
            .unwrap()
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Git { stderr, .. } if stderr.contains("invalid reference: feat")),
            "{err:?}"
        );
        assert_eq!(full_ref_tip(&wt, "HEAD").await, wt_head);
        assert!(wt_head.is_some());
    }

    /// A switch refused over local changes keeps git's stderr, which the frontend
    /// matches on. git reports this on stderr alone, so no control can tell stderr
    /// from the combined text here.
    #[tokio::test]
    async fn checkout_refused_over_local_changes_keeps_git_stderr() {
        let (_g, repo, _feat, _head) = delete_fixture("switch-dirty").await;
        std::fs::write(std::path::Path::new(&repo).join("a.txt"), "dirty\n").unwrap();
        let err =
            super::git_checkout_branch_core(&AppState::default(), repo.clone(), "feat".into())
                .await
                .unwrap_err();
        assert!(
            matches!(&err, AppError::Git { stderr, .. }
                if stderr.contains("would be overwritten by checkout")),
            "{err:?}"
        );
    }

    /// The delete takes the worktree-admin domain first: held by a removal, the
    /// delete answers Busy naming it and deletes nothing.
    #[tokio::test]
    async fn delete_branch_answers_busy_while_the_admin_domain_is_held() {
        let (_g, repo, feat, _head) = delete_fixture("del-admin-busy").await;
        let state = AppState::default();
        let _admin = acquire_repo_lock(
            &state.worktree_admin_lock(&repo).await,
            Duration::ZERO,
            "a worktree removal",
        )
        .await
        .expect("the admin domain is free");

        let err =
            git_delete_branch_within(&state, repo.clone(), "feat".into(), None, Duration::ZERO)
                .await
                .unwrap_err();
        assert!(
            matches!(&err, AppError::Busy { holder } if holder == "a worktree removal"),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "A worktree removal is still running — try again when it finishes."
        );
        assert_eq!(
            serde_json::to_string(&err).unwrap(),
            r#"{"kind":"busy","message":"A worktree removal is still running — try again when it finishes.","holder":"a worktree removal"}"#
        );
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, Some(feat));
    }

    /// Both of the delete's domain holds carry its own label across the guarded
    /// section, so a waiter behind either reads "A branch delete …", and both are free
    /// once it returns.
    #[tokio::test]
    async fn delete_branch_holds_both_domains_under_its_own_label() {
        let (_g, repo, feat, _head) = delete_fixture("del-holder-label").await;
        let state = AppState::default();
        let admin = state.worktree_admin_lock(&repo).await;
        let tree = state.working_tree_lock(&repo).await;
        let checked = Arc::new(std::sync::Mutex::new(Vec::new()));
        let hook: DeletePhaseHook = {
            let (admin, tree, checked) = (admin.clone(), tree.clone(), Arc::clone(&checked));
            Arc::new(move |phase| {
                let (admin, tree, checked) = (admin.clone(), tree.clone(), Arc::clone(&checked));
                Box::pin(async move {
                    if phase == DeletePhase::BeforeGuards {
                        return;
                    }
                    for (what, domain) in [("admin", &admin), ("working tree", &tree)] {
                        assert_eq!(
                            domain.holder_label(),
                            Some("a branch delete"),
                            "{what} at {phase:?}"
                        );
                        if phase != DeletePhase::BeforeDelete {
                            continue;
                        }
                        let err =
                            match acquire_repo_lock(domain, Duration::ZERO, "a worktree operation")
                                .await
                            {
                                Ok(_) => panic!("the {what} domain was free inside the delete"),
                                Err(err) => err,
                            };
                        assert!(
                            matches!(&err, AppError::Busy { holder } if holder == "a branch delete"),
                            "{what}: {err:?}"
                        );
                        assert_eq!(
                            err.to_string(),
                            "A branch delete is still running — try again when it finishes."
                        );
                        assert_eq!(
                            serde_json::to_string(&err).unwrap(),
                            r#"{"kind":"busy","message":"A branch delete is still running — try again when it finishes.","holder":"a branch delete"}"#
                        );
                    }
                    checked.lock().unwrap().push(phase);
                })
            })
        };

        let outcome = DELETE_PHASE_HOOK
            .scope(hook, delete(&state, &repo, "feat", None))
            .await
            .unwrap();
        assert_eq!(
            outcome,
            DeleteBranchOutcome::Deleted {
                tip: feat,
                kept_local: true,
                upstream: None,
            }
        );
        assert_eq!(
            *checked.lock().unwrap(),
            vec![DeletePhase::BeforeDelete, DeletePhase::AfterDelete]
        );
        assert_eq!(admin.holder_label(), None);
        assert_eq!(tree.holder_label(), None);
    }

    /// ADMIN is the outer lock: a delete queued behind a working-tree holder already
    /// holds it, so a bounded admin waiter meanwhile reads the delete as the holder.
    #[tokio::test]
    async fn delete_branch_takes_the_admin_domain_before_the_working_tree() {
        let (_g, repo, feat, _head) = delete_fixture("del-admin-first").await;
        let state = Arc::new(AppState::default());
        let admin = state.worktree_admin_lock(&repo).await;
        let tree = state.working_tree_lock(&repo).await;
        let held = acquire_repo_lock(&tree, Duration::ZERO, "a commit")
            .await
            .expect("the working-tree domain is free");

        let delete = tokio::spawn({
            let (state, repo) = (Arc::clone(&state), repo.clone());
            async move {
                git_delete_branch_within(&state, repo, "feat".into(), None, TEST_GIT_HANG_GUARD)
                    .await
            }
        });
        let deadline = tokio::time::Instant::now() + TEST_GIT_HANG_GUARD;
        while admin.holder_label() != Some("a branch delete")
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let err = match acquire_repo_lock(&admin, Duration::ZERO, "a worktree operation").await {
            Ok(_) => panic!("the admin domain was free while the delete waited"),
            Err(err) => err,
        };
        assert!(
            matches!(&err, AppError::Busy { holder } if holder == "a branch delete"),
            "{err:?}"
        );
        assert_eq!(
            full_ref_tip(&repo, "refs/heads/feat").await,
            Some(feat.clone())
        );

        drop(held);
        let outcome = delete.await.unwrap().unwrap();
        assert!(
            matches!(&outcome, DeleteBranchOutcome::Deleted { tip, .. } if *tip == feat),
            "{outcome:?}"
        );
    }

    #[test]
    fn delete_branch_outcome_wire_shape() {
        let (a, b) = ("a".repeat(40), "b".repeat(40));
        let deleted = serde_json::to_string(&DeleteBranchOutcome::Deleted {
            tip: a.clone(),
            kept_local: true,
            upstream: Some("origin/x".into()),
        })
        .unwrap();
        assert_eq!(
            deleted,
            format!(r#"{{"status":"deleted","tip":"{a}","keptLocal":true,"upstream":"origin/x"}}"#)
        );
        let untracked = serde_json::to_string(&DeleteBranchOutcome::Deleted {
            tip: a.clone(),
            kept_local: false,
            upstream: None,
        })
        .unwrap();
        assert_eq!(
            untracked,
            format!(r#"{{"status":"deleted","tip":"{a}","keptLocal":false,"upstream":null}}"#)
        );
        let moved = serde_json::to_string(&DeleteBranchOutcome::TipMoved {
            expected: a.clone(),
            actual: b.clone(),
        })
        .unwrap();
        assert_eq!(
            moved,
            format!(r#"{{"status":"tipMoved","expected":"{a}","actual":"{b}"}}"#)
        );
        for wire in [&deleted, &untracked, &moved] {
            assert!(
                !wire.contains("tip_moved")
                    && !wire.contains("kept_local")
                    && !wire.contains("Deleted"),
                "{wire}"
            );
        }
    }

    /// A rename that loses the config lock still carries the branch's settings to the
    /// new name, through the repair's retry.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_rename_that_loses_the_config_lock_still_moves_the_branch_settings() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (old, new) = ("cfg-lock-rename", "cfg-lock-renamed");
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-rename", old, "unused").await;
        let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&repo), 2);

        let state = AppState::default();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_rename_branch_core(&state, repo_s.clone(), old.into(), new.into()),
            )
            .await
            .expect("the rename succeeds");
        assert!(branch_exists(&repo_s, new).await);
        assert_eq!(
            branch_section(&repo_s, old).await,
            "",
            "nothing left behind"
        );
        let moved = branch_section(&repo_s, new).await;
        assert!(moved.contains("gitdesktoparchived true"), "{moved}");
        assert!(moved.contains(".merge "), "the upstream moved too: {moved}");
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// A lock held through the repair's retry surfaces git's own half-done error, so a
    /// rename whose settings stayed behind is never reported as a success.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_rename_whose_repair_also_loses_keeps_gits_error() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (old, new) = ("cfg-lock-rename-held", "cfg-lock-rename-held2");
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-rename-held", old, "unused").await;
        let lock = hold_config_lock(&repo);

        let state = AppState::default();
        let err = git_rename_branch_core(&state, repo_s.clone(), old.into(), new.into())
            .await
            .expect_err("a second lost race surfaces");
        let AppError::Git { code, stderr } = &err else {
            panic!("expected git's error, got {err:?}")
        };
        assert_eq!(*code, 128);
        assert!(stderr.contains(RENAMED_CONFIG_LEFT_BEHIND), "{stderr}");
        std::fs::remove_file(&lock).unwrap();
    }

    /// A tracking switch that loses the config lock ends where an uncontended one
    /// does: on the new branch, tracking the remote one.
    #[tokio::test]
    async fn a_tracking_switch_that_loses_the_config_lock_still_tracks_and_switches() {
        let remote_branch = "cfg-lock-track";
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-track", "unrelated", remote_branch).await;
        let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&repo), 2);

        let state = AppState::default();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_checkout_remote_branch_core(
                    &state,
                    repo_s.clone(),
                    "origin".into(),
                    remote_branch.into(),
                ),
            )
            .await
            .expect("the switch succeeds");
        assert_cleanly_on(&repo, &repo_s, remote_branch).await;
        assert_eq!(
            upstream_of(&repo_s, remote_branch).await.as_deref(),
            Some(format!("origin/{remote_branch}").as_str())
        );
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// HEAD on `branch` with the working tree at its tip and nothing staged — where an
    /// uncontended switch ends, and never the moved-tree-under-old-HEAD half state.
    async fn assert_cleanly_on(repo: &std::path::Path, repo_s: &str, branch: &str) {
        assert_eq!(
            run(repo_s, &["symbolic-ref", "--short", "HEAD"])
                .await
                .trim(),
            branch
        );
        assert_eq!(seed_file(repo), "remote");
        assert_eq!(porcelain(repo_s).await, "", "nothing left staged");
    }

    async fn upstream_of(repo: &str, branch: &str) -> Option<String> {
        let spec = format!("{branch}@{{upstream}}");
        run_git(
            Some(repo),
            &["rev-parse", "--abbrev-ref", &spec],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .ok()
        .map(|out| out.stdout_lossy().trim().to_string())
    }

    /// The switch leg runs even when the upstream repair loses again: the branch is
    /// checked out cleanly and git's upstream error is what the caller hears.
    #[tokio::test]
    async fn a_tracking_switch_whose_upstream_repair_also_loses_still_switches() {
        let remote_branch = "cfg-lock-track-held";
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-track-held", "unrelated", remote_branch).await;
        let lock = hold_config_lock(&repo);

        let state = AppState::default();
        let err = git_checkout_remote_branch_core(
            &state,
            repo_s.clone(),
            "origin".into(),
            remote_branch.into(),
        )
        .await
        .expect_err("the lost upstream is reported");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's error, got {err:?}")
        };
        assert!(stderr.contains(UPSTREAM_WRITE_FAILED), "{stderr}");
        std::fs::remove_file(&lock).unwrap();
        assert_cleanly_on(&repo, &repo_s, remote_branch).await;
        assert_eq!(upstream_of(&repo_s, remote_branch).await, None);
    }

    /// `branch.<name>.remote` and `.merge`, or `None` for each that is unset.
    async fn tracking_of(repo: &str, branch: &str) -> (Option<String>, Option<String>) {
        let get = |key: &'static str| {
            let key = format!("branch.{branch}.{key}");
            async move {
                let out = run_git_raw(Some(repo), &["config", "--get", &key], TEST_GIT_HANG_GUARD)
                    .await
                    .unwrap();
                (out.code == 0).then(|| out.stdout_lossy().trim().to_string())
            }
        };
        (get("remote").await, get("merge").await)
    }

    /// Every `branch.autoSetupMerge` mode × start kind in which git attempts tracking
    /// (measured, git 2.51.1). Repaired exactly where git's own choice is the start ref
    /// itself, to what an uncontended twin create writes; `inherit` copies the START's
    /// upstream instead, which the repair can't pin, so it surfaces git's error with no
    /// upstream rather than a wrong one, and the switch leg still runs. A create with no
    /// start point starts from HEAD, which `always` tracks like any local start.
    #[tokio::test]
    async fn a_tracked_create_repairs_only_what_git_itself_would_write() {
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-modes", "local-start", "same-name").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        let state = AppState::default();
        // (mode, start, new branch, checkout, repaired). `simple` tracks only a
        // same-named remote branch, so its row creates `same-name` itself.
        type Case<'a> = (Option<&'a str>, Option<&'a str>, &'a str, bool, bool);
        let cases: [Case<'_>; 7] = [
            (None, Some("origin/same-name"), "mode-default", false, true),
            (
                Some("always"),
                Some("local-start"),
                "mode-always-local",
                false,
                true,
            ),
            (Some("always"), None, "mode-always-nostart", false, true),
            (Some("always"), None, "mode-always-nostart-co", true, true),
            (
                Some("simple"),
                Some("origin/same-name"),
                "same-name",
                false,
                true,
            ),
            (
                Some("inherit"),
                Some("local-start"),
                "mode-inherit-local",
                false,
                false,
            ),
            (
                Some("inherit"),
                Some("local-start"),
                "mode-inherit-co",
                true,
                false,
            ),
        ];
        for (mode, start, name, checkout, repaired) in cases {
            run(&repo_s, &["switch", "-q", main.trim()]).await;
            let _ = run_git_raw(
                Some(&repo_s),
                &["config", "--unset-all", "branch.autoSetupMerge"],
                TEST_GIT_HANG_GUARD,
            )
            .await;
            if let Some(mode) = mode {
                run(&repo_s, &["config", "branch.autoSetupMerge", mode]).await;
            }
            // What git itself writes in this mode, uncontended. `simple` gets the
            // measured literal: its twin can't share the name tracking requires.
            let want = if mode == Some("simple") {
                (Some("origin".into()), Some("refs/heads/same-name".into()))
            } else {
                let twin = format!("{name}-twin");
                let mut twin_args = vec!["branch", twin.as_str()];
                twin_args.extend(start);
                run(&repo_s, &twin_args).await;
                tracking_of(&repo_s, &twin).await
            };
            assert!(want.0.is_some(), "{mode:?} × {start:?}: git tracks here");

            let lock = hold_config_lock(&repo);
            let (hook, _) = release_config_lock_before_attempt(lock.clone(), 2);
            let created = CONFIG_WRITE_ATTEMPT_HOOK
                .scope(
                    hook,
                    git_create_branch_core(
                        &state,
                        repo_s.clone(),
                        name.into(),
                        checkout,
                        start.map(str::to_string),
                        false,
                    ),
                )
                .await;
            let _ = std::fs::remove_file(&lock);
            let got = tracking_of(&repo_s, name).await;
            if repaired {
                created.unwrap_or_else(|e| panic!("{mode:?} × {start:?}: {e}"));
                assert_eq!(
                    got, want,
                    "{mode:?} × {start:?}: what git would have written"
                );
            } else {
                let err = created.expect_err("an unpinnable upstream surfaces git's error");
                let AppError::Git { stderr, .. } = &err else {
                    panic!("expected git's error, got {err:?}")
                };
                assert!(stderr.contains(UPSTREAM_WRITE_FAILED), "{stderr}");
                assert_eq!(
                    got,
                    (None, None),
                    "{mode:?} × {start:?}: no guessed upstream"
                );
                assert_ne!(want.1.as_deref(), Some("refs/heads/local-start"));
            }
            assert!(branch_exists(&repo_s, name).await);
            if checkout {
                assert_eq!(
                    run(&repo_s, &["symbolic-ref", "--short", "HEAD"])
                        .await
                        .trim(),
                    name
                );
                assert_eq!(porcelain(&repo_s).await, "", "the switch leg still ran");
            }
        }
    }

    /// A create from a tracked start point that loses the config lock ends where an
    /// uncontended one does, in both modes: switched (or not) and tracking.
    #[tokio::test]
    async fn a_tracked_create_that_loses_the_config_lock_still_tracks() {
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-create", "unrelated", "cfg-lock-start").await;
        let state = AppState::default();
        for (name, checkout) in [("cfg-lock-made", false), ("cfg-lock-made-co", true)] {
            let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&repo), 2);
            CONFIG_WRITE_ATTEMPT_HOOK
                .scope(
                    hook,
                    git_create_branch_core(
                        &state,
                        repo_s.clone(),
                        name.into(),
                        checkout,
                        Some("origin/cfg-lock-start".into()),
                        false,
                    ),
                )
                .await
                .expect("the create succeeds");
            assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
            assert_eq!(
                upstream_of(&repo_s, name).await.as_deref(),
                Some("origin/cfg-lock-start")
            );
            if checkout {
                assert_cleanly_on(&repo, &repo_s, name).await;
            } else {
                assert_eq!(seed_file(&repo), "hello", "a plain create leaves the tree");
                assert_eq!(porcelain(&repo_s).await, "");
            }
        }
    }

    #[test]
    fn the_config_busy_refusal_names_the_branch_and_the_retry() {
        assert_eq!(
            archive_config_busy("feat/x", true).to_string(),
            "Another Git process was saving this repository's settings, so feat/x wasn't \
             archived — try again."
        );
        assert!(archive_config_busy("feat/x", false)
            .to_string()
            .contains("feat/x wasn't unarchived — try again."));
    }
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_branch_from_ignored_shapes() {
        use crate::git::ignored_guard::tests::{Fixture, Shape, SHAPES};
        for shape in SHAPES {
            for diverged in [false, true] {
                if shape == Shape::ModifyDelete && !diverged {
                    continue;
                }
                let f = Fixture::new(shape, diverged).await;
                let (_serialized, _override, _root) = holder_marker_root(&f.repo);
                let result = update_branch_from(
                    &AppState::default(),
                    &f.repo,
                    "local",
                    "incoming",
                    &HashSet::new(),
                    None,
                )
                .await;
                if shape == Shape::InsideIgnoredDir {
                    result.unwrap();
                    f.assert_landed().await;
                } else {
                    f.assert_unchanged(&result.unwrap_err()).await;
                }
            }
        }
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_branch_from_ignored_guard_sensitivity() {
        use crate::git::ignored_guard::tests::{Fixture, Shape};
        let f = Fixture::new(Shape::IgnoredFile, true).await;
        let (_serialized, _override, _root) = holder_marker_root(&f.repo);
        let state = AppState::default();
        let err = update_branch_from(&state, &f.repo, "local", "incoming", &HashSet::new(), None)
            .await
            .unwrap_err();
        f.assert_unchanged(&err).await;
        f.remove_ignored();
        update_branch_from(&state, &f.repo, "local", "incoming", &HashSet::new(), None)
            .await
            .unwrap();
        f.assert_landed().await;
    }
    #[tokio::test]
    async fn holder_ignored_guard_sensitivity() {
        use crate::git::ignored_guard::tests::{Fixture, Shape};
        let f = Fixture::new(Shape::IgnoredFile, true).await;
        let state = AppState::default();
        let err = update_in_holder(
            &state,
            &f.repo,
            "local",
            "incoming",
            &f.target,
            HolderMerge::Merge { subject: None },
        )
        .await
        .unwrap_err();
        let AppError::BranchHeld {
            message, reason, ..
        } = err
        else {
            panic!("{err:?}");
        };
        assert_eq!(reason, "failed");
        assert!(
            message.contains("ignored files there: local.cfg"),
            "{message}"
        );
        f.assert_intact().await;
        f.remove_ignored();
        update_in_holder(
            &state,
            &f.repo,
            "local",
            "incoming",
            &f.target,
            HolderMerge::Merge { subject: None },
        )
        .await
        .unwrap();
        f.assert_landed().await;
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn update_branch_from_ignored_guard_matches_native_operation_states() {
        use crate::git::ignored_guard::tests::{Fixture, Shape, MERGE_STATES};
        for state in MERGE_STATES {
            let mut f = Fixture::new(Shape::IgnoredFile, true).await;
            let (_serialized, _override, _root) = holder_marker_root(&f.repo);
            state.install(&f).await;
            f.snapshot().await;
            let expected = if state.blocks_merge() {
                Some(
                    run_git_raw(
                        Some(&f.repo),
                        &["merge", "--no-edit", "--no-overwrite-ignore", "incoming"],
                        TEST_GIT_HANG_GUARD,
                    )
                    .await
                    .unwrap(),
                )
            } else {
                None
            };
            let err = update_branch_from(
                &AppState::default(),
                &f.repo,
                "local",
                "incoming",
                &HashSet::new(),
                None,
            )
            .await
            .unwrap_err();
            if let Some(expected) = expected {
                let AppError::Git { code, stderr } = err else {
                    panic!("{state:?}: {err:?}")
                };
                assert_ne!(expected.code, 0);
                assert_eq!(code, expected.code);
                assert_eq!(stderr, expected.full_failure_text(), "{state:?}");
                f.assert_snapshot().await;
            } else {
                f.assert_unchanged(&err).await;
            }
        }
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn update_branch_from_blocked_by_native_state_does_not_wait_for_fetch() {
        use crate::git::ignored_guard::tests::{Fixture, MergeState, Shape};
        use crate::git::runner::NETWORK_LOCK_WAIT_TIMEOUT;
        let f = Fixture::new(Shape::IgnoredFile, true).await;
        let (_serialized, _override, _root) = holder_marker_root(&f.repo);
        MergeState::MergeHead.install(&f).await;
        let expected = run_git_raw(
            Some(&f.repo),
            &["merge", "--no-edit", "--no-overwrite-ignore", "incoming"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_ne!(expected.code, 0);
        let state = AppState::default();
        let network = state.network_lock(&f.repo).await;
        let _held = acquire_repo_lock(&network, NETWORK_LOCK_WAIT_TIMEOUT, "a fetch")
            .await
            .unwrap();
        let err = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            update_branch_from(&state, &f.repo, "local", "incoming", &HashSet::new(), None),
        )
        .await
        .expect("git's own refusal must precede the network wait")
        .unwrap_err();
        let AppError::Git { code, stderr } = err else {
            panic!("{err:?}")
        };
        assert_eq!(code, expected.code);
        assert_eq!(stderr, expected.full_failure_text());
        assert!(stderr.contains("MERGE_HEAD exists"), "{stderr}");
        f.assert_snapshot().await;
    }

    /// Pins the measured exit of `for-each-ref --contains` on a well-formed oid
    /// the repo lacks, which decides how `commit_on_remote` reads an empty answer.
    #[tokio::test]
    async fn commit_on_remote_errs_for_an_unknown_oid() {
        let (_base, base) = temp_base("on-remote-unknown");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        let unknown = "0123456789abcdef0123456789abcdef01234567";
        let raw = run_git_raw(
            Some(&repo),
            &[
                "for-each-ref",
                "refs/remotes",
                "--contains",
                unknown,
                "--format=%(refname)",
            ],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_ne!(
            raw.code, 0,
            "for-each-ref answered an unknown oid with exit 0"
        );
        let result = super::commit_on_remote(repo.clone(), unknown.into()).await;
        assert!(matches!(result, Err(AppError::Command(_))), "{result:?}");
    }

    #[tokio::test]
    async fn commit_on_remote_answers_from_remote_tracking_refs() {
        let (_base, base) = temp_base("on-remote-answers");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        let pushed = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        run(&repo, &["commit", "-q", "--allow-empty", "-m", "local"]).await;
        let local = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        assert!(super::commit_on_remote(repo.clone(), pushed).await.unwrap());
        assert!(!super::commit_on_remote(repo.clone(), local).await.unwrap());
    }

    /// `--contains` skips a remote-tracking ref whose tip object is missing and still
    /// exits 0, so the empty answer must not read as "not on a remote".
    #[tokio::test]
    async fn commit_on_remote_errs_when_a_remote_tip_is_missing() {
        let (_base, base) = temp_base("on-remote-missing-tip");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        let local = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        // update-ref refuses a missing object, so the loose ref is written directly.
        let refs = base
            .join(".git")
            .join("refs")
            .join("remotes")
            .join("origin");
        std::fs::create_dir_all(&refs).unwrap();
        std::fs::write(
            refs.join("main"),
            "0123456789abcdef0123456789abcdef01234567\n",
        )
        .unwrap();
        let result = super::commit_on_remote(repo.clone(), local).await;
        assert!(matches!(result, Err(AppError::Command(_))), "{result:?}");
    }

    /// A stale `origin/HEAD` symref to a deleted branch is common and names no tip, so
    /// it leaves an empty answer standing.
    #[tokio::test]
    async fn commit_on_remote_reads_past_a_dangling_remote_head_symref() {
        let (_base, base) = temp_base("on-remote-dangling-head");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        run(&repo, &["commit", "-q", "--allow-empty", "-m", "local"]).await;
        let local = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        let refs = base
            .join(".git")
            .join("refs")
            .join("remotes")
            .join("origin");
        std::fs::write(refs.join("HEAD"), "ref: refs/remotes/origin/gone\n").unwrap();
        assert!(!super::commit_on_remote(repo.clone(), local).await.unwrap());
    }

    /// Expected `git_unpushed_count` answer: (count, basis, default branch), with the
    /// head oid read here (`None` where HEAD doesn't verify: unborn).
    async fn assert_unpushed(repo: &str, count: u32, basis: UnpushedBasis, default: Option<&str>) {
        let head = run_git_raw(
            Some(repo),
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        let head_oid = (head.code == 0).then(|| head.stdout_lossy().trim().to_string());
        let got = super::git_unpushed_count(repo.to_string()).await.unwrap();
        assert_eq!(
            got,
            UnpushedCount {
                count,
                basis,
                default_branch: default.map(str::to_string),
                head_oid,
            }
        );
    }

    async fn commit_empty(repo: &str, message: &str) {
        run(repo, &["commit", "-q", "--allow-empty", "-m", message]).await;
    }

    /// A seed commit plus one more, on a branch named `master`.
    async fn init_master_repo(repo: &str) {
        init_repo(repo, "r.txt").await;
        run(repo, &["branch", "-m", "master"]).await;
        commit_empty(repo, "two").await;
    }

    #[tokio::test]
    async fn unpushed_count_reads_zero_on_an_unborn_head() {
        let (_base, base) = temp_base("unpushed-unborn");
        let repo = base.to_string_lossy().into_owned();
        run(&repo, &["init", "-q"]).await;
        // No main/master ref exists before the first commit.
        assert_unpushed(&repo, 0, UnpushedBasis::Unresolved, None).await;
        let got = super::git_unpushed_count(repo).await.unwrap();
        assert_eq!(got.head_oid, None);
    }

    /// The count carries the commit it was counted from: the detached commit on a
    /// detached HEAD, the branch tip otherwise, on the remotes basis too.
    #[tokio::test]
    async fn unpushed_count_returns_the_head_oid_it_counted_from() {
        let (_base, base) = temp_base("unpushed-head-oid");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        let tip = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        run(&repo, &["checkout", "-q", "--detach", "HEAD~1"]).await;
        let detached = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        assert_ne!(detached, tip, "fixture: the detached commit is not the tip");
        let got = super::git_unpushed_count(repo.clone()).await.unwrap();
        assert_eq!(got.head_oid.as_deref(), Some(detached.as_str()));
        assert_eq!(got.basis, UnpushedBasis::DefaultBranch);
        assert_eq!(got.count, 0);

        run(&repo, &["switch", "-q", "master"]).await;
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD~1"]).await;
        let got = super::git_unpushed_count(repo).await.unwrap();
        assert_eq!(got.head_oid.as_deref(), Some(tip.as_str()));
        assert_eq!((got.basis, got.count), (UnpushedBasis::Remotes, 1));
    }

    #[tokio::test]
    async fn unpushed_count_excludes_remote_tracking_refs() {
        let (_base, base) = temp_base("unpushed-remotes");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        commit_empty(&repo, "local").await;
        assert_unpushed(&repo, 1, UnpushedBasis::Remotes, None).await;
    }

    /// The probe's `--count=1` must apply after for-each-ref skips the dangling
    /// symref that sorts ahead of the real remote ref.
    #[tokio::test]
    async fn unpushed_count_probe_sees_a_remote_ref_behind_a_dangling_head() {
        let (_base, base) = temp_base("unpushed-dangling-first");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/aaa/HEAD",
                "refs/remotes/aaa/master",
            ],
        )
        .await;
        run(&repo, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        commit_empty(&repo, "local").await;
        assert_unpushed(&repo, 1, UnpushedBasis::Remotes, None).await;
    }

    #[tokio::test]
    async fn unpushed_count_stops_at_the_default_branch_fork_point_without_a_remote() {
        let (_base, base) = temp_base("unpushed-fork-point");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(&repo, &["switch", "-q", "-c", "feature"]).await;
        for message in ["f1", "f2", "f3"] {
            commit_empty(&repo, message).await;
        }
        assert_unpushed(&repo, 3, UnpushedBasis::DefaultBranch, Some("master")).await;
    }

    #[tokio::test]
    async fn unpushed_count_reaches_every_commit_on_the_default_branch() {
        let (_base, base) = temp_base("unpushed-on-default");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        commit_empty(&repo, "three").await;
        assert_unpushed(&repo, 3, UnpushedBasis::OnDefaultBranch, Some("master")).await;
    }

    #[tokio::test]
    async fn unpushed_count_counts_every_commit_without_a_default_branch() {
        let (_base, base) = temp_base("unpushed-unresolved");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["branch", "-m", "topic"]).await;
        commit_empty(&repo, "two").await;
        assert_unpushed(&repo, 2, UnpushedBasis::Unresolved, None).await;
    }

    #[tokio::test]
    async fn unpushed_count_counts_a_whole_orphan_branch() {
        let (_base, base) = temp_base("unpushed-orphan");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(&repo, &["switch", "-q", "--orphan", "lone"]).await;
        commit_empty(&repo, "o1").await;
        commit_empty(&repo, "o2").await;
        assert_unpushed(&repo, 2, UnpushedBasis::DefaultBranch, Some("master")).await;
    }

    #[tokio::test]
    async fn unpushed_count_counts_a_detached_head_past_the_default_branch() {
        let (_base, base) = temp_base("unpushed-detached");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(&repo, &["switch", "-q", "-c", "feature"]).await;
        commit_empty(&repo, "f1").await;
        let sha = run(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        run(&repo, &["checkout", "-q", "--detach", &sha]).await;
        assert_unpushed(&repo, 1, UnpushedBasis::DefaultBranch, Some("master")).await;
    }

    /// A dangling `refs/remotes/origin/HEAD` resolves no ref, so the no-remote arms
    /// answer; its target names a default that verifies locally.
    #[tokio::test]
    async fn unpushed_count_treats_a_dangling_remote_head_as_no_remote() {
        let (_base, base) = temp_base("unpushed-dangling-verified");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/master",
            ],
        )
        .await;
        assert_unpushed(&repo, 2, UnpushedBasis::OnDefaultBranch, Some("master")).await;
    }

    /// The dangling symref's target has no local branch, so the default doesn't
    /// verify and every commit counts, even though a local master exists.
    #[tokio::test]
    async fn unpushed_count_is_unresolved_when_the_default_does_not_verify() {
        let (_base, base) = temp_base("unpushed-dangling-unverified");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        run(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        )
        .await;
        assert_unpushed(&repo, 2, UnpushedBasis::Unresolved, None).await;
    }

    /// A configured remote nothing was fetched from or pushed to yet.
    async fn add_unfetched_origin(repo: &str) {
        run(repo, &["remote", "add", "origin", "../unfetched.git"]).await;
    }

    /// With a remote configured, the default-branch basis never applies: nothing has
    /// reached that remote, so every commit counts and keeps its arrow.
    #[tokio::test]
    async fn unpushed_count_counts_every_commit_on_the_default_branch_of_an_unfetched_remote() {
        let (_base, base) = temp_base("unpushed-unfetched-default");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        add_unfetched_origin(&repo).await;
        commit_empty(&repo, "three").await;
        assert_unpushed(&repo, 3, UnpushedBasis::Remotes, None).await;
    }

    #[tokio::test]
    async fn unpushed_count_counts_every_commit_on_a_feature_branch_of_an_unfetched_remote() {
        let (_base, base) = temp_base("unpushed-unfetched-feature");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        add_unfetched_origin(&repo).await;
        run(&repo, &["switch", "-q", "-c", "feature"]).await;
        commit_empty(&repo, "f1").await;
        assert_unpushed(&repo, 3, UnpushedBasis::Remotes, None).await;
    }

    /// A dangling remote HEAD beside a configured remote still leaves the remote's
    /// basis in charge, even though its target names a local branch.
    #[tokio::test]
    async fn unpushed_count_keeps_the_remote_basis_behind_a_dangling_head_of_a_configured_remote() {
        let (_base, base) = temp_base("unpushed-unfetched-dangling");
        let repo = base.to_string_lossy().into_owned();
        init_master_repo(&repo).await;
        add_unfetched_origin(&repo).await;
        run(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/master",
            ],
        )
        .await;
        assert_unpushed(&repo, 2, UnpushedBasis::Remotes, None).await;
    }

    #[test]
    fn unpushed_count_wire_shape() {
        let cases = [
            (
                UnpushedBasis::Remotes,
                None,
                Some("abc"),
                r#"{"count":4,"basis":"remotes","defaultBranch":null,"headOid":"abc"}"#,
            ),
            (
                UnpushedBasis::DefaultBranch,
                Some("main"),
                Some("abc"),
                r#"{"count":4,"basis":"default-branch","defaultBranch":"main","headOid":"abc"}"#,
            ),
            (
                UnpushedBasis::OnDefaultBranch,
                Some("main"),
                Some("abc"),
                r#"{"count":4,"basis":"on-default-branch","defaultBranch":"main","headOid":"abc"}"#,
            ),
            (
                UnpushedBasis::Unresolved,
                None,
                Some("abc"),
                r#"{"count":4,"basis":"unresolved","defaultBranch":null,"headOid":"abc"}"#,
            ),
            (
                UnpushedBasis::Unresolved,
                None,
                None,
                r#"{"count":4,"basis":"unresolved","defaultBranch":null,"headOid":null}"#,
            ),
        ];
        for (basis, default, head, want) in cases {
            let json = serde_json::to_string(&UnpushedCount {
                count: 4,
                basis,
                default_branch: default.map(str::to_string),
                head_oid: head.map(str::to_string),
            })
            .unwrap();
            assert_eq!(json, want);
            for snake in [
                "default_branch",
                "on_default_branch",
                "OnDefaultBranch",
                "head_oid",
            ] {
                assert!(!json.contains(snake), "{json}");
            }
        }
    }

    #[tokio::test]
    async fn unpushed_count_errs_outside_a_repository() {
        let (_base, base) = temp_base("unpushed-broken");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        std::fs::rename(base.join(".git"), base.join("git-moved")).unwrap();
        let result = super::git_unpushed_count(repo).await;
        assert!(matches!(result, Err(AppError::Command(_))), "{result:?}");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn update_branch_from_ignored_subdirectory() {
        use crate::git::ignored_guard::tests::{Fixture, Shape};
        let f = Fixture::new(Shape::IgnoredFile, true).await;
        let (_serialized, _override, _root) = holder_marker_root(&f.repo);
        let sub = std::path::Path::new(&f.repo).join("sub");
        std::fs::create_dir(&sub).unwrap();
        let err = update_branch_from(
            &AppState::default(),
            &sub.to_string_lossy(),
            "local",
            "incoming",
            &HashSet::new(),
            None,
        )
        .await
        .unwrap_err();
        f.assert_unchanged(&err).await;
    }

    // --- Keep local flag and the remote-default branch-list field. ---

    /// A repo on an explicitly named `main`, with the identity pinned repo-locally.
    async fn keep_local_repo(tag: &str) -> (tempfile::TempDir, std::path::PathBuf, String) {
        let (guard, base) = temp_base(tag);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q", "-b", "main"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "seed"]).await;
        (guard, base, repo_s)
    }

    fn append_config(repo: &str, text: &str) {
        use std::io::Write;
        let path = std::path::Path::new(repo).join(".git").join("config");
        let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    async fn listed_keep_local(repo: &str, name: &str) -> bool {
        git_branches(repo.to_string())
            .await
            .unwrap()
            .iter()
            .find(|b| b.name == name)
            .unwrap_or_else(|| panic!("{name} listed"))
            .keep_local
    }

    #[test]
    fn keep_local_list_parse_reads_git_bools_and_the_last_entry() {
        use super::parse_branch_flags;
        let key = |name: &str| super::keep_local_key(name).to_ascii_lowercase();
        assert_eq!(
            super::keep_local_key("rel/1.2"),
            "branch.rel/1.2.gitdesktopLocalOnly"
        );
        let marked = ["true", "yes", "on", "1", "TRUE", "maybe"];
        let unmarked = ["false", "no", "off", "0", ""];
        for value in marked {
            let text = format!("{} {value}\n", key("rel/1.2"));
            assert!(
                parse_branch_flags(&text).keep_local.contains("rel/1.2"),
                "{value:?}"
            );
        }
        for value in unmarked {
            let text = format!("{} {value}\n", key("rel/1.2"));
            assert!(parse_branch_flags(&text).keep_local.is_empty(), "{value:?}");
        }
        // A valueless key is git's true.
        assert!(parse_branch_flags(&format!("{}\n", key("x")))
            .keep_local
            .contains("x"));
        // The last entry wins, a junk-first pair included (the named asymmetry: the
        // guard's `--type=bool --get` fails on the junk entry; the list reads `false`).
        for (first, last, expect) in [
            ("true", "false", false),
            ("false", "true", true),
            ("maybe", "true", true),
            ("maybe", "false", false),
        ] {
            let text = format!("{k} {first}\n{k} {last}\n", k = key("x"));
            assert_eq!(
                parse_branch_flags(&text).keep_local.contains("x"),
                expect,
                "{first} then {last}"
            );
        }
        // Archived keeps its literal rule, beside a Keep local entry for another name.
        let text = format!(
            "branch.a.gitdesktoparchived true\nbranch.b.gitdesktoparchived yes\n\
             branch.c.gitdesktoparchived\n{} true\n",
            key("d")
        );
        let flags = parse_branch_flags(&text);
        assert_eq!(flags.archived, HashSet::from(["a".to_string()]));
        assert_eq!(flags.keep_local, HashSet::from(["d".to_string()]));
    }

    /// The guard's read and the list agree on every value git can hold, except the named
    /// junk-first asymmetry, where the read fails closed.
    #[tokio::test]
    async fn keep_local_read_and_list_agree_on_real_config() {
        let (_guard, base, repo_s) = keep_local_repo("keep-local-read").await;
        run(&repo_s, &["branch", "x"]).await;
        let key = super::keep_local_key("x");
        let reset = |repo_s: String, key: String| async move {
            run_git_raw(
                Some(&repo_s),
                &["config", "--unset-all", &key],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
        };

        assert!(
            !super::branch_keep_local(&repo_s, "x").await.unwrap(),
            "unset"
        );
        assert!(!listed_keep_local(&repo_s, "x").await);
        for (values, read, listed) in [
            (&["true"][..], Some(true), true),
            (&["yes"][..], Some(true), true),
            (&["false"][..], Some(false), false),
            (&[""][..], Some(false), false),
            (&["maybe"][..], None, true),
            (&["true", "false"][..], Some(false), false),
            (&["maybe", "true"][..], None, true),
            (&["maybe", "false"][..], None, false),
        ] {
            reset(repo_s.clone(), key.clone()).await;
            for value in values {
                run(&repo_s, &["config", "--add", &key, value]).await;
            }
            let got = super::branch_keep_local(&repo_s, "x").await;
            match read {
                Some(expect) => assert_eq!(got.unwrap(), expect, "{values:?}"),
                None => {
                    let err = got.expect_err("junk fails closed");
                    assert!(
                        err.to_string().contains("bad boolean config value"),
                        "{values:?}: {err}"
                    );
                }
            }
            assert_eq!(listed_keep_local(&repo_s, "x").await, listed, "{values:?}");
        }
        // A valueless key reads true on both.
        reset(repo_s.clone(), key.clone()).await;
        append_config(&repo_s, "[branch \"x\"]\n\tgitdesktopLocalOnly\n");
        assert!(super::branch_keep_local(&repo_s, "x").await.unwrap());
        assert!(listed_keep_local(&repo_s, "x").await);

        // Exact-name match: the subsection is case-sensitive.
        assert!(!super::branch_keep_local(&repo_s, "X").await.unwrap());
        // An invalid key (exit 1 WITH stderr) is an error, not unset.
        super::branch_keep_local(&repo_s, "x\ny")
            .await
            .expect_err("an invalid key is not 'unset'");
        // git exits 1 silently outside a repository; no route can push from one.
        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(
            !super::branch_keep_local(&plain.to_string_lossy(), "x")
                .await
                .expect("a non-repository reads as unmarked, not an error"),
            "a non-repository reads as unmarked"
        );
    }

    /// Exit 1 reads "not set" through trace output on stderr, and fails closed only on
    /// git's own `error:`/`fatal:` line.
    #[test]
    fn keep_local_answer_reads_exit_1_through_trace_lines() {
        let out = |code: i32, stdout: &str, stderr: &str| crate::git::runner::GitOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.to_string(),
            code,
        };
        let trace = "11:32:43.281828 exec-cmd.c:266    trace: resolved executable dir: C:/git\n\
                     11:32:43.283829 git.c:502         trace: built-in: git config --get k\n";
        let invalid = format!("{trace}error: key does not contain a section: k\n");
        for (row, given, expect) in [
            ("true", out(0, "true\n", ""), Some(true)),
            ("false", out(0, "false\n", ""), Some(false)),
            ("unset", out(1, "", ""), Some(false)),
            ("unset under GIT_TRACE", out(1, "", trace), Some(false)),
            (
                "invalid key",
                out(1, "", "error: invalid key (newline): branch.x\ny.k\n"),
                None,
            ),
            ("invalid key under GIT_TRACE", out(1, "", &invalid), None),
            ("exit 1 with stdout", out(1, "true\n", ""), None),
            ("fatal", out(128, "", "fatal: bad boolean value\n"), None),
            ("junk", out(0, "maybe\n", ""), None),
        ] {
            match (super::keep_local_answer(&given), expect) {
                (Ok(got), Some(want)) => assert_eq!(got, want, "{row}"),
                (Err(AppError::Git { .. }), None) => {}
                (got, _) => panic!("{row}: {got:?}"),
            }
        }
    }

    /// The branch list's flag read takes only exit 1 as "no flags" (trace lines on
    /// stderr included); any other failed read fails the list instead of hiding a mark.
    #[test]
    fn branch_flags_answer_reads_only_exit_1_as_empty() {
        let out = |code: i32, stdout: &str, stderr: &str| crate::git::runner::GitOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.to_string(),
            code,
        };
        let trace = "11:32:43.283829 git.c:502         trace: built-in: git config --get-regexp\n";
        let marked = out(0, "branch.x.gitdesktoplocalonly true\n", "");
        let flags = super::branch_flags_answer(&marked).unwrap();
        assert_eq!(
            flags.keep_local,
            std::collections::HashSet::from(["x".to_string()])
        );
        assert!(flags.archived.is_empty());
        for (row, given) in [
            ("no match", out(1, "", "")),
            ("no match under GIT_TRACE", out(1, "", trace)),
        ] {
            let flags =
                super::branch_flags_answer(&given).unwrap_or_else(|e| panic!("{row}: {e:?}"));
            assert!(
                flags.keep_local.is_empty() && flags.archived.is_empty(),
                "{row}"
            );
        }
        for (row, given) in [
            (
                "error",
                out(3, "", "error: could not lock config file .git/config\n"),
            ),
            (
                "fatal",
                out(128, "", "fatal: bad config line 1 in file .git/config\n"),
            ),
            ("invalid regex", out(6, "", "error: invalid pattern\n")),
        ] {
            match super::branch_flags_answer(&given) {
                Err(AppError::Git { code, .. }) => assert_eq!(code, given.code, "{row}"),
                got => panic!("{row}: {got:?}"),
            }
        }
    }

    /// A real read with GIT_TRACE in the spawn's environment still answers the mark.
    #[tokio::test]
    async fn keep_local_read_answers_under_git_trace() {
        let (_guard, _base, repo_s) = keep_local_repo("keep-local-trace").await;
        run(&repo_s, &["branch", "x"]).await;
        for var in ["GIT_TRACE", "GIT_TRACE2", "GIT_TRACE_SETUP"] {
            let envs = [(var, "1")];
            let traced = crate::git::runner::run_git_raw_env(
                Some(&repo_s),
                &["config", "--get", &super::keep_local_key("x")],
                &envs,
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
            assert!(!traced.stderr.trim().is_empty(), "{var} reaches the spawn");
            let unmarked = super::branch_keep_local_env(&repo_s, "x", &envs).await;
            assert!(!unmarked.expect("unmarked under trace"), "{var}");
            super::branch_keep_local_env(&repo_s, "x\ny", &envs)
                .await
                .expect_err("an invalid key still fails closed under trace");
        }
        super::set_branch_keep_local_core(&repo_s, "x", true)
            .await
            .unwrap();
        let envs = [("GIT_TRACE", "1")];
        assert!(super::branch_keep_local_env(&repo_s, "x", &envs)
            .await
            .expect("marked under trace"));
    }

    /// Both directions on the current branch, a branch that is the remote default, and a
    /// dotted name; the read follows each write, and a repeat turn-off stays Ok.
    #[tokio::test]
    async fn keep_local_setter_round_trips_and_the_read_follows() {
        let (_guard, _base, repo_s) = keep_local_repo("keep-local-set").await;
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        run(
            &repo_s,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        )
        .await;
        run(&repo_s, &["branch", "rel/1.2"]).await;
        run(
            &repo_s,
            &["branch", "--set-upstream-to", "origin/main", "main"],
        )
        .await;
        let main = git_branches(repo_s.clone()).await.unwrap();
        let main = main.iter().find(|b| b.name == "main").unwrap();
        assert!(
            main.is_current && main.upstream_is_remote_default,
            "{main:?}"
        );

        for name in ["main", "rel/1.2"] {
            super::set_branch_keep_local_core(&repo_s, name, true)
                .await
                .expect("turn on");
            assert!(super::branch_keep_local(&repo_s, name).await.unwrap());
            assert!(listed_keep_local(&repo_s, name).await);
            for _ in 0..2 {
                super::set_branch_keep_local_core(&repo_s, name, false)
                    .await
                    .expect("turn off, twice");
            }
            assert!(!super::branch_keep_local(&repo_s, name).await.unwrap());
            assert!(!listed_keep_local(&repo_s, name).await);
        }
        // A multi-valued local flag is fully cleared.
        let key = super::keep_local_key("main");
        run(&repo_s, &["config", "--add", &key, "true"]).await;
        run(&repo_s, &["config", "--add", &key, "true"]).await;
        super::set_branch_keep_local_core(&repo_s, "main", false)
            .await
            .expect("clears a multi-valued flag");
        assert!(!super::branch_keep_local(&repo_s, "main").await.unwrap());
        // A doubled local flag turns on too (a plain set exits 5 there), leaving one value.
        run(&repo_s, &["config", "--add", &key, "false"]).await;
        run(&repo_s, &["config", "--add", &key, "false"]).await;
        super::set_branch_keep_local_core(&repo_s, "main", true)
            .await
            .expect("turns on a multi-valued flag");
        assert!(super::branch_keep_local(&repo_s, "main").await.unwrap());
        assert_eq!(
            run(&repo_s, &["config", "--local", "--get-all", &key]).await,
            "true\n"
        );
        // An invalid name never reaches a config key.
        let err = super::set_branch_keep_local_core(&repo_s, "a b", true)
            .await
            .expect_err("invalid name");
        assert!(matches!(err, AppError::InvalidArgument(_)), "{err:?}");
    }

    /// A mark set in an included file survives a local turn-off: the setter says so
    /// and the read still refuses. Twin: a local mark turns off with Ok.
    #[tokio::test]
    async fn keep_local_setter_reports_a_mark_set_in_another_scope() {
        let (_guard, base, repo_s) = keep_local_repo("keep-local-scope-off").await;
        run(&repo_s, &["branch", "x"]).await;
        run(&repo_s, &["branch", "y"]).await;
        let inc = base.join("inc.gitconfig");
        std::fs::write(&inc, "[branch \"x\"]\n\tgitdesktopLocalOnly = true\n").unwrap();
        let inc_s = inc.to_string_lossy().replace('\\', "/");
        run(&repo_s, &["config", "include.path", &inc_s]).await;

        let err = super::set_branch_keep_local_core(&repo_s, "x", false)
            .await
            .expect_err("the included mark still reads marked");
        assert!(
            matches!(&err, AppError::Command(m) if m == "Keep local is still on for x: it is \
                set outside this repository's own Git config (a global, system, worktree or \
                included config file), so GitDesktop can't turn it off here."),
            "{err:?}"
        );
        assert!(super::branch_keep_local(&repo_s, "x").await.unwrap());

        super::set_branch_keep_local_core(&repo_s, "y", true)
            .await
            .unwrap();
        super::set_branch_keep_local_core(&repo_s, "y", false)
            .await
            .expect("a local mark turns off");
        assert!(!super::branch_keep_local(&repo_s, "y").await.unwrap());
    }

    /// An included `false` after the branch's own section outranks a local turn-on: the
    /// setter says so, the write stays, and the read allows. Twin: no include, Ok.
    #[tokio::test]
    async fn keep_local_setter_reports_an_off_set_in_another_scope() {
        let (_guard, base, repo_s) = keep_local_repo("keep-local-scope-on").await;
        run(&repo_s, &["branch", "x"]).await;
        run(&repo_s, &["branch", "y"]).await;
        run(&repo_s, &["config", "branch.x.remote", "origin"]).await;
        let inc = base.join("inc.gitconfig");
        std::fs::write(&inc, "[branch \"x\"]\n\tgitdesktopLocalOnly = false\n").unwrap();
        let inc_s = inc.to_string_lossy().replace('\\', "/");
        run(&repo_s, &["config", "include.path", &inc_s]).await;

        let err = super::set_branch_keep_local_core(&repo_s, "x", true)
            .await
            .expect_err("the included false still reads unmarked");
        assert!(
            matches!(&err, AppError::Command(m) if m == "Keep local is still off for x: another \
                Git config scope sets it off (a worktree or included config file), so \
                GitDesktop can't turn it on here."),
            "{err:?}"
        );
        assert!(!super::branch_keep_local(&repo_s, "x").await.unwrap());
        let local = run_git_raw(
            Some(&repo_s),
            &["config", "--local", "--get", &super::keep_local_key("x")],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_eq!(
            local.stdout_lossy().trim(),
            "true",
            "the local write is kept"
        );

        super::set_branch_keep_local_core(&repo_s, "y", true)
            .await
            .expect("no include: the mark takes");
        assert!(super::branch_keep_local(&repo_s, "y").await.unwrap());
    }

    /// A config lock held through the retry reads as the try-again copy, both ways.
    #[tokio::test]
    async fn keep_local_setter_held_config_lock_reads_try_again() {
        let (_guard, _base, repo_s) = keep_local_repo("keep-local-lock").await;
        let lock = std::path::Path::new(&repo_s)
            .join(".git")
            .join("config.lock");
        std::fs::write(&lock, b"").unwrap();
        for (on, verb) in [(true, "on"), (false, "off")] {
            let err = super::set_branch_keep_local_core(&repo_s, "main", on)
                .await
                .expect_err("a held lock refuses");
            assert!(
                matches!(&err, AppError::Command(m) if *m == format!(
                    "Another Git process was saving this repository's settings, so Keep \
                     local wasn't turned {verb} for main — try again."
                )),
                "{err:?}"
            );
        }
        std::fs::remove_file(&lock).unwrap();
    }

    /// git moves the whole `branch.<name>` section on rename and drops it on delete.
    #[tokio::test]
    async fn keep_local_flag_follows_rename_and_delete() {
        let (_guard, _base, repo_s) = keep_local_repo("keep-local-rename").await;
        run(&repo_s, &["branch", "old"]).await;
        super::set_branch_keep_local_core(&repo_s, "old", true)
            .await
            .unwrap();
        run(&repo_s, &["branch", "-m", "--", "old", "new"]).await;
        assert_eq!(branch_section(&repo_s, "old").await, "");
        let moved = branch_section(&repo_s, "new").await;
        assert!(moved.contains("gitdesktoplocalonly true"), "{moved}");
        assert!(super::branch_keep_local(&repo_s, "new").await.unwrap());
        run(&repo_s, &["branch", "-D", "--", "new"]).await;
        assert_eq!(branch_section(&repo_s, "new").await, "");
        assert!(!super::branch_keep_local(&repo_s, "new").await.unwrap());
    }

    #[test]
    fn keep_local_branch_serializes_camel_case_fields() {
        let branch = crate::git::types::Branch {
            name: "x".into(),
            is_current: false,
            upstream: None,
            last_commit_date: String::new(),
            archived: false,
            upstream_ahead: 0,
            upstream_behind: 0,
            upstream_gone: false,
            upstream_remote: None,
            upstream_remote_ref: None,
            keep_local: true,
            upstream_is_remote_default: true,
            renamed_from_upstream: true,
            named_push_remote: Some("origin".into()),
            named_push_branch: Some("x".into()),
            named_push_refused: true,
        };
        let value = serde_json::to_value(&branch).unwrap();
        for (key, expected) in [
            ("renamedFromUpstream", serde_json::json!(true)),
            ("namedPushRemote", serde_json::json!("origin")),
            ("namedPushBranch", serde_json::json!("x")),
            ("namedPushRefused", serde_json::json!(true)),
        ] {
            assert_eq!(value.get(key), Some(&expected), "{key}");
        }
        for snake in [
            "renamed_from_upstream",
            "named_push_remote",
            "named_push_branch",
            "named_push_refused",
        ] {
            assert!(value.get(snake).is_none(), "{snake}");
        }
        let object = value.as_object().unwrap();
        assert_eq!(object.get("keepLocal"), Some(&serde_json::json!(true)));
        assert_eq!(
            object.get("upstreamIsRemoteDefault"),
            Some(&serde_json::json!(true))
        );
        assert!(!object.contains_key("keep_local"));
        assert!(!object.contains_key("upstream_is_remote_default"));
    }

    /// Every remote-default shape, from the one list spawn: default, non-default, a
    /// slash-named remote, no HEAD symref, a dangling one, gone, local `.`, a non-branch
    /// upstream, untracked; a remote branch named `feat/HEAD` and the remote HEAD rows
    /// never become branch rows.
    #[tokio::test]
    async fn remote_default_flag_matches_each_probe_row() {
        let (_guard, _base, repo_s) = keep_local_repo("remote-default").await;
        for remote in ["origin", "team/fork", "nohead", "dangle"] {
            run(&repo_s, &["remote", "add", remote, &repo_s]).await;
        }
        for tracking in [
            "refs/remotes/origin/main",
            "refs/remotes/origin/dev",
            "refs/remotes/origin/feat/HEAD",
            "refs/remotes/team/fork/trunk",
            "refs/remotes/nohead/main",
        ] {
            run(&repo_s, &["update-ref", tracking, "HEAD"]).await;
        }
        for (head, target) in [
            ("refs/remotes/origin/HEAD", "refs/remotes/origin/main"),
            (
                "refs/remotes/team/fork/HEAD",
                "refs/remotes/team/fork/trunk",
            ),
            ("refs/remotes/dangle/HEAD", "refs/remotes/dangle/gone"),
        ] {
            run(&repo_s, &["symbolic-ref", head, target]).await;
        }
        let rows = [
            ("on-default", Some(("origin", "refs/heads/main")), true),
            ("on-dev", Some(("origin", "refs/heads/dev")), false),
            ("slash", Some(("team/fork", "refs/heads/trunk")), true),
            ("gone-b", Some(("origin", "refs/heads/deleted")), false),
            ("nohead-b", Some(("nohead", "refs/heads/main")), false),
            ("dangle-b", Some(("dangle", "refs/heads/gone")), false),
            ("local-up", Some((".", "refs/heads/main")), false),
            ("pr-b", Some(("origin", "refs/pull/1/head")), false),
            ("untracked", None, false),
        ];
        for (name, upstream, _) in rows {
            run(&repo_s, &["branch", name]).await;
            if let Some((remote, merge)) = upstream {
                run(
                    &repo_s,
                    &["config", &format!("branch.{name}.remote"), remote],
                )
                .await;
                run(&repo_s, &["config", &format!("branch.{name}.merge"), merge]).await;
            }
        }

        let branches = git_branches(repo_s.clone()).await.unwrap();
        let mut names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        names.sort_unstable();
        let mut expected: Vec<&str> = rows.iter().map(|(n, _, _)| *n).collect();
        expected.push("main");
        expected.sort_unstable();
        assert_eq!(names, expected, "only refs/heads rows");
        for (name, _, default) in rows {
            let row = branches.iter().find(|b| b.name == name).unwrap();
            assert_eq!(row.upstream_is_remote_default, default, "{row:?}");
        }
        assert!(
            branches
                .iter()
                .find(|b| b.name == "gone-b")
                .unwrap()
                .upstream_gone
        );

        // No remotes at all: nothing is a remote default.
        let (_guard2, _base2, bare_s) = keep_local_repo("remote-default-none").await;
        let only = git_branches(bare_s).await.unwrap();
        assert_eq!(only.len(), 1);
        assert!(!only[0].upstream_is_remote_default && !only[0].keep_local);
    }

    /// The new-name refusal for `Feat` beside the stored `feat`.
    const NEW_NAME_TWIN_REFUSAL: &str = "Feat differs from the existing branch feat only in \
        letter case, which this disk can't keep apart. Use a different name, or rename feat \
        first.";

    /// Whether `repo`'s refs alias, read by git alone: a fresh LOOSE `oracle-loose` read as
    /// `ORACLE-LOOSE` (a packed-only twin under test can't be read that way), asserted equal
    /// to [`super::refs_can_alias`] before a test branches on it. Call it after any
    /// `pack-refs` the fixture runs and before any the test runs later.
    async fn case_twin_alias_oracle(repo: &str) -> bool {
        run(repo, &["branch", "oracle-loose"]).await;
        let observed = is_aliased(repo, "ORACLE-LOOSE").await;
        assert_eq!(
            super::refs_can_alias(repo).await,
            observed,
            "the alias verdict matches git's own reads"
        );
        observed
    }

    /// Every stored branch name, read with raw git.
    async fn case_twin_listed(repo: &str) -> Vec<String> {
        run(
            repo,
            &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        )
        .await
        .lines()
        .filter_map(|line| line.strip_prefix("refs/heads/"))
        .map(str::to_string)
        .collect()
    }

    /// HEAD's symbolic ref (or detached sha) and the local config, which a refused mint
    /// must leave as they were.
    async fn case_twin_snapshot(repo: &str) -> (Option<String>, Option<String>, String) {
        let config = run(repo, &["config", "--list", "--local"]).await;
        (
            symbolic_head(repo).await,
            full_ref_tip(repo, "HEAD").await,
            config,
        )
    }

    #[test]
    fn case_twin_of_skips_the_exact_name_and_the_renamed_branch() {
        // Stored names, the new name, the branch a rename moves off, the expected twin.
        type Row<'a> = (&'a [&'a str], &'a str, Option<&'a str>, Option<&'a str>);
        let rows: [Row; 9] = [
            (&["feat"], "feat", None, None),
            (&["main", "feat"], "Feat", None, Some("feat")),
            (&["feat"], "Feat", Some("feat"), None),
            (&["feat", "FEAT"], "Feat", Some("feat"), Some("FEAT")),
            (&["chore/z"], "Chore/z", None, Some("chore/z")),
            (&["é/z"], "É/z", None, Some("é/z")),
            (&["aσ"], "AΣ", None, Some("aσ")),
            (&["feat", "aς"], "fear", None, None),
            (&["feat", "Feat"], "Feat", None, None),
        ];
        for (stored, name, replaces, twin) in rows {
            let stored: Vec<String> = stored.iter().map(|s| s.to_string()).collect();
            assert_eq!(
                super::case_twin_of(&stored, name, replaces),
                twin,
                "{stored:?} {name} {replaces:?}"
            );
        }
        let refusal = super::new_name_twin_refusal("Feat", "feat");
        assert!(
            matches!(&refusal, AppError::Command(m) if m == NEW_NAME_TWIN_REFUSAL),
            "{refusal:?}"
        );
    }

    /// How a test stores the twin `feat`.
    #[derive(Clone, Copy, Debug)]
    enum TwinStorage {
        PackedOnly,
        Loose,
        LooseAndPacked,
    }

    /// A repository on the files backend holding `feat` stored as `storage`, and the
    /// alias oracle's verdict.
    async fn case_twin_fixture(
        tag: &str,
        storage: TwinStorage,
    ) -> (tempfile::TempDir, String, bool) {
        let (g, base) = temp_base(tag);
        let base = base.join("repo");
        std::fs::create_dir_all(&base).unwrap();
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["branch", "feat"]).await;
        match storage {
            TwinStorage::PackedOnly => {
                run(&repo, &["pack-refs", "--all"]).await;
            }
            TwinStorage::Loose => {}
            TwinStorage::LooseAndPacked => {
                run(&repo, &["pack-refs", "--all"]).await;
                // A moved tip, since git skips writing a loose ref that already has its value.
                commit_file(&repo, "s.txt", "second\n").await;
                run(&repo, &["update-ref", "refs/heads/feat", "HEAD"]).await;
                let loose = base.join(".git").join("refs").join("heads").join("feat");
                assert!(loose.is_file(), "fixture sanity: feat is loose too");
            }
        }
        let aliases = case_twin_alias_oracle(&repo).await;
        (g, repo, aliases)
    }

    /// Creating `Feat` beside `feat` in each `(checkout, no_track)` arm: refused before git
    /// where refs alias, leaving HEAD, the branches and the config as they were; created
    /// beside `feat` where they don't.
    async fn create_beside_case_twin(storage: TwinStorage) {
        for (checkout, no_track) in [(false, false), (false, true), (true, false), (true, true)] {
            let (_g, repo, aliases) = case_twin_fixture("create-case-twin", storage).await;
            let before = case_twin_snapshot(&repo).await;
            let row = format!("{storage:?} checkout={checkout} no_track={no_track}");
            let result = git_create_branch_core(
                &AppState::default(),
                repo.clone(),
                "Feat".into(),
                checkout,
                None,
                no_track,
            )
            .await;
            let listed = case_twin_listed(&repo).await;
            if aliases {
                assert!(
                    matches!(&result, Err(AppError::Command(m)) if m == NEW_NAME_TWIN_REFUSAL),
                    "{row}: {result:?}"
                );
                assert!(!listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert!(listed.iter().any(|b| b == "feat"), "{row}: {listed:?}");
                assert_eq!(case_twin_snapshot(&repo).await, before, "{row}");
            } else {
                result.unwrap_or_else(|e| panic!("{row}: {e:?}"));
                assert!(listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert!(listed.iter().any(|b| b == "feat"), "{row}: {listed:?}");
            }
        }
    }

    #[tokio::test]
    async fn create_refuses_a_case_twin_of_a_packed_only_branch() {
        create_beside_case_twin(TwinStorage::PackedOnly).await;
    }

    #[tokio::test]
    async fn create_refuses_a_case_twin_of_a_loose_branch() {
        create_beside_case_twin(TwinStorage::Loose).await;
    }

    #[tokio::test]
    async fn create_refuses_a_case_twin_of_a_loose_and_packed_branch() {
        create_beside_case_twin(TwinStorage::LooseAndPacked).await;
    }

    /// `@{-1}` names the previous branch, which git expands into the name it mints, so a
    /// deleted `Feat` would come back beside a packed `feat` under a spelling the twin check
    /// never compared. Create and rename refuse it as a branch name, on every disk.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn create_and_rename_refuse_a_previous_branch_expression_as_the_new_name() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        for rename in [false, true] {
            let (_g, base) = temp_base("previous-branch-new-name");
            let repo = base.to_string_lossy().into_owned();
            init_repo(&repo, "r.txt").await;
            let home = run(&repo, &["branch", "--show-current"])
                .await
                .trim()
                .to_string();
            run(&repo, &["switch", "-c", "Feat"]).await;
            run(&repo, &["switch", &home]).await;
            run(&repo, &["branch", "-D", "Feat"]).await;
            run(&repo, &["branch", "feat"]).await;
            run(&repo, &["pack-refs", "--all"]).await;
            let expanded = run(&repo, &["check-ref-format", "--branch", "@{-1}"]).await;
            assert_eq!(
                expanded.trim(),
                "Feat",
                "fixture sanity: git expands @{{-1}}"
            );
            let before = case_twin_snapshot(&repo).await;
            let state = AppState::default();
            let result = if rename {
                git_rename_branch_core(&state, repo.clone(), home.clone(), "@{-1}".into())
                    .await
                    .map(drop)
            } else {
                git_create_branch_core(&state, repo.clone(), "@{-1}".into(), false, None, false)
                    .await
            };
            assert!(
                matches!(&result, Err(AppError::InvalidArgument(m))
                    if m == "invalid branch name: @{-1}"),
                "rename={rename}: {result:?}"
            );
            let listed = case_twin_listed(&repo).await;
            assert!(
                !listed.iter().any(|b| b == "Feat"),
                "rename={rename}: {listed:?}"
            );
            assert!(
                listed.iter().any(|b| b == "feat"),
                "rename={rename}: {listed:?}"
            );
            assert!(listed.contains(&home), "rename={rename}: {listed:?}");
            assert_eq!(case_twin_snapshot(&repo).await, before, "rename={rename}");
        }
    }

    /// git stores a branch literally named `@` and `branch -m` moves it by that name, so
    /// the rename takes it as its old name end to end, HEAD left on its own branch.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn rename_moves_a_branch_literally_named_at() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_g, base) = temp_base("rename-literal-at");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        let head = symbolic_head(&repo).await;
        run(&repo, &["update-ref", "refs/heads/@", "HEAD"]).await;
        let result =
            git_rename_branch_core(&AppState::default(), repo.clone(), "@".into(), "at".into())
                .await;
        assert!(result.is_ok(), "{result:?}");
        let listed = case_twin_listed(&repo).await;
        assert!(listed.iter().any(|b| b == "at"), "{listed:?}");
        assert!(!listed.iter().any(|b| b == "@"), "{listed:?}");
        assert_eq!(symbolic_head(&repo).await, head);
    }

    /// `@{-1}` as the old name names the previous branch, which git would rename: refused
    /// as a branch name, that branch where it was.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn rename_refuses_a_previous_branch_expression_as_the_old_name() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_g, base) = temp_base("rename-previous-old-name");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        let home = run(&repo, &["branch", "--show-current"])
            .await
            .trim()
            .to_string();
        run(&repo, &["switch", "-c", "prev-old"]).await;
        run(&repo, &["switch", &home]).await;
        let before = case_twin_snapshot(&repo).await;
        let result = git_rename_branch_core(
            &AppState::default(),
            repo.clone(),
            "@{-1}".into(),
            "prev-new".into(),
        )
        .await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(m))
                if m == "invalid branch name: @{-1}"),
            "{result:?}"
        );
        let listed = case_twin_listed(&repo).await;
        assert!(listed.iter().any(|b| b == "prev-old"), "{listed:?}");
        assert!(!listed.iter().any(|b| b == "prev-new"), "{listed:?}");
        assert_eq!(case_twin_snapshot(&repo).await, before);
    }

    /// A name stored byte-exactly keeps git's own "already exists", alone and in a
    /// repository that already holds its twin, on every disk.
    #[tokio::test]
    async fn create_of_an_existing_name_keeps_gits_answer_beside_a_case_twin() {
        for twin_too in [false, true] {
            for no_track in [false, true] {
                let (_g, base) = temp_base("create-existing-case-twin");
                let repo = base.to_string_lossy().into_owned();
                init_repo(&repo, "r.txt").await;
                let name = if twin_too {
                    run(&repo, &["branch", "feat"]).await;
                    run(&repo, &["pack-refs", "--all"]).await;
                    // Beside a packed-only `feat` git mints the twin itself.
                    run(&repo, &["branch", "Feat"]).await;
                    "Feat"
                } else {
                    run(&repo, &["branch", "feat"]).await;
                    "feat"
                };
                let row = format!("twin_too={twin_too} no_track={no_track}");
                let result = git_create_branch_core(
                    &AppState::default(),
                    repo.clone(),
                    name.into(),
                    false,
                    None,
                    no_track,
                )
                .await;
                assert!(
                    matches!(&result, Err(AppError::Git { stderr, .. })
                        if stderr.contains("already exists") && !stderr.contains("letter case")),
                    "{row}: {result:?}"
                );
            }
        }
    }

    /// A reftable repository keeps `Feat` and `feat` apart on any disk, so the create
    /// succeeds. Returns early when this git can't create a reftable repository.
    #[tokio::test]
    async fn create_beside_a_case_twin_in_a_reftable_repository_succeeds() {
        let (_g, base) = temp_base("reftable-case-twin");
        let repo = base.to_string_lossy().into_owned();
        let init = run_git_raw(
            Some(&repo),
            &["init", "-q", "--ref-format=reftable"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        if init.code != 0 {
            eprintln!("note: this git can't create a reftable repo; skipping");
            return;
        }
        run(&repo, &["config", "user.email", "t@t.local"]).await;
        run(&repo, &["config", "user.name", "T"]).await;
        commit_file(&repo, "a.txt", "seed\n").await;
        run(&repo, &["branch", "feat"]).await;
        assert!(!super::refs_can_alias(&repo).await);
        git_create_branch_core(
            &AppState::default(),
            repo.clone(),
            "Feat".into(),
            false,
            None,
            false,
        )
        .await
        .expect("the reftable create succeeds");
        let listed = case_twin_listed(&repo).await;
        assert!(listed.iter().any(|b| b == "Feat"), "{listed:?}");
        assert!(listed.iter().any(|b| b == "feat"), "{listed:?}");
    }

    /// A twin minted while a create waits on the config-write mutex is refused there; the
    /// `--no-track` arm waits on the mutex too.
    #[tokio::test]
    async fn create_refuses_a_case_twin_minted_during_the_mutex_wait() {
        for no_track in [true, false] {
            let (_g, base) = temp_base("create-case-twin-mutex");
            let repo = base.to_string_lossy().into_owned();
            init_repo(&repo, "r.txt").await;
            let aliases = case_twin_alias_oracle(&repo).await;
            let (holder, release) = hold_config_mutex(&repo).await;
            let (events, waiting) = on_first_waiting();
            let create = tokio::spawn({
                let repo = repo.clone();
                CONFIG_WRITE_LOCK_EVENTS.scope(events, async move {
                    git_create_branch_core(
                        &AppState::default(),
                        repo,
                        "Feat".into(),
                        false,
                        None,
                        no_track,
                    )
                    .await
                })
            });
            waiting
                .await
                .unwrap_or_else(|_| panic!("no_track={no_track}: the create reached the mutex"));
            run(&repo, &["branch", "feat"]).await;
            run(&repo, &["pack-refs", "--all"]).await;
            release.send(()).unwrap();
            holder.await.unwrap();
            let result = tokio::time::timeout(TEST_GIT_HANG_GUARD, create)
                .await
                .expect("the create finishes once released")
                .unwrap();
            let listed = case_twin_listed(&repo).await;
            if aliases {
                assert!(
                    matches!(&result, Err(AppError::Command(m)) if m == NEW_NAME_TWIN_REFUSAL),
                    "no_track={no_track}: {result:?}"
                );
                assert!(!listed.iter().any(|b| b == "Feat"), "{listed:?}");
            } else {
                result.unwrap_or_else(|e| panic!("no_track={no_track}: {e:?}"));
                assert!(listed.iter().any(|b| b == "Feat"), "{listed:?}");
            }
        }
    }

    /// Renaming `ctw-src` onto `CTW-dst` beside the packed-only `ctw-dst`, the twin minted
    /// up front or while the rename waits on the config-write mutex: refused where refs
    /// alias with both branches where they were, renamed where they don't.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn rename_refuses_a_case_twin_of_another_branch() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let expected = "CTW-dst differs from the existing branch ctw-dst only in letter case, \
            which this disk can't keep apart. Use a different name, or rename ctw-dst first.";
        for during_wait in [false, true] {
            let (_g, base) = temp_base("rename-case-twin");
            let repo = base.to_string_lossy().into_owned();
            init_repo(&repo, "r.txt").await;
            // Branch names no other test uses: the marker root override is process-wide.
            run(&repo, &["branch", "ctw-src"]).await;
            let mint = |repo: String| async move {
                run(&repo, &["branch", "ctw-dst"]).await;
                run(&repo, &["pack-refs", "--all"]).await;
            };
            if !during_wait {
                mint(repo.clone()).await;
            }
            let aliases = case_twin_alias_oracle(&repo).await;
            let rename = |repo: String| async move {
                git_rename_branch_core(
                    &AppState::default(),
                    repo,
                    "ctw-src".into(),
                    "CTW-dst".into(),
                )
                .await
            };
            let result = if during_wait {
                let (holder, release) = hold_config_mutex(&repo).await;
                let (events, waiting) = on_first_waiting();
                let task =
                    tokio::spawn(CONFIG_WRITE_LOCK_EVENTS.scope(events, rename(repo.clone())));
                waiting.await.expect("the rename reached the mutex");
                mint(repo.clone()).await;
                release.send(()).unwrap();
                holder.await.unwrap();
                tokio::time::timeout(TEST_GIT_HANG_GUARD, task)
                    .await
                    .expect("the rename finishes once released")
                    .unwrap()
            } else {
                rename(repo.clone()).await
            };
            let listed = case_twin_listed(&repo).await;
            let row = format!("during_wait={during_wait}: {listed:?}");
            assert!(listed.iter().any(|b| b == "ctw-dst"), "{row}");
            if aliases {
                assert!(
                    matches!(&result, Err(AppError::Command(m)) if m == expected),
                    "{row}: {result:?}"
                );
                assert!(listed.iter().any(|b| b == "ctw-src"), "{row}");
                assert!(!listed.iter().any(|b| b == "CTW-dst"), "{row}");
            } else {
                result.unwrap_or_else(|e| panic!("{row}: {e:?}"));
                assert!(!listed.iter().any(|b| b == "ctw-src"), "{row}");
                assert!(listed.iter().any(|b| b == "CTW-dst"), "{row}");
            }
        }
    }

    /// A case-only rename of a packed branch whose exact new spelling is minted while it
    /// waits on the config-write mutex is refused, with the minted branch where it was.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_case_only_rename_keeps_a_new_spelling_minted_during_its_wait() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_g, base) = temp_base("rename-case-minted");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        // Branch names no other test uses: the marker root override is process-wide.
        run(&repo, &["branch", "cmw-topic"]).await;
        run(&repo, &["pack-refs", "--all"]).await;
        commit_file(&repo, "b.txt", "next\n").await;
        let minted = full_ref_tip(&repo, "HEAD").await.unwrap();
        let (holder, release) = hold_config_mutex(&repo).await;
        let (events, waiting) = on_first_waiting();
        let renamed = repo.clone();
        let rename = async move {
            let state = AppState::default();
            git_rename_branch_core(&state, renamed, "cmw-topic".into(), "Cmw-topic".into()).await
        };
        let task = tokio::spawn(CONFIG_WRITE_LOCK_EVENTS.scope(events, rename));
        waiting.await.expect("the rename reached the mutex");
        run(&repo, &["update-ref", "refs/heads/Cmw-topic", &minted]).await;
        release.send(()).unwrap();
        holder.await.unwrap();
        let result = tokio::time::timeout(TEST_GIT_HANG_GUARD, task)
            .await
            .expect("the rename finishes once released")
            .unwrap();
        assert!(result.is_err(), "{result:?}");
        let tip = full_ref_tip(&repo, "refs/heads/Cmw-topic").await;
        assert_eq!(tip, Some(minted), "the minted branch kept its tip");
    }

    /// Renaming a branch to its own case variant is never a twin refusal: packed or loose,
    /// checked out or not, it succeeds and only the new spelling is stored.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn rename_to_its_own_case_variant_is_not_a_case_twin() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        for packed in [true, false] {
            for checked_out in [false, true] {
                let (_g, base) = temp_base("rename-own-case-twin");
                let repo = base.to_string_lossy().into_owned();
                init_repo(&repo, "r.txt").await;
                // Branch names no other test uses: the marker root override is process-wide.
                run(&repo, &["branch", "ctself-a"]).await;
                if packed {
                    run(&repo, &["pack-refs", "--all"]).await;
                }
                if checked_out {
                    run(&repo, &["switch", "-q", "ctself-a"]).await;
                }
                let result = git_rename_branch_core(
                    &AppState::default(),
                    repo.clone(),
                    "ctself-a".into(),
                    "CTSELF-a".into(),
                )
                .await;
                let listed = case_twin_listed(&repo).await;
                let ours: Vec<&str> = listed
                    .iter()
                    .map(String::as_str)
                    .filter(|b| *b == "ctself-a" || *b == "CTSELF-a")
                    .collect();
                let row =
                    format!("packed={packed} checked_out={checked_out}: {result:?} {listed:?}");
                assert!(result.is_ok(), "{row}");
                assert_eq!(ours, vec!["CTSELF-a"], "{row}");
                if checked_out {
                    let head = symbolic_head(&repo).await;
                    let on = head.as_deref().and_then(|h| h.strip_prefix("refs/heads/"));
                    assert_eq!(on, Some("CTSELF-a"), "{row}");
                }
            }
        }
    }

    /// The entries of `.git/<dir>` read from the disk, so a test sees which spelling git
    /// wrote rather than the one a folding disk resolves.
    fn disk_names(repo: &str, dir: &str) -> Vec<String> {
        std::fs::read_dir(std::path::Path::new(repo).join(".git").join(dir))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect()
    }

    /// Renaming the loose `lcase-topic` (an upstream set, two reflog entries) to
    /// `Lcase-topic` succeeds on every disk: the exact listing, the ref and reflog files
    /// and the settings carry the new spelling, and the reflog keeps its history.
    async fn case_only_rename_moves_a_loose_branch(checked_out: bool) {
        let (_g, base) = temp_base("rename-case-only");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["config", "core.logAllRefUpdates", "true"]).await;
        // Branch names no other test uses: the marker root override is process-wide.
        run(&repo, &["branch", "lcase-topic"]).await;
        let tree = "HEAD^{tree}";
        let next = run(&repo, &["commit-tree", tree, "-p", "HEAD", "-m", "next"]).await;
        let msg = "second entry";
        let target = next.trim();
        run(
            &repo,
            &["update-ref", "-m", msg, "refs/heads/lcase-topic", target],
        )
        .await;
        run(&repo, &["config", "branch.lcase-topic.remote", "origin"]).await;
        let merge = "refs/heads/lcase-topic";
        run(&repo, &["config", "branch.lcase-topic.merge", merge]).await;
        if checked_out {
            run(&repo, &["switch", "-q", "lcase-topic"]).await;
        }
        let aliases = case_twin_alias_oracle(&repo).await;
        let row = format!("checked_out={checked_out} aliases={aliases}");
        let mode = super::rename_mode(&repo, "lcase-topic", "Lcase-topic").await;
        let expected = if aliases { "-M" } else { "-m" };
        assert_eq!(mode.unwrap(), expected, "{row}");
        let result = git_rename_branch_core(
            &AppState::default(),
            repo.clone(),
            "lcase-topic".into(),
            "Lcase-topic".into(),
        )
        .await;
        assert!(result.is_ok(), "{row}: {result:?}");
        let listed = case_twin_listed(&repo).await;
        assert!(
            listed.iter().any(|b| b == "Lcase-topic"),
            "{row}: {listed:?}"
        );
        assert!(
            !listed.iter().any(|b| b == "lcase-topic"),
            "{row}: {listed:?}"
        );
        for dir in ["refs/heads", "logs/refs/heads"] {
            let names = disk_names(&repo, dir);
            assert!(
                names.iter().any(|n| n == "Lcase-topic"),
                "{row} {dir}: {names:?}"
            );
            assert!(
                !names.iter().any(|n| n == "lcase-topic"),
                "{row} {dir}: {names:?}"
            );
        }
        assert_eq!(
            run(&repo, &["config", "branch.Lcase-topic.remote"])
                .await
                .trim(),
            "origin",
            "{row}"
        );
        assert_eq!(
            run(&repo, &["config", "branch.Lcase-topic.merge"])
                .await
                .trim(),
            merge,
            "{row}"
        );
        assert_eq!(branch_section(&repo, "lcase-topic").await, "", "{row}");
        let reflog = run(
            &repo,
            &["reflog", "show", "--format=%gs", "refs/heads/Lcase-topic"],
        )
        .await;
        assert!(reflog.lines().any(|l| l == msg), "{row}: {reflog}");
        assert!(
            reflog
                .lines()
                .any(|l| l.starts_with("branch: Created from")),
            "{row}: {reflog}"
        );
        if checked_out {
            let head = symbolic_head(&repo).await;
            assert_eq!(head.as_deref(), Some("refs/heads/Lcase-topic"), "{row}");
        }
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn case_only_rename_moves_a_loose_branch_not_checked_out() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        case_only_rename_moves_a_loose_branch(false).await;
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn case_only_rename_moves_a_loose_branch_checked_out() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        case_only_rename_moves_a_loose_branch(true).await;
    }

    /// Renaming the loose `lcase-twin` (at `next`) to `Lcase-twin`, a packed branch of its
    /// own (at the seed): git refuses as the name exists, on every disk (where refs alias the
    /// two share one loose spelling), and both refs stay where they were. The refs are
    /// asserted before the verdict, so a replace shows as the move it made.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn case_only_rename_onto_a_real_twin_is_refused() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_g, base) = temp_base("rename-case-only-twin");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        let seed = full_ref_tip(&repo, "HEAD").await.unwrap();
        run(&repo, &["update-ref", "refs/heads/Lcase-twin", &seed]).await;
        run(&repo, &["pack-refs", "--all"]).await;
        let next = run(
            &repo,
            &["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "n"],
        )
        .await;
        let next = next.trim().to_string();
        run(&repo, &["update-ref", "refs/heads/lcase-twin", &next]).await;
        let aliases = case_twin_alias_oracle(&repo).await;
        let pairs = || async {
            run(
                &repo,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads/",
                ],
            )
            .await
        };
        let before = pairs().await;
        assert!(
            before.contains(&format!("refs/heads/Lcase-twin {seed}")),
            "{before}"
        );
        assert!(
            before.contains(&format!("refs/heads/lcase-twin {next}")),
            "{before}"
        );
        let result = git_rename_branch_core(
            &AppState::default(),
            repo.clone(),
            "lcase-twin".into(),
            "Lcase-twin".into(),
        )
        .await;
        assert_eq!(pairs().await, before, "aliases={aliases}");
        assert!(
            matches!(&result, Err(AppError::Git { stderr, .. })
                if stderr.contains("a branch named 'Lcase-twin' already exists")),
            "aliases={aliases}: {result:?}"
        );
    }

    /// A repository with the loose `<dir>/leaf` (upstream set) beside the sibling
    /// `<dir>/other`, and the alias oracle's verdict.
    async fn case_dir_fixture(tag: &str, dir: &str) -> (tempfile::TempDir, String, bool) {
        let (g, base) = temp_base(tag);
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        // Branch names no other test uses: the marker root override is process-wide.
        let leaf = format!("{dir}/leaf");
        run(&repo, &["branch", &leaf]).await;
        run(&repo, &["branch", &format!("{dir}/other")]).await;
        run(
            &repo,
            &["config", &format!("branch.{leaf}.remote"), "origin"],
        )
        .await;
        let merge = super::branch_full_ref(&leaf).unwrap();
        run(&repo, &["config", &format!("branch.{leaf}.merge"), &merge]).await;
        let aliases = case_twin_alias_oracle(&repo).await;
        (g, repo, aliases)
    }

    /// Every branch with its object id, read with raw git.
    async fn branch_pairs(repo: &str) -> String {
        run(
            repo,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads/",
            ],
        )
        .await
    }

    /// A case change in the DIRECTORY part (`Xcdir/leaf` to `xcdir/leaf`, a sibling in the
    /// folder) keeps `-m` on every store, since the disk keeps the shared folder's spelling:
    /// refused with git's "already exists" where refs alias, refs and settings untouched;
    /// renamed where they can't.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn case_only_rename_of_a_directory_part_keeps_the_plain_move() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_g, repo, aliases) = case_dir_fixture("rename-case-dir", "Xcdir").await;
        let mode = super::rename_mode(&repo, "Xcdir/leaf", "xcdir/leaf").await;
        assert_eq!(mode.unwrap(), "-m", "aliases={aliases}");
        let (before, section) = (
            branch_pairs(&repo).await,
            branch_section(&repo, "Xcdir/leaf").await,
        );
        let result = git_rename_branch_core(
            &AppState::default(),
            repo.clone(),
            "Xcdir/leaf".into(),
            "xcdir/leaf".into(),
        )
        .await;
        let listed = case_twin_listed(&repo).await;
        let row = format!("aliases={aliases}: {result:?} {listed:?}");
        if aliases {
            assert_eq!(branch_pairs(&repo).await, before, "{row}");
            assert_eq!(branch_section(&repo, "Xcdir/leaf").await, section, "{row}");
            assert_eq!(branch_section(&repo, "xcdir/leaf").await, "", "{row}");
            assert!(
                matches!(&result, Err(AppError::Git { stderr, .. })
                    if stderr.contains("a branch named 'xcdir/leaf' already exists")),
                "{row}"
            );
        } else {
            assert!(result.is_ok(), "{row}");
            assert!(listed.iter().any(|b| b == "xcdir/leaf"), "{row}");
            assert!(!listed.iter().any(|b| b == "Xcdir/leaf"), "{row}");
        }
    }

    /// A case change in the last part only (`Xldir/leaf` to `Xldir/LEAF`, a sibling in the
    /// folder) takes `-M` where refs alias and succeeds: the new spelling is listed, the
    /// sibling untouched, the settings moved.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn case_only_rename_of_the_last_part_beside_a_sibling_moves_the_branch() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_g, repo, aliases) = case_dir_fixture("rename-case-leaf", "Xldir").await;
        let mode = super::rename_mode(&repo, "Xldir/leaf", "Xldir/LEAF").await;
        let expected = if aliases { "-M" } else { "-m" };
        assert_eq!(mode.unwrap(), expected, "aliases={aliases}");
        let sibling = full_ref_tip(&repo, "refs/heads/Xldir/other").await;
        let result = git_rename_branch_core(
            &AppState::default(),
            repo.clone(),
            "Xldir/leaf".into(),
            "Xldir/LEAF".into(),
        )
        .await;
        let listed = case_twin_listed(&repo).await;
        let row = format!("aliases={aliases}: {result:?} {listed:?}");
        assert!(result.is_ok(), "{row}");
        assert!(listed.iter().any(|b| b == "Xldir/LEAF"), "{row}");
        assert!(!listed.iter().any(|b| b == "Xldir/leaf"), "{row}");
        assert!(listed.iter().any(|b| b == "Xldir/other"), "{row}");
        let after = full_ref_tip(&repo, "refs/heads/Xldir/other").await;
        assert_eq!(after, sibling, "{row}");
        assert_eq!(branch_section(&repo, "Xldir/leaf").await, "", "{row}");
        let moved = branch_section(&repo, "Xldir/LEAF").await;
        assert!(moved.contains(".remote origin"), "{row}: {moved}");
        assert!(
            moved.contains(".merge refs/heads/Xldir/leaf"),
            "{row}: {moved}"
        );
    }

    /// A reftable repository with one commit, whose ref names never alias; `None` with a
    /// note only when this git says it doesn't know the option or the format, so any
    /// other init failure fails the test.
    async fn reftable_rename_repo(tag: &str) -> Option<(tempfile::TempDir, String)> {
        let (g, base) = temp_base(tag);
        let repo = base.to_string_lossy().into_owned();
        let init = run_git_raw(
            Some(&repo),
            &["init", "-q", "--ref-format=reftable"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        if init.code != 0 {
            let stderr = init.stderr.to_lowercase();
            let unsupported = init.code == 129
                || stderr.contains("unknown option")
                || stderr.contains("unknown ref storage format");
            assert!(unsupported, "reftable init failed: {}", init.stderr);
            eprintln!("note: this git can't create a reftable repo; skipping");
            return None;
        }
        run(&repo, &["config", "user.email", "t@t.local"]).await;
        run(&repo, &["config", "user.name", "T"]).await;
        commit_file(&repo, "a.txt", "seed\n").await;
        assert!(!super::refs_can_alias_strict(&repo).await.unwrap());
        Some((g, repo))
    }

    /// Where ref names can't alias, a case-only rename keeps `-m` and still succeeds,
    /// leaving only the new spelling stored.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn case_only_rename_where_names_cannot_alias_keeps_the_plain_move() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let Some((_g, repo)) = reftable_rename_repo("rename-case-only-reftable").await else {
            return;
        };
        run(&repo, &["branch", "rtcase-topic"]).await;
        let mode = super::rename_mode(&repo, "rtcase-topic", "Rtcase-topic").await;
        assert_eq!(mode.unwrap(), "-m");
        let result = git_rename_branch_core(
            &AppState::default(),
            repo.clone(),
            "rtcase-topic".into(),
            "Rtcase-topic".into(),
        )
        .await;
        assert!(result.is_ok(), "{result:?}");
        let listed = case_twin_listed(&repo).await;
        assert!(listed.iter().any(|b| b == "Rtcase-topic"), "{listed:?}");
        assert!(!listed.iter().any(|b| b == "rtcase-topic"), "{listed:?}");
    }

    /// Where ref names can't alias, both spellings are ordinary branches: the rename of one
    /// onto the other is refused as the name exists, and both stay where they were.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn case_only_rename_onto_a_twin_where_names_cannot_alias_is_refused() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let Some((_g, repo)) = reftable_rename_repo("rename-twin-reftable").await else {
            return;
        };
        run(&repo, &["branch", "Rtcase-twin"]).await;
        commit_file(&repo, "b.txt", "next\n").await;
        run(&repo, &["branch", "rtcase-twin"]).await;
        let pairs = || async {
            run(
                &repo,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads/",
                ],
            )
            .await
        };
        let before = pairs().await;
        let tips: Vec<&str> = before
            .lines()
            .filter(|l| {
                l.starts_with("refs/heads/Rtcase-twin ") || l.starts_with("refs/heads/rtcase-twin ")
            })
            .collect();
        assert_eq!(tips.len(), 2, "{before}");
        assert_ne!(
            tips[0].split(' ').nth(1),
            tips[1].split(' ').nth(1),
            "{before}"
        );
        let result = git_rename_branch_core(
            &AppState::default(),
            repo.clone(),
            "rtcase-twin".into(),
            "Rtcase-twin".into(),
        )
        .await;
        assert_eq!(pairs().await, before);
        assert!(
            matches!(&result, Err(AppError::Git { stderr, .. })
                if stderr.contains("a branch named 'Rtcase-twin' already exists")),
            "{result:?}"
        );
    }

    /// A create through a LINKED worktree beside a packed-only twin in the common store:
    /// the listing, the disk probe and the mutex all key on the common dir.
    #[tokio::test]
    async fn create_through_a_linked_worktree_refuses_a_case_twin() {
        for (checkout, no_track) in [(true, false), (false, true)] {
            let (g, repo, aliases) =
                case_twin_fixture("linked-case-twin", TwinStorage::PackedOnly).await;
            let wt = g.path().join("wt").to_string_lossy().into_owned();
            run(&repo, &["worktree", "add", "-q", "--detach", &wt]).await;
            assert_eq!(super::refs_can_alias(&wt).await, aliases, "{wt}");
            let before = case_twin_snapshot(&wt).await;
            let row = format!("checkout={checkout} no_track={no_track}");
            let result = git_create_branch_core(
                &AppState::default(),
                wt.clone(),
                "Feat".into(),
                checkout,
                None,
                no_track,
            )
            .await;
            let listed = case_twin_listed(&repo).await;
            if aliases {
                assert!(
                    matches!(&result, Err(AppError::Command(m)) if m == NEW_NAME_TWIN_REFUSAL),
                    "{row}: {result:?}"
                );
                assert!(!listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert_eq!(case_twin_snapshot(&wt).await, before, "{row}");
            } else {
                result.unwrap_or_else(|e| panic!("{row}: {e:?}"));
                assert!(listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert!(listed.iter().any(|b| b == "feat"), "{row}: {listed:?}");
            }
        }
    }

    /// Checking out `origin/Feat` beside the packed-only `feat`: refused before the switch
    /// where refs alias, leaving HEAD, the branches and the config as they were; a new
    /// `Feat` tracking `origin/Feat` where they don't.
    #[tokio::test]
    async fn remote_checkout_refuses_a_case_twin() {
        let (_g, repo, aliases) =
            case_twin_fixture("remote-case-twin", TwinStorage::PackedOnly).await;
        run(&repo, &["remote", "add", "origin", &repo]).await;
        run(&repo, &["update-ref", "refs/remotes/origin/Feat", "HEAD"]).await;
        let feat = full_ref_tip(&repo, "refs/heads/feat").await;
        let before = case_twin_snapshot(&repo).await;
        let result = git_checkout_remote_branch_core(
            &AppState::default(),
            repo.clone(),
            "origin".into(),
            "Feat".into(),
        )
        .await;
        let listed = case_twin_listed(&repo).await;
        if aliases {
            assert!(
                matches!(&result, Err(AppError::Command(m)) if m == NEW_NAME_TWIN_REFUSAL),
                "{result:?}"
            );
            assert!(!listed.iter().any(|b| b == "Feat"), "{listed:?}");
            assert!(listed.iter().any(|b| b == "feat"), "{listed:?}");
            assert_eq!(case_twin_snapshot(&repo).await, before);
            assert_eq!(branch_section(&repo, "Feat").await, "");
        } else {
            result.unwrap_or_else(|e| panic!("{e:?}"));
            assert!(listed.iter().any(|b| b == "Feat"), "{listed:?}");
            assert_eq!(
                symbolic_head(&repo).await.as_deref(),
                Some("refs/heads/Feat")
            );
            assert_eq!(
                run(&repo, &["config", "--get", "branch.Feat.merge"])
                    .await
                    .trim(),
                "refs/heads/Feat"
            );
        }
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, feat);
    }

    /// Checking out `Feat` from a remote named `team/fork` creates `Feat` tracking
    /// `team/fork/Feat`, never the `fork/Feat` git derives from the start ref alone; beside
    /// a packed-only `feat` where refs alias, it is refused with the twin sentence and
    /// creates nothing.
    #[tokio::test]
    async fn remote_checkout_under_a_slash_named_remote_creates_the_named_branch() {
        for twin in [false, true] {
            let (_g, repo, refused) = if twin {
                case_twin_fixture("slash-remote-twin", TwinStorage::PackedOnly).await
            } else {
                let (g, base) = temp_base("slash-remote");
                let repo = base.join("repo").to_string_lossy().into_owned();
                std::fs::create_dir_all(&repo).unwrap();
                init_repo(&repo, "r.txt").await;
                (g, repo, false)
            };
            run(&repo, &["remote", "add", "team/fork", &repo]).await;
            run(
                &repo,
                &["update-ref", "refs/remotes/team/fork/Feat", "HEAD"],
            )
            .await;
            let before = case_twin_snapshot(&repo).await;
            let result = git_checkout_remote_branch_core(
                &AppState::default(),
                repo.clone(),
                "team/fork".into(),
                "Feat".into(),
            )
            .await;
            let listed = case_twin_listed(&repo).await;
            let row = format!("twin={twin}");
            assert!(
                !listed.iter().any(|b| b == "fork/Feat"),
                "{row}: {listed:?}"
            );
            if refused {
                assert!(
                    matches!(&result, Err(AppError::Command(m)) if m == NEW_NAME_TWIN_REFUSAL),
                    "{row}: {result:?}"
                );
                assert!(!listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert_eq!(case_twin_snapshot(&repo).await, before, "{row}");
            } else {
                result.unwrap_or_else(|e| panic!("{row}: {e:?}"));
                assert!(listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert_eq!(
                    symbolic_head(&repo).await.as_deref(),
                    Some("refs/heads/Feat"),
                    "{row}"
                );
                assert_eq!(
                    upstream_of(&repo, "Feat").await.as_deref(),
                    Some("team/fork/Feat"),
                    "{row}"
                );
            }
        }
    }

    /// The remote rename: its check, its act, and the leased delete. Every remote is a
    /// local bare repository or an unroutable `.invalid` address.
    mod remote_rename {
        use super::super::{
            git_rename_branch_core, git_rename_branch_remote_core, is_case_only_rename,
            is_remote_rejection, live_pushed_tip, parse_remote_rename_read, pushed_branch_contains,
            remote_rejection_detail, remote_rename_check, remote_side_refusal,
            same_push_repository, set_branch_keep_local_core, unreachable_detail, OldKeptCause,
            PushedCopy, RemoteRenameCheck, RemoteRenameOutcome, RemoteRenamePhase,
            RemoteRenamePhaseHook, RemoteRenameRead, RemoteRenameRefusal, REMOTE_RENAME_PHASE_HOOK,
        };
        use super::{branch_exists, full_ref_tip, git_ok, run, temp_base};
        use crate::error::AppError;
        use crate::git::runner::{run_git_raw, TEST_GIT_HANG_GUARD};
        use crate::state::AppState;
        use std::rc::Rc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

        /// The local pull request store's process-wide override, on a folder of its own, for
        /// as long as it is held: a rename's local pull request move reads that store.
        /// Fields drop in order: the override restored, its folder deleted, the lock released.
        struct StoreHold {
            _override: crate::local_prs::tests::StoreDirOverride,
            _dir: tempfile::TempDir,
            _serialized: std::sync::MutexGuard<'static, ()>,
        }

        impl StoreHold {
            fn take() -> Self {
                let serialized = crate::local_prs::tests::store_dir_lock();
                let dir = tempfile::tempdir().unwrap();
                Self {
                    _override: crate::local_prs::tests::StoreDirOverride::set(dir.path()),
                    _dir: dir,
                    _serialized: serialized,
                }
            }
        }

        /// A bare `remote.git` (HEAD on `main`) and `repo`, whose `old` (one commit past
        /// `main`) tracks `origin/old`. `main` is checked out; no `refs/remotes/origin/HEAD`.
        /// Holds the store, shared by a second fixture of the same test ([`fixture_beside`]):
        /// the store lock is not reentrant.
        struct Fixture {
            _guard: tempfile::TempDir,
            base: String,
            bare: String,
            repo: String,
            main: String,
            old: String,
            _store: Rc<StoreHold>,
        }

        async fn commit(repo: &str, message: &str) {
            std::fs::write(std::path::Path::new(repo).join("f.txt"), message).unwrap();
            run(repo, &["add", "-A"]).await;
            run(repo, &["commit", "-qm", message]).await;
        }

        async fn fixture(tag: &str) -> Fixture {
            fixture_holding(tag, Rc::new(StoreHold::take())).await
        }

        /// A second fixture inside a test whose first, `f`, still holds the store.
        async fn fixture_beside(f: &Fixture, tag: &str) -> Fixture {
            fixture_holding(tag, f._store.clone()).await
        }

        async fn fixture_holding(tag: &str, store: Rc<StoreHold>) -> Fixture {
            let (guard, base) = temp_base(tag);
            let base_s = base.to_string_lossy().into_owned();
            let bare = base.join("remote.git").to_string_lossy().into_owned();
            let repo = base.join("repo").to_string_lossy().into_owned();
            run(&base_s, &["init", "-q", "--bare", "-b", "main", &bare]).await;
            run(&base_s, &["init", "-q", "-b", "main", &repo]).await;
            run(&repo, &["config", "user.email", "t@t.local"]).await;
            run(&repo, &["config", "user.name", "T"]).await;
            commit(&repo, "seed").await;
            run(&repo, &["remote", "add", "origin", &bare]).await;
            run(&repo, &["push", "-q", "origin", "main"]).await;
            run(&repo, &["checkout", "-q", "-b", "old"]).await;
            commit(&repo, "old work").await;
            run(&repo, &["push", "-q", "-u", "origin", "old"]).await;
            run(&repo, &["checkout", "-q", "main"]).await;
            let main = full_ref_tip(&repo, "refs/heads/main").await.unwrap();
            let old = full_ref_tip(&repo, "refs/heads/old").await.unwrap();
            Fixture {
                _guard: guard,
                base: base_s,
                bare,
                repo,
                main,
                old,
                _store: store,
            }
        }

        /// A second clone of the bare remote, with an identity and `old` checked out.
        async fn second_clone(f: &Fixture) -> String {
            let c2 = format!("{}/c2", f.base);
            run(&f.base, &["clone", "-q", &f.bare, &c2]).await;
            run(&c2, &["config", "user.email", "c@t.local"]).await;
            run(&c2, &["config", "user.name", "C"]).await;
            run(&c2, &["checkout", "-q", "-b", "old", "origin/old"]).await;
            c2
        }

        async fn remote_tip(f: &Fixture, branch: &str) -> Option<String> {
            full_ref_tip(&f.bare, &super::super::branch_full_ref(branch).unwrap()).await
        }

        async fn config_get(repo: &str, key: &str) -> String {
            run_git_raw(Some(repo), &["config", "--get", key], TEST_GIT_HANG_GUARD)
                .await
                .unwrap()
                .stdout_lossy()
                .trim()
                .to_string()
        }

        async fn remote_refs(f: &Fixture) -> String {
            run(
                &f.bare,
                &["for-each-ref", "--format=%(refname) %(objectname)"],
            )
            .await
        }

        fn hook_at<F, Fut>(at: RemoteRenamePhase, step: F) -> RemoteRenamePhaseHook
        where
            F: Fn() -> Fut + Send + Sync + 'static,
            Fut: std::future::Future<Output = ()> + Send + 'static,
        {
            let step = Arc::new(step);
            Arc::new(move |phase| {
                let step = step.clone();
                Box::pin(async move {
                    if phase == at {
                        step().await;
                    }
                })
            })
        }

        async fn act(f: &Fixture, new: &str, expected: Option<&str>) -> RemoteRenameOutcome {
            git_rename_branch_remote_core(
                &AppState::default(),
                f.repo.clone(),
                "old".into(),
                new.into(),
                "origin".into(),
                expected.map(str::to_string),
            )
            .await
            .unwrap()
        }

        async fn act_hooked(f: &Fixture, hook: RemoteRenamePhaseHook) -> RemoteRenameOutcome {
            REMOTE_RENAME_PHASE_HOOK
                .scope(hook, act(f, "new", None))
                .await
        }

        async fn set_url(f: &Fixture, url: &str) {
            run(&f.repo, &["remote", "set-url", "origin", url]).await;
            crate::git::remote::invalidate_remote_url_cache(&f.repo, "origin");
        }

        /// The act's refusal on `new`, asserting nothing was renamed here or there.
        async fn refusal(f: &Fixture, new: &str, expected: Option<&str>) -> RemoteRenameRefusal {
            let before = remote_refs(f).await;
            let outcome = act(f, new, expected).await;
            let RemoteRenameOutcome::Refused { refusal } = outcome else {
                panic!("{new}: expected a refusal, got {outcome:?}");
            };
            assert!(branch_exists(&f.repo, "old").await, "{refusal:?}: old kept");
            if new != "Old" {
                assert!(
                    !branch_exists(&f.repo, new).await,
                    "{refusal:?}: {new} absent"
                );
            }
            assert_eq!(
                remote_refs(f).await,
                before,
                "{refusal:?}: remote unchanged"
            );
            refusal
        }

        /// [`refusal`], then the same with the remote unreachable: a local refusal fires
        /// before the network read.
        async fn local_refusal(f: &Fixture, new: &str) -> RemoteRenameRefusal {
            let reachable = refusal(f, new, None).await;
            set_url(f, &format!("{}/missing.git", f.base)).await;
            let offline = refusal(f, new, None).await;
            set_url(f, &f.bare).await;
            assert_eq!(offline, reachable, "the remote's reach changed the verdict");
            reachable
        }

        #[test]
        fn remote_rename_wire_shapes_are_camel_case() {
            use serde_json::{json, to_value};
            let rows = [
                (
                    to_value(RemoteRenameRefusal::NotTracking).unwrap(),
                    json!({"code": "notTracking"}),
                ),
                (
                    to_value(RemoteRenameRefusal::PushUrlDiffers).unwrap(),
                    json!({"code": "pushUrlDiffers"}),
                ),
                (
                    to_value(RemoteRenameRefusal::PushesElsewhere {
                        push_remote: "fork".into(),
                    })
                    .unwrap(),
                    json!({"code": "pushesElsewhere", "pushRemote": "fork"}),
                ),
                (
                    to_value(RemoteRenameRefusal::Unreachable { detail: "d".into() }).unwrap(),
                    json!({"code": "unreachable", "detail": "d"}),
                ),
                (
                    to_value(RemoteRenameCheck::Clear { old_tip: A.into() }).unwrap(),
                    json!({"status": "clear", "oldTip": A}),
                ),
                (
                    to_value(RemoteRenameCheck::Refused {
                        refusal: RemoteRenameRefusal::RemoteAhead,
                    })
                    .unwrap(),
                    json!({"status": "refused", "refusal": {"code": "remoteAhead"}}),
                ),
                (
                    to_value(OldKeptCause::NotInPush).unwrap(),
                    json!({"reason": "notInPush"}),
                ),
                (
                    to_value(OldKeptCause::Unverified).unwrap(),
                    json!({"reason": "unverified"}),
                ),
                (
                    to_value(OldKeptCause::Rejected {
                        detail: "no".into(),
                    })
                    .unwrap(),
                    json!({"reason": "rejected", "detail": "no"}),
                ),
                (
                    to_value(RemoteRenameOutcome::Renamed { warning: None }).unwrap(),
                    json!({"status": "renamed", "warning": null}),
                ),
                (
                    to_value(RemoteRenameOutcome::OldKept {
                        warning: Some("w".into()),
                        cause: OldKeptCause::Moved,
                    })
                    .unwrap(),
                    json!({"status": "oldKept", "warning": "w", "cause": {"reason": "moved"}}),
                ),
            ];
            for (got, want) in rows {
                assert_eq!(got, want);
            }
            let failed = to_value(RemoteRenameOutcome::PushFailed {
                warning: None,
                error: AppError::Command("x".into()),
            })
            .unwrap();
            assert_eq!(failed["status"], "pushFailed");
            assert_eq!(failed["error"]["message"], "x");
            let kept = to_value(OldKeptCause::Failed {
                error: AppError::Command("y".into()),
            })
            .unwrap();
            assert_eq!(kept["reason"], "failed");
            assert_eq!(kept["error"]["message"], "y");
            let text = format!("{failed}{kept}");
            for snake in [
                "old_tip",
                "push_failed",
                "old_kept",
                "not_in_push",
                "is_draft",
            ] {
                assert!(!text.contains(snake), "{snake} in {text}");
            }
        }

        #[test]
        fn same_push_repository_compares_repository_identity() {
            let rows: [(&str, &[&str], bool); 20] = [
                // A scheme's default port is the port git uses when the URL names none.
                ("https://h:443/o/r.git", &["https://h/o/r.git"], true),
                ("http://h/o/r.git", &["http://h:80/o/r.git"], true),
                ("ssh://git@h:22/o/r.git", &["git@h:o/r.git"], true),
                ("git+ssh://git@h:22/o/r.git", &["ssh://git@h/o/r.git"], true),
                ("https://h:80/o/r.git", &["https://h/o/r.git"], false),
                ("ssh://git@h:2222/o/r.git", &["git@h:o/r.git"], false),
                // A missing ssh user is still another user.
                ("ssh://h:22/o/r.git", &["git@h:o/r.git"], false),
                // Within one transport family the port and the ssh user tell two
                // repositories apart; across families each serves its own port.
                (
                    "ssh://git@host:2222/a/b.git",
                    &["ssh://git@host:2200/a/b.git"],
                    false,
                ),
                (
                    "https://host:8443/a/b.git",
                    &["https://host:9443/a/b.git"],
                    false,
                ),
                ("alice@host:repo.git", &["bob@host:repo.git"], false),
                (
                    "ssh://git@host:2222/a/b.git",
                    &["https://host/a/b.git"],
                    true,
                ),
                (
                    "https://github.com/a/b.git",
                    &["git@github.com:a/b.git"],
                    true,
                ),
                (
                    "https://GitHub.com/a/b",
                    &["ssh://git@github.com/a/b.git/"],
                    true,
                ),
                (
                    "https://github.com/a/b.git",
                    &["https://github.com/a/c.git"],
                    false,
                ),
                (
                    "https://github.com/a/b.git",
                    &["https://gitlab.com/a/b.git"],
                    false,
                ),
                (
                    "https://github.com/a/b.git",
                    &["https://github.com/a/b.git", "git@github.com:a/b.git"],
                    false,
                ),
                ("/srv/x.git", &["/srv/x.git"], true),
                ("/srv/x.git", &["/srv/x.git/"], false),
                (
                    "https://github.com/a/b.git",
                    &["https://github.com/a/b.git"],
                    true,
                ),
                ("https://github.com/a/b.git", &[], false),
            ];
            for (fetch, push, want) in rows {
                assert_eq!(
                    same_push_repository(fetch, push),
                    want,
                    "{fetch} vs {push:?}"
                );
            }
        }

        #[test]
        fn remote_rename_read_counts_exact_rows_only() {
            let read = |stdout: &str, new: Option<&str>| {
                parse_remote_rename_read(stdout, "refs/heads/old", new)
            };
            let f1 = format!(
                "ref: refs/heads/main\tHEAD\n{A}\tHEAD\n{A}\trefs/heads/old\n{B}\trefs/heads/x/refs/heads/old\n"
            );
            assert_eq!(
                read(&f1, Some("refs/heads/new")),
                RemoteRenameRead {
                    default_ref: Some("refs/heads/main".into()),
                    old_tip: Some(A.into()),
                    new_exists: false,
                }
            );
            // The tail-match decoys alone: neither name is listed.
            let decoys =
                format!("{B}\trefs/heads/x/refs/heads/old\n{B}\trefs/heads/y/refs/heads/new\n");
            let only_decoys = read(&decoys, Some("refs/heads/new"));
            assert_eq!(
                only_decoys.old_tip, None,
                "a tail match read as the old branch"
            );
            assert!(
                !only_decoys.new_exists,
                "a tail match read as the new branch"
            );
            assert_eq!(
                remote_side_refusal(&only_decoys, "refs/heads/old", None),
                Some(RemoteRenameRefusal::RemoteGone)
            );
            assert_eq!(read("abc123\trefs/heads/old\n", None).old_tip, None);
            let upper = A.to_ascii_uppercase();
            assert_eq!(
                read(&format!("{upper}\trefs/heads/old\n"), None).old_tip,
                Some(A.into())
            );

            let state =
                |default_ref: Option<&str>, old_tip: Option<&str>, new_exists| RemoteRenameRead {
                    default_ref: default_ref.map(str::to_string),
                    old_tip: old_tip.map(str::to_string),
                    new_exists,
                };
            use RemoteRenameRefusal as R;
            let rows = [
                (
                    state(Some("refs/heads/old"), None, true),
                    None,
                    Some(R::RemoteDefault),
                ),
                (state(None, Some(A), false), None, None),
                (
                    state(Some("refs/heads/main"), Some(A), false),
                    Some(upper.as_str()),
                    None,
                ),
                (state(None, None, true), Some(A), Some(R::RemoteGone)),
                (state(None, Some(A), true), Some(B), Some(R::Moved)),
                (state(None, Some(A), true), Some(A), Some(R::NewExists)),
            ];
            for (row, expected, want) in rows {
                assert_eq!(
                    remote_side_refusal(&row, "refs/heads/old", expected),
                    want,
                    "{row:?}"
                );
            }
        }

        #[test]
        fn rejection_and_unreachable_details_read_git_text() {
            let deny = "remote: error: denying ref deletion for refs/heads/victim        \n\
                        To C:/x/remote.git\n ! [remote rejected] victim (deletion prohibited)\n\
                        error: failed to push some refs to 'C:/x/remote.git'\n";
            assert_eq!(
                remote_rejection_detail(deny),
                "error: denying ref deletion for refs/heads/victim"
            );
            let current = "remote: error: refusing to delete the current branch: refs/heads/old\n\
                           To C:/x/remote.git\n ! [remote rejected] old (deletion of the current branch prohibited)\n";
            assert_eq!(
                remote_rejection_detail(current),
                "error: refusing to delete the current branch: refs/heads/old"
            );
            let checked_out =
                "To C:/x/nb\n ! [remote rejected] old (branch is currently checked out)\n";
            assert_eq!(
                remote_rejection_detail(checked_out),
                "branch is currently checked out"
            );
            let gh006 = "remote: error: GH006: Protected branch update failed for refs/heads/old.\n\
                         remote: \nremote: - Cannot delete this branch\nremote: \n\
                         To https://github.com/o/r.git\n ! [remote rejected] old (protected branch hook declined)\n";
            assert_eq!(
                remote_rejection_detail(gh006),
                "error: GH006: Protected branch update failed for refs/heads/old.\n- Cannot delete this branch"
            );
            // Only a ref status line, colored or not, is the remote's rejection.
            let colored = "To C:/x/nb\n \x1b[31m! [remote rejected]\x1b[m old (declined)\n";
            let fatal_path = "fatal: could not read from 'C:/[remote rejected]/x.git'\n";
            let rows = [
                (deny, true),
                (current, true),
                (checked_out, true),
                (gh006, true),
                (colored, true),
                (fatal_path, false),
                ("remote: ! [remote rejected] old (hook text)\n", false),
                ("", false),
            ];
            for (stderr, want) in rows {
                assert_eq!(is_remote_rejection(stderr), want, "{stderr:?}");
            }

            let git = |stderr: &str| AppError::Git {
                code: 128,
                stderr: stderr.into(),
            };
            let missing = git(
                "fatal: 'C:/x/missing.git' does not appear to be a git repository\n\
                               fatal: Could not read from remote repository.\n",
            );
            assert_eq!(
                unreachable_detail(&missing),
                "'C:/x/missing.git' does not appear to be a git repository"
            );
            assert_eq!(unreachable_detail(&git("warning: w\nerror: e\n")), "e");
            let timeout = AppError::Command("timed out".into());
            assert_eq!(unreachable_detail(&timeout), timeout.to_string());

            assert!(is_case_only_rename("feat", Some("Feat")));
            assert!(!is_case_only_rename("feat", Some("feat")));
            assert!(!is_case_only_rename("feat", Some("other")));
            assert!(!is_case_only_rename("feat", None));
        }

        /// The whole act lands here and there, with the rename lock free while it pushes.
        #[tokio::test]
        async fn a_remote_rename_moves_the_branch_on_its_remote() {
            let f = fixture("rr-happy").await;
            run(&f.repo, &["branch", "other"]).await;
            run(&f.repo, &["update-ref", "refs/remotes/origin/new", &f.main]).await;
            let reached = Arc::new(AtomicUsize::new(0));
            let (repo, bare, count) = (f.repo.clone(), f.bare.clone(), reached.clone());
            let hook: RemoteRenamePhaseHook = Arc::new(move |phase| {
                let (repo, bare, count) = (repo.clone(), bare.clone(), count.clone());
                Box::pin(async move {
                    let has = |repo: String, rev: &'static str| async move {
                        git_ok(&repo, &["rev-parse", "--verify", "--quiet", rev]).await
                    };
                    match phase {
                        RemoteRenamePhase::BeforePush => {
                            assert!(has(repo.clone(), "refs/heads/new").await, "renamed here");
                            assert!(!has(repo.clone(), "refs/heads/old").await, "old gone here");
                            assert!(
                                !has(repo.clone(), "refs/remotes/origin/new").await,
                                "the stale tracking ref is gone before the push"
                            );
                        }
                        RemoteRenamePhase::AfterPush => return,
                        RemoteRenamePhase::BeforeDelete => {
                            assert!(has(bare.clone(), "refs/heads/new").await, "new pushed");
                            assert!(has(bare.clone(), "refs/heads/old").await, "old still there");
                            let other = tokio::time::timeout(
                                std::time::Duration::from_secs(30),
                                git_rename_branch_core(
                                    &AppState::default(),
                                    repo.clone(),
                                    "other".into(),
                                    "other2".into(),
                                ),
                            )
                            .await;
                            assert!(
                                matches!(other, Ok(Ok(_))),
                                "the rename lock is free: {other:?}"
                            );
                        }
                    }
                    count.fetch_add(1, Ordering::SeqCst);
                })
            });
            let outcome = act_hooked(&f, hook).await;
            assert!(
                matches!(outcome, RemoteRenameOutcome::Renamed { warning: None }),
                "{outcome:?}"
            );
            assert_eq!(reached.load(Ordering::SeqCst), 2, "both hooks ran");
            assert_eq!(remote_tip(&f, "new").await, Some(f.old.clone()));
            assert_eq!(remote_tip(&f, "old").await, None);
            assert_eq!(
                config_get(&f.repo, "branch.new.merge").await,
                "refs/heads/new"
            );
            assert_eq!(full_ref_tip(&f.repo, "refs/remotes/origin/old").await, None);
            assert_eq!(
                full_ref_tip(&f.repo, "refs/remotes/origin/new").await,
                Some(f.old.clone()),
                "the push created new"
            );
            assert!(branch_exists(&f.repo, "other2").await);
        }

        /// Each local refusal, before any network read; a bare `branch.old.merge = old` is
        /// not tracking (git lists no upstream for it).
        #[tokio::test]
        async fn local_refusals_fire_before_the_network_read() {
            use RemoteRenameRefusal as R;
            let f = fixture("rr-local").await;
            let repo = f.repo.as_str();
            run(repo, &["branch", "--unset-upstream", "old"]).await;
            assert_eq!(local_refusal(&f, "new").await, R::NotTracking);
            run(repo, &["config", "branch.old.remote", "origin"]).await;
            run(repo, &["config", "branch.old.merge", "old"]).await;
            assert_eq!(
                local_refusal(&f, "new").await,
                R::NotTracking,
                "a bare merge"
            );
            run(repo, &["config", "branch.old.merge", "refs/heads/old"]).await;

            set_branch_keep_local_core(repo, "old", true).await.unwrap();
            assert_eq!(local_refusal(&f, "new").await, R::KeepLocal);
            set_branch_keep_local_core(repo, "old", false)
                .await
                .unwrap();

            run(repo, &["config", "remote.origin.mirror", "true"]).await;
            assert_eq!(local_refusal(&f, "new").await, R::Mirror);
            run(repo, &["config", "--unset", "remote.origin.mirror"]).await;

            let elsewhere = format!("{}/elsewhere.git", f.base);
            run(repo, &["config", "remote.origin.pushurl", &elsewhere]).await;
            assert_eq!(local_refusal(&f, "new").await, R::PushUrlDiffers);
            run(repo, &["config", "--unset-all", "remote.origin.pushurl"]).await;

            run(repo, &["config", "--add", "remote.origin.pushurl", &f.bare]).await;
            run(repo, &["config", "--add", "remote.origin.pushurl", &f.bare]).await;
            assert_eq!(
                local_refusal(&f, "new").await,
                R::PushUrlDiffers,
                "two push URLs"
            );
            run(repo, &["config", "--unset-all", "remote.origin.pushurl"]).await;

            if super::super::refs_can_alias_strict(repo).await.unwrap() {
                assert_eq!(local_refusal(&f, "Old").await, R::CaseOnly);
            } else {
                eprintln!("SKIP caseOnly real-repo row: this store's refs cannot alias");
            }

            let check = remote_rename_check(
                &AppState::default(),
                repo,
                "old",
                Some("new"),
                "origin",
                None,
            )
            .await
            .unwrap();
            assert_eq!(
                check,
                RemoteRenameCheck::Clear {
                    old_tip: f.old.clone()
                }
            );
            assert_eq!(
                remote_rename_check(&AppState::default(), repo, "old", None, "origin", None)
                    .await
                    .unwrap(),
                RemoteRenameCheck::Clear {
                    old_tip: f.old.clone()
                },
                "no new name yet"
            );
        }

        /// The refusals the live read decides, each renaming nothing.
        #[tokio::test]
        async fn remote_refusals_rename_nothing() {
            use RemoteRenameRefusal as R;
            let f = fixture("rr-remote").await;
            let bare = f.bare.as_str();

            set_url(&f, &format!("{}/missing.git", f.base)).await;
            let R::Unreachable { detail } = refusal(&f, "new", None).await else {
                panic!("expected unreachable");
            };
            assert!(
                !detail.is_empty() && !detail.starts_with("fatal:"),
                "{detail}"
            );
            set_url(&f, &f.bare).await;

            run(bare, &["symbolic-ref", "HEAD", "refs/heads/old"]).await;
            assert_eq!(refusal(&f, "new", None).await, R::RemoteDefault);
            run(bare, &["symbolic-ref", "HEAD", "refs/heads/main"]).await;

            run(bare, &["update-ref", "-d", "refs/heads/old"]).await;
            assert_eq!(refusal(&f, "new", None).await, R::RemoteGone);
            run(bare, &["update-ref", "refs/heads/old", &f.old]).await;

            assert_eq!(refusal(&f, "new", Some(&f.main)).await, R::Moved);

            run(bare, &["update-ref", "refs/heads/new", &f.main]).await;
            assert_eq!(refusal(&f, "new", None).await, R::NewExists);
            run(bare, &["update-ref", "refs/heads/new", &f.old]).await;
            assert_eq!(
                refusal(&f, "new", None).await,
                R::NewExists,
                "at the same commit"
            );
            run(bare, &["update-ref", "-d", "refs/heads/new"]).await;

            // pushInsteadOf: the push URL is the same repository, so the check reaches its
            // read, which the reserved `.invalid` name fails. An empty proxy keeps any
            // inherited proxy out; the resolver is still asked for the name.
            set_url(&f, "https://example.invalid/a/b.git").await;
            run(&f.repo, &["config", "remote.origin.proxy", ""]).await;
            run(
                &f.repo,
                &[
                    "config",
                    "url.git@example.invalid:.pushInsteadOf",
                    "https://example.invalid/",
                ],
            )
            .await;
            let rewritten = refusal(&f, "new", None).await;
            assert!(matches!(rewritten, R::Unreachable { .. }), "{rewritten:?}");
            run(
                &f.repo,
                &["config", "--remove-section", "url.git@example.invalid:"],
            )
            .await;
            run(&f.repo, &["config", "--unset", "remote.origin.proxy"]).await;
            set_url(&f, &f.bare).await;

            let c2 = second_clone(&f).await;
            commit(&c2, "remote only").await;
            run(&c2, &["push", "-q", "origin", "old"]).await;
            assert_eq!(
                refusal(&f, "new", None).await,
                R::RemoteAhead,
                "an unfetched commit"
            );
            run(&f.repo, &["fetch", "-q", "origin"]).await;
            assert_eq!(
                refusal(&f, "new", None).await,
                R::RemoteAhead,
                "a fetched commit"
            );
        }

        /// A refused push deletes nothing: the second clone puts `new` at an ANCESTOR of
        /// the local tip, a fast-forward the create-only lease alone refuses.
        #[tokio::test]
        async fn a_refused_push_runs_no_delete() {
            let f = fixture("rr-push").await;
            let c2 = second_clone(&f).await;
            let hook = hook_at(RemoteRenamePhase::BeforePush, move || {
                let c2 = c2.clone();
                async move {
                    run(&c2, &["push", "-q", "origin", "main:refs/heads/new"]).await;
                }
            });
            let outcome = act_hooked(&f, hook).await;
            assert!(
                matches!(outcome, RemoteRenameOutcome::PushFailed { .. }),
                "{outcome:?}"
            );
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert_eq!(remote_tip(&f, "new").await, Some(f.main.clone()));
            assert_eq!(config_get(&f.repo, "branch.new.remote").await, "origin");
            assert_eq!(
                config_get(&f.repo, "branch.new.merge").await,
                "refs/heads/old"
            );

            // A fetch after the stale-ref cleanup re-creates `origin/new`; the push's
            // create-only lease still refuses.
            let g = fixture_beside(&f, "rr-push-fetched").await;
            let (c3, repo) = (second_clone(&g).await, g.repo.clone());
            let hook = hook_at(RemoteRenamePhase::BeforePush, move || {
                let (c3, repo) = (c3.clone(), repo.clone());
                async move {
                    run(&c3, &["push", "-q", "origin", "main:refs/heads/new"]).await;
                    run(&repo, &["fetch", "-q", "origin"]).await;
                }
            });
            let outcome = act_hooked(&g, hook).await;
            assert!(
                matches!(
                    &outcome,
                    RemoteRenameOutcome::PushFailed {
                        error: AppError::PushDestinationExists { .. },
                        ..
                    }
                ),
                "{outcome:?}"
            );
            assert_eq!(remote_tip(&g, "old").await, Some(g.old.clone()));
            assert_eq!(remote_tip(&g, "new").await, Some(g.main.clone()));
        }

        /// A push remote other than the remote being renamed on refuses the remote step
        /// before the network read; the branch's own key outranks `remote.pushDefault`.
        #[tokio::test]
        async fn a_push_remote_elsewhere_refuses_the_remote_step() {
            let f = fixture("rr-pushremote").await;
            let repo = f.repo.as_str();
            let fork = RemoteRenameRefusal::PushesElsewhere {
                push_remote: "fork".into(),
            };
            run(repo, &["config", "branch.old.pushRemote", "fork"]).await;
            assert_eq!(local_refusal(&f, "new").await, fork, "pushRemote");
            run(repo, &["config", "remote.pushDefault", "origin"]).await;
            assert_eq!(local_refusal(&f, "new").await, fork, "the own key wins");
            run(repo, &["config", "--unset", "branch.old.pushRemote"]).await;
            run(repo, &["config", "remote.pushDefault", "fork"]).await;
            assert_eq!(local_refusal(&f, "new").await, fork, "pushDefault");

            let state = AppState::default();
            let check = || remote_rename_check(&state, repo, "old", Some("new"), "origin", None);
            let clear = RemoteRenameCheck::Clear {
                old_tip: f.old.clone(),
            };
            run(repo, &["config", "branch.old.pushRemote", "origin"]).await;
            assert_eq!(check().await.unwrap(), clear, "the remote itself");
            run(repo, &["config", "--unset", "branch.old.pushRemote"]).await;
            run(repo, &["config", "--unset", "remote.pushDefault"]).await;
            assert_eq!(check().await.unwrap(), clear, "unset");

            // An empty value gives git no push remote; the branch's own empty key still wins.
            run(repo, &["config", "remote.pushDefault", "fork"]).await;
            run(repo, &["config", "branch.old.pushRemote", ""]).await;
            assert_eq!(check().await.unwrap(), clear, "an empty pushRemote");
            run(repo, &["config", "--unset", "branch.old.pushRemote"]).await;
            run(repo, &["config", "remote.pushDefault", ""]).await;
            assert_eq!(check().await.unwrap(), clear, "an empty pushDefault");
        }

        /// A tracking ref a leftover lock holds at a value containing the old tip is never
        /// the proof: the live tip is, and it lacks the old tip.
        #[tokio::test]
        async fn a_stale_tracking_ref_is_never_the_containment_proof() {
            let f = fixture("rr-stale-tracking").await;
            let (repo, main, old) = (f.repo.clone(), f.main.clone(), f.old.clone());
            let hook = hook_at(RemoteRenamePhase::BeforePush, move || {
                let (repo, main, old) = (repo.clone(), main.clone(), old.clone());
                async move {
                    run(&repo, &["update-ref", "refs/remotes/origin/new", &old]).await;
                    let lock =
                        std::path::Path::new(&repo).join(".git/refs/remotes/origin/new.lock");
                    std::fs::write(lock, "").unwrap();
                    run(&repo, &["update-ref", "refs/heads/new", &main]).await;
                }
            });
            let outcome = act_hooked(&f, hook).await;
            assert!(
                matches!(
                    outcome,
                    RemoteRenameOutcome::OldKept {
                        cause: OldKeptCause::NotInPush,
                        ..
                    }
                ),
                "{outcome:?}"
            );
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert_eq!(remote_tip(&f, "new").await, Some(f.main.clone()));
        }

        /// The check's ancestry reads the commits as stored: a replace ref or a graft that
        /// makes the remote's tip look contained still answers `remoteAhead`.
        #[tokio::test]
        async fn replace_refs_and_grafts_never_prove_containment() {
            let f = fixture("rr-graft").await;
            let c2 = second_clone(&f).await;
            commit(&c2, "remote only").await;
            run(&c2, &["push", "-q", "origin", "old"]).await;
            run(&f.repo, &["fetch", "-q", "origin"]).await;
            let ahead_tip = remote_tip(&f, "old").await.unwrap();
            let state = AppState::default();
            let check = || remote_rename_check(&state, &f.repo, "old", Some("new"), "origin", None);
            let ahead = RemoteRenameCheck::Refused {
                refusal: RemoteRenameRefusal::RemoteAhead,
            };
            let looks_contained: [&str; 4] = ["merge-base", "--is-ancestor", &ahead_tip, &f.old];

            run(&f.repo, &["replace", "--graft", &f.old, &ahead_tip]).await;
            assert!(git_ok(&f.repo, &looks_contained).await, "fixture: replaced");
            assert_eq!(check().await.unwrap(), ahead, "replace ref");
            run(&f.repo, &["replace", "-d", &f.old]).await;

            let grafts = std::path::Path::new(&f.repo).join(".git/info/grafts");
            std::fs::create_dir_all(grafts.parent().unwrap()).unwrap();
            std::fs::write(&grafts, format!("{} {ahead_tip}\n", f.old)).unwrap();
            // Every git through 2.51 reads info/grafts; its removal is slated for Git 3.0,
            // where this row has nothing to prove. CI must still run it.
            let probe = run_git_raw(Some(&f.repo), &looks_contained, TEST_GIT_HANG_GUARD)
                .await
                .unwrap();
            // Exit 1 is a git that ignores the file; any other failure is the fixture's.
            assert!(matches!(probe.code, 0 | 1), "graft probe: {}", probe.stderr);
            if probe.code == 0 {
                assert_eq!(check().await.unwrap(), ahead, "graft file");
            } else {
                assert!(
                    std::env::var_os("CI").is_none(),
                    "CI's git must honour info/grafts for the graft row"
                );
                eprintln!("skipped graft row: this git ignores info/grafts");
            }
        }

        /// The proof after the push reads the commits as stored too: a pushed tip that only
        /// a replace ref makes contain the old tip keeps the old branch.
        #[tokio::test]
        async fn a_replace_ref_never_proves_the_push_contains_the_old_tip() {
            let f = fixture("rr-graft-proof").await;
            let (repo, main, old) = (f.repo.clone(), f.main.clone(), f.old.clone());
            let side = Arc::new(std::sync::Mutex::new(String::new()));
            let hook = hook_at(RemoteRenamePhase::BeforePush, {
                let side = side.clone();
                move || {
                    let (repo, main, old, side) =
                        (repo.clone(), main.clone(), old.clone(), side.clone());
                    async move {
                        let tree = format!("{main}^{{tree}}");
                        let tip = run(&repo, &["commit-tree", "-p", &main, "-m", "side", &tree])
                            .await
                            .trim()
                            .to_string();
                        run(&repo, &["replace", "--graft", &tip, &main, &old]).await;
                        let contained = ["merge-base", "--is-ancestor", &old, &tip];
                        assert!(git_ok(&repo, &contained).await, "fixture: replaced");
                        run(&repo, &["update-ref", "refs/heads/new", &tip]).await;
                        *side.lock().unwrap() = tip;
                    }
                }
            });
            let outcome = act_hooked(&f, hook).await;
            assert!(
                matches!(
                    outcome,
                    RemoteRenameOutcome::OldKept {
                        cause: OldKeptCause::NotInPush,
                        ..
                    }
                ),
                "{outcome:?}"
            );
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            let side = side.lock().unwrap().clone();
            assert_eq!(remote_tip(&f, "new").await, Some(side));
        }

        /// `refs/remotes/origin/old` made a symbolic ref to `keep`, which `keep_symbolic`
        /// creates at the old tip; git's own tracking update after a delete would follow it.
        async fn keep_symbolic(f: &Fixture) {
            run(&f.repo, &["branch", "keep", &f.old]).await;
            run(&f.repo, &["update-ref", "-d", "refs/remotes/origin/old"]).await;
            run(
                &f.repo,
                &["symbolic-ref", "refs/remotes/origin/old", "refs/heads/keep"],
            )
            .await;
        }

        /// The rename's delete of the old name removes a symbolic tracking ref first, so
        /// the local branch it names survives.
        #[tokio::test]
        async fn a_symbolic_tracking_ref_never_costs_the_rename_a_branch() {
            let f = fixture("rr-symbolic").await;
            keep_symbolic(&f).await;
            let outcome = act(&f, "new", None).await;
            assert!(
                matches!(outcome, RemoteRenameOutcome::Renamed { .. }),
                "{outcome:?}"
            );
            assert_eq!(
                full_ref_tip(&f.repo, "refs/heads/keep").await,
                Some(f.old.clone())
            );
            assert!(!git_ok(&f.repo, &["symbolic-ref", "-q", "refs/remotes/origin/old"]).await);
            assert_eq!(remote_tip(&f, "old").await, None);
        }

        /// The plain remote delete: a symbolic tracking ref it can't remove refuses before
        /// the push; removed, the branch it named survives; and a read of it that fails
        /// never fails a delete.
        #[tokio::test]
        async fn a_symbolic_tracking_ref_never_costs_a_remote_delete_a_branch() {
            use crate::git::runner::GIT_SPAWN_LOG;
            let f = fixture("rr-symbolic-delete").await;
            keep_symbolic(&f).await;
            let state = AppState::default();
            let delete = || {
                super::super::git_delete_remote_branch_core(
                    &state,
                    f.repo.clone(),
                    "origin".into(),
                    "old".into(),
                )
            };
            let lock = std::path::Path::new(&f.repo).join(".git/refs/remotes/origin/old.lock");
            std::fs::write(&lock, "").unwrap();
            let refused = delete().await;
            assert!(matches!(refused, Err(AppError::Git { .. })), "{refused:?}");
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            std::fs::remove_file(&lock).unwrap();

            delete().await.unwrap();
            assert_eq!(remote_tip(&f, "old").await, None);
            assert_eq!(
                full_ref_tip(&f.repo, "refs/heads/keep").await,
                Some(f.old.clone())
            );

            run(&f.repo, &["push", "-q", "origin", "keep:refs/heads/old"]).await;
            let away = format!("{}-away", f.repo);
            let steps = Arc::new(AtomicUsize::new(0));
            let log = {
                let (repo, away, steps) = (f.repo.clone(), away.clone(), steps.clone());
                Arc::new(move |args: &[&str]| match steps.load(Ordering::SeqCst) {
                    0 if args.starts_with(&["symbolic-ref", "-q"]) => {
                        super::move_dir(&repo, &away);
                        steps.store(1, Ordering::SeqCst);
                    }
                    1 => {
                        super::move_dir(&away, &repo);
                        steps.store(2, Ordering::SeqCst);
                    }
                    _ => {}
                })
            };
            let deleted = GIT_SPAWN_LOG.scope(log, delete()).await;
            assert_eq!(steps.load(Ordering::SeqCst), 2, "fixture: {deleted:?}");
            deleted.unwrap();
            assert_eq!(remote_tip(&f, "old").await, None);
        }

        /// A remote delete of `HEAD`, plain or the rename's leased one, refuses before it
        /// reads, drops or pushes anything, so the clone-made `origin/HEAD` symref survives.
        #[tokio::test]
        async fn a_remote_delete_of_head_refuses_and_keeps_the_default_pointer() {
            use super::super::{delete_remote_branch_leased, RemoteDeleteLeased};
            use crate::git::runner::GIT_SPAWN_LOG;
            const REFUSAL: &str = "HEAD is the remote's default-branch pointer, not a branch";
            let f = fixture("rr-delete-head").await;
            run(&f.repo, &["fetch", "-q", "origin"]).await;
            run(
                &f.repo,
                &[
                    "symbolic-ref",
                    "refs/remotes/origin/HEAD",
                    "refs/remotes/origin/main",
                ],
            )
            .await;
            let state = AppState::default();
            let spawned = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let log = {
                let spawned = spawned.clone();
                Arc::new(move |args: &[&str]| spawned.lock().unwrap().push(args.join(" ")))
            };
            let plain = GIT_SPAWN_LOG
                .scope(
                    log.clone(),
                    super::super::git_delete_remote_branch_core(
                        &state,
                        f.repo.clone(),
                        "origin".into(),
                        "HEAD".into(),
                    ),
                )
                .await;
            assert!(
                matches!(&plain, Err(AppError::InvalidArgument(m)) if m == REFUSAL),
                "{plain:?}"
            );
            let leased = GIT_SPAWN_LOG
                .scope(
                    log,
                    delete_remote_branch_leased(&state, &f.repo, "origin", "HEAD", &f.main),
                )
                .await;
            assert!(matches!(
                &leased,
                RemoteDeleteLeased::Kept(OldKeptCause::Failed {
                    error: AppError::InvalidArgument(m),
                }) if m == REFUSAL
            ));
            let spawned = spawned.lock().unwrap().clone();
            assert!(spawned.is_empty(), "nothing read or pushed: {spawned:?}");
            let head = run_git_raw(
                Some(&f.repo),
                &["symbolic-ref", "refs/remotes/origin/HEAD"],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
            assert_eq!(head.stdout_lossy().trim(), "refs/remotes/origin/main");
            assert_eq!(remote_tip(&f, "main").await, Some(f.main.clone()));
        }

        /// The check's read of the remote tip: a commit this store lacks is `remoteAhead`,
        /// one it holds goes on to the ancestry test, and a corrupt one is the check's `Err`.
        #[tokio::test]
        async fn the_remote_tip_read_tells_absent_from_corrupt() {
            let f = fixture("rr-tip-read").await;
            let state = AppState::default();
            let check = || remote_rename_check(&state, &f.repo, "old", Some("new"), "origin", None);
            let clear = RemoteRenameCheck::Clear {
                old_tip: f.old.clone(),
            };
            assert_eq!(check().await.unwrap(), clear, "held and contained");

            let c2 = second_clone(&f).await;
            commit(&c2, "remote only").await;
            run(&c2, &["push", "-q", "origin", "old"]).await;
            let ahead_tip = remote_tip(&f, "old").await.unwrap();
            assert!(
                !git_ok(&f.repo, &["cat-file", "-e", &ahead_tip]).await,
                "fixture: the remote tip is absent here"
            );
            let ahead = RemoteRenameCheck::Refused {
                refusal: RemoteRenameRefusal::RemoteAhead,
            };
            assert_eq!(check().await.unwrap(), ahead, "absent");

            let loose = std::path::Path::new(&f.repo)
                .join(".git/objects")
                .join(&ahead_tip[..2])
                .join(&ahead_tip[2..]);
            std::fs::create_dir_all(loose.parent().unwrap()).unwrap();
            std::fs::write(&loose, "garbage").unwrap();
            let read = check().await;
            assert!(
                matches!(&read, Err(AppError::Git { .. })),
                "corrupt: {read:?}"
            );
        }

        /// The check reads the fetch URL past the remote URL cache, so a `set-url` made
        /// since a cached read is the URL it compares with the live push URL.
        #[tokio::test]
        async fn the_check_reads_the_fetch_url_uncached() {
            let f = fixture("rr-url-uncached").await;
            let moved = format!("{}/moved.git", f.base);
            run(&f.base, &["clone", "-q", "--bare", &f.bare, &moved]).await;
            let url = || crate::git::remote::git_remote_url(f.repo.clone(), "origin".into());
            let cached = url().await.unwrap();
            run(&f.repo, &["remote", "set-url", "origin", &moved]).await;
            assert_eq!(
                url().await.unwrap(),
                cached,
                "fixture: the cache answers the old URL"
            );
            let state = AppState::default();
            let check = remote_rename_check(&state, &f.repo, "old", Some("new"), "origin", None);
            let clear = RemoteRenameCheck::Clear {
                old_tip: f.old.clone(),
            };
            assert_eq!(check.await.unwrap(), clear);
        }

        /// Under `push.followTags`, a tag the remote refuses fails neither the push nor the
        /// delete: both carry `--no-follow-tags`.
        #[tokio::test]
        async fn follow_tags_never_fails_a_rename_that_landed() {
            let f = fixture("rr-follow-tags").await;
            run(&f.repo, &["config", "push.followTags", "true"]).await;
            run(&f.repo, &["tag", "-a", "v-follow", "-m", "v", &f.old]).await;
            let hook = std::path::Path::new(&f.bare).join("hooks").join("update");
            std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
            std::fs::write(
                &hook,
                "#!/bin/sh\ncase \"$1\" in refs/tags/*) echo no tags >&2; exit 1;; esac\nexit 0\n",
            )
            .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            let outcome = act(&f, "new", None).await;
            assert!(
                matches!(outcome, RemoteRenameOutcome::Renamed { warning: None }),
                "{outcome:?}"
            );
            assert_eq!(remote_tip(&f, "old").await, None);
            assert_eq!(remote_tip(&f, "new").await, Some(f.old.clone()));
            assert_eq!(
                config_get(&f.repo, "branch.new.merge").await,
                "refs/heads/new"
            );
            assert_eq!(full_ref_tip(&f.bare, "refs/tags/v-follow").await, None);
        }

        /// A branch moved back before the push leaves the old remote branch alone.
        #[tokio::test]
        async fn a_push_missing_the_old_tip_keeps_the_old_branch() {
            let f = fixture("rr-notinpush").await;
            let (repo, main) = (f.repo.clone(), f.main.clone());
            let hook = hook_at(RemoteRenamePhase::BeforePush, move || {
                let (repo, main) = (repo.clone(), main.clone());
                async move {
                    run(&repo, &["update-ref", "refs/heads/new", &main]).await;
                }
            });
            let outcome = act_hooked(&f, hook).await;
            assert!(
                matches!(
                    outcome,
                    RemoteRenameOutcome::OldKept {
                        cause: OldKeptCause::NotInPush,
                        ..
                    }
                ),
                "{outcome:?}"
            );
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert_eq!(remote_tip(&f, "new").await, Some(f.main.clone()));
        }

        const LOST_UPSTREAM: &str = "Couldn't set new's upstream to origin/new.";

        /// Holds `.git/config.lock` from `BeforePush` through the push's return, so the
        /// `-u` lands while its upstream write and the push's own repair both lose; the
        /// lock is released at `AfterPush`. `move_back` resets `new` one commit back before
        /// the push; `dead_url` then points `origin` at a missing repository.
        fn lost_upstream_hook(
            f: &Fixture,
            move_back: bool,
            dead_url: bool,
        ) -> RemoteRenamePhaseHook {
            let (repo, main, base) = (f.repo.clone(), f.main.clone(), f.base.clone());
            Arc::new(move |phase| {
                let (repo, main, base) = (repo.clone(), main.clone(), base.clone());
                Box::pin(async move {
                    match phase {
                        RemoteRenamePhase::BeforePush => {
                            crate::git::runner::hold_config_lock(&repo);
                            if move_back {
                                run(&repo, &["update-ref", "refs/heads/new", &main]).await;
                            }
                        }
                        RemoteRenamePhase::AfterPush => {
                            let lock = std::path::Path::new(&repo).join(".git/config.lock");
                            std::fs::remove_file(lock).expect("the held config.lock");
                            if dead_url {
                                let dead = format!("{base}/missing.git");
                                run(&repo, &["remote", "set-url", "origin", &dead]).await;
                                crate::git::remote::invalidate_remote_url_cache(&repo, "origin");
                            }
                        }
                        RemoteRenamePhase::BeforeDelete => {}
                    }
                })
            })
        }

        /// A `-u` that lost the config lock leaves `new` tracking `origin/old`, whose
        /// tracking ref still holds the old tip; the proof must not take it for the push.
        #[tokio::test]
        async fn a_lost_upstream_is_never_the_containment_proof() {
            let f = fixture("rr-lost-back").await;
            let outcome = act_hooked(&f, lost_upstream_hook(&f, true, false)).await;
            assert_eq!(
                config_get(&f.repo, "branch.new.merge").await,
                "refs/heads/old",
                "the upstream write was lost"
            );
            let RemoteRenameOutcome::OldKept {
                warning: Some(warning),
                cause: OldKeptCause::NotInPush,
            } = &outcome
            else {
                panic!("{outcome:?}");
            };
            assert_eq!(warning, LOST_UPSTREAM);
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert_eq!(remote_tip(&f, "new").await, Some(f.main.clone()));

            let g = fixture_beside(&f, "rr-lost-kept").await;
            let outcome = act_hooked(&g, lost_upstream_hook(&g, false, false)).await;
            let RemoteRenameOutcome::Renamed {
                warning: Some(warning),
            } = &outcome
            else {
                panic!("{outcome:?}");
            };
            assert_eq!(warning, LOST_UPSTREAM);
            assert_eq!(remote_tip(&g, "old").await, None);
            assert_eq!(remote_tip(&g, "new").await, Some(g.old.clone()));
        }

        /// A live read that fails leaves the proof unknown: nothing is deleted.
        #[tokio::test]
        async fn an_unverified_push_keeps_the_old_branch() {
            let f = fixture("rr-unverified").await;
            let outcome = act_hooked(&f, lost_upstream_hook(&f, false, true)).await;
            set_url(&f, &f.bare).await;
            let RemoteRenameOutcome::OldKept {
                warning: Some(warning),
                cause: OldKeptCause::Unverified,
            } = &outcome
            else {
                panic!("{outcome:?}");
            };
            assert_eq!(warning, LOST_UPSTREAM);
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert_eq!(remote_tip(&f, "new").await, Some(f.old.clone()));
        }

        /// The lease tells a moved old branch from a deleted one.
        #[tokio::test]
        async fn the_lease_tells_a_moved_old_branch_from_a_deleted_one() {
            let f = fixture("rr-moved").await;
            let c2 = second_clone(&f).await;
            let hook = hook_at(RemoteRenamePhase::BeforeDelete, move || {
                let c2 = c2.clone();
                async move {
                    commit(&c2, "moved").await;
                    run(&c2, &["push", "-q", "origin", "old"]).await;
                }
            });
            let outcome = act_hooked(&f, hook).await;
            assert!(
                matches!(
                    outcome,
                    RemoteRenameOutcome::OldKept {
                        cause: OldKeptCause::Moved,
                        ..
                    }
                ),
                "{outcome:?}"
            );
            assert!(remote_tip(&f, "old").await.is_some_and(|tip| tip != f.old));
            assert_eq!(remote_tip(&f, "new").await, Some(f.old.clone()));

            let g = fixture_beside(&f, "rr-gone").await;
            let bare = g.bare.clone();
            let hook = hook_at(RemoteRenamePhase::BeforeDelete, move || {
                let bare = bare.clone();
                async move {
                    run(&bare, &["update-ref", "-d", "refs/heads/old"]).await;
                }
            });
            let outcome = act_hooked(&g, hook).await;
            assert!(
                matches!(outcome, RemoteRenameOutcome::Renamed { .. }),
                "{outcome:?}"
            );
            assert_eq!(full_ref_tip(&g.repo, "refs/remotes/origin/old").await, None);
            assert_eq!(remote_tip(&g, "new").await, Some(g.old.clone()));

            // The lease names its tip: an implicit one would read the tracking ref, which a
            // fetch moved to the new tip, and delete the moved branch.
            let h = fixture_beside(&f, "rr-moved-fetched").await;
            let (c3, repo) = (second_clone(&h).await, h.repo.clone());
            let moved_in = c3.clone();
            let hook = hook_at(RemoteRenamePhase::BeforeDelete, move || {
                let (c3, repo) = (c3.clone(), repo.clone());
                async move {
                    commit(&c3, "moved").await;
                    run(&c3, &["push", "-q", "origin", "old"]).await;
                    run(&repo, &["fetch", "-q", "origin"]).await;
                }
            });
            let outcome = act_hooked(&h, hook).await;
            assert!(
                matches!(
                    outcome,
                    RemoteRenameOutcome::OldKept {
                        cause: OldKeptCause::Moved,
                        ..
                    }
                ),
                "{outcome:?}"
            );
            let moved = full_ref_tip(&moved_in, "refs/heads/old").await;
            assert!(moved.is_some() && moved != Some(h.old.clone()));
            let tracking = full_ref_tip(&h.repo, "refs/remotes/origin/old").await;
            assert_eq!(tracking, moved, "fixture: the fetch moved the tracking ref");
            assert_eq!(remote_tip(&h, "old").await, moved);
        }

        /// The remote's own refusal comes back verbatim, without its padding.
        #[tokio::test]
        async fn a_remote_that_denies_deletes_keeps_the_old_branch() {
            let f = fixture("rr-deny").await;
            run(&f.bare, &["config", "receive.denyDeletes", "true"]).await;
            let outcome = act(&f, "new", None).await;
            let RemoteRenameOutcome::OldKept {
                cause: OldKeptCause::Rejected { detail },
                ..
            } = &outcome
            else {
                panic!("{outcome:?}");
            };
            assert_eq!(detail, "error: denying ref deletion for refs/heads/old");
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert_eq!(remote_tip(&f, "new").await, Some(f.old.clone()));
        }

        /// The proof reads the live tip under a remapped fetch refspec and under one that
        /// does not cover `new`; the `-u` still writes the remapped tracking ref.
        #[tokio::test]
        async fn the_containment_proof_follows_the_fetch_refspec() {
            let f = fixture("rr-mapped").await;
            let fetch = "+refs/heads/*:refs/remotes/origin/mapped/*";
            run(
                &f.repo,
                &["config", "--replace-all", "remote.origin.fetch", fetch],
            )
            .await;
            run(
                &f.repo,
                &["update-ref", "refs/remotes/origin/mapped/old", &f.old],
            )
            .await;
            run(&f.repo, &["update-ref", "-d", "refs/remotes/origin/old"]).await;
            let mapped = act(&f, "new", None).await;

            let g = fixture_beside(&f, "rr-narrow").await;
            let fetch = "+refs/heads/old:refs/remotes/origin/old";
            run(
                &g.repo,
                &["config", "--replace-all", "remote.origin.fetch", fetch],
            )
            .await;
            let narrow = act(&g, "new", None).await;
            // The narrow `new` reads untracked by its atoms while its config is right, so
            // the live read proves it and no lost-upstream warning is added.
            assert!(
                matches!(
                    (&mapped, &narrow),
                    (
                        RemoteRenameOutcome::Renamed { warning: None },
                        RemoteRenameOutcome::Renamed { warning: None }
                    )
                ),
                "mapped: {mapped:?}; narrow: {narrow:?}"
            );
            assert_eq!(config_get(&g.repo, "branch.new.remote").await, "origin");
            assert_eq!(
                config_get(&g.repo, "branch.new.merge").await,
                "refs/heads/new"
            );
            let narrow_line = super::super::read_branch_upstream(&g.repo, "new")
                .await
                .unwrap();
            assert!(
                narrow_line
                    .as_ref()
                    .is_none_or(|up| up.tracking_ref.is_empty()),
                "{narrow_line:?}"
            );
            assert_eq!(full_ref_tip(&f.repo, "refs/remotes/origin/new").await, None);
            assert_eq!(
                full_ref_tip(&f.repo, "refs/remotes/origin/mapped/new").await,
                Some(f.old.clone())
            );
            assert_eq!(remote_tip(&f, "old").await, None);
            assert_eq!(remote_tip(&g, "new").await, Some(g.old.clone()));
            assert_eq!(remote_tip(&g, "old").await, None);
        }

        /// The live arm of the proof: a missing row and a listed commit absent here both
        /// read as not proven.
        #[tokio::test]
        async fn the_live_proof_needs_an_exact_row_and_a_local_commit() {
            let f = fixture("rr-live").await;
            assert_eq!(
                live_pushed_tip(&f.repo, "origin", "nope").await,
                None,
                "no row"
            );
            let c2 = second_clone(&f).await;
            commit(&c2, "ghost").await;
            run(&c2, &["push", "-q", "origin", "old:refs/heads/ghost"]).await;
            assert_eq!(
                live_pushed_tip(&f.repo, "origin", "ghost").await,
                None,
                "absent here"
            );
            assert_eq!(
                pushed_branch_contains(&f.repo, "origin", "ghost", &f.old).await,
                (PushedCopy::Unknown, false)
            );
            assert_eq!(
                live_pushed_tip(&f.repo, "origin", "old").await,
                Some(f.old.clone())
            );
        }
    }
}
