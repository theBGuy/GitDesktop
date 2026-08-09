//! Local-git READ tools (always available; no opt-in flag).
//!
//! The 12 read-only tools that operate purely on the bound repository's git data:
//! status, history/log, branches, tags, remotes, blame, commit/working/ref diffs, and
//! file reads. The raw-diff tools (`commit_diff`/`working_diff`/`diff_refs`) issue
//! `git` directly (via [`diff_text`]) so they get consistent caps + intuitive
//! semantics; the metadata tools reuse an existing command core directly.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{schemars, tool, tool_router, ErrorData as McpError};

use super::{
    app_err, cap_head, diff_text, ensure_not_flag, json_result, resolve_commit, to_value,
    GitDesktopMcp, ShaArg, READ_FILE_MAX_BYTES, SESSION_BRANCH_PREFIX,
};

// ---- Local-git tool parameters --------------------------------------------

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct LogArgs {
    /// Max commits to return (default 50).
    #[serde(default)]
    limit: Option<u32>,
    /// Commits to skip from HEAD, for paging (default 0).
    #[serde(default)]
    skip: Option<u32>,
    /// Optional filter; matches commit message and author.
    #[serde(default)]
    search: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct FileHistoryArgs {
    /// Repo-relative path of the file.
    path: String,
    /// Max commits to return (default 50).
    #[serde(default)]
    limit: Option<u32>,
    /// Commits to skip, for paging (default 0).
    #[serde(default)]
    skip: Option<u32>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct BlameArgs {
    /// Repo-relative path of the file.
    path: String,
    /// Optional rev to blame the file at (branch/tag/SHA). Omit to blame the
    /// current working tree.
    #[serde(default)]
    rev: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct CommitDiffArgs {
    /// Commit SHA, or any rev (branch, tag, HEAD).
    sha: String,
    /// Limit to a single file (repo-relative). Omit for the whole commit.
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct WorkingDiffArgs {
    /// Limit to a single file (repo-relative). Omit for all changes.
    #[serde(default)]
    path: Option<String>,
    /// Show only staged changes (vs HEAD). Default false = all uncommitted
    /// changes (staged + unstaged) vs HEAD.
    #[serde(default)]
    staged: Option<bool>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct DiffRefsArgs {
    /// The "from" ref (base) — branch, tag, or SHA.
    base: String,
    /// The "to" ref (head) — branch, tag, or SHA.
    head: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ReadFileArgs {
    /// Repo-relative path of the file.
    path: String,
    /// Optional rev to read the file at (branch/tag/SHA). Omit to read the
    /// current working-tree contents.
    #[serde(default, rename = "ref")]
    at_ref: Option<String>,
}

#[tool_router(router = read_git_router, vis = "pub(crate)")]
impl GitDesktopMcp {
    #[tool(
        description = "Working-tree status: current branch, upstream, ahead/behind counts, and \
                       the staged/unstaged/untracked file changes. Returns JSON."
    )]
    async fn repo_status(&self) -> Result<CallToolResult, McpError> {
        let status = crate::git::status::status_core(&self.repo)
            .await
            .map_err(app_err)?;
        json_result(&status)
    }

    #[tool(
        description = "List recent commits (sha, author, authorEmail, date, subject). Supports paging via \
                       limit/skip and an optional message/author search filter."
    )]
    async fn log(&self, Parameters(args): Parameters<LogArgs>) -> Result<CallToolResult, McpError> {
        let commits = crate::git::history::git_log(
            self.repo.clone(),
            args.limit.unwrap_or(50),
            args.skip.unwrap_or(0),
            args.search,
        )
        .await
        .map_err(app_err)?;
        json_result(&commits)
    }

    #[tool(description = "List the commits that touched a single file (newest first).")]
    async fn file_history(
        &self,
        Parameters(args): Parameters<FileHistoryArgs>,
    ) -> Result<CallToolResult, McpError> {
        let commits = crate::git::history::git_file_log(
            self.repo.clone(),
            args.path,
            args.limit.unwrap_or(50),
            args.skip.unwrap_or(0),
        )
        .await
        .map_err(app_err)?;
        json_result(&commits)
    }

    #[tool(
        description = "List local branches with their upstream and current/archived flags. \
                       Returns JSON. (For ahead/behind counts, see repo_status.)"
    )]
    async fn list_branches(&self) -> Result<CallToolResult, McpError> {
        let mut branches = crate::git::branches::git_branches(self.repo.clone())
            .await
            .map_err(app_err)?;
        // Drop GitDesktop agent-session branches (`gd/session/*`) — they're app-internal,
        // and the write-side tools refuse to touch them (see
        // `write_git::ensure_not_session_branch`). Filtering here keeps them off this
        // read surface too, matching every GUI branch list.
        branches.retain(|b| !b.name.starts_with(SESSION_BRANCH_PREFIX));
        json_result(&branches)
    }

    #[tool(
        description = "Per-line authorship (git blame) for a file: each line's commit/author. \
                       Optionally at a specific revision (SHA, branch, tag) instead of the working tree."
    )]
    async fn blame(
        &self,
        Parameters(args): Parameters<BlameArgs>,
    ) -> Result<CallToolResult, McpError> {
        let lines = crate::git::history::git_blame(self.repo.clone(), args.path, args.rev)
            .await
            .map_err(app_err)?;
        json_result(&lines)
    }

    #[tool(
        description = "Show a commit (accepts any rev: SHA, branch, tag, HEAD): its message/author \
                       metadata plus the list of changed files with add/delete counts. Returns JSON."
    )]
    async fn show_commit(
        &self,
        Parameters(args): Parameters<ShaArg>,
    ) -> Result<CallToolResult, McpError> {
        // Resolve the rev to a SHA first, so branch/tag/HEAD work (the underlying
        // commands validate a hex hash).
        let sha = resolve_commit(&self.repo, &args.sha).await?;
        let details = crate::git::history::git_commit_details(self.repo.clone(), sha.clone())
            .await
            .map_err(app_err)?;
        let files = crate::git::history::git_commit_files(self.repo.clone(), sha)
            .await
            .map_err(app_err)?;
        let body =
            serde_json::json!({ "details": to_value(&details)?, "files": to_value(&files)? });
        json_result(&body)
    }

    #[tool(
        description = "Raw unified diff of a commit (accepts any rev: SHA, branch, tag, HEAD) — the \
                       whole commit, or a single file when `path` is given. Large diffs are truncated."
    )]
    async fn commit_diff(
        &self,
        Parameters(args): Parameters<CommitDiffArgs>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_flag(&args.sha, "sha")?;
        let mut a: Vec<&str> = vec!["show", "--no-color", args.sha.as_str()];
        // `path` is documented as a single file, so it matches only itself — a raw
        // `[slug]`-style path would splice a glob-sibling's hunks into the answer.
        let spec = args.path.as_deref().map(crate::git::pathspec::literal);
        if let Some(spec) = spec.as_deref() {
            a.push("--");
            a.push(spec);
        }
        diff_text(&self.repo, &a).await
    }

    #[tool(
        description = "Raw unified diff of uncommitted changes. Default shows ALL changes \
                       (staged + unstaged) vs HEAD; set staged=true for staged-only. Optionally \
                       scope to one file. For a NEW/untracked file's content, use read_file. \
                       Large diffs are truncated."
    )]
    async fn working_diff(
        &self,
        Parameters(args): Parameters<WorkingDiffArgs>,
    ) -> Result<CallToolResult, McpError> {
        let mut a: Vec<&str> = vec!["diff", "--no-color"];
        // `git diff HEAD` = staged + unstaged vs HEAD; `git diff --cached` = staged
        // vs HEAD. Scoping with `-- <path>` keeps the same base (unlike the per-file
        // UI command, which only diffs against the index).
        if args.staged.unwrap_or(false) {
            a.push("--cached");
        } else {
            a.push("HEAD");
        }
        // Single documented file, so it matches only itself (see commit_diff).
        let spec = args.path.as_deref().map(crate::git::pathspec::literal);
        if let Some(spec) = spec.as_deref() {
            a.push("--");
            a.push(spec);
        }
        diff_text(&self.repo, &a).await
    }

    #[tool(
        description = "Raw unified diff between two refs (branches, tags, or SHAs) — the full \
                       difference between base and head (the two endpoints, not an ancestry range), \
                       so it never silently empties on diverged branches. Large diffs are truncated."
    )]
    async fn diff_refs(
        &self,
        Parameters(args): Parameters<DiffRefsArgs>,
    ) -> Result<CallToolResult, McpError> {
        ensure_not_flag(&args.base, "base")?;
        ensure_not_flag(&args.head, "head")?;
        diff_text(
            &self.repo,
            &["diff", "--no-color", &args.base, &args.head, "--"],
        )
        .await
    }

    #[tool(
        description = "Read a file's contents — the current working-tree version, or at a given \
                       rev when `ref` is set. Hard-scoped to the bound repository; binary files are \
                       refused. Large files are truncated."
    )]
    async fn read_file(
        &self,
        Parameters(args): Parameters<ReadFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        let text = read_file_core(&self.repo, &args.path, args.at_ref.as_deref()).await?;
        Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
    }

    #[tool(description = "List tags, newest first. Returns JSON.")]
    async fn list_tags(&self) -> Result<CallToolResult, McpError> {
        let tags = crate::git::ops::git_list_tags(self.repo.clone())
            .await
            .map_err(app_err)?;
        json_result(&tags)
    }

    #[tool(
        description = "List the repository's remotes with their URLs (credentials redacted). Returns JSON."
    )]
    async fn remotes(&self) -> Result<CallToolResult, McpError> {
        // One `git remote -v` instead of a listing plus a `get-url` per remote.
        let listing = crate::git::runner::run_git(
            Some(&self.repo),
            &["remote", "-v"],
            crate::git::runner::DEFAULT_TIMEOUT,
        )
        .await
        .map_err(app_err)?;
        let listing = listing.stdout_lossy();
        let (names, fetch_urls) = parse_remote_v(&listing);
        let mut out = Vec::with_capacity(names.len());
        for name in names {
            let url = match fetch_urls.get(name) {
                Some(url) => redact_url_credentials(url),
                // No fetch row means `remote.<name>.url` is unset, where git's own
                // `get-url` answers with the name itself — keep reporting that.
                None => crate::git::remote::git_remote_url(self.repo.clone(), name.to_string())
                    .await
                    .map(|u| redact_url_credentials(&u))
                    .unwrap_or_default(),
            };
            out.push(serde_json::json!({ "name": name, "url": url }));
        }
        json_result(&out)
    }
}

/// Splits `git remote -v` output into the remote names (first seen wins, keeping git's
/// order) and each remote's FETCH url. Names come from EVERY row because a remote with
/// no configured URL emits one bare `name\t` row and no `(fetch)` row at all; the url
/// comes from the `(fetch)` row alone, which is the URL `git remote get-url` reports.
fn parse_remote_v(listing: &str) -> (Vec<&str>, std::collections::HashMap<&str, &str>) {
    let mut names: Vec<&str> = Vec::new();
    let mut fetch_urls: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for line in listing.lines() {
        let Some((name, rest)) = line.split_once('\t') else {
            continue;
        };
        if !names.contains(&name) {
            names.push(name);
        }
        if let Some(url) = rest.strip_suffix(" (fetch)") {
            // First-wins, like `names` above: `get-url` answers with a remote's FIRST
            // url, so agreeing by construction survives a second fetch row.
            fetch_urls.entry(name).or_insert(url);
        }
    }
    (names, fetch_urls)
}

/// Redacts an in-URL credential (the `user:pass@` / `token@` userinfo) from an
/// http(s) remote URL, so `remotes` can't hand a secret to the connected agent.
fn redact_url_credentials(url: &str) -> String {
    for scheme in ["https://", "http://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            let authority_end = rest.find('/').unwrap_or(rest.len());
            if let Some(at) = rest[..authority_end].find('@') {
                return format!("{scheme}***@{}", &rest[at + 1..]);
            }
            return url.to_string();
        }
    }
    url.to_string()
}

/// Reads a repo file's contents — working tree or at a rev — hard-scoped to the
/// repository root so a tool call can't escape it via `..` or an absolute path.
/// Binary content is refused (mirroring the working-tree branch's UTF-8 rejection).
async fn read_file_core(
    repo: &str,
    rel_path: &str,
    at_ref: Option<&str>,
) -> Result<String, McpError> {
    use crate::git::runner::{run_git, DEFAULT_TIMEOUT};

    if rel_path.starts_with('/') || rel_path.starts_with('\\') {
        return Err(McpError::invalid_params(
            "path must be relative to the repository root",
            None,
        ));
    }
    if rel_path.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(McpError::invalid_params("path must not contain '..'", None));
    }

    let raw = if let Some(r) = at_ref {
        if r.starts_with('-') {
            return Err(McpError::invalid_params("invalid ref", None));
        }
        // `git show <rev>:<path>` resolves the path within the repo tree.
        let spec = format!("{r}:{rel_path}");
        let out = run_git(Some(repo), &["show", &spec], DEFAULT_TIMEOUT)
            .await
            .map_err(app_err)?;
        // `git show` dumps a raw blob; reject binary (the working-tree branch's
        // read_to_string rejects non-UTF-8, so match that contract).
        if out.stdout.contains(&0u8) {
            return Err(McpError::invalid_params("file appears to be binary", None));
        }
        out.stdout_lossy()
    } else {
        // Working-tree read, canonicalized and confined to the repo root.
        let root = tokio::fs::canonicalize(repo)
            .await
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        let target = tokio::fs::canonicalize(root.join(rel_path))
            .await
            .map_err(|_| McpError::invalid_params("file not found in repository", None))?;
        if !target.starts_with(&root) {
            return Err(McpError::invalid_params(
                "path escapes the repository root",
                None,
            ));
        }
        // Read bytes so we apply the SAME binary contract as the `git show` branch:
        // reject NUL-containing content (a valid-UTF-8 file with NULs would sneak past
        // `read_to_string`), then reject non-UTF-8 as "binary" too — mapping it to the
        // same invalid-params error rather than an internal error.
        let bytes = tokio::fs::read(&target).await.map_err(|e| {
            // Only a genuine not-found keeps the not-found message; anything else
            // (permission denied, IO failure) surfaces honestly instead of misleading
            // the caller about a file that clearly exists.
            if e.kind() == std::io::ErrorKind::NotFound {
                McpError::invalid_params("file not found in repository", None)
            } else {
                McpError::internal_error(e.to_string(), None)
            }
        })?;
        if bytes.contains(&0u8) {
            return Err(McpError::invalid_params("file appears to be binary", None));
        }
        String::from_utf8(bytes)
            .map_err(|_| McpError::invalid_params("file appears to be binary", None))?
    };

    Ok(cap_head(raw, READ_FILE_MAX_BYTES))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A remote with no `remote.<name>.url` emits ONE bare row — name, TAB, nothing —
    /// and no `(fetch)` row, so it must survive the parse on the name side alone. Its
    /// absence from the url map is what routes the tool to its `get-url` arm (git
    /// answers that with the remote's own name). Measured against git 2.51.1.windows.1.
    #[test]
    fn a_remote_without_a_url_keeps_its_name_and_gets_no_url() {
        let (names, urls) = parse_remote_v("nourl\t");
        assert_eq!(names, vec!["nourl"]);
        assert!(!urls.contains_key("nourl"));
    }

    /// A remote carrying several push URLs emits exactly one `(fetch)` row (the FIRST
    /// url) plus one `(push)` row per url — and `git remote get-url` returns that same
    /// first url, so taking the fetch row keeps the reported url identical to what the
    /// per-remote `get-url` calls used to report. Measured against git 2.51.1.windows.1.
    #[test]
    fn a_multi_url_remote_reports_the_fetch_url_once() {
        let (names, urls) = parse_remote_v(
            "origin\thttps://example.com/first.git (fetch)\n\
             origin\thttps://example.com/first.git (push)\n\
             origin\thttps://example.com/second.git (push)",
        );
        assert_eq!(names, vec!["origin"]);
        assert_eq!(
            urls.get("origin").copied(),
            Some("https://example.com/first.git")
        );
    }

    /// The ordinary shape: fetch + push rows for one url, folded to a single name.
    #[test]
    fn a_single_url_remote_yields_one_name_and_its_url() {
        let (names, urls) = parse_remote_v(
            "origin\thttps://example.com/a.git (fetch)\n\
             origin\thttps://example.com/a.git (push)",
        );
        assert_eq!(names, vec!["origin"]);
        assert_eq!(
            urls.get("origin").copied(),
            Some("https://example.com/a.git")
        );
    }
}
