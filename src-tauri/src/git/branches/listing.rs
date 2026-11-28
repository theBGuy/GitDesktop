use super::*;

/// Every local branch. Names are read in FULL and stripped of exactly `refs/heads/`:
/// `%(refname:short)` disambiguates, so a branch shadowed by a same-named tag lists as
/// `heads/<name>` (or the full ref, when that is ambiguous too) and every row action
/// would target the wrong name. `%(upstream:short)` stays short on purpose — the UI
/// hands it back as a rev, which its disambiguated form resolves correctly.
///
/// The same spawn lists every remote's `HEAD` (`**`, since `*` stops at the `/` of a
/// slash-named remote) so `upstream_is_remote_default` compares two full refs, exact
/// under a remapped fetch refspec. A dangling remote HEAD prints no row: false.
#[tauri::command]
pub async fn git_branches(repo_path: String) -> AppResult<Vec<Branch>> {
    let out = run_git(
        Some(&repo_path),
        &[
            "for-each-ref",
            "refs/heads",
            "refs/remotes/**/HEAD",
            "--format=%(refname)%00%(upstream:short)%00%(HEAD)%00%(committerdate:iso8601-strict)%00%(upstream:track)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)%00%(symref)",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let flags = read_branch_flags(&repo_path).await?;
    let remote_heads: std::collections::HashMap<&str, &str> = text
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('\0').collect();
            let refname = fields.first()?;
            let symref = fields.get(8).filter(|s| !s.is_empty())?;
            (refname.starts_with("refs/remotes/") && refname.ends_with("/HEAD"))
                .then_some((*refname, *symref))
        })
        .collect();
    // Read once per listing; a failed read leaves every row's push destination unknown.
    #[cfg(test)]
    run_test_hook(&LISTING_ROUTING_HOOK).await;
    let routing = crate::git::remote::named_push_routing(&repo_path)
        .await
        .ok();
    // Rows whose live upstream has another name: (row index, upstream name, full ref).
    let mut candidates: Vec<(usize, String, String)> = Vec::new();
    let mut branches = Vec::new();
    for line in text.lines() {
        let mut parts = line.split('\0');
        let (
            Some(refname),
            upstream,
            head,
            date,
            track,
            upstream_remote,
            upstream_remote_ref,
            upstream_full,
        ) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        )
        else {
            continue;
        };
        let Some(name) = refname
            .strip_prefix("refs/heads/")
            .filter(|n| !n.is_empty())
        else {
            continue;
        };
        let (upstream_ahead, upstream_behind, upstream_gone) =
            parse_upstream_track(track.unwrap_or(""));
        let remote = upstream_remote.unwrap_or("");
        let upstream_full = upstream_full.unwrap_or("");
        let upstream_is_remote_default = !upstream_gone
            && crate::git::remote::is_named_remote(remote)
            && upstream_remote_ref.is_some_and(|r| r.starts_with("refs/heads/"))
            && !upstream_full.is_empty()
            && crate::git::remote::upstream_is_remote_default(
                remote_heads
                    .get(format!("refs/remotes/{remote}/HEAD").as_str())
                    .copied(),
                upstream_full,
            ) == Some(true);
        let upstream_kind =
            crate::git::remote::upstream_from_remoteref(upstream_remote_ref.unwrap_or(""));
        let candidate_up = match &upstream_kind {
            crate::git::remote::Upstream::Branch(up)
                if !upstream_gone
                    && crate::git::remote::is_named_remote(remote)
                    && !upstream_is_remote_default
                    && up != name =>
            {
                Some(up.clone())
            }
            _ => None,
        };
        if let (Some(up), Ok(full_ref)) = (candidate_up, branch_full_ref(name)) {
            candidates.push((branches.len(), up, full_ref));
        }
        let (named_push_remote, named_push_branch, named_push_refused) = named_push_fields(
            routing
                .as_ref()
                .map(|r| r.destination(name, &upstream_kind, remote, upstream_gone)),
        );
        branches.push(Branch {
            name: name.to_string(),
            is_current: head == Some("*"),
            upstream: upstream.filter(|u| !u.is_empty()).map(str::to_string),
            last_commit_date: date.unwrap_or("").to_string(),
            archived: flags.archived.contains(name),
            upstream_ahead,
            upstream_behind,
            upstream_gone,
            upstream_remote: upstream_remote.filter(|r| !r.is_empty()).map(str::to_string),
            upstream_remote_ref: upstream_remote_ref
                .filter(|r| !r.is_empty())
                .map(str::to_string),
            keep_local: flags.keep_local.contains(name),
            upstream_is_remote_default,
            renamed_from_upstream: false,
            named_push_remote,
            named_push_branch,
            named_push_refused,
        });
    }
    // One reflog spawn per chunk of candidates; a failed spawn (one ref deleted since the
    // listing fails the whole call) leaves that chunk's rows false and the listing whole.
    #[cfg(test)]
    run_test_hook(&LISTING_REFLOG_HOOK).await;
    for chunk in candidates.chunks(REFLOG_BATCH) {
        let refs: Vec<String> = chunk
            .iter()
            .map(|(_, _, full_ref)| full_ref.clone())
            .collect();
        match read_reflog_subjects(&repo_path, &refs).await {
            Ok(subjects) => {
                for (row, up, full_ref) in chunk {
                    let subjects = subjects.get(full_ref).map_or(&[][..], Vec::as_slice);
                    let previous = previous_branch_names(subjects, &branches[*row].name);
                    branches[*row].renamed_from_upstream = previous.contains(up);
                }
            }
            Err(e) => {
                eprintln!("gitdesktop: branch-list reflog read failed (rows read false): {e}")
            }
        }
    }
    Ok(branches)
}

/// A row's three push-destination fields; an unread routing (None) is `None`/`None`/false.
fn named_push_fields(
    destination: Option<crate::git::remote::NamedPushDestination>,
) -> (Option<String>, Option<String>, bool) {
    use crate::git::remote::NamedPushDestination;
    match destination {
        Some(NamedPushDestination::To { remote, branch }) => (Some(remote), Some(branch), false),
        Some(NamedPushDestination::Refused) => (None, None, true),
        None => (None, None, false),
    }
}

/// The for-each-ref atoms [`push_destination_fields`] reads, appended NUL-separated
/// after a read's own fields: the push remote, its explicit destination ref (filled only
/// under a `remote.<r>.push` refspec), the destination's remote-tracking ref, and the
/// upstream's tracking ref it is compared with.
const PUSH_DESTINATION_ATOMS: &str =
    "%(push:remotename)%00%(push:remoteref)%00%(push)%00%(upstream)";

/// The position of `%(upstream)` among [`PUSH_DESTINATION_ATOMS`], for readers that
/// take that one atom off a line.
pub(crate) const UPSTREAM_ATOM_INDEX: usize = 3;

/// Runs `for-each-ref <pattern>` with `base_format` extended by
/// [`PUSH_DESTINATION_ATOMS`]. A git that rejects one of them fails the whole command,
/// so that failure re-runs `base_format` once and the lines carry no atoms: the
/// destination reads as unknown, never a broken read (the status read may still derive
/// one from the push config).
pub(crate) async fn read_refs_with_push_destination(
    repo_path: &str,
    pattern: &str,
    base_format: &str,
) -> AppResult<String> {
    let extended = format!("{base_format}%00{PUSH_DESTINATION_ATOMS}");
    read_refs_with_fallback(repo_path, pattern, &extended, base_format).await
}

async fn read_refs_with_fallback(
    repo_path: &str,
    pattern: &str,
    extended: &str,
    base_format: &str,
) -> AppResult<String> {
    let out = run_git_raw(
        Some(repo_path),
        &["for-each-ref", pattern, extended],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code == 0 {
        return Ok(out.stdout_lossy());
    }
    // Any other failure surfaces exactly as `run_git` would have reported it.
    if !is_unknown_format_atom(&out.stderr) {
        out.exit_verdict()?;
    }
    let out = run_git(
        Some(repo_path),
        &["for-each-ref", pattern, base_format],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(out.stdout_lossy())
}

/// Whether for-each-ref refused a format atom: git's ref-filter says `unknown field
/// name: <atom>` for an atom it lacks and `unrecognized %(push) argument: <arg>` for a
/// known atom's unknown argument. The runner pins `LC_ALL=C`, so neither localizes.
fn is_unknown_format_atom(stderr: &str) -> bool {
    stderr.contains("unknown field name") || stderr.contains("unrecognized %(push) argument")
}

/// `(push_remote, push_branch)` from a line's [`PUSH_DESTINATION_ATOMS`] fields (empty
/// when the read fell back without them), via [`push_destination`].
pub(crate) fn push_destination_fields(
    local: &str,
    atoms: &[&str],
    upstream_remote: &str,
    upstream_remoteref: &str,
) -> (Option<String>, Option<String>) {
    let [push_remote, push_remoteref, push_track, upstream_track] = match atoms {
        [a, b, c, d, ..] => [*a, *b, *c, *d],
        _ => return (None, None),
    };
    push_destination(
        local,
        push_remote,
        push_remoteref,
        push_track,
        upstream_track,
        upstream_remote,
        upstream_remoteref,
    )
}

/// Where a BARE push of `local` lands, as `(remote, branch on it)`: both Some or both
/// None. A push remote with its own push refspecs is unresolved: git's bare push sends
/// every configured refspec, which no single destination describes, and
/// `%(push:remoteref)` fills only then (one that doesn't map the branch leaves `%(push)`
/// empty). Otherwise `%(push)` is the destination's LOCAL remote-tracking ref, which
/// depends on the fetch refspec's mapping, so it is only read back when it is the
/// upstream's own tracking ref on the same remote (the upstream's branch) or the
/// standard `refs/remotes/<remote>/<local>` (the same name). Any other shape (a
/// remapped fetch refspec, `team/…`) is unresolved: a wrong branch name is never an
/// answer. A mirror push remote (`remote.<r>.mirror`) resolves here like any other; the
/// atoms can't tell it apart, so the status read clears it from the push config, except
/// for the branch's own same-named live upstream, where it reads no config. Every app
/// push to a mirror is refused before git runs (`refuse_mirror_push`).
fn push_destination(
    local: &str,
    push_remote: &str,
    push_remoteref: &str,
    push_track: &str,
    upstream_track: &str,
    upstream_remote: &str,
    upstream_remoteref: &str,
) -> (Option<String>, Option<String>) {
    if !crate::git::remote::is_named_remote(push_remote) || !push_remoteref.is_empty() {
        return (None, None);
    }
    let branch = if push_track.is_empty() {
        None
    } else if push_track == upstream_track && upstream_remote == push_remote {
        upstream_remoteref.strip_prefix("refs/heads/")
    } else if push_track == format!("refs/remotes/{push_remote}/{local}") {
        Some(local)
    } else {
        None
    };
    match branch.filter(|b| !b.is_empty()) {
        Some(b) => (Some(push_remote.to_string()), Some(b.to_string())),
        None => (None, None),
    }
}

/// Parses git's `%(upstream:track)` field into `(ahead, behind, gone)`.
///
/// Shapes: `[ahead 1, behind 2]`, `[ahead 1]`, `[behind 2]`, `[gone]`
/// (upstream deleted), or empty (no upstream, or in sync). `[gone]` yields
/// `(0, 0, true)`; empty and anything unparseable yield `(0, 0, false)`.
/// The `gone` bit lets consumers offer "Publish branch" instead of Push/Pull
/// against a dead ref, even though `%(upstream:short)` still names the upstream.
fn parse_upstream_track(track: &str) -> (u32, u32, bool) {
    let inner = track
        .trim()
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'));
    let Some(inner) = inner else {
        return (0, 0, false);
    };
    let (mut ahead, mut behind, mut gone) = (0u32, 0u32, false);
    for part in inner.split(',') {
        let mut words = part.split_whitespace();
        match (words.next(), words.next()) {
            (Some("ahead"), Some(n)) => ahead = n.parse().unwrap_or(0),
            (Some("behind"), Some(n)) => behind = n.parse().unwrap_or(0),
            (Some("gone"), _) => gone = true,
            _ => {}
        }
    }
    (ahead, behind, gone)
}

/// Splits a remote-tracking ref past `refs/remotes/` at the longest configured
/// remote followed by `/` (a remote name may itself hold `/`), else at the first
/// `/`; `None` when either side would be empty. The same rule as Compare's
/// `splitRemoteDisplay`, so against the same remote list the two agree on every row.
fn split_remote_tracking<'a>(rest: &'a str, remotes: &[String]) -> Option<(&'a str, &'a str)> {
    let mut slash = rest.find('/')?;
    for remote in remotes {
        if remote.len() > slash
            && rest
                .strip_prefix(remote.as_str())
                .is_some_and(|tail| tail.starts_with('/'))
        {
            slash = remote.len();
        }
    }
    let (remote, name) = (&rest[..slash], &rest[slash + 1..]);
    (!remote.is_empty() && !name.is_empty()).then_some((remote, name))
}

/// Branches that exist on a remote, feeding every remote-branch list. Returns
/// every `refs/remotes/<remote>/<branch>`, skipping each configured remote's
/// symbolic `HEAD`; consumers drop what they don't offer (such as
/// `gd/session/*`). The list reflects the last fetch. A failed
/// remotes read fails the list: a guessed split would leak session branches.
#[tauri::command]
pub async fn git_remote_branches(repo_path: String) -> AppResult<Vec<RemoteBranch>> {
    let (out, remotes) = tokio::try_join!(
        run_git(
            Some(&repo_path),
            &[
                "for-each-ref",
                "refs/remotes",
                "--format=%(refname)%00%(committerdate:iso8601-strict)%00%(objectname)",
            ],
            DEFAULT_TIMEOUT,
        ),
        crate::git::remote::git_remotes(repo_path.clone()),
    )?;
    let mut branches = Vec::new();
    for line in out.stdout_lossy().lines() {
        let mut parts = line.split('\0');
        let (Some(refname), date, tip) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        // Full ref, stripped of exactly `refs/remotes/`: the short form turns into
        // `remotes/<remote>/<branch>` when a local ref is named `<remote>/<branch>`.
        // A `/` inside a branch name or a configured remote's name stays whole; a ref
        // under no configured remote splits at its first `/`.
        let Some((remote, name)) = refname
            .strip_prefix("refs/remotes/")
            .and_then(|r| split_remote_tracking(r, &remotes))
        else {
            continue;
        };
        // Skip the remote's symbolic HEAD (`origin/HEAD` → points at the default).
        if name == "HEAD" {
            continue;
        }
        branches.push(RemoteBranch {
            name: name.to_string(),
            remote: remote.to_string(),
            last_commit_date: date.unwrap_or("").to_string(),
            tip: tip.unwrap_or("").to_string(),
        });
    }
    Ok(branches)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        copy_repo, init_repo, pin_remote_head, run, temp_base, tracking_branch,
    };
    use crate::git::runner::TEST_GIT_HANG_GUARD;
    use std::sync::Arc;

    /// One listing: two renamed copies, a stacked branch, a same-name branch and the
    /// measured default's renamed copy, plus the rows' push-destination fields. Deleting a
    /// candidate from the hook fails its chunk's reflog read: those rows read false and the
    /// listing stands.
    #[tokio::test]
    async fn listing_flags_renamed_copies_from_one_batched_reflog_read() {
        use super::{named_push_fields, TestHook, LISTING_REFLOG_HOOK};
        let (_g, _base, repo) = copy_repo("list-renamed").await;
        tracking_branch(&repo, "o1", "o1").await;
        run(&repo, &["branch", "-m", "o1", "n1"]).await;
        tracking_branch(&repo, "o2", "o2").await;
        run(&repo, &["branch", "-m", "o2", "n2"]).await;
        tracking_branch(&repo, "feat2", "feat1").await;
        tracking_branch(&repo, "same", "same").await;
        tracking_branch(&repo, "dflt", "dflt").await;
        run(&repo, &["branch", "-m", "dflt", "dcopy"]).await;
        for (key, value) in [
            ("remote.mir.url", repo.as_str()),
            ("remote.mir.fetch", "+refs/heads/*:refs/remotes/mir/*"),
            ("remote.mir.mirror", "true"),
        ] {
            run(&repo, &["config", key, value]).await;
        }
        run(&repo, &["update-ref", "refs/remotes/mir/m", "HEAD"]).await;
        run(&repo, &["branch", "--track", "m", "refs/remotes/mir/m"]).await;
        pin_remote_head(&repo, Some("dflt")).await;
        let names = ["n1", "n2", "feat2", "same", "dcopy"];
        let flags = |rows: &[crate::git::types::Branch]| -> Vec<bool> {
            names
                .iter()
                .map(|n| {
                    rows.iter()
                        .find(|b| b.name == *n)
                        .unwrap()
                        .renamed_from_upstream
                })
                .collect()
        };
        let rows = git_branches(repo.clone()).await.unwrap();
        assert_eq!(flags(&rows), [true, true, false, false, false]);
        let row = |name: &str| rows.iter().find(|b| b.name == name).unwrap().clone();
        let same = row("same");
        assert_eq!(
            (
                same.named_push_remote.as_deref(),
                same.named_push_branch.as_deref(),
                same.named_push_refused
            ),
            (Some("origin"), Some("same"), false)
        );
        let mirror = row("m");
        assert_eq!(
            (
                mirror.named_push_remote,
                mirror.named_push_branch,
                mirror.named_push_refused
            ),
            (None, None, true)
        );
        assert_eq!(named_push_fields(None), (None, None, false));

        let tip = run(&repo, &["rev-parse", "refs/heads/feat2"])
            .await
            .trim()
            .to_string();
        let hook: TestHook = {
            let repo = repo.clone();
            Arc::new(move || {
                let (repo, tip) = (repo.clone(), tip.clone());
                Box::pin(async move {
                    run(&repo, &["update-ref", "-d", "refs/heads/feat2", &tip]).await;
                })
            })
        };
        let rows = LISTING_REFLOG_HOOK
            .scope(hook, git_branches(repo.clone()))
            .await
            .unwrap();
        assert_eq!(flags(&rows), [false, false, false, false, false]);
    }

    /// A routing read that fails for the repository still lists every row, each with its
    /// push-destination fields unread (`named_push_fields(None)`). The routing hook breaks
    /// `.git/config` for that read alone; the reflog hook restores it.
    #[tokio::test]
    async fn listing_survives_a_failed_routing_read() {
        use super::{TestHook, LISTING_REFLOG_HOOK, LISTING_ROUTING_HOOK};
        let (_g, _base, repo) = copy_repo("list-routing").await;
        tracking_branch(&repo, "o1", "o1").await;
        run(&repo, &["branch", "-m", "o1", "n1"]).await;
        tracking_branch(&repo, "same", "same").await;
        let whole = git_branches(repo.clone()).await.unwrap();
        let config = std::path::Path::new(&repo).join(".git").join("config");
        let saved = std::fs::read(&config).unwrap();
        let file_hook = |bytes: Vec<u8>| -> TestHook {
            let config = config.clone();
            Arc::new(move || {
                let (config, bytes) = (config.clone(), bytes.clone());
                Box::pin(async move { std::fs::write(&config, bytes).unwrap() })
            })
        };
        let broken = [saved.as_slice(), b"[broken\n"].concat();
        let rows = LISTING_ROUTING_HOOK
            .scope(
                file_hook(broken),
                LISTING_REFLOG_HOOK.scope(file_hook(saved.clone()), git_branches(repo.clone())),
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(&config).unwrap(),
            saved,
            "the config restored"
        );
        let names = |rows: &[crate::git::types::Branch]| -> Vec<String> {
            rows.iter().map(|b| b.name.clone()).collect()
        };
        assert_eq!(names(&rows), names(&whole));
        let same = whole.iter().find(|b| b.name == "same").unwrap();
        assert_eq!(
            same.named_push_remote.as_deref(),
            Some("origin"),
            "read whole"
        );
        for row in &rows {
            let wire = serde_json::to_value(row).unwrap();
            assert_eq!(
                (
                    &wire["namedPushRemote"],
                    &wire["namedPushBranch"],
                    &wire["namedPushRefused"]
                ),
                (
                    &serde_json::Value::Null,
                    &serde_json::Value::Null,
                    &serde_json::Value::Bool(false)
                ),
                "{}",
                row.name
            );
        }
        let n1 = rows.iter().find(|b| b.name == "n1").unwrap();
        assert!(
            n1.renamed_from_upstream,
            "the reflog read ran on the restored config"
        );
    }

    #[test]
    fn parses_ahead_and_behind() {
        assert_eq!(parse_upstream_track("[ahead 1, behind 2]"), (1, 2, false));
    }

    #[test]
    fn parses_ahead_only() {
        assert_eq!(parse_upstream_track("[ahead 1]"), (1, 0, false));
    }

    #[test]
    fn parses_behind_only() {
        assert_eq!(parse_upstream_track("[behind 2]"), (0, 2, false));
    }

    #[test]
    fn gone_upstream_is_zero() {
        // `[gone]` reports the deleted-upstream bit with zeroed counts.
        assert_eq!(parse_upstream_track("[gone]"), (0, 0, true));
    }

    #[test]
    fn empty_or_unparseable_is_zero() {
        assert_eq!(parse_upstream_track(""), (0, 0, false));
        assert_eq!(parse_upstream_track("   "), (0, 0, false));
        assert_eq!(parse_upstream_track("garbage"), (0, 0, false));
    }

    /// The destination derivation's arms: an explicit push ref, the upstream's own
    /// tracking ref, the standard same-name tracking ref, and everything that stays
    /// unresolved rather than naming a wrong branch.
    #[test]
    fn push_destination_arms() {
        let both = |r: &str, b: &str| (Some(r.to_string()), Some(b.to_string()));
        let none = (None, None);
        let up = "refs/remotes/origin/main";
        // (local, push remote, push remoteref, %(push), %(upstream), upstream remote,
        //  upstream remoteref) → destination
        let cases = [
            // A push remote with its own push refspecs sends them all, as configured:
            // no single destination describes that push.
            (
                (
                    "topic",
                    "origin",
                    "refs/heads/pushed/t",
                    "refs/remotes/origin/pushed/t",
                    up,
                    "origin",
                    "refs/heads/main",
                ),
                none.clone(),
            ),
            (
                (
                    "topic",
                    "origin",
                    "refs/tags/t",
                    "",
                    up,
                    "origin",
                    "refs/heads/main",
                ),
                none.clone(),
            ),
            // The upstream's own tracking ref on the same remote: the upstream branch.
            (
                ("topic", "origin", "", up, up, "origin", "refs/heads/main"),
                both("origin", "main"),
            ),
            // The upstream's tracking ref named for ANOTHER push remote (upstream
            // mode, triangular): git refuses that push.
            (
                ("topic", "second", "", up, up, "origin", "refs/heads/main"),
                none.clone(),
            ),
            // The standard same-name tracking ref.
            (
                (
                    "topic",
                    "origin",
                    "",
                    "refs/remotes/origin/topic",
                    up,
                    "origin",
                    "refs/heads/main",
                ),
                both("origin", "topic"),
            ),
            (
                (
                    "a/b",
                    "fork",
                    "",
                    "refs/remotes/fork/a/b",
                    up,
                    "origin",
                    "refs/heads/main",
                ),
                both("fork", "a/b"),
            ),
            // A remapped fetch refspec's tracking name is never read as the branch.
            (
                (
                    "topic",
                    "origin",
                    "",
                    "refs/remotes/origin/team/topic",
                    "refs/remotes/origin/team/main",
                    "origin",
                    "refs/heads/main",
                ),
                none.clone(),
            ),
            // Remapped, but the destination IS the upstream: read back through it.
            (
                (
                    "topic",
                    "origin",
                    "",
                    "refs/remotes/origin/team/main",
                    "refs/remotes/origin/team/main",
                    "origin",
                    "refs/heads/main",
                ),
                both("origin", "main"),
            ),
            // No destination (simple's cross-name refusal, nothing, a narrow fetch).
            (
                ("topic", "origin", "", "", up, "origin", "refs/heads/main"),
                none.clone(),
            ),
            // No remote, or a local one.
            (
                (
                    "topic",
                    "",
                    "",
                    "refs/remotes/origin/topic",
                    up,
                    "origin",
                    "refs/heads/main",
                ),
                none.clone(),
            ),
            (
                (
                    "topic",
                    ".",
                    "",
                    "refs/heads/main",
                    "",
                    ".",
                    "refs/heads/main",
                ),
                none.clone(),
            ),
            // An upstream that is no branch can't name the destination.
            (
                (
                    "topic",
                    "origin",
                    "",
                    "refs/remotes/origin/pr",
                    "refs/remotes/origin/pr",
                    "origin",
                    "refs/pull/1/head",
                ),
                none.clone(),
            ),
        ];
        for ((local, pr, prr, p, u, ur, urr), want) in cases {
            assert_eq!(
                push_destination(local, pr, prr, p, u, ur, urr),
                want,
                "{local} {pr} {prr} {p} {u}"
            );
        }
    }

    /// git's two real phrasings for a refused format atom (measured live below) are the
    /// retry's trigger; any other failure is not.
    #[test]
    fn unknown_format_atom_phrasings() {
        assert!(is_unknown_format_atom("fatal: unknown field name: pushx"));
        assert!(is_unknown_format_atom(
            "fatal: unrecognized %(push) argument: bogus"
        ));
        assert!(!is_unknown_format_atom("fatal: not a git repository"));
        assert!(!is_unknown_format_atom(
            "fatal: unrecognized %(upstream) argument: bogus"
        ));
    }

    #[test]
    fn upstream_atom_index_names_the_upstream_atom() {
        let atoms: Vec<&str> = PUSH_DESTINATION_ATOMS.split("%00").collect();
        assert_eq!(atoms.get(UPSTREAM_ATOM_INDEX), Some(&"%(upstream)"));
    }

    /// The retry-once, live, over the status read's own format: an extended format this
    /// git rejects (an unknown atom, and a known atom with an unknown argument) re-runs
    /// the base format, so the read still answers with the tracking fields and no push
    /// atoms. A failure of any other kind is an error, not a retry.
    #[tokio::test]
    async fn a_rejected_push_atom_falls_back_to_the_base_read() {
        use crate::git::remote::{parse_upstream_tracking, Upstream, UPSTREAM_TRACKING_FORMAT};
        let (_base, base) = temp_base("push-atom-retry");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        // A tracked branch, so the tracking fields have something to say.
        let main = run(&repo_s, &["symbolic-ref", "--short", "HEAD"])
            .await
            .trim()
            .to_string();
        let refname = run(&repo_s, &["symbolic-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        let tracking = format!("refs/remotes/origin/{main}");
        run(&repo_s, &["update-ref", &tracking, "HEAD"]).await;
        let upstream = format!("--set-upstream-to=origin/{main}");
        run(&repo_s, &["branch", "-q", &upstream]).await;
        // Pinned, so a global remote.pushDefault can't move the push remote read below.
        let push_remote = format!("branch.{main}.pushRemote");
        run(&repo_s, &["config", &push_remote, "origin"]).await;
        let fmt = UPSTREAM_TRACKING_FORMAT;
        let base_text = run(&repo_s, &["for-each-ref", &refname, fmt]).await;
        let tracked = Some((Upstream::Branch(main.clone()), "origin".to_string(), false));
        assert_eq!(parse_upstream_tracking(&base_text, &refname), tracked);
        for bogus in ["%(nosuchatom)", "%(push:bogus)"] {
            // The premise: git itself rejects it with a phrasing the matcher knows.
            let raw = run_git_raw(
                Some(&repo_s),
                &["for-each-ref", &refname, &format!("--format={bogus}")],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
            assert_ne!(raw.code, 0, "{bogus}");
            assert!(
                is_unknown_format_atom(&raw.stderr),
                "{bogus}: {}",
                raw.stderr
            );
            let extended = format!("{fmt}%00{bogus}");
            let text = read_refs_with_fallback(&repo_s, &refname, &extended, fmt)
                .await
                .expect("the fallback answers");
            assert_eq!(text, base_text, "{bogus}");
            assert_eq!(parse_upstream_tracking(&text, &refname), tracked, "{bogus}");
        }
        // The real extended read answers with the atoms on this git: the tracking
        // fields unchanged, the push remote after them.
        let text = read_refs_with_push_destination(&repo_s, &refname, fmt)
            .await
            .unwrap();
        assert_eq!(parse_upstream_tracking(&text, &refname), tracked);
        let line = text.lines().next().unwrap();
        // The base format's fields plus the push atoms, whatever their values.
        let base_fields = crate::git::remote::UPSTREAM_TRACKING_FIELDS;
        let push_atoms = PUSH_DESTINATION_ATOMS.split("%00").count();
        assert_eq!(
            line.split('\0').count(),
            base_fields + push_atoms,
            "{line:?}"
        );
        assert_eq!(
            line.split('\0').nth(base_fields),
            Some("origin"),
            "{line:?}"
        );
        // Not a format refusal: no retry, an error.
        let missing = base.join("not-a-repo");
        std::fs::create_dir_all(&missing).unwrap();
        read_refs_with_push_destination(&missing.to_string_lossy(), &refname, fmt)
            .await
            .expect_err("a broken repository is an error");
    }

    /// `git_branches` must surface git's authoritative `%(upstream:remotename)`
    /// on each branch: a tracked branch carries its remote, an untracked one
    /// carries none. This is the single source of truth the UI reads instead of
    /// re-deriving the remote from the upstream string.
    #[tokio::test]
    async fn git_branches_reports_upstream_remote() {
        let (_base, base) = temp_base("upstream-remote");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        // A remote named `origin` (URL is the repo's own path — never fetched) and
        // a synthetic remote-tracking ref pointing at HEAD.
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/x", "HEAD"]).await;

        let state = AppState::default();
        // Pin tracking mode repo-locally so an ambient global
        // `branch.autoSetupMerge = simple|false` can't leave `tracked` untracked.
        run(&repo_s, &["config", "branch.autoSetupMerge", "true"]).await;
        // Tracked branch `tracked` → tracks origin/x.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "tracked".into(),
            false,
            Some("origin/x".into()),
            false,
        )
        .await
        .expect("create tracked succeeds");
        // Untracked branch `solo` → based on the same ref with tracking suppressed.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "solo".into(),
            false,
            Some("origin/x".into()),
            true,
        )
        .await
        .expect("create solo succeeds");

        let branches = git_branches(repo_s.clone()).await.expect("list branches");
        let tracked = branches
            .iter()
            .find(|b| b.name == "tracked")
            .expect("tracked branch present");
        assert_eq!(
            tracked.upstream_remote.as_deref(),
            Some("origin"),
            "a tracked branch carries its upstream's remote"
        );
        let solo = branches
            .iter()
            .find(|b| b.name == "solo")
            .expect("solo branch present");
        assert_eq!(
            solo.upstream_remote, None,
            "an untracked branch carries no upstream remote"
        );
    }

    /// Every row names its branch exactly, however git would shorten it: a branch
    /// shadowed by a same-named tag, and one whose `heads/<name>` is itself taken by a
    /// branch (git then answers the full ref). The archive flag, keyed by name, follows.
    #[tokio::test]
    async fn git_branches_names_branches_shadowed_by_tags() {
        let (_base, base) = temp_base("list-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "shadowed"]).await;
        run(&repo_s, &["tag", "shadowed"]).await;
        run(&repo_s, &["branch", "ambiguous"]).await;
        run(&repo_s, &["tag", "ambiguous"]).await;
        run(&repo_s, &["branch", "heads/ambiguous"]).await;
        set_branch_archived_core(&repo_s, "shadowed", true)
            .await
            .expect("archive shadowed");

        let branches = git_branches(repo_s.clone()).await.expect("list branches");
        let mut names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        names.sort_unstable();
        assert!(
            names.contains(&"shadowed")
                && names.contains(&"ambiguous")
                && names.contains(&"heads/ambiguous"),
            "{names:?}"
        );
        assert!(
            !names
                .iter()
                .any(|n| *n == "heads/shadowed" || n.starts_with("refs/")),
            "{names:?}"
        );
        let shadowed = branches.iter().find(|b| b.name == "shadowed").unwrap();
        assert!(
            shadowed.archived,
            "the archive flag is keyed by the real name"
        );
    }

    /// A remote-tracking ref shortened past `<remote>/<branch>` by a tag named
    /// `origin/main` still splits into that remote and branch, and the remote's
    /// symbolic HEAD stays out of the list.
    #[tokio::test]
    async fn git_remote_branches_split_refs_shadowed_by_a_tag() {
        let (_base, base) = temp_base("remote-list-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        run(
            &repo_s,
            &["update-ref", "refs/remotes/origin/feat/x", "HEAD"],
        )
        .await;
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

        let rows = super::git_remote_branches(repo_s.clone())
            .await
            .expect("list remote branches");
        let mut pairs: Vec<(String, String)> =
            rows.into_iter().map(|b| (b.remote, b.name)).collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("origin".to_string(), "feat/x".to_string()),
                ("origin".to_string(), "main".to_string()),
            ]
        );
    }

    /// The split takes the longest configured remote followed by `/`, whatever the
    /// list's order, and falls back to the first `/` (the rule Compare's
    /// `splitRemoteDisplay` applies).
    #[test]
    fn split_remote_tracking_takes_the_longest_configured_remote() {
        type Case<'a> = (&'a str, &'a [String], Option<(&'a str, &'a str)>);
        let list = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let slash_remote = list(&["origin", "team/fork"]);
        let longer_first = list(&["team/fork", "team"]);
        let shorter_first = list(&["team", "team/fork"]);
        let only_slash = list(&["team/fork"]);
        let cases: &[Case] = &[
            ("origin/main", &slash_remote, Some(("origin", "main"))),
            ("origin/feat/x", &slash_remote, Some(("origin", "feat/x"))),
            ("team/fork/Feat", &slash_remote, Some(("team/fork", "Feat"))),
            (
                "team/fork/gd/session/abc",
                &slash_remote,
                Some(("team/fork", "gd/session/abc")),
            ),
            ("ghost/x/y", &slash_remote, Some(("ghost", "x/y"))),
            ("team/fork/x", &shorter_first, Some(("team/fork", "x"))),
            ("team/other", &shorter_first, Some(("team", "other"))),
            ("team/fork/x", &longer_first, Some(("team/fork", "x"))),
            ("team/other", &longer_first, Some(("team", "other"))),
            ("team/fork", &only_slash, Some(("team", "fork"))),
            ("lonely", &slash_remote, None),
        ];
        for (rest, remotes, want) in cases {
            assert_eq!(
                super::split_remote_tracking(rest, remotes),
                *want,
                "{rest} against {remotes:?}"
            );
        }
    }

    /// A remote whose name holds `/` lists its branches under its whole name, its
    /// session branches keep their full `gd/session/*` name, and its symbolic HEAD
    /// stays out of the list.
    #[tokio::test]
    async fn git_remote_branches_split_at_a_slash_named_remote() {
        let (_base, base) = temp_base("remote-list-slash-remote");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["remote", "add", "team/fork", &repo_s]).await;
        for refname in [
            "refs/remotes/origin/main",
            "refs/remotes/team/fork/Feat",
            "refs/remotes/team/fork/gd/session/abc",
        ] {
            run(&repo_s, &["update-ref", refname, "HEAD"]).await;
        }
        run(
            &repo_s,
            &[
                "symbolic-ref",
                "refs/remotes/team/fork/HEAD",
                "refs/remotes/team/fork/Feat",
            ],
        )
        .await;

        let rows = super::git_remote_branches(repo_s.clone())
            .await
            .expect("list remote branches");
        let mut pairs: Vec<(String, String)> =
            rows.into_iter().map(|b| (b.remote, b.name)).collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("origin".to_string(), "main".to_string()),
                ("team/fork".to_string(), "Feat".to_string()),
                ("team/fork".to_string(), "gd/session/abc".to_string()),
            ]
        );
    }

    /// Each row carries its tracking ref's own commit id, on the wire as `tip`.
    #[tokio::test]
    async fn git_remote_branches_read_each_tip() {
        let (_base, base) = temp_base("remote-list-tips");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/a", "HEAD"]).await;
        let first = run(&repo_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["commit", "-q", "--allow-empty", "-m", "second"]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/b", "HEAD"]).await;
        let second = run(&repo_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        assert_ne!(first, second);

        let rows = super::git_remote_branches(repo_s.clone())
            .await
            .expect("list remote branches");
        let mut tips: Vec<(String, String)> = rows
            .iter()
            .map(|b| (b.name.clone(), b.tip.clone()))
            .collect();
        tips.sort();
        assert_eq!(
            tips,
            vec![("a".into(), first), ("b".into(), second.clone())]
        );
        let row = rows.into_iter().find(|b| b.name == "b").unwrap();
        assert_eq!(
            serde_json::to_value(&row).unwrap(),
            serde_json::json!({
                "name": "b",
                "remote": "origin",
                "lastCommitDate": row.last_commit_date,
                "tip": second,
            })
        );
    }
}
