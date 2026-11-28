use super::*;

/// How many refs one reflog read names.
pub(super) const REFLOG_BATCH: usize = 64;

/// One spawn over at most [`REFLOG_BATCH`] full refs: each ref's subjects, newest first.
/// `--no-show-signature` keeps `log.showSignature` from running gpg per entry; the trailing
/// `--` keeps a tracked path spelled like a ref from failing the read. One missing ref fails
/// the whole call.
pub(super) async fn read_reflog_subjects(
    repo_path: &str,
    full_refs: &[String],
) -> AppResult<std::collections::HashMap<String, Vec<String>>> {
    let mut args = vec![
        "reflog",
        "show",
        "--no-show-signature",
        "--format=%gD%x09%gs",
    ];
    args.extend(full_refs.iter().map(String::as_str));
    args.push("--");
    let out = run_git(Some(repo_path), &args, DEFAULT_TIMEOUT).await?;
    Ok(parse_reflog_batch(&out.stdout_lossy()))
}

/// `<full ref>@{N}<TAB><subject>` lines into each ref's subjects, in line order; refs may
/// arrive in any order. The selector's ref is the text before its last `@{`; a line without
/// a tab or without `@{` is skipped.
fn parse_reflog_batch(stdout: &str) -> std::collections::HashMap<String, Vec<String>> {
    let mut map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for line in stdout.lines() {
        let Some((selector, subject)) = line.split_once('\t') else {
            continue;
        };
        let Some(at) = selector.rfind("@{") else {
            continue;
        };
        map.entry(selector[..at].to_string())
            .or_default()
            .push(subject.to_string());
    }
    map
}

/// `branch`'s earlier names from its reflog subjects (newest first), most recent first.
/// The walk stops at the first `branch: Created from` entry: a rename chain lies above its
/// own creation. Only the whole `Branch: renamed refs/heads/<from> to refs/heads/<to>` form
/// counts, with `<to>` equal to the current name ignoring case (a folding disk can store a
/// folder-case variant).
pub(super) fn previous_branch_names(subjects: &[String], branch: &str) -> Vec<String> {
    let mut current = branch.to_string();
    let mut names = Vec::new();
    for subject in subjects {
        if subject.starts_with("branch: Created from") {
            break;
        }
        let Some((from, to)) = subject
            .strip_prefix("Branch: renamed refs/heads/")
            .and_then(|rest| rest.split_once(" to refs/heads/"))
        else {
            continue;
        };
        if from.is_empty() || to.is_empty() || from.contains(' ') || to.contains(' ') {
            continue;
        }
        if eq_ignoring_case(to, &current) {
            names.push(from.to_string());
            current = from.to_string();
        }
    }
    names
}

/// A local branch that is a renamed copy of the remote branch it still tracks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenamedCopy {
    pub remote: String,
    pub upstream_branch: String,
    /// True when the local `refs/remotes/<remote>/HEAD` names a `refs/` ref that exists (the
    /// predicate having answered, it does not name the upstream); false otherwise (absent,
    /// dangling or outside `refs/`), so the remote's default is unmeasured.
    pub default_measured: bool,
}

/// `Some` only when ALL hold: `branch`'s upstream is LIVE; that branch's name differs from
/// `branch`; that name is, exactly, one of `branch`'s own previous names by its reflog; and
/// the upstream is not measured as the remote's default branch. `None` in every other case
/// (a name failing `validate_branch_name`, no upstream, gone, local `.`, same name, no
/// reflog, a start-point branch of any kind). A failed read is that read's error. Not
/// detected, each read as not a renamed copy: `git branch -c` copies (`Branch:
/// copied …`), rename entries older than the reflog expiry (`gc.reflogExpire`, about 90
/// days by default), and clients writing another subject form. The upstream is read first,
/// so a variant spelling finds no exact line and never reads the reflog.
pub(crate) async fn renamed_copy_of(
    repo_path: &str,
    branch: &str,
) -> AppResult<Option<RenamedCopy>> {
    if validate_branch_name(branch).is_err() {
        return Ok(None);
    }
    let Some(line) = read_branch_upstream(repo_path, branch).await? else {
        return Ok(None);
    };
    let Some(up) = line.live_branch() else {
        return Ok(None);
    };
    if up == branch {
        return Ok(None);
    }
    let target = crate::git::remote::remote_head_target(repo_path, &line.remote).await?;
    if crate::git::remote::upstream_is_remote_default(target.as_deref(), &line.tracking_ref)
        == Some(true)
    {
        return Ok(None);
    }
    let full_ref = branch_full_ref(branch)?;
    let subjects = read_reflog_subjects(repo_path, std::slice::from_ref(&full_ref)).await?;
    let subjects = subjects.get(&full_ref).map_or(&[][..], Vec::as_slice);
    if !previous_branch_names(subjects, branch)
        .iter()
        .any(|name| name == up)
    {
        return Ok(None);
    }
    // `symbolic-ref` prints a dangling target with exit 0, so only a target that exists as
    // that exact ref measures the default; a failed read leaves it unmeasured. Never
    // `rev-parse`: it also resolves a branch or tag spelled like the target. Only a `refs/`
    // target reaches the argv: a root ref (`FETCH_HEAD`) never measures, and a
    // hand-written one can't be read as an option.
    let default_measured = match target.filter(|t| t.starts_with("refs/")) {
        Some(remote_head) => run_git_raw(
            Some(repo_path),
            &["show-ref", "--verify", "--quiet", &remote_head],
            DEFAULT_TIMEOUT,
        )
        .await
        .is_ok_and(|out| out.code == 0),
        None => false,
    };
    Ok(Some(RenamedCopy {
        remote: line.remote.clone(),
        upstream_branch: up.to_string(),
        default_measured,
    }))
}

/// Create PR's gate: the renamed copy whose create of `head` into `base` is refused, or
/// None. It refuses, with guidance, a renamed copy ([`renamed_copy_of`]: a reflog rename
/// entry, an upstream under a different name) of an origin branch that is neither `base`
/// nor origin's default; a branch that tracks its start point is never refused here (its
/// reflog holds no rename entry). Every create
/// push on every forge, and the MCP tool's, runs behind it. With no local
/// `refs/remotes/origin/HEAD` the default is read live; that read's failure is the `Err`.
pub(crate) async fn renamed_copy_refusing_create(
    repo_path: &str,
    head: &str,
    base: &str,
) -> AppResult<Option<RenamedCopy>> {
    if validate_branch_name(head).is_err() {
        return Ok(None);
    }
    let Some(copy) = renamed_copy_of(repo_path, head).await? else {
        return Ok(None);
    };
    if copy.remote != "origin" || copy.upstream_branch == base {
        return Ok(None);
    }
    if copy.default_measured {
        return Ok(Some(copy));
    }
    match live_remote_default(repo_path, "origin").await? {
        Some(target)
            if target.strip_prefix("refs/heads/") == Some(copy.upstream_branch.as_str()) =>
        {
            Ok(None)
        }
        _ => Ok(Some(copy)),
    }
}

#[cfg(test)]
mod tests {
    use crate::git::branches::tests::{copy_repo, git_ok, pin_remote_head, run, tracking_branch};

    #[test]
    fn previous_branch_names_walks_renames_above_the_creation_entry() {
        use super::previous_branch_names;
        let walk = |subjects: &[&str], branch: &str| {
            let subjects: Vec<String> = subjects.iter().map(|s| s.to_string()).collect();
            previous_branch_names(&subjects, branch)
        };
        let created = "branch: Created from main";
        let renamed = "Branch: renamed refs/heads/old to refs/heads/new";
        assert_eq!(walk(&[renamed, created], "new"), ["old"]);
        assert_eq!(
            walk(
                &[
                    "Branch: renamed refs/heads/mid to refs/heads/new",
                    "Branch: renamed refs/heads/old to refs/heads/mid",
                    created,
                ],
                "new"
            ),
            ["mid", "old"]
        );
        assert_eq!(
            walk(
                &["Branch: renamed refs/heads/new to refs/heads/New", renamed],
                "New"
            ),
            ["new", "old"]
        );
        // A stale rename entry under a creation entry is never reached.
        assert!(walk(&[created, renamed], "new").is_empty());
        assert!(walk(
            &["branch: Created from refs/remotes/origin/topic", renamed],
            "new"
        )
        .is_empty());
        assert_eq!(
            walk(&["commit: x", renamed, "branch: Created from HEAD"], "new"),
            ["old"]
        );
        assert_eq!(
            walk(
                &["Branch: renamed refs/heads/old to refs/heads/Feat/x"],
                "feat/x"
            ),
            ["old"]
        );
        for skipped in [
            "commit: Branch: renamed refs/heads/a to refs/heads/new",
            "branch: renamed refs/heads/a to refs/heads/new",
            "Branch: copied refs/heads/a to refs/heads/new",
            "Branch: renamed refs/heads/a b to refs/heads/new",
            "Branch: renamed refs/heads/ to refs/heads/new",
        ] {
            assert!(walk(&[skipped], "new").is_empty(), "{skipped}");
        }
    }

    #[test]
    fn parse_reflog_batch_groups_each_ref_newest_first() {
        use super::parse_reflog_batch;
        let out = "refs/heads/b@{0}\tBranch: renamed refs/heads/a to refs/heads/b\n\
                   refs/heads/b@{1}\tbranch: Created from main\n\
                   refs/heads/x@{y@{0}\tcommit: a\tb\n\
                   refs/heads/a2@{0}\tcommit: c\n\
                   no tab here\n\
                   refs/heads/q\tno selector\n";
        let map = parse_reflog_batch(out);
        assert_eq!(
            map.get("refs/heads/b").unwrap(),
            &[
                "Branch: renamed refs/heads/a to refs/heads/b",
                "branch: Created from main"
            ]
        );
        assert_eq!(map.get("refs/heads/x@{y").unwrap(), &["commit: a\tb"]);
        assert_eq!(map.get("refs/heads/a2").unwrap(), &["commit: c"]);
        assert_eq!(map.len(), 3, "{map:?}");
        assert!(parse_reflog_batch("").is_empty());
    }

    #[tokio::test]
    async fn renamed_copy_of_reads_the_reflog_behind_a_live_upstream() {
        use super::{read_branch_upstream, renamed_copy_of, RenamedCopy};
        let (_g, base, repo) = copy_repo("renamed-copy").await;
        let copy = |up: &str, measured: bool| {
            Some(RenamedCopy {
                remote: "origin".into(),
                upstream_branch: up.into(),
                default_measured: measured,
            })
        };
        tracking_branch(&repo, "old", "old").await;
        run(&repo, &["branch", "-m", "old", "new"]).await;
        tracking_branch(&repo, "c1", "c1").await;
        run(&repo, &["branch", "-m", "c1", "mid"]).await;
        run(&repo, &["branch", "-m", "mid", "chain"]).await;
        tracking_branch(&repo, "feat2", "feat1").await;
        tracking_branch(&repo, "hotfix", "release-1.2").await;
        tracking_branch(&repo, "dflt", "dflt").await;
        run(&repo, &["branch", "-m", "dflt", "dcopy"]).await;
        tracking_branch(&repo, "same", "same").await;
        tracking_branch(&repo, "g", "g").await;
        run(&repo, &["branch", "-m", "g", "gone"]).await;
        run(&repo, &["update-ref", "-d", "refs/remotes/origin/g"]).await;
        run(&repo, &["branch", "--track", "lo", "main"]).await;
        run(&repo, &["branch", "-m", "lo", "lo2"]).await;
        tracking_branch(&repo, "feat", "feat").await;
        run(&repo, &["branch", "-M", "feat", "Feat"]).await;
        tracking_branch(&repo, "ob", "ob").await;
        run(&repo, &["config", "branch.ob.merge", "ob"]).await;
        run(&repo, &["branch", "-m", "ob", "nb"]).await;
        run(&repo, &["branch", "par/child"]).await;
        run(&repo, &["config", "core.logAllRefUpdates", "false"]).await;
        tracking_branch(&repo, "nl", "nl").await;
        run(&repo, &["branch", "-m", "nl", "nolog"]).await;

        pin_remote_head(&repo, None).await;
        assert_eq!(
            renamed_copy_of(&repo, "new").await.unwrap(),
            copy("old", false)
        );
        assert_eq!(
            renamed_copy_of(&repo, "chain").await.unwrap(),
            copy("c1", false)
        );
        assert_eq!(
            renamed_copy_of(&repo, "Feat").await.unwrap(),
            copy("feat", false)
        );
        // A bare `branch.<b>.merge = ob` lists with an empty `%(upstream:remoteref)` (and no
        // remote or track) under git 2.51.1, so it reads as untracked: no renamed copy.
        assert_eq!(renamed_copy_of(&repo, "nb").await.unwrap(), None);
        // Unmeasured does not exclude: the default's renamed copy still answers.
        assert_eq!(
            renamed_copy_of(&repo, "dcopy").await.unwrap(),
            copy("dflt", false)
        );
        for none in [
            "feat2", "hotfix", "same", "gone", "lo2", "nolog", "missing", "main", "par",
        ] {
            assert_eq!(renamed_copy_of(&repo, none).await.unwrap(), None, "{none}");
        }
        pin_remote_head(&repo, Some("dflt")).await;
        assert_eq!(renamed_copy_of(&repo, "dcopy").await.unwrap(), None);
        assert_eq!(
            renamed_copy_of(&repo, "new").await.unwrap(),
            copy("old", true)
        );
        // A dangling origin/HEAD: `symbolic-ref --quiet` still prints its target.
        let dangling = "refs/remotes/origin/nope";
        run(
            &repo,
            &["symbolic-ref", "refs/remotes/origin/HEAD", dangling],
        )
        .await;
        assert!(!git_ok(&repo, &["rev-parse", "--verify", "-q", dangling]).await);
        assert_eq!(
            renamed_copy_of(&repo, "new").await.unwrap(),
            copy("old", false),
            "a dangling default is unmeasured"
        );
        // A branch spelled like the target: `rev-parse` resolves it, the exact read does not.
        run(&repo, &["branch", dangling]).await;
        let peel = "refs/remotes/origin/nope^{commit}";
        assert!(git_ok(&repo, &["rev-parse", "--verify", "-q", peel]).await);
        assert_eq!(
            renamed_copy_of(&repo, "new").await.unwrap(),
            copy("old", false),
            "a branch named like the dangling target measures nothing"
        );
        run(&repo, &["fetch", "-q", "origin"]).await;
        run(
            &repo,
            &["symbolic-ref", "refs/remotes/origin/HEAD", "FETCH_HEAD"],
        )
        .await;
        assert!(
            git_ok(&repo, &["show-ref", "--verify", "--quiet", "FETCH_HEAD"]).await,
            "the old argv would measure FETCH_HEAD"
        );
        assert_eq!(
            renamed_copy_of(&repo, "new").await.unwrap(),
            copy("old", false),
            "a root ref target is unmeasured"
        );
        pin_remote_head(&repo, Some("dflt")).await;
        // Validation refuses before any spawn, so a non-repository answers too.
        let nowhere = base.to_string_lossy().into_owned();
        assert_eq!(renamed_copy_of(&nowhere, "a~1").await.unwrap(), None);
        assert!(renamed_copy_of(&nowhere, "new").await.is_err());

        assert_eq!(read_branch_upstream(&repo, "par").await.unwrap(), None);
        run(
            &repo,
            &[
                "config",
                "--replace-all",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/mapped/*",
            ],
        )
        .await;
        run(
            &repo,
            &["update-ref", "refs/remotes/origin/mapped/n", "HEAD"],
        )
        .await;
        run(&repo, &["branch", "n"]).await;
        run(&repo, &["config", "branch.n.remote", "origin"]).await;
        run(&repo, &["config", "branch.n.merge", "refs/heads/n"]).await;
        let mapped = read_branch_upstream(&repo, "n").await.unwrap().unwrap();
        assert_eq!(mapped.tracking_ref, "refs/remotes/origin/mapped/n");
        run(
            &repo,
            &[
                "config",
                "--replace-all",
                "remote.origin.fetch",
                "+refs/heads/main:refs/remotes/origin/main",
            ],
        )
        .await;
        let narrow = read_branch_upstream(&repo, "n").await.unwrap().unwrap();
        assert_eq!(narrow.tracking_ref, "");
    }
}
