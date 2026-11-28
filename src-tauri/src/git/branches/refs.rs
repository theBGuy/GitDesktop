use super::*;

/// HEAD's branch as its full ref (`refs/heads/<name>`), or `None` when HEAD is
/// detached. Read with `symbolic-ref`, never `rev-parse --abbrev-ref`: the short form
/// disambiguates, so a branch shadowed by a same-named tag reads `heads/<name>` (or the
/// full ref, when that is ambiguous too). An UNBORN branch still answers here — sites
/// that must refuse before the first commit check `git::history::unborn_head`. Any
/// other failure (not a repository, git missing) is an `Err`.
pub(crate) async fn current_branch_ref(repo_path: &str) -> AppResult<Option<String>> {
    let out = run_git_raw(
        Some(repo_path),
        &["symbolic-ref", "-q", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match out.code {
        0 => {
            let full = out.stdout_lossy();
            let full = full.trim_end_matches(['\r', '\n']);
            let named = full
                .strip_prefix("refs/heads/")
                .is_some_and(|name| !name.is_empty());
            Ok(named.then(|| full.to_string()))
        }
        // `-q` exits 1, silently, exactly when HEAD is not a symbolic ref.
        1 => Ok(None),
        code => Err(AppError::Git {
            code,
            stderr: out.full_failure_text(),
        }),
    }
}

/// The checked-out branch's NAME (what a branch argument, config key, refspec or
/// comparison against `status --branch` wants), with [`current_branch_ref`]'s
/// detached/unborn/error contract. A rev position takes the full ref instead: a bare
/// name resolves to a same-named tag first.
pub(crate) async fn current_branch_name(repo_path: &str) -> AppResult<Option<String>> {
    Ok(current_branch_ref(repo_path)
        .await?
        .and_then(|full| full.strip_prefix("refs/heads/").map(str::to_string)))
}

/// Whether HEAD names a branch with no commits yet (a fresh `git init`, an orphan
/// switch) — the state [`current_branch_name`] reports as an ordinary branch.
pub(crate) async fn head_is_unborn(repo_path: &str) -> AppResult<bool> {
    let out = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--verify", "-q", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(out.code != 0)
}

/// `name` for a REV position whose callers name LOCAL BRANCHES. A name git already
/// resolves to that branch stays as given (`merge` words its message from it: the full
/// ref would read "Merge branch 'refs/heads/x'"). When something else captures it, a
/// same-named tag first (gitrevisions checks refs/tags before refs/heads), the local
/// branch named exactly `name` is taken by its full ref, git's own `%(refname)`.
/// Anything that names no local branch (a remote-tracking ref, sha, rev expression)
/// passes through, as does a failed read, leaving each command's own error to surface.
/// An input already spelled as a full ref (`refs/...`) is returned untouched, so a
/// branch literally named `refs/heads/x` can never capture it. Callers validate `name`
/// first. Not for inputs that may legitimately be TAGS: a tag sharing a branch's name
/// would lose to the branch.
pub(crate) async fn branch_first_rev(repo_path: &str, name: &str) -> String {
    if name.starts_with("refs/") {
        return name.to_string();
    }
    // Ambiguous names answer empty on stdout with exit 0 (the error rides stderr).
    let resolved = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--symbolic-full-name", name],
        DEFAULT_TIMEOUT,
    )
    .await;
    if let Ok(out) = resolved {
        if out.code == 0 && out.stdout_lossy().trim().strip_prefix("refs/heads/") == Some(name) {
            return name.to_string();
        }
    }
    let listed = run_git_raw(
        Some(repo_path),
        &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        DEFAULT_TIMEOUT,
    )
    .await;
    let Ok(out) = listed else {
        return name.to_string();
    };
    if out.code != 0 {
        return name.to_string();
    }
    out.stdout_lossy()
        .lines()
        .find(|full| full.strip_prefix("refs/heads/") == Some(name))
        .map_or_else(|| name.to_string(), str::to_string)
}

/// The refusal for an operation that needs a commit on HEAD's branch.
pub(crate) fn unborn_head_error() -> AppError {
    AppError::InvalidArgument(
        "The current branch has no commits yet — commit on it, or switch to another branch, \
         first."
            .into(),
    )
}

/// A caller-supplied tip pin in the form the compare reads: a full object id (40 or 64
/// hex), lowercased. `update-ref` resolves a short old value as a rev and an empty one
/// skips its compare, so anything else is refused before git runs.
pub(crate) fn full_object_id(id: &str) -> AppResult<String> {
    if !matches!(id.len(), 40 | 64) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::InvalidArgument(
            "expected tip must be a full commit id (40 or 64 hex characters)".into(),
        ));
    }
    Ok(id.to_ascii_lowercase())
}

/// The commit `refs/heads/<name>` points at, `None` only from a run that listed no ref
/// of exactly that name; a failed run, or the ref listed without a commit, is an `Err`.
/// Unlike `rev-parse --verify`, the pattern takes neither a case variant nor the
/// `refs/heads/refs/heads/<name>` fallback, but it lists `<name>/…` children, so only the
/// exact line counts. A symbolic ref reads as its target's commit; a dangling one, and a
/// broken loose ref (git only warns and exits 0), read as absent.
pub(crate) async fn exact_branch_tip(repo_path: &str, name: &str) -> AppResult<Option<String>> {
    let full_ref = branch_full_ref(name)?;
    let out = run_git(
        Some(repo_path),
        &[
            "for-each-ref",
            "--format=%(refname)%00%(objectname)",
            &full_ref,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match exact_ref_field(&out.stdout_lossy(), &full_ref) {
        None => Ok(None),
        Some("") => Err(AppError::Command(format!(
            "git listed {full_ref} without a commit id."
        ))),
        Some(oid) => Ok(Some(oid.to_string())),
    }
}

/// The field after the NUL on the `for-each-ref` line whose refname is exactly
/// `full_ref`. An exact line without a NUL reads as an empty field, so the caller
/// refuses it rather than skipping it.
pub(super) fn exact_ref_field<'a>(stdout: &'a str, full_ref: &str) -> Option<&'a str> {
    stdout.lines().find_map(|line| {
        let (refname, field) = line.split_once('\0').unwrap_or((line, ""));
        (refname == full_ref).then_some(field)
    })
}

/// `refs/heads/<name>` for the delete's tip read and its `update-ref` target, never a
/// refspec; the name is validated here as well as at every entry point, as a branch
/// name, since a rev expression (`feat~1`) would resolve under `refs/heads/` to another
/// commit.
pub(super) fn branch_full_ref(name: &str) -> AppResult<String> {
    validate_branch_name(name)?;
    Ok(format!("refs/heads/{name}"))
}

/// Enumerate stored names so case-insensitive loose-ref lookups cannot alias a branch.
pub(crate) async fn branch_exists_exact(repo_path: &str, name: &str) -> AppResult<bool> {
    Ok(stored_branch_names(repo_path)
        .await?
        .iter()
        .any(|stored| stored == name))
}

/// Every stored branch name, from one `for-each-ref` over `refs/heads/`.
pub(super) async fn stored_branch_names(repo_path: &str) -> AppResult<Vec<String>> {
    let refs = run_git(
        Some(repo_path),
        &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(refs
        .stdout_lossy()
        .lines()
        .filter_map(|line| line.strip_prefix("refs/heads/"))
        .map(str::to_string)
        .collect())
}

/// The branch's tip for the exact name, or for a spelling the filesystem aliases to its
/// loose ref (a checkout's `Chore/z` for a stored `chore/z`), never git's ref-search
/// fallback or a tag; a failed exact read, or a failed `show-ref` spawn, is the `Err`.
/// Destructive callers read [`exact_branch_tip`].
pub(crate) async fn branch_tip_sha(repo_path: &str, branch: &str) -> AppResult<Option<String>> {
    if let Some(tip) = exact_branch_tip(repo_path, branch).await? {
        return Ok(Some(tip));
    }
    shown_branch_tip(repo_path, branch).await
}

/// `refs/heads/<name>` as `show-ref --verify` reads it: it opens the loose file by the
/// given spelling (so a case-insensitive filesystem may answer another spelling's file)
/// and, unlike `rev-parse`, searches no other prefix. Any non-zero exit is `None`.
pub(super) async fn shown_branch_tip(repo_path: &str, name: &str) -> AppResult<Option<String>> {
    let full_ref = branch_full_ref(name)?;
    let out = run_git_raw(
        Some(repo_path),
        &["show-ref", "--verify", "--hash", &full_ref],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(None);
    }
    Ok(full_object_id(out.stdout_lossy().trim()).ok())
}

/// One branch's upstream, read from its exact `for-each-ref` line.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BranchUpstream {
    /// Through `parse_upstream_tracking`.
    pub upstream: crate::git::remote::Upstream,
    /// `%(upstream:remotename)`.
    pub remote: String,
    /// `[gone]` in `%(upstream:track)`.
    pub gone: bool,
    /// `%(upstream)`: the full tracking ref, empty when git maps none (a fetch refspec
    /// that does not cover the upstream).
    pub tracking_ref: String,
}

impl BranchUpstream {
    /// The upstream's branch name when it is LIVE: a branch, on a named remote, not gone.
    /// A bare `branch.<b>.merge = <x>` is branch `<x>`.
    pub(crate) fn live_branch(&self) -> Option<&str> {
        match &self.upstream {
            crate::git::remote::Upstream::Branch(up)
                if crate::git::remote::is_named_remote(&self.remote) && !self.gone =>
            {
                Some(up)
            }
            _ => None,
        }
    }
}

/// `Ok(None)`: `branch` fails `validate_branch_name` (no spawn), or has no exact line. A
/// failed run is the `Err`.
pub(crate) async fn read_branch_upstream(
    repo_path: &str,
    branch: &str,
) -> AppResult<Option<BranchUpstream>> {
    if validate_branch_name(branch).is_err() {
        return Ok(None);
    }
    let full_ref = branch_full_ref(branch)?;
    let format = format!(
        "{}%00%(upstream)",
        crate::git::remote::UPSTREAM_TRACKING_FORMAT
    );
    let out = run_git(
        Some(repo_path),
        &["for-each-ref", &format, &full_ref],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(parse_branch_upstream(&out.stdout_lossy(), &full_ref))
}

/// The first line's upstream when its refname is exactly `full_ref` (the pattern also
/// lists `<branch>/…` children, which sort after it).
pub(super) fn parse_branch_upstream(stdout: &str, full_ref: &str) -> Option<BranchUpstream> {
    let (upstream, remote, gone) = crate::git::remote::parse_upstream_tracking(stdout, full_ref)?;
    let tracking_ref = stdout
        .lines()
        .next()
        .and_then(|line| {
            line.split('\0')
                .nth(crate::git::remote::UPSTREAM_TRACKING_FIELDS)
        })
        .unwrap_or("")
        .to_string();
    Some(BranchUpstream {
        upstream,
        remote,
        gone,
        tracking_ref,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        aliasing_fixture, delete_fixture, full_ref_tip, init_repo, is_aliased, run, temp_base,
    };

    #[test]
    fn parse_branch_upstream_reads_the_exact_line_and_its_tracking_ref() {
        use super::parse_branch_upstream;
        use crate::git::remote::Upstream;
        let own = "refs/heads/p\0refs/heads/p\0origin\0\0refs/remotes/origin/p\n\
                   refs/heads/p/child\0refs/heads/c\0origin\0\0refs/remotes/origin/c\n";
        let line = parse_branch_upstream(own, "refs/heads/p").unwrap();
        assert_eq!(line.upstream, Upstream::Branch("p".into()));
        assert_eq!((line.remote.as_str(), line.gone), ("origin", false));
        assert_eq!(line.tracking_ref, "refs/remotes/origin/p");
        let child_only = "refs/heads/p/child\0refs/heads/c\0origin\0\0refs/remotes/origin/c\n";
        assert_eq!(parse_branch_upstream(child_only, "refs/heads/p"), None);
        let gone = parse_branch_upstream(
            "refs/heads/g\0refs/heads/g\0origin\0[gone]\0\n",
            "refs/heads/g",
        )
        .unwrap();
        assert!(gone.gone && gone.live_branch().is_none());
        assert_eq!(gone.tracking_ref, "");
    }

    /// The branch-first read: an unambiguous branch keeps its name, a shadowed one
    /// becomes its full ref, and names of no local branch pass through untouched.
    #[tokio::test]
    async fn branch_first_rev_qualifies_only_a_shadowed_branch() {
        let (_base, base_dir) = temp_base("branch-first-rev");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "plain"]).await;
        run(&repo_s, &["branch", "shadowed"]).await;
        run(&repo_s, &["tag", "shadowed"]).await;
        run(&repo_s, &["tag", "v1"]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        // A branch literally named `refs/heads/plain` must not capture that full ref.
        run(
            &repo_s,
            &["update-ref", "refs/heads/refs/heads/plain", "HEAD"],
        )
        .await;

        let mut got = Vec::new();
        for name in [
            "plain",
            "shadowed",
            "v1",
            "origin/main",
            "HEAD~0",
            "nope",
            "refs/heads/plain",
        ] {
            got.push(super::branch_first_rev(&repo_s, name).await);
        }
        assert_eq!(
            got,
            [
                "plain",
                "refs/heads/shadowed",
                "v1",
                "origin/main",
                "HEAD~0",
                "nope",
                "refs/heads/plain"
            ]
        );
    }

    #[test]
    fn exact_ref_field_reads_only_the_line_naming_the_ref() {
        let full_ref = "refs/heads/feat";
        assert_eq!(
            exact_ref_field("refs/heads/feat\0abc\n", full_ref),
            Some("abc")
        );
        assert_eq!(
            exact_ref_field("refs/heads/feat/sub\0abc\nrefs/heads/feat\0def\n", full_ref),
            Some("def")
        );
        for other in [
            "refs/heads/feat/sub\0abc\n",
            "refs/heads/Feat\0abc\n",
            "refs/heads/feature\0abc\n",
            "",
        ] {
            assert_eq!(exact_ref_field(other, full_ref), None, "{other:?}");
        }
        assert_eq!(exact_ref_field("refs/heads/feat\0\n", full_ref), Some(""));
        assert_eq!(exact_ref_field("refs/heads/feat\n", full_ref), Some(""));
    }

    #[tokio::test]
    async fn exact_branch_tip_reads_a_packed_ref() {
        let (_g, repo, feat, _head) = delete_fixture("tip-packed").await;
        run(&repo, &["pack-refs", "--all"]).await;
        let loose = std::path::Path::new(&repo).join(".git/refs/heads/feat");
        assert!(!loose.exists(), "fixture sanity: feat is packed only");
        assert_eq!(exact_branch_tip(&repo, "feat").await.unwrap(), Some(feat));
    }

    /// `for-each-ref refs/heads/topic` lists `topic/x` too; only an exact line counts.
    #[tokio::test]
    async fn exact_branch_tip_reads_no_branch_for_a_slash_prefix() {
        let (_g, repo, feat, _head) = delete_fixture("tip-slash-prefix").await;
        run(&repo, &["branch", "topic/x", &feat]).await;
        assert_eq!(exact_branch_tip(&repo, "topic").await.unwrap(), None);
        assert_eq!(
            exact_branch_tip(&repo, "topic/x").await.unwrap(),
            Some(feat)
        );
    }

    #[tokio::test]
    async fn exact_branch_tip_fails_outside_a_repository() {
        let (_g, base) = temp_base("tip-no-repo");
        let dir = base.to_string_lossy().into_owned();
        assert!(exact_branch_tip(&dir, "feat").await.is_err());
    }

    /// `branch_tip_sha` answers an aliased spelling through the loose file, never git's
    /// ref-search fallback or a tag. Returns early on a case-sensitive filesystem or a
    /// non-files ref backend, as above.
    #[tokio::test]
    async fn branch_tip_sha_reads_an_aliased_spelling() {
        let (_g, repo) = aliasing_fixture("tip-alias").await;
        run(&repo, &["branch", "Chore/z"]).await;
        run(&repo, &["update-ref", "refs/heads/refs/heads/Fb", "HEAD"]).await;
        run(&repo, &["tag", "Tg"]).await;
        if !is_aliased(&repo, "Chore/z").await {
            return;
        }
        let tip = full_ref_tip(&repo, "HEAD").await.unwrap();
        assert_eq!(
            full_ref_tip(&repo, "refs/heads/Fb").await,
            Some(tip.clone()),
            "fixture sanity: rev-parse takes the fallback"
        );

        assert_eq!(
            branch_tip_sha(&repo, "Chore/z").await.unwrap(),
            Some(tip.clone())
        );
        assert_eq!(branch_tip_sha(&repo, "chore/z").await.unwrap(), Some(tip));
        assert_eq!(branch_tip_sha(&repo, "Nope").await.unwrap(), None);
        assert_eq!(branch_tip_sha(&repo, "Fb").await.unwrap(), None);
        assert_eq!(branch_tip_sha(&repo, "Tg").await.unwrap(), None);
    }
}
