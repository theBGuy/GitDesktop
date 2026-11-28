use super::*;

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
pub(super) async fn branch_reset_to_upstream_within(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        aliased_current_fixture, assert_twins_intact, delete_fixture, diverged_local_upstream,
        full_ref_tip, held_spelling_fixture, init_repo, is_aliased, local_tip, packed_twin_fixture,
        run, temp_base, twin_checkout, TWIN_REFUSAL,
    };
    use crate::git::runner::{GIT_SPAWN_LOG, TEST_GIT_HANG_GUARD};
    use std::sync::Arc;

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
}
