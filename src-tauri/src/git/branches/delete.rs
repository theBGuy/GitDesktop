use super::*;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        aliased_current_fixture, aliasing_fixture, branch_exists, branch_section, delete,
        delete_fixture, diverged_local_upstream, full_ref_tip, is_aliased, keep_local_repo,
        local_tip, packed_twin_fixture, repo_with_branch_settings, run, temp_base,
    };
    use crate::git::runner::{
        hold_config_lock, release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK,
        CONFIG_WRITE_LOCK_EVENTS, GIT_SPAWN_LOG, TEST_GIT_HANG_GUARD,
    };
    use std::sync::Arc;
    use std::time::Duration;

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
}
