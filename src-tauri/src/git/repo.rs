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
}

/// Owner segment + host of a git remote URL — handles
/// `https://host/owner/repo(.git)` and scp-style `git@host:owner/repo(.git)`.
/// None if it can't be parsed.
fn parse_owner_host(url: &str) -> (Option<String>, Option<String>) {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    // Split into host and the `owner/repo` path (scheme or scp form).
    let (host, path) = if let Some(idx) = url.find("://") {
        let rest = &url[idx + 3..];
        match rest.split_once('/') {
            Some((h, p)) => (h, p),
            None => return (None, None),
        }
    } else if let Some(colon) = url.rfind(':') {
        // A Windows drive-path remote (`C:\path\to\repo`, `C:/path/to/repo`)
        // looks like the scp form to `rfind(':')`, but the text before the colon
        // is a single drive letter — it has no owner/host. Bail so we don't
        // persist a bogus host ("c") + owner ("to") onto RecentRepo.
        let head = &url[..colon];
        if head.len() == 1 && head.as_bytes()[0].is_ascii_alphabetic() {
            return (None, None);
        }
        let host = head.rsplit('@').next().unwrap_or(head);
        (host, &url[colon + 1..])
    } else {
        return (None, None);
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
    // owner is the segment immediately before the repo name.
    let owner = (segs.len() >= 2).then(|| segs[segs.len() - 2].to_string());
    let host = (!host.is_empty()).then_some(host);
    (owner, host)
}

/// Resolves the owner + host + provider for each repo path (from its `origin`
/// remote), batched so the repo list/switcher can group repos by owner in one
/// round-trip. The glab known-hosts config is read once for the whole batch.
#[tauri::command]
pub async fn git_repo_owners(repo_paths: Vec<String>) -> AppResult<Vec<RepoOwner>> {
    let glab_hosts = crate::forge::glab::known_hosts().await;
    let mut out = Vec::with_capacity(repo_paths.len());
    for path in repo_paths {
        let (owner, host) = match run_git_raw(
            Some(&path),
            &["remote", "get-url", "origin"],
            DEFAULT_TIMEOUT,
        )
        .await
        {
            Ok(res) if res.code == 0 => parse_owner_host(res.stdout_lossy().trim()),
            _ => (None, None),
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
        });
    }
    Ok(out)
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

fn default_clone_dir_name(url: &str) -> Option<String> {
    let trimmed = url.trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next()?;
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
mod owner_tests {
    use super::parse_owner_host;

    #[test]
    fn parses_owner_and_host_from_common_remote_forms() {
        assert_eq!(
            parse_owner_host("https://github.com/octocat/repo.git"),
            (Some("octocat".into()), Some("github.com".into()))
        );
        assert_eq!(
            parse_owner_host("git@gitlab.com:group/repo.git"),
            (Some("group".into()), Some("gitlab.com".into()))
        );
        // Subgroups: the owner is the segment before the repo name.
        assert_eq!(
            parse_owner_host("https://gitlab.com/group/sub/repo"),
            (Some("sub".into()), Some("gitlab.com".into()))
        );
        // Credentials + port strip from the host.
        assert_eq!(
            parse_owner_host("https://user@gitlab.acme.com:8443/g/r.git"),
            (Some("g".into()), Some("gitlab.acme.com".into()))
        );
        assert_eq!(parse_owner_host("not-a-url"), (None, None));
    }

    #[test]
    fn bracketed_ipv6_hosts_keep_their_brackets() {
        // The persisted host must be spelled as `remote_host` spells it, or the
        // provider routing compares two different strings for the same instance.
        assert_eq!(
            parse_owner_host("https://[2001:DB8::1]:8443/owner/repo.git"),
            (Some("owner".into()), Some("[2001:db8::1]".into()))
        );
        // scp form: `rfind(':')` lands past the address, on the path separator.
        assert_eq!(
            parse_owner_host("git@[2001:db8::1]:owner/repo.git"),
            (Some("owner".into()), Some("[2001:db8::1]".into()))
        );
        // A malformed bracket is no host at all — the path still parses.
        assert_eq!(
            parse_owner_host("https://[2001:db8::1/owner/repo"),
            (Some("owner".into()), None)
        );
        // Nor is a span followed by something that isn't a port.
        assert_eq!(
            parse_owner_host("https://[2001:db8::1]junk/owner/repo"),
            (Some("owner".into()), None)
        );
    }

    #[test]
    fn windows_drive_path_remotes_have_no_owner_or_host() {
        // A local-path origin (backslash or forward-slash form) must not be
        // misparsed as scp-style `host:owner/repo`.
        assert_eq!(parse_owner_host(r"C:\path\to\repo"), (None, None));
        assert_eq!(parse_owner_host("C:/path/to/repo"), (None, None));
        assert_eq!(parse_owner_host("c:/x/y"), (None, None));
    }
}
