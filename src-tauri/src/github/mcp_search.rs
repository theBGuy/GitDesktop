//! GitHub as a second MCP-discovery source for the Browse dialog.
//!
//! Searches GitHub for MCP-server repositories (topic-filtered, star-ranked) and
//! pulls each repo's `server.json` and `package.json` in the SAME GraphQL call,
//! so the frontend can derive an addable server without an N+1 of per-repo
//! requests: a `server.json` is the registry manifest shape (reused verbatim);
//! a `package.json` that depends on the MCP SDK becomes `npx -y <name>`; anything
//! else lands as a manual-setup stub. Rougher than the curated registry — read-only.

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::forge::session::{classify_gh_failure, GhFailure};
use crate::github::gh_failure_reason;
use crate::github::runner::{run_gh_raw, GH_NETWORK_TIMEOUT};

/// One repository hit, with its manifest files inlined (null when absent). The
/// frontend turns this into an addable server (see `mcp-registry.ts`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubMcpHit {
    pub name_with_owner: String,
    pub description: Option<String>,
    pub url: String,
    /// Raw `server.json` text (the registry manifest), when the repo has one.
    pub server_json: Option<String>,
    /// Raw `package.json` text, for the npm-package fallback.
    pub package_json: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubMcpSearchPage {
    pub repos: Vec<GithubMcpHit>,
    /// GraphQL `endCursor` when there's another page, else null.
    pub next_cursor: Option<String>,
}

/// Search + manifest fetch in one query. `object(expression:"HEAD:<file>")`
/// returns the blob (or null when the file is absent), so a missing manifest is
/// not an error — it just yields `None`.
const SEARCH_QUERY: &str = r#"query($q: String!, $after: String) {
  search(query: $q, type: REPOSITORY, first: 30, after: $after) {
    pageInfo { endCursor hasNextPage }
    nodes {
      ... on Repository {
        nameWithOwner
        description
        url
        sj: object(expression: "HEAD:server.json") { ... on Blob { text } }
        pj: object(expression: "HEAD:package.json") { ... on Blob { text } }
      }
    }
  }
}"#;

/// Search GitHub for MCP-server repositories. `query` is the user's free text
/// (may be empty to browse the popular ones); `cursor` pages through results.
#[tauri::command]
pub async fn gh_github_mcp_search(
    query: String,
    cursor: Option<String>,
) -> AppResult<GithubMcpSearchPage> {
    // `topic:mcp-server` is the server convention; the user's text narrows it,
    // server-side star sort surfaces the popular ones, `fork:false` trims clones.
    let q = format!("topic:mcp-server {} sort:stars-desc fork:false", query.trim());

    let query_arg = format!("query={SEARCH_QUERY}");
    let q_arg = format!("q={q}");
    let after_arg = cursor
        .as_deref()
        .filter(|c| !c.is_empty())
        .map(|c| format!("after={c}"));

    let mut args: Vec<&str> = vec!["api", "graphql", "-f", &query_arg, "-f", &q_arg];
    if let Some(a) = &after_arg {
        args.push("-f");
        args.push(a);
    }

    // run_gh_raw: a missing manifest is a null blob, not an error, but gh can
    // still exit non-zero on partial GraphQL errors — parse `data` regardless.
    let out = run_gh_raw(None, &args, GH_NETWORK_TIMEOUT).await?;

    github_mcp_search_outcome(Ok(out))
}

fn github_mcp_search_outcome(
    result: AppResult<crate::github::runner::GhOutput>,
) -> AppResult<GithubMcpSearchPage> {
    let out = result?;
    let mut page = GithubMcpSearchPage {
        repos: Vec::new(),
        next_cursor: None,
    };
    let value = match serde_json::from_str::<serde_json::Value>(&out.stdout_lossy()) {
        Ok(value) => Some(value),
        Err(error) if out.code == 0 => {
            return Err(crate::github::gh_unreadable(
                "the MCP search results",
                error.to_string(),
            ));
        }
        Err(_) => None,
    };
    let search = value
        .as_ref()
        .and_then(|v| v.get("data"))
        .filter(|v| v.is_object())
        .and_then(|v| v.get("search"))
        .filter(|v| v.is_object());
    let Some(search) = search else {
        return match classify_gh_failure(&out.stderr) {
            GhFailure::RateLimited | GhFailure::Transport => {
                Err(AppError::Gh(gh_failure_reason(&out)))
            }
            GhFailure::NotFound | GhFailure::Answered => Ok(page),
        };
    };
    if search["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false) {
        page.next_cursor = search["pageInfo"]["endCursor"].as_str().map(str::to_string);
    }
    if let Some(nodes) = search["nodes"].as_array() {
        for n in nodes {
            let name_with_owner = n["nameWithOwner"].as_str().unwrap_or("");
            if name_with_owner.is_empty() {
                continue;
            }
            // Blob text is present only for an existing, non-truncated text file.
            let blob = |key: &str| {
                n[key]["text"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .map(str::to_string)
            };
            page.repos.push(GithubMcpHit {
                name_with_owner: name_with_owner.to_string(),
                description: n["description"].as_str().map(str::to_string),
                url: n["url"].as_str().unwrap_or("").to_string(),
                server_json: blob("sj"),
                package_json: blob("pj"),
            });
        }
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mcp_search_rejects_unreadable_bodies_and_keeps_missing_search_empty() {
        for body in [
            "{}",
            r#"{"data":null}"#,
            r#"{"data":[]}"#,
            r#"{"data":{}}"#,
            r#"{"data":{"search":null}}"#,
            r#"{"data":{"search":[]}}"#,
        ] {
            let empty = github_mcp_search_outcome(gh_output(0, body, "")).unwrap();
            assert!(empty.repos.is_empty() && empty.next_cursor.is_none());
        }
        for body in ["garbage", ""] {
            let error = github_mcp_search_outcome(gh_output(0, body, ""))
                .expect_err("unreadable MCP search must reject");
            assert!(
                matches!(error, AppError::Gh(message) if message.starts_with("Couldn't read "))
            );
        }
    }

    #[test]
    fn mcp_search_preserves_partial_data_and_classifies_missing_search() {
        let partial = r#"{"data":{"search":{"nodes":[{"nameWithOwner":"o/r","sj":{"text":"{}"}}],"pageInfo":{"hasNextPage":true,"endCursor":"next"}}},"errors":[{"message":"unresolved"}]}"#;
        let page = github_mcp_search_outcome(gh_output(1, partial, HELD_REST_STDERR)).unwrap();
        assert_eq!(page.repos[0].server_json.as_deref(), Some("{}"));
        assert_eq!(page.next_cursor.as_deref(), Some("next"));
        for body in [
            "",
            "garbage",
            "{}",
            r#"{"data":null}"#,
            r#"{"data":[]}"#,
            r#"{"data":{}}"#,
            r#"{"data":{"search":null}}"#,
            r#"{"data":{"search":[]}}"#,
        ] {
            assert!(
                github_mcp_search_outcome(gh_output(1, body, HELD_REST_STDERR)).is_err(),
                "{body}"
            );
            assert!(
                github_mcp_search_outcome(gh_output(1, body, NOT_FOUND_STDERR))
                    .unwrap()
                    .repos
                    .is_empty()
            );
        }
    }

    fn gh_output(
        code: i32,
        body: &str,
        stderr: &str,
    ) -> crate::error::AppResult<crate::github::runner::GhOutput> {
        Ok(crate::github::runner::GhOutput {
            code,
            stdout: body.as_bytes().to_vec(),
            stderr: stderr.into(),
        })
    }

    const HELD_REST_STDERR: &str = "GitHub's REST API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.";
    const NOT_FOUND_STDERR: &str = "HTTP 404: Not Found (https://api.github.com/repos/o/r)";
    const ANSWERED_STDERR: &str =
        "HTTP 403: Resource not accessible by integration (https://api.github.com/repos/o/r)";

    #[test]
    fn mcp_search_preserves_denials_and_rejects_transient_failures() {
        let absent = github_mcp_search_outcome(gh_output(1, "", NOT_FOUND_STDERR)).unwrap();
        assert!(absent.repos.is_empty() && absent.next_cursor.is_none());
        let absent = github_mcp_search_outcome(gh_output(1, "", ANSWERED_STDERR)).unwrap();
        assert!(absent.repos.is_empty() && absent.next_cursor.is_none());
        let loaded = github_mcp_search_outcome(gh_output(
            0,
            r#"{"data":{"search":{"nodes":[{"nameWithOwner":"o/r"}]}}}"#,
            "",
        ))
        .unwrap();
        assert!(loaded.repos.len() == 1);
        for stderr in [
            HELD_REST_STDERR,
            "GitHub's GraphQL API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.",
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error = github_mcp_search_outcome(gh_output(1, "", stderr))
                .expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(github_mcp_search_outcome(Err(crate::error::AppError::Timeout(30))).is_err());
    }
}
