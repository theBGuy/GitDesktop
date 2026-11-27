use super::*;

/// Deletes a branch on a remote, always leased on `expected_tip`, the tip the caller's row
/// showed ([`delete_remote_branch_at_tip`]); a missing or empty tip refuses. The push
/// authenticates with the same one-shot provider-CLI credential entries `git_push` uses, so
/// a stale ambient credential can't shadow the signed-in CLI's identity.
#[tauri::command]
pub async fn git_delete_remote_branch(
    state: State<'_, AppState>,
    repo_path: String,
    remote: String,
    name: String,
    expected_tip: Option<String>,
) -> AppResult<()> {
    delete_remote_branch_at_tip(&state, &repo_path, &remote, &name, expected_tip.as_deref()).await
}

/// The unleased `git push <remote> --delete`, for callers with no listed tip (the MCP tool);
/// the branch menu deletes through [`delete_remote_branch_at_tip`].
pub(crate) async fn git_delete_remote_branch_core(
    state: &AppState,
    repo_path: String,
    remote: String,
    name: String,
) -> AppResult<()> {
    refuse_remote_branch_delete(&repo_path, &remote, &name).await?;
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
    remote_delete_answer(&repo_path, &remote, &name, out.map(|_| ())).await
}

/// The delete leased on `expected_tip`, after the plain delete's refusals. No tip, or an
/// empty one, refuses before any git runs. The leased tip and the read that tells a gone
/// branch from a moved one both come from the fetch repository while the push writes every
/// push URL, so it also refuses unless exactly one push URL names the fetch repository
/// ([`push_reaches_fetch_repository`]), and unless the fetch settings tie the row to `name`
/// on `remote` ([`tracking_ref_is_branch_own`]), since the row's tip is what the lease
/// names. A failed URL or settings read is returned as its own error. Every refusal and
/// error comes before anything is dropped or pushed. A refused lease is told apart by a
/// read after it: gone is done, still listed or unread refuses with nothing deleted on the
/// remote. Any other failure answers as the plain delete's does.
async fn delete_remote_branch_at_tip(
    state: &AppState,
    repo_path: &str,
    remote: &str,
    name: &str,
    expected_tip: Option<&str>,
) -> AppResult<()> {
    let Some(expected_tip) = expected_tip.filter(|tip| !tip.is_empty()) else {
        return Err(AppError::Command(format!(
            "Couldn't read which commit {remote}/{name} is at, so it wasn't deleted. Fetch, then try again."
        )));
    };
    full_object_id(expected_tip)?;
    refuse_remote_branch_delete(repo_path, remote, name).await?;
    // The remote `.` and a rev-expression name (`old~1`) pass the refusals above. Each is
    // refused here with the error the leased delete gives it, before the URL read below.
    if !crate::git::remote::is_named_remote(remote) {
        return Err(AppError::InvalidArgument(format!(
            "invalid remote: {remote}"
        )));
    }
    validate_branch_name(name)?;
    if !push_reaches_fetch_repository(repo_path, remote).await? {
        return Err(AppError::Command(format!(
            "{remote} pushes to a different address than it fetches from, so GitDesktop can't check {name} before deleting it. Nothing was deleted."
        )));
    }
    if !tracking_ref_is_branch_own(repo_path, remote, name).await? {
        return Err(AppError::Command(format!(
            "GitDesktop can't confirm from this clone's fetch settings that {remote}/{name} came from {name} on {remote}, so it can't check {name} before deleting it. Nothing was deleted."
        )));
    }
    match delete_remote_branch_leased(state, repo_path, remote, name, expected_tip).await {
        RemoteDeleteLeased::Deleted | RemoteDeleteLeased::AlreadyGone => Ok(()),
        RemoteDeleteLeased::Moved | RemoteDeleteLeased::Unread(_) => Err(AppError::Command(format!(
            "{remote}/{name} isn't at the commit this delete was confirmed for, so it wasn't deleted. Fetch, then check it before you delete it."
        ))),
        RemoteDeleteLeased::Failed(error) => {
            remote_delete_answer(repo_path, remote, name, Err(error)).await
        }
    }
}

/// The plain remote delete's refusals, before anything is dropped or pushed.
async fn refuse_remote_branch_delete(repo_path: &str, remote: &str, name: &str) -> AppResult<()> {
    validate_ref_name(remote)?;
    validate_ref_name(name)?;
    if name == "HEAD" {
        return Err(AppError::InvalidArgument(REMOTE_HEAD_POINTER.into()));
    }
    crate::git::status::refuse_mirror_push(
        repo_path,
        crate::git::status::PushRemote::Named(remote),
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
        Some(repo_path),
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
    Ok(())
}

/// A remote delete push's answer.
async fn remote_delete_answer(
    repo_path: &str,
    remote: &str,
    name: &str,
    out: AppResult<()>,
) -> AppResult<()> {
    match out {
        Ok(()) => Ok(()),
        // Already gone on the server, so done; a failed push prunes no tracking ref, so the
        // row's own one is dropped here (`drop_own_tracking_ref`).
        Err(AppError::Git { stderr, .. })
            if stderr.to_lowercase().contains("remote ref does not exist") =>
        {
            drop_own_tracking_ref(repo_path, remote, name).await;
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
    /// rename; `push_remote` is the name as configured, a URL's userinfo replaced by `***`.
    PushesElsewhere { push_remote: String },
    /// `remote.<remote>.mirror` is set.
    Mirror,
    /// The remote pushes somewhere other than the repository it fetches from, or to several.
    PushUrlDiffers,
    /// The names differ only in letter case and this store's refs can alias.
    CaseOnly,
    /// The remote's fetch refspecs provably never fetch the new name.
    NewNotFetched,
    /// A positive fetch entry of the remote names the old branch by its full, `heads/` or
    /// bare spelling. A fetch that uses these settings (the app's Fetch passes no refspec)
    /// fails once the old name is deleted on the remote, unless that spelling also resolves
    /// to another ref there.
    OldFetchedByName,
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
/// is the local rename's [`RenameBranchOutcome::warning`], plus, after a successful push
/// whose upstream read does not show `<new>` tracking `<remote>/<new>`, at most one
/// sentence: the lost-upstream one when `<new>`'s config does not name `<remote>` and
/// `refs/heads/<new>`, or the fetch-settings one when it does and the read shows no
/// tracking ref mapped. A failed config read, or a right config with an upstream read that
/// failed or proved nothing, adds neither, so no sentence does not prove `<new>` reads as
/// tracked here (a tracking ref deleted between the push and the read is one such case).
/// Neither sentence rides `PushFailed`.
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
    /// The new name is pushed; `warning` may carry either upstream sentence, and its
    /// absence does not prove the new name is tracked here. The old remote branch was not
    /// deleted, except after `Failed`, where it may have been.
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
    let (copy, seen) = pushed_branch_contains(repo, &remote, &new_name, &old_tip).await;
    let warning = if seen == UpstreamSeen::Tracked {
        warning
    } else {
        with_lost_upstream_warning(repo, &remote, &new_name, seen, warning).await
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
    let cause = match delete_remote_branch_leased(state, repo, &remote, &old_name, &old_tip).await {
        RemoteDeleteLeased::Deleted | RemoteDeleteLeased::AlreadyGone => {
            return Ok(RemoteRenameOutcome::Renamed { warning })
        }
        RemoteDeleteLeased::Moved => OldKeptCause::Moved,
        RemoteDeleteLeased::Failed(AppError::Git { stderr, .. })
            if is_remote_rejection(&stderr) =>
        {
            OldKeptCause::Rejected {
                detail: remote_rejection_detail(&stderr),
            }
        }
        RemoteDeleteLeased::Unread(error) | RemoteDeleteLeased::Failed(error) => {
            OldKeptCause::Failed { error }
        }
    };
    Ok(RemoteRenameOutcome::OldKept { warning, cause })
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
                push_remote: crate::git::remote::redact_url_userinfo(push_remote),
            });
        }
    }
    let target = crate::git::status::PushRemote::Named(remote);
    match crate::git::status::refuse_mirror_push(repo_path, target).await {
        Err(AppError::PushRemoteIsMirror { .. }) => return refused(Refusal::Mirror),
        other => other?,
    }
    if !push_reaches_fetch_repository(repo_path, remote).await? {
        return refused(Refusal::PushUrlDiffers);
    }
    if is_case_only_rename(old, new) && refs_can_alias_strict(repo_path).await? {
        return refused(Refusal::CaseOnly);
    }
    // Both fetch-settings rules run only once a new name is given; `NewNotFetched` answers
    // first, so the old-name rule refuses only the configurations it lets through.
    if let Some(new) = new {
        let listed = config.fetch_entries(remote);
        if fetch_sources_never_map(&listed, &branch_full_ref(new)?, new) {
            return refused(Refusal::NewNotFetched);
        }
        if fetch_entry_names_branch(&listed, &branch_full_ref(old)?, old) {
            return refused(Refusal::OldFetchedByName);
        }
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

/// Whether a push to `remote` writes the repository it fetches from: reads its fetch URL
/// and every push URL with `git remote get-url`, and passes only exactly one push URL naming
/// the fetch repository ([`same_push_repository`]). Addresses compare as git printed them,
/// minus each output's one final newline: nothing is trimmed and an empty line is an
/// address, since git prints edge whitespace and an embedded newline as part of the value.
/// A failed read is the `Err`. The remote rename's check and the leased remote delete both
/// call it.
async fn push_reaches_fetch_repository(repo_path: &str, remote: &str) -> AppResult<bool> {
    // Read uncached: the push URLs below are live, and a cached fetch URL could compare a
    // `set-url` from the last few seconds against the one before it.
    let fetch_out = run_git(
        Some(repo_path),
        &["remote", "get-url", remote],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy();
    let fetch_url = fetch_out.strip_suffix('\n').unwrap_or(&fetch_out);
    // `--all`: a plain `get-url --push` prints only the first of several push URLs.
    let listed = run_git(
        Some(repo_path),
        &["remote", "get-url", "--push", "--all", remote],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy();
    // Split on LF alone: git ends each line with LF and prints a CR the value itself holds,
    // which `lines` would drop from the end of an address.
    let push_urls: Vec<&str> = listed
        .strip_suffix('\n')
        .unwrap_or(&listed)
        .split('\n')
        .collect();
    Ok(same_push_repository(fetch_url, &push_urls))
}

/// Whether a push to `push_urls` writes the repository `fetch_url` reads: exactly one push
/// URL, textually the fetch URL or the same path by `forge::remote_path` and, within one
/// transport family ([`url_transport`]), the same authority by `forge::remote_authority`
/// (port included unless it is the scheme's default, case-insensitive) and the same ssh
/// user, whose home a relative scp path starts from. Across families (ssh beside https) only
/// the host must match, since each serves its own port. A side these fns can't parse refuses,
/// and so does an address with edge whitespace that is not byte-equal to the other, because
/// the identity parse trims it.
fn same_push_repository(fetch_url: &str, push_urls: &[&str]) -> bool {
    let [push_url] = push_urls else {
        return false;
    };
    if *push_url == fetch_url {
        return true;
    }
    if push_url.trim() != *push_url || fetch_url.trim() != fetch_url {
        return false;
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
pub(super) const REMOTE_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

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

/// What the upstream read of the pushed branch shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UpstreamSeen {
    /// Its exact line reads a live upstream `<remote>/<new>`.
    Tracked,
    /// Its exact line has an empty `%(upstream)`: git maps no tracking ref for it.
    Unmapped,
    /// Anything else: a failed read, no exact line, a line whose mapped tracking ref is
    /// gone, or a live upstream other than `<remote>/<new>`: on another remote, or on
    /// `<remote>` under another branch name (the config still naming the old branch while
    /// its tracking ref is still there).
    Unconfirmed,
}

/// The upstream read's answer for `new` on `remote` as an [`UpstreamSeen`].
fn upstream_seen(
    read: &AppResult<Option<BranchUpstream>>,
    remote: &str,
    new: &str,
) -> UpstreamSeen {
    match read {
        Ok(Some(up)) if up.live_branch() == Some(new) && up.remote == remote => {
            UpstreamSeen::Tracked
        }
        Ok(Some(up)) if up.tracking_ref.is_empty() => UpstreamSeen::Unmapped,
        _ => UpstreamSeen::Unconfirmed,
    }
}

/// Whether the pushed `new` holds `old_tip`, proven against the remote's live tip (a
/// tracking ref the push wrote can be held at an older value by a leftover lock), and what
/// the upstream read of `new` shows, which steers only the warning.
async fn pushed_branch_contains(
    repo_path: &str,
    remote: &str,
    new: &str,
    old_tip: &str,
) -> (PushedCopy, UpstreamSeen) {
    let seen = upstream_seen(&read_branch_upstream(repo_path, new).await, remote, new);
    let Some(target) = live_pushed_tip(repo_path, remote, new).await else {
        return (PushedCopy::Unknown, seen);
    };
    let copy = match is_strict_ancestor(repo_path, old_tip, &target).await {
        Ok(true) => PushedCopy::Contains,
        Ok(false) => PushedCopy::Missing,
        Err(_) => PushedCopy::Unknown,
    };
    (copy, seen)
}

/// Each positive entry's source: one leading `+` stripped, `^` entries skipped, cut at
/// the first `:`. An empty entry writes no tracking ref and is skipped.
fn positive_fetch_sources(listed: &str) -> impl Iterator<Item = &str> {
    listed
        .lines()
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.strip_prefix('+').unwrap_or(entry))
        .filter(|entry| !entry.starts_with('^'))
        .map(|entry| entry.split_once(':').map_or(entry, |(source, _)| source))
}

/// Whether a positive entry's source is `branch_ref`, its `heads/` form or the bare
/// `branch`, with any destination, an empty one or none. git resolves the two short
/// spellings on the remote's ref list, so with no other ref of that spelling there each
/// names the branch, and a fetch by these settings fails once the branch is gone (probed
/// on git 2.51.1 for Windows and 2.47.3 on Linux). Sources compare as bytes, so a case
/// variant or a glob never matches. When the remote also has another ref the spelling
/// resolves to (a tag `<branch>` for the bare spelling, a tag `heads/<branch>` for the
/// `heads/` one), that fetch keeps working after the branch is gone and this still
/// answers yes: a false refusal, toward inaction.
fn fetch_entry_names_branch(listed: &str, branch_ref: &str, branch: &str) -> bool {
    let heads = branch_ref.strip_prefix("refs/");
    positive_fetch_sources(listed)
        .any(|source| source == branch_ref || Some(source) == heads || source == branch)
}

/// Whether the entries provably never fetch `new_ref`. A negative entry (its first
/// character `^`) whose pattern excludes `new_ref` answers yes whatever else is listed.
/// Otherwise, among full `refs/…` sources git maps `new_ref` only through a `*`, `new_ref`
/// itself or the bare `new` (git can resolve `refs/x` to `refs/heads/refs/x`); with none of
/// those, and no short source to resolve on the remote, no entry maps it. No positive
/// entry and no excluding negative one, no verdict.
fn fetch_sources_never_map(listed: &str, new_ref: &str, new: &str) -> bool {
    if listed
        .lines()
        .filter_map(|entry| entry.strip_prefix('^'))
        .any(|pattern| negative_pattern_excludes(pattern, new_ref))
    {
        return true;
    }
    let mut sources = positive_fetch_sources(listed).peekable();
    sources.peek().is_some()
        && sources.all(|source| {
            source.starts_with("refs/")
                && !source.contains('*')
                && source != new_ref
                && source != new
        })
}

/// Whether a negative entry's pattern excludes `full_ref`, as git's fetch compares them:
/// against the remote's full ref name. A pattern without `*` excludes only the identical
/// name, byte for byte, so a short one (`heads/new`, `new`) never does. A pattern with a
/// `*` excludes it when the text before the first `*` is a prefix, the rest a suffix, and
/// the two fit in the name without overlapping; the `*` matches any run (empty, or across
/// `/`), so one with nothing before it (`*new`, `*/new`) excludes a full ref name too
/// (probed on git 2.51.1 for Windows and 2.47.3 on Linux).
fn negative_pattern_excludes(pattern: &str, full_ref: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == full_ref,
        Some((prefix, suffix)) => {
            full_ref.len() >= prefix.len() + suffix.len()
                && full_ref.starts_with(prefix)
                && full_ref.ends_with(suffix)
        }
    }
}

/// What one fetch entry does to a tracking ref: names no write to it, writes it from the
/// source it names, or is an entry git rejects.
enum FetchEntryWrite {
    Nothing,
    From(String),
    Rejected,
}

/// Reads one fetch entry against `tracking_ref`. Empty or negative (`^` first) writes
/// nothing; one leading `+` is the force flag; the entry is cut at the first `:`, and no
/// destination writes nothing. A `*` on one side only, or two on a side, is an entry git
/// rejects. An exact destination is its full name when it starts `refs/`, takes `refs/` in
/// front when it starts `remotes/`, and else writes no tracking ref. A pattern destination
/// is matched against `tracking_ref` itself, never by its literal lead, and counts only when
/// the name it expands to starts with the bytes `refs/`, as git tests the expanded name.
/// Destinations compare by bytes, or ignoring case when `refs_alias`.
fn fetch_entry_write(entry: &str, tracking_ref: &str, refs_alias: bool) -> FetchEntryWrite {
    if entry.is_empty() || entry.starts_with('^') {
        return FetchEntryWrite::Nothing;
    }
    let entry = entry.strip_prefix('+').unwrap_or(entry);
    let Some((source, dest)) = entry.split_once(':') else {
        return FetchEntryWrite::Nothing;
    };
    if dest.is_empty() {
        return FetchEntryWrite::Nothing;
    }
    match (source.split_once('*'), dest.split_once('*')) {
        (None, None) => {
            let full = if dest.starts_with("refs/") {
                dest.to_string()
            } else if dest.starts_with("remotes/") {
                format!("refs/{dest}")
            } else {
                return FetchEntryWrite::Nothing;
            };
            let writes = if refs_alias {
                eq_ignoring_case(&full, tracking_ref)
            } else {
                full == tracking_ref
            };
            if writes {
                FetchEntryWrite::From(source.to_string())
            } else {
                FetchEntryWrite::Nothing
            }
        }
        (Some((src_pre, src_suf)), Some((dst_pre, dst_suf)))
            if !src_suf.contains('*') && !dst_suf.contains('*') =>
        {
            match pattern_run(tracking_ref, dst_pre, dst_suf, refs_alias) {
                Some(run) if format!("{dst_pre}{run}{dst_suf}").starts_with("refs/") => {
                    FetchEntryWrite::From(format!("{src_pre}{run}{src_suf}"))
                }
                _ => FetchEntryWrite::Nothing,
            }
        }
        _ => FetchEntryWrite::Rejected,
    }
}

/// The run of `name` a pattern's `*` takes: `name` split into `prefix`, the run (possibly
/// empty) and `suffix`, the two not overlapping. Under `fold` each part is matched by
/// [`eq_ignoring_case`] at a char boundary; lowercasing never shortens a char, so at most
/// one boundary matches each part. None when `name` does not split that way.
fn pattern_run<'a>(name: &'a str, prefix: &str, suffix: &str, fold: bool) -> Option<&'a str> {
    if !fold {
        return name.strip_prefix(prefix)?.strip_suffix(suffix);
    }
    let boundaries = || name.char_indices().map(|(i, _)| i).chain([name.len()]);
    let start = boundaries().find(|&i| eq_ignoring_case(&name[..i], prefix))?;
    let end = boundaries()
        .filter(|&j| j >= start)
        .find(|&j| eq_ignoring_case(&name[j..], suffix))?;
    Some(&name[start..end])
}

/// Whether the fetch entries tie `tracking_ref` to `branch_ref` and to nothing else they
/// name: `own` (this remote's entries) names `branch_ref` as the source of every entry that
/// writes the row, at least one does, and no entry of `others` (every other remote's)
/// writes it, whatever its source. An entry with a destination whose `*` layout git rejects
/// (a `*` on one side only, or two on a side), in either listing, answers no. Each listing
/// holds one entry per line, read by [`fetch_entry_write`]; sources compare by bytes, as a
/// server's names are case-sensitive. A negative entry adds no source, so it never changes
/// the answer: a row one has since excluded still reads as its branch's. Out of sight: a
/// ref written by hand, by a command-line refspec or under earlier settings, and fetch
/// settings this checkout's config listing does not show (another worktree's
/// `config.worktree`, a conditional include that holds elsewhere). Under the standard
/// entry, two server branches differing only in case share one row on a store whose names
/// alias, and the row still reads as its branch's; the leased tip guards that delete. No is
/// the answer toward inaction.
fn tracking_ref_only_from_branch(
    own: &str,
    others: &str,
    tracking_ref: &str,
    branch_ref: &str,
    refs_alias: bool,
) -> bool {
    let mut sourced = false;
    for entry in own.split('\n') {
        match fetch_entry_write(entry, tracking_ref, refs_alias) {
            FetchEntryWrite::Nothing => {}
            FetchEntryWrite::From(source) if source == branch_ref => sourced = true,
            FetchEntryWrite::From(_) | FetchEntryWrite::Rejected => return false,
        }
    }
    sourced
        && others.split('\n').all(|entry| {
            matches!(
                fetch_entry_write(entry, tracking_ref, refs_alias),
                FetchEntryWrite::Nothing
            )
        })
}

/// Whether this clone's fetch settings tie `refs/remotes/<remote>/<name>` to `name` on
/// `remote` ([`tracking_ref_only_from_branch`]), with refs compared ignoring case where the
/// store's names alias. While the common dir's legacy `remotes` folder holds any entry the
/// answer is no: git reads each file there as a remote's fetch settings, which the config
/// listing never shows. Every failed read is the `Err`.
async fn tracking_ref_is_branch_own(repo_path: &str, remote: &str, name: &str) -> AppResult<bool> {
    let config = crate::git::status::push_config_strict(repo_path).await?;
    let common = crate::git::worktree::git_common_dir(repo_path).await?;
    let common = std::path::Path::new(&common);
    let refs_alias = refs_can_alias_at(common)?;
    if legacy_remotes_listed(common)? {
        return Ok(false);
    }
    let branch_ref = branch_full_ref(name)?;
    Ok(tracking_ref_only_from_branch(
        &config.fetch_entries(remote),
        &config.other_fetch_entries(remote),
        &format!("refs/remotes/{remote}/{name}"),
        &branch_ref,
        refs_alias,
    ))
}

/// Whether `<common>/remotes` holds any entry. Only a folder that is not there reads as
/// none; any other failure to read it, or an entry of it, is the `Err`.
fn legacy_remotes_listed(common: &std::path::Path) -> std::io::Result<bool> {
    match std::fs::read_dir(common.join("remotes")) {
        Ok(mut entries) => Ok(entries.next().transpose()?.is_some()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Best-effort drop of the row `refs/remotes/<remote>/<name>` after its branch is already
/// gone on the server, only when [`tracking_ref_is_branch_own`] answers yes: a row the
/// settings tie elsewhere is another branch's, and a failed read touches no ref.
async fn drop_own_tracking_ref(repo_path: &str, remote: &str, name: &str) {
    if !matches!(
        tracking_ref_is_branch_own(repo_path, remote, name).await,
        Ok(true)
    ) {
        return;
    }
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
}

/// `warning` plus at most one sentence about `new`'s upstream, decided by
/// [`upstream_warning`] from `seen` and a single read of `new`'s config. Whether the
/// upstream is set is read from the config, never the atoms: under a fetch refspec that
/// does not cover `new` (a narrow wildcard, an entry with no destination, or a source git
/// resolves by name such as a short one, all of which the check lets through) they read
/// untracked while the config is right. The fetch-settings sentence also needs `seen` to
/// be `Unmapped`, and a `Tracked` read adds neither sentence.
async fn with_lost_upstream_warning(
    repo_path: &str,
    remote: &str,
    new: &str,
    seen: UpstreamSeen,
    warning: Option<String>,
) -> Option<String> {
    let names = upstream_config_names(repo_path, remote, new).await;
    upstream_warning(seen, names, remote, new, warning)
}

/// The sentence a successful push adds to `warning`, from the upstream read (`seen`) and
/// whether `new`'s config names `<remote>` and `refs/heads/<new>` (`names`). By pair:
/// `Tracked` adds nothing, whatever the config says; a config that does not name them
/// (`Some(false)`) gives the lost-upstream sentence for `Unmapped` and for `Unconfirmed`;
/// a right config (`Some(true)`) gives the fetch-settings sentence for `Unmapped` only and
/// adds nothing for `Unconfirmed`; a failed config read (`None`) adds nothing. The two
/// sentences need opposite config answers, so they never pair.
fn upstream_warning(
    seen: UpstreamSeen,
    names: Option<bool>,
    remote: &str,
    new: &str,
    warning: Option<String>,
) -> Option<String> {
    let sentence = match (seen, names) {
        (UpstreamSeen::Tracked, _) => return warning,
        (_, Some(false)) => format!("Couldn't set {new}'s upstream to {remote}/{new}."),
        (UpstreamSeen::Unmapped, Some(true)) => format!(
            "{new} shows no upstream here because this clone's fetch settings don't include it on {remote}."
        ),
        _ => return warning,
    };
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

/// What a leased remote delete did.
enum RemoteDeleteLeased {
    Deleted,
    AlreadyGone,
    /// The lease refused and a read after it still lists the branch.
    Moved,
    /// The lease refused and the read after it failed.
    Unread(AppError),
    /// A check, the symbolic tracking-ref drop, the credential read or the push failed; the
    /// error as returned.
    Failed(AppError),
}

/// Deletes `name` on `remote` only while it points at `expected_tip`, under the network
/// lock. A refused lease is told apart by a read after it: gone is already done (the row's
/// own tracking ref dropped, [`drop_own_tracking_ref`]), still listed is moved. No
/// `--porcelain`: with it git reports the rejection on stdout.
async fn delete_remote_branch_leased(
    state: &AppState,
    repo_path: &str,
    remote: &str,
    name: &str,
    expected_tip: &str,
) -> RemoteDeleteLeased {
    let failed = RemoteDeleteLeased::Failed;
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
                Ok(stdout) if listed_row(&stdout, &full_ref).is_some() => RemoteDeleteLeased::Moved,
                Ok(_) => {
                    drop_own_tracking_ref(repo_path, remote, name).await;
                    RemoteDeleteLeased::AlreadyGone
                }
                Err(error) => RemoteDeleteLeased::Unread(error),
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        branch_exists, full_ref_tip, git_ok, init_repo, move_dir, run, temp_base,
    };
    use crate::git::runner::TEST_GIT_HANG_GUARD;

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

    /// The remote rename: its check, its act, and the leased delete. Every remote is a
    /// local bare repository or an unroutable `.invalid` address.
    mod remote_rename {
        use super::super::{
            git_rename_branch_core, git_rename_branch_remote_core, is_case_only_rename,
            is_remote_rejection, live_pushed_tip, parse_remote_rename_read, pushed_branch_contains,
            remote_rejection_detail, remote_rename_check, remote_side_refusal,
            same_push_repository, set_branch_keep_local_core, unreachable_detail, OldKeptCause,
            PushedCopy, RemoteRenameCheck, RemoteRenameOutcome, RemoteRenamePhase,
            RemoteRenamePhaseHook, RemoteRenameRead, RemoteRenameRefusal, UpstreamSeen,
            REMOTE_RENAME_PHASE_HOOK,
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
                    to_value(RemoteRenameRefusal::NewNotFetched).unwrap(),
                    json!({"code": "newNotFetched"}),
                ),
                (
                    to_value(RemoteRenameRefusal::OldFetchedByName).unwrap(),
                    json!({"code": "oldFetchedByName"}),
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
            let old_fetched = to_value(RemoteRenameRefusal::OldFetchedByName).unwrap();
            let text = format!("{failed}{kept}{old_fetched}");
            for snake in [
                "old_tip",
                "push_failed",
                "old_kept",
                "not_in_push",
                "is_draft",
                "old_fetched_by_name",
            ] {
                assert!(!text.contains(snake), "{snake} in {text}");
            }
        }

        #[test]
        fn same_push_repository_compares_repository_identity() {
            let rows: [(&str, &[&str], bool); 29] = [
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
                // Edge whitespace passes only byte-equal, since the identity parse trims
                // it: the four false scp, https and ssh rows pin that arm, and the two
                // byte-equal true rows the pass ahead of it. The other `/srv` rows and the
                // two-address row are guards that pass with or without the arm.
                ("/srv/x.git", &["/srv/x.git "], false),
                ("/srv/x.git ", &["/srv/x.git"], false),
                ("git@h:o/r.git", &["git@h:o/r.git "], false),
                ("https://h/o/r.git", &[" https://h/o/r.git"], false),
                ("https://h/o/r.git", &["https://h/o/r.git\t"], false),
                ("ssh://git@h/o/r.git ", &["git@h:o/r.git"], false),
                ("https://h/o/r.git", &["https://h/o/r.git", ""], false),
                ("/srv/x.git ", &["/srv/x.git "], true),
                ("https://h/o/r.git ", &["https://h/o/r.git "], true),
            ];
            let wrong: Vec<_> = rows
                .iter()
                .filter(|(fetch, push, want)| same_push_repository(fetch, push) != *want)
                .map(|(fetch, push, _)| format!("{fetch:?} vs {push:?}"))
                .collect();
            assert!(wrong.is_empty(), "wrong answers: {wrong:?}");
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
            // An exact entry for `old` beside the wildcard: every refusal below runs under
            // fetch settings the old-name rule would refuse.
            run(
                repo,
                &[
                    "config",
                    "--add",
                    "remote.origin.fetch",
                    "+refs/heads/old:refs/remotes/origin/old",
                ],
            )
            .await;
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

            run(
                repo,
                &[
                    "config",
                    "--replace-all",
                    "remote.origin.fetch",
                    "+refs/heads/*:refs/remotes/origin/*",
                ],
            )
            .await;
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
            // A URL value keeps its scheme, host and path, never its userinfo.
            run(
                repo,
                &[
                    "config",
                    "remote.pushDefault",
                    "https://user:token@host/o/r",
                ],
            )
            .await;
            let url = RemoteRenameRefusal::PushesElsewhere {
                push_remote: "https://***@host/o/r".into(),
            };
            assert_eq!(local_refusal(&f, "new").await, url, "a URL");
            run(repo, &["config", "remote.pushDefault", "fork"]).await;

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
                RemoteDeleteLeased::Failed(AppError::InvalidArgument(m)) if m == REFUSAL
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

        async fn delete_at(f: &Fixture, tip: &str) -> crate::error::AppResult<()> {
            super::super::delete_remote_branch_at_tip(
                &AppState::default(),
                &f.repo,
                "origin",
                "old",
                Some(tip),
            )
            .await
        }

        /// The leased delete at the row's tip deletes; at a stale tip with the branch
        /// already gone it is done and drops the tracking ref.
        #[tokio::test]
        async fn a_leased_remote_delete_deletes_at_its_tip_and_settles_a_gone_branch() {
            let f = fixture("rr-lease-delete").await;
            let g = fixture_beside(&f, "rr-lease-gone").await;
            assert_ne!(f.main, f.old);
            delete_at(&f, &f.old).await.unwrap();
            assert_eq!(remote_tip(&f, "old").await, None);
            assert_eq!(full_ref_tip(&f.repo, "refs/remotes/origin/old").await, None);

            run(&g.bare, &["update-ref", "-d", "refs/heads/old"]).await;
            delete_at(&g, &g.main).await.unwrap();
            assert_eq!(full_ref_tip(&g.repo, "refs/remotes/origin/old").await, None);
        }

        /// A remote branch pushed to since the row's tip refuses the leased delete with S2:
        /// nothing deleted there, the tracking ref untouched here.
        #[tokio::test]
        async fn a_leased_remote_delete_keeps_a_moved_branch() {
            let f = fixture("rr-lease-moved").await;
            let c2 = second_clone(&f).await;
            run(&c2, &["commit", "-q", "--allow-empty", "-m", "moved"]).await;
            run(&c2, &["push", "-q", "origin", "old"]).await;
            let moved = full_ref_tip(&c2, "refs/heads/old").await;
            assert_ne!(moved, Some(f.old.clone()));

            let err = delete_at(&f, &f.old).await.unwrap_err();
            assert!(
                matches!(&err, AppError::Command(m) if m == "origin/old isn't at the commit this delete was confirmed for, so it wasn't deleted. Fetch, then check it before you delete it."),
                "{err:?}"
            );
            assert_eq!(remote_tip(&f, "old").await, moved);
            assert_eq!(
                full_ref_tip(&f.repo, "refs/remotes/origin/old").await,
                Some(f.old.clone())
            );
        }

        /// A remote that refuses the delete answers the leased delete with the plain
        /// delete's own error.
        #[tokio::test]
        async fn a_leased_remote_delete_keeps_the_plain_deletes_rejection() {
            let f = fixture("rr-lease-rejected").await;
            run(&f.bare, &["config", "receive.denyDeletes", "true"]).await;
            let plain = super::super::git_delete_remote_branch_core(
                &AppState::default(),
                f.repo.clone(),
                "origin".into(),
                "old".into(),
            )
            .await
            .unwrap_err();
            let leased = delete_at(&f, &f.old).await.unwrap_err();
            assert!(matches!(&plain, AppError::Git { .. }), "{plain:?}");
            assert_eq!(format!("{leased:?}"), format!("{plain:?}"));
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert!(matches!(
                delete_at(&f, "abc").await,
                Err(AppError::InvalidArgument(_))
            ));
        }

        /// Every argv `delete_at` spawns, with its result.
        async fn delete_at_logged(f: &Fixture) -> (crate::error::AppResult<()>, Vec<String>) {
            use crate::git::runner::GIT_SPAWN_LOG;
            let spawned = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let log = {
                let spawned = spawned.clone();
                Arc::new(move |args: &[&str]| spawned.lock().unwrap().push(args.join(" ")))
            };
            let result = GIT_SPAWN_LOG.scope(log, delete_at(f, &f.old)).await;
            let spawned = spawned.lock().unwrap().clone();
            (result, spawned)
        }

        /// A leased delete under split push URLs refuses with S3 and leaves the push
        /// repository, the fetch repository and the tracking ref as they were, with no
        /// push, network read or ref update run.
        async fn assert_split_push_refused(f: &Fixture, push: &str, row: &str) {
            const S3: &str = "origin pushes to a different address than it fetches from, so GitDesktop can't check old before deleting it. Nothing was deleted.";
            let fetched = remote_refs(f).await;
            let (result, spawned) = delete_at_logged(f).await;
            assert!(
                matches!(&result, Err(AppError::Command(m)) if m == S3),
                "{row}: {result:?}"
            );
            assert_eq!(
                full_ref_tip(push, "refs/heads/old").await,
                Some(f.old.clone()),
                "{row}"
            );
            assert_eq!(remote_refs(f).await, fetched, "{row}");
            assert_eq!(
                full_ref_tip(&f.repo, "refs/remotes/origin/old").await,
                Some(f.old.clone()),
                "{row}"
            );
            assert!(
                !spawned
                    .iter()
                    .any(|argv| ["push", "ls-remote", "update-ref"]
                        .iter()
                        .any(|verb| argv.split(' ').next() == Some(*verb))),
                "{row}: {spawned:?}"
            );
        }

        /// A fixture beside `push.git`, a bare clone of its remote that holds `old` at the
        /// leased tip, so a delete that went ahead under a split push URL would land there.
        async fn split_push_fixture(tag: &str) -> (Fixture, String) {
            let f = fixture(tag).await;
            let push = format!("{}/push.git", f.base);
            run(&f.base, &["clone", "-q", "--bare", &f.bare, &push]).await;
            assert_eq!(
                full_ref_tip(&push, "refs/heads/old").await,
                Some(f.old.clone())
            );
            (f, push)
        }

        /// One push URL naming another repository refuses the leased delete.
        #[tokio::test]
        async fn a_split_push_url_refuses_the_leased_remote_delete() {
            let (f, push) = split_push_fixture("rr-delete-split-push").await;
            run(&f.repo, &["config", "remote.origin.pushurl", &push]).await;
            assert_split_push_refused(&f, &push, "one push URL elsewhere").await;
        }

        /// The same-repository read compares the addresses git prints, edge whitespace and
        /// a newline or CR ending included, so no address folds onto the fetch URL.
        #[tokio::test]
        async fn the_same_repository_read_keeps_gits_bytes() {
            let f = fixture("rr-push-bytes").await;
            let bare = f.bare.as_str();
            let spaced = format!("{bare} ");
            let spaced = spaced.as_str();
            let ended = format!("{bare}\n");
            let ended = ended.as_str();
            let carriage = format!("{bare}\r");
            let carriage = carriage.as_str();
            let rows: [(&str, &str, &[&str], bool); 7] = [
                ("push URL ends in a space", bare, &[spaced], false),
                ("fetch URL ends in a space, no push URL", spaced, &[], true),
                (
                    "fetch URL ends in a space, a clean push URL",
                    spaced,
                    &[bare],
                    false,
                ),
                (
                    "a blank push URL beside the fetch URL",
                    bare,
                    &[" ", bare],
                    false,
                ),
                ("push URL ends in a newline", bare, &[ended], false),
                (
                    "fetch URL ends in a newline, no push URL",
                    ended,
                    &[],
                    false,
                ),
                ("push URL ends in a CR", bare, &[carriage], false),
            ];
            let mut wrong = Vec::new();
            for (row, url, push_urls, want) in rows {
                run(&f.repo, &["config", "remote.origin.url", url]).await;
                git_ok(&f.repo, &["config", "--unset-all", "remote.origin.pushurl"]).await;
                for &push_url in push_urls {
                    let args = ["config", "--add", "remote.origin.pushurl", push_url];
                    run(&f.repo, &args).await;
                }
                let reached = super::super::push_reaches_fetch_repository(&f.repo, "origin")
                    .await
                    .unwrap();
                if reached != want {
                    wrong.push(row);
                }
            }
            assert!(wrong.is_empty(), "wrong answers: {wrong:?}");
        }

        /// A push URL that differs from the fetch URL only by a trailing space refuses the
        /// leased delete and the rename check alike.
        #[tokio::test]
        async fn a_whitespace_edged_push_url_refuses_the_delete_and_the_rename() {
            let f = fixture("rr-push-space").await;
            let spaced = format!("{} ", f.bare);
            run(&f.repo, &["config", "remote.origin.pushurl", &spaced]).await;
            assert_split_push_refused(&f, &f.bare, "push URL with a trailing space").await;
            assert_eq!(
                local_refusal(&f, "new").await,
                RemoteRenameRefusal::PushUrlDiffers
            );
        }

        /// Two push URLs refuse the leased delete, even with the branch at the leased tip
        /// in both.
        #[tokio::test]
        async fn two_push_urls_refuse_the_leased_remote_delete() {
            let (f, push) = split_push_fixture("rr-delete-two-push").await;
            run(
                &f.repo,
                &["config", "--add", "remote.origin.pushurl", &f.bare],
            )
            .await;
            run(
                &f.repo,
                &["config", "--add", "remote.origin.pushurl", &push],
            )
            .await;
            assert_split_push_refused(&f, &push, "two push URLs").await;
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
        }

        /// With no push URL, git pushes to every `url` entry and fetches from the first, so
        /// two of them refuse the leased delete.
        #[tokio::test]
        async fn two_remote_urls_refuse_the_leased_remote_delete() {
            let (f, push) = split_push_fixture("rr-delete-two-urls").await;
            run(&f.repo, &["config", "--add", "remote.origin.url", &push]).await;
            let listed = run(&f.repo, &["remote", "get-url", "--push", "--all", "origin"]).await;
            assert_eq!(listed.lines().count(), 2, "fixture: {listed}");
            assert_split_push_refused(&f, &push, "two urls").await;
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
        }

        /// One push URL equal to the fetch URL keeps the leased delete.
        #[tokio::test]
        async fn a_push_url_at_the_fetch_url_keeps_the_leased_remote_delete() {
            let (f, _push) = split_push_fixture("rr-delete-same-push").await;
            run(&f.repo, &["config", "remote.origin.pushurl", &f.bare]).await;
            delete_at(&f, &f.old).await.unwrap();
            assert_eq!(remote_tip(&f, "old").await, None);
        }

        /// The fetch-settings refusal for `name` on `origin`.
        fn unconfirmed(name: &str) -> String {
            format!(
                "GitDesktop can't confirm from this clone's fetch settings that origin/{name} came from {name} on origin, so it can't check {name} before deleting it. Nothing was deleted."
            )
        }

        /// Replaces `remote.<remote>.fetch` with `entries`, in order.
        async fn set_fetch(repo: &str, remote: &str, entries: &[&str]) {
            let key = format!("remote.{remote}.fetch");
            git_ok(repo, &["config", "--unset-all", &key]).await;
            for entry in entries {
                run(repo, &["config", "--add", &key, entry]).await;
            }
        }

        /// A leased delete of `old` that the fetch settings refuse: the sentence, the
        /// server and the tracking ref as they were, and no push, network read or ref
        /// update run.
        async fn assert_fetch_settings_refused(f: &Fixture, row: &str) {
            let before = remote_refs(f).await;
            let tracking = full_ref_tip(&f.repo, "refs/remotes/origin/old").await;
            let (result, spawned) = delete_at_logged(f).await;
            assert!(
                matches!(&result, Err(AppError::Command(m)) if *m == unconfirmed("old")),
                "{row}: {result:?}"
            );
            assert_eq!(remote_refs(f).await, before, "{row}");
            assert_eq!(
                full_ref_tip(&f.repo, "refs/remotes/origin/old").await,
                tracking,
                "{row}"
            );
            assert!(
                !spawned
                    .iter()
                    .any(|argv| ["push", "ls-remote", "update-ref"]
                        .iter()
                        .any(|verb| argv.split(' ').next() == Some(*verb))),
                "{row}: {spawned:?}"
            );
        }

        /// Each fetch-entry shape, listing and alias answer against the row
        /// `origin/topic` (or the row a case names): `want` is the verdict with names
        /// compared by bytes, then ignoring case.
        #[test]
        fn the_tracking_ref_rule_reads_each_entry_shape() {
            const STD: &str = "+refs/heads/*:refs/remotes/origin/*";
            const T: &str = "refs/remotes/origin/topic";
            const BR: &str = "refs/heads/topic";
            const PULL: &str = "+refs/pull/*/head:refs/remotes/origin/pr/*";
            const RELEASE: &str = "+refs/heads/release/*:refs/remotes/origin/*";
            const PR1: (&str, &str) = ("refs/remotes/origin/pr/1", "refs/heads/pr/1");
            // A row's label, entries, (`tracking_ref`, `branch_ref`) and verdicts.
            type At = (&'static str, &'static str);
            type OwnRow = (&'static str, String, At, [bool; 2]);
            type OtherRow = (&'static str, &'static str, &'static str, At, [bool; 2]);
            let std_plus = |entry: &str| format!("{STD}\n{entry}");
            let own_rows: Vec<OwnRow> = vec![
                ("1", STD.into(), (T, BR), [true, true]),
                (
                    "2",
                    "refs/heads/*:refs/remotes/origin/*".into(),
                    (T, BR),
                    [true, true],
                ),
                (
                    "3 +",
                    "+refs/heads/topic:refs/remotes/origin/topic".into(),
                    (T, BR),
                    [true, true],
                ),
                (
                    "3",
                    "refs/heads/topic:refs/remotes/origin/topic".into(),
                    (T, BR),
                    [true, true],
                ),
                (
                    "4",
                    "+refs/heads/topic:remotes/origin/topic".into(),
                    (T, BR),
                    [true, true],
                ),
                (
                    "5",
                    std_plus("+refs/heads/topic:refs/remotes/origin/topic"),
                    (T, BR),
                    [true, true],
                ),
                ("6 ^", std_plus("^refs/heads/topic"), (T, BR), [true, true]),
                (
                    "6 ^+",
                    std_plus("^+refs/heads/topic"),
                    (T, BR),
                    [true, true],
                ),
                (
                    "6 single",
                    "+refs/heads/topic:refs/remotes/origin/topic\n^refs/heads/main".into(),
                    (T, BR),
                    [true, true],
                ),
                ("7 topic", std_plus(PULL), (T, BR), [true, true]),
                ("7 pr/1", std_plus(PULL), PR1, [false, false]),
                ("8", PULL.into(), PR1, [false, false]),
                ("9", RELEASE.into(), (T, BR), [false, false]),
                (
                    "10",
                    ["+refs/heads/main:refs/remotes/origin/main", RELEASE].join("\n"),
                    (T, BR),
                    [false, false],
                ),
                (
                    "11",
                    "+refs/heads/main:refs/remotes/origin/topic".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "12",
                    ":refs/remotes/origin/topic".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "13 heads/",
                    "heads/topic:refs/remotes/origin/topic".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "13 bare",
                    "topic:refs/remotes/origin/topic".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "14",
                    "++refs/heads/topic:refs/remotes/origin/topic".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "15 topic",
                    "+refs/heads/t*c:refs/remotes/origin/*".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "15 opi",
                    "+refs/heads/t*c:refs/remotes/origin/*".into(),
                    ("refs/remotes/origin/opi", "refs/heads/opi"),
                    [false, false],
                ),
                (
                    "16 pre-topic-suf",
                    "+refs/heads/*:refs/remotes/origin/pre-*-suf".into(),
                    (
                        "refs/remotes/origin/pre-topic-suf",
                        "refs/heads/pre-topic-suf",
                    ),
                    [false, false],
                ),
                (
                    "16 topic",
                    "+refs/heads/*:refs/remotes/origin/pre-*-suf".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "17",
                    "+refs/heads/top*ic:refs/remotes/origin/top*ic".into(),
                    (T, BR),
                    [true, true],
                ),
                (
                    "18",
                    "+refs/heads/*:refs/remotes/origin/mapped/*".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "19",
                    "+refs/heads/*:remotes/origin/*".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "20",
                    "+refs/heads/topic:origin/topic".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "21 no colon",
                    "+refs/heads/topic".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "21 empty destination",
                    "+refs/heads/topic:".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "22 no colon",
                    std_plus("+refs/heads/topic"),
                    (T, BR),
                    [true, true],
                ),
                (
                    "22 empty destination",
                    std_plus("refs/heads/other:"),
                    (T, BR),
                    [true, true],
                ),
                ("23 unset", String::new(), (T, BR), [false, false]),
                ("23 empty value", "\n".into(), (T, BR), [false, false]),
                (
                    "23 negative only",
                    "^refs/heads/topic".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "24",
                    std_plus("+refs/heads/release/topic:refs/remotes/origin/topic"),
                    (T, BR),
                    [false, false],
                ),
                (
                    "25 star source only",
                    std_plus("+refs/heads/*:refs/remotes/origin/x"),
                    (T, BR),
                    [false, false],
                ),
                (
                    "25 star destination only",
                    std_plus("+refs/heads/topic:refs/remotes/origin/*"),
                    (T, BR),
                    [false, false],
                ),
                (
                    "25 two stars",
                    std_plus("+refs/heads/*/*:refs/remotes/origin/*/*"),
                    (T, BR),
                    [false, false],
                ),
                (
                    "26 source case",
                    "+refs/heads/Topic:refs/remotes/origin/topic".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "26 fork layout",
                    "+refs/heads/*:refs/remotes/fork/*".into(),
                    (T, BR),
                    [false, false],
                ),
                (
                    "27 standard",
                    STD.into(),
                    ("refs/remotes/origin/feat/x", "refs/heads/feat/x"),
                    [true, true],
                ),
                (
                    "27 feat/*",
                    "+refs/heads/feat/*:refs/remotes/origin/feat/*".into(),
                    ("refs/remotes/origin/feat/x", "refs/heads/feat/x"),
                    [true, true],
                ),
                (
                    "27 into feat/",
                    "+refs/heads/*:refs/remotes/origin/feat/*".into(),
                    ("refs/remotes/origin/feat/x", "refs/heads/feat/x"),
                    [false, false],
                ),
                (
                    "28a",
                    "+refs/heads/*:refs/remotes/Origin/*".into(),
                    (T, BR),
                    [false, true],
                ),
                (
                    "28b",
                    std_plus("+refs/heads/other:refs/remotes/Origin/topic"),
                    (T, BR),
                    [true, false],
                ),
                (
                    "28c",
                    std_plus("+refs/heads/other:remotes/Origin/topic"),
                    (T, BR),
                    [true, false],
                ),
                (
                    "28d",
                    std_plus("+refs/heads/other:refs/remotes/origin/É/z"),
                    ("refs/remotes/origin/é/z", "refs/heads/é/z"),
                    [true, false],
                ),
                ("36", std_plus("+*:*"), (T, BR), [false, false]),
                ("37", "+refs/*:refs/*".into(), (T, BR), [false, false]),
                (
                    "39a",
                    "+refs/heads/*:Refs/remotes/origin/*".into(),
                    (T, BR),
                    [false, false],
                ),
            ];
            let other_rows: Vec<OtherRow> = vec![
                (
                    "29",
                    STD,
                    "+refs/heads/*:refs/remotes/second/*",
                    (T, BR),
                    [true, true],
                ),
                ("30", STD, STD, (T, BR), [false, false]),
                (
                    "31 x",
                    STD,
                    "+refs/heads/x:refs/remotes/origin/topic",
                    (T, BR),
                    [false, false],
                ),
                (
                    "31 topic",
                    STD,
                    "+refs/heads/topic:refs/remotes/origin/topic",
                    (T, BR),
                    [false, false],
                ),
                (
                    "31 remotes/",
                    STD,
                    "+refs/heads/x:remotes/origin/topic",
                    (T, BR),
                    [false, false],
                ),
                (
                    "32 negative",
                    STD,
                    "^refs/heads/topic",
                    (T, BR),
                    [true, true],
                ),
                (
                    "32 no colon",
                    STD,
                    "+refs/heads/topic",
                    (T, BR),
                    [true, true],
                ),
                ("32 empty", STD, "", (T, BR), [true, true]),
                (
                    "33",
                    STD,
                    "+refs/heads/*:refs/remotes/second/x",
                    (T, BR),
                    [false, false],
                ),
                ("34 none own", "", STD, (T, BR), [false, false]),
                (
                    "34 origin/x",
                    STD,
                    "+refs/heads/*:refs/remotes/origin/x/*",
                    ("refs/remotes/origin/x/topic", "refs/heads/x/topic"),
                    [false, false],
                ),
                (
                    "35",
                    STD,
                    "+refs/heads/*:refs/remotes/Origin/*",
                    (T, BR),
                    [true, false],
                ),
                ("38", STD, "+r*:r*", (T, BR), [false, false]),
                (
                    "39b",
                    STD,
                    "+refs/heads/*:Refs/remotes/origin/*",
                    (T, BR),
                    [true, true],
                ),
            ];
            let rows = own_rows
                .iter()
                .map(|(row, own, at, want)| (*row, own.as_str(), "", *at, *want))
                .chain(other_rows.iter().copied());
            let mut wrong = Vec::new();
            for (row, own, others, (tracking_ref, branch_ref), want) in rows {
                for (alias, want) in [false, true].into_iter().zip(want) {
                    let got = super::super::tracking_ref_only_from_branch(
                        own,
                        others,
                        tracking_ref,
                        branch_ref,
                        alias,
                    );
                    if got != want {
                        wrong.push(format!("{row} (alias {alias})"));
                    }
                }
            }
            assert!(wrong.is_empty(), "wrong answers: {wrong:?}");
        }

        /// A row a prefix-stripping remap writes refuses the leased delete before anything
        /// is pushed, though the remote holds a same-named `old` at the same commit.
        #[tokio::test]
        async fn a_remapped_row_refuses_the_leased_remote_delete() {
            let f = fixture("rr-delete-remapped").await;
            run(&f.bare, &["update-ref", "refs/heads/release/old", &f.old]).await;
            let entries = [
                "+refs/heads/main:refs/remotes/origin/main",
                "+refs/heads/release/*:refs/remotes/origin/*",
            ];
            set_fetch(&f.repo, "origin", &entries).await;
            assert_fetch_settings_refused(&f, "release/* remap").await;
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert_eq!(remote_tip(&f, "release/old").await, Some(f.old.clone()));
        }

        /// A plain single-branch entry keeps the delete; beside the standard entry, a
        /// pull-request mapping refuses its own rows only.
        #[tokio::test]
        async fn single_branch_and_standard_rows_keep_the_leased_remote_delete() {
            let f = fixture("rr-delete-single").await;
            set_fetch(
                &f.repo,
                "origin",
                &["+refs/heads/old:refs/remotes/origin/old"],
            )
            .await;
            delete_at(&f, &f.old).await.unwrap();
            assert_eq!(remote_tip(&f, "old").await, None);

            let g = fixture_beside(&f, "rr-delete-pull").await;
            let entries = [
                "+refs/heads/*:refs/remotes/origin/*",
                "+refs/pull/*/head:refs/remotes/origin/pr/*",
            ];
            set_fetch(&g.repo, "origin", &entries).await;
            run(&g.bare, &["update-ref", "refs/pull/1/head", &g.main]).await;
            run(
                &g.repo,
                &["update-ref", "refs/remotes/origin/pr/1", &g.main],
            )
            .await;
            let before = remote_refs(&g).await;
            let err = super::super::delete_remote_branch_at_tip(
                &AppState::default(),
                &g.repo,
                "origin",
                "pr/1",
                Some(&g.main),
            )
            .await
            .unwrap_err();
            assert!(
                matches!(&err, AppError::Command(m) if *m == unconfirmed("pr/1")),
                "{err:?}"
            );
            assert_eq!(remote_refs(&g).await, before);
            assert_eq!(
                full_ref_tip(&g.repo, "refs/remotes/origin/pr/1").await,
                Some(g.main.clone())
            );
            delete_at(&g, &g.old).await.unwrap();
            assert_eq!(remote_tip(&g, "old").await, None);
        }

        /// The delete's own settings read failing stops it with that read's error, after
        /// both URL reads and with nothing spawned, dropped or pushed after it.
        #[tokio::test]
        async fn a_failed_fetch_settings_read_stops_the_leased_remote_delete() {
            use crate::git::runner::GIT_SPAWN_LOG;
            let f = fixture("rr-delete-unread-fetch").await;
            let away = format!("{}-away", f.repo);
            let spawned = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let listings = Arc::new(AtomicUsize::new(0));
            let log = {
                let (repo, away) = (f.repo.clone(), away.clone());
                let (spawned, listings) = (spawned.clone(), listings.clone());
                Arc::new(move |args: &[&str]| {
                    spawned.lock().unwrap().push(args.join(" "));
                    if args == ["config", "-z", "--list"]
                        && listings.fetch_add(1, Ordering::SeqCst) == 1
                    {
                        super::move_dir(&repo, &away);
                    }
                })
            };
            let deleted = GIT_SPAWN_LOG.scope(log, delete_at(&f, &f.old)).await;
            let moved = listings.load(Ordering::SeqCst) >= 2;
            if moved {
                super::move_dir(&away, &f.repo);
            }
            let spawned = spawned.lock().unwrap().clone();
            assert!(moved, "fixture: {deleted:?} {spawned:?}");
            assert!(
                matches!(&deleted, Err(e) if !matches!(e, AppError::Command(_))),
                "{deleted:?}"
            );
            let url_reads = spawned
                .iter()
                .filter(|argv| argv.starts_with("remote get-url"))
                .count();
            assert_eq!(url_reads, 2, "{spawned:?}");
            let second_listing = spawned
                .iter()
                .enumerate()
                .filter(|(_, argv)| *argv == "config -z --list")
                .nth(1)
                .map(|(at, _)| at);
            assert_eq!(second_listing, Some(spawned.len() - 1), "{spawned:?}");
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert_eq!(
                full_ref_tip(&f.repo, "refs/remotes/origin/old").await,
                Some(f.old.clone())
            );
        }

        /// The fetch entries of T4.5 and T4.7: no entry ties `origin/old` to `old`, and
        /// `other` writes it.
        async fn remap_old_row_to_other(f: &Fixture) {
            let entries = [
                "+refs/heads/*:refs/remotes/origin/mapped/*",
                "+refs/heads/other:refs/remotes/origin/old",
            ];
            set_fetch(&f.repo, "origin", &entries).await;
            run(&f.bare, &["update-ref", "refs/heads/other", &f.main]).await;
            run(
                &f.repo,
                &["update-ref", "refs/remotes/origin/mapped/old", &f.old],
            )
            .await;
            run(&f.repo, &["update-ref", "refs/remotes/origin/old", &f.main]).await;
        }

        /// A rename whose old branch is already gone on the remote is done, and leaves the
        /// row the fetch settings tie to another branch as it was.
        #[tokio::test]
        async fn an_already_gone_old_branch_leaves_another_branchs_tracking_ref() {
            let f = fixture("rr-gone-other-row").await;
            remap_old_row_to_other(&f).await;
            let bare = f.bare.clone();
            let hook = hook_at(RemoteRenamePhase::BeforeDelete, move || {
                let bare = bare.clone();
                async move {
                    run(&bare, &["update-ref", "-d", "refs/heads/old"]).await;
                }
            });
            let outcome = act_hooked(&f, hook).await;
            assert!(
                matches!(outcome, RemoteRenameOutcome::Renamed { .. }),
                "{outcome:?}"
            );
            assert_eq!(remote_tip(&f, "old").await, None);
            assert_eq!(
                full_ref_tip(&f.repo, "refs/remotes/origin/old").await,
                Some(f.main.clone())
            );
        }

        /// An already-gone branch whose fetch settings can't be read is done and keeps its
        /// tracking ref: the repository is away for the listing after the network read,
        /// back for any spawn after it.
        #[tokio::test]
        async fn an_already_gone_branch_with_unread_fetch_settings_keeps_its_tracking_ref() {
            use crate::git::runner::GIT_SPAWN_LOG;
            let g = fixture("rr-gone-unread").await;
            run(&g.bare, &["update-ref", "-d", "refs/heads/old"]).await;
            let away = format!("{}-away", g.repo);
            let spawned = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            // 0: before the network read, 1: after it, 2: moved away, 3: moved back.
            let step = Arc::new(AtomicUsize::new(0));
            let log = {
                let (repo, away) = (g.repo.clone(), away.clone());
                let (spawned, step) = (spawned.clone(), step.clone());
                Arc::new(move |args: &[&str]| {
                    spawned.lock().unwrap().push(args.join(" "));
                    match step.load(Ordering::SeqCst) {
                        0 if args.contains(&"ls-remote") => step.store(1, Ordering::SeqCst),
                        1 if args == ["config", "-z", "--list"] => {
                            super::move_dir(&repo, &away);
                            step.store(2, Ordering::SeqCst);
                        }
                        2 => {
                            super::move_dir(&away, &repo);
                            step.store(3, Ordering::SeqCst);
                        }
                        _ => {}
                    }
                })
            };
            let answer = GIT_SPAWN_LOG
                .scope(
                    log,
                    super::super::delete_remote_branch_leased(
                        &AppState::default(),
                        &g.repo,
                        "origin",
                        "old",
                        &g.main,
                    ),
                )
                .await;
            let step = step.load(Ordering::SeqCst);
            if step == 2 {
                super::move_dir(&away, &g.repo);
            }
            let spawned = spawned.lock().unwrap().clone();
            assert!(step >= 2, "fixture: {spawned:?}");
            assert!(
                matches!(answer, super::super::RemoteDeleteLeased::AlreadyGone),
                "{spawned:?}"
            );
            assert_eq!(
                full_ref_tip(&g.repo, "refs/remotes/origin/old").await,
                Some(g.old.clone())
            );
            assert!(
                !spawned.iter().any(|argv| argv.starts_with("update-ref")),
                "{spawned:?}"
            );
        }

        /// The plain delete's "remote ref does not exist" answer is done and drops only a
        /// row the fetch settings tie to the branch; any other error comes back as it was.
        #[tokio::test]
        async fn a_plain_delete_of_a_gone_branch_drops_only_its_own_tracking_ref() {
            let gone = || {
                Err(AppError::Git {
                    code: 1,
                    stderr: "error: unable to delete 'old': remote ref does not exist".into(),
                })
            };
            async fn answer(
                f: &Fixture,
                out: crate::error::AppResult<()>,
            ) -> crate::error::AppResult<()> {
                super::super::remote_delete_answer(&f.repo, "origin", "old", out).await
            }
            let f = fixture("rr-plain-gone").await;
            answer(&f, gone()).await.unwrap();
            assert_eq!(full_ref_tip(&f.repo, "refs/remotes/origin/old").await, None);

            let g = fixture_beside(&f, "rr-plain-gone-other").await;
            remap_old_row_to_other(&g).await;
            answer(&g, gone()).await.unwrap();
            assert_eq!(
                full_ref_tip(&g.repo, "refs/remotes/origin/old").await,
                Some(g.main.clone())
            );

            let h = fixture_beside(&f, "rr-plain-other-error").await;
            let other = AppError::Git {
                code: 1,
                stderr: "fatal: unable to access the remote".into(),
            };
            let shown = format!("{other:?}");
            let err = answer(&h, Err(other)).await.unwrap_err();
            assert_eq!(format!("{err:?}"), shown);
            assert_eq!(
                full_ref_tip(&h.repo, "refs/remotes/origin/old").await,
                Some(h.old.clone())
            );
        }

        /// Another remote's entries are judged: in its own namespace the delete goes ahead,
        /// writing this remote's rows it refuses.
        #[tokio::test]
        async fn another_remotes_entry_into_this_namespace_refuses_the_leased_remote_delete() {
            let f = fixture("rr-delete-second-own").await;
            run(&f.repo, &["remote", "add", "second", &f.bare]).await;
            delete_at(&f, &f.old).await.unwrap();
            assert_eq!(remote_tip(&f, "old").await, None);

            let g = fixture_beside(&f, "rr-delete-second-into").await;
            run(&g.repo, &["remote", "add", "second", &g.bare]).await;
            set_fetch(&g.repo, "second", &["+refs/heads/*:refs/remotes/origin/*"]).await;
            assert_fetch_settings_refused(&g, "second into origin/*").await;
            assert_eq!(remote_tip(&g, "old").await, Some(g.old.clone()));
        }

        /// Another remote's case-variant namespace refuses the delete exactly where the
        /// store's names alias.
        #[tokio::test]
        async fn a_case_variant_namespace_refuses_only_where_refs_alias() {
            let f = fixture("rr-delete-case-namespace").await;
            run(&f.repo, &["remote", "add", "second", &f.bare]).await;
            set_fetch(&f.repo, "second", &["+refs/heads/*:refs/remotes/Origin/*"]).await;
            if super::super::refs_can_alias_strict(&f.repo).await.unwrap() {
                assert_fetch_settings_refused(&f, "second into Origin/*").await;
                assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            } else {
                delete_at(&f, &f.old).await.unwrap();
                assert_eq!(remote_tip(&f, "old").await, None);
            }
        }

        /// A legacy `remotes` file refuses the delete; that path as a file is a read
        /// error; an empty folder changes nothing.
        #[tokio::test]
        async fn a_legacy_remotes_file_refuses_the_leased_remote_delete() {
            let f = fixture("rr-delete-legacy").await;
            let remotes = std::path::Path::new(&f.repo).join(".git").join("remotes");
            std::fs::create_dir(&remotes).unwrap();
            std::fs::write(
                remotes.join("second"),
                [
                    "URL: ",
                    &f.bare,
                    "\nPull: +refs/heads/release/*:refs/remotes/origin/*\n",
                ]
                .concat(),
            )
            .unwrap();
            assert_fetch_settings_refused(&f, "legacy remotes file").await;
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));

            let g = fixture_beside(&f, "rr-delete-legacy-file").await;
            let path = std::path::Path::new(&g.repo).join(".git").join("remotes");
            std::fs::write(&path, "not a folder\n").unwrap();
            assert!(std::fs::read_dir(&path).is_err(), "fixture: a read error");
            let before = remote_refs(&g).await;
            let err = delete_at(&g, &g.old).await.unwrap_err();
            assert!(!matches!(err, AppError::Command(_)), "{err:?}");
            assert_eq!(remote_refs(&g).await, before);
            assert_eq!(
                full_ref_tip(&g.repo, "refs/remotes/origin/old").await,
                Some(g.old.clone())
            );

            let h = fixture_beside(&f, "rr-delete-legacy-empty").await;
            std::fs::create_dir(std::path::Path::new(&h.repo).join(".git").join("remotes"))
                .unwrap();
            delete_at(&h, &h.old).await.unwrap();
            assert_eq!(remote_tip(&h, "old").await, None);
        }

        /// Runs the leased delete with the repository moved away at the spawn whose argv is
        /// exactly `target`, one of the push-URL helper's two reads, and checks that the
        /// read's own error stops it: an `Err` that is no refusal sentence, `reads` the only
        /// URL reads run, the failed one the last spawn, and nothing deleted. Returns every
        /// argv spawned.
        async fn assert_failed_url_read_stops_the_delete(
            tag: &str,
            target: &'static [&'static str],
            reads: &[&str],
        ) -> Vec<String> {
            use crate::git::runner::GIT_SPAWN_LOG;
            let f = fixture(tag).await;
            let away = format!("{}-away", f.repo);
            let spawned = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let moves = Arc::new(AtomicUsize::new(0));
            let log = {
                let (repo, away) = (f.repo.clone(), away.clone());
                let (spawned, moves) = (spawned.clone(), moves.clone());
                Arc::new(move |args: &[&str]| {
                    spawned.lock().unwrap().push(args.join(" "));
                    if args == target && moves.load(Ordering::SeqCst) == 0 {
                        super::move_dir(&repo, &away);
                        moves.store(1, Ordering::SeqCst);
                    }
                })
            };
            let deleted = GIT_SPAWN_LOG.scope(log, delete_at(&f, &f.old)).await;
            let moved = moves.load(Ordering::SeqCst);
            if moved == 1 {
                super::move_dir(&away, &f.repo);
            }
            let spawned = spawned.lock().unwrap().clone();
            assert_eq!(moved, 1, "fixture: {deleted:?} {spawned:?}");
            assert!(
                matches!(&deleted, Err(e) if !matches!(e, AppError::Command(_))),
                "{deleted:?}"
            );
            let url_reads: Vec<&str> = spawned
                .iter()
                .map(String::as_str)
                .filter(|argv| argv.starts_with("remote get-url"))
                .collect();
            assert_eq!(url_reads, reads, "{spawned:?}");
            assert_eq!(
                spawned.last().map(String::as_str),
                reads.last().copied(),
                "nothing after the failed read: {spawned:?}"
            );
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert_eq!(
                full_ref_tip(&f.repo, "refs/remotes/origin/old").await,
                Some(f.old.clone())
            );
            spawned
        }

        /// The push-URL helper's first read, of the fetch URL, failing stops the leased
        /// delete with that read's own error, with nothing read, dropped or pushed after it.
        #[tokio::test]
        async fn a_failed_fetch_url_read_stops_the_leased_remote_delete() {
            let spawned = assert_failed_url_read_stops_the_delete(
                "rr-delete-unread-fetch-url",
                &["remote", "get-url", "origin"],
                &["remote get-url origin"],
            )
            .await;
            assert_eq!(
                spawned.iter().rev().nth(1).map(String::as_str),
                Some("symbolic-ref refs/remotes/origin/HEAD"),
                "the guard's read, not the credential read: {spawned:?}"
            );
        }

        /// The push-URL helper's second read, of the push URLs, failing stops the leased
        /// delete with that read's own error, with nothing read, dropped or pushed after it.
        #[tokio::test]
        async fn a_failed_push_url_read_stops_the_leased_remote_delete() {
            assert_failed_url_read_stops_the_delete(
                "rr-delete-unread-push-url",
                &["remote", "get-url", "--push", "--all", "origin"],
                &[
                    "remote get-url origin",
                    "remote get-url --push --all origin",
                ],
            )
            .await;
        }

        /// A leased delete with no tip, or an empty one, refuses with S4 before any git
        /// runs; the remote `.` passes the plain delete's refusals and is refused before the
        /// push URL read.
        #[tokio::test]
        async fn a_remote_delete_without_a_tip_refuses_before_any_git() {
            use crate::git::runner::GIT_SPAWN_LOG;
            const S4: &str = "Couldn't read which commit origin/old is at, so it wasn't deleted. Fetch, then try again.";
            let f = fixture("rr-delete-no-tip").await;
            let state = AppState::default();
            let spawned = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let log = {
                let spawned = spawned.clone();
                Arc::new(move |args: &[&str]| spawned.lock().unwrap().push(args.join(" ")))
            };
            for tip in [None, Some("")] {
                let refused = GIT_SPAWN_LOG
                    .scope(
                        log.clone(),
                        super::super::delete_remote_branch_at_tip(
                            &state, &f.repo, "origin", "old", tip,
                        ),
                    )
                    .await;
                assert!(
                    matches!(&refused, Err(AppError::Command(m)) if m == S4),
                    "{tip:?}: {refused:?}"
                );
                let ran = spawned.lock().unwrap().clone();
                assert!(ran.is_empty(), "{tip:?}: {ran:?}");
                assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
                assert_eq!(
                    full_ref_tip(&f.repo, "refs/remotes/origin/old").await,
                    Some(f.old.clone())
                );
            }

            let dot = GIT_SPAWN_LOG
                .scope(
                    log,
                    super::super::delete_remote_branch_at_tip(
                        &state,
                        &f.repo,
                        ".",
                        "old",
                        Some(f.old.as_str()),
                    ),
                )
                .await;
            assert!(
                matches!(&dot, Err(AppError::InvalidArgument(m)) if m == "invalid remote: ."),
                "{dot:?}"
            );
            let ran = spawned.lock().unwrap().clone();
            assert_eq!(
                ran.last().map(String::as_str),
                Some("symbolic-ref refs/remotes/./HEAD"),
                "{ran:?}"
            );
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
        }

        /// A rev-expression name the plain delete's refusals let through is refused with
        /// the leased delete's own error before the push-URL read, so a split push URL
        /// doesn't turn it into the different-address refusal.
        #[tokio::test]
        async fn a_rev_expression_name_refuses_before_the_push_url_read() {
            use crate::git::runner::GIT_SPAWN_LOG;
            let (f, push) = split_push_fixture("rr-delete-rev-name").await;
            run(&f.repo, &["config", "remote.origin.pushurl", &push]).await;
            let pushes_to = run(&f.repo, &["remote", "get-url", "--push", "origin"]).await;
            assert_eq!(pushes_to.trim(), push, "fixture");
            let state = AppState::default();
            let spawned = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let log = {
                let spawned = spawned.clone();
                Arc::new(move |args: &[&str]| spawned.lock().unwrap().push(args.join(" ")))
            };
            let refused = GIT_SPAWN_LOG
                .scope(
                    log,
                    super::super::delete_remote_branch_at_tip(
                        &state,
                        &f.repo,
                        "origin",
                        "old~1",
                        Some(f.old.as_str()),
                    ),
                )
                .await;
            assert!(
                matches!(&refused, Err(AppError::InvalidArgument(m)) if m == "invalid branch name: old~1"),
                "{refused:?}"
            );
            let ran = spawned.lock().unwrap().clone();
            assert!(
                !ran.iter().any(|argv| argv.starts_with("remote get-url")),
                "{ran:?}"
            );
            assert_eq!(
                full_ref_tip(&push, "refs/heads/old").await,
                Some(f.old.clone())
            );
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert_eq!(
                full_ref_tip(&f.repo, "refs/remotes/origin/old").await,
                Some(f.old.clone())
            );
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

        /// Under a wildcard that covers `old` and not `new`, a push missing the old tip
        /// keeps the old branch and carries the fetch-settings sentence.
        #[tokio::test]
        async fn a_kept_old_branch_carries_the_fetch_settings_sentence() {
            let f = fixture("rr-narrow-notinpush").await;
            let fetch = "+refs/heads/ol*:refs/remotes/origin/ol*";
            run(
                &f.repo,
                &["config", "--replace-all", "remote.origin.fetch", fetch],
            )
            .await;
            let (repo, main) = (f.repo.clone(), f.main.clone());
            let hook = hook_at(RemoteRenamePhase::BeforePush, move || {
                let (repo, main) = (repo.clone(), main.clone());
                async move {
                    run(&repo, &["update-ref", "refs/heads/new", &main]).await;
                }
            });
            let outcome = act_hooked(&f, hook).await;
            let RemoteRenameOutcome::OldKept {
                warning: Some(warning),
                cause: OldKeptCause::NotInPush,
            } = &outcome
            else {
                panic!("{outcome:?}");
            };
            assert_eq!(
                warning,
                "new shows no upstream here because this clone's fetch settings don't include it on origin."
            );
            assert_eq!(remote_tip(&f, "old").await, Some(f.old.clone()));
            assert_eq!(remote_tip(&f, "new").await, Some(f.main.clone()));
        }

        /// A tracking ref deleted between the push and the upstream read, under the default
        /// wildcard and a right config, leaves the read unconfirmed: no sentence is added.
        #[tokio::test]
        async fn a_tracking_ref_gone_before_the_upstream_read_adds_no_sentence() {
            let f = fixture("rr-tracking-gone").await;
            let repo = f.repo.clone();
            let hook = hook_at(RemoteRenamePhase::AfterPush, move || {
                let repo = repo.clone();
                async move {
                    run(&repo, &["update-ref", "-d", "refs/remotes/origin/new"]).await;
                }
            });
            let outcome = act_hooked(&f, hook).await;
            assert!(
                matches!(&outcome, RemoteRenameOutcome::Renamed { warning: None }),
                "{outcome:?}"
            );
            assert_eq!(config_get(&f.repo, "branch.new.remote").await, "origin");
            assert_eq!(
                config_get(&f.repo, "branch.new.merge").await,
                "refs/heads/new"
            );
            assert_eq!(full_ref_tip(&f.repo, "refs/remotes/origin/new").await, None);
            assert_eq!(remote_tip(&f, "new").await, Some(f.old.clone()));
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

        /// The proof reads the live tip under a remapped fetch refspec and under a wildcard
        /// that covers `old` and not `new`; the `-u` still writes the remapped tracking ref,
        /// and only the uncovered `new` gets the fetch-settings sentence.
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
            // A wildcard that covers `old` and not `new`: no check refuses it.
            let fetch = "+refs/heads/ol*:refs/remotes/origin/ol*";
            run(
                &g.repo,
                &["config", "--replace-all", "remote.origin.fetch", fetch],
            )
            .await;
            let narrow = act(&g, "new", None).await;
            // The narrow `new` reads untracked by its atoms while its config is right: the
            // live read proves it, and the warning says the fetch settings leave it no
            // upstream here, never that the upstream wasn't set.
            assert!(
                matches!(&mapped, RemoteRenameOutcome::Renamed { warning: None }),
                "mapped: {mapped:?}"
            );
            let RemoteRenameOutcome::Renamed {
                warning: Some(warning),
            } = &narrow
            else {
                panic!("narrow: {narrow:?}");
            };
            assert_eq!(
                warning,
                "new shows no upstream here because this clone's fetch settings don't include it on origin."
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

        /// A new name no fetch entry can map, or one a negative entry excludes, refuses as
        /// `NewNotFetched` before the network read. Beside the exact old entry, an exact
        /// entry for the new name, a narrow wildcard and a short source pass that rule and
        /// reach the old-name rule, which refuses. The standard and remapped wildcards are
        /// clear, and so is a short negative entry beside the standard wildcard. No entry at
        /// all reads as not tracking, which refuses first.
        #[tokio::test]
        async fn a_new_name_outside_the_fetch_refspec_refuses_the_remote_step() {
            use RemoteRenameRefusal as R;
            let f = fixture("rr-unfetched").await;
            let repo = f.repo.as_str();
            let set_fetch = |entries: &'static [&'static str]| async move {
                run(repo, &["config", "--unset-all", "remote.origin.fetch"]).await;
                for entry in entries {
                    run(repo, &["config", "--add", "remote.origin.fetch", entry]).await;
                }
            };
            let check = |new: &'static str| async move {
                remote_rename_check(&AppState::default(), repo, "old", Some(new), "origin", None)
                    .await
                    .unwrap()
            };
            let clear = RemoteRenameCheck::Clear {
                old_tip: f.old.clone(),
            };
            const OLD: &str = "+refs/heads/old:refs/remotes/origin/old";
            // Past the new-name rule, the exact old entry refuses through the old-name one.
            let old_named = RemoteRenameCheck::Refused {
                refusal: R::OldFetchedByName,
            };

            set_fetch(&[OLD]).await;
            assert_eq!(local_refusal(&f, "new").await, R::NewNotFetched);
            set_fetch(&[OLD, "+refs/heads/new:refs/remotes/origin/new"]).await;
            assert_eq!(check("new").await, old_named, "an exact entry for the name");
            set_fetch(&[OLD, "+refs/heads/feat-*:refs/remotes/origin/feat-*"]).await;
            assert_eq!(check("new").await, old_named, "a narrow wildcard");
            set_fetch(&[OLD, "+new:refs/remotes/origin/new"]).await;
            assert_eq!(check("new").await, old_named, "a short source for the name");
            assert_eq!(
                check("other").await,
                old_named,
                "a short source for another name"
            );
            set_fetch(&["+refs/heads/*:refs/remotes/origin/*"]).await;
            assert_eq!(check("new").await, clear, "the standard wildcard");
            set_fetch(&["+refs/heads/*:refs/remotes/origin/mapped/*"]).await;
            run(
                repo,
                &["update-ref", "refs/remotes/origin/mapped/old", &f.old],
            )
            .await;
            assert_eq!(check("new").await, clear, "a remapped wildcard");
            // A negative entry excluding the name refuses whatever maps it, ahead of the
            // old-name rule; one git does not apply to the name lets the check through.
            const WILD: &str = "+refs/heads/*:refs/remotes/origin/*";
            set_fetch(&[WILD, "^refs/heads/new"]).await;
            assert_eq!(local_refusal(&f, "new").await, R::NewNotFetched);
            set_fetch(&[WILD, "^refs/heads/n*"]).await;
            assert_eq!(local_refusal(&f, "new").await, R::NewNotFetched);
            set_fetch(&[WILD, OLD, "^refs/heads/new"]).await;
            assert_eq!(local_refusal(&f, "new").await, R::NewNotFetched);
            set_fetch(&[WILD, "^new"]).await;
            assert_eq!(check("new").await, clear, "a short negative entry");
            // No entry: the upstream reads as not live, which refuses first.
            set_fetch(&[]).await;
            assert_eq!(local_refusal(&f, "new").await, R::NotTracking);

            for (listed, refused) in [
                ("+refs/heads/old:refs/remotes/origin/old\n", true),
                ("refs/heads/old\n", true),
                (
                    "+refs/heads/old:refs/remotes/origin/old\n^refs/heads/x\n",
                    true,
                ),
                ("+refs/heads/old:a\n+refs/heads/new:b\n", false),
                ("+refs/heads/*:refs/remotes/origin/*\n", false),
                ("+refs/heads/feat-*:refs/remotes/origin/feat-*\n", false),
                ("+refs/heads/old:a\n+new:refs/remotes/origin/new\n", false),
                ("+refs/heads/old:a\nnew\n", false),
                ("^refs/heads/old\n", false),
                ("\n", false),
                ("", false),
            ] {
                assert_eq!(
                    super::super::fetch_sources_never_map(listed, "refs/heads/new", "new"),
                    refused,
                    "{listed:?}"
                );
            }
            // A branch named `refs/foo`: git resolves the source `refs/foo` to it.
            assert!(!super::super::fetch_sources_never_map(
                "+refs/heads/old:a\n+refs/foo:refs/remotes/origin/foo\n",
                "refs/heads/refs/foo",
                "refs/foo"
            ));
        }

        /// A negative entry refuses the new name when its pattern excludes the full ref the
        /// way git's fetch does. Without `*` only the identical name, so a short pattern or
        /// a case variant never does; with one, a prefix before the first `*` and a suffix
        /// after it that fit without overlapping, so a pattern starting with `*` can. An
        /// entry git cannot parse as negative never refuses.
        #[test]
        fn a_negative_fetch_entry_excludes_the_new_name_by_gits_rule() {
            for (negative, refused) in [
                ("^refs/heads/new", true),
                ("^refs/heads/n*", true),
                ("^refs/heads/*w", true),
                ("^refs/heads/new*", true),
                ("^refs/heads/ne*w", true),
                ("^refs/heads/*", true),
                ("^refs/*", true),
                ("^*new", true),
                ("^*/new", true),
                ("^*w", true),
                ("^refs/heads/*/new", false),
                ("^refs/tags/*", false),
                ("^refs/heads/x*", false),
                ("^new", false),
                ("^heads/new", false),
                ("^refs/heads/NEW", false),
                ("^+refs/heads/new", false),
                ("+^refs/heads/new", false),
                ("^refs/heads/n**", false),
                ("^refs/heads/newer", false),
                ("^refs/heads/ne*wx", false),
            ] {
                let listed = ["+refs/heads/*:refs/remotes/origin/*", negative, ""].join("\n");
                assert_eq!(
                    super::super::fetch_sources_never_map(&listed, "refs/heads/new", "new"),
                    refused,
                    "{listed:?}"
                );
            }
            // With no positive entry at all, the negative one still answers.
            assert!(super::super::fetch_sources_never_map(
                "^refs/heads/new\n",
                "refs/heads/new",
                "new"
            ));
        }

        /// The old-name matcher: each spelling git resolves to the branch, alone or beside a
        /// wildcard; never a negative entry, a glob, a case variant or another branch.
        #[test]
        fn the_old_name_matcher_reads_each_spelling_git_resolves_to_the_branch() {
            const WILD: &str = "+refs/heads/*:refs/remotes/origin/*";
            let named = [
                "+refs/heads/old:refs/remotes/origin/old",
                "refs/heads/old:refs/remotes/origin/old",
                "old:refs/remotes/origin/old",
                "+old:refs/remotes/origin/old",
                "heads/old:refs/remotes/origin/old",
                "+heads/old:refs/remotes/origin/old",
                "refs/heads/old",
                "+refs/heads/old",
                "refs/heads/old:",
                "old",
                "heads/old",
                "refs/heads/old:refs/remotes/origin/x",
            ];
            for entry in named {
                for listed in [format!("{entry}\n"), format!("{WILD}\n{entry}\n")] {
                    assert!(
                        super::super::fetch_entry_names_branch(&listed, "refs/heads/old", "old"),
                        "{listed:?}"
                    );
                }
            }
            for listed in [
                "^refs/heads/old\n",
                "+refs/heads/*:refs/remotes/origin/*\n",
                "+refs/heads/ol*:refs/remotes/origin/ol*\n",
                "refs/heads/OLD:refs/remotes/origin/OLD\n",
                "refs/heads/other:refs/remotes/origin/other\n",
                "refs/heads/old2:refs/remotes/origin/old2\n",
                "refs/heads/old/x:refs/remotes/origin/old/x\n",
                "refs/heads/xold:refs/remotes/origin/xold\n",
                "heads/olds\n",
                "",
                "\n",
            ] {
                assert!(
                    !super::super::fetch_entry_names_branch(listed, "refs/heads/old", "old"),
                    "{listed:?}"
                );
            }
            // A branch named `refs/foo`: its bare spelling is the source `refs/foo`.
            assert!(super::super::fetch_entry_names_branch(
                "+refs/foo:refs/remotes/origin/foo\n",
                "refs/heads/refs/foo",
                "refs/foo"
            ));
        }

        /// A positive fetch entry naming the old branch (full, `heads/` or bare source; any,
        /// an empty or no destination) refuses before the network read, once a new name is
        /// given and the new-name rule let the configuration through; the default clone and
        /// a negative entry for the old branch stay clear.
        #[tokio::test]
        async fn an_old_name_in_the_fetch_settings_refuses_the_remote_step() {
            use RemoteRenameRefusal as R;
            const WILD: &str = "+refs/heads/*:refs/remotes/origin/*";
            const OLD: &str = "+refs/heads/old:refs/remotes/origin/old";
            let f = fixture("rr-old-fetched").await;
            let repo = f.repo.as_str();
            let set_fetch = |entries: &'static [&'static str]| async move {
                run(repo, &["config", "--unset-all", "remote.origin.fetch"]).await;
                for entry in entries {
                    run(repo, &["config", "--add", "remote.origin.fetch", entry]).await;
                }
            };
            let check = |new: Option<&'static str>| async move {
                remote_rename_check(&AppState::default(), repo, "old", new, "origin", None)
                    .await
                    .unwrap()
            };
            let clear = RemoteRenameCheck::Clear {
                old_tip: f.old.clone(),
            };
            let rows: [&'static [&'static str]; 7] = [
                &[WILD, OLD],
                &[WILD, "+old:refs/remotes/origin/old"],
                &[WILD, "old:refs/remotes/origin/old"],
                &[WILD, "heads/old:refs/remotes/origin/old"],
                &[WILD, "refs/heads/old"],
                &[WILD, "refs/heads/old:"],
                &[OLD, "+refs/heads/new:refs/remotes/origin/new"],
            ];
            for entries in rows {
                set_fetch(entries).await;
                assert_eq!(
                    local_refusal(&f, "new").await,
                    R::OldFetchedByName,
                    "{entries:?}"
                );
            }
            // A single-branch clone of `old` answers `NewNotFetched`: that rule runs first.
            set_fetch(&[OLD]).await;
            assert_eq!(local_refusal(&f, "new").await, R::NewNotFetched);
            assert_eq!(check(None).await, clear, "no name typed, single branch");
            set_fetch(&[OLD, "+refs/heads/x:refs/remotes/origin/x"]).await;
            assert_eq!(local_refusal(&f, "new").await, R::NewNotFetched);
            set_fetch(&[WILD, OLD]).await;
            assert_eq!(check(None).await, clear, "no name typed, exact old entry");
            set_fetch(&[WILD]).await;
            assert_eq!(check(Some("new")).await, clear, "the default clone");
            set_fetch(&[WILD, "^refs/heads/old"]).await;
            assert_eq!(check(Some("new")).await, clear, "a negative old entry");
        }

        /// The fetch-settings sentence needs an answered upstream read with no tracking ref
        /// mapped and a config that names the upstream; the lost-upstream sentence needs that
        /// config read to answer the opposite, so the two never pair.
        #[test]
        fn the_fetch_settings_warning_needs_an_unmapped_read_and_a_right_config() {
            use super::super::{parse_branch_upstream, upstream_seen, upstream_warning};
            use UpstreamSeen::{Tracked, Unconfirmed, Unmapped};
            const S6: &str =
                "new shows no upstream here because this clone's fetch settings don't include it on origin.";
            const LOST: &str = "Couldn't set new's upstream to origin/new.";
            for (seen, names, want) in [
                (Unmapped, Some(true), Some(S6)),
                (Unconfirmed, Some(true), None),
                (Unmapped, Some(false), Some(LOST)),
                (Unconfirmed, Some(false), Some(LOST)),
                (Unmapped, None, None),
                (Tracked, Some(true), None),
                (Tracked, Some(false), None),
            ] {
                let row = format!("{seen:?} {names:?}");
                assert_eq!(
                    upstream_warning(seen, names, "origin", "new", None).as_deref(),
                    want,
                    "{row}"
                );
                let kept = upstream_warning(seen, names, "origin", "new", Some("w".into()));
                let want_kept = want.map_or("w".to_string(), |s| format!("w {s}"));
                assert_eq!(kept.as_deref(), Some(want_kept.as_str()), "{row}, kept");
            }

            let line = |stdout: &str| -> crate::error::AppResult<_> {
                Ok(parse_branch_upstream(stdout, "refs/heads/new"))
            };
            let failed: crate::error::AppResult<_> = Err(AppError::Git {
                code: 128,
                stderr: "fatal: x".into(),
            });
            for (read, want) in [
                (failed, Unconfirmed),
                (Ok(None), Unconfirmed),
                (line("refs/heads/new\0\0\0\0"), Unmapped),
                (
                    line("refs/heads/new\0refs/heads/new\0origin\0\0refs/remotes/origin/new"),
                    Tracked,
                ),
                (
                    line("refs/heads/new\0refs/heads/new\0origin\0[gone]\0refs/remotes/origin/new"),
                    Unconfirmed,
                ),
                (
                    line("refs/heads/new\0refs/heads/new\0upstream\0\0refs/remotes/upstream/new"),
                    Unconfirmed,
                ),
            ] {
                assert_eq!(upstream_seen(&read, "origin", "new"), want, "{read:?}");
            }
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
                (PushedCopy::Unknown, UpstreamSeen::Unconfirmed)
            );
            assert_eq!(
                live_pushed_tip(&f.repo, "origin", "old").await,
                Some(f.old.clone())
            );
        }
    }
}
