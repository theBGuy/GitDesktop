use super::*;

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
pub(super) async fn worktree_holding_branch(repo_path: &str, name: &str) -> Option<String> {
    worktree_holding_branch_checked(repo_path, name)
        .await
        .ok()
        .flatten()
}

/// [`worktree_holding_branch`] with a failed `worktree list` reported as an `Err`, for
/// a caller with no git refusal behind it to fall back on.
pub(super) async fn worktree_holding_branch_checked(repo_path: &str, name: &str) -> AppResult<Option<String>> {
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
pub(super) struct GitDirs {
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
pub(super) async fn clear_update_holder(
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
pub(super) async fn update_holder_refusal(
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

/// The refusal for a branch checked out in a linked worktree; a test pins its wording.
pub(super) fn checked_out_elsewhere(name: &str, path: &str) -> AppError {
    AppError::Command(format!(
        "{name} is checked out in the worktree at {path} — remove that worktree \
         (or switch it to another branch) before deleting {name}."
    ))
}

/// [`delete_branch_ref_at`]'s guards, in order: an update marker claiming `name`, a
/// linked worktree holding it, the current branch, a checkout whose HEAD was `tip` in the
/// previous pass and changed since, or that arrived on or switched onto a case variant of
/// the name, a rebase or bisect working on it. Shared by both passes so they refuse alike;
/// a failed read is the `Err` too. The marker read heals nothing and reads no ref. Each
/// pass lists the worktrees afresh; `git_dirs` is resolved by the first pass that reaches
/// the operation check and reused after it, and `heads` carries each pass's stanzas
/// (path, HEAD and branch line) to the next.
pub(super) async fn refuse_if_branch_in_use(
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
pub(super) struct ListedHead {
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

/// The `holder` of the publish hold's `Busy`.
pub(super) const PUBLISH_HOLDER: &str = "a repository publish";

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        branch_exists, branch_section, delete, delete_fixture, full_ref_tip, init_repo, is_aliased,
        keep_local_repo, local_tip, run, temp_base,
    };
    use std::time::Duration;

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
}
