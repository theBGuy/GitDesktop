//! Repository rulesets — the modern, layered replacement for classic branch
//! protection. The frontend builds the (large, nested) ruleset JSON to GitHub's
//! schema and we forward it; reads return the raw object for the editor to seed
//! from. `gh ruleset` is read-only, so every write is a raw `gh api`.
//!
//! Key affordance: "disable" is a reversible `enforcement: "disabled"` (the
//! ruleset is retained), NOT a delete — so `gh_ruleset_set_enforcement` does a
//! GET-then-PUT to flip only enforcement without dropping the rules.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::github::runner::{run_gh, run_gh_input, GH_NETWORK_TIMEOUT};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesetSummary {
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub enforcement: String,
    /// "Repository" | "Organization" — org rulesets are read-only from a repo.
    #[serde(default, alias = "source_type")]
    pub source_type: String,
}

fn validate_enforcement(e: &str) -> AppResult<()> {
    if !matches!(e, "active" | "evaluate" | "disabled") {
        return Err(AppError::InvalidArgument(format!(
            "invalid enforcement: {e}"
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn gh_rulesets_list(repo_path: String) -> AppResult<Vec<RulesetSummary>> {
    // Pin the origin slug: `gh api`'s `{owner}/{repo}` placeholders auto-resolve
    // to the PARENT on a fork with an `upstream` remote, so build the literal
    // `repos/<slug>` path to keep ruleset admin on the user's own fork.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &["api", &format!("repos/{slug}/rulesets?per_page=100")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse rulesets: {e}")))
}

/// The full ruleset object (raw GitHub JSON), for the editor to seed from.
#[tauri::command]
pub async fn gh_ruleset_get(repo_path: String, id: u64) -> AppResult<Value> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &["api", &format!("repos/{slug}/rulesets/{id}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the ruleset: {e}")))
}

#[tauri::command]
pub async fn gh_ruleset_create(repo_path: String, body: Value) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "POST",
            &format!("repos/{slug}/rulesets"),
            "--input",
            "-",
        ],
        &body.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_ruleset_update(repo_path: String, id: u64, body: Value) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "PUT",
            &format!("repos/{slug}/rulesets/{id}"),
            "--input",
            "-",
        ],
        &body.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_ruleset_delete(repo_path: String, id: u64) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "DELETE",
            &format!("repos/{slug}/rulesets/{id}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// The `required_status_checks` contexts in a `/rules/branches/{branch}` response,
/// in GitHub's own order and deduplicated — several rulesets may require the same
/// context. Contexts are trimmed to match the editor's own normalizer
/// (`storedCheckEntries`), so a ruleset authored elsewhere with a padded context
/// still joins the check reporting under the bare name. Pure so the shape is pinned
/// without a live `gh` call.
fn required_check_contexts(rules: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for rule in rules.as_array().into_iter().flatten() {
        if rule.get("type").and_then(Value::as_str) != Some("required_status_checks") {
            continue;
        }
        let checks = rule
            .pointer("/parameters/required_status_checks")
            .and_then(Value::as_array);
        for check in checks.into_iter().flatten() {
            let Some(context) = check.get("context").and_then(Value::as_str) else {
                continue;
            };
            let context = context.trim();
            if context.is_empty() || out.iter().any(|c| c == context) {
                continue;
            }
            out.push(context.to_string());
        }
    }
    out
}

/// The approving reviews the branch's `pull_request` rules demand, or `None` when no
/// such rule names a count. The MAXIMUM across rules: several rulesets may each set a
/// count and GitHub enforces the strictest. A count of zero is "no approvals required"
/// — the same thing as an absent rule to a reader, so it reads as `None` rather than
/// "0 approving reviews".
fn required_approving_reviews(rules: &Value) -> Option<u32> {
    rules
        .as_array()
        .into_iter()
        .flatten()
        .filter(|rule| rule.get("type").and_then(Value::as_str) == Some("pull_request"))
        .filter_map(|rule| {
            rule.pointer("/parameters/required_approving_review_count")
                .and_then(Value::as_u64)
                // Out-of-u32-range counts DROP rather than truncate — `as u32` would
                // turn a nonsense 2^32+1 into a fabricated "1 approving review".
                .and_then(|n| u32::try_from(n).ok())
        })
        .filter(|n| *n > 0)
        .max()
}

/// What the base branch's active rules demand of a pull request, for the blocked-merge
/// line. Approvals ride alongside the check contexts because the PR's own check rollup
/// can never name them — nothing in it corresponds to a review requirement.
#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchRequiredRules {
    pub contexts: Vec<String>,
    pub required_approving_review_count: Option<u32>,
}

/// A branch name made safe for the `rules/branches/{branch}` path. gh parses the URL
/// with Go's `url.Parse`, where a raw `#` opens a FRAGMENT — `master#x` reads
/// `master`'s rules, naming another branch's checks — and a bare `%` fails the parse.
/// `/` stays raw on purpose: the endpoint takes the rest of the path as the branch, so
/// `release/1.0` must survive intact. That is why `encode_query_value` is the wrong
/// tool here — it emits `%2F`.
/// Refuse a ref that carries `{` or `}` before it reaches an endpoint. gh expands `{…}`
/// in an endpoint as an owner/repo placeholder, which retargets the request at another
/// repo; `escape_branch_path` covers `#`/`%` but deliberately not these. `what` names the
/// value in the message ("this branch" / "the default branch").
fn refuse_braced(what: &str, value: &str) -> AppResult<()> {
    if value.contains('{') || value.contains('}') {
        return Err(AppError::Gh(format!(
            "{what} cannot be addressed as an endpoint: {value}"
        )));
    }
    Ok(())
}

fn escape_branch_path(branch: &str) -> String {
    // `%` first: escaping it second would rewrite the `%` of the `%23` just written.
    branch.replace('%', "%25").replace('#', "%23")
}

/// What the branch's active rules require, for the pull-request view's blocked-merge
/// line. `/rules/branches` aggregates every ruleset that applies and answers `[]` for a
/// readable branch under no rules. A branch the token can't read — or a name the ref
/// gate refuses — is an Err, like every other `run_gh` non-zero exit; the caller may
/// treat that as empty, but it is not reported as empty. One response feeds both the
/// contexts and the approvals count — the approvals rule rides the same payload.
#[tauri::command]
pub async fn gh_branch_required_checks(
    repo_path: String,
    branch: String,
    lens: Option<String>,
) -> AppResult<BranchRequiredRules> {
    // Both guards are needed: the ref gate rejects refspec metacharacters but permits
    // `#`/`%`, which are legal in a git ref and special in a URL.
    crate::git::branches::validate_branch_name(&branch)?;
    // Braces are the third case. Refused BEFORE the slug resolution, so a bad name
    // spawns no git or gh.
    refuse_braced("this branch", &branch)?;
    // The lens slug, not the origin one: a fork PR's base branch — and its rules —
    // live in the repo the PR targets.
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "api",
            &format!(
                "repos/{slug}/rules/branches/{}",
                escape_branch_path(&branch)
            ),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let rules: Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the branch rules: {e}")))?;
    Ok(BranchRequiredRules {
        contexts: required_check_contexts(&rules),
        required_approving_review_count: required_approving_reviews(&rules),
    })
}

/// Flips only `enforcement` (the reversible soft-off). PUT is a full replace, so
/// we GET the ruleset and resend its writable fields with the new enforcement —
/// the rules are preserved.
#[tauri::command]
pub async fn gh_ruleset_set_enforcement(
    repo_path: String,
    id: u64,
    enforcement: String,
) -> AppResult<()> {
    validate_enforcement(&enforcement)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &["api", &format!("repos/{slug}/rulesets/{id}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let full: Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the ruleset: {e}")))?;
    let body = json!({
        "name": full.get("name").cloned().unwrap_or(json!("")),
        "target": full.get("target").cloned().unwrap_or(json!("branch")),
        "enforcement": enforcement,
        "bypass_actors": full.get("bypass_actors").cloned().unwrap_or(json!([])),
        "conditions": full.get("conditions").cloned().unwrap_or(json!({})),
        "rules": full.get("rules").cloned().unwrap_or(json!([])),
    });
    gh_ruleset_update(repo_path, id, body).await
}

/// One GitHub App that reports checks on this repo, for naming a required-check
/// entry's `integration_id` pin.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckApp {
    pub id: u64,
    pub name: String,
    pub slug: String,
}

/// The distinct apps reporting the check runs in a `commits/{ref}/check-runs`
/// response, in first-appearance order — one app reports every run of a matrix job.
/// Every field is optional: this is third-party JSON, and a run naming no app id
/// resolves no pin whatever else it carries.
fn check_run_apps(payload: &Value) -> Vec<CheckApp> {
    let mut out: Vec<CheckApp> = Vec::new();
    let runs = payload.pointer("/check_runs").and_then(Value::as_array);
    for run in runs.into_iter().flatten() {
        let Some(app) = run.get("app") else { continue };
        let Some(id) = app.get("id").and_then(Value::as_u64) else {
            continue;
        };
        if out.iter().any(|a| a.id == id) {
            continue;
        }
        let field = |key| app.get(key).and_then(Value::as_str).unwrap_or("").to_string();
        out.push(CheckApp {
            id,
            name: field("name"),
            slug: field("slug"),
        });
    }
    out
}

/// The apps behind this repo's checks, so the ruleset editor can name each
/// required-check pin. GitHub publishes no id→name lookup for an app, and the
/// latest check runs on the default branch's head are the repo-scoped source of
/// those identities. One page of them, deliberately: the distinct apps on a head
/// commit are a handful, and a pin to an app that never reported there stays
/// unresolved and renders as its raw id.
#[tauri::command]
pub async fn gh_check_run_apps(repo_path: String) -> AppResult<Vec<CheckApp>> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &["api", &format!("repos/{slug}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let repo: Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the repository: {e}")))?;
    let branch = repo
        .get("default_branch")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Gh("the repository names no default branch".into()))?;
    refuse_braced("the default branch", branch)?;
    let endpoint = format!(
        "repos/{slug}/commits/{}/check-runs",
        escape_branch_path(branch)
    );
    let out = run_gh(
        Some(&repo_path),
        &["api", "--method", "GET", &endpoint, "-f", "per_page=100"],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let payload: Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the check runs: {e}")))?;
    Ok(check_run_apps(&payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contexts(raw: &str) -> Vec<String> {
        required_check_contexts(&serde_json::from_str::<Value>(raw).expect("valid JSON"))
    }

    fn approvals(raw: &str) -> Option<u32> {
        required_approving_reviews(&serde_json::from_str::<Value>(raw).expect("valid JSON"))
    }

    fn apps(raw: &str) -> Vec<(u64, String, String)> {
        check_run_apps(&serde_json::from_str::<Value>(raw).expect("valid JSON"))
            .into_iter()
            .map(|a| (a.id, a.name, a.slug))
            .collect()
    }

    #[test]
    fn reads_the_approvals_count_the_same_payload_already_carries() {
        // The `pull_request` rule rides the very response the contexts come from, so
        // naming approvals costs no second call.
        let raw = r#"[
            {"type":"pull_request","parameters":{"required_approving_review_count":2,"dismiss_stale_reviews_on_push":true}},
            {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"build"}]}}
        ]"#;
        assert_eq!(approvals(raw), Some(2));
        assert_eq!(contexts(raw), vec!["build"]);
    }

    #[test]
    fn the_strictest_rule_wins_and_no_requirement_reads_as_none() {
        assert_eq!(
            approvals(
                r#"[
                    {"type":"pull_request","parameters":{"required_approving_review_count":1}},
                    {"type":"pull_request","parameters":{"required_approving_review_count":3}}
                ]"#
            ),
            Some(3)
        );
        // The u32 conversion runs per-value, BEFORE the max: an out-of-range nonsense
        // count drops while its in-range sibling still names the requirement.
        assert_eq!(
            approvals(
                r#"[
                    {"type":"pull_request","parameters":{"required_approving_review_count":4294967297}},
                    {"type":"pull_request","parameters":{"required_approving_review_count":3}}
                ]"#
            ),
            Some(3)
        );
        // Absent rule, absent field, a zero count, and shapes the endpoint never
        // promised all mean "no approvals to name" — never a fabricated 0.
        for raw in [
            "[]",
            r#"[{"type":"required_status_checks","parameters":{"required_status_checks":[]}}]"#,
            r#"[{"type":"pull_request"}]"#,
            r#"[{"type":"pull_request","parameters":{}}]"#,
            r#"[{"type":"pull_request","parameters":{"required_approving_review_count":0}}]"#,
            r#"[{"type":"pull_request","parameters":{"required_approving_review_count":"two"}}]"#,
            // Past u32: dropped, never truncated (`as` would fabricate "1" from 2^32+1).
            r#"[{"type":"pull_request","parameters":{"required_approving_review_count":4294967297}}]"#,
            r#"{"message":"Not Found"}"#,
        ] {
            assert_eq!(approvals(raw), None, "raw: {raw}");
        }
    }

    #[test]
    fn the_rules_shape_serializes_camel_case() {
        // The frontend reads `requiredApprovingReviewCount`; an absent count must
        // travel as an explicit null rather than vanishing from the object.
        let json = serde_json::to_string(&BranchRequiredRules {
            contexts: vec!["build".into()],
            required_approving_review_count: None,
        })
        .expect("serializes");
        assert_eq!(
            json,
            r#"{"contexts":["build"],"requiredApprovingReviewCount":null}"#
        );
    }

    #[test]
    fn reads_the_contexts_of_a_live_rules_response() {
        // Verbatim `gh api repos/theBGuy/GitDesktop/rules/branches/master`, so the
        // parser is pinned against the shape the endpoint actually returns.
        let raw = r#"[{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,"do_not_enforce_on_create":false,"required_status_checks":[{"context":"build"},{"context":"fragment"}]},"ruleset_source_type":"Repository","ruleset_source":"theBGuy/GitDesktop","ruleset_id":20332127}]"#;
        assert_eq!(contexts(raw), vec!["build", "fragment"]);
    }

    #[test]
    fn ignores_rules_of_every_other_type() {
        let raw = r#"[
            {"type":"pull_request","parameters":{"required_approving_review_count":1}},
            {"type":"deletion"},
            {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"lint","integration_id":15368}]}}
        ]"#;
        assert_eq!(contexts(raw), vec!["lint"]);
    }

    #[test]
    fn dedupes_a_context_required_by_two_rulesets() {
        let raw = r#"[
            {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"build"},{"context":"test"}]}},
            {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"build"}]}}
        ]"#;
        assert_eq!(contexts(raw), vec!["build", "test"]);
        // Padding is not identity: a ruleset authored outside this app's editor can
        // carry " ci ", which names the same check as the bare "ci" beside it — and
        // a unique padded context still has to come out matching its check's name.
        let padded = r#"[
            {"type":"required_status_checks","parameters":{"required_status_checks":[{"context":" ci "},{"context":"ci"},{"context":"  lint\t"}]}}
        ]"#;
        assert_eq!(contexts(padded), vec!["ci", "lint"]);
    }

    #[test]
    fn escapes_only_what_go_url_parse_would_misread() {
        // Measured against `gh api`: `…/branches/master#x` returns MASTER's rules (the
        // `#` opened a fragment), and `…/branches/master%x` fails url.Parse outright.
        assert_eq!(escape_branch_path("feat#2"), "feat%232");
        assert_eq!(escape_branch_path("100%done"), "100%25done");
        // A name that already reads like an escape is data, not an escape.
        assert_eq!(escape_branch_path("v%23"), "v%2523");
        // Order proof: `#` first would re-escape the `%` of its own `%23`.
        assert_eq!(escape_branch_path("a#b%c"), "a%23b%25c");
        // `/` rides raw — the endpoint matches the rest of the path as the branch.
        assert_eq!(escape_branch_path("release/1.0"), "release/1.0");
        assert_eq!(escape_branch_path("master"), "master");
    }

    #[test]
    fn an_unprotected_branch_requires_nothing() {
        assert_eq!(contexts("[]"), Vec::<String>::new());
    }

    #[test]
    fn tolerates_shapes_the_endpoint_never_promised() {
        // A rules read that isn't a list of well-formed rules yields no contexts
        // rather than panicking — the banner falls back to its generic line.
        for raw in [
            r#"{"message":"Not Found"}"#,
            r#"[{"type":"required_status_checks"}]"#,
            r#"[{"type":"required_status_checks","parameters":{"required_status_checks":{}}}]"#,
            r#"[{"type":"required_status_checks","parameters":{"required_status_checks":[{},{"context":42},{"context":""},{"context":"  "}]}}]"#,
        ] {
            assert_eq!(contexts(raw), Vec::<String>::new(), "raw: {raw}");
        }
    }

    #[test]
    fn the_check_app_shape_serializes_camel_case() {
        // The editor joins these against a stored entry's `integration_id`, so the
        // id must travel as a JSON number rather than a string.
        let json = serde_json::to_string(&CheckApp {
            id: 15368,
            name: "GitHub Actions".into(),
            slug: "github-actions".into(),
        })
        .expect("serializes");
        assert_eq!(
            json,
            r#"{"id":15368,"name":"GitHub Actions","slug":"github-actions"}"#
        );
    }

    #[test]
    fn names_each_app_reporting_a_check_once() {
        // Trimmed from `gh api repos/theBGuy/GitDesktop/commits/master/check-runs`:
        // one app reports every leg of a matrix job, so it must be named once.
        let raw = r#"{"total_count":8,"check_runs":[
            {"name":"Cloudflare Pages","app":{"id":85455,"name":"Cloudflare Workers and Pages","slug":"cloudflare-workers-and-pages"}},
            {"name":"rebuild","app":{"id":15368,"name":"GitHub Actions","slug":"github-actions"}},
            {"name":"test (ubuntu-24.04)","app":{"id":15368,"name":"GitHub Actions","slug":"github-actions"}}
        ]}"#;
        assert_eq!(
            apps(raw),
            vec![
                (
                    85455,
                    "Cloudflare Workers and Pages".to_string(),
                    "cloudflare-workers-and-pages".to_string()
                ),
                (
                    15368,
                    "GitHub Actions".to_string(),
                    "github-actions".to_string()
                ),
            ]
        );
    }

    #[test]
    fn tolerates_check_runs_the_endpoint_never_promised() {
        // A run naming no app id resolves no pin and drops; one missing only its
        // display fields still resolves by id, and renders as that id.
        assert_eq!(
            apps(r#"{"check_runs":[{"app":null},{},{"app":{"name":"no id"}},{"app":{"id":7}}]}"#),
            vec![(7, String::new(), String::new())]
        );
        for raw in [
            r#"{"message":"Not Found"}"#,
            r#"{"check_runs":{}}"#,
            r#"{"check_runs":[]}"#,
            "[]",
        ] {
            assert!(apps(raw).is_empty(), "raw: {raw}");
        }
    }

    /// Both ref gates admit a bare `{`: git allows it in a ref, and the branch gate's
    /// rev-expression rejections cover `@{` but not `x{y}`. The endpoint guard is
    /// therefore the only thing between a crafted branch and a retargeted request.
    #[tokio::test]
    async fn a_braced_branch_is_refused_before_any_spawn() {
        assert!(
            crate::git::branches::validate_branch_name("main{owner}").is_ok(),
            "the premise: the ref gates let this through"
        );
        // A repo path that cannot resolve: if the guard did NOT fire, the failure
        // would come from git/gh with a different message, so the assertion below is
        // also the proof that nothing was spawned.
        let err = gh_branch_required_checks(
            "C:/no-such-repo-a-braced-branch-test".to_string(),
            "main{owner}".to_string(),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().contains("cannot be addressed as an endpoint"),
            "must fail on the brace guard, not on the unresolvable repo: {err}"
        );
    }
}
