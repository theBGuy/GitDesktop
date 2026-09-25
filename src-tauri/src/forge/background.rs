//! Batch forge readiness for the background PR-sync poller: one call per tick
//! answers "which of these repos can be polled for PRs right now", resolving gh
//! auth once per distinct host instead of once per repo.

use serde::Serialize;

use crate::error::AppResult;
use crate::forge::model::{ForgeStatus, Provider};
use crate::forge::session::{github_health_for_poller, github_host_for_repo, SessionState};

/// One repo's background-poll readiness. Output order matches the input paths.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundRepoStatus {
    pub path: String,
    /// `"github"` | `"gitlab"` | `"bitbucket"`.
    pub provider: String,
    pub host: Option<String>,
    /// Whether this repo's PRs can be polled this tick.
    pub ready: bool,
    /// The signed-in login on the repo's host — the pr-open catch-up's viewer.
    pub login: Option<String>,
}

fn provider_tag(provider: Provider) -> &'static str {
    match provider {
        Provider::GitHub => "github",
        Provider::GitLab => "gitlab",
        Provider::Bitbucket => "bitbucket",
    }
}

/// One repo's route: `(path, provider, host)`. `host` is `None` only for a GitHub
/// route whose `origin` host is unreadable.
type Route = (String, Provider, Option<String>);

/// Group routes by GitHub host: the distinct hosts to probe (first-seen order) and,
/// per input route, the index of its host's probe — `None` for a non-GitHub route or
/// a GitHub route with no host. One entry per route keeps the batch output in input
/// order.
fn group_github_hosts(routes: &[Route]) -> (Vec<String>, Vec<Option<usize>>) {
    let mut hosts: Vec<String> = Vec::new();
    let probe_of = routes
        .iter()
        .map(|(_, provider, host)| {
            let host = host.as_ref().filter(|_| *provider == Provider::GitHub)?;
            Some(hosts.iter().position(|h| h == host).unwrap_or_else(|| {
                hosts.push(host.clone());
                hosts.len() - 1
            }))
        })
        .collect();
    (hosts, probe_of)
}

/// The Rust twin of `forgeFeatureReady(status, "pullRequests")` in
/// src/lib/git/queries/accounts.ts (`forgeReady` + the implemented flag) — the two
/// must agree, so a change to either predicate lands in both.
fn pull_requests_ready(status: &ForgeStatus) -> bool {
    status.installed
        && status.authenticated
        && status.repo.as_deref().is_some_and(|r| !r.is_empty())
        && status.implemented.pull_requests
}

/// Background PR-sync readiness for many repos at once.
///
/// GitHub readiness is deliberately looser than `forge_status`: no `gh repo view`,
/// because `gh_pr_poll` derives the slug itself and fails loudly per repo, and the
/// caller already skips a repo whose poll fails. Auth is judged per HOST, via the
/// poller-lite probe (no expiry or rate-limit reads), so a broken account on an
/// unrelated host no longer marks every repo unready. A repo whose `origin` host is
/// unreadable (no origin, a local-path remote) is not ready: `gh_pr_poll` needs that
/// origin, and `github_host_for_repo`'s github.com default would otherwise probe it.
///
/// GitLab, Bitbucket, and any other non-GitHub provider the detect chain yields keep
/// the per-repo `resolve_status` probe; a failed probe reads as not-ready rather than
/// failing the batch.
#[tauri::command]
pub async fn forge_background_statuses(paths: Vec<String>) -> AppResult<Vec<BackgroundRepoStatus>> {
    let mut routes: Vec<Route> = Vec::with_capacity(paths.len());
    for path in paths {
        let route = match crate::forge::detect_non_github(&path).await {
            Some((provider @ (Provider::GitLab | Provider::Bitbucket), host)) => {
                (path, provider, Some(host))
            }
            // github.com, Enterprise, and unknown hosts: gh's port-sensitive spelling.
            _ => {
                let origin_host = crate::git::remote::git_remote_url(path.clone(), "origin".into())
                    .await
                    .ok()
                    .and_then(|url| crate::forge::remote_host(&url));
                let host = match origin_host {
                    Some(_) => Some(github_host_for_repo(&path).await),
                    None => None,
                };
                (path, Provider::GitHub, host)
            }
        };
        routes.push(route);
    }

    let (hosts, probe_of) = group_github_hosts(&routes);
    let mut verdicts = Vec::with_capacity(hosts.len());
    for host in &hosts {
        let health = Box::pin(github_health_for_poller(host)).await;
        verdicts.push((matches!(health.state, SessionState::Healthy), health.login));
    }

    let mut out = Vec::with_capacity(routes.len());
    for ((path, provider, host), probe) in routes.into_iter().zip(probe_of) {
        let (ready, login) = match (probe, provider) {
            (Some(i), _) => verdicts[i].clone(),
            (None, Provider::GitHub) => (false, None),
            (None, _) => {
                let status = Box::pin(crate::forge::resolve_status(&path)).await.ok();
                (
                    status.as_ref().is_some_and(pull_requests_ready),
                    status.and_then(|s| s.login),
                )
            }
        };
        out.push(BackgroundRepoStatus {
            path,
            provider: provider_tag(provider).to_string(),
            host,
            ready,
            login,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::model::{Capabilities, Implemented};

    fn route(path: &str, provider: Provider, host: &str) -> Route {
        (path.to_string(), provider, Some(host.to_string()))
    }

    #[test]
    fn a_github_route_without_a_host_never_probes() {
        let routes = vec![
            (String::from("/no-origin"), Provider::GitHub, None),
            route("/a", Provider::GitHub, "github.com"),
            (String::from("/local-remote"), Provider::GitHub, None),
        ];
        let (hosts, probe_of) = group_github_hosts(&routes);
        assert_eq!(hosts, vec!["github.com".to_string()]);
        assert_eq!(probe_of, vec![None, Some(0), None]);
    }

    #[test]
    fn many_repos_on_one_host_share_one_probe() {
        let routes: Vec<_> = (0..10)
            .map(|i| route(&format!("/r{i}"), Provider::GitHub, "github.com"))
            .collect();
        let (hosts, probe_of) = group_github_hosts(&routes);
        assert_eq!(hosts, vec!["github.com".to_string()]);
        assert_eq!(probe_of, vec![Some(0); 10]);
    }

    #[test]
    fn mixed_hosts_probe_once_each_in_input_order() {
        let routes = vec![
            route("/a", Provider::GitHub, "github.com"),
            route("/b", Provider::GitHub, "ghe.corp:8443"),
            route("/c", Provider::GitLab, "gitlab.com"),
            route("/d", Provider::GitHub, "github.com"),
            route("/e", Provider::GitHub, "ghe.corp:8443"),
            route("/f", Provider::Bitbucket, "bitbucket.org"),
        ];
        let (hosts, probe_of) = group_github_hosts(&routes);
        assert_eq!(
            hosts,
            vec!["github.com".to_string(), "ghe.corp:8443".to_string()]
        );
        assert_eq!(
            probe_of,
            vec![Some(0), Some(1), None, Some(0), Some(1), None]
        );
    }

    #[test]
    fn no_routes_means_no_probes() {
        let (hosts, probe_of) = group_github_hosts(&[]);
        assert!(hosts.is_empty());
        assert!(probe_of.is_empty());
    }

    #[test]
    fn wire_shape_is_camel_case_with_null_options() {
        let absent = BackgroundRepoStatus {
            path: "/r".into(),
            provider: "github".into(),
            host: None,
            ready: false,
            login: None,
        };
        assert_eq!(
            serde_json::to_value(&absent).unwrap(),
            serde_json::json!({
                "path": "/r", "provider": "github", "host": null, "ready": false, "login": null
            })
        );
        let present = BackgroundRepoStatus {
            path: "/r".into(),
            provider: "gitlab".into(),
            host: Some("gitlab.com".into()),
            ready: true,
            login: Some("octo".into()),
        };
        assert_eq!(
            serde_json::to_value(&present).unwrap(),
            serde_json::json!({
                "path": "/r", "provider": "gitlab", "host": "gitlab.com", "ready": true,
                "login": "octo"
            })
        );
    }

    fn status(provider: Provider, repo: Option<&str>) -> ForgeStatus {
        ForgeStatus {
            provider: Some(provider),
            installed: true,
            authenticated: true,
            repo: repo.map(str::to_string),
            host: None,
            login: None,
            capabilities: Capabilities::for_provider(provider),
            implemented: Implemented::for_provider(provider),
        }
    }

    #[test]
    fn pull_requests_ready_mirrors_forge_feature_ready() {
        assert!(pull_requests_ready(&status(Provider::GitLab, Some("g/r"))));
        // `forgeReady` reads the repo through Boolean(), so "" is as absent as null.
        assert!(!pull_requests_ready(&status(Provider::GitLab, Some(""))));
        assert!(!pull_requests_ready(&status(Provider::GitLab, None)));
        let mut unauthed = status(Provider::Bitbucket, Some("w/r"));
        unauthed.authenticated = false;
        assert!(!pull_requests_ready(&unauthed));
        let mut missing = status(Provider::Bitbucket, Some("w/r"));
        missing.installed = false;
        assert!(!pull_requests_ready(&missing));
        let mut unbuilt = status(Provider::GitLab, Some("g/r"));
        unbuilt.implemented.pull_requests = false;
        assert!(!pull_requests_ready(&unbuilt));
    }
}
