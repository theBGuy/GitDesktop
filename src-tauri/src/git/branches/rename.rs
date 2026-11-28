use super::*;

/// What a completed rename reports beyond success.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameBranchOutcome {
    /// Set when the local-PR migration could not complete after git renamed the
    /// branch — the rename itself succeeded. Shown verbatim in the GUI success
    /// toast's description and appended to the MCP text.
    pub warning: Option<String>,
}

/// Refuses a rename into or out of the agent-session namespace, compared
/// case-insensitively: a case-insensitive filesystem can land `GD/Session/x` inside
/// an existing `gd/session/` ref folder.
pub(super) fn refuse_session_rename(old_name: &str, new_name: &str) -> AppResult<()> {
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

/// git's text when `branch -m` moved the ref but lost `.git/config.lock`: exit 128,
/// `branch.<old>.*` left under the old name (measured, git 2.51.1, C locale).
pub(super) const RENAMED_CONFIG_LEFT_BEHIND: &str = "branch is renamed, but update of config-file failed";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        branch_exists, branch_section, case_twin_alias_oracle, case_twin_listed,
        case_twin_snapshot, commit_file, full_ref_tip, hold_config_mutex, holder_marker_root,
        init_repo, keep_local_repo, on_first_waiting, repo_with_branch_settings, run,
        symbolic_head, temp_base,
    };
    use crate::git::runner::{
        hold_config_lock, release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK,
        CONFIG_WRITE_LOCK_EVENTS, TEST_GIT_HANG_GUARD,
    };
    use std::sync::Arc;
    use std::time::Duration;

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
}
