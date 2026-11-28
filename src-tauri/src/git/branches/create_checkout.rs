use super::*;

#[tauri::command]
pub async fn git_checkout_branch(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    git_checkout_branch_core(&state, repo_path, name).await
}

pub(crate) async fn git_checkout_branch_core(
    state: &AppState,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    validate_ref_name(&name)?;
    let session_name = is_session_branch_name(&name);
    // Refuse only guess-creation so existing session-named branches stay reachable.
    if session_name && !branch_exists_exact(&repo_path, &name).await? {
        refuse_session_branch_name(&name)?;
    }
    crate::git::update_marker::refuse_if_branch_updating(state, &repo_path, &name).await?;
    let mut args = vec!["switch"];
    if session_name {
        // The existence check runs outside the lock; a concurrent delete must
        // not re-open guess-creation at the switch.
        args.push("--no-guess");
    }
    args.push(&name);
    // The switch's HEAD write lands inside the config-write mutex, so it cannot fall
    // inside a branch delete's guarded window; its working-tree hold comes first.
    let repo = repo_path.as_str();
    let domain = state.working_tree_lock(repo).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, holder_label("switch")).await?;
    with_config_write_lock(repo, |_held| async move {
        run_git_raw_index_retry(repo, &args, DEFAULT_TIMEOUT).await
    })
    .await?
    .exit_verdict()?;
    Ok(())
}

/// Check out a remote-only branch as a new local tracking branch of a SPECIFIC
/// remote. We pass `--track -c <name> refs/remotes/<remote>/<name>` explicitly rather
/// than plain `switch <name>` because when the same branch name exists on 2+ remotes
/// git's DWIM refuses ("matched multiple remote tracking branches"), and even in the
/// single-remote case the switcher row promised the user this exact remote — so
/// we honor it by construction instead of trusting git's guess. The local name is
/// explicit because `--track` alone strips only the start's first component after
/// `refs/remotes/`, so a remote named `team/fork` would mint `fork/<name>`.
#[tauri::command]
pub async fn git_checkout_remote_branch(
    state: State<'_, AppState>,
    repo_path: String,
    remote: String,
    name: String,
) -> AppResult<()> {
    git_checkout_remote_branch_core(&state, repo_path, remote, name).await
}

pub(crate) async fn git_checkout_remote_branch_core(
    state: &AppState,
    repo_path: String,
    remote: String,
    name: String,
) -> AppResult<()> {
    validate_ref_name(&remote)?;
    validate_branch_name(&name)?;
    refuse_session_branch_name(&name)?;
    // A live update means a LOCAL `name` already exists and is held, so this switch
    // collides on it rather than creating anything.
    crate::git::update_marker::refuse_if_branch_updating(state, &repo_path, &name).await?;
    // The full ref: a tag or local branch named `<remote>/<name>` makes the bare form
    // ambiguous, and git refuses to start from it.
    let start = format!("refs/remotes/{remote}/{name}");
    let (repo, local, start_s) = (repo_path.as_str(), name.as_str(), start.as_str());
    let out = run_minting_write(
        state,
        repo,
        &["switch", "--track", "-c", local, start_s],
        local,
        None,
        |out, held| async move {
            let by = TrackedBy::ExplicitTrack;
            let finished = finish_tracking_setup(&held, repo, out, local, start_s, by, true).await;
            finished.map(|finished| finished.out)
        },
    )
    .await?;
    full_failure_verdict(out)?;
    Ok(())
}

/// Build the argv for creating a branch. Pure so the decision table
/// (checkout × start_point × no_track) is unit-testable without a repo.
///
/// `no_track` suppresses git's automatic upstream setup so that basing a new
/// branch on a remote-tracking ref (e.g. `origin/epic/x`) yields a branch with
/// NO upstream — its first push then publishes it under its own name. Placement
/// matters: `--no-track` goes right after `switch` in the checkout arm, and
/// BEFORE the `--` in the `branch` arm.
fn build_create_branch_args(
    name: &str,
    checkout: bool,
    start_point: Option<&str>,
    no_track: bool,
) -> Vec<String> {
    let mut args: Vec<String> = if checkout {
        let mut a = vec!["switch".to_string()];
        if no_track {
            a.push("--no-track".to_string());
        }
        a.push("-c".to_string());
        a.push(name.to_string());
        a
    } else {
        let mut a = vec!["branch".to_string()];
        if no_track {
            a.push("--no-track".to_string());
        }
        a.push("--".to_string());
        a.push(name.to_string());
        a
    };
    if let Some(start) = start_point {
        args.push(start.to_string());
    }
    args
}

#[tauri::command]
pub async fn git_create_branch(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    checkout: bool,
    start_point: Option<String>,
    no_track: bool,
) -> AppResult<()> {
    git_create_branch_core(&state, repo_path, name, checkout, start_point, no_track).await
}

pub(crate) async fn git_create_branch_core(
    state: &AppState,
    repo_path: String,
    name: String,
    checkout: bool,
    start_point: Option<String>,
    no_track: bool,
) -> AppResult<()> {
    validate_branch_name(&name)?;
    refuse_session_branch_name(&name)?;
    if let Some(start) = &start_point {
        // start_point may be a branch name or a commit hash — validate as a ref
        // (non-empty, no leading '-') rather than strictly a hash.
        validate_ref_name(start)?;
    }
    let args = build_create_branch_args(&name, checkout, start_point.as_deref(), no_track);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (repo, local) = (repo_path.as_str(), name.as_str());
    // Any create but `--no-track` can set tracking up, the one leg that writes the
    // config: with no start point git starts from HEAD, where `always` tracks that
    // local branch and `inherit` copies its upstream (measured, git 2.51.1).
    if no_track {
        // Writes no config, so a lost config lock has nothing to repair.
        run_minting_write(state, repo, &arg_refs, local, None, |out, _| async move {
            Ok(out)
        })
        .await?
        .exit_verdict()?;
        return Ok(());
    }
    let start = start_point.as_deref().unwrap_or("HEAD");
    let out = run_minting_write(
        state,
        repo,
        &arg_refs,
        local,
        None,
        |out, held| async move {
            let by = TrackedBy::AutoSetupMerge;
            let finished =
                finish_tracking_setup(&held, repo, out, local, start, by, checkout).await;
            finished.map(|finished| finished.out)
        },
    )
    .await?;
    full_failure_verdict(out)?;
    Ok(())
}

/// A write that mints the branch `name` (`replaces` is the branch a rename moves off):
/// the working-tree domain, then the config-write mutex, each taken ONCE and both held
/// through git, with [`refuse_new_name_twin`] inside the mutex, so a twin another creator
/// in any checkout mints during the wait is still seen. A lost config lock hands the raw
/// output and the held mutex to `repair`, as [`run_git_mutating_config_write`] does; the
/// raw output comes back for the caller's verdict.
///
/// Before git runs, a name with no ref loses its leftover `branch.<name>` keys in the
/// local config file under any header spelling, so a minted branch carries only its own
/// settings from that file; keys set through an `[include]`d file are neither read nor
/// removed, and the minted branch takes them up. Every key goes for a rename or a create
/// whose name is not marked Keep local, every key but a true Keep local mark for a create
/// of a marked name (Restore marks the name before it creates the branch and keeps the
/// mark when that create fails). A drop that fails stops the mint. It, or a mint that does
/// not land, puts back the records the drop removed while the name still has no ref, as
/// [`restore_dropped_branch_settings`] decides from the local config file's listing alone,
/// so a key set again in another scope or through an `[include]` does not stop a put-back
/// ([`drop_leftover_branch_settings`] names the limits).
///
/// [`run_git_mutating_config_write`]: crate::git::runner::run_git_mutating_config_write
pub(super) async fn run_minting_write<F, Fut>(
    state: &AppState,
    repo_path: &str,
    args: &[&str],
    name: &str,
    replaces: Option<&str>,
    repair: F,
) -> AppResult<GitOutput>
where
    F: FnOnce(GitOutput, ConfigWriteHeld) -> Fut,
    Fut: std::future::Future<Output = AppResult<GitOutput>>,
{
    let domain = state.working_tree_lock(repo_path).await;
    let label = holder_label(subcommand_of(args));
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, label).await?;
    with_config_write_lock(repo_path, |held| async move {
        if let Some(old) = replaces {
            // Both waits above reopen the window of the rename's pre-wait publish check.
            refuse_while_publishing(repo_path, old).await?;
        }
        refuse_new_name_twin(repo_path, name, replaces).await?;
        let mut argv = args.to_vec();
        // A rename's `-M` was read before the hold: an exact `name` minted since then
        // takes `-m`, so git refuses instead of replacing it.
        if replaces.is_some() {
            if let Some(flag) = argv.iter_mut().find(|arg| **arg == "-M") {
                if exact_branch_tip(repo_path, name).await?.is_some() {
                    *flag = "-m";
                }
            }
        }
        let dropped =
            drop_leftover_branch_settings(&held, repo_path, name, replaces.is_some()).await?;
        #[cfg(test)]
        run_test_hook(&MINT_CLEANUP_HOOK).await;
        let out = run_git_raw_index_retry(repo_path, &argv, DEFAULT_TIMEOUT).await;
        // A refusal or a run that never finished (spawn error, timeout) restores; the
        // run's own result stays the answer.
        let landed = out.as_ref().is_ok_and(|out| out.code == 0);
        if !landed && !dropped.is_empty() {
            // The drop answers a key's records only after that key's unset answered, so its
            // answer stands in for those keys' records before the drop, except that a value
            // listed again in the marked arm is left out of it and then reads as another
            // writer's.
            restore_dropped_branch_settings(&held, repo_path, name, &dropped, &dropped).await;
        }
        let out = out?;
        if is_config_lock_contention(&out.stderr) {
            return repair(out, held).await;
        }
        Ok(out)
    })
    .await
}

/// [`run_git_mutating_config_write`]'s verdict: a non-zero exit is [`AppError::Git`]
/// with [`GitOutput::full_failure_text`].
///
/// [`run_git_mutating_config_write`]: crate::git::runner::run_git_mutating_config_write
pub(super) fn full_failure_verdict(out: GitOutput) -> AppResult<GitOutput> {
    if out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    Ok(out)
}

/// [`run_minting_write`]'s leftover-settings rule, under the held config-write mutex: a
/// name whose branch ref exists is never touched, and a name with no local
/// `branch.<name>` key writes nothing, so a mint with no leftovers gets no config write.
/// The whole arm (a rename, or a create of a name not marked Keep local) removes the
/// section, then unsets every listed key, which reaches a header in another letter case
/// that the removal does not match. The marked arm (a create of a marked name) unsets
/// every key but the mark, which is never removed.
///
/// The answer is the records gone, for [`restore_dropped_branch_settings`]: those the
/// re-read no longer lists; when the re-read fails, every listed record after a section
/// removal, else the records of the keys whose unset answered. An unset failure, and in
/// the whole arm a failed re-read or a key listed again, is the `Err`: the records gone
/// are put back as that put-back decides, and nothing is minted. A failed re-read does not
/// fail the marked arm, so its mint runs, answering the records its unsets removed, which
/// a refused mint puts back. A `--remove-section` that times out or fails to spawn is the
/// `Err` with nothing it may have removed put back. A section removal or an unset that
/// loses the config lock answers the busy-config refusal ([`config_lock_busy`]) for the
/// rename or the create.
///
/// Known limit: when the re-read fails, the records gone are inferred, not read, and can
/// be wrong two ways. After a section removal that answered, every listed record counts
/// as gone; the removal answers for any lowercase `[branch "<name>"]` header, even one
/// holding no record, so a record still present under an other-case header, its key's
/// unset having failed or never run, is put back a second time when the put-back's own
/// read of the section fails too. With no section removed (a lone other-case header, or
/// the marked arm), they are the records of the keys whose unset answered; an unset that
/// timed out or failed to spawn is not among them even if git had already written, so its
/// record is not put back.
async fn drop_leftover_branch_settings(
    held: &ConfigWriteHeld,
    repo_path: &str,
    name: &str,
    renaming: bool,
) -> AppResult<Vec<(String, Option<String>)>> {
    if exact_branch_tip(repo_path, name).await?.is_some() {
        return Ok(Vec::new());
    }
    let listed = run_git(
        Some(repo_path),
        &["config", "--local", "--null", "--list"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let listed = listed.stdout_lossy();
    let records = branch_section_records(&listed, name);
    let keys = branch_section_keys(&listed, name);
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let whole = renaming || !branch_keep_local(repo_path, name).await?;
    let busy_tail = if renaming {
        "the branch wasn't renamed — try again."
    } else {
        "the branch wasn't created — try again."
    };
    // A write that lost the config lock answers the app's busy refusal, not git's lock line.
    let failed = |out: &GitOutput| {
        if is_config_lock_contention(&out.stderr) {
            return config_lock_busy(busy_tail);
        }
        AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        }
    };
    let mut removed = false;
    if whole {
        let section = format!("branch.{name}");
        let args = ["config", "--remove-section", &section];
        let out = run_git_config_write_held(held, repo_path, &args, DEFAULT_TIMEOUT).await?;
        if out.code == 0 {
            removed = true;
        } else if !out.stderr.contains("no such section") {
            // "no such section" leaves keys only under a header in another letter case,
            // which the per-key unsets still reach.
            return Err(failed(&out));
        }
    }
    let mark = keep_local_key(name);
    let mark_variable = mark.rsplit_once('.').map_or("", |(_, variable)| variable);
    let keep = (!whole).then_some(mark_variable);
    let (unset_keys, unset) = unset_section_keys(held, repo_path, &keys, keep, failed).await;
    let left = section_records_now(repo_path, name).await;
    let unset_records: Vec<_> = records
        .iter()
        .filter(|(key, _)| unset_keys.contains(key))
        .cloned()
        .collect();
    let gone = match &left {
        Ok(left) => records_gone(&records, left),
        // The removal took the lowercase records of keys no unset reached, and a listing
        // can't tell which header a record sat under.
        Err(_) if removed => records.clone(),
        Err(_) => unset_records,
    };
    let failure = match (unset, left) {
        (Err(e), _) => Some(e),
        (Ok(()), Err(e)) if whole => Some(e),
        // A key listed again after its unset answered: another writer is at the config.
        (Ok(()), Ok(left)) if whole && !left.is_empty() => Some(AppError::Busy {
            holder: String::new(),
        }),
        _ => None,
    };
    let Some(failure) = failure else {
        return Ok(gone);
    };
    if !gone.is_empty() {
        restore_dropped_branch_settings(held, repo_path, name, &records, &gone).await;
    }
    Err(failure)
}

/// Unsets each of `keys` in the local config but the variable `keep` (matched in any
/// case), stopping at the first failure. Answers the keys whose unset exited 0 or 5 (5:
/// the key was already gone), in `keys` order, beside that failure or `Ok`; an unset that
/// failed to spawn or timed out is a failure, and its key is not among them. Another exit
/// is the error `failed` builds from its output.
async fn unset_section_keys(
    held: &ConfigWriteHeld,
    repo_path: &str,
    keys: &[String],
    keep: Option<&str>,
    failed: impl Fn(&GitOutput) -> AppError,
) -> (Vec<String>, AppResult<()>) {
    let mut unset = Vec::new();
    for key in keys {
        let variable = key.rsplit_once('.').map_or("", |(_, variable)| variable);
        if keep.is_some_and(|keep| variable.eq_ignore_ascii_case(keep)) {
            continue;
        }
        let args = ["config", "--local", "--unset-all", key.as_str()];
        let ran = run_git_config_write_held(held, repo_path, &args, DEFAULT_TIMEOUT).await;
        let out = match ran {
            Ok(out) => out,
            Err(e) => return (unset, Err(e)),
        };
        if out.code != 0 && out.code != 5 {
            return (unset, Err(failed(&out)));
        }
        unset.push(key.clone());
    }
    (unset, Ok(()))
}

/// [`branch_section_records`] of a fresh `config --local --list` read.
async fn section_records_now(
    repo_path: &str,
    name: &str,
) -> AppResult<Vec<(String, Option<String>)>> {
    #[cfg(test)]
    if SECTION_REREAD_FAILS.try_with(|_| ()).is_ok() {
        return Err(AppError::Command(SECTION_REREAD_FAILURE.into()));
    }
    let listed = run_git(
        Some(repo_path),
        &["config", "--local", "--null", "--list"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(branch_section_records(&listed.stdout_lossy(), name))
}

/// The records of `before` that `after` no longer holds; a record listed twice counts
/// twice.
fn records_gone(
    before: &[(String, Option<String>)],
    after: &[(String, Option<String>)],
) -> Vec<(String, Option<String>)> {
    let mut kept = after.to_vec();
    let mut gone = Vec::new();
    for record in before {
        match kept.iter().position(|left| left == record) {
            Some(at) => {
                kept.remove(at);
            }
            None => gone.push(record.clone()),
        }
    }
    gone
}

/// Puts back the `branch.<name>` records a drop removed when its mint did not land (git
/// refused it or never finished: a spawn error, a timeout) or the drop itself failed part
/// way, under the same held mutex, while `name` still has no ref (a mint that left a ref
/// there wrote its own section). Best-effort and logged: the failure is the answer.
/// A value-less key comes back as `true`, the same boolean. Each record goes back with
/// `config --add`, which writes it inside a header of the section still in the file,
/// otherwise into a new section at the end of the local config. After the drop a header is
/// left only where git kept it: a section the removal took is gone whole, git deletes any
/// header (either letter case) the unsets emptied unless it holds a comment line, and in
/// the marked arm the header holding the Keep local mark is never emptied, so its records
/// go back inside it. A record that lands after an `[include]` which followed its original
/// place is no longer overridden by it, whether in a new section at the end or in a kept
/// header that sits after the include (measured on git 2.51.1 and 2.47.3).
///
/// Which records go back is decided per key from one fresh read of the section, taken
/// before any put-back, against `before`, the section's records before the drop, values
/// compared with their multiplicity ([`records_to_put_back`]). A key listing a value
/// `before` did not hold has another writer's value and gets nothing, since `--add` lands
/// after it and the old value would win. A key whose last listed value is its last value
/// `before` keeps its effective value and gets nothing, since an add would replace it; the
/// cost is that its other old values don't come back. Any other key gets back its dropped
/// records in order, less any the read lists on top of the survivors the drop left (its
/// records `before` less the dropped ones): no record still listed is added again, and the
/// key's original last value goes back last. When that read fails, every record goes back.
/// A write between the read and an `--add` is out of reach, since an outside git takes no
/// app lock and `git config` has no add-if-absent.
async fn restore_dropped_branch_settings(
    held: &ConfigWriteHeld,
    repo_path: &str,
    name: &str,
    before: &[(String, Option<String>)],
    dropped: &[(String, Option<String>)],
) {
    if !matches!(exact_branch_tip(repo_path, name).await, Ok(None)) {
        return;
    }
    let put_back = match section_records_now(repo_path, name).await {
        Ok(now) => records_to_put_back(before, &now, dropped),
        Err(_) => dropped.to_vec(),
    };
    for (key, value) in &put_back {
        let value = value.as_deref().unwrap_or("true");
        let args = ["config", "--local", "--add", key.as_str(), value];
        let restored = run_git_config_write_held(held, repo_path, &args, DEFAULT_TIMEOUT).await;
        if !restored.as_ref().is_ok_and(|out| out.code == 0) {
            eprintln!("gitdesktop: couldn't restore {key} of a branch that wasn't minted");
        }
    }
}

/// The records of `dropped` that [`restore_dropped_branch_settings`]' rule adds back, in
/// their order, from the section's records `before` the drop and `now`; a value-less
/// record equals only another value-less one.
fn records_to_put_back(
    before: &[(String, Option<String>)],
    now: &[(String, Option<String>)],
    dropped: &[(String, Option<String>)],
) -> Vec<(String, Option<String>)> {
    let of = |records: &[(String, Option<String>)], key: &str| -> Vec<(String, Option<String>)> {
        records.iter().filter(|(k, _)| k == key).cloned().collect()
    };
    // For each of `keys` that gets records back, the records `now` lists on top of the
    // survivors the drop left (`before` less the dropped ones) that no dropped one matched
    // yet: a survivor is already absent from `dropped`, so it must not strike a dropped one.
    let (mut keys, mut unmatched): (Vec<&str>, Vec<_>) = (Vec::new(), Vec::new());
    let mut skipped: Vec<&str> = Vec::new();
    let mut add = Vec::new();
    for record in dropped {
        let key = record.0.as_str();
        if skipped.contains(&key) {
            continue;
        }
        let at = match keys.iter().position(|k| *k == key) {
            Some(at) => at,
            None => {
                let (before, now) = (of(before, key), of(now, key));
                let foreign = !records_gone(&now, &before).is_empty();
                let intact = !now.is_empty() && now.last() == before.last();
                if foreign || intact {
                    skipped.push(key);
                    continue;
                }
                let survivors = records_gone(&before, &of(dropped, key));
                keys.push(key);
                unmatched.push(records_gone(&now, &survivors));
                keys.len() - 1
            }
        };
        let listed: &mut Vec<_> = &mut unmatched[at];
        match listed.iter().position(|left| left == record) {
            Some(i) => {
                listed.remove(i);
            }
            None => add.push(record.clone()),
        }
    }
    add
}

/// The records of the `[branch "<name>"]` section in a `config --null --list` text, in
/// order: a record is `<key>\n<value>`, or `<key>` alone for a value-less key. The key
/// splits at its first dot (section, any case) and its last (variable); the subsection
/// between may hold dots and must equal `name` exactly, as git compares it.
fn branch_section_records(list_output: &str, name: &str) -> Vec<(String, Option<String>)> {
    let mut records = Vec::new();
    for record in list_output.split('\0') {
        let (key, value) = match record.split_once('\n') {
            Some((key, value)) => (key, Some(value)),
            None => (record, None),
        };
        let Some((section, rest)) = key.split_once('.') else {
            continue;
        };
        let Some((subsection, _)) = rest.rsplit_once('.') else {
            continue;
        };
        if section.eq_ignore_ascii_case("branch") && subsection == name {
            records.push((key.to_string(), value.map(str::to_string)));
        }
    }
    records
}

/// [`branch_section_records`]' keys, each once.
fn branch_section_keys(list_output: &str, name: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for (key, _) in branch_section_records(list_output, name) {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        append_config, branch_exists, branch_section, case_twin_alias_oracle, case_twin_listed,
        case_twin_snapshot, commit_file, delete, delete_fixture, full_ref_tip, git_ok,
        hold_config_mutex, init_repo, keep_local_repo, move_dir, on_first_waiting, run,
        symbolic_head, temp_base, tracking_of, upstream_of, NEW_NAME_TWIN_REFUSAL,
    };
    use crate::git::runner::{
        hold_config_lock, CONFIG_WRITE_LOCK_EVENTS, GIT_SPAWN_LOG, TEST_GIT_HANG_GUARD,
    };
    use std::sync::Arc;

    /// A rename onto a name whose leftover section says `remote = stale` and Keep local
    /// false keeps exactly the renamed branch's own settings.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_rename_drops_the_leftover_section_of_its_new_name() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_g, _base, repo) = keep_local_repo("orphan-rename").await;
        run(&repo, &["branch", "old"]).await;
        run(&repo, &["config", "branch.old.remote", "origin"]).await;
        run(&repo, &["config", "branch.old.merge", "refs/heads/old"]).await;
        super::set_branch_keep_local_core(&repo, "old", true)
            .await
            .unwrap();
        append_config(
            &repo,
            "[branch \"new\"]\n\tremote = stale\n\tgitdesktopLocalOnly = false\n\tleftover = kept\n",
        );
        git_rename_branch_core(
            &AppState::default(),
            repo.clone(),
            "old".into(),
            "new".into(),
        )
        .await
        .unwrap();
        let remotes = run_git_raw(
            Some(&repo),
            &["config", "--get-all", "branch.new.remote"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap()
        .stdout_lossy();
        assert_eq!(remotes, "origin\n");
        assert!(super::branch_keep_local(&repo, "new").await.unwrap());
        assert!(!git_ok(&repo, &["config", "--get", "branch.new.leftover"]).await);
    }

    async fn create_no_track(repo: &str, name: &str, start: Option<&str>) -> Result<(), AppError> {
        git_create_branch_core(
            &AppState::default(),
            repo.to_string(),
            name.to_string(),
            false,
            start.map(str::to_string),
            true,
        )
        .await
    }

    /// A refused rename puts back the destination's leftover section it dropped, a Keep
    /// local mark included: git ran with the source gone, so the new name has no ref.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn a_refused_rename_restores_the_dropped_leftover_settings() {
        use super::{TestHook, MINT_CLEANUP_HOOK};
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store.path());
        let (_g, _base, repo) = keep_local_repo("orphan-rename-refused").await;
        run(&repo, &["branch", "src"]).await;
        append_config(
            &repo,
            "[branch \"dst\"]\n\tremote = stale\n\tgitdesktopLocalOnly = true\n",
        );
        let hook: TestHook = {
            let repo = repo.clone();
            Arc::new(move || {
                let repo = repo.clone();
                Box::pin(async move {
                    run(&repo, &["update-ref", "-d", "refs/heads/src"]).await;
                })
            })
        };
        let state = AppState::default();
        let rename =
            super::git_rename_branch_core(&state, repo.clone(), "src".into(), "dst".into());
        let renamed = MINT_CLEANUP_HOOK.scope(hook.clone(), rename).await;
        assert!(renamed.is_err(), "git refused the rename");
        assert!(!branch_exists(&repo, "dst").await);
        let section = branch_section(&repo, "dst").await;
        assert!(section.contains("branch.dst.remote stale"), "{section}");
        assert!(
            section.contains("branch.dst.gitdesktoplocalonly true"),
            "{section}"
        );

        // A hand-capitalised header is no section `--remove-section` finds, so its keys
        // are unset one by one, and the refused rename puts each back once.
        run(&repo, &["branch", "src"]).await;
        append_config(&repo, "[Branch \"dup\"]\n\tremote = stale\n");
        let rename =
            super::git_rename_branch_core(&state, repo.clone(), "src".into(), "dup".into());
        let renamed = MINT_CLEANUP_HOOK.scope(hook.clone(), rename).await;
        assert!(renamed.is_err(), "git refused the rename onto dup");
        assert_eq!(
            run(&repo, &["config", "--get-all", "branch.dup.remote"])
                .await
                .trim(),
            "stale"
        );

        // With both headers the section removal takes the lowercase record and the per-key
        // unset the capitalised one; each comes back once.
        run(&repo, &["branch", "src"]).await;
        append_config(
            &repo,
            "[branch \"two\"]\n\tremote = a\n[Branch \"two\"]\n\tremote = b\n",
        );
        let rename =
            super::git_rename_branch_core(&state, repo.clone(), "src".into(), "two".into());
        let renamed = MINT_CLEANUP_HOOK.scope(hook, rename).await;
        assert!(renamed.is_err(), "git refused the rename onto two");
        let remotes = run(&repo, &["config", "--get-all", "branch.two.remote"]).await;
        let mut remotes: Vec<&str> = remotes.lines().collect();
        remotes.sort_unstable();
        assert_eq!(remotes, ["a", "b"]);
    }

    /// A rename whose git never ran (its spawn failed) also puts back the destination's
    /// dropped leftover section, and answers that spawn's own error.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn a_rename_that_never_ran_restores_the_dropped_leftover_settings() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store.path());
        let (_g, _base, repo) = keep_local_repo("orphan-rename-unspawned").await;
        run(&repo, &["branch", "src"]).await;
        append_config(
            &repo,
            "[branch \"dst\"]\n\tremote = stale\n\tgitdesktopLocalOnly = true\n",
        );
        // The rename's spawn finds the repository moved away; the next spawn moves it back.
        let away = format!("{repo}-away");
        let steps = Arc::new(AtomicUsize::new(0));
        let log = {
            let (repo, away, steps) = (repo.clone(), away.clone(), steps.clone());
            Arc::new(move |args: &[&str]| match steps.load(SeqCst) {
                0 if args.first() == Some(&"branch") && args.contains(&"--") => {
                    move_dir(&repo, &away);
                    steps.store(1, SeqCst);
                }
                1 => {
                    move_dir(&away, &repo);
                    steps.store(2, SeqCst);
                }
                _ => {}
            })
        };
        let state = AppState::default();
        let rename =
            super::git_rename_branch_core(&state, repo.clone(), "src".into(), "dst".into());
        let renamed = GIT_SPAWN_LOG.scope(log, rename).await;
        assert_eq!(steps.load(SeqCst), 2, "fixture: away and back: {renamed:?}");
        assert!(
            matches!(
                renamed,
                Err(crate::error::AppError::Io(_) | crate::error::AppError::GitNotFound)
            ),
            "{renamed:?}"
        );
        assert!(branch_exists(&repo, "src").await);
        assert!(!branch_exists(&repo, "dst").await);
        let section = branch_section(&repo, "dst").await;
        assert!(section.contains("branch.dst.remote stale"), "{section}");
        assert!(
            section.contains("branch.dst.gitdesktoplocalonly true"),
            "{section}"
        );
    }

    /// A create drops a leftover section; with a true mark in it, the mark stays and the
    /// other keys are already gone when git runs (read from the cleanup hook).
    #[tokio::test]
    async fn a_create_drops_leftover_settings_and_keeps_a_true_mark() {
        use super::{TestHook, MINT_CLEANUP_HOOK};
        let (_g, _base, repo) = keep_local_repo("orphan-create").await;
        append_config(
            &repo,
            "[branch \"x\"]\n\tremote = stale\n\tmerge = refs/heads/gone\n\tgitdesktopArchived = true\n",
        );
        create_no_track(&repo, "x", None).await.unwrap();
        assert_eq!(branch_section(&repo, "x").await, "");
        append_config(
            &repo,
            "[branch \"y\"]\n\tremote = stale\n\tmerge = refs/heads/gone\n\tgitdesktopArchived = true\n\tgitdesktopLocalOnly = true\n",
        );
        let seen = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hook: TestHook = {
            let (repo, seen) = (repo.clone(), seen.clone());
            Arc::new(move || {
                let (repo, seen) = (repo.clone(), seen.clone());
                Box::pin(async move {
                    assert!(super::branch_keep_local(&repo, "y").await.unwrap());
                    assert!(!branch_exists(&repo, "y").await, "the hook runs before git");
                    for key in ["remote", "merge", "gitdesktopArchived"] {
                        let key = format!("branch.y.{key}");
                        assert!(!git_ok(&repo, &["config", "--get", &key]).await, "{key}");
                    }
                    seen.store(true, std::sync::atomic::Ordering::SeqCst);
                })
            })
        };
        MINT_CLEANUP_HOOK
            .scope(hook, create_no_track(&repo, "y", None))
            .await
            .unwrap();
        assert!(seen.load(std::sync::atomic::Ordering::SeqCst));
        assert!(branch_exists(&repo, "y").await);
        assert!(super::branch_keep_local(&repo, "y").await.unwrap());
        let section = branch_section(&repo, "y").await;
        assert_eq!(
            section.trim(),
            "branch.y.gitdesktoplocalonly true",
            "{section}"
        );
        // Restore's contract: a mark set before the create survives it, and a failed
        // create leaves the mark in place.
        super::set_branch_keep_local_core(&repo, "z", true)
            .await
            .unwrap();
        create_no_track(&repo, "z", None).await.unwrap();
        assert!(super::branch_keep_local(&repo, "z").await.unwrap());
        super::set_branch_keep_local_core(&repo, "w", true)
            .await
            .unwrap();
        assert!(create_no_track(&repo, "w", Some("no-such-start"))
            .await
            .is_err());
        assert!(!branch_exists(&repo, "w").await);
        assert!(super::branch_keep_local(&repo, "w").await.unwrap());
        // An existing ref is never touched, and an other-case section survives.
        run(&repo, &["branch", "exist"]).await;
        run(&repo, &["config", "branch.exist.remote", "keep"]).await;
        assert!(create_no_track(&repo, "exist", None).await.is_err());
        assert_eq!(
            run(&repo, &["config", "--get", "branch.exist.remote"]).await,
            "keep\n"
        );
        append_config(&repo, "[branch \"Q\"]\n\tremote = other\n");
        create_no_track(&repo, "q", None).await.unwrap();
        assert_eq!(
            run(&repo, &["config", "--get", "branch.Q.remote"]).await,
            "other\n"
        );
    }

    /// A create git refuses (its start point doesn't exist) puts back what its drop
    /// removed: a whole section, or a marked section's other keys beside the one mark.
    #[tokio::test]
    async fn a_refused_create_restores_the_dropped_leftover_settings() {
        let (_g, _base, repo) = keep_local_repo("orphan-create-refused").await;
        append_config(
            &repo,
            "[branch \"x\"]\n\tremote = stale\n\tmerge = refs/heads/gone\n",
        );
        let before = branch_section(&repo, "x").await;
        assert!(create_no_track(&repo, "x", Some("no-such-start"))
            .await
            .is_err());
        assert!(!branch_exists(&repo, "x").await);
        assert_eq!(branch_section(&repo, "x").await, before);
        let tracked = git_create_branch_core(
            &AppState::default(),
            repo.clone(),
            "x".into(),
            false,
            Some("no-such-start".into()),
            false,
        )
        .await;
        assert!(tracked.is_err());
        assert_eq!(branch_section(&repo, "x").await, before);
        append_config(
            &repo,
            "[branch \"m\"]\n\tremote = stale\n\tgitdesktopLocalOnly = true\n",
        );
        let sorted = |text: String| {
            let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
            lines.sort_unstable();
            lines
        };
        let before = sorted(branch_section(&repo, "m").await);
        assert!(create_no_track(&repo, "m", Some("no-such-start"))
            .await
            .is_err());
        assert_eq!(sorted(branch_section(&repo, "m").await), before);
    }

    /// A hand-capitalised `[Branch "<name>"]` header is no section `--remove-section`
    /// matches, so a rename or create onto the name unsets its keys one by one, alone or
    /// after removing a lowercase `[branch "<name>"]` beside it, and the minted branch
    /// keeps only its own settings.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_mint_unsets_a_capitalised_leftover_section() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        let (_g, _base, repo) = keep_local_repo("orphan-capitalised").await;
        run(&repo, &["branch", "old"]).await;
        run(&repo, &["config", "branch.old.remote", "origin"]).await;
        append_config(
            &repo,
            "[Branch \"dup\"]\n\tremote = stale\n\tpushRemote = fork\n",
        );
        git_rename_branch_core(
            &AppState::default(),
            repo.clone(),
            "old".into(),
            "dup".into(),
        )
        .await
        .unwrap();
        assert_eq!(
            run(&repo, &["config", "--get-all", "branch.dup.remote"]).await,
            "origin\n"
        );
        assert!(!git_ok(&repo, &["config", "--get", "branch.dup.pushRemote"]).await);
        append_config(&repo, "[Branch \"c\"]\n\tremote = stale\n");
        create_no_track(&repo, "c", None).await.unwrap();
        assert_eq!(branch_section(&repo, "c").await, "");

        run(&repo, &["branch", "src2"]).await;
        run(&repo, &["config", "branch.src2.remote", "origin"]).await;
        append_config(
            &repo,
            "[branch \"both\"]\n\tremote = stale\n[Branch \"both\"]\n\tremote = b\n\tpushRemote = fork\n\tmerge = refs/heads/old\n",
        );
        git_rename_branch_core(
            &AppState::default(),
            repo.clone(),
            "src2".into(),
            "both".into(),
        )
        .await
        .unwrap();
        assert_eq!(
            run(&repo, &["config", "--get-all", "branch.both.remote"]).await,
            "origin\n"
        );
        assert!(!git_ok(&repo, &["config", "--get", "branch.both.pushRemote"]).await);
        assert!(!git_ok(&repo, &["config", "--get", "branch.both.merge"]).await);
        append_config(
            &repo,
            "[branch \"pair\"]\n\tremote = stale\n[Branch \"pair\"]\n\tremote = b\n\tpushRemote = fork\n",
        );
        create_no_track(&repo, "pair", None).await.unwrap();
        assert_eq!(branch_section(&repo, "pair").await, "");
    }

    /// When the re-read after the cleanup fails, a create stops before git with the
    /// leftover settings put back, each record once, whichever header it sat under.
    #[tokio::test]
    async fn a_create_whose_reread_fails_keeps_the_leftover_settings() {
        use super::{SECTION_REREAD_FAILS, SECTION_REREAD_FAILURE};
        let (_g, _base, repo) = keep_local_repo("orphan-reread-fails").await;
        append_config(
            &repo,
            "[branch \"dst\"]\n\tremote = stale\n\tmerge = refs/heads/gone\n",
        );
        let before = branch_section(&repo, "dst").await;
        let created = SECTION_REREAD_FAILS
            .scope((), create_no_track(&repo, "dst", None))
            .await;
        assert!(!branch_exists(&repo, "dst").await, "{created:?}");
        assert!(
            matches!(&created, Err(AppError::Command(m)) if m == SECTION_REREAD_FAILURE),
            "{created:?}"
        );
        assert_eq!(branch_section(&repo, "dst").await, before);

        append_config(
            &repo,
            "[branch \"both\"]\n\tremote = a\n[Branch \"both\"]\n\tremote = b\n",
        );
        let created = SECTION_REREAD_FAILS
            .scope((), create_no_track(&repo, "both", None))
            .await;
        assert!(!branch_exists(&repo, "both").await, "{created:?}");
        assert!(
            matches!(&created, Err(AppError::Command(m)) if m == SECTION_REREAD_FAILURE),
            "{created:?}"
        );
        let remotes = run(&repo, &["config", "--get-all", "branch.both.remote"]).await;
        let mut remotes: Vec<&str> = remotes.lines().collect();
        remotes.sort_unstable();
        assert_eq!(remotes, ["a", "b"]);
    }

    /// Runs `run` under a [`GIT_SPAWN_LOG`] hook that holds `.git/config.lock` from the
    /// spawn of `config --local --unset-all <key>` until the first `config --local --add`,
    /// so that unset and its retry fail and the put-back writes; every argv goes to `seen`.
    async fn hold_config_lock_from_unset<T>(
        repo: &str,
        key: &str,
        seen: Arc<std::sync::Mutex<Vec<String>>>,
        run: impl std::future::Future<Output = T>,
    ) -> T {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        let step = Arc::new(AtomicUsize::new(0));
        let (repo, key) = (repo.to_string(), key.to_string());
        let hook = Arc::new(move |args: &[&str]| {
            seen.lock().unwrap().push(args.join(" "));
            let unset = ["config", "--local", "--unset-all", key.as_str()];
            if step.load(SeqCst) == 0 && args == unset {
                hold_config_lock(&repo);
                step.store(1, SeqCst);
            } else if step.load(SeqCst) == 1 && args.starts_with(&["config", "--local", "--add"]) {
                let lock = std::path::Path::new(&repo).join(".git").join("config.lock");
                std::fs::remove_file(lock).expect("the held config.lock");
                step.store(2, SeqCst);
            }
        });
        GIT_SPAWN_LOG.scope(hook, run).await
    }

    /// A marked create whose unsets stop part way, with its re-read failing too, puts
    /// back the records those unsets removed beside the mark they never touch.
    #[tokio::test]
    async fn a_part_way_marked_leftover_unset_with_a_failed_reread_restores_it() {
        use super::SECTION_REREAD_FAILS;
        let (_g, _base, repo) = keep_local_repo("orphan-marked-part-way").await;
        append_config(
            &repo,
            "[branch \"m\"]\n\tremote = stale\n\tmerge = refs/heads/gone\n\tgitdesktopLocalOnly = true\n",
        );
        let sorted = |text: String| {
            let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
            lines.sort_unstable();
            lines
        };
        let before = sorted(branch_section(&repo, "m").await);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let create = SECTION_REREAD_FAILS.scope((), create_no_track(&repo, "m", None));
        let created =
            hold_config_lock_from_unset(&repo, "branch.m.merge", seen.clone(), create).await;
        assert!(
            matches!(&created, Err(AppError::Command(m)) if m == BUSY_CREATE),
            "{created:?}"
        );
        assert!(!branch_exists(&repo, "m").await);
        assert_eq!(sorted(branch_section(&repo, "m").await), before);
        assert!(super::branch_keep_local(&repo, "m").await.unwrap());
        let seen = seen.lock().unwrap().clone();
        let lists = seen.iter().filter(|argv| *argv == LOCAL_LIST).count();
        assert_eq!(lists, 1, "the seam answered the re-read: {seen:#?}");
        let at = |argv: &str| seen.iter().position(|seen| seen == argv);
        let remote_unset = at("config --local --unset-all branch.m.remote");
        let merge_unset = "config --local --unset-all branch.m.merge";
        assert!(
            remote_unset.is_some() && remote_unset < at(merge_unset),
            "{seen:#?}"
        );
        let merge_unsets = seen.iter().filter(|argv| *argv == merge_unset).count();
        assert_eq!(merge_unsets, 2, "{seen:#?}");
        let added = seen
            .iter()
            .any(|argv| argv.starts_with("config --local --add "));
        assert!(added, "{seen:#?}");
    }

    /// An unmarked create whose unsets stop part way after its section removal, with its
    /// re-read failing too, puts back every record the removal and the unsets took.
    #[tokio::test]
    async fn a_part_way_leftover_unset_after_a_section_removal_restores_every_record() {
        use super::SECTION_REREAD_FAILS;
        let (_g, _base, repo) = keep_local_repo("orphan-removed-part-way").await;
        append_config(
            &repo,
            "[branch \"u\"]\n\tremote = stale\n\tmerge = refs/heads/gone\n",
        );
        let before = branch_section(&repo, "u").await;
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let create = SECTION_REREAD_FAILS.scope((), create_no_track(&repo, "u", None));
        let created =
            hold_config_lock_from_unset(&repo, "branch.u.merge", seen.clone(), create).await;
        assert!(
            matches!(&created, Err(AppError::Command(m)) if m == BUSY_CREATE),
            "{created:?}"
        );
        assert!(!branch_exists(&repo, "u").await);
        assert_eq!(branch_section(&repo, "u").await, before);
        let seen = seen.lock().unwrap().clone();
        let lists = seen.iter().filter(|argv| *argv == LOCAL_LIST).count();
        assert_eq!(lists, 1, "the seam answered the re-read: {seen:#?}");
        let at = |argv: &str| seen.iter().position(|seen| seen == argv);
        let removal = at("config --remove-section branch.u");
        let remote_unset = at("config --local --unset-all branch.u.remote");
        let merge_unset = "config --local --unset-all branch.u.merge";
        assert!(
            removal.is_some() && removal < remote_unset && remote_unset < at(merge_unset),
            "{seen:#?}"
        );
        let merge_unsets = seen.iter().filter(|argv| *argv == merge_unset).count();
        assert_eq!(merge_unsets, 2, "{seen:#?}");
    }

    /// The drop's listing argv, which the re-read spawns too.
    const LOCAL_LIST: &str = "config --local --null --list";
    const BUSY_CREATE: &str = "Another Git process was saving this repository's settings, so the branch wasn't created — try again.";

    /// A key the re-read lists again after its unset answered stops a create as busy, and
    /// the put-back leaves the newer value alone rather than adding the old one after it.
    #[tokio::test]
    async fn a_key_listed_again_after_the_unsets_stops_the_create_as_busy() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        let (_g, _base, repo) = keep_local_repo("orphan-listed-again").await;
        append_config(&repo, "[branch \"l\"]\n\tremote = stale\n");
        let lists = Arc::new(AtomicUsize::new(0));
        let hook = {
            let (repo, lists) = (repo.clone(), lists.clone());
            Arc::new(move |args: &[&str]| {
                let list = ["config", "--local", "--null", "--list"];
                if args == list && lists.fetch_add(1, SeqCst) == 1 {
                    append_config(&repo, "[branch \"l\"]\n\tremote = late\n");
                }
            })
        };
        let created = GIT_SPAWN_LOG
            .scope(hook, create_no_track(&repo, "l", None))
            .await;
        // The drop's listing, its re-read and the put-back's read.
        assert_eq!(lists.load(SeqCst), 3, "{created:?}");
        assert!(matches!(created, Err(AppError::Busy { .. })), "{created:?}");
        assert!(!branch_exists(&repo, "l").await);
        assert_eq!(
            run(&repo, &["config", "--get-all", "branch.l.remote"]).await,
            "late\n"
        );
        assert_eq!(
            run(&repo, &["config", "--get", "branch.l.remote"]).await,
            "late\n"
        );
    }

    /// A value written between a refused create's drop and its put-back stays the only
    /// one for its key, while a key nobody wrote again still comes back.
    #[tokio::test]
    async fn a_refused_create_keeps_a_value_written_after_its_drop() {
        use super::{TestHook, MINT_CLEANUP_HOOK};
        let (_g, _base, repo) = keep_local_repo("orphan-create-late").await;
        append_config(
            &repo,
            "[branch \"x\"]\n\tremote = stale\n\tmerge = refs/heads/gone\n",
        );
        let hook: TestHook = {
            let repo = repo.clone();
            Arc::new(move || {
                let repo = repo.clone();
                Box::pin(async move {
                    run(&repo, &["config", "branch.x.remote", "late"]).await;
                })
            })
        };
        let created = MINT_CLEANUP_HOOK
            .scope(hook, create_no_track(&repo, "x", Some("no-such-start")))
            .await;
        assert!(created.is_err());
        assert!(!branch_exists(&repo, "x").await);
        assert_eq!(
            run(&repo, &["config", "--get-all", "branch.x.remote"]).await,
            "late\n"
        );
        assert_eq!(
            run(&repo, &["config", "--get", "branch.x.merge"]).await,
            "refs/heads/gone\n"
        );
    }

    /// Runs a create of `name` over `config` whose section removal answers and whose unset
    /// of `branch.<name>.remote` loses the config lock, and answers the `--add`s it spawned
    /// beside that key's `--get-all` and `--get`; the lock comes off at the first `--add`,
    /// else after the create.
    async fn create_with_a_failed_remote_unset(
        repo_name: &str,
        name: &str,
        config: &str,
    ) -> (Vec<String>, String, String) {
        let (_g, _base, repo) = keep_local_repo(repo_name).await;
        append_config(&repo, config);
        let key = format!("branch.{name}.remote");
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let create = create_no_track(&repo, name, None);
        let created = hold_config_lock_from_unset(&repo, &key, seen.clone(), create).await;
        assert!(
            matches!(&created, Err(AppError::Command(m)) if m == BUSY_CREATE),
            "{created:?}"
        );
        assert!(!branch_exists(&repo, name).await);
        let seen = seen.lock().unwrap().clone();
        let removal = format!("config --remove-section branch.{name}");
        assert!(seen.contains(&removal), "{seen:#?}");
        let adds: Vec<String> = seen
            .into_iter()
            .filter(|argv| argv.starts_with("config --local --add "))
            .collect();
        let lock = std::path::Path::new(&repo).join(".git").join("config.lock");
        if adds.is_empty() {
            std::fs::remove_file(lock).expect("the held config.lock");
        }
        let all = run(&repo, &["config", "--get-all", &key]).await;
        let get = run(&repo, &["config", "--get", &key]).await;
        (adds, all, get)
    }

    /// A survivor under a capitalised header that is not the key's original last value
    /// gets the dropped last value back after it.
    #[tokio::test]
    async fn a_failed_unset_puts_back_the_last_value_after_an_earlier_survivor() {
        let config = "[Branch \"n\"]\n\tremote = b\n[branch \"n\"]\n\tremote = a\n";
        let (adds, all, get) =
            create_with_a_failed_remote_unset("orphan-survivor-first", "n", config).await;
        assert_eq!(adds, ["config --local --add branch.n.remote a"]);
        assert_eq!((all.as_str(), get.as_str()), ("b\na\n", "a\n"));
    }

    /// A survivor under a capitalised header that is the key's original last value keeps
    /// the effective value, and nothing is added after it.
    #[tokio::test]
    async fn a_failed_unset_adds_nothing_after_a_surviving_last_value() {
        let config = "[branch \"n\"]\n\tremote = a\n[Branch \"n\"]\n\tremote = b\n";
        let (adds, all, get) =
            create_with_a_failed_remote_unset("orphan-survivor-last", "n", config).await;
        assert!(adds.is_empty(), "{adds:#?}");
        assert_eq!((all.as_str(), get.as_str()), ("b\n", "b\n"));
    }

    /// A value the drop took from one header while a survivor under the other repeats it
    /// still comes back, so the key's original last value goes back last.
    #[tokio::test]
    async fn a_failed_unset_puts_back_a_value_a_survivor_repeats() {
        let config = concat!(
            "[branch \"n\"]\n\tremote = a\n",
            "[Branch \"n\"]\n\tremote = b\n\tremote = c\n",
            "[branch \"n\"]\n\tremote = b\n",
        );
        let (adds, all, get) =
            create_with_a_failed_remote_unset("orphan-survivor-repeat", "n", config).await;
        let add = |value: &str| format!("config --local --add branch.n.remote {value}");
        assert_eq!(adds, [add("a"), add("b")]);
        assert_eq!((all.as_str(), get.as_str()), ("b\nc\na\nb\n", "b\n"));
    }

    /// The put-back rule per key, values compared with their multiplicity: a survivor the
    /// drop left strikes no dropped record, a value-less record equals only another, and
    /// the adds keep `dropped` order across keys.
    #[test]
    fn the_put_back_rule_tells_survivors_from_other_writers() {
        // Records separated by spaces: `v` is `remote = v`, `k:v` is `k = v`, and `~` is a
        // value-less `remote`.
        let records = |text: &str| -> Vec<(String, Option<String>)> {
            let remote = "branch.n.remote".to_string();
            text.split_whitespace()
                .map(|record| match (record, record.split_once(':')) {
                    ("~", _) => (remote.clone(), None),
                    (_, Some((key, value))) => (format!("branch.n.{key}"), Some(value.into())),
                    (_, None) => (remote.clone(), Some(record.into())),
                })
                .collect()
        };
        // (before, now, dropped, wanted adds)
        let rows: [(&str, &str, &str, &str); 16] = [
            ("b a", "b", "a", "a"),
            ("a b", "b", "a", ""),
            ("a b c b", "b c", "a b", "a b"),
            ("x w x", "x w", "x", "x"),
            ("a b a", "a b", "a", "a"),
            ("b a", "b", "b a", "a"),
            ("z w y z", "z w", "z w y z", "y z"),
            ("z w y z", "z w", "y z", "y z"),
            ("stale", "late", "stale", ""),
            ("x", "x x", "x", ""),
            ("a b", "a a", "b", ""),
            ("a", "", "a", "a"),
            ("~", "true", "~", ""),
            ("true", "~", "true", ""),
            ("~ a", "~", "~ a", "a"),
            ("a m:x p:y b", "m:late", "a m:x p:y b", "a p:y b"),
        ];
        let mut wrong = Vec::new();
        for (before, now, dropped, want) in rows {
            let (before_records, now_records) = (records(before), records(now));
            let got = super::records_to_put_back(&before_records, &now_records, &records(dropped));
            if got != records(want) {
                wrong.push((before, now, dropped, got));
            }
        }
        assert!(wrong.is_empty(), "wrong answers: {wrong:?}");
    }

    /// A marked create whose unsets all answer still mints when its re-read fails,
    /// keeping the mark and dropping the other leftover key.
    #[tokio::test]
    async fn a_marked_create_with_a_failed_reread_still_mints() {
        use super::SECTION_REREAD_FAILS;
        let (_g, _base, repo) = keep_local_repo("orphan-marked-reread").await;
        append_config(
            &repo,
            "[branch \"k\"]\n\tremote = stale\n\tgitdesktopLocalOnly = true\n",
        );
        let created = SECTION_REREAD_FAILS
            .scope((), create_no_track(&repo, "k", None))
            .await;
        assert!(created.is_ok(), "{created:?}");
        assert!(branch_exists(&repo, "k").await);
        assert!(super::branch_keep_local(&repo, "k").await.unwrap());
        assert!(!git_ok(&repo, &["config", "--get", "branch.k.remote"]).await);
    }

    /// A section removal that loses the config lock stops a rename with the busy refusal,
    /// the leftover section as it was and nothing renamed.
    #[tokio::test]
    async fn a_rename_whose_section_removal_loses_the_config_lock_answers_busy() {
        use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
        const BUSY_RENAME: &str = "Another Git process was saving this repository's settings, so the branch wasn't renamed — try again.";
        const REMOVAL: &str = "config --remove-section branch.dst";
        let (_g, _base, repo) = keep_local_repo("orphan-removal-busy").await;
        run(&repo, &["branch", "src"]).await;
        append_config(
            &repo,
            "[branch \"dst\"]\n\tremote = stale\n\tmerge = refs/heads/gone\n",
        );
        let before = branch_section(&repo, "dst").await;
        let spawned = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let held = Arc::new(AtomicBool::new(false));
        let hook = {
            let (repo, spawned, held) = (repo.clone(), spawned.clone(), held.clone());
            Arc::new(move |args: &[&str]| {
                let argv = args.join(" ");
                if argv == REMOVAL && !held.swap(true, SeqCst) {
                    hold_config_lock(&repo);
                }
                spawned.lock().unwrap().push(argv);
            })
        };
        let renamed = GIT_SPAWN_LOG
            .scope(
                hook,
                git_rename_branch_core(
                    &AppState::default(),
                    repo.clone(),
                    "src".into(),
                    "dst".into(),
                ),
            )
            .await;
        let lock = std::path::Path::new(&repo).join(".git").join("config.lock");
        let was_held = lock.exists();
        if was_held {
            std::fs::remove_file(&lock).expect("the held config.lock");
        }
        let refused = renamed.err();
        let spawned = spawned.lock().unwrap().clone();
        assert!(was_held, "{refused:?} {spawned:#?}");
        assert!(
            matches!(&refused, Some(AppError::Command(m)) if m == BUSY_RENAME),
            "{refused:?}"
        );
        let removals = spawned.iter().filter(|argv| *argv == REMOVAL).count();
        assert_eq!(removals, 2, "the removal and its retry: {spawned:#?}");
        assert_eq!(spawned.last().map(String::as_str), Some(REMOVAL));
        assert_eq!(branch_section(&repo, "dst").await, before);
        assert!(branch_exists(&repo, "src").await);
        assert!(!branch_exists(&repo, "dst").await);
    }

    /// A section removal that fails for a reason other than the config lock answers git's
    /// own failure.
    #[tokio::test]
    async fn a_section_removal_failing_otherwise_answers_gits_failure() {
        let (_g, _base, repo) = keep_local_repo("orphan-removal-broken").await;
        append_config(&repo, "[branch \"b\"]\n\tremote = stale\n");
        let config = std::path::Path::new(&repo).join(".git").join("config");
        let bytes = std::fs::read(&config).unwrap();
        let hook = {
            let repo = repo.clone();
            Arc::new(move |args: &[&str]| {
                if args == ["config", "--remove-section", "branch.b"] {
                    append_config(&repo, "[broken\n");
                }
            })
        };
        let created = GIT_SPAWN_LOG
            .scope(hook, create_no_track(&repo, "b", None))
            .await;
        // The refused removal changed nothing: only the broken line follows the saved bytes.
        let after = std::fs::read(&config).unwrap();
        std::fs::write(&config, &bytes).unwrap();
        assert!(matches!(&created, Err(AppError::Git { .. })), "{created:?}");
        assert!(
            after.starts_with(&bytes),
            "{}",
            String::from_utf8_lossy(&after)
        );
        assert_eq!(&after[bytes.len()..], b"[broken\n");
        assert!(!branch_exists(&repo, "b").await);
    }

    #[test]
    fn records_gone_counts_each_listing() {
        let rec = |key: &str, value: Option<&str>| (key.to_string(), value.map(str::to_string));
        let before = [
            rec("branch.x.remote", Some("a")),
            rec("branch.x.remote", Some("a")),
            rec("branch.x.flag", None),
        ];
        assert_eq!(
            super::records_gone(&before, &[rec("branch.x.remote", Some("a"))]),
            [
                rec("branch.x.remote", Some("a")),
                rec("branch.x.flag", None)
            ]
        );
        assert!(super::records_gone(&before, &before).is_empty());
    }

    #[test]
    fn branch_section_keys_reads_exact_subsections() {
        use super::branch_section_keys;
        let listed = "branch.feat.v2.remote\norigin\0branch.feat.v2.flag\0branch.X.remote\nother\0\
                      branch.x.merge\nrefs/heads/x\0core.bare\nfalse\0branch.x.merge\nrefs/heads/y\0";
        assert_eq!(
            branch_section_keys(listed, "feat.v2"),
            ["branch.feat.v2.remote", "branch.feat.v2.flag"]
        );
        assert_eq!(branch_section_keys(listed, "x"), ["branch.x.merge"]);
        assert_eq!(branch_section_keys(listed, "X"), ["branch.X.remote"]);
        assert!(branch_section_keys("", "x").is_empty());
    }

    // Full decision table for the create-branch argv: checkout × start_point ×
    // no_track (8 cases). The no_track=false rows are a regression guard — their argv
    // must not change.
    #[test]
    fn build_create_branch_args_checkout_no_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", true, None, false),
            vec!["switch", "-c", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_checkout_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", true, Some("main"), false),
            vec!["switch", "-c", "feat", "main"]
        );
    }

    #[test]
    fn build_create_branch_args_checkout_no_start_track_off() {
        assert_eq!(
            build_create_branch_args("feat", true, None, true),
            vec!["switch", "--no-track", "-c", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_checkout_remote_start_track_off() {
        // The motivating case: `git switch --no-track -c feat origin/epic/x`.
        assert_eq!(
            build_create_branch_args("feat", true, Some("origin/epic/x"), true),
            vec!["switch", "--no-track", "-c", "feat", "origin/epic/x"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_no_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", false, None, false),
            vec!["branch", "--", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", false, Some("main"), false),
            vec!["branch", "--", "feat", "main"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_no_start_track_off() {
        // `--no-track` must come BEFORE the `--`.
        assert_eq!(
            build_create_branch_args("feat", false, None, true),
            vec!["branch", "--no-track", "--", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_remote_start_track_off() {
        assert_eq!(
            build_create_branch_args("feat", false, Some("origin/epic/x"), true),
            vec!["branch", "--no-track", "--", "feat", "origin/epic/x"]
        );
    }

    #[tokio::test]
    async fn create_branch_refuses_session_branch_name_any_case() {
        for checkout in [false, true] {
            let (_base, base) = temp_base("create-session-branch-name");
            let repo = base.to_string_lossy().into_owned();
            init_repo(&repo, "r.txt").await;
            let before = run(&repo, &["for-each-ref", "refs/heads"]).await;
            let result = git_create_branch_core(
                &AppState::default(),
                repo.clone(),
                "GD/Session/x".into(),
                checkout,
                None,
                false,
            )
            .await;
            assert!(
                matches!(&result, Err(AppError::InvalidArgument(message)) if message ==
                    "\"GD/Session/x\" is in gd/session/, which is reserved for agent sessions — choose another name."),
                "{result:?}"
            );
            assert_eq!(run(&repo, &["for-each-ref", "refs/heads"]).await, before);
        }
    }

    #[tokio::test]
    async fn checkout_refuses_a_case_alias_of_a_session_branch_name() {
        let (_base, base) = temp_base("checkout-session-case-alias");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["update-ref", "refs/heads/gd/session/x", "HEAD"]).await;
        let head = run(&repo, &["symbolic-ref", "HEAD"]).await;
        // On a case-sensitive filesystem this is a passing control.
        let result = super::git_checkout_branch_core(
            &AppState::default(),
            repo.clone(),
            "GD/Session/x".into(),
        )
        .await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(message)) if message ==
                "\"GD/Session/x\" is in gd/session/, which is reserved for agent sessions — choose another name."),
            "expected session branch refusal, got {result:?}"
        );
        assert_eq!(run(&repo, &["symbolic-ref", "HEAD"]).await, head);
    }

    #[tokio::test]
    async fn checkout_switches_to_an_existing_session_branch_any_case() {
        for packed in [false, true] {
            let (_base, base) = temp_base("checkout-existing-session-branch");
            let repo = base.to_string_lossy().into_owned();
            init_repo(&repo, "r.txt").await;
            run(&repo, &["update-ref", "refs/heads/GD/Session/x", "HEAD"]).await;
            if packed {
                run(&repo, &["pack-refs", "--all"]).await;
            }
            super::git_checkout_branch_core(
                &AppState::default(),
                repo.clone(),
                "GD/Session/x".into(),
            )
            .await
            .expect("existing session branch remains reachable");
            assert_eq!(
                run(&repo, &["symbolic-ref", "HEAD"]).await.trim(),
                "refs/heads/GD/Session/x"
            );
        }
    }

    #[tokio::test]
    async fn checkout_refuses_guessing_a_session_branch_name_any_case() {
        let (_base, base) = temp_base("checkout-guess-session-branch-name");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["remote", "add", "origin", &repo]).await;
        run(&repo, &["update-ref", "refs/remotes/origin/GD/Session/x", "HEAD"]).await;
        let head = run(&repo, &["symbolic-ref", "HEAD"]).await;
        assert!(run(&repo, &["for-each-ref", "refs/heads/GD/Session/x"])
            .await
            .is_empty());
        let result = super::git_checkout_branch_core(
            &AppState::default(),
            repo.clone(),
            "GD/Session/x".into(),
        )
        .await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(message)) if message ==
                "\"GD/Session/x\" is in gd/session/, which is reserved for agent sessions — choose another name."),
            "expected session branch refusal, got {result:?}"
        );
        assert!(run(&repo, &["for-each-ref", "refs/heads/GD/Session/x"])
            .await
            .is_empty());
        assert_eq!(run(&repo, &["symbolic-ref", "HEAD"]).await, head);
    }

    #[tokio::test]
    async fn checkout_remote_refuses_session_branch_name_any_case() {
        let (_base, base) = temp_base("checkout-session-branch-name");
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["remote", "add", "origin", &repo]).await;
        run(&repo, &["update-ref", "refs/remotes/origin/GD/Session/x", "HEAD"]).await;
        let head = run(&repo, &["symbolic-ref", "HEAD"]).await;
        let refs = run(&repo, &["for-each-ref", "refs/heads"]).await;
        let result = git_checkout_remote_branch_core(
            &AppState::default(),
            repo.clone(),
            "origin".into(),
            "GD/Session/x".into(),
        )
        .await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(message)) if message ==
                "\"GD/Session/x\" is in gd/session/, which is reserved for agent sessions — choose another name."),
            "{result:?}"
        );
        assert_eq!(run(&repo, &["symbolic-ref", "HEAD"]).await, head);
        assert_eq!(run(&repo, &["for-each-ref", "refs/heads"]).await, refs);
    }

    /// Drives `git_create_branch_core` against a real repo to prove git honors the
    /// `--no-track` placement the argv table pins. Synthesizes a remote-tracking ref
    /// (`refs/remotes/origin/x` via `update-ref`, so nothing is ever fetched) and bases
    /// two branches on it: the `no_track=true` arm must have NO upstream, the control
    /// arm must track `origin/x`. Both use `checkout=false` to keep assertions simple —
    /// the checkout arm shares the same `--no-track` placement per the argv table.
    #[tokio::test]
    async fn create_branch_honors_no_track_against_real_repo() {
        let (_base, base) = temp_base("no-track");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        // A remote named `origin` (URL is the repo's own path — never fetched) and
        // a synthetic remote-tracking ref pointing at HEAD.
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/x", "HEAD"]).await;

        let state = AppState::default();

        // no-track arm: branch `y` from `origin/x` with tracking suppressed.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "y".into(),
            false,
            Some("origin/x".into()),
            true,
        )
        .await
        .expect("create y succeeds");
        // No upstream → `y@{upstream}` fails to resolve.
        assert!(
            run_git(
                Some(&repo_s),
                &["rev-parse", "--abbrev-ref", "y@{upstream}"],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .is_err(),
            "no-track branch y must have no upstream"
        );
        // But it still starts at origin/x's tip.
        assert_eq!(
            run(&repo_s, &["rev-parse", "y"]).await.trim(),
            run(&repo_s, &["rev-parse", "origin/x"]).await.trim(),
            "y should start at origin/x"
        );

        // Pin the tracking mode repo-locally: an ambient global
        // `branch.autoSetupMerge = simple|false` leaves `z` untracked and false-fails
        // this control arm. The `--no-track` arm is immune — the flag overrides config.
        run(&repo_s, &["config", "branch.autoSetupMerge", "true"]).await;

        // control arm: branch `z` from `origin/x` with tracking left on.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "z".into(),
            false,
            Some("origin/x".into()),
            false,
        )
        .await
        .expect("create z succeeds");
        // Upstream resolves and IS origin/x.
        assert_eq!(
            run(&repo_s, &["rev-parse", "--abbrev-ref", "z@{upstream}"])
                .await
                .trim(),
            "origin/x",
            "z should track origin/x"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "z"]).await.trim(),
            run(&repo_s, &["rev-parse", "origin/x"]).await.trim(),
            "z should start at origin/x"
        );

        // A remote-tracking start point spelled as its full ref keeps the short form's
        // tip and tracking, and a LOCAL branch literally named `origin/x` can't
        // capture it.
        std::fs::write(repo.join("r.txt"), "moved\n").unwrap();
        run(&repo_s, &["commit", "-qam", "local work"]).await;
        run(&repo_s, &["branch", "origin/x"]).await;
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "w".into(),
            false,
            Some("refs/remotes/origin/x".into()),
            false,
        )
        .await
        .expect("create w succeeds");
        assert_eq!(
            run(
                &repo_s,
                &["rev-parse", "--symbolic-full-name", "w@{upstream}"]
            )
            .await
            .trim(),
            "refs/remotes/origin/x",
            "w should track origin/x"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/w"]).await,
            run(&repo_s, &["rev-parse", "refs/remotes/origin/x"]).await,
            "w should start at the remote-tracking ref, not the local origin/x"
        );

        // The local twin: `refs/heads/...` reads the branch even where a same-named
        // tag on another commit captures the short form.
        run(&repo_s, &["tag", "origin/x", "refs/remotes/origin/x"]).await;
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "v".into(),
            false,
            Some("refs/heads/origin/x".into()),
            false,
        )
        .await
        .expect("create v succeeds");
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/v"]).await,
            run(&repo_s, &["rev-parse", "refs/heads/origin/x"]).await,
            "v should start at the local branch, not the tag"
        );
        assert_ne!(
            run(&repo_s, &["rev-parse", "refs/heads/v"]).await,
            run(&repo_s, &["rev-parse", "refs/tags/origin/x"]).await,
            "fixture sanity: the tag sits on another commit"
        );
    }

    /// The tracking checkout starts from the remote-tracking ref itself: a tag named
    /// `origin/<branch>` makes the bare `origin/<branch>` ambiguous, and git refuses it.
    #[tokio::test]
    async fn checkout_remote_branch_tracks_the_remote_ref_shadowed_by_a_tag() {
        let (_base, base) = temp_base("checkout-remote-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        // The tag sits on the seed commit, the remote branch one commit past it.
        run(&repo_s, &["tag", "origin/landing"]).await;
        std::fs::write(repo.join("r.txt"), "remote\n").unwrap();
        run(&repo_s, &["commit", "-qam", "remote work"]).await;
        run(
            &repo_s,
            &["update-ref", "refs/remotes/origin/landing", "HEAD"],
        )
        .await;
        run(&repo_s, &["reset", "-q", "--hard", "HEAD~1"]).await;

        let state = AppState::default();
        git_checkout_remote_branch_core(&state, repo_s.clone(), "origin".into(), "landing".into())
            .await
            .expect("the tracking checkout succeeds");
        assert_eq!(
            run(&repo_s, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/landing"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/landing"]).await,
            run(&repo_s, &["rev-parse", "refs/remotes/origin/landing"]).await,
            "the branch starts at the remote ref, never the tag"
        );
        assert_eq!(
            tracking_of(&repo_s, "landing").await,
            (Some("origin".into()), Some("refs/heads/landing".into()))
        );
    }

    /// A plain switch in a linked worktree queues on the config-write mutex (held here
    /// through the main checkout, which shares it) with HEAD unmoved, then lands.
    #[tokio::test]
    async fn checkout_waits_on_the_config_mutex_before_moving_head() {
        let (g, repo, _feat, _head) = delete_fixture("switch-mutex").await;
        let wt = g.path().join("wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt]).await;
        let (holder, release) = hold_config_mutex(&repo).await;

        let (events, waiting) = on_first_waiting();
        let switch = tokio::spawn({
            let wt = wt.clone();
            CONFIG_WRITE_LOCK_EVENTS.scope(events, async move {
                super::git_checkout_branch_core(&AppState::default(), wt, "feat".into()).await
            })
        });
        waiting.await.expect("the switch reached the mutex");
        assert_eq!(
            symbolic_head(&wt).await,
            None,
            "HEAD moved before the mutex"
        );
        release.send(()).unwrap();
        holder.await.unwrap();

        tokio::time::timeout(TEST_GIT_HANG_GUARD, switch)
            .await
            .expect("the switch finishes once released")
            .unwrap()
            .unwrap();
        assert_eq!(symbolic_head(&wt).await.as_deref(), Some("refs/heads/feat"));
    }

    /// A switch onto the branch a delete is parked on (inside the mutex) waits for the
    /// delete, then fails on the missing name, leaving its checkout where it was.
    #[tokio::test]
    async fn checkout_queued_behind_a_parked_delete_finds_the_branch_gone() {
        let (g, repo, feat, _head) = delete_fixture("switch-behind-delete").await;
        let wt = g.path().join("wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt]).await;
        let wt_head = full_ref_tip(&wt, "HEAD").await;
        let state = Arc::new(AppState::default());

        let (parked_tx, parked_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let slots = Arc::new(std::sync::Mutex::new((Some(parked_tx), Some(release_rx))));
        let hook: DeletePhaseHook = Arc::new(move |phase| {
            let slots = Arc::clone(&slots);
            Box::pin(async move {
                if phase != DeletePhase::BeforeDelete {
                    return;
                }
                let (parked, release) = {
                    let mut slots = slots.lock().unwrap();
                    (slots.0.take(), slots.1.take())
                };
                if let (Some(parked), Some(release)) = (parked, release) {
                    let _ = parked.send(());
                    let _ = release.await;
                }
            })
        });
        let deleter = tokio::spawn({
            let (state, repo) = (Arc::clone(&state), repo.clone());
            DELETE_PHASE_HOOK.scope(
                hook,
                async move { delete(&state, &repo, "feat", None).await },
            )
        });
        parked_rx.await.expect("the delete parked inside the mutex");

        let (events, waiting) = on_first_waiting();
        let switch = tokio::spawn({
            let (state, wt) = (Arc::clone(&state), wt.clone());
            CONFIG_WRITE_LOCK_EVENTS.scope(events, async move {
                super::git_checkout_branch_core(&state, wt, "feat".into()).await
            })
        });
        waiting.await.expect("the switch queued behind the delete");
        release_tx.send(()).unwrap();

        assert_eq!(
            deleter.await.unwrap().unwrap(),
            DeleteBranchOutcome::Deleted {
                tip: feat,
                kept_local: true,
                upstream: None,
            }
        );
        let err = tokio::time::timeout(TEST_GIT_HANG_GUARD, switch)
            .await
            .expect("the switch finishes once the delete does")
            .unwrap()
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Git { stderr, .. } if stderr.contains("invalid reference: feat")),
            "{err:?}"
        );
        assert_eq!(full_ref_tip(&wt, "HEAD").await, wt_head);
        assert!(wt_head.is_some());
    }

    /// A switch refused over local changes keeps git's stderr, which the frontend
    /// matches on. git reports this on stderr alone, so no control can tell stderr
    /// from the combined text here.
    #[tokio::test]
    async fn checkout_refused_over_local_changes_keeps_git_stderr() {
        let (_g, repo, _feat, _head) = delete_fixture("switch-dirty").await;
        std::fs::write(std::path::Path::new(&repo).join("a.txt"), "dirty\n").unwrap();
        let err =
            super::git_checkout_branch_core(&AppState::default(), repo.clone(), "feat".into())
                .await
                .unwrap_err();
        assert!(
            matches!(&err, AppError::Git { stderr, .. }
                if stderr.contains("would be overwritten by checkout")),
            "{err:?}"
        );
    }

    /// How a test stores the twin `feat`.
    #[derive(Clone, Copy, Debug)]
    enum TwinStorage {
        PackedOnly,
        Loose,
        LooseAndPacked,
    }

    /// A repository on the files backend holding `feat` stored as `storage`, and the
    /// alias oracle's verdict.
    async fn case_twin_fixture(
        tag: &str,
        storage: TwinStorage,
    ) -> (tempfile::TempDir, String, bool) {
        let (g, base) = temp_base(tag);
        let base = base.join("repo");
        std::fs::create_dir_all(&base).unwrap();
        let repo = base.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["branch", "feat"]).await;
        match storage {
            TwinStorage::PackedOnly => {
                run(&repo, &["pack-refs", "--all"]).await;
            }
            TwinStorage::Loose => {}
            TwinStorage::LooseAndPacked => {
                run(&repo, &["pack-refs", "--all"]).await;
                // A moved tip, since git skips writing a loose ref that already has its value.
                commit_file(&repo, "s.txt", "second\n").await;
                run(&repo, &["update-ref", "refs/heads/feat", "HEAD"]).await;
                let loose = base.join(".git").join("refs").join("heads").join("feat");
                assert!(loose.is_file(), "fixture sanity: feat is loose too");
            }
        }
        let aliases = case_twin_alias_oracle(&repo).await;
        (g, repo, aliases)
    }

    /// Creating `Feat` beside `feat` in each `(checkout, no_track)` arm: refused before git
    /// where refs alias, leaving HEAD, the branches and the config as they were; created
    /// beside `feat` where they don't.
    async fn create_beside_case_twin(storage: TwinStorage) {
        for (checkout, no_track) in [(false, false), (false, true), (true, false), (true, true)] {
            let (_g, repo, aliases) = case_twin_fixture("create-case-twin", storage).await;
            let before = case_twin_snapshot(&repo).await;
            let row = format!("{storage:?} checkout={checkout} no_track={no_track}");
            let result = git_create_branch_core(
                &AppState::default(),
                repo.clone(),
                "Feat".into(),
                checkout,
                None,
                no_track,
            )
            .await;
            let listed = case_twin_listed(&repo).await;
            if aliases {
                assert!(
                    matches!(&result, Err(AppError::Command(m)) if m == NEW_NAME_TWIN_REFUSAL),
                    "{row}: {result:?}"
                );
                assert!(!listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert!(listed.iter().any(|b| b == "feat"), "{row}: {listed:?}");
                assert_eq!(case_twin_snapshot(&repo).await, before, "{row}");
            } else {
                result.unwrap_or_else(|e| panic!("{row}: {e:?}"));
                assert!(listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert!(listed.iter().any(|b| b == "feat"), "{row}: {listed:?}");
            }
        }
    }

    #[tokio::test]
    async fn create_refuses_a_case_twin_of_a_packed_only_branch() {
        create_beside_case_twin(TwinStorage::PackedOnly).await;
    }

    #[tokio::test]
    async fn create_refuses_a_case_twin_of_a_loose_branch() {
        create_beside_case_twin(TwinStorage::Loose).await;
    }

    #[tokio::test]
    async fn create_refuses_a_case_twin_of_a_loose_and_packed_branch() {
        create_beside_case_twin(TwinStorage::LooseAndPacked).await;
    }

    /// `@{-1}` names the previous branch, which git expands into the name it mints, so a
    /// deleted `Feat` would come back beside a packed `feat` under a spelling the twin check
    /// never compared. Create and rename refuse it as a branch name, on every disk.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn create_and_rename_refuse_a_previous_branch_expression_as_the_new_name() {
        let _serialized = crate::local_prs::tests::store_dir_lock();
        let store_dir = tempfile::tempdir().unwrap();
        let _override = crate::local_prs::tests::StoreDirOverride::set(store_dir.path());
        for rename in [false, true] {
            let (_g, base) = temp_base("previous-branch-new-name");
            let repo = base.to_string_lossy().into_owned();
            init_repo(&repo, "r.txt").await;
            let home = run(&repo, &["branch", "--show-current"])
                .await
                .trim()
                .to_string();
            run(&repo, &["switch", "-c", "Feat"]).await;
            run(&repo, &["switch", &home]).await;
            run(&repo, &["branch", "-D", "Feat"]).await;
            run(&repo, &["branch", "feat"]).await;
            run(&repo, &["pack-refs", "--all"]).await;
            let expanded = run(&repo, &["check-ref-format", "--branch", "@{-1}"]).await;
            assert_eq!(
                expanded.trim(),
                "Feat",
                "fixture sanity: git expands @{{-1}}"
            );
            let before = case_twin_snapshot(&repo).await;
            let state = AppState::default();
            let result = if rename {
                git_rename_branch_core(&state, repo.clone(), home.clone(), "@{-1}".into())
                    .await
                    .map(drop)
            } else {
                git_create_branch_core(&state, repo.clone(), "@{-1}".into(), false, None, false)
                    .await
            };
            assert!(
                matches!(&result, Err(AppError::InvalidArgument(m))
                    if m == "invalid branch name: @{-1}"),
                "rename={rename}: {result:?}"
            );
            let listed = case_twin_listed(&repo).await;
            assert!(
                !listed.iter().any(|b| b == "Feat"),
                "rename={rename}: {listed:?}"
            );
            assert!(
                listed.iter().any(|b| b == "feat"),
                "rename={rename}: {listed:?}"
            );
            assert!(listed.contains(&home), "rename={rename}: {listed:?}");
            assert_eq!(case_twin_snapshot(&repo).await, before, "rename={rename}");
        }
    }

    /// A name stored byte-exactly keeps git's own "already exists", alone and in a
    /// repository that already holds its twin, on every disk.
    #[tokio::test]
    async fn create_of_an_existing_name_keeps_gits_answer_beside_a_case_twin() {
        for twin_too in [false, true] {
            for no_track in [false, true] {
                let (_g, base) = temp_base("create-existing-case-twin");
                let repo = base.to_string_lossy().into_owned();
                init_repo(&repo, "r.txt").await;
                let name = if twin_too {
                    run(&repo, &["branch", "feat"]).await;
                    run(&repo, &["pack-refs", "--all"]).await;
                    // Beside a packed-only `feat` git mints the twin itself.
                    run(&repo, &["branch", "Feat"]).await;
                    "Feat"
                } else {
                    run(&repo, &["branch", "feat"]).await;
                    "feat"
                };
                let row = format!("twin_too={twin_too} no_track={no_track}");
                let result = git_create_branch_core(
                    &AppState::default(),
                    repo.clone(),
                    name.into(),
                    false,
                    None,
                    no_track,
                )
                .await;
                assert!(
                    matches!(&result, Err(AppError::Git { stderr, .. })
                        if stderr.contains("already exists") && !stderr.contains("letter case")),
                    "{row}: {result:?}"
                );
            }
        }
    }

    /// A reftable repository keeps `Feat` and `feat` apart on any disk, so the create
    /// succeeds. Returns early when this git can't create a reftable repository.
    #[tokio::test]
    async fn create_beside_a_case_twin_in_a_reftable_repository_succeeds() {
        let (_g, base) = temp_base("reftable-case-twin");
        let repo = base.to_string_lossy().into_owned();
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
        run(&repo, &["branch", "feat"]).await;
        assert!(!super::refs_can_alias(&repo).await);
        git_create_branch_core(
            &AppState::default(),
            repo.clone(),
            "Feat".into(),
            false,
            None,
            false,
        )
        .await
        .expect("the reftable create succeeds");
        let listed = case_twin_listed(&repo).await;
        assert!(listed.iter().any(|b| b == "Feat"), "{listed:?}");
        assert!(listed.iter().any(|b| b == "feat"), "{listed:?}");
    }

    /// A twin minted while a create waits on the config-write mutex is refused there; the
    /// `--no-track` arm waits on the mutex too.
    #[tokio::test]
    async fn create_refuses_a_case_twin_minted_during_the_mutex_wait() {
        for no_track in [true, false] {
            let (_g, base) = temp_base("create-case-twin-mutex");
            let repo = base.to_string_lossy().into_owned();
            init_repo(&repo, "r.txt").await;
            let aliases = case_twin_alias_oracle(&repo).await;
            let (holder, release) = hold_config_mutex(&repo).await;
            let (events, waiting) = on_first_waiting();
            let create = tokio::spawn({
                let repo = repo.clone();
                CONFIG_WRITE_LOCK_EVENTS.scope(events, async move {
                    git_create_branch_core(
                        &AppState::default(),
                        repo,
                        "Feat".into(),
                        false,
                        None,
                        no_track,
                    )
                    .await
                })
            });
            waiting
                .await
                .unwrap_or_else(|_| panic!("no_track={no_track}: the create reached the mutex"));
            run(&repo, &["branch", "feat"]).await;
            run(&repo, &["pack-refs", "--all"]).await;
            release.send(()).unwrap();
            holder.await.unwrap();
            let result = tokio::time::timeout(TEST_GIT_HANG_GUARD, create)
                .await
                .expect("the create finishes once released")
                .unwrap();
            let listed = case_twin_listed(&repo).await;
            if aliases {
                assert!(
                    matches!(&result, Err(AppError::Command(m)) if m == NEW_NAME_TWIN_REFUSAL),
                    "no_track={no_track}: {result:?}"
                );
                assert!(!listed.iter().any(|b| b == "Feat"), "{listed:?}");
            } else {
                result.unwrap_or_else(|e| panic!("no_track={no_track}: {e:?}"));
                assert!(listed.iter().any(|b| b == "Feat"), "{listed:?}");
            }
        }
    }

    /// A create through a LINKED worktree beside a packed-only twin in the common store:
    /// the listing, the disk probe and the mutex all key on the common dir.
    #[tokio::test]
    async fn create_through_a_linked_worktree_refuses_a_case_twin() {
        for (checkout, no_track) in [(true, false), (false, true)] {
            let (g, repo, aliases) =
                case_twin_fixture("linked-case-twin", TwinStorage::PackedOnly).await;
            let wt = g.path().join("wt").to_string_lossy().into_owned();
            run(&repo, &["worktree", "add", "-q", "--detach", &wt]).await;
            assert_eq!(super::refs_can_alias(&wt).await, aliases, "{wt}");
            let before = case_twin_snapshot(&wt).await;
            let row = format!("checkout={checkout} no_track={no_track}");
            let result = git_create_branch_core(
                &AppState::default(),
                wt.clone(),
                "Feat".into(),
                checkout,
                None,
                no_track,
            )
            .await;
            let listed = case_twin_listed(&repo).await;
            if aliases {
                assert!(
                    matches!(&result, Err(AppError::Command(m)) if m == NEW_NAME_TWIN_REFUSAL),
                    "{row}: {result:?}"
                );
                assert!(!listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert_eq!(case_twin_snapshot(&wt).await, before, "{row}");
            } else {
                result.unwrap_or_else(|e| panic!("{row}: {e:?}"));
                assert!(listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert!(listed.iter().any(|b| b == "feat"), "{row}: {listed:?}");
            }
        }
    }

    /// Checking out `origin/Feat` beside the packed-only `feat`: refused before the switch
    /// where refs alias, leaving HEAD, the branches and the config as they were; a new
    /// `Feat` tracking `origin/Feat` where they don't.
    #[tokio::test]
    async fn remote_checkout_refuses_a_case_twin() {
        let (_g, repo, aliases) =
            case_twin_fixture("remote-case-twin", TwinStorage::PackedOnly).await;
        run(&repo, &["remote", "add", "origin", &repo]).await;
        run(&repo, &["update-ref", "refs/remotes/origin/Feat", "HEAD"]).await;
        let feat = full_ref_tip(&repo, "refs/heads/feat").await;
        let before = case_twin_snapshot(&repo).await;
        let result = git_checkout_remote_branch_core(
            &AppState::default(),
            repo.clone(),
            "origin".into(),
            "Feat".into(),
        )
        .await;
        let listed = case_twin_listed(&repo).await;
        if aliases {
            assert!(
                matches!(&result, Err(AppError::Command(m)) if m == NEW_NAME_TWIN_REFUSAL),
                "{result:?}"
            );
            assert!(!listed.iter().any(|b| b == "Feat"), "{listed:?}");
            assert!(listed.iter().any(|b| b == "feat"), "{listed:?}");
            assert_eq!(case_twin_snapshot(&repo).await, before);
            assert_eq!(branch_section(&repo, "Feat").await, "");
        } else {
            result.unwrap_or_else(|e| panic!("{e:?}"));
            assert!(listed.iter().any(|b| b == "Feat"), "{listed:?}");
            assert_eq!(
                symbolic_head(&repo).await.as_deref(),
                Some("refs/heads/Feat")
            );
            assert_eq!(
                run(&repo, &["config", "--get", "branch.Feat.merge"])
                    .await
                    .trim(),
                "refs/heads/Feat"
            );
        }
        assert_eq!(full_ref_tip(&repo, "refs/heads/feat").await, feat);
    }

    /// Checking out `Feat` from a remote named `team/fork` creates `Feat` tracking
    /// `team/fork/Feat`, never the `fork/Feat` git derives from the start ref alone; beside
    /// a packed-only `feat` where refs alias, it is refused with the twin sentence and
    /// creates nothing.
    #[tokio::test]
    async fn remote_checkout_under_a_slash_named_remote_creates_the_named_branch() {
        for twin in [false, true] {
            let (_g, repo, refused) = if twin {
                case_twin_fixture("slash-remote-twin", TwinStorage::PackedOnly).await
            } else {
                let (g, base) = temp_base("slash-remote");
                let repo = base.join("repo").to_string_lossy().into_owned();
                std::fs::create_dir_all(&repo).unwrap();
                init_repo(&repo, "r.txt").await;
                (g, repo, false)
            };
            run(&repo, &["remote", "add", "team/fork", &repo]).await;
            run(
                &repo,
                &["update-ref", "refs/remotes/team/fork/Feat", "HEAD"],
            )
            .await;
            let before = case_twin_snapshot(&repo).await;
            let result = git_checkout_remote_branch_core(
                &AppState::default(),
                repo.clone(),
                "team/fork".into(),
                "Feat".into(),
            )
            .await;
            let listed = case_twin_listed(&repo).await;
            let row = format!("twin={twin}");
            assert!(
                !listed.iter().any(|b| b == "fork/Feat"),
                "{row}: {listed:?}"
            );
            if refused {
                assert!(
                    matches!(&result, Err(AppError::Command(m)) if m == NEW_NAME_TWIN_REFUSAL),
                    "{row}: {result:?}"
                );
                assert!(!listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert_eq!(case_twin_snapshot(&repo).await, before, "{row}");
            } else {
                result.unwrap_or_else(|e| panic!("{row}: {e:?}"));
                assert!(listed.iter().any(|b| b == "Feat"), "{row}: {listed:?}");
                assert_eq!(
                    symbolic_head(&repo).await.as_deref(),
                    Some("refs/heads/Feat"),
                    "{row}"
                );
                assert_eq!(
                    upstream_of(&repo, "Feat").await.as_deref(),
                    Some("team/fork/Feat"),
                    "{row}"
                );
            }
        }
    }
}
