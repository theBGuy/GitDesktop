use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::history::{parse_commit_log, LOG_FORMAT};
use crate::git::runner::{
    acquire_repo_lock, holder_label, run_git, run_git_config_write_held, run_git_mutating_raw,
    run_git_raw, run_git_raw_index_retry, with_config_write_lock, GitOutput, DEFAULT_TIMEOUT,
    LOCK_WAIT_TIMEOUT,
};
use crate::git::types::{AmendRace, CommitAuthor, CommitResult, CommitSummary};
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

    /// The ref a compare-and-swap moves for this pin, resolved under the caller's hold: the
    /// pinned branch's full ref, HEAD itself when detached, and for `Any` whatever HEAD names
    /// now. Never a dereferenced `HEAD`: `update-ref` resolves a symbolic HEAD when it runs,
    /// so a switch landing after the caller's checks would redirect the move.
    pub(crate) async fn cas_ref(&self, repo_path: &str) -> AppResult<CasRef> {
        Ok(match self {
            Self::Branch(name) => {
                crate::git::branches::validate_branch_name(name)?;
                CasRef::Branch(format!("refs/heads/{name}"))
            }
            Self::Detached => CasRef::Detached,
            Self::Any => match crate::git::branches::current_branch_ref(repo_path).await? {
                Some(full) => CasRef::Branch(full),
                None => CasRef::Detached,
            },
        })
    }
}

/// The one ref a pinned rewrite moves, compared-and-swapped against the oid its checks read,
/// so a commit another process lands after those checks refuses the move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CasRef {
    /// A branch, by its full ref.
    Branch(String),
    /// HEAD itself, updated `--no-deref`.
    Detached,
}

impl CasRef {
    fn name(&self) -> &str {
        match self {
            Self::Branch(full) => full,
            Self::Detached => "HEAD",
        }
    }

    /// The ref's oid now, `None` when it doesn't resolve (an unborn branch).
    pub(crate) async fn oid(&self, repo_path: &str) -> AppResult<Option<String>> {
        ref_oid(repo_path, self.name()).await
    }

    /// Moves the ref to `new` only while it still holds `old` (`None`: only while it doesn't
    /// exist). Moving the branch HEAD is on logs HEAD's reflog too (measured, git 2.51.1).
    pub(crate) async fn swap(
        &self,
        repo_path: &str,
        message: &str,
        new: &str,
        old: Option<&str>,
    ) -> AppResult<GitOutput> {
        let mut args = vec!["update-ref"];
        if *self == Self::Detached {
            args.push("--no-deref");
        }
        args.extend(["-m", message, self.name(), new, old.unwrap_or("")]);
        run_git_raw_index_retry(repo_path, &args, DEFAULT_TIMEOUT).await
    }

    /// Puts the ref back from `current` to `old` by the same compare-and-swap, so it never
    /// moves a ref another process moved meanwhile. `None` on either side is an absent ref:
    /// an `old` of `None` deletes exactly the ref a swap from `None` created, undereferenced
    /// (HEAD always exists, so no such swap of it lands), and a `current` of `None`
    /// re-creates a deleted ref only while it is still absent.
    pub(crate) async fn roll_back(
        &self,
        repo_path: &str,
        old: Option<&str>,
        current: Option<&str>,
    ) -> RolledBack {
        let message = "reset: rolling back";
        let restored = match (old, current) {
            (Some(old), current) => self.swap(repo_path, message, old, current).await,
            (None, Some(current)) => {
                run_git_raw_index_retry(
                    repo_path,
                    &["update-ref", "--no-deref", "-d", self.name(), current],
                    DEFAULT_TIMEOUT,
                )
                .await
            }
            (None, None) => return RolledBack::Restored,
        };
        let why = match restored {
            Ok(out) if out.code == 0 => return RolledBack::Restored,
            Ok(out) => out.full_failure_text(),
            Err(e) => e.to_string(),
        };
        match self.oid(repo_path).await {
            Ok(now) if now.as_deref() == old => RolledBack::Restored,
            Ok(now) if now.as_deref() == current => RolledBack::Stuck(why),
            Ok(_) => RolledBack::Lost,
            Err(_) => RolledBack::Unread(why),
        }
    }

    /// The branch this names, for a verdict; neutral for a detached HEAD.
    fn label(&self) -> &str {
        match self {
            Self::Branch(full) => full.strip_prefix("refs/heads/").unwrap_or(full),
            Self::Detached => "the branch",
        }
    }

    /// Whether HEAD still names this ref: on this branch, or still detached.
    async fn still_checked_out(&self, repo_path: &str) -> AppResult<bool> {
        let now = crate::git::branches::current_branch_ref(repo_path).await?;
        Ok(match self {
            Self::Branch(full) => now.as_deref() == Some(full.as_str()),
            Self::Detached => now.is_none(),
        })
    }

    /// Refuses with `switched` when HEAD stopped naming this ref right after its move from
    /// `old` to `new` (`None`: the move deleted it) landed: the move compares only the ref's
    /// own oid, so any branch switch in that instant passes it. A branch is moved back by
    /// compare-and-swap, and an unreadable HEAD there fails closed, as a switch. A detached
    /// HEAD the switch replaced holds nothing of the move's, and moving it back would undo
    /// the switch itself; unreadable, it gets `op`'s own verdict instead, claiming nothing.
    /// `files_pending` says the caller writes files after this check and hasn't yet (a hard
    /// reset's read-tree), which that verdict then states.
    pub(crate) async fn refuse_if_switched(
        &self,
        repo_path: &str,
        old: Option<&str>,
        new: Option<&str>,
        switched: &str,
        op: &str,
        files_pending: bool,
    ) -> AppResult<()> {
        let rolled = match (self, self.still_checked_out(repo_path).await) {
            (_, Ok(true)) => return Ok(()),
            (Self::Detached, Ok(false)) => RolledBack::Restored,
            (Self::Detached, Err(e)) => {
                // The swap's own value, since the read just failed.
                let files = if files_pending {
                    ", and your files were not updated"
                } else {
                    ""
                };
                return Err(AppError::Git {
                    code: 1,
                    stderr: format!(
                        "Couldn't confirm what is checked out after the {op}; HEAD was moved \
                         to {}{files}.\n{e}",
                        new.map_or("", short_oid)
                    ),
                });
            }
            (Self::Branch(_), _) => self.roll_back(repo_path, old, new).await,
        };
        let label = self.label();
        let stderr = match rolled {
            RolledBack::Restored => switched.to_string(),
            RolledBack::Lost => format!(
                "The checked-out branch changed, and another Git process moved {label} before \
                 it could be moved back. {SWITCH_ROLLBACK_HINT}"
            ),
            RolledBack::Stuck(why) => {
                let now = match new {
                    Some(oid) => format!("it now points at {}", short_oid(oid)),
                    None => "it no longer exists".to_string(),
                };
                format!(
                    "The checked-out branch changed, and {label} couldn't be moved back: {now}. \
                     {SWITCH_ROLLBACK_HINT}\n{why}"
                )
            }
            RolledBack::Unread(why) => format!(
                "The checked-out branch changed, and {label} couldn't be moved back. \
                 {SWITCH_ROLLBACK_HINT}\n{why}"
            ),
        };
        Err(AppError::Git { code: 1, stderr })
    }

    /// Why a swap of this ref from `old` failed, read under the caller's hold: HEAD off the
    /// pin answers `switched`, the ref off `old` answers `moved`, and anything else (a stale
    /// ref `.lock`) keeps git's own error.
    pub(crate) async fn refusal(
        &self,
        repo_path: &str,
        pin: &ExpectedRef,
        old: Option<&str>,
        failed: &GitOutput,
        moved: &str,
        switched: &str,
    ) -> AppResult<AppError> {
        let copy = if pin.moved(repo_path).await? {
            switched
        } else if self.oid(repo_path).await?.as_deref() != old {
            moved
        } else {
            return Ok(AppError::Git {
                code: failed.code,
                stderr: failed.full_failure_text(),
            });
        };
        Ok(AppError::Git {
            code: 1,
            stderr: copy.to_string(),
        })
    }
}

/// How a [`CasRef::roll_back`] ended.
pub(crate) enum RolledBack {
    /// The ref holds its old value again.
    Restored,
    /// Another process moved the ref meanwhile, so it stays where that process put it.
    Lost,
    /// The ref still holds the swapped-in value: the rollback failed on its own (a stale ref
    /// `.lock`, not a race). Carries git's text.
    Stuck(String),
    /// The rollback failed and the ref couldn't be re-read, so where it points is unknown.
    /// Carries git's text.
    Unread(String),
}

/// The first seven hex digits a verdict names a commit by.
pub(crate) fn short_oid(oid: &str) -> &str {
    &oid[..oid.len().min(7)]
}

/// The recovery hint every failed-rollback verdict for a caught switch ends its lead with.
/// ops.rs's three failed tree-step rollback verdicts append it too.
pub(crate) const SWITCH_ROLLBACK_HINT: &str =
    "Check the branch in a terminal; the reflog has every tip.";

/// Records `old` in ORIG_HEAD after a reset-style move, as `git reset` does. Best-effort, as
/// in git: the move already landed, so a failed write never fails it.
pub(crate) async fn record_orig_head(repo_path: &str, old: &str) {
    let _ = run_git_raw(
        Some(repo_path),
        &["update-ref", "ORIG_HEAD", old],
        DEFAULT_TIMEOUT,
    )
    .await;
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
/// serializes this process only, and the amend stays `git commit --amend` (the one route
/// that runs the user's hooks), so a separate process can still move HEAD in the
/// milliseconds before the spawn: such an amend still lands, reported in `raced`.
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
    // `verified` is the pinned arm's new hash and race report, both read under its hold.
    let (commit, verified) = match expected_head.filter(|_| amend) {
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
            #[cfg(test)]
            run_phase_hook(&AMEND_PHASE_HOOK).await;
            let commit = run_git_raw_index_retry(&repo_path, &args, DEFAULT_TIMEOUT).await?;
            let verified = if commit.code == 0 {
                let hash = head_hash(&repo_path).await?;
                let raced = amend_race(&repo_path, &expected, &expected_ref, &hash).await;
                Some((hash, raced))
            } else {
                None
            };
            (commit, verified)
        }
        None => (
            run_git_mutating_raw(state, &repo_path, &args, DEFAULT_TIMEOUT).await?,
            None,
        ),
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
    let (hash, raced) = match verified {
        Some(verified) => verified,
        None => (head_hash(&repo_path).await?, None),
    };
    Ok(CommitResult { hash, raced })
}

async fn head_hash(repo_path: &str) -> AppResult<String> {
    let out = run_git(Some(repo_path), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT).await?;
    Ok(out.stdout_lossy().trim().to_string())
}

/// What a pinned amend rewrote instead of `expected` on the pinned ref, `None` when it
/// rewrote exactly that commit; read under the commit's hold right after it landed. Three
/// signals: HEAD off the pin, a parent set unlike the pin's (a commit landed on top first),
/// and HEAD's reflog naming another previous tip (another amend kept the pin's parents).
/// A probe that can't answer abstains, since the amend itself already happened.
async fn amend_race(
    repo_path: &str,
    expected: &str,
    pin: &ExpectedRef,
    hash: &str,
) -> Option<AmendRace> {
    let switched = pin.moved(repo_path).await.unwrap_or(false);
    let parents_differ = match (
        commit_parents(repo_path, hash).await,
        commit_parents(repo_path, expected).await,
    ) {
        (Some(now), Some(pinned)) => now != pinned,
        _ => false,
    };
    // Best-effort: a HEAD move that skipped HEAD's reflog reads as a race here, and so does
    // a post-commit or post-rewrite hook that itself commits or amends (HEAD@{1} is then
    // this amend's own intermediate commit).
    let rewrote = ref_oid(repo_path, "HEAD@{1}")
        .await
        .ok()
        .flatten()
        .filter(|previous| previous != expected);
    if !switched && !parents_differ && rewrote.is_none() {
        return None;
    }
    let (branch, detached) = if switched {
        match crate::git::branches::current_branch_name(repo_path).await {
            Ok(Some(name)) => (Some(name), false),
            Ok(None) => (None, true),
            Err(_) => (None, false),
        }
    } else {
        (None, false)
    };
    Some(AmendRace {
        rewrote,
        branch,
        detached,
    })
}

/// The parent oids of `oid` as `commit --amend` sees them, `None` when they can't be read.
/// Through the shallow graft, unlike the root undo's raw-object read: a depth-1 clone's
/// boundary commit has no parents there, so the amend of it is parentless too (measured,
/// git 2.51.1), and comparing the raw header would call that clean amend a race.
async fn commit_parents(repo_path: &str, oid: &str) -> Option<Vec<String>> {
    let out = run_git_raw(
        Some(repo_path),
        // A user's `log.showSignature` would otherwise print gpg output into the list.
        &["log", "-1", "--no-show-signature", "--format=%P", oid],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    if out.code != 0 {
        return None;
    }
    Some(
        out.stdout_lossy()
            .split_whitespace()
            .map(str::to_string)
            .collect(),
    )
}

/// The refusal an undo gets when HEAD is no longer the commit the user chose.
/// KEEP IN STEP: this exact sentence is the one wording for a moved-HEAD undo on
/// every route (GUI toast, MCP tool error); ops.rs and branches.rs carry the
/// reset twins of its "… — nothing was <verb>." shape.
const UNDO_HEAD_MOVED: &str = "The latest commit changed — nothing was undone.";

/// The refusal an undo gets when HEAD sits on another branch (or none) than the one
/// the user saw, even at the same commit. KEEP IN STEP with the family above.
const UNDO_BRANCH_SWITCHED: &str = "The checked-out branch changed — nothing was undone.";

/// The refusal for an undo while a merge is stopped (MERGE_HEAD): `reset --soft` refuses
/// there, and the undo's `update-ref` would not. KEEP IN STEP with the family above.
const UNDO_MID_MERGE: &str =
    "A merge is in progress — finish or abort it first; nothing was undone.";

/// The refusal for an undo over unmerged entries with no merge stopped (a conflicted
/// squash, stash pop or rebase), the other half of `reset --soft`'s refusal. KEEP IN STEP
/// with the family above.
const UNDO_UNRESOLVED: &str = "Resolve the conflicts first; nothing was undone.";

/// The refusal for an undo while a cherry-pick or revert is stopped: `reset --soft` would
/// cancel it, clearing its sequencer only on the last pick. KEEP IN STEP with the family above.
const UNDO_MID_PICK: &str =
    "A cherry-pick or revert is in progress — finish or abort it first; nothing was undone.";

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
/// undo whatever HEAD is. Either way the ref moves (or, at a root commit, is deleted) by
/// compare-and-swap against the oid read under the hold, so a commit a separate process
/// lands after the checks refuses the undo, and HEAD is re-read right after the move, so
/// that process's branch switch puts the branch back and refuses too. A switch landing
/// after that re-read is unseen.
///
/// `update-ref` skips both `reset --soft`'s mid-merge refusal and its cancelling of a
/// stopped pick, so both arms refuse those states first.
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
    if head.is_some() {
        let refuse = |copy: &str| AppError::Git {
            code: 1,
            stderr: copy.to_string(),
        };
        let ops = crate::git::ops::op_state(&repo_path).await?;
        if ops.cherry_picking || ops.reverting {
            return Err(refuse(UNDO_MID_PICK));
        }
        // The pair `reset --soft` itself refuses on (measured, git 2.51.1).
        if ops.merging {
            return Err(refuse(UNDO_MID_MERGE));
        }
        if crate::git::ops::has_unmerged(&repo_path).await? {
            return Err(refuse(UNDO_UNRESOLVED));
        }
    }
    // The parent of the oid read above, never `HEAD~1` again: a switch between two
    // HEAD-relative reads would aim this branch at another branch's parent.
    let parent = match &head {
        Some(head_oid) => ref_oid(&repo_path, &format!("{head_oid}~1")).await?,
        None => None,
    };
    if let (Some(head_oid), Some(parent)) = (&head, parent) {
        return soft_undo(&repo_path, &expected_ref, head_oid, &parent).await;
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
    run_phase_hook(&UNDO_ROOT_HOOK).await;
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
    if let Some(full_ref) = target {
        #[cfg(test)]
        run_phase_hook(&UNDO_ROOT_DELETED_HOOK).await;
        // A switch that lands on another branch after the delete gets the branch re-created,
        // only while it is still absent.
        CasRef::Branch(full_ref)
            .refuse_if_switched(
                &repo_path,
                Some(&head_oid),
                None,
                UNDO_BRANCH_SWITCHED,
                "undo",
                false,
            )
            .await?;
    }
    Ok(())
}

/// The undo of a commit with a parent: `reset --soft`'s ref move as a compare-and-swap of
/// the ref HEAD named under the hold, from `head_oid` to `parent`. The index and tree stay
/// as they are, so the undone commit's changes stay staged. The caller has already refused
/// the mid-operation states.
async fn soft_undo(
    repo_path: &str,
    pin: &ExpectedRef,
    head_oid: &str,
    parent: &str,
) -> AppResult<()> {
    let cas = pin.cas_ref(repo_path).await?;
    #[cfg(test)]
    run_phase_hook(&UNDO_SOFT_HOOK).await;
    let out = cas
        .swap(repo_path, "reset: moving to HEAD~1", parent, Some(head_oid))
        .await?;
    if out.code != 0 {
        return Err(cas
            .refusal(
                repo_path,
                pin,
                Some(head_oid),
                &out,
                UNDO_HEAD_MOVED,
                UNDO_BRANCH_SWITCHED,
            )
            .await?);
    }
    #[cfg(test)]
    run_phase_hook(&UNDO_SWAPPED_HOOK).await;
    cas.refuse_if_switched(
        repo_path,
        Some(head_oid),
        Some(parent),
        UNDO_BRANCH_SWITCHED,
        "undo",
        false,
    )
    .await?;
    record_orig_head(repo_path, head_oid).await;
    crate::git::ops::clear_branch_state(repo_path).await;
    Ok(())
}

/// A test seam awaited inside a rewrite's hold, where a raw `git` spawned by the test is a
/// separate process: exactly the racer the compare-and-swaps answer.
#[cfg(test)]
pub(crate) type PhaseHook = std::sync::Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync,
>;

#[cfg(test)]
tokio::task_local! {
    /// Awaited by the root undo it is scoped to, after `symbolic-ref` named the branch
    /// and before the delete, so a test can switch HEAD inside that window.
    static UNDO_ROOT_HOOK: PhaseHook;
    /// Awaited by the pinned amend it is scoped to, after the pin checks and before the
    /// `commit --amend` spawn, so a test can move HEAD inside that window.
    static AMEND_PHASE_HOOK: PhaseHook;
    /// Awaited by the soft undo it is scoped to, after the head and parent reads and
    /// before the compare-and-swap, so a test can move HEAD inside that window.
    static UNDO_SOFT_HOOK: PhaseHook;
    /// Awaited by the soft undo it is scoped to, after the compare-and-swap landed and
    /// before HEAD is re-read, so a test can switch branches inside that window.
    static UNDO_SWAPPED_HOOK: PhaseHook;
    /// Awaited by the root undo it is scoped to, after the branch delete landed and before
    /// HEAD is re-read, so a test can switch branches inside that window.
    static UNDO_ROOT_DELETED_HOOK: PhaseHook;
}

/// Runs `hook`'s seam when the calling task is scoped to one.
#[cfg(test)]
pub(crate) async fn run_phase_hook(hook: &'static tokio::task::LocalKey<PhaseHook>) {
    if let Ok(wait) = hook.try_with(|hook| hook()) {
        wait.await;
    }
}

/// A seam that runs each of `steps` in `repo` as a raw `git` process. Test-only.
#[cfg(test)]
pub(crate) fn racing_git(repo: &str, steps: &[&[&str]]) -> PhaseHook {
    let repo = repo.to_string();
    let steps: Vec<Vec<String>> = steps
        .iter()
        .map(|step| step.iter().map(|arg| arg.to_string()).collect())
        .collect();
    std::sync::Arc::new(move || {
        let (repo, steps) = (repo.clone(), steps.clone());
        Box::pin(async move {
            for step in &steps {
                let args: Vec<&str> = step.iter().map(String::as_str).collect();
                run_git(Some(&repo), &args, DEFAULT_TIMEOUT)
                    .await
                    .unwrap_or_else(|e| panic!("the racer's git {args:?} failed: {e}"));
            }
        })
    })
}

/// A seam that commits a new `file` in `repo` through raw `git`, recording the racer's
/// commit in the returned slot. Test-only.
#[cfg(test)]
pub(crate) fn racing_commit(
    repo: &str,
    file: &str,
) -> (PhaseHook, std::sync::Arc<std::sync::Mutex<Option<String>>>) {
    let landed = std::sync::Arc::new(std::sync::Mutex::new(None));
    let (repo, file, slot) = (repo.to_string(), file.to_string(), landed.clone());
    let hook: PhaseHook = std::sync::Arc::new(move || {
        let (repo, file, slot) = (repo.clone(), file.clone(), slot.clone());
        Box::pin(async move {
            std::fs::write(std::path::Path::new(&repo).join(&file), "racer\n").unwrap();
            for args in [&["add", "-A"][..], &["commit", "-qm", "racer"]] {
                run_git(Some(&repo), args, DEFAULT_TIMEOUT).await.unwrap();
            }
            *slot.lock().unwrap() = Some(head_hash(&repo).await.unwrap());
        })
    });
    (hook, landed)
}

/// The root undo's mutation: deletes `full_ref` only while it still points at `oid`.
/// Never `HEAD`: `update-ref` dereferences a symbolic HEAD when it runs, so a switch
/// that lands after the caller's checks would redirect the delete to another branch.
/// It can't also verify HEAD in the same transaction: git 2.51.1 refuses `symref-verify
/// HEAD` beside a delete of its referent ("fatal: prepare: multiple updates for 'HEAD'
/// (including one via its referent 'refs/heads/main') are not allowed", measured).
async fn delete_root_ref(repo_path: &str, full_ref: &str, oid: &str) -> AppResult<GitOutput> {
    run_git_raw_index_retry(
        repo_path,
        &["update-ref", "-d", full_ref, oid],
        DEFAULT_TIMEOUT,
    )
    .await
}

/// The oid `name` resolves to, `None` when it doesn't resolve.
pub(crate) async fn ref_oid(repo_path: &str, name: &str) -> AppResult<Option<String>> {
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
    use crate::git::ops::branch_state_fixtures::{
        branch_state_present, stop_an_autostashed_squash, write_unguarded_branch_state,
    };

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
    /// delete must not redirect it: the delete takes the branch read under the hold, the
    /// re-read after it sees HEAD on the other branch, and the deleted branch is re-created.
    /// The branch HEAD switched to (same root commit) survives with HEAD still on it.
    #[tokio::test]
    async fn root_undo_puts_back_the_branch_it_read_when_head_switches_before_the_delete() {
        let (dir, repo) = amend_fixture("gd-undo-root-switched-", &[]).await;
        let root = raw_commit(&dir, &repo, "a.txt", "A").await;
        run(&repo, &["branch", "-m", "checked"]).await;
        let hook_repo = repo.clone();
        let switch: PhaseHook = std::sync::Arc::new(move || {
            let repo = hook_repo.clone();
            Box::pin(async move {
                run(&repo, &["switch", "-qc", "switched-to"]).await;
            })
        });

        let result = UNDO_ROOT_HOOK
            .scope(switch, undo(&repo, Some(root.clone())))
            .await;

        assert_undo_refused(result, UNDO_BRANCH_SWITCHED);
        assert_eq!(
            ref_oid(&repo, "refs/heads/checked").await.unwrap(),
            Some(root.clone()),
            "the branch the undo read is back"
        );
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

    /// Another process switches branches right after the root undo's delete landed: the
    /// re-read sees HEAD elsewhere, so the deleted branch is re-created at its commit (only
    /// while still absent) and the undo refuses, with the index exactly as it was.
    #[tokio::test]
    async fn root_undo_recreates_and_refuses_a_switch_right_after_its_delete() {
        let (dir, repo) = amend_fixture("gd-undo-root-deleted-", &[]).await;
        let root = raw_commit(&dir, &repo, "a.txt", "A").await;
        let full = run(&repo, &["symbolic-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        let seen = branch_here(&repo).await;
        run(&repo, &["branch", "twin"]).await;
        let index = run(&repo, &["ls-files", "--stage"]).await;

        let result = UNDO_ROOT_DELETED_HOOK
            .scope(
                racing_git(&repo, &[&["switch", "-q", "twin"]]),
                undo_on(&repo, Some(root.clone()), seen),
            )
            .await;

        assert_undo_refused(result, UNDO_BRANCH_SWITCHED);
        assert_eq!(ref_oid(&repo, &full).await.unwrap(), Some(root.clone()));
        assert_eq!(reflog_subject(&repo, &full).await, "reset: rolling back");
        assert_eq!(
            run(&repo, &["symbolic-ref", "--short", "HEAD"])
                .await
                .trim(),
            "twin",
            "the switch stands"
        );
        assert_eq!(run(&repo, &["ls-files", "--stage"]).await, index);
        assert_eq!(
            porcelain(&repo).await,
            "",
            "index and tree match the commit"
        );
    }

    async fn reflog_subject(repo: &str, name: &str) -> String {
        run(repo, &["reflog", "-1", "--format=%gs", name])
            .await
            .trim()
            .to_string()
    }

    fn racer_landed(slot: &std::sync::Mutex<Option<String>>) -> String {
        slot.lock().unwrap().clone().expect("the racer committed")
    }

    /// Another process commits on top of the pin after the undo's checks: the swap from
    /// the pin refuses, so the racer's commit stays the tip and nothing is recorded.
    #[tokio::test]
    async fn soft_undo_refuses_a_commit_landing_before_its_swap() {
        let (dir, repo) = amend_fixture("gd-undo-soft-raced-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let seen = branch_here(&repo).await;
        let (commit, landed) = racing_commit(&repo, "c.txt");

        let result = UNDO_SOFT_HOOK
            .scope(commit, undo_on(&repo, Some(b.clone()), seen))
            .await;

        assert_undo_refused(result, UNDO_HEAD_MOVED);
        assert_eq!(
            head(&repo).await,
            racer_landed(&landed),
            "the racer's tip stands"
        );
        assert_eq!(run(&repo, &["rev-parse", "HEAD~1"]).await.trim(), b);
        assert_eq!(ref_oid(&repo, "ORIG_HEAD").await.unwrap(), None);
        assert_eq!(porcelain(&repo).await, "", "index and tree are untouched");
    }

    /// The swap records what `reset --soft` does: ORIG_HEAD at the undone tip, and the move
    /// in the branch's reflog AND HEAD's, which git logs when it moves HEAD's referent.
    /// Detached, HEAD itself moves and logs, and the branch stays put.
    #[tokio::test]
    async fn soft_undo_records_orig_head_and_logs_both_reflogs() {
        let (dir, repo) = amend_fixture("gd-undo-soft-logs-", &[]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let full = run(&repo, &["symbolic-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        undo_on(&repo, Some(b.clone()), branch_here(&repo).await)
            .await
            .expect("the undo runs");

        assert_eq!(head(&repo).await, a);
        assert_eq!(
            run(&repo, &["diff", "--cached", "--name-only"])
                .await
                .trim(),
            "b.txt",
            "the undone commit's changes stay staged"
        );
        assert_eq!(ref_oid(&repo, "ORIG_HEAD").await.unwrap(), Some(b));
        for log in [full.as_str(), "HEAD"] {
            assert_eq!(
                reflog_subject(&repo, log).await,
                "reset: moving to HEAD~1",
                "{log}"
            );
        }

        let c = raw_commit(&dir, &repo, "c.txt", "C").await;
        run(&repo, &["checkout", "-q", "--detach"]).await;
        undo_on(&repo, Some(c.clone()), ExpectedRef::Detached)
            .await
            .expect("a detached undo runs");

        assert_eq!(head(&repo).await, a);
        assert_eq!(ref_oid(&repo, &full).await.unwrap(), Some(c.clone()));
        assert_eq!(
            reflog_subject(&repo, "HEAD").await,
            "reset: moving to HEAD~1"
        );
        assert_eq!(ref_oid(&repo, "ORIG_HEAD").await.unwrap(), Some(c));
    }

    /// `feature` and the base branch each rewrite `a.txt` on top of A, so merging or
    /// picking `feature` conflicts. HEAD ends on the base branch at B; returns (A, B).
    async fn diverged(dir: &tempfile::TempDir, repo: &str) -> (String, String) {
        let a = raw_commit(dir, repo, "a.txt", "A").await;
        let base = run(repo, &["symbolic-ref", "--short", "HEAD"])
            .await
            .trim()
            .to_string();
        run(repo, &["switch", "-qc", "feature"]).await;
        raw_commit(dir, repo, "a.txt", "theirs").await;
        run(repo, &["switch", "-q", &base]).await;
        let b = raw_commit(dir, repo, "a.txt", "mine").await;
        (a, b)
    }

    async fn resolve_ours(repo: &str) {
        run(repo, &["checkout", "--ours", "--", "a.txt"]).await;
        run(repo, &["add", "a.txt"]).await;
    }

    /// The swap would move a branch under a stopped merge, so the undo refuses on the pair
    /// `reset --soft` refuses on, each with its own copy: MERGE_HEAD, or unmerged entries
    /// without it (a conflicted squash). Once the squash is resolved neither is left, and
    /// the undo runs as git's would, clearing the squash's message files with it.
    #[tokio::test]
    async fn soft_undo_refuses_mid_merge_and_runs_after_a_resolved_squash() {
        let (dir, repo) = amend_fixture("gd-undo-mid-merge-", &[]).await;
        let (_, b) = diverged(&dir, &repo).await;
        let merge = run_git_raw(
            Some(&repo),
            &["merge", "--no-edit", "feature"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(merge.code, 0, "fixture: the merge stops on its conflict");
        resolve_ours(&repo).await;
        assert!(crate::git::ops::op_state(&repo).await.unwrap().merging);
        assert_undo_refused(
            undo_on(&repo, Some(b.clone()), branch_here(&repo).await).await,
            UNDO_MID_MERGE,
        );
        assert_eq!(head(&repo).await, b);

        let (dir, repo) = amend_fixture("gd-undo-mid-squash-", &[]).await;
        let (a, b) = diverged(&dir, &repo).await;
        let squash = run_git_raw(
            Some(&repo),
            &["merge", "--squash", "feature"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(squash.code, 0, "fixture: the squash stops on its conflict");
        assert_eq!(ref_oid(&repo, "MERGE_HEAD").await.unwrap(), None);
        assert_undo_refused(
            undo_on(&repo, Some(b.clone()), branch_here(&repo).await).await,
            UNDO_UNRESOLVED,
        );
        assert_eq!(head(&repo).await, b);

        resolve_ours(&repo).await;
        assert!(
            branch_state_present(&repo).await.contains(&"SQUASH_MSG"),
            "fixture: the resolved squash leaves its message behind"
        );
        undo_on(&repo, Some(b), branch_here(&repo).await)
            .await
            .expect("a resolved squash leaves nothing to refuse");
        assert_eq!(head(&repo).await, a);
        assert!(branch_state_present(&repo).await.is_empty());
    }

    /// Parity with git's own `reset --soft HEAD~1`, measured on twin repos (git 2.51.1):
    /// both clear MERGE_MSG, SQUASH_MSG, MERGE_MODE, MERGE_RR and AUTO_MERGE. git's reset
    /// also clears CHERRY_PICK_HEAD and REVERT_HEAD, which the undo never reaches: it
    /// refuses a stopped pick or revert (the test below) rather than cancel it. Both file a
    /// stopped autostash in the stash list.
    #[tokio::test]
    async fn soft_undo_clears_the_branch_state_git_reset_clears() {
        let unguarded = [
            "MERGE_MSG",
            "SQUASH_MSG",
            "MERGE_MODE",
            "MERGE_RR",
            "AUTO_MERGE",
        ];
        for ours in [false, true] {
            let (dir, repo) = amend_fixture("gd-undo-parity-", &[]).await;
            raw_commit(&dir, &repo, "a.txt", "A").await;
            let b = raw_commit(&dir, &repo, "b.txt", "B").await;
            write_unguarded_branch_state(&repo, &b).await;
            assert_eq!(branch_state_present(&repo).await, unguarded);

            if ours {
                undo(&repo, Some(b)).await.expect("the undo runs");
            } else {
                run(&repo, &["reset", "--soft", "HEAD~1"]).await;
            }

            assert!(branch_state_present(&repo).await.is_empty(), "ours: {ours}");
        }
        for name in ["CHERRY_PICK_HEAD", "REVERT_HEAD"] {
            let (dir, repo) = amend_fixture("gd-undo-parity-pick-", &[]).await;
            raw_commit(&dir, &repo, "a.txt", "A").await;
            let b = raw_commit(&dir, &repo, "b.txt", "B").await;
            run(&repo, &["update-ref", name, &b]).await;
            run(&repo, &["reset", "--soft", "HEAD~1"]).await;
            assert!(
                branch_state_present(&repo).await.is_empty(),
                "git's reset clears {name}"
            );
        }
        // A stopped `merge --squash --autostash`: git files MERGE_AUTOSTASH in the stash
        // list as "autostash" instead of dropping it.
        for ours in [false, true] {
            let (dir, repo) = amend_fixture("gd-undo-parity-autostash-", &[]).await;
            raw_commit(&dir, &repo, "a.txt", "A").await;
            let autostash = stop_an_autostashed_squash(&repo).await;
            let tip = head(&repo).await;

            if ours {
                undo(&repo, Some(tip)).await.expect("the undo runs");
            } else {
                run(&repo, &["reset", "--soft", "HEAD~1"]).await;
            }

            assert!(branch_state_present(&repo).await.is_empty(), "ours: {ours}");
            assert_eq!(
                run(&repo, &["stash", "list", "--format=%gs"]).await,
                "autostash\n",
                "ours: {ours}"
            );
            assert_eq!(
                run(&repo, &["rev-parse", "stash@{0}"]).await.trim(),
                autostash,
                "ours: {ours}"
            );
        }
    }

    /// A stopped cherry-pick or revert refuses the undo: git's `reset --soft` would cancel
    /// it, keeping or clearing its sequencer by how many picks remain. The pick stays
    /// exactly as it was, to finish or abort.
    #[tokio::test]
    async fn soft_undo_refuses_while_a_pick_or_revert_is_stopped() {
        for (verb, marker) in [
            ("cherry-pick", "CHERRY_PICK_HEAD"),
            ("revert", "REVERT_HEAD"),
        ] {
            let (dir, repo) = amend_fixture("gd-undo-mid-pick-", &[]).await;
            let (_, b) = diverged(&dir, &repo).await;
            let target = if verb == "revert" {
                // Rewritten again on top, so reverting B conflicts.
                raw_commit(&dir, &repo, "a.txt", "later").await;
                b
            } else {
                "feature".to_string()
            };
            let stopped = run_git_raw(Some(&repo), &[verb, "--no-edit", &target], DEFAULT_TIMEOUT)
                .await
                .unwrap();
            assert_ne!(stopped.code, 0, "fixture: the {verb} stops on its conflict");
            resolve_ours(&repo).await;
            let tip = head(&repo).await;

            assert_undo_refused(
                undo_on(&repo, Some(tip.clone()), branch_here(&repo).await).await,
                UNDO_MID_PICK,
            );
            assert_eq!(head(&repo).await, tip);
            assert!(
                ref_oid(&repo, marker).await.unwrap().is_some(),
                "the {verb} is still there to finish or abort"
            );
        }
    }

    /// The root arm shares those refusals: a branch whose only commit has a stopped
    /// cherry-pick on it refuses the undo rather than deleting the branch under the pick.
    #[tokio::test]
    async fn root_undo_refuses_while_a_pick_is_stopped() {
        let (dir, repo) = amend_fixture("gd-undo-root-mid-pick-", &[]).await;
        let a = raw_commit(&dir, &repo, "a.txt", "A").await;
        let full = run(&repo, &["symbolic-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        let start = run(&repo, &["symbolic-ref", "--short", "HEAD"])
            .await
            .trim()
            .to_string();
        // A root commit of its own writing `a.txt` too, so picking it is an add/add conflict.
        run(&repo, &["switch", "-q", "--orphan", "other"]).await;
        let other = raw_commit(&dir, &repo, "a.txt", "other").await;
        run(&repo, &["switch", "-q", &start]).await;
        let stopped = run_git_raw(Some(&repo), &["cherry-pick", &other], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_ne!(stopped.code, 0, "fixture: the pick stops on its conflict");
        resolve_ours(&repo).await;

        assert_undo_refused(
            undo_on(&repo, Some(a.clone()), branch_here(&repo).await).await,
            UNDO_MID_PICK,
        );
        assert_eq!(
            ref_oid(&repo, &full).await.unwrap(),
            Some(a),
            "the branch is intact"
        );
        assert!(
            ref_oid(&repo, "CHERRY_PICK_HEAD").await.unwrap().is_some(),
            "the pick is still there to finish or abort"
        );
    }

    /// Another process commits on top of the pin after the amend's checks. The amend still
    /// lands, rewriting the racer's commit, and reports that commit by its oid.
    #[tokio::test]
    async fn a_raced_amend_reports_the_commit_it_rewrote() {
        let (dir, repo) = amend_fixture("gd-amend-raced-commit-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let seen = branch_here(&repo).await;
        let (commit, landed) = racing_commit(&repo, "c.txt");

        let result = AMEND_PHASE_HOOK
            .scope(commit, amend_on(&repo, "B reworded", Some(b.clone()), seen))
            .await
            .expect("a raced amend still lands");

        let racer = racer_landed(&landed);
        assert_eq!(
            result.raced,
            Some(AmendRace {
                rewrote: Some(racer.clone()),
                branch: None,
                detached: false,
            })
        );
        assert_eq!(head(&repo).await, result.hash);
        assert_eq!(head_subject(&repo).await, "B reworded");
        assert_eq!(run(&repo, &["rev-parse", "HEAD~1"]).await.trim(), b);
        assert_eq!(
            run(&repo, &["rev-parse", "HEAD@{1}"]).await.trim(),
            racer,
            "the racer's commit is in the reflog"
        );
    }

    /// A racer that amends the pin itself keeps the pin's parents, so HEAD's reflog is
    /// what names the commit the amend rewrote.
    #[tokio::test]
    async fn a_raced_amend_reports_a_racers_amend_of_the_pin() {
        let (dir, repo) = amend_fixture("gd-amend-raced-amend-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let seen = branch_here(&repo).await;
        let amend = racing_git(&repo, &[&["commit", "--amend", "-qm", "B by racer"]]);

        let result = AMEND_PHASE_HOOK
            .scope(amend, amend_on(&repo, "B reworded", Some(b.clone()), seen))
            .await
            .expect("a raced amend still lands");

        let race = result.raced.expect("the race is reported");
        assert_eq!(race.branch, None);
        let rewrote = race
            .rewrote
            .expect("HEAD's reflog names the rewritten commit");
        assert_ne!(rewrote, b);
        assert_eq!(
            run(&repo, &["log", "-1", "--format=%s", &rewrote])
                .await
                .trim(),
            "B by racer"
        );
        assert_eq!(head_subject(&repo).await, "B reworded");
    }

    /// Another process switches to a new branch at the pinned commit after the checks:
    /// the amend lands there, reported by that branch's name, and the pinned branch keeps
    /// the commit the user saw.
    #[tokio::test]
    async fn a_raced_amend_reports_the_branch_it_landed_on() {
        let (dir, repo) = amend_fixture("gd-amend-raced-switch-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let full = run(&repo, &["symbolic-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        let seen = branch_here(&repo).await;
        let switch = racing_git(&repo, &[&["switch", "-qc", "other"]]);

        let result = AMEND_PHASE_HOOK
            .scope(switch, amend_on(&repo, "B reworded", Some(b.clone()), seen))
            .await
            .expect("a raced amend still lands");

        assert_eq!(
            result.raced,
            Some(AmendRace {
                rewrote: None,
                branch: Some("other".into()),
                detached: false,
            })
        );
        assert_eq!(
            ref_oid(&repo, &full).await.unwrap(),
            Some(b),
            "the pin's branch"
        );
        assert_eq!(
            ref_oid(&repo, "refs/heads/other").await.unwrap(),
            Some(result.hash)
        );
    }

    /// Another process detaches HEAD at the pinned commit after the checks: the amend lands
    /// on the detached HEAD, reported as detached, and the pinned branch keeps its commit.
    #[tokio::test]
    async fn a_raced_amend_reports_a_detached_head() {
        let (dir, repo) = amend_fixture("gd-amend-raced-detach-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let full = run(&repo, &["symbolic-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        let seen = branch_here(&repo).await;
        let detach = racing_git(&repo, &[&["checkout", "-q", "--detach"]]);

        let result = AMEND_PHASE_HOOK
            .scope(detach, amend_on(&repo, "B reworded", Some(b.clone()), seen))
            .await
            .expect("a raced amend still lands");

        assert_eq!(
            result.raced,
            Some(AmendRace {
                rewrote: None,
                branch: None,
                detached: true,
            })
        );
        assert_eq!(
            ref_oid(&repo, &full).await.unwrap(),
            Some(b),
            "the pin's branch"
        );
        assert_eq!(head(&repo).await, result.hash);
    }

    /// Another process switches branches right after the undo's swap landed, which the swap
    /// (it compares only the branch's own oid) can't see: HEAD's re-read moves the branch
    /// back exactly and refuses. A branch at another commit and one at the pinned tip both
    /// count.
    #[tokio::test]
    async fn soft_undo_moves_back_and_refuses_a_switch_right_after_its_swap() {
        for target in ["side", "twin"] {
            let (dir, repo) = amend_fixture("gd-undo-switched-after-", &[]).await;
            raw_commit(&dir, &repo, "a.txt", "A").await;
            let b = raw_commit(&dir, &repo, "b.txt", "B").await;
            let full = run(&repo, &["symbolic-ref", "HEAD"])
                .await
                .trim()
                .to_string();
            let seen = branch_here(&repo).await;
            let start = run(&repo, &["symbolic-ref", "--short", "HEAD"])
                .await
                .trim()
                .to_string();
            run(&repo, &["branch", "twin"]).await;
            run(&repo, &["switch", "-qc", "side"]).await;
            raw_commit(&dir, &repo, "s.txt", "S").await;
            run(&repo, &["switch", "-q", &start]).await;

            let result = UNDO_SWAPPED_HOOK
                .scope(
                    racing_git(&repo, &[&["switch", "-q", target]]),
                    undo_on(&repo, Some(b.clone()), seen),
                )
                .await;

            assert_undo_refused(result, UNDO_BRANCH_SWITCHED);
            assert_eq!(ref_oid(&repo, &full).await.unwrap(), Some(b), "{target}");
            assert_eq!(
                run(&repo, &["symbolic-ref", "--short", "HEAD"])
                    .await
                    .trim(),
                target,
                "the switch stands"
            );
            assert_eq!(ref_oid(&repo, "ORIG_HEAD").await.unwrap(), None, "{target}");
            assert_eq!(reflog_subject(&repo, &full).await, "reset: rolling back");
        }
    }

    /// A depth-1 clone's boundary commit records a parent it never fetched, and
    /// `commit --amend` reads it through the shallow graft, minting a parentless commit. A
    /// clean amend there is no race. A commit landing on top of the boundary still is,
    /// caught by the parents alone once the racer's reflog is gone.
    #[tokio::test]
    async fn an_amend_of_a_shallow_boundary_reads_parents_through_the_graft() {
        let (dir, source) = amend_fixture("gd-amend-shallow-", &[]).await;
        raw_commit(&dir, &source, "a.txt", "A").await;
        raw_commit(&dir, &source, "b.txt", "B").await;
        // `--depth` is ignored for a plain local path, so the source goes by URL.
        let path = source.replace('\\', "/");
        let url = if path.starts_with('/') {
            format!("file://{path}")
        } else {
            format!("file:///{path}")
        };
        let clone = dir.path().join("clone").to_string_lossy().into_owned();
        run_git(
            None,
            &["clone", "-q", "--depth", "1", &url, &clone],
            DEFAULT_TIMEOUT,
        )
        .await
        .expect("the shallow clone succeeds");
        run(&clone, &["config", "user.email", "t@t.local"]).await;
        run(&clone, &["config", "user.name", "T"]).await;
        let boundary = head(&clone).await;

        let clean = amend_on(
            &clone,
            "B reworded",
            Some(boundary),
            branch_here(&clone).await,
        )
        .await
        .expect("the amend runs");
        assert_eq!(
            clean.raced, None,
            "a clean amend of the boundary is no race"
        );

        // HEAD@{1} answers from a fresh log's one entry, and from the branch's log when HEAD
        // has none, so the reflog signal is silenced only by no logs at all (measured, git
        // 2.51.1).
        run(&clone, &["config", "core.logAllRefUpdates", "false"]).await;
        let (commit, landed) = racing_commit(&clone, "c.txt");
        let expire: PhaseHook = std::sync::Arc::new({
            let clone = clone.clone();
            move || {
                let (clone, commit) = (clone.clone(), commit.clone());
                Box::pin(async move {
                    commit().await;
                    let logs = run(&clone, &["rev-parse", "--git-path", "logs"]).await;
                    std::fs::remove_dir_all(std::path::Path::new(&clone).join(logs.trim()))
                        .unwrap();
                })
            }
        });
        let raced = AMEND_PHASE_HOOK
            .scope(
                expire,
                amend_on(
                    &clone,
                    "B again",
                    Some(clean.hash.clone()),
                    branch_here(&clone).await,
                ),
            )
            .await
            .expect("a raced amend still lands");
        assert_eq!(
            raced.raced,
            Some(AmendRace {
                rewrote: None,
                branch: None,
                detached: false,
            }),
            "with no reflog to read, the parents name the race"
        );
        assert_eq!(
            run(&clone, &["rev-parse", "HEAD~1"]).await.trim(),
            clean.hash,
            "the amend replaced the racer's {}",
            racer_landed(&landed)
        );
    }

    /// No race, no report: a pinned amend on the branch it saw, and an unpinned one.
    #[tokio::test]
    async fn a_clean_amend_reports_no_race() {
        let (dir, repo) = amend_fixture("gd-amend-clean-", &[]).await;
        raw_commit(&dir, &repo, "a.txt", "A").await;
        let b = raw_commit(&dir, &repo, "b.txt", "B").await;
        let seen = branch_here(&repo).await;

        let pinned = amend_on(&repo, "B reworded", Some(b), seen)
            .await
            .expect("the amend runs");
        assert_eq!(pinned.raced, None);
        assert_eq!(pinned.hash, head(&repo).await);

        let unpinned = amend_expecting(&repo, "B again", None)
            .await
            .expect("the amend runs");
        assert_eq!(unpinned.raced, None);
        assert_eq!(head_subject(&repo).await, "B again");
    }

    /// The wire shape the commit box and the MCP commit tool read: exactly `hash` and
    /// `raced`, the race's single-word fields inside, and `raced: null` when clean.
    #[test]
    fn commit_result_serializes_its_race_report() {
        let clean = CommitResult {
            hash: "abc".into(),
            raced: None,
        };
        assert_eq!(
            serde_json::to_value(&clean).unwrap(),
            serde_json::json!({ "hash": "abc", "raced": null })
        );
        let raced = CommitResult {
            hash: "abc".into(),
            raced: Some(AmendRace {
                rewrote: Some("def".into()),
                branch: None,
                detached: false,
            }),
        };
        assert_eq!(
            serde_json::to_value(&raced).unwrap(),
            serde_json::json!({
                "hash": "abc",
                "raced": { "rewrote": "def", "branch": null, "detached": false }
            })
        );
    }
}
