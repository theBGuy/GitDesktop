use crate::error::{AppError, AppResult};
use crate::git::blob_sizes::{side_id, BlobSizes};
use crate::github::runner::{gh_output_ok, run_gh, GhOutput, GH_NETWORK_TIMEOUT};
use crate::github::{gh_lens_slug, gh_unreadable, lens_remote};

const UNKNOWN: BlobSizes = BlobSizes {
    old_size: None,
    new_size: None,
};

/// Resolve only local remote metadata. Missing or unparseable remotes, and a lens remote
/// whose host isn't github.com, stay unknown; failed Git reads remain errors so callers
/// never cache a transient failure as null.
async fn sizes_repo_slug(repo: &str, lens: Option<&str>) -> AppResult<Option<String>> {
    let remote = lens_remote(lens)?;
    let url = match crate::git::remote::git_remote_url(repo.to_string(), remote.to_string()).await {
        Ok(url) => url,
        Err(AppError::Git { stderr, .. }) if no_such_remote(&stderr) => return Ok(None),
        Err(error) => return Err(error),
    };
    // The query pins github.com (run_gh would aim it at origin's login host), so the
    // selected lens must name that host.
    if crate::forge::remote_host(&url).as_deref() != Some("github.com") {
        return Ok(None);
    }
    match gh_lens_slug(repo, lens).await {
        Ok(slug) => Ok(Some(slug)),
        Err(AppError::Gh(_)) => Ok(None),
        Err(error) => Err(error),
    }
}

// Matches the repo's other missing-remote checks: git before 2.30 died with
// `fatal: No such remote`, current git prints `error: No such remote`.
fn no_such_remote(stderr: &str) -> bool {
    stderr.contains("No such remote")
}

fn sizes_query(old: Option<&str>, new: Option<&str>) -> String {
    let mut query =
        String::from("query($owner:String!,$name:String!){repository(owner:$owner,name:$name){");
    for (alias, id) in [("o", old), ("n", new)] {
        if let Some(id) = id {
            query.push_str(&format!(
                "{alias}:object(expression:\"{id}\"){{__typename ... on Blob{{oid byteSize}}}} "
            ));
        }
    }
    query.push_str("}}");
    query
}

/// Sizes from GitHub's selected repository lens. Unknown objects stay null per
/// side; transport, authentication, rate-limit and unreadable-body failures error.
#[tauri::command]
pub async fn github_blob_sizes(
    repo_path: String,
    old_oid: Option<String>,
    new_oid: Option<String>,
    lens: Option<String>,
) -> AppResult<BlobSizes> {
    let old = side_id(old_oid)?;
    let new = side_id(new_oid)?;
    lens_remote(lens.as_deref())?;
    if old.is_none() && new.is_none() {
        return Ok(UNKNOWN);
    }
    let Some(slug) = sizes_repo_slug(&repo_path, lens.as_deref()).await? else {
        return Ok(UNKNOWN);
    };
    // gh_lens_slug validates the owner/name grammar before this split.
    let (owner, name) = slug
        .split_once('/')
        .ok_or_else(|| AppError::InvalidArgument("invalid GitHub repository slug".into()))?;
    let args = sizes_args(&sizes_query(old.as_deref(), new.as_deref()), owner, name);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await;
    github_sizes_outcome(result, old.as_deref(), new.as_deref())
}

/// An explicit `--hostname` outranks run_gh's `GH_HOST` pin to origin's login host,
/// which would send a github.com lens slug to origin's (possibly GHE) host.
fn sizes_args(query: &str, owner: &str, name: &str) -> Vec<String> {
    vec![
        "api".into(),
        "graphql".into(),
        "--hostname".into(),
        "github.com".into(),
        "-f".into(),
        format!("query={query}"),
        "-f".into(),
        format!("owner={owner}"),
        "-f".into(),
        format!("name={name}"),
    ]
}

fn alias_size(value: Option<&serde_json::Value>, requested: Option<&str>) -> Option<u64> {
    let (value, requested) = (value?, requested?);
    if value.get("__typename")?.as_str()? != "Blob" {
        return None;
    }
    let oid = value.get("oid")?.as_str()?;
    if !matches!(oid.len(), 40 | 64)
        || !oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !oid
            .to_ascii_lowercase()
            .starts_with(&requested.to_ascii_lowercase())
    {
        return None;
    }
    // Byte sizes ride IPC as JS numbers; refuse values that cannot remain exact.
    value
        .get("byteSize")?
        .as_u64()
        .filter(|size| *size < (1u64 << 53))
}

fn github_sizes_outcome(
    result: AppResult<GhOutput>,
    old: Option<&str>,
    new: Option<&str>,
) -> AppResult<BlobSizes> {
    let out = result.and_then(gh_output_ok)?;
    let value: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|error| gh_unreadable("blob sizes", error.to_string()))?;
    if let Some(errors) = value.get("errors").and_then(serde_json::Value::as_array) {
        if !errors.is_empty() {
            return Err(gh_unreadable(
                "blob sizes",
                serde_json::json!(errors).to_string(),
            ));
        }
    }
    Ok(BlobSizes {
        old_size: alias_size(value.pointer("/data/repository/o"), old),
        new_size: alias_size(value.pointer("/data/repository/n"), new),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::runner::{run_git, DEFAULT_TIMEOUT};
    use crate::github::test_support::{
        gh_output, ANSWERED_STDERR, HELD_REST_STDERR, NOT_FOUND_STDERR,
    };
    use serde_json::{json, Value};

    fn pair(sizes: BlobSizes) -> (Option<u64>, Option<u64>) {
        (sizes.old_size, sizes.new_size)
    }

    fn blob(oid: &str, size: Value) -> Value {
        json!({"__typename": "Blob", "oid": oid, "byteSize": size})
    }

    fn body(old: Value, new: Value) -> String {
        json!({"data": {"repository": {"o": old, "n": new}}}).to_string()
    }

    #[test]
    fn sizes_only_answer_for_matching_full_blob_ids() {
        let oid = format!("99c756e{}", "a".repeat(33));
        let text = body(blob(&oid, json!(90132)), json!({"__typename": "Commit"}));
        let result = github_sizes_outcome(gh_output(0, &text, ""), Some("99C756E"), Some("abcd"));
        assert_eq!(pair(result.unwrap()), (Some(90132), None));
        for width in [40, 64] {
            let oid = "A".repeat(width);
            let text = body(blob(&oid, json!(0)), blob(&oid, json!(42)));
            assert_eq!(
                pair(
                    github_sizes_outcome(gh_output(0, &text, ""), Some("aaaa"), Some("AAAA"))
                        .unwrap()
                ),
                (Some(0), Some(42))
            );
            assert_eq!(
                pair(github_sizes_outcome(gh_output(0, &text, ""), None, Some("bbbb")).unwrap()),
                (None, None)
            );
        }
    }

    #[test]
    fn unreadable_aliases_fail_closed_independently() {
        let oid = "a".repeat(40);
        for bad in [
            Value::Null,
            json!({"__typename": "Commit", "oid": oid, "byteSize": 7}),
            json!({"oid": oid, "byteSize": 7}),
            json!({"__typename": "Blob", "byteSize": 7}),
            json!({"__typename": "Blob", "oid": oid}),
            blob(&"b".repeat(40), json!(7)),
            blob("aaaa", json!(7)),
            blob(&format!("aaaa{}", "z".repeat(36)), json!(7)),
            blob(&oid, json!("7")),
            blob(&oid, json!(-1)),
            blob(&oid, json!(1.5)),
            blob(&oid, json!(true)),
            blob(&oid, Value::Null),
            blob(&oid, json!(u64::MAX)),
            blob(&oid, json!(1u64 << 53)),
            blob(&oid, serde_json::from_str("18446744073709551616").unwrap()),
        ] {
            let text = body(bad.clone(), blob(&oid, json!(7)));
            assert_eq!(
                pair(
                    github_sizes_outcome(gh_output(0, &text, ""), Some("aaaa"), Some("aaaa"))
                        .unwrap()
                ),
                (None, Some(7)),
                "{bad}"
            );
            let text = body(blob(&oid, json!(7)), bad.clone());
            assert_eq!(
                pair(
                    github_sizes_outcome(gh_output(0, &text, ""), Some("aaaa"), Some("aaaa"))
                        .unwrap()
                ),
                (Some(7), None),
                "{bad}"
            );
        }
        for text in ["{}", r#"{"data":null}"#, r#"{"data":{"repository":null}}"#] {
            assert_eq!(
                pair(
                    github_sizes_outcome(gh_output(0, text, ""), Some("aaaa"), Some("aaaa"))
                        .unwrap()
                ),
                (None, None)
            );
        }
        let max = (1u64 << 53) - 1;
        let text = body(blob(&oid, json!(max)), Value::Null);
        assert_eq!(
            pair(github_sizes_outcome(gh_output(0, &text, ""), Some("aaaa"), None).unwrap()),
            (Some(max), None)
        );
    }

    #[test]
    fn failures_never_become_unknown_sizes() {
        let text = body(blob(&"a".repeat(40), json!(7)), Value::Null);
        for stderr in [
            HELD_REST_STDERR,
            NOT_FOUND_STDERR,
            ANSWERED_STDERR,
            "failed to connect",
            "authentication required",
            "GraphQL: rate limit exceeded",
            "",
        ] {
            assert!(matches!(
                github_sizes_outcome(gh_output(1, &text, stderr), Some("aaaa"), None),
                Err(AppError::Gh(_))
            ));
        }
        for error in [
            AppError::GhNotFound,
            AppError::Timeout(120),
            AppError::Gh("transport failed".into()),
        ] {
            let expected = error.to_string();
            let result = github_sizes_outcome(Err(error), Some("aaaa"), None).unwrap_err();
            assert_eq!(result.to_string(), expected);
        }
        for text in [
            "garbage",
            r#"{"errors":[{"message":"denied"}],"data":null}"#,
        ] {
            let error =
                github_sizes_outcome(gh_output(0, text, ""), Some("aaaa"), None).unwrap_err();
            assert!(error
                .to_string()
                .starts_with("Couldn't read blob sizes from GitHub."));
        }
    }

    #[test]
    fn query_has_only_requested_aliases_and_variable_repo_identity() {
        let query = sizes_query(Some("abcd"), Some("1234"));
        assert!(query.starts_with("query($owner:String!,$name:String!)"));
        assert!(query.contains("repository(owner:$owner,name:$name)"));
        for (alias, id) in [("o", "abcd"), ("n", "1234")] {
            assert!(query.contains(&format!(
                "{alias}:object(expression:\"{id}\"){{__typename ... on Blob{{oid byteSize}}}}"
            )));
        }
        assert!(!sizes_query(None, Some("1234")).contains("o:object"));
        assert!(!sizes_query(Some("abcd"), None).contains("n:object"));
    }

    #[test]
    fn a_missing_remote_reads_as_unknown_in_either_git_wording() {
        for stderr in [
            "error: No such remote 'upstream'",
            "fatal: No such remote 'upstream'\n",
        ] {
            assert!(no_such_remote(stderr), "{stderr:?}");
        }
        for stderr in ["fatal: not a git repository", ""] {
            assert!(!no_such_remote(stderr), "{stderr:?}");
        }
    }

    #[test]
    fn sizes_args_pin_github_com() {
        let args = sizes_args("q", "owner", "name");
        let at = args.iter().position(|arg| arg == "--hostname");
        assert_eq!(
            at.and_then(|at| args.get(at + 1)).map(String::as_str),
            Some("github.com"),
            "{args:?}"
        );
        assert_eq!(&args[..2], ["api", "graphql"]);
        for field in ["query=q", "owner=owner", "name=name"] {
            let at = args.iter().position(|arg| arg == field).unwrap();
            assert_eq!(args[at - 1], "-f", "{field}");
        }
    }

    fn nowhere() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("missing").to_string_lossy().into_owned();
        (dir, repo)
    }

    #[tokio::test]
    async fn validation_precedes_every_early_return() {
        let (_dir, repo) = nowhere();
        for bad in ["", "abc", "abcd\n", "abcd:evil", "not-hex", &"a".repeat(65)] {
            for (old, new) in [
                (Some(bad.into()), None),
                (None, Some(bad.into())),
                (Some("0000".into()), Some(bad.into())),
            ] {
                assert!(
                    matches!(github_blob_sizes(repo.clone(), old, new, None).await,
                    Err(AppError::InvalidArgument(message)) if message.starts_with("invalid object id: "))
                );
            }
        }
        for (old, new) in [
            (None, None),
            (Some("0000".into()), None),
            (Some("abcd".into()), None),
        ] {
            assert!(matches!(
                github_blob_sizes(repo.clone(), old, new, Some("fork".into())).await,
                Err(AppError::InvalidArgument(message)) if message == "unknown remote lens: fork"
            ));
        }
        assert!(matches!(
            sizes_repo_slug(&repo, Some("fork")).await,
            Err(AppError::InvalidArgument(_))
        ));
        for lens in [None, Some("origin"), Some("upstream")] {
            for (old, new) in [(None, None), (Some("0000".into()), Some("0".repeat(64)))] {
                let result = github_blob_sizes(repo.clone(), old, new, lens.map(str::to_string))
                    .await
                    .unwrap();
                assert_eq!(pair(result), (None, None));
            }
            assert!(github_blob_sizes(
                repo.clone(),
                Some("abcd".into()),
                None,
                lens.map(str::to_string)
            )
            .await
            .is_err());
        }
    }

    async fn git(repo: &str, args: &[&str]) {
        run_git(Some(repo), args, DEFAULT_TIMEOUT).await.unwrap();
    }

    async fn remote_repo(origin: Option<&str>) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_string_lossy().into_owned();
        git(&repo, &["init", "-q"]).await;
        if let Some(url) = origin {
            git(&repo, &["remote", "add", "origin", url]).await;
        }
        (dir, repo)
    }

    #[tokio::test]
    async fn unavailable_remote_identities_return_unknown_without_gh() {
        for remote in [
            None,
            Some("https://gitlab.com/owner/repo.git"),
            Some("git@bitbucket.org:owner/repo.git"),
            Some("https://github.enterprise.example/owner/repo.git"),
            Some("not-a-url"),
            Some("https://github.com/owner/repo/extra"),
        ] {
            let (_dir, repo) = remote_repo(remote).await;
            let result = github_blob_sizes(repo, Some("abcd".into()), Some("1234".into()), None)
                .await
                .unwrap();
            assert_eq!(pair(result), (None, None), "{remote:?}");
        }
        let (_dir, repo) = remote_repo(Some("https://github.com/fork/project.git")).await;
        let result = github_blob_sizes(repo, Some("abcd".into()), None, Some("upstream".into()))
            .await
            .unwrap();
        assert_eq!(pair(result), (None, None));
    }

    #[tokio::test]
    async fn the_lens_selects_the_local_remote_slug() {
        let (_dir, repo) = remote_repo(Some("git@github.com:fork/project.git")).await;
        git(
            &repo,
            &[
                "remote",
                "add",
                "upstream",
                "https://github.com/parent/base.git",
            ],
        )
        .await;
        for (lens, expected) in [
            (None, "fork/project"),
            (Some("origin"), "fork/project"),
            (Some("upstream"), "parent/base"),
        ] {
            assert_eq!(
                sizes_repo_slug(&repo, lens).await.unwrap().as_deref(),
                Some(expected)
            );
        }
    }

    #[tokio::test]
    async fn only_the_selected_lens_host_may_target_github_com() {
        for upstream in [
            "https://gitlab.com/parent/base.git",
            "git@bitbucket.org:parent/base.git",
            "https://github.enterprise.example/parent/base.git",
            "https://github.com.evil.example/parent/base.git",
        ] {
            let (_dir, repo) = remote_repo(Some("https://github.com/fork/project.git")).await;
            git(&repo, &["remote", "add", "upstream", upstream]).await;
            assert_eq!(
                sizes_repo_slug(&repo, Some("origin"))
                    .await
                    .unwrap()
                    .as_deref(),
                Some("fork/project")
            );
            let result =
                github_blob_sizes(repo, Some("abcd".into()), None, Some("upstream".into()))
                    .await
                    .unwrap();
            assert_eq!(pair(result), (None, None), "{upstream}");
        }
        let (_dir, repo) = remote_repo(Some("https://gitlab.com/fork/project.git")).await;
        git(
            &repo,
            &[
                "remote",
                "add",
                "upstream",
                "https://GitHub.com/parent/base.git",
            ],
        )
        .await;
        assert_eq!(sizes_repo_slug(&repo, None).await.unwrap(), None);
        assert_eq!(
            sizes_repo_slug(&repo, Some("upstream"))
                .await
                .unwrap()
                .as_deref(),
            Some("parent/base")
        );
    }
}
