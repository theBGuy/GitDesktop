//! The viewer's teams in the open repo's org — the option list behind the PR
//! list's team-review-request filter.
//!
//! `user/teams` returns a BARE slug per team, but the search qualifier is
//! org-qualified (`team-review-requested:org/slug`), and GitHub answers an
//! unresolvable team slug by zeroing the whole OR group it sits in rather than by
//! erroring. Composing the qualified form here — from each team's own organization
//! login — is what keeps the filter from silently emptying a list.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::runner::{run_gh, GH_NETWORK_TIMEOUT};

/// One team the viewer belongs to, ready to drop into a search qualifier.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TeamRef {
    /// ORG-QUALIFIED `"org/slug"` — the exact form the search qualifier takes,
    /// spelled with the organization login GitHub itself returned.
    pub slug: String,
    /// The team's display name, for the picker row.
    pub name: String,
}

/// The viewer's teams in this repo's org, and whether the read was scope-limited.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MyTeams {
    pub teams: Vec<TeamRef>,
    /// The token lacks `read:org`, so `teams` is empty for a reason the UI must
    /// state rather than presenting it as "you're in no teams".
    pub missing_scope: bool,
}

/// One raw `user/teams` row. Tolerant throughout — this is untrusted API JSON, and
/// a row missing the fields we key on is dropped, not defaulted into a team that
/// would zero every search it joins.
#[derive(Deserialize)]
struct RawTeam {
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    organization: Option<RawOrg>,
}

#[derive(Deserialize)]
struct RawOrg {
    #[serde(default)]
    login: Option<String>,
}

/// Whether a gh failure is the missing-`read:org` signature — gh names the scope in
/// its hint, and that NAME is the only reliable signal.
///
/// The status code is not: SAML SSO enforcement and secondary rate limits answer 403
/// on this endpoint too, and telling a user to grant a scope they already hold sends
/// them somewhere that can't fix it (the frontend caches this answer, so a
/// misclassification sticks). Those propagate as errors instead.
fn is_missing_org_scope(stderr: &str) -> bool {
    stderr.to_ascii_lowercase().contains("read:org")
}

/// Flatten `--paginate --slurp` output — an outer array of PAGES, each itself the
/// endpoint's own array — into one list. Pure: `--slurp` nests one level deeper than
/// an unpaginated body, so reading the outer array as the payload would drop every
/// team. Mirrors `pr::flatten_slurped_pages`.
fn flatten_slurped_pages(pages: Vec<Vec<RawTeam>>) -> Vec<RawTeam> {
    pages.into_iter().flatten().collect()
}

/// Keep the teams whose organization is this repo's owner, qualified for the search.
/// Pure, so the compose step — the whole reason this module exists — is pinned
/// without a spawn. Org logins compare case-insensitively (GitHub's own comparison),
/// but the EMITTED slug uses the organization's own spelling from the response.
fn teams_in_org(raw: Vec<RawTeam>, owner: &str) -> Vec<TeamRef> {
    raw.into_iter()
        .filter_map(|t| {
            let slug = t.slug.filter(|s| !s.is_empty())?;
            let org = t
                .organization
                .and_then(|o| o.login)
                .filter(|l| !l.is_empty())?;
            if !org.eq_ignore_ascii_case(owner) {
                return None;
            }
            let name = t
                .name
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| slug.clone());
            Some(TeamRef {
                slug: format!("{org}/{slug}"),
                name,
            })
        })
        .collect()
}

/// The viewer's teams in the lens repo's organization. A repo owned by a USER has
/// no teams, so it yields an empty list with `missing_scope: false` — an answer,
/// not a gap.
pub async fn my_teams(repo_path: &str, lens: Option<&str>) -> AppResult<MyTeams> {
    let slug = crate::github::gh_lens_slug(repo_path, lens).await?;
    let owner = slug.split('/').next().unwrap_or_default().to_string();
    // `--slurp` is what makes the pagination version-proof, not a shape preference:
    // gh 2.94 concatenates a multi-page body into ONE array (measured across a real
    // two-page walk), but older gh emitted one array PER page, which no single `Vec`
    // can parse. `--slurp` (gh 2.44+) wraps the pages in an outer array on every
    // version, so the flatten below reads the same either way.
    let out = match run_gh(
        Some(repo_path),
        &["api", "user/teams", "--paginate", "--slurp"],
        GH_NETWORK_TIMEOUT,
    )
    .await
    {
        Ok(out) => out,
        // Only the scope gap degrades; every other failure is a real error the
        // caller must see.
        Err(AppError::Gh(msg)) if is_missing_org_scope(&msg) => {
            return Ok(MyTeams {
                teams: Vec::new(),
                missing_scope: true,
            })
        }
        Err(e) => return Err(e),
    };
    let pages: Vec<Vec<RawTeam>> = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| gh_unreadable("your teams", format!("could not parse user/teams: {e}")))?;
    Ok(MyTeams {
        teams: teams_in_org(flatten_slurped_pages(pages), &owner),
        missing_scope: false,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        flatten_slurped_pages, is_missing_org_scope, teams_in_org, MyTeams, RawTeam, TeamRef,
    };

    /// The `--paginate --slurp` shape: an outer array of PAGES. Captured from
    /// `gh api "user/teams?per_page=2" --paginate --slurp`, whose real two-page walk
    /// returned these four teams split 2/2 (fields beyond these three are ignored).
    const FIXTURE: &str = r#"[
      [
        {"name":"Developers","slug":"developers","organization":{"login":"EpicGames"}},
        {"name":"admin","slug":"admin","organization":{"login":"blizzhackers"}}
      ],
      [
        {"name":"bh","slug":"bh","organization":{"login":"blizzhackers"}},
        {"name":"YARB","slug":"yarb","organization":{"login":"blizzhackers"}}
      ]
    ]"#;

    fn parse() -> Vec<RawTeam> {
        let pages: Vec<Vec<RawTeam>> = serde_json::from_str(FIXTURE).expect("fixture parses");
        assert_eq!(
            pages.len(),
            2,
            "the fixture must exercise a MULTI-page walk"
        );
        flatten_slurped_pages(pages)
    }

    /// The page boundary must be invisible downstream: a team on page 2 has to reach
    /// the picker exactly like one on page 1. Reading the slurped outer array as the
    /// payload would instead yield two "teams" with no slug and drop all four.
    #[test]
    fn slurped_pages_flatten_into_one_team_list() {
        let flat = parse();
        assert_eq!(flat.len(), 4);
        let slugs: Vec<&str> = flat
            .iter()
            .map(|t| t.slug.as_deref().unwrap_or_default())
            .collect();
        assert_eq!(slugs, ["developers", "admin", "bh", "yarb"]);
        // A single-page walk still slurps into an outer array of one.
        let one: Vec<Vec<RawTeam>> =
            serde_json::from_str(r#"[[{"slug":"solo","organization":{"login":"octo"}}]]"#)
                .expect("parses");
        assert_eq!(flatten_slurped_pages(one).len(), 1);
        // An account in no teams slurps to an outer array holding one empty page.
        let empty: Vec<Vec<RawTeam>> = serde_json::from_str("[[]]").expect("parses");
        assert!(flatten_slurped_pages(empty).is_empty());
    }

    #[test]
    fn teams_are_org_qualified_for_the_search_qualifier() {
        let teams = teams_in_org(parse(), "blizzhackers");
        let slugs: Vec<&str> = teams.iter().map(|t| t.slug.as_str()).collect();
        // `bh` and `yarb` live on page 2 of the fixture, so this also pins that the
        // qualified form survives the page boundary. The bare slug `user/teams`
        // returns would match nothing; the qualified form is what the filter sends.
        assert_eq!(
            slugs,
            ["blizzhackers/admin", "blizzhackers/bh", "blizzhackers/yarb"]
        );
        let names: Vec<&str> = teams.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["admin", "bh", "YARB"]);
    }

    #[test]
    fn the_org_match_is_case_insensitive_but_keeps_githubs_spelling() {
        let teams = teams_in_org(parse(), "epicgames");
        assert_eq!(teams.len(), 1);
        // Compared case-insensitively, emitted with the organization's own casing.
        assert_eq!(teams[0].slug, "EpicGames/developers");
    }

    #[test]
    fn a_user_owned_repo_has_no_teams() {
        assert!(teams_in_org(parse(), "theBGuy").is_empty());
    }

    #[test]
    fn rows_missing_a_slug_or_org_are_dropped() {
        let raw: Vec<RawTeam> = serde_json::from_str(
            r#"[{"name":"No slug","organization":{"login":"octo"}},
                {"slug":"no-org","name":"No org"},
                {"slug":"","name":"Empty","organization":{"login":"octo"}},
                {"slug":"ok","organization":{"login":"octo"}}]"#,
        )
        .expect("parses");
        let teams = teams_in_org(raw, "octo");
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].slug, "octo/ok");
        // A nameless team falls back to its slug rather than rendering blank.
        assert_eq!(teams[0].name, "ok");
    }

    /// The scope NAME classifies, never the status code: a 403 has several causes,
    /// and only one of them is fixed by granting a scope.
    #[test]
    fn only_the_named_scope_is_classified_as_missing_scope() {
        assert!(is_missing_org_scope(
            "error: your authentication token is missing required scopes [read:org]"
        ));
        assert!(is_missing_org_scope(
            "HTTP 403: Resource not accessible (missing the read:org scope)"
        ));
        // Case-insensitive — gh's hint casing isn't a contract.
        assert!(is_missing_org_scope("requires the READ:ORG scope"));
        // SAML enforcement: the user's token is fine; they must authorize it for the
        // org. Naming a scope here would send them to the wrong settings page.
        assert!(!is_missing_org_scope(
            "HTTP 403: Resource protected by organization SAML enforcement. You must \
             grant your OAuth token access to this organization."
        ));
        // A secondary rate limit is transient — calling it a scope gap makes a retry
        // look pointless.
        assert!(!is_missing_org_scope(
            "HTTP 403: You have exceeded a secondary rate limit. Please wait a few \
             minutes before you try again."
        ));
        // The bare status line on its own classifies nothing.
        assert!(!is_missing_org_scope(
            "HTTP 403: Resource not accessible by integration"
        ));
        assert!(!is_missing_org_scope("HTTP 404: Not Found"));
        assert!(!is_missing_org_scope("dial tcp: lookup api.github.com"));
    }

    #[test]
    fn the_wire_shape_is_camel_case() {
        let page = MyTeams {
            teams: vec![TeamRef {
                slug: "octo/reviewers".to_string(),
                name: "Reviewers".to_string(),
            }],
            missing_scope: true,
        };
        assert_eq!(
            serde_json::to_value(&page).expect("MyTeams serializes"),
            serde_json::json!({
                "teams": [{"slug": "octo/reviewers", "name": "Reviewers"}],
                "missingScope": true,
            })
        );
    }
}
