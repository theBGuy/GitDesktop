use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::history::{parse_commit_log, LOG_FORMAT};
use crate::git::runner::{
    acquire_repo_lock, holder_label, run_git, run_git_config_write_held, run_git_mutating_raw,
    run_git_raw, run_git_raw_index_retry, with_config_write_lock, GitOutput, DEFAULT_TIMEOUT,
    LOCK_WAIT_TIMEOUT,
};
use crate::git::types::{CommitAuthor, CommitResult, CommitSummary};
use crate::state::AppState;

/// The identity `git commit` would use in this repo (config user.name /
/// user.email, empty when unset) — lets the UI keep the author out of the
/// co-author suggestions.
#[tauri::command]
pub async fn git_user_identity(repo_path: String) -> AppResult<CommitAuthor> {
    async fn config_value(repo: &str, key: &str) -> String {
        run_git_raw(Some(repo), &["config", "--get", key], DEFAULT_TIMEOUT)
            .await
            .ok()
            .filter(|o| o.code == 0)
            .map(|o| o.stdout_lossy().trim().to_string())
            .unwrap_or_default()
    }
    Ok(CommitAuthor {
        name: config_value(&repo_path, "user.name").await,
        email: config_value(&repo_path, "user.email").await,
    })
}

/// The repo-local identity override (`git config --local user.name/email`),
/// empty strings when there's no override — the repo then uses the global one.
#[tauri::command]
pub async fn git_local_identity(repo_path: String) -> AppResult<CommitAuthor> {
    async fn get(repo: &str, key: &str) -> String {
        run_git_raw(
            Some(repo),
            &["config", "--local", "--get", key],
            DEFAULT_TIMEOUT,
        )
        .await
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| o.stdout_lossy().trim().to_string())
        .unwrap_or_default()
    }
    Ok(CommitAuthor {
        name: get(&repo_path, "user.name").await,
        email: get(&repo_path, "user.email").await,
    })
}

/// Sets or clears the repo-local identity override. A blank name and email
/// clears it (the repo falls back to the global identity); otherwise both are
/// required, so commits never get a half-set author.
///
/// Both keys are written under ONE hold of the config-write mutex, each with its
/// lost-lock retry: no other writer holding that mutex lands between them, and a lock
/// held through the retry fails the first key before the second is touched. A writer
/// outside the mutex (another process, or a long command's unprotected first run here)
/// that takes the lock after `user.name` lands and outlasts `user.email`'s retry still
/// leaves the new name with the old email, reported as git's error.
///
/// Each key is set with `--replace-all`: a plain set exits 5 on a multi-valued key
/// having written nothing (measured, git 2.51.1), so a duplicated entry would block
/// every save.
#[tauri::command]
pub async fn git_set_local_identity(
    repo_path: String,
    name: String,
    email: String,
) -> AppResult<()> {
    let repo = repo_path.as_str();
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() && email.is_empty() {
        return with_config_write_lock(repo, |held| async move {
            for key in ["user.name", "user.email"] {
                // `--unset-all`: a plain `--unset` exits 5 on a multi-valued key having
                // removed nothing, which would read as already clear (measured, git
                // 2.51.1). Exit 5 here is a key that was never set.
                let args = ["config", "--local", "--unset-all", key];
                let out = run_git_config_write_held(&held, repo, &args, DEFAULT_TIMEOUT).await?;
                if out.code != 5 {
                    out.exit_verdict()?;
                }
            }
            Ok(())
        })
        .await;
    }
    for (value, what) in [(name, "name"), (email, "email")] {
        if value.is_empty() || value.starts_with('-') {
            return Err(crate::error::AppError::InvalidArgument(format!(
                "invalid {what}: {value}"
            )));
        }
    }
    with_config_write_lock(repo, |held| async move {
        for (key, value) in [("user.name", name), ("user.email", email)] {
            let args = ["config", "--local", "--replace-all", key, value];
            run_git_config_write_held(&held, repo, &args, DEFAULT_TIMEOUT)
                .await?
                .exit_verdict()?;
        }
        Ok(())
    })
    .await
}

/// The global git identity (`git config --global`), empty strings when unset.
#[tauri::command]
pub async fn git_global_identity() -> AppResult<CommitAuthor> {
    async fn get(key: &str) -> String {
        run_git_raw(None, &["config", "--global", "--get", key], DEFAULT_TIMEOUT)
            .await
            .ok()
            .filter(|o| o.code == 0)
            .map(|o| o.stdout_lossy().trim().to_string())
            .unwrap_or_default()
    }
    Ok(CommitAuthor {
        name: get("user.name").await,
        email: get("user.email").await,
    })
}

/// Writes the global git identity — the author for new commits in every
/// repo without a local override. `--replace-all` for the same multi-valued-key
/// reason as [`git_set_local_identity`].
#[tauri::command]
pub async fn git_set_global_identity(name: String, email: String) -> AppResult<()> {
    let name = name.trim();
    let email = email.trim();
    for (value, what) in [(name, "name"), (email, "email")] {
        if value.is_empty() || value.starts_with('-') {
            return Err(crate::error::AppError::InvalidArgument(format!(
                "invalid {what}: {value}"
            )));
        }
    }
    run_git(
        None,
        &["config", "--global", "--replace-all", "user.name", name],
        DEFAULT_TIMEOUT,
    )
    .await?;
    run_git(
        None,
        &["config", "--global", "--replace-all", "user.email", email],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// The global default branch (`git config --global init.defaultBranch`) — the
/// name `git init` gives the first branch of a new repo, here and on the command
/// line. Empty when unset (git then uses its built-in default).
#[tauri::command]
pub async fn git_global_default_branch() -> AppResult<String> {
    Ok(run_git_raw(
        None,
        &["config", "--global", "--get", "init.defaultBranch"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .filter(|o| o.code == 0)
    .map(|o| o.stdout_lossy().trim().to_string())
    .unwrap_or_default())
}

/// Writes the global default branch — the branch `git init` gives new
/// repositories, so GitDesktop and a command-line `git init` agree.
#[tauri::command]
pub async fn git_set_global_default_branch(branch: String) -> AppResult<()> {
    let branch = branch.trim();
    crate::git::branches::validate_ref_name(branch)?;
    run_git(
        None,
        &["config", "--global", "init.defaultBranch", branch],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Distinct commit authors across all refs, most recent first — co-author
/// suggestions for the commit box. Capped so huge repos stay fast.
#[tauri::command]
pub async fn git_commit_authors(repo_path: String) -> AppResult<Vec<CommitAuthor>> {
    let out = run_git_raw(
        Some(&repo_path),
        &["log", "--all", "-n", "500", "--format=%an%x00%ae"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    // A repo with no commits yet has no authors to suggest.
    if out.code != 0 {
        return Ok(Vec::new());
    }
    let text = out.stdout_lossy();
    let mut seen = std::collections::HashSet::new();
    let mut authors = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(2, '\0');
        let (Some(name), Some(email)) = (parts.next(), parts.next()) else {
            continue;
        };
        if email.is_empty() || name.is_empty() {
            continue;
        }
        if seen.insert(email.to_lowercase()) {
            authors.push(CommitAuthor {
                name: name.to_string(),
                email: email.to_string(),
            });
        }
    }
    Ok(authors)
}

/// What HEAD must name, beside its oid, for a pinned rewrite to run: an oid alone can't
/// see a switch to another branch at the same commit, which would rewrite THAT branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ExpectedRef {
    /// Unpinned: the MCP tools pin the commit id only.
    Any,
    /// HEAD detached, on no branch.
    Detached,
    /// HEAD on this branch (the short name).
    Branch(String),
}

impl ExpectedRef {
    /// The IPC form: the branch's short name, or `HEAD` for a detached HEAD (git refuses
    /// a branch named `HEAD`, so the two never collide). Absent means unpinned.
    pub(crate) fn from_wire(wire: Option<String>) -> AppResult<Self> {
        match wire {
            None => Ok(Self::Any),
            Some(head) if head == "HEAD" => Ok(Self::Detached),
            Some(name) => {
                crate::git::branches::validate_branch_name(&name)?;
                Ok(Self::Branch(name))
            }
        }
    }

    /// Whether HEAD names something else now; run under the caller's hold. A
    /// `symbolic-ref` that fails for any reason but a detached HEAD is an `Err`.
    pub(crate) async fn moved(&self, repo_path: &str) -> AppResult<bool> {
        let wanted = match self {
            Self::Any => return Ok(false),
            Self::Detached => None,
            Self::Branch(name) => Some(name.as_str()),
        };
        Ok(crate::git::branches::current_branch_name(repo_path)
            .await?
            .as_deref()
            != wanted)
    }
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, AppState>,
    repo_path: String,
    title: String,
    body: Option<String>,
    amend: bool,
    expected_head: Option<String>,
    expected_branch: Option<String>,
) -> AppResult<CommitResult> {
    let expected_ref = ExpectedRef::from_wire(expected_branch)?;
    git_commit_core_expecting(
        &state,
        repo_path,
        title,
        body,
        amend,
        expected_head,
        expected_ref,
    )
    .await
}

/// The refusal an amend gets when HEAD is no longer the commit the user chose.
/// KEEP IN STEP: one wording family with `AMEND_BRANCH_SWITCHED`, the undo pair below
/// and ops.rs's reset pair ("… — nothing was <verb>.").
const AMEND_HEAD_MOVED: &str = "The latest commit changed — nothing was amended.";

/// The refusal an amend gets when HEAD sits on another branch (or none) than the one
/// the user chose, even at the same commit.
const AMEND_BRANCH_SWITCHED: &str = "The checked-out branch changed — nothing was amended.";

/// The unpinned form, kept for test fixtures: every production route passes its pin
/// (or its absence) to [`git_commit_core_expecting`] explicitly.
#[cfg(test)]
pub(crate) async fn git_commit_core(
    state: &AppState,
    repo_path: String,
    title: String,
    body: Option<String>,
    amend: bool,
) -> AppResult<CommitResult> {
    git_commit_core_expecting(state, repo_path, title, body, amend, None, ExpectedRef::Any).await
}

/// `expected_head` is consulted only when `amend` is set: the amend then runs only
/// if HEAD is still that full oid, and on `expected_ref`'s branch (or detached, as it
/// says), both checked under the same working-tree hold as the commit. The hold
/// serializes this process only, so a separate process can still move HEAD in the
/// milliseconds between the check and the commit spawn.
pub(crate) async fn git_commit_core_expecting(
    state: &AppState,
    repo_path: String,
    title: String,
    body: Option<String>,
    amend: bool,
    expected_head: Option<String>,
    expected_ref: ExpectedRef,
) -> AppResult<CommitResult> {
    // git's own conflict advice offers `git commit` as the way to conclude a
    // cherry-pick, and the commit box has no mid-op gate, so this route ends picks
    // that never reach `op_continue`. The probe is stat-level because every commit
    // pays it, and the journal read below runs only when a pick really was stopped.
    let was_cherry_picking = crate::git::ops::cherry_pick_marker_present(&repo_path);

    let mut args = vec!["commit"];
    if amend {
        args.push("--amend");
    }
    args.extend(["-m", title.as_str()]);
    let body = body.filter(|b| !b.trim().is_empty());
    if let Some(body) = &body {
        args.extend(["-m", body.as_str()]);
    }
    // Raw: a refusing `commit` writes its whole report to stdout and leaves
    // stderr EMPTY (measured, git 2.51.1) — this is the commit box's own error
    // path, so "git exited with code 1" would be the user's only explanation.
    let commit = match expected_head.filter(|_| amend) {
        // The guard drops at the block's end, so the pick-close below takes its
        // store locks outside the working-tree hold.
        Some(expected) => {
            let domain = state.working_tree_lock(&repo_path).await;
            let _guard =
                acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, holder_label("commit")).await?;
            if expected_ref.moved(&repo_path).await? {
                return Err(AppError::Git {
                    code: 1,
                    stderr: AMEND_BRANCH_SWITCHED.to_string(),
                });
            }
            let current =
                run_git_raw(Some(&repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT).await?;
            // A non-zero exit is an unborn HEAD: nothing the user chose is there.
            if current.code != 0 || current.stdout_lossy().trim() != expected {
                return Err(AppError::Git {
                    code: 1,
                    stderr: AMEND_HEAD_MOVED.to_string(),
                });
            }
            run_git_raw_index_retry(&repo_path, &args, DEFAULT_TIMEOUT).await?
        }
        None => run_git_mutating_raw(state, &repo_path, &args, DEFAULT_TIMEOUT).await?,
    };
    if commit.code != 0 {
        return Err(AppError::Git {
            code: commit.code,
            stderr: commit.full_failure_text(),
        });
    }
    // The widest of the close routes, and the loosest: this is also the MCP commit
    // tool's choke point, and ANY commit that clears a `CHERRY_PICK_HEAD` fires it —
    // so a plain unjournaled `cherry-pick` resolved here closes whatever paused
    // record the repo still holds. Wrong only when a stale record predates it, and
    // only until a `git_oplog_check` that finds no pick in progress retires it.
    if was_cherry_picking && !crate::git::ops::cherry_pick_marker_present(&repo_path) {
        crate::oplog::close_paused_pick(&repo_path, crate::oplog::PausedOutcome::Continued).await;
    }
    let out = run_git(Some(&repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT).await?;
    Ok(CommitResult {
        hash: out.stdout_lossy().trim().to_string(),
    })
}

/// The refusal an undo gets when HEAD is no longer the commit the user chose.
/// KEEP IN STEP: this exact sentence is the one wording for a moved-HEAD undo on
/// every route (GUI toast, MCP tool error); ops.rs and branches.rs carry the
/// reset twins of its "… — nothing was <verb>." shape.
const UNDO_HEAD_MOVED: &str = "The latest commit changed — nothing was undone.";

/// The refusal an undo gets when HEAD sits on another branch (or none) than the one
/// the user saw, even at the same commit. KEEP IN STEP with the family above.
const UNDO_BRANCH_SWITCHED: &str = "The checked-out branch changed — nothing was undone.";

/// The refusal for a detached HEAD at a parentless commit: `update-ref -d HEAD`
/// there deletes `.git/HEAD` itself and git stops recognizing the repository
/// (measured, git 2.51.1).
/// KEEP IN STEP: HistoryPanel.tsx's `UNDO_DETACHED_ROOT` toasts this exact sentence on
/// the hotkey and palette routes; its menu item shows a short form.
const UNDO_DETACHED_ROOT: &str =
    "HEAD is detached at the repository's first commit — nothing to undo onto.";

/// The refusal for a shallow clone's boundary commit: its parent is recorded but was
/// never fetched, so `HEAD~1` can't resolve, and the root arm would delete the branch.
const UNDO_SHALLOW_BOUNDARY: &str =
    "The latest commit's parent isn't in this shallow clone — nothing was undone.";

#[tauri::command]
pub async fn git_undo_commit(
    state: State<'_, AppState>,
    repo_path: String,
    expected_head: String,
    expected_branch: String,
) -> AppResult<()> {
    let expected_ref = ExpectedRef::from_wire(Some(expected_branch))?;
    git_undo_commit_core(&state, repo_path, Some(expected_head), expected_ref).await
}

/// Undoes the latest commit, keeping its changes staged (soft reset). A root commit
/// has no parent to reset to, so the branch ref is deleted instead, leaving the repo
/// in the pre-first-commit state.
///
/// Every read and the mutation share one working-tree hold. With `expected_head`
/// the undo runs only while HEAD is still that full oid, and with `expected_ref` only
/// while HEAD names that branch (or none); `None` and `Any` (the MCP default)
/// undo whatever HEAD is, though the root deletion still compares-and-swaps on
/// the oid read under the hold. A separate process can still move HEAD in the
/// milliseconds before the soft reset spawns, the window the amend pin accepts.
pub(crate) async fn git_undo_commit_core(
    state: &AppState,
    repo_path: String,
    expected_head: Option<String>,
    expected_ref: ExpectedRef,
) -> AppResult<()> {
    let moved = || AppError::Git {
        code: 1,
        stderr: UNDO_HEAD_MOVED.to_string(),
    };
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "an undo").await?;
    if expected_ref.moved(&repo_path).await? {
        return Err(AppError::Git {
            code: 1,
            stderr: UNDO_BRANCH_SWITCHED.to_string(),
        });
    }
    // `None` is an unborn HEAD: nothing a pin could name is there. Unpinned, it
    // falls through to the root arm unchanged, where git's update-ref is a no-op.
    let head = ref_oid(&repo_path, "HEAD").await?;
    if let Some(expected) = &expected_head {
        if head.as_deref() != Some(expected.as_str()) {
            return Err(moved());
        }
    }
    let has_parent = run_git_raw(
        Some(&repo_path),
        &["rev-parse", "--verify", "--quiet", "HEAD~1"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .code
        == 0;
    if has_parent {
        let out =
            run_git_raw_index_retry(&repo_path, &["reset", "--soft", "HEAD~1"], DEFAULT_TIMEOUT)
                .await?;
        if out.code != 0 {
            return Err(AppError::Git {
                code: out.code,
                stderr: out.full_failure_text(),
            });
        }
        return Ok(());
    }
    let head_oid = head.unwrap_or_default();
    // What the root arm deletes: the ref HEAD named under this hold; `None` when
    // unborn, where the arm deletes `HEAD` and git does nothing.
    let mut target: Option<String> = None;
    if !head_oid.is_empty() {
        // The raw object, not `rev-list --parents`: a shallow graft hides the parent
        // line from traversal but not from the commit itself (measured, git 2.51.1).
        let object = run_git_raw(
            Some(&repo_path),
            &["cat-file", "commit", &head_oid],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if object.code != 0 {
            return Err(AppError::Git {
                code: object.code,
                stderr: object.full_failure_text(),
            });
        }
        let text = object.stdout_lossy();
        let mut header = text.lines().take_while(|line| !line.is_empty());
        if header.any(|line| line.starts_with("parent ")) {
            return Err(AppError::Git {
                code: 1,
                stderr: UNDO_SHALLOW_BOUNDARY.to_string(),
            });
        }
        let attached = run_git_raw(
            Some(&repo_path),
            &["symbolic-ref", "-q", "HEAD"],
            DEFAULT_TIMEOUT,
        )
        .await?;
        // Fails closed: `-q` exits 1 exactly when HEAD is detached, and any other
        // failure refuses with git's own error rather than risk deleting HEAD itself.
        if attached.code == 1 {
            return Err(AppError::Git {
                code: 1,
                stderr: UNDO_DETACHED_ROOT.to_string(),
            });
        }
        if attached.code != 0 {
            return Err(AppError::Git {
                code: attached.code,
                stderr: attached.full_failure_text(),
            });
        }
        target = Some(attached.stdout_lossy().trim().to_string());
    }
    #[cfg(test)]
    undo_root_phase().await;
    // The old value (passed even unpinned) means a branch that just gained a commit is
    // never deleted; naming the ref means another process's switch can't redirect it.
    let out = match &target {
        None => {
            run_git_raw_index_retry(&repo_path, &["update-ref", "-d", "HEAD"], DEFAULT_TIMEOUT)
                .await?
        }
        Some(full_ref) => delete_root_ref(&repo_path, full_ref, &head_oid).await?,
    };
    if out.code != 0 {
        // A failed compare-and-swap reads as moved only when that ref really moved; a
        // stale ref `.lock` keeps git's own error.
        if let Some(full_ref) = &target {
            if ref_oid(&repo_path, full_ref).await?.as_deref() != Some(head_oid.as_str()) {
                return Err(moved());
            }
        }
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    Ok(())
}

#[cfg(test)]
type UndoRootHook = std::sync::Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync,
>;

#[cfg(test)]
tokio::task_local! {
    /// Awaited by the root undo it is scoped to, after `symbolic-ref` named the branch
    /// and before the delete, so a test can switch HEAD inside that window.
    static UNDO_ROOT_HOOK: UndoRootHook;
}

#[cfg(test)]
async fn undo_root_phase() {
    if let Ok(wait) = UNDO_ROOT_HOOK.try_with(|hook| hook()) {
        wait.await;
    }
}

/// The root undo's mutation: deletes `full_ref` only while it still points at `oid`.
/// Never `HEAD`: `update-ref` dereferences a symbolic HEAD when it runs, so a switch
/// that lands after the caller's checks would redirect the delete to another branch.
async fn delete_root_ref(repo_path: &str, full_ref: &str, oid: &str) -> AppResult<GitOutput> {
    run_git_raw_index_retry(
        repo_path,
        &["update-ref", "-d", full_ref, oid],
        DEFAULT_TIMEOUT,
    )
    .await
}

/// The oid `name` resolves to, `None` when it doesn't resolve.
async fn ref_oid(repo_path: &str, name: &str) -> AppResult<Option<String>> {
    let out = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--verify", "--quiet", name],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok((out.code == 0).then(|| out.stdout_lossy().trim().to_string()))
}

#[tauri::command]
pub async fn git_recent_commits(repo_path: String, limit: u32) -> AppResult<Vec<CommitSummary>> {
    let head_exists = run_git_raw(
        Some(&repo_path),
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .code
        == 0;
    if !head_exists {
        return Ok(Vec::new());
    }

    let limit_arg = limit.to_string();
    let out = run_git(
        Some(&repo_path),
        &["log", "-n", &limit_arg, LOG_FORMAT],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(parse_commit_log(&out.stdout_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// Every local value of `key`, empty when unset.
    async fn local_values(repo: &str, key: &str) -> Vec<String> {
        run_git_raw(
            Some(repo),
            &["config", "--local", "--get-all", key],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy()
        .lines()
        .map(str::to_string)
        .collect()
    }

    /// Under the held-lock seam, neither identity path leaves a half-set author: a
    /// first-attempt loss lands both keys through the retry (name: two attempts, then
    /// email: one), a lock held throughout fails before either key changes, and setting
    /// or clearing replaces or removes every value of a multi-valued key. Clearing what
    /// was never set is git's exit 5, a success.
    #[tokio::test]
    async fn the_identity_override_never_lands_half_set() {
        use crate::git::runner::{
            hold_config_lock, is_config_lock_contention, release_config_lock_before_attempt,
            CONFIG_WRITE_ATTEMPT_HOOK,
        };
        use std::sync::atomic::Ordering;
        let dir = tempfile::Builder::new()
            .prefix("gd-identity-")
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        run(&repo, &["init", "-q"]).await;
        let lock = dir.path().join(".git").join("config.lock");
        let identity = || async {
            (
                local_values(&repo, "user.name").await,
                local_values(&repo, "user.email").await,
            )
        };
        let set = |name: &str, email: &str| {
            git_set_local_identity(repo.clone(), name.into(), email.into())
        };

        git_set_local_identity(repo.clone(), String::new(), String::new())
            .await
            .expect("clearing a never-set override succeeds");

        hold_config_lock(dir.path());
        let (hook, attempts) = release_config_lock_before_attempt(lock.clone(), 2);
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(hook, set("Ann", "ann@t.local"))
            .await
            .expect("the set lands through the retry");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        let ann = (vec!["Ann".to_string()], vec!["ann@t.local".to_string()]);
        assert_eq!(identity().await, ann);

        hold_config_lock(dir.path());
        // The canary: a set or unset that loses the lock exits 255 with nothing changed.
        for args in [
            &["config", "--local", "user.name", "Bob"][..],
            &["config", "--local", "--replace-all", "user.name", "Bob"],
            &["config", "--local", "--unset-all", "user.name"],
        ] {
            let raw = run_git_raw(Some(&repo), args, DEFAULT_TIMEOUT)
                .await
                .unwrap();
            assert_eq!(raw.code, 255, "{args:?}: {}", raw.stderr);
            assert!(is_config_lock_contention(&raw.stderr), "{}", raw.stderr);
        }
        for result in [set("Bob", "bob@t.local").await, set("", "").await] {
            let err = result.expect_err("a lock held through the retry fails");
            assert!(
                matches!(&err, AppError::Git { stderr, .. } if is_config_lock_contention(stderr)),
                "{err:?}"
            );
            assert_eq!(identity().await, ann, "neither key changed");
        }
        std::fs::remove_file(&lock).unwrap();

        run(&repo, &["config", "--local", "--add", "user.name", "Extra"]).await;
        // Why the clear is `--unset-all`: plain `--unset` exits 5, the never-set code,
        // on a multi-valued key while removing nothing.
        let plain = run_git_raw(
            Some(&repo),
            &["config", "--local", "--unset", "user.name"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(plain.code, 5, "{}", plain.stderr);
        assert_eq!(local_values(&repo, "user.name").await, ["Ann", "Extra"]);
        // Why the set is `--replace-all`: a plain set exits 5 there too, writing nothing.
        let plain = run_git_raw(
            Some(&repo),
            &["config", "--local", "user.name", "Bob"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(plain.code, 5, "{}", plain.stderr);
        assert_eq!(local_values(&repo, "user.name").await, ["Ann", "Extra"]);
        set("Cara", "cara@t.local")
            .await
            .expect("the set replaces every value");
        assert_eq!(
            identity().await,
            (vec!["Cara".to_string()], vec!["cara@t.local".to_string()])
        );

        run(&repo, &["config", "--local", "--add", "user.name", "Extra"]).await;
        hold_config_lock(dir.path());
        let (hook, attempts) = release_config_lock_before_attempt(lock.clone(), 2);
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(hook, set("", ""))
            .await
            .expect("the clear lands through the retry");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert_eq!(identity().await, (vec![], vec![]), "no value survives");
    }

    /// The recent-commits list shares History's log format + parser, so its rows
    /// carry the `%D` tag decorations and the `%P` merge flag.
    #[tokio::test]
    async fn recent_commits_carry_tags_and_merge_flags() {
        let dir = tempfile::Builder::new()
            .prefix("gd-recent-commits-")
            .tempdir()
            .expect("create temp dir");
        let root = dir.path();
        let repo = root.to_string_lossy().into_owned();
        run(&repo, &["init", "-q"]).await;
        run(&repo, &["config", "user.email", "t@t.local"]).await;
        run(&repo, &["config", "user.name", "T"]).await;

        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "seed"]).await;
        // `git init` picks the default branch name from the host's config.
        let base_branch = run(&repo, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        run(&repo, &["checkout", "-qb", "feature"]).await;
        std::fs::write(root.join("feature.txt"), "feature\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "feature work"]).await;

        run(&repo, &["checkout", "-q", &base_branch]).await;
        std::fs::write(root.join("base.txt"), "base\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        run(&repo, &["commit", "-qm", "base work"]).await;
        run(&repo, &["tag", "v1.0"]).await;
        // `--no-ff` so the fixture has a real two-parent commit to report on.
        run(&repo, &["merge", "-q", "--no-ff", "--no-edit", "feature"]).await;

        let commits = git_recent_commits(repo.clone(), 10)
            .await
            .expect("the log reads");

        assert!(
            commits[0].is_merge,
            "the newest commit is the merge: {:?}",
            commits[0]
        );
        assert!(commits[0].tags.is_empty(), "the merge carries no tag");
        let tagged = commits
            .iter()
            .find(|c| c.subject == "base work")
            .expect("the tagged commit is in range");
        assert_eq!(tagged.tags, vec!["v1.0".to_string()]);
        assert!(!tagged.is_merge, "an ordinary commit has one parent");
    }

    /// A temp repo with a local identity, so commits work on any host config.
    async fn amend_fixture(prefix: &str, init_args: &[&str]) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        let mut init = vec!["init", "-q"];
        init.extend_from_slice(init_args);
        run(&repo, &init).await;
        run(&repo, &["config", "user.email", "t@t.local"]).await;
        run(&repo, &["config", "user.name", "T"]).await;
        (dir, repo)
    }

    /// Commits `file` with `subject` through raw git and returns the new HEAD.
    async fn raw_commit(dir: &tempfile::TempDir, repo: &str, file: &str, subject: &str) -> String {
        std::fs::write(dir.path().join(file), format!("{subject}\n")).unwrap();
        run(repo, &["add", "-A"]).await;
        run(repo, &["commit", "-qm", subject]).await;
        head(repo).await
    }

    async fn head(repo: &str) -> String {
        run(repo, &["rev-parse", "HEAD"]).await.trim().to_string()
    }

    async fn head_subject(repo: &str) -> String {
        run(repo, &["log", "-1", "--format=%s"])
            .await
            .trim()
            .to_string()
    }

    async fn amend_expecting(
        repo: &str,
        title: &str,
        expected: Option<String>,
    ) -> AppResult<CommitResult> {
        amend_on(repo, title, expected, ExpectedRef::Any).await
    }

    async fn amend_on(
        repo: &str,
        title: &str,
        expected: Option<String>,
        expected_ref: ExpectedRef,
    ) -> AppResult<CommitResult> {
        let state = AppState::default();
        git_commit_core_expecting(
            &state,
            repo.to_string(),
            title.to_string(),
            None,
            true,
            expected,
            expected_ref,
        )
        .await
    }

    fn assert_refused(result: AppResult<CommitResult>) {
        match result {
            Err(AppError::Git { stderr, .. }) => assert_eq!(stderr, AMEND_HEAD_MOVED),
            other => panic!("expected the head-moved refusal, got {other:?}"),
        }
    }

    /// The amend the user chose for A must not rewrite an outside commit B that
    /// became HEAD meanwhile. B carries a file: git itself refuses to amend past an
    /// empty commit, which would hide the defect.
    #[tokio::test]
    async fn amend_refuses_when_head_moved_and_leaves_head_alone() {
        let (dir, repo) = amend_fixture("gd-amend-moved-", &[]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;

        let result = amend_expecting(&repo, "A reworded", Some(a)).await;

        assert_eq!(head(&repo).await, b, "HEAD is still the outside commit");
        assert_eq!(head_subject(&repo).await, "B", "B's message is untouched");
        assert_refused(result);
    }

    #[tokio::test]
    async fn amend_with_current_head_rewrites_it() {
        let (dir, repo) = amend_fixture("gd-amend-current-", &[]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;

        let result = amend_expecting(&repo, "B reworded", Some(b.clone()))
            .await
            .expect("amending the current HEAD succeeds");

        assert_ne!(result.hash, b, "the amend minted a new commit");
        assert_eq!(head(&repo).await, result.hash);
        assert_eq!(head_subject(&repo).await, "B reworded");
        let parent = run(&repo, &["rev-parse", "HEAD~1"]).await;
        assert_eq!(parent.trim(), a, "the parent is preserved");
    }

    #[tokio::test]
    async fn amend_with_expected_head_works_detached() {
        let (dir, repo) = amend_fixture("gd-amend-detached-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        run(&repo, &["checkout", "-q", "--detach"]).await;

        amend_expecting(&repo, "B detached", Some(b))
            .await
            .expect("a detached HEAD amends when it matches");

        assert_eq!(head_subject(&repo).await, "B detached");
    }

    /// git's own unborn-amend error words it differently, so the exact refusal text
    /// proves the CAS answered before any commit spawned.
    #[tokio::test]
    async fn amend_expected_head_refuses_on_unborn() {
        let (_dir, repo) = amend_fixture("gd-amend-unborn-", &[]).await;

        let result = amend_expecting(&repo, "first", Some("0".repeat(40))).await;

        assert_refused(result);
        let probe = run_git_raw(
            Some(&repo),
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(probe.code, 0, "the repo still has no HEAD");
    }

    /// The MCP commit tool passes no expected head and keeps amending whatever HEAD is.
    #[tokio::test]
    async fn amend_without_expected_keeps_rewriting_current_head() {
        let (dir, repo) = amend_fixture("gd-amend-none-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        raw_commit(&dir, &repo, "b.txt", "B").await;

        amend_expecting(&repo, "B via mcp", None)
            .await
            .expect("an amend with no expectation runs");

        assert_eq!(head_subject(&repo).await, "B via mcp");
    }

    #[tokio::test]
    async fn expected_head_compare_is_full_hash_in_sha256_repos() {
        let (dir, repo) = amend_fixture("gd-amend-sha256-", &["--object-format=sha256"]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        assert_eq!(a.len(), 64, "a sha256 oid");

        // Same 63-char prefix, different last digit: only a full compare tells them apart.
        let last = if a.ends_with('0') { '1' } else { '0' };
        let near_miss = format!("{}{last}", &a[..63]);
        assert_refused(amend_expecting(&repo, "A near miss", Some(near_miss)).await);
        assert_eq!(head(&repo).await, a);

        amend_expecting(&repo, "A sha256", Some(a))
            .await
            .expect("the full oid matches");
        assert_eq!(head_subject(&repo).await, "A sha256");
    }

    async fn undo(repo: &str, expected: Option<String>) -> AppResult<()> {
        undo_on(repo, expected, ExpectedRef::Any).await
    }

    async fn undo_on(repo: &str, expected: Option<String>, on: ExpectedRef) -> AppResult<()> {
        let state = AppState::default();
        git_undo_commit_core(&state, repo.to_string(), expected, on).await
    }

    /// HEAD's branch name, as the GUI's status read reports it.
    async fn branch_here(repo: &str) -> ExpectedRef {
        ExpectedRef::Branch(
            run(repo, &["symbolic-ref", "--short", "HEAD"])
                .await
                .trim()
                .to_string(),
        )
    }

    fn assert_undo_refused(result: AppResult<()>, copy: &str) {
        match result {
            Err(AppError::Git { stderr, .. }) => assert_eq!(stderr, copy),
            other => panic!("expected the refusal {copy:?}, got {other:?}"),
        }
    }

    async fn porcelain(repo: &str) -> String {
        run(repo, &["status", "--porcelain"]).await
    }

    async fn has_head(repo: &str) -> bool {
        run_git_raw(
            Some(repo),
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .code
            == 0
    }

    /// The undo the user chose for B must not unwind an outside commit C that became
    /// HEAD meanwhile; HEAD, index and tree stay exactly as C left them.
    #[tokio::test]
    async fn undo_commit_refuses_when_head_moved() {
        let (dir, repo) = amend_fixture("gd-undo-moved-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let c = raw_commit(&dir, &repo, "c.txt", "C").await;

        let result = undo(&repo, Some(b)).await;

        assert_undo_refused(result, UNDO_HEAD_MOVED);
        assert_eq!(head(&repo).await, c, "the outside commit is kept");
        assert_eq!(porcelain(&repo).await, "", "index and tree are untouched");
    }

    #[tokio::test]
    async fn undo_commit_with_current_head_undoes() {
        let (dir, repo) = amend_fixture("gd-undo-current-", &[]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;

        undo(&repo, Some(b))
            .await
            .expect("undoing the current HEAD succeeds");

        assert_eq!(head(&repo).await, a, "HEAD is back on the parent");
        assert_eq!(
            run(&repo, &["diff", "--cached", "--name-only"])
                .await
                .trim(),
            "b.txt",
            "the undone commit's changes stay staged"
        );
    }

    #[tokio::test]
    async fn undo_commit_root_arm_deletes_ref_when_expected_matches() {
        let (dir, repo) = amend_fixture("gd-undo-root-", &[]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;

        undo(&repo, Some(a))
            .await
            .expect("undoing the only commit succeeds");

        assert!(!has_head(&repo).await, "the branch is unborn again");
        assert_eq!(
            porcelain(&repo).await.trim(),
            "A  a.txt",
            "its file stays staged"
        );
    }

    /// A root-only branch measured by the user gains an outside commit before the
    /// undo runs: deleting the branch ref now would drop both commits.
    #[tokio::test]
    async fn undo_commit_refuses_root_arm_when_branch_gained_a_commit() {
        let (dir, repo) = amend_fixture("gd-undo-root-moved-", &[]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;

        let result = undo(&repo, Some(a.clone())).await;

        assert_undo_refused(result, UNDO_HEAD_MOVED);
        assert_eq!(head(&repo).await, b, "the branch ref survives");
        assert_eq!(run(&repo, &["rev-parse", "HEAD~1"]).await.trim(), a);
        assert_eq!(porcelain(&repo).await, "");
    }

    #[tokio::test]
    async fn undo_commit_expected_head_compare_is_full_hash_in_sha256_repos() {
        let (dir, repo) = amend_fixture("gd-undo-sha256-", &["--object-format=sha256"]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        assert_eq!(b.len(), 64, "a sha256 oid");

        // Same 63-char prefix, different last digit: only a full compare tells them apart.
        let last = if b.ends_with('0') { '1' } else { '0' };
        for stale in [format!("{}{last}", &b[..63]), b[..40].to_string()] {
            assert_undo_refused(undo(&repo, Some(stale)).await, UNDO_HEAD_MOVED);
            assert_eq!(head(&repo).await, b);
        }

        undo(&repo, Some(b)).await.expect("the full oid matches");
        assert_eq!(head(&repo).await, a);
    }

    #[tokio::test]
    async fn undo_commit_refuses_on_unborn_head() {
        let (_dir, repo) = amend_fixture("gd-undo-unborn-", &[]).await;

        assert_undo_refused(undo(&repo, Some("0".repeat(40))).await, UNDO_HEAD_MOVED);

        assert!(!has_head(&repo).await, "the repo still has no HEAD");
    }

    /// The MCP undo tool passes no expected head and keeps undoing whatever HEAD is.
    #[tokio::test]
    async fn undo_commit_without_expected_undoes_current_head() {
        let (dir, repo) = amend_fixture("gd-undo-none-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        raw_commit(&dir, &repo, "c.txt", "C").await;

        undo(&repo, None)
            .await
            .expect("an undo with no expectation runs");

        assert_eq!(head(&repo).await, b);
    }

    /// A stale ref lock fails the root arm's compare-and-swap with HEAD unmoved: that
    /// is git's own error, never the moved refusal. Clearing it is the success twin.
    #[tokio::test]
    async fn undo_commit_root_arm_keeps_gits_error_for_a_stale_ref_lock() {
        let (dir, repo) = amend_fixture("gd-undo-root-lock-", &[]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        let full_ref = run(&repo, &["symbolic-ref", "HEAD"]).await;
        let lock = dir
            .path()
            .join(".git")
            .join(format!("{}.lock", full_ref.trim()));
        std::fs::write(&lock, "").unwrap();

        match undo(&repo, Some(a.clone())).await {
            Err(AppError::Git { stderr, .. }) => {
                assert_ne!(stderr, UNDO_HEAD_MOVED);
                assert!(stderr.contains(".lock"), "git's own error: {stderr}");
            }
            other => panic!("expected git's lock error, got {other:?}"),
        }
        assert_eq!(head(&repo).await, a, "the branch survives");

        std::fs::remove_file(&lock).unwrap();
        undo(&repo, Some(a))
            .await
            .expect("with the lock gone, the undo runs");
        assert!(!has_head(&repo).await);
    }

    /// Only the object's header counts toward the shallow check: a root commit whose
    /// MESSAGE carries a line starting `parent ` still takes the root arm.
    #[tokio::test]
    async fn undo_commit_root_arm_ignores_a_parent_line_in_the_message() {
        let (dir, repo) = amend_fixture("gd-undo-root-parent-msg-", &[]).await;
        std::fs::write(dir.path().join("a.txt"), "A\n").unwrap();
        run(&repo, &["add", "-A"]).await;
        let fake = format!("parent {}", "1".repeat(40));
        run(&repo, &["commit", "-qm", "A", "-m", &fake]).await;
        let a = head(&repo).await;

        undo(&repo, Some(a))
            .await
            .expect("a message line is not a parent");

        assert!(!has_head(&repo).await, "the branch is unborn again");
    }

    /// A depth-1 clone's only commit records a parent it never fetched: `HEAD~1` fails
    /// to resolve there, and taking the root arm would delete the branch.
    #[tokio::test]
    async fn undo_commit_refuses_a_shallow_clones_boundary_commit() {
        let (dir, source) = amend_fixture("gd-undo-shallow-", &[]).await;
        raw_commit(&dir, &source, "a.txt", "A").await;
        raw_commit(&dir, &source, "b.txt", "B").await;
        // `--depth` is ignored for a plain local path, so the source goes by URL.
        let path = source.replace('\\', "/");
        let url = if path.starts_with('/') {
            format!("file://{path}")
        } else {
            format!("file:///{path}")
        };
        let clone_dir = dir.path().join("clone");
        let clone = clone_dir.to_string_lossy().into_owned();
        run_git(
            None,
            &["clone", "-q", "--depth", "1", &url, &clone],
            DEFAULT_TIMEOUT,
        )
        .await
        .expect("the shallow clone succeeds");
        let b = head(&clone).await;
        assert!(
            run_git_raw(
                Some(&clone),
                &["rev-parse", "--verify", "--quiet", "HEAD~1"],
                DEFAULT_TIMEOUT,
            )
            .await
            .unwrap()
            .code
                != 0,
            "fixture sanity: the boundary's parent does not resolve"
        );

        for expected in [Some(b.clone()), None] {
            assert_undo_refused(undo(&clone, expected).await, UNDO_SHALLOW_BOUNDARY);
            assert_eq!(head(&clone).await, b, "the branch survives");
        }
        undo(&source, None)
            .await
            .expect("the same commit undoes where its parent exists");
    }

    /// `update-ref -d HEAD` on a detached HEAD deletes `.git/HEAD` itself, so the
    /// detached-at-root case refuses on both routes. The attached root arm above is
    /// the success twin.
    #[tokio::test]
    async fn undo_commit_refuses_a_detached_head_at_the_root_commit() {
        let (dir, repo) = amend_fixture("gd-undo-detached-root-", &[]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        run(&repo, &["checkout", "-q", "--detach"]).await;

        for expected in [Some(a.clone()), None] {
            assert_undo_refused(undo(&repo, expected).await, UNDO_DETACHED_ROOT);
            assert!(dir.path().join(".git").join("HEAD").is_file());
            assert_eq!(head(&repo).await, a, "HEAD still names the commit");
        }
    }

    /// A switch to another branch at the SAME commit passes the oid pin; the branch
    /// pin refuses it, and the branch the user saw proceeds.
    #[tokio::test]
    async fn undo_commit_refuses_a_same_oid_switch_to_another_branch() {
        let (dir, repo) = amend_fixture("gd-undo-switched-", &[]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let seen = branch_here(&repo).await;
        run(&repo, &["switch", "-qc", "other"]).await;

        let result = undo_on(&repo, Some(b.clone()), seen).await;

        assert_undo_refused(result, UNDO_BRANCH_SWITCHED);
        assert_eq!(head(&repo).await, b, "HEAD is untouched");
        assert_eq!(porcelain(&repo).await, "");
        undo_on(&repo, Some(b), ExpectedRef::Branch("other".into()))
            .await
            .expect("the branch HEAD is on undoes");
        assert_eq!(head(&repo).await, a);
    }

    /// Detached and attached are different answers at the same commit, both ways.
    #[tokio::test]
    async fn undo_commit_refuses_a_detached_flip_either_way() {
        let (dir, repo) = amend_fixture("gd-undo-flip-", &[]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let attached = branch_here(&repo).await;

        assert_undo_refused(
            undo_on(&repo, Some(b.clone()), ExpectedRef::Detached).await,
            UNDO_BRANCH_SWITCHED,
        );
        run(&repo, &["checkout", "-q", "--detach"]).await;
        assert_undo_refused(
            undo_on(&repo, Some(b.clone()), attached).await,
            UNDO_BRANCH_SWITCHED,
        );
        assert_eq!(head(&repo).await, b);

        undo_on(&repo, Some(b), ExpectedRef::Detached)
            .await
            .expect("a detached HEAD undoes when the pin says detached");
        assert_eq!(head(&repo).await, a);
    }

    #[tokio::test]
    async fn amend_refuses_a_same_oid_switch_to_another_branch() {
        let (dir, repo) = amend_fixture("gd-amend-switched-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let seen = branch_here(&repo).await;
        run(&repo, &["switch", "-qc", "other"]).await;

        match amend_on(&repo, "B reworded", Some(b.clone()), seen).await {
            Err(AppError::Git { stderr, .. }) => assert_eq!(stderr, AMEND_BRANCH_SWITCHED),
            other => panic!("expected the branch-switched refusal, got {other:?}"),
        }
        assert_eq!(head(&repo).await, b, "HEAD is untouched");
        assert_eq!(head_subject(&repo).await, "B");

        amend_on(
            &repo,
            "B reworded",
            Some(b),
            ExpectedRef::Branch("other".into()),
        )
        .await
        .expect("the branch HEAD is on amends");
        assert_eq!(head_subject(&repo).await, "B reworded");
    }

    #[tokio::test]
    async fn amend_refuses_a_detached_flip_either_way() {
        let (dir, repo) = amend_fixture("gd-amend-flip-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let attached = branch_here(&repo).await;
        let refused = |result: AppResult<CommitResult>| match result {
            Err(AppError::Git { stderr, .. }) => assert_eq!(stderr, AMEND_BRANCH_SWITCHED),
            other => panic!("expected the branch-switched refusal, got {other:?}"),
        };

        refused(amend_on(&repo, "x", Some(b.clone()), ExpectedRef::Detached).await);
        run(&repo, &["checkout", "-q", "--detach"]).await;
        refused(amend_on(&repo, "x", Some(b.clone()), attached).await);
        assert_eq!(head_subject(&repo).await, "B");

        amend_on(&repo, "B detached", Some(b), ExpectedRef::Detached)
            .await
            .expect("a detached HEAD amends when the pin says detached");
        assert_eq!(head_subject(&repo).await, "B detached");
    }

    #[test]
    fn expected_ref_reads_the_wire_form() {
        assert_eq!(ExpectedRef::from_wire(None).unwrap(), ExpectedRef::Any);
        assert_eq!(
            ExpectedRef::from_wire(Some("HEAD".into())).unwrap(),
            ExpectedRef::Detached
        );
        assert_eq!(
            ExpectedRef::from_wire(Some("feature/x".into())).unwrap(),
            ExpectedRef::Branch("feature/x".into())
        );
        assert!(ExpectedRef::from_wire(Some("-x".into())).is_err());
    }

    /// A switch that lands after the root undo's `symbolic-ref` read and before its
    /// delete must not redirect it: the branch read under the hold goes, and the branch
    /// HEAD switched to (same root commit) survives with HEAD still on it.
    #[tokio::test]
    async fn root_undo_deletes_the_branch_it_read_when_head_switches_before_the_delete() {
        let (dir, repo) = amend_fixture("gd-undo-root-switched-", &[]).await;
        let root = raw_commit(&dir, &repo, "a.txt", "A").await;
        run(&repo, &["branch", "-m", "checked"]).await;
        let hook_repo = repo.clone();
        let switch: UndoRootHook = std::sync::Arc::new(move || {
            let repo = hook_repo.clone();
            Box::pin(async move {
                run(&repo, &["switch", "-qc", "switched-to"]).await;
            })
        });

        UNDO_ROOT_HOOK
            .scope(switch, undo(&repo, Some(root.clone())))
            .await
            .expect("the undo deletes the branch it read");

        assert_eq!(ref_oid(&repo, "refs/heads/checked").await.unwrap(), None);
        assert_eq!(
            ref_oid(&repo, "refs/heads/switched-to").await.unwrap(),
            Some(root),
            "the branch HEAD switched to survives"
        );
        assert_eq!(
            run(&repo, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/switched-to"
        );
    }
}
