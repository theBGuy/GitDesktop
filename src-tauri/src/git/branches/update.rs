use super::*;

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

/// A process-unique suffix for the throwaway worktree directory name.
fn unique_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), nanos)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        aliased_current_fixture, assert_twins_intact, commit_file, delete_fixture, full_ref_tip,
        held_spelling_fixture, holder_marker_root, init_repo, is_aliased, packed_twin_fixture, run,
        temp_base, twin_checkout, worktree_listed, TWIN_REFUSAL,
    };
    use crate::git::runner::TEST_GIT_HANG_GUARD;
    use std::time::Duration;

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
        crate::test_exec::write_executable(
            &hook,
            &format!(
                "#!/bin/sh\necho fired > \"{}\"\nexit 1\n",
                sentinel.to_string_lossy().replace('\\', "/")
            ),
        );

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

    /// The `gd-update-*` entries under a marker root: a settled holder update leaves none.
    fn marker_leftovers(root: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(root)
            .expect("the marker root is readable")
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|name| name.starts_with("gd-update-"))
            .collect()
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
}
