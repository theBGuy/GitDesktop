use super::*;

/// Resolve a remote's default branch name (e.g. `"master"` / `"main"`) — the branch
/// a fork's `upstream` sync targets. Reads the LOCAL `refs/remotes/<remote>/HEAD`
/// symbolic ref first: offline, written by the initial `git clone`, so it usually
/// answers immediately. If that ref is unset — as it is for a hand-added `upstream`
/// — one network call (`git remote set-head <remote> --auto`) writes it and we
/// re-read. Returns the bare branch name (no `<remote>/` prefix).
#[tauri::command]
pub async fn git_remote_default_branch(
    state: State<'_, AppState>,
    repo_path: String,
    remote: String,
) -> AppResult<String> {
    ensure_remote_exists(&repo_path, &remote).await?;

    if let Some(branch) = remote_head_branch(&repo_path, &remote).await? {
        return Ok(branch);
    }

    // The local ref is unset — ask the remote for its HEAD (one network call),
    // then re-read. `set-head --auto` writes `refs/remotes/<remote>/HEAD`.
    let cred = crate::forge::credential_config_for_remote(&repo_path, &remote).await?;
    run_git_mutating_with_creds(
        &state,
        &repo_path,
        &cred,
        &["remote", "set-head", &remote, "--auto"],
        NETWORK_TIMEOUT,
    )
    .await?;

    remote_head_branch(&repo_path, &remote)
        .await?
        .ok_or_else(|| {
            AppError::InvalidArgument(format!(
                "could not resolve default branch for remote: {remote}"
            ))
        })
}

/// The branch `refs/remotes/<remote>/HEAD` points at, or `None` when that symref
/// is unset (never written for a hand-added remote). Local read, no network.
pub(crate) async fn remote_head_branch(repo_path: &str, remote: &str) -> AppResult<Option<String>> {
    read_symbolic_ref(
        repo_path,
        &format!("refs/remotes/{remote}/HEAD"),
        &format!("refs/remotes/{remote}/"),
    )
    .await
}

/// The full ref `refs/remotes/<remote>/HEAD` points at; None when unset or unreadable
/// (unmeasured).
pub(crate) async fn remote_head_target(repo_path: &str, remote: &str) -> AppResult<Option<String>> {
    read_symbolic_ref(repo_path, &format!("refs/remotes/{remote}/HEAD"), "").await
}

/// Whether an upstream is its remote's default branch, comparing FULL tracking refs so
/// a remapped fetch refspec answers the same as the default one. Some only from a
/// remote HEAD that answered; None = unmeasured (no name fallback).
pub(crate) fn upstream_is_remote_default(
    remote_head_target: Option<&str>,
    upstream_tracking_ref: &str,
) -> Option<bool> {
    let target = remote_head_target.filter(|t| !t.is_empty())?;
    if upstream_tracking_ref.is_empty() {
        return None;
    }
    Some(target == upstream_tracking_ref)
}

/// Read a symbolic ref and strip `prefix` off its target, returning the tail
/// (the branch name). `None` when the ref is unset — `git symbolic-ref` exits
/// non-zero — or its target doesn't start with `prefix`.
async fn read_symbolic_ref(
    repo_path: &str,
    symref: &str,
    prefix: &str,
) -> AppResult<Option<String>> {
    let out = run_git(
        Some(repo_path),
        &["symbolic-ref", "--quiet", symref],
        DEFAULT_TIMEOUT,
    )
    .await;
    // An unset ref makes `symbolic-ref` exit non-zero; run_git surfaces that as
    // an error, which here means "not resolved yet", not a hard failure.
    let Ok(out) = out else {
        return Ok(None);
    };
    let target = out.stdout_lossy().trim().to_string();
    Ok(target
        .strip_prefix(prefix)
        .filter(|b| !b.is_empty())
        .map(str::to_string))
}

#[cfg(test)]
mod tests {
    #[test]
    fn upstream_is_remote_default_table() {
        let full = "refs/remotes/origin/mirror/main";
        for (target, upstream, want) in [
            (None, full, None),
            (Some(""), full, None),
            (Some(full), full, Some(true)),
            (Some("refs/remotes/origin/main"), full, Some(false)),
            (Some(full), "", None),
        ] {
            assert_eq!(
                super::upstream_is_remote_default(target, upstream),
                want,
                "{target:?} vs {upstream:?}"
            );
        }
    }
}
