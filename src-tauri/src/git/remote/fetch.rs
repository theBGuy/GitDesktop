use super::*;

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, repo_path: String) -> AppResult<()> {
    git_fetch_core(&state, repo_path).await
}

/// The shared fetch. It prunes BRANCHES — clearing tracking refs for branches the
/// forge no longer has is the action's whole point — and keeps the local tags a
/// `fetch.pruneTags` / `remote.<name>.pruneTags` config would prune: the background
/// auto-fetch runs this on a timer, and a transfer the user never asked for must
/// not delete their refs. The flag reaches only the IMPLICIT tag refspec — a remote
/// spelling `refs/tags/*` out in its own fetch config still prunes them here (the
/// pull side stands down for that shape; this always-prune action has no stand-down).
pub(crate) async fn git_fetch_core(state: &AppState, repo_path: String) -> AppResult<()> {
    let cred = crate::forge::credential_config_for_remote(&repo_path, "origin").await?;
    run_git_mutating_with_creds(
        state,
        &repo_path,
        &cred,
        &["fetch", "--prune", "--no-prune-tags"],
        NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Fetch a single named remote, unlike [`git_fetch`] which fetches only the
/// default remote. Powers "Update from upstream" for forks: a default-remote fetch
/// never touches an `upstream` remote, so a fork needs this to see upstream's new
/// commits at all. The remote is validated to exist before use; the flags are
/// [`git_fetch_core`]'s, for the same reasons.
#[tauri::command]
pub async fn git_fetch_remote(
    state: State<'_, AppState>,
    repo_path: String,
    remote: String,
) -> AppResult<()> {
    ensure_remote_exists(&repo_path, &remote).await?;
    let cred = crate::forge::credential_config_for_remote(&repo_path, &remote).await?;
    run_git_mutating_with_creds(
        &state,
        &repo_path,
        &cred,
        &["fetch", "--prune", "--no-prune-tags", &remote],
        NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::remote::tests::{run, seeded_origin};

    /// A tag-pruning user keeps their local tags through the Fetch action, and the
    /// BRANCH half of the prune still runs — that half is what the action exists
    /// for, and the auto-fetch timer is what makes the tag half matter. A sibling
    /// clone under the same config is the negative control: there a raw pruning
    /// fetch deletes the tag, so the config is proven to bite before the flag is
    /// credited with anything.
    #[tokio::test]
    async fn fetch_keeps_local_tags_and_still_prunes_branches() {
        let (_guard, base, _origin_s, url) = seeded_origin("prune-tags").await;
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();

        // A branch both clones track, deleted on the origin afterwards — the stale
        // tracking ref the prune has to take.
        run(&work_s, &["switch", "-q", "-c", "doomed"]).await;
        std::fs::write(work.join("d.txt"), "d\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "doomed"]).await;
        run(&work_s, &["push", "-q", "-u", "origin", "doomed"]).await;

        for name in ["clone", "control"] {
            run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, name]).await;
            let c = base.join(name).to_string_lossy().into_owned();
            run(&c, &["config", "fetch.pruneTags", "true"]).await;
            // A tag the origin does not carry, which is what makes it prunable.
            run(&c, &["tag", "keep-me"]).await;
        }
        run(&work_s, &["push", "-q", "origin", "--delete", "doomed"]).await;

        let clone_s = base.join("clone").to_string_lossy().into_owned();
        let control_s = base.join("control").to_string_lossy().into_owned();

        // Both preconditions, asserted before the fetch: without them the two
        // assertions below would pass on an empty starting state.
        assert_eq!(run(&clone_s, &["tag"]).await.trim(), "keep-me");
        assert!(
            !run(&clone_s, &["for-each-ref", "refs/remotes/origin/doomed"])
                .await
                .trim()
                .is_empty(),
            "the clone must start with the tracking ref the prune is meant to clear"
        );

        // The config has to bite, or retention below proves nothing.
        run(&control_s, &["fetch", "--prune", "origin"]).await;
        assert!(
            run(&control_s, &["tag"]).await.trim().is_empty(),
            "fetch.pruneTags must delete the tag on the control's raw pruning fetch"
        );

        git_fetch_core(&AppState::default(), clone_s.clone())
            .await
            .expect("the fetch action succeeds");
        assert_eq!(
            run(&clone_s, &["tag"]).await.trim(),
            "keep-me",
            "the Fetch action deleted a tag the user still holds"
        );
        assert!(
            run(&clone_s, &["for-each-ref", "refs/remotes/origin/doomed"])
                .await
                .trim()
                .is_empty(),
            "the deleted upstream branch's tracking ref must still be pruned"
        );
    }
}
