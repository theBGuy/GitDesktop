//! Batch forge readiness for the background PR-sync poller: one call per tick
//! answers "which of these repos can be polled for PRs right now". gh auth for
//! registered hosts takes one probe per tick instead of one per repo; an unmapped
//! host spelling pays the per-repo `resolve_status` probe every tick.

use std::collections::HashMap;

use serde::Serialize;

use crate::error::AppResult;
use crate::forge::model::{ForgeStatus, Provider};
use crate::forge::session::{github_host_for_repo, github_hosts_health_for_poller, SessionState};

/// One repo's background-poll readiness. Output order matches the input paths.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundRepoStatus {
    pub path: String,
    pub provider: Provider,
    pub host: Option<String>,
    /// Whether this repo's PRs can be polled this tick.
    pub ready: bool,
    /// The signed-in login on the repo's host — the pr-open catch-up's viewer.
    pub login: Option<String>,
}

/// One repo's route: `(path, provider, host)`. `host` is `None` only for a GitHub
/// route whose `origin` host is unreadable.
type Route = (String, Provider, Option<String>);

/// Per gh-registered host: whether its session reads Healthy, and its active login.
type HostVerdicts = HashMap<String, (bool, Option<String>)>;

/// Whether any route needs the gh probe: a GitHub route with a readable host. Routes
/// without one are never ready, so a batch of only those spends no gh call.
fn needs_github_probe(routes: &[Route]) -> bool {
    routes
        .iter()
        .any(|(_, provider, host)| *provider == Provider::GitHub && host.is_some())
}

/// A GitHub route's `(ready, login)` from the tick's host verdicts, or `None` to take
/// the per-repo `resolve_status` probe instead. No host → not ready. A host gh has
/// registered → that host's own verdict, so a broken account on one host never gates
/// another's. Any other host (an ssh alias, `www.`, an unregistered Enterprise host)
/// → `None`, as is every host over an empty map: it can't tell "no host signed in"
/// from an unreadable probe (old gh without `--json`), and the per-repo probe answers
/// both correctly.
fn github_verdict(host: Option<&str>, verdicts: &HostVerdicts) -> Option<(bool, Option<String>)> {
    let Some(host) = host else {
        return Some((false, None));
    };
    // Unmapped → per-repo probe; readiness is never borrowed from another host.
    verdicts.get(host).cloned()
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

/// Background PR-sync readiness for many repos at once. On a host the batch probe
/// answers, readiness skips `gh repo view`: `gh_pr_poll` derives the slug itself and
/// fails loudly per repo. A repo whose `origin` host is unreadable (no origin, a
/// local-path remote) is not ready: `gh_pr_poll` needs that origin, and
/// `github_host_for_repo`'s github.com default would otherwise read it as ready.
/// Non-GitHub repos, and GitHub hosts the batch probe can't answer (see
/// [`github_verdict`]), take the per-repo `resolve_status` probe; a failed probe reads
/// as not-ready rather than failing the batch.
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

    let verdicts: HostVerdicts = if needs_github_probe(&routes) {
        Box::pin(github_hosts_health_for_poller())
            .await
            .into_iter()
            .map(|(host, health)| {
                let healthy = matches!(health.state, SessionState::Healthy);
                (host, (healthy, health.login))
            })
            .collect()
    } else {
        HashMap::new()
    };

    let mut out = Vec::with_capacity(routes.len());
    for (path, provider, host) in routes {
        let decided = match provider {
            Provider::GitHub => github_verdict(host.as_deref(), &verdicts),
            _ => None,
        };
        let (ready, login) = match decided {
            Some(verdict) => verdict,
            None => {
                let status = Box::pin(crate::forge::resolve_status(&path)).await.ok();
                (
                    status.as_ref().is_some_and(pull_requests_ready),
                    status.and_then(|s| s.login),
                )
            }
        };
        out.push(BackgroundRepoStatus {
            path,
            provider,
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

    fn route(path: &str, provider: Provider, host: Option<&str>) -> Route {
        (path.to_string(), provider, host.map(str::to_string))
    }

    fn verdicts(entries: &[(&str, bool, Option<&str>)]) -> HostVerdicts {
        entries
            .iter()
            .map(|(host, healthy, login)| (host.to_string(), (*healthy, login.map(str::to_string))))
            .collect()
    }

    #[test]
    fn a_github_route_with_a_readable_host_needs_the_probe() {
        let routes: Vec<_> = (0..10)
            .map(|i| route(&format!("/r{i}"), Provider::GitHub, Some("github.com")))
            .collect();
        assert!(needs_github_probe(&routes));
        let mixed = vec![
            route("/c", Provider::GitLab, Some("gitlab.com")),
            route("/a", Provider::GitHub, Some("ghe.corp:8443")),
        ];
        assert!(needs_github_probe(&mixed));
    }

    #[test]
    fn no_probe_without_a_readable_github_route() {
        assert!(!needs_github_probe(&[]));
        let routes = vec![
            route("/no-origin", Provider::GitHub, None),
            route("/c", Provider::GitLab, Some("gitlab.com")),
            route("/f", Provider::Bitbucket, Some("bitbucket.org")),
        ];
        assert!(!needs_github_probe(&routes));
    }

    #[test]
    fn an_unreadable_origin_is_never_ready() {
        let v = verdicts(&[("github.com", true, Some("octo"))]);
        assert_eq!(github_verdict(None, &v), Some((false, None)));
        // Not even the empty-map per-repo fallback: nothing could poll it.
        assert_eq!(
            github_verdict(None, &HostVerdicts::new()),
            Some((false, None))
        );
    }

    #[test]
    fn an_empty_map_defers_to_the_per_repo_probe() {
        let empty = HostVerdicts::new();
        assert_eq!(github_verdict(Some("github.com"), &empty), None);
        assert_eq!(github_verdict(Some("github.com-work"), &empty), None);
    }

    #[test]
    fn a_registered_host_reads_only_its_own_verdict() {
        let v = verdicts(&[
            ("github.com", true, Some("octo")),
            ("ghe.corp:8443", false, Some("corp-me")),
        ]);
        assert_eq!(
            github_verdict(Some("github.com"), &v),
            Some((true, Some("octo".into())))
        );
        // A healthy github.com never lends readiness to a broken registered host.
        assert_eq!(
            github_verdict(Some("ghe.corp:8443"), &v),
            Some((false, Some("corp-me".into())))
        );
    }

    #[test]
    fn an_unknown_host_defers_to_the_per_repo_probe() {
        // A healthy host in the map never lends readiness to a spelling gh doesn't key.
        let v = verdicts(&[
            ("ghe.corp", true, Some("corp-me")),
            ("github.com", true, Some("octo")),
        ]);
        assert_eq!(github_verdict(Some("github.com-work"), &v), None);
        assert_eq!(github_verdict(Some("www.github.com"), &v), None);
        assert_eq!(github_verdict(Some("ghe.unregistered.corp"), &v), None);
    }

    #[test]
    fn wire_shape_is_camel_case_with_null_options() {
        let absent = BackgroundRepoStatus {
            path: "/r".into(),
            provider: Provider::GitHub,
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
            provider: Provider::GitLab,
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
