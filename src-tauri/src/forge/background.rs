//! Batch forge readiness for the background PR-sync poller: one call per tick
//! answers "which of these repos can be polled for PRs right now". Each provider in
//! the batch pays one auth probe per host per tick (gh's registered hosts, each
//! GitLab host, the single Bitbucket account) instead of one per repo; a repo whose
//! host its provider's probe can't key pays the per-repo `resolve_status` probe.

use std::collections::HashMap;

use serde::Serialize;

use crate::error::AppResult;
use crate::forge::http::BB_HOST;
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

/// A host's `(ready, login)` for this tick.
type Verdict = (bool, Option<String>);

/// Per probed host: whether its sign-in can poll PRs, and its active login.
type HostVerdicts = HashMap<String, Verdict>;

/// For each GitLab route whose host resolves, keyed by path: the host glab pins its
/// probes to — the same `origin` web authority the per-repo runner resolves, which
/// may differ from the route's own `host` spelling.
type GitlabHosts = HashMap<String, String>;

/// Each provider's host verdicts for one tick. A provider absent from the batch
/// keeps an empty map, so none of its repos can read a verdict from it.
#[derive(Default)]
struct TickVerdicts {
    github: HostVerdicts,
    gitlab: HostVerdicts,
    bitbucket: HostVerdicts,
}

/// Whether any route needs the gh probe: a GitHub route with a readable host. Routes
/// without one are never ready, so a batch of only those spends no gh call.
fn needs_github_probe(routes: &[Route]) -> bool {
    routes
        .iter()
        .any(|(_, provider, host)| *provider == Provider::GitHub && host.is_some())
}

/// Whether any route needs the Bitbucket account probe.
fn needs_bitbucket_probe(routes: &[Route]) -> bool {
    routes
        .iter()
        .any(|(_, provider, _)| *provider == Provider::Bitbucket)
}

/// One `(host, repo path)` per distinct GitLab host in the batch, first-seen order:
/// the tick spends one probe on each, addressed through the first repo on that host.
/// Repos without a resolved host are absent and take the per-repo probe, so a batch
/// of only those spends no batched spawn.
fn gitlab_probe_targets<'a>(
    routes: &'a [Route],
    gitlab_hosts: &'a GitlabHosts,
) -> Vec<(&'a str, &'a str)> {
    let mut targets: Vec<(&str, &str)> = Vec::new();
    for (path, provider, _) in routes {
        if *provider != Provider::GitLab {
            continue;
        }
        if let Some(host) = gitlab_hosts.get(path) {
            if !targets.iter().any(|(seen, _)| *seen == host.as_str()) {
                targets.push((host, path));
            }
        }
    }
    targets
}

/// The one lookup every provider's verdict goes through: a host the tick probed
/// answers with its own verdict; a miss takes the per-repo probe, never another
/// host's readiness.
fn host_verdict(host: &str, verdicts: &HostVerdicts) -> Option<Verdict> {
    verdicts.get(host).cloned()
}

/// A GitHub route's `(ready, login)` from the tick's host verdicts, or `None` to take
/// the per-repo `resolve_status` probe instead. No host → not ready. A host gh has
/// registered → that host's own verdict, so a broken account on one host never gates
/// another's. Any other host (an ssh alias, `www.`, an unregistered Enterprise host)
/// → `None`, as is every host over an empty map: it can't tell "no host signed in"
/// from an unreadable probe (old gh without `--json`), and the per-repo probe answers
/// both correctly.
fn github_verdict(host: Option<&str>, verdicts: &HostVerdicts) -> Option<Verdict> {
    let Some(host) = host else {
        return Some((false, None));
    };
    host_verdict(host, verdicts)
}

/// A GitLab route's verdict from the tick's per-host probes, keyed by the host glab
/// pins (see [`GitlabHosts`]). An unresolvable host takes the per-repo probe, which
/// still answers through glab's own default routing.
fn gitlab_verdict(host: Option<&str>, verdicts: &HostVerdicts) -> Option<Verdict> {
    host.and_then(|host| host_verdict(host, verdicts))
}

/// A Bitbucket route's verdict: Bitbucket Cloud stores one account for every repo,
/// so the tick's single probe is keyed by [`BB_HOST`] whatever the route's spelling.
fn bitbucket_verdict(verdicts: &HostVerdicts) -> Option<Verdict> {
    host_verdict(BB_HOST, verdicts)
}

/// A route's verdict from its own provider's map, or `None` to take the per-repo
/// `resolve_status` probe.
fn route_verdict(
    provider: Provider,
    host: Option<&str>,
    gitlab_host: Option<&str>,
    tick: &TickVerdicts,
) -> Option<Verdict> {
    match provider {
        Provider::GitHub => github_verdict(host, &tick.github),
        Provider::GitLab => gitlab_verdict(gitlab_host, &tick.gitlab),
        Provider::Bitbucket => bitbucket_verdict(&tick.bitbucket),
    }
}

/// A host-level status's verdict: [`pull_requests_ready`] minus the repo slug, which
/// a host probe can't see — the PR poll derives the slug itself and fails per repo.
/// A failed probe (`None`) reads as not ready.
fn status_verdict(status: Option<&ForgeStatus>) -> Verdict {
    match status {
        Some(s) => (
            s.installed && s.authenticated && s.implemented.pull_requests,
            s.login.clone(),
        ),
        None => (false, None),
    }
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

/// Background PR-sync readiness for many repos at once. Each provider's map is built
/// once per tick, and only when the batch holds a repo that can read it: one gh probe
/// for its registered hosts, one glab auth probe (plus a login lookup, cached two
/// minutes on success) per GitLab host, one `/user` read for the Bitbucket account.
/// On a host its probe answers, readiness skips the repo slug: the PR poll derives it
/// and fails loudly per repo. A GitHub repo whose `origin` host is unreadable (no
/// origin, a local-path remote) is not ready: `gh_pr_poll` needs that origin, and
/// `github_host_for_repo`'s github.com default would otherwise read it as ready. A
/// repo its provider's map can't key (see [`route_verdict`]) takes the per-repo
/// `resolve_status` probe; a failed probe reads as not-ready rather than failing the
/// batch.
#[tauri::command]
pub async fn forge_background_statuses(paths: Vec<String>) -> AppResult<Vec<BackgroundRepoStatus>> {
    let mut routes: Vec<Route> = Vec::with_capacity(paths.len());
    let mut gitlab_hosts = GitlabHosts::new();
    for path in paths {
        let route = match crate::forge::detect_non_github(&path).await {
            Some((Provider::GitLab, host)) => {
                // The per-repo runner's own host resolution (`glab::repo_host`'s
                // resolved arm), so a batched probe addresses the instance it would.
                let pinned = crate::git::remote::git_remote_url(path.clone(), "origin".into())
                    .await
                    .ok()
                    .and_then(|url| crate::forge::glab::cwd_host(Some(&url)));
                if let Some(pinned) = pinned {
                    gitlab_hosts.insert(path.clone(), pinned);
                }
                (path, Provider::GitLab, Some(host))
            }
            Some((Provider::Bitbucket, host)) => (path, Provider::Bitbucket, Some(host)),
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

    let mut tick = TickVerdicts::default();
    if needs_github_probe(&routes) {
        tick.github = Box::pin(github_hosts_health_for_poller())
            .await
            .into_iter()
            .map(|(host, health)| {
                let healthy = matches!(health.state, SessionState::Healthy);
                (host, (healthy, health.login))
            })
            .collect();
    }
    for (host, path) in gitlab_probe_targets(&routes, &gitlab_hosts) {
        let status = Box::pin(crate::forge::gitlab::host_status(path, host)).await;
        tick.gitlab
            .insert(host.to_string(), status_verdict(Some(&status)));
    }
    if needs_bitbucket_probe(&routes) {
        // A failed probe still fills the map: every repo on the account would fail the
        // same way, so falling back per repo would only multiply the request.
        let status = Box::pin(crate::forge::bitbucket::account_status(BB_HOST))
            .await
            .ok();
        tick.bitbucket
            .insert(BB_HOST.to_string(), status_verdict(status.as_ref()));
    }

    let mut out = Vec::with_capacity(routes.len());
    for (path, provider, host) in routes {
        let gitlab_host = gitlab_hosts.get(&path).map(String::as_str);
        let decided = route_verdict(provider, host.as_deref(), gitlab_host, &tick);
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

    fn gitlab_hosts(entries: &[(&str, &str)]) -> GitlabHosts {
        entries
            .iter()
            .map(|(path, host)| (path.to_string(), host.to_string()))
            .collect()
    }

    fn tick(github: HostVerdicts, gitlab: HostVerdicts, bitbucket: HostVerdicts) -> TickVerdicts {
        TickVerdicts {
            github,
            gitlab,
            bitbucket,
        }
    }

    #[test]
    fn gitlab_repos_on_one_host_take_one_probe() {
        let routes: Vec<_> = (0..5)
            .map(|i| route(&format!("/g{i}"), Provider::GitLab, Some("gitlab.com")))
            .collect();
        let hosts: GitlabHosts = (0..5)
            .map(|i| (format!("/g{i}"), "gitlab.com".to_string()))
            .collect();
        assert_eq!(
            gitlab_probe_targets(&routes, &hosts),
            vec![("gitlab.com", "/g0")]
        );
    }

    #[test]
    fn distinct_gitlab_hosts_take_one_probe_each() {
        let routes = vec![
            route("/a", Provider::GitLab, Some("gitlab.com")),
            route("/b", Provider::GitLab, Some("gitlab.corp")),
            route("/c", Provider::GitLab, Some("gitlab.com")),
            route("/d", Provider::GitLab, Some("gitlab.corp")),
        ];
        let hosts = gitlab_hosts(&[
            ("/a", "gitlab.com"),
            ("/b", "gitlab.corp:8443"),
            ("/c", "gitlab.com"),
            ("/d", "gitlab.corp:8443"),
        ]);
        // Grouped by the pinned host, not the route's own spelling.
        assert_eq!(
            gitlab_probe_targets(&routes, &hosts),
            vec![("gitlab.com", "/a"), ("gitlab.corp:8443", "/b")]
        );
    }

    #[test]
    fn an_unresolvable_gitlab_host_takes_the_per_repo_probe() {
        let routes = vec![
            route("/unpinned", Provider::GitLab, Some("gitlab.com")),
            route("/pinned", Provider::GitLab, Some("gitlab.com")),
        ];
        let hosts = gitlab_hosts(&[("/pinned", "gitlab.com")]);
        assert_eq!(
            gitlab_probe_targets(&routes, &hosts),
            vec![("gitlab.com", "/pinned")]
        );
        let t = tick(
            HostVerdicts::new(),
            verdicts(&[("gitlab.com", true, Some("gl-me"))]),
            HostVerdicts::new(),
        );
        assert_eq!(
            route_verdict(Provider::GitLab, Some("gitlab.com"), Some("gitlab.com"), &t),
            Some((true, Some("gl-me".into())))
        );
        // Its route host is in the map, but only the pinned host keys a verdict.
        assert_eq!(
            route_verdict(Provider::GitLab, Some("gitlab.com"), None, &t),
            None
        );
        // A batch of only unresolvable repos spends no batched spawn.
        assert!(gitlab_probe_targets(&routes[..1], &hosts).is_empty());
    }

    #[test]
    fn a_gitlab_host_reads_only_its_own_verdict() {
        let t = tick(
            HostVerdicts::new(),
            verdicts(&[
                ("gitlab.com", true, Some("gl-me")),
                ("gitlab.corp", false, Some("corp-me")),
            ]),
            HostVerdicts::new(),
        );
        assert_eq!(
            route_verdict(
                Provider::GitLab,
                Some("gitlab.corp"),
                Some("gitlab.corp"),
                &t
            ),
            Some((false, Some("corp-me".into())))
        );
        // A healthy gitlab.com never lends readiness to a host the tick didn't probe.
        assert_eq!(
            route_verdict(Provider::GitLab, Some("gl.other"), Some("gl.other"), &t),
            None
        );
    }

    #[test]
    fn bitbucket_repos_share_the_one_account_verdict() {
        let routes: Vec<_> = (0..3)
            .map(|i| {
                route(
                    &format!("/b{i}"),
                    Provider::Bitbucket,
                    Some("bitbucket.org"),
                )
            })
            .collect();
        assert!(needs_bitbucket_probe(&routes));
        let t = tick(
            HostVerdicts::new(),
            HostVerdicts::new(),
            verdicts(&[(BB_HOST, true, Some("bb-me"))]),
        );
        for (_, provider, host) in &routes {
            assert_eq!(
                route_verdict(*provider, host.as_deref(), None, &t),
                Some((true, Some("bb-me".into())))
            );
        }
        // One account, whatever spelling the route's remote carries.
        assert_eq!(
            route_verdict(Provider::Bitbucket, Some("www.bitbucket.org"), None, &t),
            Some((true, Some("bb-me".into())))
        );
    }

    #[test]
    fn a_missing_bitbucket_token_mirrors_the_per_repo_not_ready_shape() {
        // Seam gap: `http::load_credentials` reads the OS keyring with no hermetic
        // override, so the arm's routing and its no-network return stay unpinned here.
        fn account_probe<F>(_: impl Fn(&'static str) -> F)
        where
            F: std::future::Future<Output = AppResult<ForgeStatus>>,
        {
        }
        account_probe(crate::forge::bitbucket::account_status);
        // The value that arm returns; `BitbucketForge::status` fills only `repo`.
        let account = crate::forge::bitbucket::no_token_status(BB_HOST);
        assert!(!account.installed && !account.authenticated);
        assert_eq!(
            (account.repo.as_deref(), account.login.as_deref()),
            (None, None)
        );
        let per_repo = ForgeStatus {
            repo: Some("w/r".into()),
            ..account.clone()
        };
        assert_eq!(status_verdict(Some(&account)), (false, None));
        assert_eq!(
            status_verdict(Some(&account)),
            (pull_requests_ready(&per_repo), per_repo.login.clone())
        );
        // A rejected token keeps the stored login, as the per-repo probe does.
        let mut rejected = status(Provider::Bitbucket, None);
        rejected.authenticated = false;
        rejected.login = Some("stored".into());
        assert_eq!(
            status_verdict(Some(&rejected)),
            (false, Some("stored".into()))
        );
        // An unreadable keyring or a failed request reads as not ready.
        assert_eq!(status_verdict(None), (false, None));
    }

    #[test]
    fn status_verdict_is_pull_requests_ready_minus_the_slug() {
        for provider in [Provider::GitLab, Provider::Bitbucket] {
            for (installed, authenticated, implemented) in [
                (true, true, true),
                (false, true, true),
                (true, false, true),
                (true, true, false),
            ] {
                let mut host_level = status(provider, None);
                host_level.installed = installed;
                host_level.authenticated = authenticated;
                host_level.implemented.pull_requests = implemented;
                host_level.login = Some("me".into());
                let slugged = ForgeStatus {
                    repo: Some("o/r".into()),
                    ..host_level.clone()
                };
                assert_eq!(
                    status_verdict(Some(&host_level)),
                    (pull_requests_ready(&slugged), Some("me".into()))
                );
            }
        }
    }

    #[test]
    fn a_mixed_tick_probes_only_the_providers_present() {
        let github = route("/h", Provider::GitHub, Some("github.com"));
        let gitlab = route("/g", Provider::GitLab, Some("gitlab.com"));
        let bitbucket = route("/b", Provider::Bitbucket, Some("bitbucket.org"));
        let hosts = gitlab_hosts(&[("/g", "gitlab.com")]);

        let all = vec![github.clone(), gitlab.clone(), bitbucket.clone()];
        assert!(needs_github_probe(&all));
        assert!(!gitlab_probe_targets(&all, &hosts).is_empty());
        assert!(needs_bitbucket_probe(&all));

        let no_bitbucket = vec![github.clone(), gitlab.clone()];
        assert!(!needs_bitbucket_probe(&no_bitbucket));
        let only_bitbucket = vec![bitbucket];
        assert!(!needs_github_probe(&only_bitbucket));
        assert!(gitlab_probe_targets(&only_bitbucket, &hosts).is_empty());
        assert!(needs_bitbucket_probe(&only_bitbucket));
        let only_github = vec![github];
        assert!(gitlab_probe_targets(&only_github, &hosts).is_empty());

        // Each provider reads its own map: a GitLab host present only in the gh map
        // is a miss, never a borrowed verdict.
        let t = tick(
            verdicts(&[
                ("github.com", true, Some("octo")),
                ("gitlab.com", true, Some("x")),
            ]),
            verdicts(&[("gitlab.com", false, Some("gl-me"))]),
            verdicts(&[(BB_HOST, true, Some("bb-me"))]),
        );
        assert_eq!(
            route_verdict(Provider::GitHub, Some("github.com"), None, &t),
            Some((true, Some("octo".into())))
        );
        assert_eq!(
            route_verdict(Provider::GitLab, Some("gitlab.com"), Some("gitlab.com"), &t),
            Some((false, Some("gl-me".into())))
        );
        assert_eq!(
            route_verdict(Provider::Bitbucket, Some("bitbucket.org"), None, &t),
            Some((true, Some("bb-me".into())))
        );
        let gh_only = tick(
            verdicts(&[("gitlab.com", true, Some("x"))]),
            HostVerdicts::new(),
            HostVerdicts::new(),
        );
        assert_eq!(
            route_verdict(
                Provider::GitLab,
                Some("gitlab.com"),
                Some("gitlab.com"),
                &gh_only
            ),
            None
        );
    }

    #[test]
    fn every_provider_takes_the_per_repo_probe_on_a_map_miss() {
        let empty = TickVerdicts::default();
        assert_eq!(
            route_verdict(Provider::GitHub, Some("github.com"), None, &empty),
            None
        );
        assert_eq!(
            route_verdict(
                Provider::GitLab,
                Some("gitlab.com"),
                Some("gitlab.com"),
                &empty
            ),
            None
        );
        assert_eq!(
            route_verdict(Provider::Bitbucket, Some("bitbucket.org"), None, &empty),
            None
        );
    }
}
