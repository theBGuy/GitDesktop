use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git, run_git_raw, DEFAULT_TIMEOUT, NETWORK_TIMEOUT};
use crate::git::types::{GitInfo, RepoInfo};
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoOwner {
    pub path: String,
    /// Owner parsed from the `origin` remote (e.g. "octocat"), or None when
    /// the repo has no origin remote.
    pub owner: Option<String>,
    /// The origin remote's host (e.g. "github.com", "gitlab.com"), parsed from
    /// the same URL — lets per-repo UI (the repo list's context menu) name the
    /// actual provider instead of guessing.
    pub host: Option<String>,
    /// The provider that host routes to ("github" / "gitlab" / "bitbucket"),
    /// including self-managed GitLab hosts glab is signed in to. `None` when
    /// there's no host or it's unrecognized (the UI labels those GitHub,
    /// matching the backend's gh-authoritative routing).
    pub provider: Option<String>,
    /// The repo name as the `origin` remote spells it (e.g. "GitDesktop") — the
    /// REMOTE identity, unlike `RepoInfo.name`, which is the checkout's folder
    /// basename and can differ (a renamed clone, a worktree directory). `None`
    /// when there's no origin remote or its URL doesn't parse.
    pub repo_name: Option<String>,
}

/// Owner segment + host + repo name of a git remote URL — handles
/// `https://host/owner/repo(.git)` and scp-style `git@host:owner/repo(.git)`.
/// None per component if it can't be parsed.
///
/// The owner is ONE segment — the one before the repo name — so a nested GitLab
/// group yields `sub`, not `group/sub`. This is the spelling persisted on
/// `RecentRepo.owner`, which the My work inbox's rows are matched against, so
/// `forge::gitlab`'s mapper is pinned against this function directly.
pub(crate) fn parse_owner_host(url: &str) -> (Option<String>, Option<String>, Option<String>) {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    // Split into host and the `owner/repo` path (scheme or scp form).
    let (host, path) = if let Some(idx) = url.find("://") {
        let rest = &url[idx + 3..];
        match rest.split_once('/') {
            Some((h, p)) => (h, p),
            None => return (None, None, None),
        }
    } else if let Some(colon) = url.rfind(':') {
        // A Windows drive-path remote (`C:\path\to\repo`, `C:/path/to/repo`)
        // looks like the scp form to `rfind(':')`, but the text before the colon
        // is a single drive letter — it has no owner/host. Bail so we don't
        // persist a bogus host ("c") + owner ("to") onto RecentRepo.
        let head = &url[..colon];
        if head.len() == 1 && head.as_bytes()[0].is_ascii_alphabetic() {
            return (None, None, None);
        }
        let host = head.rsplit('@').next().unwrap_or(head);
        (host, &url[colon + 1..])
    } else {
        return (None, None, None);
    };
    // Strip credentials and a port from the host.
    let host = host.rsplit('@').next().unwrap_or(host);
    // A bracketed IPv6 literal keeps its brackets — this host is persisted and compared
    // against `remote_host`'s spelling by the provider routing. A `:`-led suffix rides
    // the port slot and is dropped, like the bare arm drops it; a malformed bracket or
    // any other suffix yields no host rather than a truncated one that would mismatch
    // silently.
    let host = if host.starts_with('[') {
        crate::forge::bracketed_split(host)
            .filter(|(_, suffix)| suffix.is_empty() || suffix.starts_with(':'))
            .map_or("", |(span, _)| span)
    } else {
        host.split(':').next().unwrap_or(host)
    };
    let host = host.to_ascii_lowercase();
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    // owner is the segment immediately before the repo name; a single-segment
    // path carries neither, so both take the same guard.
    let owner = (segs.len() >= 2).then(|| segs[segs.len() - 2].to_string());
    let repo_name = (segs.len() >= 2).then(|| segs[segs.len() - 1].to_string());
    let host = (!host.is_empty()).then_some(host);
    (owner, host, repo_name)
}

/// Resolves the owner + host + provider for each repo path (from its `origin`
/// remote), batched so the repo list/switcher can group repos by owner in one
/// round-trip. The glab known-hosts config is read once for the whole batch.
#[tauri::command]
pub async fn git_repo_owners(repo_paths: Vec<String>) -> AppResult<Vec<RepoOwner>> {
    let glab_hosts = crate::forge::glab::known_hosts().await;
    let mut out = Vec::with_capacity(repo_paths.len());
    for path in repo_paths {
        let (owner, host, repo_name) = match run_git_raw(
            Some(&path),
            &["remote", "get-url", "origin"],
            DEFAULT_TIMEOUT,
        )
        .await
        {
            Ok(res) if res.code == 0 => parse_owner_host(res.stdout_lossy().trim()),
            _ => (None, None, None),
        };
        let provider = host
            .as_deref()
            .and_then(|h| crate::forge::provider_tag_for_host(h, &glab_hosts))
            .map(str::to_string);
        out.push(RepoOwner {
            path,
            owner,
            host,
            provider,
            repo_name,
        });
    }
    Ok(out)
}

/// A checkout's origin identity, read LIVE from the remote — the four axes the
/// open-time proof compares.
#[derive(Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoOrigin {
    /// The origin's host, in `crate::forge::remote_host`'s spelling — lowercased,
    /// PORT STRIPPED, a bracketed IPv6 literal keeping its brackets. That is the
    /// same function the inbox item's own `host` comes from, so the two compare
    /// without either side re-deriving it.
    pub host: String,
    /// The origin's full namespace path (`group/subgroup/name`, `.git` and
    /// surrounding slashes trimmed).
    pub path: String,
    /// The origin's web authority — `host[:port]`, the port present only when it
    /// is NOT the scheme's default (`crate::forge::web_authority`). `host` alone
    /// can't separate two instances that share a hostname on different ports,
    /// because it strips every port; this is the axis that can.
    ///
    /// Elision matches the browser `URL` spelling the caller parses the item's web
    /// URL with, so the two sides agree without either re-normalizing: `:443` on
    /// https and `:80` on http are dropped, any other web port is kept, and a
    /// TRANSPORT port (`ssh://…:2222`) is dropped entirely — it says nothing about
    /// where the web UI lives.
    pub authority: String,
    /// Which hosted integration a LANDING on this checkout would actually get —
    /// `"github"` / `"gitlab"` / `"bitbucket"`, or `""` when the path has no
    /// origin to classify.
    ///
    /// This answers "what would opening here resolve to", NOT "what forge is this
    /// really". The two can disagree: `crate::forge::detect_non_github` classifies
    /// from `glab`'s SAVED hosts, so a checkout on an instance implied only by a
    /// token plus glab's config-file default is unclassifiable and resolves to
    /// GitHub — the resilient default for an unknown host. Reporting that honestly
    /// is the point: the row can then refuse a landing that would open with the
    /// wrong integration, instead of the caller assuming agreement.
    pub provider: String,
}

/// The origin remote's identity — open-time proof that a matched checkout really
/// is the row's project, on all four axes.
///
/// Three of them are IDENTITY axes, each closing a distinct way the stored match
/// lies.
/// `parse_owner_host` keeps only ONE owner segment, so `team-a/sub/repo` and
/// `team-b/sub/repo` are indistinguishable by owner+name+host — `path` settles
/// that. The host in the match comes from the STORED `RecentRepo.host`, which
/// goes stale the moment a remote is re-pointed, so identical namespaces on two
/// different instances would pass a path-only proof — reading `host` live closes
/// that window. And `host` itself strips every port, so two instances sharing a
/// hostname on different ports still collide — `authority` is the axis that
/// separates them.
///
/// `provider` is a different KIND of axis: not an identity to compare, but the
/// integration a landing here would resolve to, so the caller can refuse an open
/// that would arrive under the wrong one (see the field's own note).
///
/// `""` for any axis the origin won't yield (and for every axis when there is no
/// origin at all): the caller reads an absent axis as UNPROVEN, never as a
/// mismatch, so a hostless origin proves nothing rather than matching everything.
///
/// Cost: one `detect_non_github`, which re-reads the origin remote through its
/// TTL cache — warm, since the line above just populated it for this same path —
/// plus glab's known-hosts config read for a host that isn't canonically GitHub,
/// GitLab or Bitbucket. Both are local and sit inside the caller's existing
/// open-time deadline.
#[tauri::command]
pub async fn repo_origin_path(repo_path: String) -> AppResult<RepoOrigin> {
    let Ok(url) =
        crate::git::remote::git_remote_url(repo_path.clone(), "origin".to_string()).await
    else {
        return Ok(RepoOrigin::default());
    };
    // The LANDING's own classifier (`resolve_status` dispatches on exactly this),
    // so the verdict is what the open will really get rather than a second
    // opinion that could disagree with it. `None` is GitHub by the resilient
    // default that keeps `gh` authoritative for Enterprise and unknown hosts.
    let provider = match crate::forge::detect_non_github(&repo_path).await {
        Some((crate::forge::model::Provider::GitLab, _)) => "gitlab",
        Some((crate::forge::model::Provider::Bitbucket, _)) => "bitbucket",
        Some((crate::forge::model::Provider::GitHub, _)) | None => "github",
    };
    Ok(RepoOrigin {
        host: crate::forge::remote_host(&url).unwrap_or_default(),
        path: crate::forge::remote_path(&url).unwrap_or_default(),
        authority: crate::forge::web_authority(&url).unwrap_or_default(),
        provider: provider.to_string(),
    })
}

/// A repository's worktree-stable identity key: the absolute path of its common
/// git directory (`git rev-parse --path-format=absolute --git-common-dir`), which
/// is identical for the main checkout and every linked worktree of the same repo
/// (verified: main and a `gd/session/*` worktree both resolve to `<repo>/.git`).
/// The per-repo app-data stores (local PRs/issues, review history + drafts, branch
/// rules, automations) key their records on this so a PR created inside a worktree
/// is visible from the main checkout and vice-versa, instead of being split by
/// checkout path — the worktree-unaware bug. Falls back to the input path when git
/// can't resolve it (a non-repo path, or git missing) so the key is always a
/// stable, usable string that matches the frontend's own fallback (`repoIdentity`
/// in `src/lib/git/repo-identity.ts`). The GUI reaches this via the
/// `git_repo_identity` command; the MCP server calls it directly — ONE shared
/// resolver so the two processes can never disagree on the key.
pub async fn repo_identity(repo_path: &str) -> String {
    match run_git(
        Some(repo_path),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(out) => {
            let dir = out.stdout_lossy().trim().to_string();
            if dir.is_empty() {
                repo_path.to_string()
            } else {
                dir
            }
        }
        // Not a git repo, git missing, timeout — degrade to the raw path so the
        // caller still gets a stable key (matches the frontend fallback exactly).
        Err(_) => repo_path.to_string(),
    }
}

/// Resolve a repo's worktree-stable identity key for the frontend stores (see
/// [`repo_identity`]).
#[tauri::command]
pub async fn git_repo_identity(repo_path: String) -> AppResult<String> {
    Ok(repo_identity(&repo_path).await)
}

#[tauri::command]
pub async fn check_git_installed(state: State<'_, AppState>) -> AppResult<GitInfo> {
    let info = state
        .git_info
        .get_or_try_init(|| async {
            let out = run_git(None, &["--version"], DEFAULT_TIMEOUT).await?;
            Ok::<_, AppError>(GitInfo {
                version: out.stdout_lossy().trim().to_string(),
            })
        })
        .await?;
    Ok(info.clone())
}

#[tauri::command]
pub async fn validate_repo(path: String) -> AppResult<RepoInfo> {
    if !Path::new(&path).is_dir() {
        return Err(AppError::NotARepo(path));
    }
    let out = run_git_raw(
        Some(&path),
        &["rev-parse", "--show-toplevel"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Err(AppError::NotARepo(path));
    }
    let root = out.stdout_lossy().trim().to_string();
    if root.is_empty() {
        // bare repository: rev-parse succeeds but prints no toplevel
        return Err(AppError::NotARepo(path));
    }
    // git prints forward slashes; normalize so recents dedupe properly
    #[cfg(windows)]
    let root = root.replace('/', "\\");
    let name = root
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&root)
        .to_string();
    Ok(RepoInfo { root, name })
}

#[tauri::command]
pub async fn clone_repo(
    url: String,
    parent_dir: String,
    dir_name: Option<String>,
    recurse_submodules: bool,
) -> AppResult<String> {
    clone_repo_core(&url, &parent_dir, dir_name, recurse_submodules, &[]).await
}

/// Clone `url` into `parent_dir/<dir_name>` (dir inferred from the URL when not
/// given), returning the cloned path. `recurse_submodules` checks out the repo's
/// submodules in the same pass; without it their directories clone empty.
/// `extra_config` are `git -c key=value` entries prepended before `clone` — e.g.
/// a provider credential helper so a private repo authenticates (see
/// `forge::forge_clone`).
pub(crate) async fn clone_repo_core(
    url: &str,
    parent_dir: &str,
    dir_name: Option<String>,
    recurse_submodules: bool,
    extra_config: &[String],
) -> AppResult<String> {
    if url.starts_with('-') {
        return Err(AppError::InvalidArgument("invalid clone URL".into()));
    }
    let dir_name = match dir_name {
        Some(name) => name,
        None => default_clone_dir_name(url)
            .ok_or_else(|| AppError::InvalidArgument("could not infer directory from URL".into()))?,
    };
    if dir_name.starts_with('-') || dir_name.contains(['/', '\\']) {
        return Err(AppError::InvalidArgument("invalid directory name".into()));
    }
    let mut args: Vec<&str> = Vec::new();
    for c in extra_config {
        args.push("-c");
        args.push(c.as_str());
    }
    args.push("clone");
    if recurse_submodules {
        args.push("--recurse-submodules");
    }
    args.extend_from_slice(&["--", url, dir_name.as_str()]);
    run_git(Some(parent_dir), &args, NETWORK_TIMEOUT).await?;
    let cloned = Path::new(parent_dir).join(&dir_name);
    Ok(cloned.to_string_lossy().into_owned())
}

// The separator set covers every source spelling git accepts — `/` for URLs,
// `:` for scp-like `git@host:team/repo.git`, `\` for Windows local paths —
// because the caller rejects any inferred name that still holds a separator.
fn default_clone_dir_name(url: &str) -> Option<String> {
    let trimmed = url.trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\', ':']).next()?;
    let name = last.trim_end_matches(".git").trim();
    (!name.is_empty()).then(|| name.to_string())
}

const GITIGNORE_TEMPLATES: &[(&str, &str)] = &[
    (
        "Node",
        "node_modules/\ndist/\nbuild/\ncoverage/\n.env\n.env.local\nnpm-debug.log*\nyarn-error.log*\n.DS_Store\n",
    ),
    (
        "Python",
        "__pycache__/\n*.py[cod]\n.venv/\nvenv/\ndist/\nbuild/\n*.egg-info/\n.pytest_cache/\n.mypy_cache/\n.env\n.DS_Store\n",
    ),
    ("Rust", "/target\n**/*.rs.bk\n.DS_Store\n"),
    ("Go", "bin/\n*.exe\n*.test\n*.out\nvendor/\n.env\n.DS_Store\n"),
];

const MIT_LICENSE: &str = r#"MIT License

Copyright (c) {year} {holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"#;

const UNLICENSE: &str = r#"This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute
this software, either in source code form or as a compiled binary, for any
purpose, commercial or non-commercial, and by any means.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY ARISING FROM THE USE OF THE SOFTWARE.

For more information, please refer to <https://unlicense.org>
"#;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRepoOptions {
    pub name: String,
    pub description: String,
    pub parent_dir: String,
    pub init_readme: bool,
    pub gitignore: Option<String>,
    pub license: Option<String>,
    pub default_branch: String,
}

#[tauri::command]
pub async fn create_repo(
    state: tauri::State<'_, crate::state::AppState>,
    options: CreateRepoOptions,
) -> AppResult<String> {
    let name = options.name.trim();
    if name.is_empty() || name.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
        return Err(AppError::InvalidArgument(format!(
            "invalid repository name: {name}"
        )));
    }
    let branch = {
        let b = options.default_branch.trim();
        if b.is_empty() { "main" } else { b }
    };
    if branch.starts_with('-') || branch.contains(' ') {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {branch}"
        )));
    }

    let root = Path::new(&options.parent_dir).join(name);
    let occupied = root.exists()
        && std::fs::read_dir(&root)
            .map(|mut d| d.next().is_some())
            .unwrap_or(true);
    if occupied {
        return Err(AppError::InvalidArgument(format!(
            "{} already exists and is not empty",
            root.display()
        )));
    }
    tokio::fs::create_dir_all(&root).await.map_err(AppError::Io)?;
    let root_str = root.to_string_lossy().into_owned();

    run_git(Some(&root_str), &["init", "-b", branch], DEFAULT_TIMEOUT).await?;

    let description = options.description.trim();
    if !description.is_empty() {
        let desc_path = root.join(".git").join("description");
        tokio::fs::write(&desc_path, format!("{description}\n"))
            .await
            .map_err(AppError::Io)?;
    }

    let mut wrote_files = false;
    if options.init_readme {
        let mut readme = format!("# {name}\n");
        if !description.is_empty() {
            readme.push_str(&format!("\n{description}\n"));
        }
        tokio::fs::write(root.join("README.md"), readme)
            .await
            .map_err(AppError::Io)?;
        wrote_files = true;
    }
    if let Some(template) = options.gitignore.as_deref() {
        if let Some((_, content)) = GITIGNORE_TEMPLATES.iter().find(|(n, _)| *n == template) {
            tokio::fs::write(root.join(".gitignore"), content)
                .await
                .map_err(AppError::Io)?;
            wrote_files = true;
        }
    }
    if let Some(license) = options.license.as_deref() {
        let text = match license {
            "MIT" => {
                let holder = run_git_raw(Some(&root_str), &["config", "user.name"], DEFAULT_TIMEOUT)
                    .await
                    .map(|o| o.stdout_lossy().trim().to_string())
                    .unwrap_or_default();
                let year = time_year();
                Some(
                    MIT_LICENSE
                        .replace("{year}", &year)
                        .replace("{holder}", if holder.is_empty() { name } else { &holder }),
                )
            }
            "Unlicense" => Some(UNLICENSE.to_string()),
            _ => None,
        };
        if let Some(text) = text {
            tokio::fs::write(root.join("LICENSE"), text)
                .await
                .map_err(AppError::Io)?;
            wrote_files = true;
        }
    }

    if wrote_files {
        crate::git::runner::run_git_mutating(&state, &root_str, &["add", "-A"], DEFAULT_TIMEOUT)
            .await?;
        crate::git::runner::run_git_mutating(
            &state,
            &root_str,
            &["commit", "-m", "Initial commit"],
            DEFAULT_TIMEOUT,
        )
        .await?;
    }

    Ok(root_str)
}

fn time_year() -> String {
    // chrono-free current year from the unix epoch; close enough for a license
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (1970 + secs / 31_557_600).to_string()
}

#[cfg(test)]
mod clone_dir_tests {
    use super::default_clone_dir_name;

    #[test]
    fn default_clone_dir_name_reads_a_windows_local_path() {
        assert_eq!(default_clone_dir_name(r"C:\Users\dev\my-repo"), Some("my-repo".into()));
    }

    #[test]
    fn default_clone_dir_name_ignores_a_trailing_backslash() {
        assert_eq!(default_clone_dir_name(r"C:\Users\dev\my-repo\"), Some("my-repo".into()));
    }

    #[test]
    fn default_clone_dir_name_reads_a_unc_path() {
        assert_eq!(default_clone_dir_name(r"\\server\share\repo"), Some("repo".into()));
    }

    #[test]
    fn default_clone_dir_name_reads_urls_and_scp_form() {
        assert_eq!(default_clone_dir_name("C:/Users/dev/my-repo"), Some("my-repo".into()));
        assert_eq!(
            default_clone_dir_name("https://github.com/owner/repo.git"),
            Some("repo".into())
        );
        assert_eq!(default_clone_dir_name("git@host:team/repo.git"), Some("repo".into()));
    }

    #[test]
    fn default_clone_dir_name_rejects_a_bare_drive_root() {
        assert_eq!(default_clone_dir_name(r"C:\"), None);
    }
}

#[cfg(test)]
mod owner_tests {
    use super::{parse_owner_host, RepoOwner};

    #[test]
    fn parses_owner_host_and_repo_name_from_common_remote_forms() {
        assert_eq!(
            parse_owner_host("https://github.com/octocat/repo.git"),
            (
                Some("octocat".into()),
                Some("github.com".into()),
                Some("repo".into())
            )
        );
        // Without the `.git` suffix, and with a trailing slash — both trimmed
        // before the segments are cut, so the name never carries either.
        assert_eq!(
            parse_owner_host("https://github.com/octocat/repo"),
            (
                Some("octocat".into()),
                Some("github.com".into()),
                Some("repo".into())
            )
        );
        assert_eq!(
            parse_owner_host("https://github.com/octocat/repo.git/"),
            (
                Some("octocat".into()),
                Some("github.com".into()),
                Some("repo".into())
            )
        );
        assert_eq!(
            parse_owner_host("git@gitlab.com:group/repo.git"),
            (
                Some("group".into()),
                Some("gitlab.com".into()),
                Some("repo".into())
            )
        );
        // Subgroups: the owner is the segment before the repo name.
        assert_eq!(
            parse_owner_host("https://gitlab.com/group/sub/repo"),
            (
                Some("sub".into()),
                Some("gitlab.com".into()),
                Some("repo".into())
            )
        );
        // Credentials + port strip from the host.
        assert_eq!(
            parse_owner_host("https://user@gitlab.acme.com:8443/g/r.git"),
            (
                Some("g".into()),
                Some("gitlab.acme.com".into()),
                Some("r".into())
            )
        );
        assert_eq!(parse_owner_host("not-a-url"), (None, None, None));
        // A single-segment path addresses no repo: neither owner nor name.
        assert_eq!(
            parse_owner_host("https://github.com/repo.git"),
            (None, Some("github.com".into()), None)
        );
    }

    #[test]
    fn bracketed_ipv6_hosts_keep_their_brackets() {
        // The persisted host must be spelled as `remote_host` spells it, or the
        // provider routing compares two different strings for the same instance.
        assert_eq!(
            parse_owner_host("https://[2001:DB8::1]:8443/owner/repo.git"),
            (
                Some("owner".into()),
                Some("[2001:db8::1]".into()),
                Some("repo".into())
            )
        );
        // scp form: `rfind(':')` lands past the address, on the path separator.
        assert_eq!(
            parse_owner_host("git@[2001:db8::1]:owner/repo.git"),
            (
                Some("owner".into()),
                Some("[2001:db8::1]".into()),
                Some("repo".into())
            )
        );
        // A malformed bracket is no host at all — the path still parses.
        assert_eq!(
            parse_owner_host("https://[2001:db8::1/owner/repo"),
            (Some("owner".into()), None, Some("repo".into()))
        );
        // Nor is a span followed by something that isn't a port.
        assert_eq!(
            parse_owner_host("https://[2001:db8::1]junk/owner/repo"),
            (Some("owner".into()), None, Some("repo".into()))
        );
    }

    #[test]
    fn windows_drive_path_remotes_have_no_owner_host_or_repo_name() {
        // A local-path origin (backslash or forward-slash form) must not be
        // misparsed as scp-style `host:owner/repo`.
        assert_eq!(parse_owner_host(r"C:\path\to\repo"), (None, None, None));
        assert_eq!(parse_owner_host("C:/path/to/repo"), (None, None, None));
        assert_eq!(parse_owner_host("c:/x/y"), (None, None, None));
    }

    /// The frontend matches inbox rows to local clones on `repoName`, so the
    /// wire key set is pinned here rather than trusted to `rename_all`.
    #[test]
    fn repo_owner_serializes_to_the_camel_case_wire_shape() {
        let wire = serde_json::to_value(RepoOwner {
            path: "C:/repos/GitDesktop".into(),
            owner: Some("theBGuy".into()),
            host: Some("github.com".into()),
            provider: Some("github".into()),
            repo_name: Some("GitDesktop".into()),
        })
        .unwrap();
        let mut keys: Vec<&str> = wire
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["host", "owner", "path", "provider", "repoName"]);
        assert_eq!(wire.get("repoName").and_then(|v| v.as_str()), Some("GitDesktop"));
    }

    /// The disambiguator itself: `parse_owner_host` folds two DIFFERENT nested
    /// projects onto the same owner+name+host, which is what lets a work-inbox row
    /// match the wrong checkout. `repo_origin_path` has to tell them apart.
    #[test]
    fn nested_namespaces_collide_on_owner_but_not_on_the_full_path() {
        let a = parse_owner_host("https://gitlab.com/team-a/sub/repo.git");
        let b = parse_owner_host("https://gitlab.com/team-b/sub/repo.git");
        assert_eq!(a, b, "owner+host+name cannot separate these — the bug");
        assert_ne!(
            crate::forge::remote_path("https://gitlab.com/team-a/sub/repo.git"),
            crate::forge::remote_path("https://gitlab.com/team-b/sub/repo.git"),
            "the full origin path is what proves the match",
        );
    }
}

#[cfg(test)]
mod origin_path_tests {
    use super::{repo_origin_path, RepoOrigin};

    /// Resolve `origin` against a real repo (temp_dir, git on PATH).
    ///
    /// A FRESH temp repo per remote form — `git_remote_url`'s TTL cache is keyed by
    /// `(repo_path, name)`, and this test's raw `git remote add` bypasses the
    /// app-side commands that invalidate it, so reusing one path across iterations
    /// would serve the first remote's cached URL to every later assertion.
    async fn origin_of(tag: &str, remote: Option<&str>) -> RepoOrigin {
        async fn run(repo: &str, args: &[&str]) {
            let _ =
                crate::git::runner::run_git(Some(repo), args, crate::git::runner::DEFAULT_TIMEOUT)
                    .await;
        }
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-origin-path-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q"]).await;
        if let Some(url) = remote {
            run(&repo_s, &["remote", "add", "origin", url]).await;
        }
        repo_origin_path(repo_s).await.unwrap()
    }

    fn origin(host: &str, path: &str, authority: &str, provider: &str) -> RepoOrigin {
        RepoOrigin {
            host: host.into(),
            path: path.into(),
            authority: authority.into(),
            provider: provider.into(),
        }
    }

    /// All four axes of the proof, across the forms the inbox meets.
    #[tokio::test]
    async fn origin_reports_the_host_and_the_whole_namespace() {
        for (tag, remote, want) in [
            // The namespace collision: the segment before the name is identical, so
            // only the whole path separates these two projects.
            (
                "nested-a",
                Some("https://gitlab.com/team-a/sub/repo.git"),
                origin("gitlab.com", "team-a/sub/repo", "gitlab.com", "gitlab"),
            ),
            (
                "nested-b",
                Some("https://gitlab.com/team-b/sub/repo.git"),
                origin("gitlab.com", "team-b/sub/repo", "gitlab.com", "gitlab"),
            ),
            (
                "flat",
                Some("https://github.com/theBGuy/GitDesktop.git"),
                origin("github.com", "theBGuy/GitDesktop", "github.com", "github"),
            ),
            // scp-style ssh: that `:` opens the path, so there is no port to keep.
            (
                "scp",
                Some("git@gitlab.com:group/sub/repo.git"),
                origin("gitlab.com", "group/sub/repo", "gitlab.com", "gitlab"),
            ),
            // `host` strips the port — `remote_host`'s contract — while the
            // authority KEEPS it, which is the whole point of the third axis. The
            // acme hosts sit in nobody's glab config, so despite the gitlab-looking
            // name their provider verdict is the honest resilient default.
            (
                "ported",
                Some("https://gitlab.acme.corp:8443/team/svc.git"),
                origin("gitlab.acme.corp", "team/svc", "gitlab.acme.corp:8443", "github"),
            ),
            // An explicit default port elides, matching the browser `URL` spelling
            // the item side is parsed with — otherwise every default-port item
            // would mismatch a checkout cloned with an explicit `:443`.
            (
                "explicit-default-port",
                Some("https://gitlab.acme.corp:443/team/svc.git"),
                origin("gitlab.acme.corp", "team/svc", "gitlab.acme.corp", "github"),
            ),
            // A TRANSPORT port is not the web port: ssh on 2222 beside a web UI on
            // 443 is the common self-managed shape, so it must not reach the
            // authority or the checkout would fail to match its own instance.
            (
                "ssh-nondefault-port",
                Some("ssh://git@gitlab.acme.corp:2222/team/svc.git"),
                origin("gitlab.acme.corp", "team/svc", "gitlab.acme.corp", "github"),
            ),
            // Mixed case lowercases on both host axes, again matching the item side.
            (
                "mixed-case",
                Some("https://GitLab.ACME.corp/Team/Svc.git"),
                origin("gitlab.acme.corp", "Team/Svc", "gitlab.acme.corp", "github"),
            ),
            // No `.git` suffix to strip, and a trailing slash to trim.
            (
                "bare",
                Some("https://gitlab.com/group/sub/repo/"),
                origin("gitlab.com", "group/sub/repo", "gitlab.com", "gitlab"),
            ),
            // No origin at all → every axis "" (unproven), never an error.
            ("no-origin", None, RepoOrigin::default()),
        ] {
            assert_eq!(origin_of(tag, remote).await, want, "case: {tag}");
        }
    }

    /// The gap this closes: the stored `RecentRepo.host` goes stale when a remote
    /// is re-pointed, so a path-only proof passes for the SAME namespace on a
    /// DIFFERENT instance and opens the wrong checkout. Reading the host live
    /// separates them.
    #[tokio::test]
    async fn the_same_namespace_on_two_hosts_is_distinguishable() {
        let cloud = origin_of("host-cloud", Some("https://gitlab.com/team/sub/repo.git")).await;
        let corp = origin_of(
            "host-corp",
            Some("https://gitlab.acme.corp/team/sub/repo.git"),
        )
        .await;

        assert_eq!(cloud.path, corp.path, "identical namespaces — the trap");
        assert_ne!(cloud.host, corp.host, "…separated only by the live host");
        assert_ne!(cloud, corp, "so the proof as a whole distinguishes them");
    }

    /// The third axis: SAME hostname, SAME namespace, different port — two
    /// separate instances. `host` strips the port, so it cannot tell them apart
    /// and neither can a host+path proof; only the authority can.
    #[tokio::test]
    async fn the_same_namespace_on_two_ports_is_distinguishable() {
        let default_port =
            origin_of("port-default", Some("https://gitlab.example/team/repo.git")).await;
        let alt_port = origin_of(
            "port-alt",
            Some("https://gitlab.example:8443/team/repo.git"),
        )
        .await;

        assert_eq!(default_port.path, alt_port.path, "identical namespaces");
        assert_eq!(
            default_port.host, alt_port.host,
            "identical hosts — host+path alone would pass here, the defect",
        );
        assert_ne!(
            default_port.authority, alt_port.authority,
            "the authority is what separates the two instances",
        );
        assert_ne!(default_port, alt_port);
    }

    /// The wire shape the frontend mirrors, pinned rather than trusted to
    /// `rename_all` — a key drift would read as `undefined` on the TS side and
    /// silently turn every proof into "unproven".
    #[test]
    fn origin_serializes_to_the_camel_case_wire_shape() {
        let wire = serde_json::to_value(origin(
            "gitlab.example",
            "team/sub/repo",
            "gitlab.example:8443",
            "gitlab",
        ))
        .unwrap();
        let mut keys: Vec<&str> = wire
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["authority", "host", "path", "provider"]);
        assert_eq!(
            wire,
            serde_json::json!({
                "host": "gitlab.example",
                "path": "team/sub/repo",
                "authority": "gitlab.example:8443",
                "provider": "gitlab",
            }),
        );
    }

    /// A path that isn't a repo answers with EVERY axis empty — the full default —
    /// rather than erroring: the caller's contract is "unproven", and a stale
    /// recents row must not fail the open.
    #[tokio::test]
    async fn a_non_repo_path_is_unproven_not_an_error() {
        let dir = tempfile::Builder::new()
            .prefix("gd-origin-path-nonrepo-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_string_lossy().into_owned();
        let unproven = repo_origin_path(path).await.unwrap();
        assert_eq!(unproven, RepoOrigin::default());
        assert!(
            unproven.host.is_empty()
                && unproven.path.is_empty()
                && unproven.authority.is_empty()
                && unproven.provider.is_empty()
        );
    }
}
