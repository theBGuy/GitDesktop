pub mod actions;
pub mod auth;
pub mod avatar;
pub mod collaborators;
pub mod discussion;
pub mod insights;
pub mod issue;
pub mod lifecycle;
pub mod mcp_search;
pub mod pages;
pub mod pr;
pub mod project;
pub mod release;
pub mod repo_settings;
pub mod rulesets;
pub mod runner;
pub mod secrets;
pub mod security;
pub mod security_findings;

use crate::error::{AppError, AppResult};

/// The `owner/repo` slug of the checked-out repo's **origin** remote, to pass
/// explicitly as `gh -R <slug>`.
///
/// A bare `gh` call with only the repo path as CWD lets gh auto-resolve the
/// repo. On a fork with an `upstream` remote, that resolution prefers the
/// PARENT — so an unpinned call answers for the upstream repo instead of the
/// user's fork (the Actions surface would show the parent's runs; the fork-badge
/// probe would read the parent's `isFork: false`). Pinning the origin slug keeps
/// every gh call on the fork. For a single-remote repo the slug equals what gh
/// resolved before, so behavior is unchanged there.
///
/// Reuses the cached origin-URL lookup (no extra `git` spawn within its TTL) and
/// the shared origin-path parser, which already strips `.git` and handles both
/// `https://…` and scp-style `git@github.com:owner/repo` URLs. A GitHub origin
/// path is exactly `owner/repo`; the callers can't work without a GitHub origin,
/// so no origin / an unparseable one is a clear error (`AppError::Gh`).
///
/// This is the origin-pinned entry point (100+ call sites across
/// actions/releases/settings/discussions rely on it), kept as a thin delegate to
/// [`gh_lens_slug`] with no lens so those surfaces stay on the fork.
pub(crate) async fn gh_origin_slug(repo_path: &str) -> AppResult<String> {
    gh_lens_slug(repo_path, None).await
}

/// Resolve a GitHub `owner/repo` slug through a validated **remote lens** — the
/// fork-identity Part B primitive. `lens` is `None` (defaults to `origin`),
/// `Some("origin")`, or `Some("upstream")`; anything else is rejected before any
/// git spawn. The `upstream` lens lets a fork user address the PARENT repo's
/// PRs/issues without disturbing the origin-pinning that Part A (#56) established
/// for every other surface.
///
/// Resolves `git_remote_url(repo_path, remote)` for `remote = lens.unwrap_or("origin")`,
/// then the shared origin-path parser (strips `.git`, handles `https://…` and
/// scp-style URLs). The error NAMES the remote it failed on so a missing
/// `upstream` on a non-fork clone reads clearly. `git_remote_url`'s TTL cache is
/// keyed by (repo, name), so each lens caches independently — no extra work here.
///
/// This is also where the slug is grammar-checked ([`valid_github_slug`]): every
/// `gh` spawn resolves its slug here or through [`gh_origin_slug`], so the 100+
/// `repos/{slug}/…` endpoint sites inherit the guard and none re-check it.
pub(crate) async fn gh_lens_slug(repo_path: &str, lens: Option<&str>) -> AppResult<String> {
    let remote = lens_remote(lens)?;
    let url =
        crate::git::remote::git_remote_url(repo_path.to_string(), remote.to_string()).await?;
    let slug = crate::forge::remote_path(&url).ok_or_else(|| {
        AppError::Gh(format!(
            "could not determine the GitHub repository from the {remote} remote"
        ))
    })?;
    if !valid_github_slug(&slug) {
        return Err(AppError::Gh(format!(
            "the {remote} remote's repository path {slug:?} isn't a valid GitHub owner/repo slug"
        )));
    }
    Ok(slug)
}

/// Whether a slug is safe to interpolate into a `gh api` endpoint and to pass as
/// `gh -R <slug>` argv: gh expands `{…}` in an endpoint and splits it on `?`/`#`
/// (query/fragment), a leading `-` reads as a flag, and `.`/`..` traverse the path.
fn valid_github_slug(slug: &str) -> bool {
    let Some((owner, repo)) = slug.split_once('/') else {
        return false;
    };
    crate::forge::validate_owner(owner).is_ok() && crate::forge::validate_repo_name(repo).is_ok()
}

/// Validate a lens value and map it to the git remote name it resolves. Pure —
/// the network-free half of [`gh_lens_slug`], split out so it can be unit-tested.
/// `None`/`Some("origin")` → `"origin"`, `Some("upstream")` → `"upstream"`;
/// anything else is an `InvalidArgument` before any git spawn.
pub(crate) fn lens_remote(lens: Option<&str>) -> AppResult<&'static str> {
    match lens {
        None | Some("origin") => Ok("origin"),
        Some("upstream") => Ok("upstream"),
        Some(other) => Err(AppError::InvalidArgument(format!(
            "unknown remote lens: {other}"
        ))),
    }
}

/// The fork owner (the part before `/`) of an `owner/repo` slug — the `<user>` in
/// `gh pr create --head <user>:<branch>` for the upstream-lens fork flow. Pure.
pub(crate) fn fork_owner_of(slug: &str) -> &str {
    slug.split('/').next().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{fork_owner_of, lens_remote, valid_github_slug};

    #[test]
    fn lens_remote_accepts_none_origin_upstream() {
        assert_eq!(lens_remote(None).unwrap(), "origin");
        assert_eq!(lens_remote(Some("origin")).unwrap(), "origin");
        assert_eq!(lens_remote(Some("upstream")).unwrap(), "upstream");
    }

    #[test]
    fn lens_remote_rejects_junk() {
        for junk in ["fork", "", "ORIGIN", "upstream ", "origin/x"] {
            let err = lens_remote(Some(junk)).unwrap_err();
            assert!(
                matches!(err, crate::error::AppError::InvalidArgument(_)),
                "expected InvalidArgument for {junk:?}, got {err:?}"
            );
        }
    }

    #[test]
    fn fork_owner_extracts_owner_before_slash() {
        assert_eq!(fork_owner_of("PhoenixMputu/biome"), "PhoenixMputu");
        assert_eq!(fork_owner_of("octocat/hello-world"), "octocat");
        // A malformed slug with no slash yields the whole string (gh then errors).
        assert_eq!(fork_owner_of("nowhere"), "nowhere");
        assert_eq!(fork_owner_of(""), "");
    }

    #[test]
    fn valid_github_slug_accepts_real_slugs() {
        for slug in [
            "theBGuy/GitDesktop",
            "octo-cat/hello.world_2",
            "a1/b2",
            "user/repo-name.js",
        ] {
            assert!(valid_github_slug(slug), "{slug:?} should be accepted");
        }
    }

    #[test]
    fn valid_github_slug_refuses_unaddressable_slugs() {
        for slug in [
            // Endpoint-retargeting characters: gh expands `{…}` and splits on `?`/`#`.
            "own{er}/repo",
            "owner/rep}o",
            "owner/re?po",
            "owner/re#po",
            "owner/re po",
            "a/b%7D",
            // Shape: exactly one slash, both segments present.
            "a/b/c",
            "a",
            "",
            "/repo",
            "owner/",
            // A leading `-` reads as a flag in `gh -R <slug>` argv.
            "-x/y",
            "x/-y",
            // Dot segments traverse the endpoint path.
            "./x",
            "x/..",
        ] {
            assert!(!valid_github_slug(slug), "{slug:?} should be refused");
        }
    }
}
