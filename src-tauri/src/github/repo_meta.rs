use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::github::runner::{
    gh_auth_epoch, gh_host_for_repo, gh_output_ok, run_gh_cached_get_raw_on_host, GhOutput,
};

const REPO_META_TTL: Duration = Duration::from_secs(60);
const REPO_META_CAP: usize = 64;
// The host is the GH_HOST pin. None (no readable origin host, or no stored login
// for it) pins nothing, so every None key reads gh's default host and is safe to
// share across checkouts.
type RepoMetaKey = (Option<String>, String);

struct RepoMetaBody {
    body: String,
    epoch: u64,
    fetched: Instant,
}

#[derive(Default)]
struct RepoMetaCache {
    // Entries and generation share a lock so eviction always beats a late fill.
    entries: HashMap<RepoMetaKey, RepoMetaBody>,
    generation: u64,
}

static REPO_META: OnceLock<Mutex<RepoMetaCache>> = OnceLock::new();

fn cache() -> &'static Mutex<RepoMetaCache> {
    REPO_META.get_or_init(|| Mutex::new(RepoMetaCache::default()))
}

fn memo_key(host: Option<String>, slug: &str) -> RepoMetaKey {
    (host, slug.to_lowercase())
}

fn memo_get(
    entries: &HashMap<RepoMetaKey, RepoMetaBody>,
    key: &RepoMetaKey,
    epoch: u64,
    ttl: Duration,
    now: Instant,
) -> Option<String> {
    entries
        .get(key)
        .filter(|entry| entry.epoch == epoch && now.duration_since(entry.fetched) < ttl)
        .map(|entry| entry.body.clone())
}

fn memo_put(
    cache: &mut RepoMetaCache,
    key: RepoMetaKey,
    body: String,
    pre_epoch: u64,
    pre_generation: u64,
    current_epoch: u64,
    now: Instant,
) {
    if cache.generation != pre_generation || pre_epoch != current_epoch {
        return;
    }
    if !cache.entries.contains_key(&key) && cache.entries.len() >= REPO_META_CAP {
        if let Some(oldest) = cache
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.fetched)
            .map(|(key, _)| key.clone())
        {
            cache.entries.remove(&oldest);
        }
    }
    cache.entries.insert(
        key,
        RepoMetaBody {
            body,
            epoch: pre_epoch,
            fetched: now,
        },
    );
}

fn memo_put_output(
    cache: &mut RepoMetaCache,
    key: RepoMetaKey,
    out: &GhOutput,
    pre_epoch: u64,
    pre_generation: u64,
    current_epoch: u64,
    now: Instant,
) {
    if out.code == 0 {
        memo_put(
            cache,
            key,
            out.stdout_lossy(),
            pre_epoch,
            pre_generation,
            current_epoch,
            now,
        );
    }
}

fn memo_invalidate(cache: &mut RepoMetaCache, slug: Option<&str>) {
    cache.generation += 1;
    match slug {
        Some(slug) => {
            let folded = slug.to_lowercase();
            cache.entries.retain(|(_, key_slug), _| *key_slug != folded);
        }
        None => cache.entries.clear(),
    }
}

pub(crate) fn repo_meta_generation() -> u64 {
    cache().lock().unwrap_or_else(|p| p.into_inner()).generation
}

pub(crate) fn seed_repo_meta(
    host: Option<String>,
    slug: &str,
    body: String,
    pre_fetch_epoch: u64,
    pre_fetch_generation: u64,
) {
    memo_put(
        &mut cache().lock().unwrap_or_else(|p| p.into_inner()),
        memo_key(host, slug),
        body,
        pre_fetch_epoch,
        pre_fetch_generation,
        gh_auth_epoch(),
        Instant::now(),
    );
}

pub(crate) async fn repo_object(
    repo_path: &str,
    slug: &str,
    timeout: Duration,
) -> AppResult<GhOutput> {
    let epoch = gh_auth_epoch();
    let generation = repo_meta_generation();
    let host = gh_host_for_repo(repo_path).await;
    let key = memo_key(host.clone(), slug);
    if let Some(body) = memo_get(
        &cache().lock().unwrap_or_else(|p| p.into_inner()).entries,
        &key,
        gh_auth_epoch(),
        REPO_META_TTL,
        Instant::now(),
    ) {
        return Ok(GhOutput {
            stdout: body.into_bytes(),
            stderr: String::new(),
            code: 0,
        });
    }
    let out = run_gh_cached_get_raw_on_host(
        Some(repo_path),
        host.as_deref(),
        &["api", &format!("repos/{slug}")],
        timeout,
        epoch,
    )
    .await?;
    memo_put_output(
        &mut cache().lock().unwrap_or_else(|p| p.into_inner()),
        key,
        &out,
        epoch,
        generation,
        gh_auth_epoch(),
        Instant::now(),
    );
    Ok(out)
}

pub(crate) async fn repo_object_ok(
    repo_path: &str,
    slug: &str,
    timeout: Duration,
) -> AppResult<GhOutput> {
    gh_output_ok(repo_object(repo_path, slug, timeout).await?)
}

pub(crate) fn invalidate_repo_meta(slug: &str) {
    memo_invalidate(
        &mut cache().lock().unwrap_or_else(|p| p.into_inner()),
        Some(slug),
    );
}

pub(crate) fn invalidate_all_repo_meta() {
    memo_invalidate(&mut cache().lock().unwrap_or_else(|p| p.into_inner()), None);
}

/// `GhNotFound` precedes any request (missing gh or working directory).
/// Every other error, including a timeout, may follow a server write, so it evicts.
/// A pre-spawn Io error may over-evict, which is harmless.
pub(crate) fn write_was_attempted<T>(result: &AppResult<T>) -> bool {
    !matches!(result, Err(AppError::GhNotFound))
}

pub(crate) fn invalidate_repo_meta_after<T>(slug: &str, result: &AppResult<T>) {
    if write_was_attempted(result) {
        invalidate_repo_meta(slug);
    }
}

pub(crate) fn invalidate_all_repo_meta_after<T>(result: &AppResult<T>) {
    if write_was_attempted(result) {
        invalidate_all_repo_meta();
    }
}

pub(crate) fn transfer_destination(value: &str) -> Option<String> {
    let path = if value.contains("://") {
        tauri::Url::parse(value)
            .ok()?
            .path()
            .trim_matches('/')
            .to_string()
    } else {
        value.trim_matches('/').to_string()
    };
    let parts: Vec<&str> = path.split('/').collect();
    let parts = if parts.len() >= 3 && parts[0].contains('.') {
        &parts[1..]
    } else {
        &parts[..]
    };
    let owner = parts.first()?;
    let repo = parts.get(1)?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    let slug = format!("{owner}/{repo}");
    crate::github::valid_github_slug(&slug).then_some(slug)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn wiring_body(source: &str, name: &str) -> String {
        let source = source.replace("\r\n", "\n");
        let start = source.find(&format!("fn {name}(")).unwrap();
        source[start..]
            .split("\n}")
            .next()
            .unwrap()
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Every `.rs` file under `dir`, as (path with `/` separators, text).
    pub(crate) fn rust_sources(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_sources(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                out.push((path.to_string_lossy().replace('\\', "/"), text));
            }
        }
    }

    #[test]
    fn wiring_bodies_ignore_commented_out_evictions() {
        let source =
            "fn write() {\n    // invalidate_stack_memo_after(&slug, &result);\n    result?;\n}";
        assert!(!wiring_body(source, "write").contains("invalidate_stack_memo_after("));
    }

    pub(crate) fn assert_stack_eviction_wiring() {
        let source = include_str!("pr.rs");
        for name in [
            "gh_stack_create",
            "gh_stack_add",
            "gh_stack_dissolve",
            "gh_pr_merge",
            "gh_pr_merge_async",
            "gh_pr_close",
            "gh_pr_reopen",
            "gh_pr_edit",
        ] {
            let body = wiring_body(source, name);
            let marker = "invalidate_stack_memo_after(&slug, &result);";
            let alternate = "invalidate_stack_memo_after(slug, &result);";
            let at = body
                .find(marker)
                .or_else(|| body.find(alternate))
                .unwrap_or_else(|| panic!("{name}: missing stack eviction after the attempt"));
            let before = body[..at].trim_end();
            assert!(
                before.ends_with(".await;")
                    || before.ends_with("invalidate_repo_meta_after(&slug, &result);")
                    || before.ends_with("invalidate_repo_meta_after(slug, &result);"),
                "{name}: post-attempt ordering"
            );
            assert!(
                body[at..].contains("result?"),
                "{name}: evict before propagation"
            );
            if name == "gh_pr_edit" {
                assert!(
                    body.contains("let result = run_gh_api_write_json(&repo_path, \"PATCH\", &endpoint, &payload).await;")
                );
                assert!(!body.contains("if base"));
            }
            if name == "gh_pr_merge" {
                assert!(
                    body.ends_with("invalidate_stack_memo_after(&slug, &outcome);\n    outcome")
                );
            }
        }
    }

    fn assert_eviction_wiring(source: &str, functions: &[&str]) {
        for name in functions {
            let body = wiring_body(source, name);
            let eviction = body
                .find("invalidate_repo_meta_after(")
                .or_else(|| body.find("invalidate_all_repo_meta_after("))
                .unwrap_or_else(|| panic!("{name}: missing post-attempt eviction"));
            assert!(
                body[..eviction].trim_end().ends_with(".await;"),
                "{name}: evict immediately after the attempt"
            );
            assert!(
                body[eviction..].contains("result?")
                    || body[eviction..].contains("result.map_err("),
                "{name}: propagate only after eviction"
            );
            if *name == "gh_repo_delete" {
                assert!(
                    body.contains("invalidate_all_repo_meta_after(&result);"),
                    "gh_repo_delete: fork deletion must also evict parent metadata"
                );
            }
            if matches!(*name, "gh_pr_create_core" | "gh_repo_settings_update") {
                assert_eq!(
                    body.matches("invalidate_repo_meta_after(").count(),
                    2,
                    "{name}"
                );
            }
            if *name == "gh_repo_settings_update" {
                assert!(eviction < body.find("let topics_out").unwrap());
            }
            if *name == "gh_pr_merge" {
                assert!(
                    body.ends_with(
                        ".await;\n    invalidate_repo_meta_after(&slug, &outcome);\n    invalidate_stack_memo_after(&slug, &outcome);\n    outcome"
                    ),
                    "gh_pr_merge: evict at exit after both merge arms and branch cleanup"
                );
                let capture = body.find("let outcome = async {").unwrap();
                for step in [
                    "gh_pr_merge_async(",
                    "return Err(AppError::Gh(",
                    "gh_delete_remote_head_branch(",
                ] {
                    assert!(capture < body.find(step).unwrap(), "{step}: captured exit");
                }
            }
        }
    }

    #[test]
    fn repo_lifecycle_evictions_follow_attempts() {
        assert_eviction_wiring(
            include_str!("lifecycle.rs"),
            &[
                "gh_repo_set_archived",
                "gh_repo_rename",
                "gh_repo_set_visibility",
                "gh_repo_transfer",
                "gh_repo_delete",
            ],
        );
    }

    #[test]
    fn repo_security_eviction_follows_patch() {
        assert_eviction_wiring(include_str!("security.rs"), &["apply_feature"]);
    }

    #[test]
    fn repo_issue_evictions_follow_attempts() {
        assert_eviction_wiring(
            include_str!("issue.rs"),
            &[
                "gh_issue_create",
                "gh_issue_close",
                "gh_issue_reopen",
                "gh_issue_transfer",
                "gh_issue_delete",
            ],
        );
    }

    #[test]
    fn repo_pages_evictions_follow_attempts() {
        assert_eviction_wiring(
            include_str!("pages.rs"),
            &["gh_pages_enable", "gh_pages_disable"],
        );
    }

    #[test]
    fn repo_collaborator_evictions_follow_attempts() {
        assert_eviction_wiring(
            include_str!("collaborators.rs"),
            &["gh_collaborator_add", "gh_collaborator_remove"],
        );
    }

    #[test]
    fn repo_draft_conversion_eviction_follows_attempt() {
        assert_eviction_wiring(
            include_str!("project_item_edits.rs"),
            &["gh_convert_draft_item"],
        );
    }

    #[test]
    fn repo_pr_and_star_and_fork_evictions_follow_attempts() {
        assert_eviction_wiring(
            include_str!("pr.rs"),
            &[
                "gh_repo_set_star",
                "gh_pr_merge",
                "gh_pr_merge_async",
                "gh_pr_close",
                "gh_pr_reopen",
                "gh_repo_fork",
                "gh_pr_create_core",
            ],
        );
    }

    #[test]
    fn repo_settings_read_stamps_before_fetch_and_seeds_after() {
        let body = wiring_body(include_str!("repo_settings.rs"), "gh_repo_settings_get");
        let fetch = body.find("run_gh_on_host(").unwrap();
        let seed = body.find("seed_repo_meta(").unwrap();
        for stamp in ["gh_auth_epoch()", "repo_meta_generation()"] {
            assert!(
                body.find(stamp).unwrap() < fetch,
                "{stamp}: stamp before fetch"
            );
        }
        assert!(fetch < seed, "seed after fetch");
    }

    #[test]
    fn repo_settings_patch_evicts_before_topics_can_fail() {
        assert_eviction_wiring(
            include_str!("repo_settings.rs"),
            &["gh_repo_settings_update"],
        );
    }

    #[test]
    fn repo_named_fork_and_star_evictions_follow_attempts() {
        assert_eviction_wiring(
            include_str!("../forge/github.rs"),
            &["fork_repo", "star_repo"],
        );
    }

    /// Where the last eviction on the attempt's own `result` starts, among the lines
    /// before the first `result?`; evictions on any other binding are not counted.
    fn last_result_eviction(body: &str) -> Option<usize> {
        let propagate = body.find("result?")?;
        let mut at = 0;
        let mut last = None;
        for line in body[..propagate].split_inclusive('\n') {
            let trimmed = line.trim();
            if trimmed.starts_with("invalidate_") && trimmed.ends_with("&result);") {
                last = Some(at + line.find("invalidate_").unwrap());
            }
            at += line.len();
        }
        last
    }

    /// The first map in `body`: after `anchor`, with the row's noun in its own statement.
    /// A rebinding map is the `let result = result.map_err(` statement at the run's own
    /// indentation, after the last counted eviction and directly before the statement
    /// holding `result?`. Returns where the text the next map is read from starts.
    fn hedge_at(body: &str, anchor: &str, token: &str, rebinds: bool) -> Option<usize> {
        let map = body.find("timed_out_write(")?;
        let statement_end = map + body[map..].find(';')? + 1;
        if body.find(anchor).is_none_or(|a| a >= map)
            || !body[map..statement_end].contains(&format!("LandedWrite::{token}"))
        {
            return None;
        }
        if !rebinds {
            return Some(statement_end);
        }
        let indent = |at: usize| {
            let start = body[..at].rfind('\n').map_or(0, |n| n + 1);
            &body[start..at]
        };
        let eviction = last_result_eviction(body)?;
        let run = body.find("let result = ")?;
        let rebind = body.find("let result = result.map_err(")?;
        let propagate = body.find("result?")?;
        let between = body[rebind..propagate]
            .split_once(';')
            .map_or("", |(_, rest)| rest.trim());
        let placed = eviction < rebind
            && rebind < map
            && !body[rebind..map].contains(';')
            && map < propagate
            && indent(rebind) == indent(run)
            && (between.is_empty()
                || (between.starts_with("let ")
                    && between.ends_with(" =")
                    && !between.contains('\n')));
        let propagated = propagate + body[propagate..].find(';')? + 1;
        placed.then_some(propagated)
    }

    /// Exactly one map per entry of `maps` (anchor, rebinds), each read by `hedge_at`
    /// from where the previous one's statement ended, so a later map is held to its own
    /// anchor, noun and placement.
    fn hedges(body: &str, maps: &[(&str, bool)], token: &str) -> bool {
        if body.matches("timed_out_write(").count() != maps.len() {
            return false;
        }
        let mut from = 0;
        for &(anchor, rebinds) in maps {
            match hedge_at(&body[from..], anchor, token, rebinds) {
                Some(next) => from += next,
                None => return false,
            }
        }
        true
    }

    /// Every GitHub write on this roster holds the may-have-landed map exactly as many
    /// times as its row says, each map after its own write's text (a read before the write
    /// keeps the bare timeout; one after it is not told apart) and naming the row's noun. A
    /// rebinding map follows the attempt's evictions and directly precedes `result?`. It
    /// sees only its rows: a GitHub write with no row here is invisible to it.
    #[test]
    fn every_listed_github_write_hedges_its_timeout() {
        let pr = include_str!("pr.rs");
        let release = include_str!("release.rs");
        let issue = include_str!("issue.rs");
        let actions = include_str!("actions.rs");
        let collaborators = include_str!("collaborators.rs");
        let lifecycle = include_str!("lifecycle.rs");
        let pages = include_str!("pages.rs");
        let repo_settings = include_str!("repo_settings.rs");
        let rulesets = include_str!("rulesets.rs");
        let secrets = include_str!("secrets.rs");
        let security = include_str!("security.rs");
        let forge_github = include_str!("../forge/github.rs");
        // (source, function, text of the write's own run, LandedWrite, maps, evicts)
        let rows: &[(&str, &str, &str, &str, usize, bool)] = &[
            (
                pr,
                "gh_pr_review",
                "run_gh_text_write(",
                "Changed",
                1,
                false,
            ),
            (pr, "gh_pr_merge", "\"pr\", \"merge\"", "Changed", 1, true),
            (
                pr,
                "gh_pr_merge_async",
                "\"--method\", \"PUT\"",
                "Changed",
                1,
                true,
            ),
            (
                pr,
                "edit_comment",
                "EDIT_COMMENT_MUTATION",
                "Saved(\"comment\")",
                1,
                false,
            ),
            (
                pr,
                "edit_review_comment",
                "EDIT_REVIEW_COMMENT_MUTATION",
                "Saved(\"comment\")",
                1,
                false,
            ),
            (
                pr,
                "gh_pr_edit_labels",
                "\"api\", \"graphql\"",
                "Changed",
                1,
                false,
            ),
            (
                pr,
                "commit_comment_create",
                "\"-X\", \"POST\"",
                "Posted",
                1,
                false,
            ),
            (
                pr,
                "commit_comment_edit",
                "\"-X\", \"PATCH\"",
                "Saved(\"comment\")",
                1,
                false,
            ),
            (
                pr,
                "commit_comment_delete",
                "\"-X\", \"DELETE\"",
                "Changed",
                1,
                false,
            ),
            (pr, "thread_create", "\"-X\", \"POST\"", "Posted", 1, false),
            (pr, "review_submit", "\"-X\", \"POST\"", "Changed", 1, false),
            (
                pr,
                "gh_pr_reply_review_thread",
                "REPLY_THREAD_MUTATION",
                "Posted",
                1,
                false,
            ),
            (
                issue,
                "gh_issue_set_assignees",
                "\"--method\", \"PATCH\"",
                "Changed",
                1,
                false,
            ),
            (
                release,
                "gh_release_create",
                "run_gh_text_write(",
                "Created(\"release\")",
                1,
                false,
            ),
            (
                release,
                "gh_release_edit",
                "release_edit_args(",
                "Saved(\"release\")",
                1,
                false,
            ),
            (
                release,
                "gh_release_delete",
                "release_delete_args(",
                "Changed",
                1,
                false,
            ),
            (
                release,
                "gh_release_upload_asset",
                "\"upload\",",
                "Changed",
                1,
                false,
            ),
            (
                release,
                "gh_release_delete_asset",
                "\"delete-asset\",",
                "Changed",
                1,
                false,
            ),
            (
                release,
                "gh_release_sync_updater_notes",
                "\"upload\",",
                "Changed",
                1,
                false,
            ),
            (
                pr,
                "gh_repo_set_star",
                "\"--method\", method",
                "Changed",
                1,
                true,
            ),
            (pr, "gh_pr_close", "\"pr\", \"close\"", "Changed", 1, true),
            (
                pr,
                "gh_pr_update_branch",
                "\"update-branch\"",
                "Changed",
                1,
                false,
            ),
            (pr, "gh_pr_reopen", "\"pr\", \"reopen\"", "Changed", 1, true),
            (
                pr,
                "delete_comment",
                "deleteIssueComment(",
                "Changed",
                1,
                false,
            ),
            (
                pr,
                "delete_review_comment",
                "deletePullRequestReviewComment(",
                "Changed",
                1,
                false,
            ),
            (
                pr,
                "gh_pr_minimize_comment",
                "{minimizeComment(",
                "Changed",
                1,
                false,
            ),
            (
                pr,
                "gh_pr_unminimize_comment",
                "unminimizeComment(",
                "Changed",
                1,
                false,
            ),
            (
                pr,
                "gh_pr_discard_pending_review",
                "deletePullRequestReview(",
                "Changed",
                1,
                false,
            ),
            (
                pr,
                "gh_repo_fork",
                "\"repo\", \"fork\"",
                "Created(\"fork\")",
                1,
                true,
            ),
            (
                pr,
                "gh_pr_set_ready",
                "\"pr\", \"ready\"",
                "Changed",
                1,
                false,
            ),
            (
                pr,
                "set_pr_reviewers",
                "\"pr\", \"edit\"",
                "Changed",
                1,
                false,
            ),
            (
                pr,
                "gh_pr_resolve_review_thread",
                "unresolveReviewThread(",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_issue_set_milestone",
                "\"--method\", \"PATCH\"",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_issue_set_type",
                "issue_set_type_args(",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_issue_pin",
                "\"issue\", \"pin\"",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_issue_unpin",
                "\"issue\", \"unpin\"",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_issue_lock",
                "\"issue\", \"lock\"",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_issue_unlock",
                "\"issue\", \"unlock\"",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_add_reaction",
                "addReaction(",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_remove_reaction",
                "removeReaction(",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_issue_remove_sub_issue",
                "removeSubIssue(",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_issue_set_dependency",
                "\"issue\", \"edit\"",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_issue_close",
                "\"issue\", \"close\"",
                "Changed",
                1,
                true,
            ),
            (
                issue,
                "gh_issue_reopen",
                "\"issue\", \"reopen\"",
                "Changed",
                1,
                true,
            ),
            (
                issue,
                "gh_issue_transfer",
                "\"issue\", \"transfer\"",
                "Changed",
                1,
                true,
            ),
            (
                issue,
                "gh_issue_delete",
                "\"issue\", \"delete\"",
                "Changed",
                1,
                true,
            ),
            (
                issue,
                "gh_issue_add_sub_issue",
                "addSubIssue(",
                "Changed",
                1,
                false,
            ),
            (
                issue,
                "gh_issue_create_linked_branch",
                "createLinkedBranch(",
                "Changed",
                1,
                false,
            ),
            (
                actions,
                "gh_run_rerun",
                "run_rerun_args(",
                "Changed",
                1,
                false,
            ),
            (
                actions,
                "gh_run_rerun_job",
                "run_rerun_job_args(",
                "Changed",
                1,
                false,
            ),
            (actions, "gh_run_approve", "/approve", "Changed", 1, false),
            (
                actions,
                "gh_run_cancel",
                "\"run\", \"cancel\"",
                "Changed",
                1,
                false,
            ),
            (
                actions,
                "gh_workflow_run",
                "run.map_err(",
                "Created(\"workflow run\")",
                1,
                false,
            ),
            (
                collaborators,
                "gh_collaborator_add",
                "/collaborators/{username}",
                "Changed",
                1,
                true,
            ),
            (
                collaborators,
                "gh_collaborator_remove",
                "/collaborators/{username}",
                "Changed",
                1,
                true,
            ),
            (
                collaborators,
                "gh_invitation_update",
                "/invitations/{id}",
                "Changed",
                1,
                false,
            ),
            (
                collaborators,
                "gh_invitation_cancel",
                "/invitations/{id}",
                "Changed",
                1,
                false,
            ),
            (
                lifecycle,
                "gh_repo_set_archived",
                "\"PATCH\",",
                "Changed",
                1,
                true,
            ),
            (
                lifecycle,
                "gh_repo_rename",
                "\"PATCH\",",
                "Changed",
                1,
                true,
            ),
            (
                lifecycle,
                "gh_repo_set_visibility",
                "\"PATCH\",",
                "Changed",
                1,
                true,
            ),
            (
                lifecycle,
                "gh_repo_transfer",
                "/transfer\"",
                "Changed",
                1,
                true,
            ),
            (
                lifecycle,
                "gh_repo_delete",
                "\"--method\", \"DELETE\"",
                "Changed",
                1,
                true,
            ),
            (pages, "gh_pages_enable", "/pages\"", "Changed", 1, true),
            (pages, "gh_pages_update", "/pages\"", "Changed", 1, false),
            (pages, "gh_pages_disable", "/pages\"", "Changed", 1, true),
            (
                repo_settings,
                "gh_hook_delete",
                "/hooks/{id}\"",
                "Changed",
                1,
                false,
            ),
            (
                repo_settings,
                "gh_hook_ping",
                "/pings\"",
                "Changed",
                1,
                false,
            ),
            (
                repo_settings,
                "gh_hook_test",
                "/tests\"",
                "Changed",
                1,
                false,
            ),
            (
                repo_settings,
                "gh_hook_redeliver",
                "/attempts\"",
                "Changed",
                1,
                false,
            ),
            (
                repo_settings,
                "gh_repo_settings_update",
                "\"PATCH\",",
                "Saved(\"repository settings\")",
                2,
                true,
            ),
            (
                rulesets,
                "gh_ruleset_create",
                "/rulesets\"",
                "Changed",
                1,
                false,
            ),
            (
                rulesets,
                "gh_ruleset_update",
                "/rulesets/{id}\"",
                "Changed",
                1,
                false,
            ),
            (
                rulesets,
                "gh_ruleset_delete",
                "/rulesets/{id}\"",
                "Changed",
                1,
                false,
            ),
            (
                secrets,
                "gh_secret_set",
                "run_gh_input(",
                "Changed",
                1,
                false,
            ),
            (secrets, "gh_secret_delete", "run_gh(", "Changed", 1, false),
            (
                secrets,
                "gh_variable_set",
                "run_gh_input(",
                "Changed",
                1,
                false,
            ),
            (
                secrets,
                "gh_variable_delete",
                "run_gh(",
                "Changed",
                1,
                false,
            ),
            (
                security,
                "toggle_endpoint",
                "\"--method\", method",
                "Changed",
                1,
                false,
            ),
            (security, "apply_feature", "\"PATCH\",", "Changed", 2, true),
            (
                forge_github,
                "fork_repo",
                "fork_args(",
                "Created(\"fork\")",
                1,
                true,
            ),
            (
                forge_github,
                "star_repo",
                "\"--method\", method",
                "Changed",
                1,
                true,
            ),
        ];
        for &(source, name, anchor, token, count, evicts) in rows {
            // A two-map row's later write: (text of its own run, whether its map rebinds).
            let later: &[(&str, bool)] = match name {
                "gh_repo_settings_update" => &[("/topics\"", true)],
                "apply_feature" => &[("code-scanning/default-setup", false)],
                _ => &[],
            };
            assert_eq!(later.len() + 1, count, "{name}: one anchor per map");
            let maps: Vec<(&str, bool)> = std::iter::once((anchor, evicts))
                .chain(later.iter().copied())
                .collect();
            let holds = |body: &str| hedges(body, &maps, token);
            let body = wiring_body(source, name);
            assert!(holds(&body), "{name}: {body}");
            let fake = format!("timed_out_write(LandedWrite::{token}); ");
            let deleted = body.replacen("timed_out_write(", "mapped(", 1);
            assert!(!holds(&deleted), "{name}: a deleted map must flip");
            let ahead = deleted.replacen(anchor, &format!("{fake}{anchor}"), 1);
            assert!(!holds(&ahead), "{name}: a map ahead of the write must flip");
            if count > 1 {
                let last = body.rfind("timed_out_write(").unwrap();
                let second = format!("{}mapped({}", &body[..last], &body[last + 16..]);
                assert!(!holds(&second), "{name}: a deleted later map must flip");
                let noun = format!("LandedWrite::{token}");
                let at = body.rfind(&noun).unwrap();
                let other = if token == "Changed" {
                    "Posted"
                } else {
                    "Changed"
                };
                let renamed = format!(
                    "{}LandedWrite::{other}{}",
                    &body[..at],
                    &body[at + noun.len()..]
                );
                assert!(
                    !holds(&renamed),
                    "{name}: a later map's other noun must flip"
                );
            }
            if evicts {
                let eviction = last_result_eviction(&body).unwrap();
                let early = format!("{}{fake}{}", &deleted[..eviction], &deleted[eviction..]);
                assert!(
                    !holds(&early),
                    "{name}: a map ahead of the eviction must flip"
                );
            }
            for (rebind, _) in body.match_indices("let result = result.map_err(") {
                // Each rebind lifted above the line before it (an eviction, the `}` of
                // the `if` holding one, or `gh_repo_fork`'s remote-URL drops), or parted
                // from its `result?` by another statement, must flip.
                let start = body[..rebind].rfind('\n').unwrap() + 1;
                let end = rebind + body[rebind..].find(";\n").unwrap() + 2;
                let previous = body[..start - 1].rfind('\n').unwrap() + 1;
                let lifted = format!(
                    "{}{}{}{}",
                    &body[..previous],
                    &body[start..end],
                    &body[previous..start],
                    &body[end..]
                );
                assert!(!holds(&lifted), "{name}: a rebind lifted a line must flip");
                let parted = format!("{}    drop(());\n{}", &body[..end], &body[end..]);
                assert!(!holds(&parted), "{name}: a parted rebind must flip");
            }
            if name == "apply_feature" {
                // The code-scanning map moved onto a toggle arm's run must flip.
                let last = body.rfind("timed_out_write(").unwrap();
                let start = body[..last].rfind(".map_err(").unwrap();
                let end = start + body[start..].find(")?;").unwrap() + 1;
                let cut = format!("{}{}", &body[..start], &body[end..]);
                let moved = cut.replacen(".await?;", &format!(".await{}?;", &body[start..end]), 1);
                assert_ne!(moved, cut);
                assert!(!holds(&moved), "{name}: a map on another arm must flip");
            }
            if name == "gh_workflow_run" {
                // The map on the inputs arm's run alone (the no-inputs arm bare) must flip.
                let arm = deleted.replacen(
                    "&json, GH_NETWORK_TIMEOUT).await",
                    &format!("&json, GH_NETWORK_TIMEOUT).await.map_err(|e| {fake})"),
                    1,
                );
                assert_ne!(arm, deleted);
                assert!(!holds(&arm), "{name}: a map on one arm must flip");
            }
        }
    }

    #[test]
    fn repo_memo_keys_fold_slug_and_gate_host_epoch_and_ttl() {
        let mut cache = RepoMetaCache::default();
        let now = Instant::now();
        let key = memo_key(Some("github.com".into()), "Owner/Repo");
        memo_put(
            &mut cache,
            key.clone(),
            "body".into(),
            1_000_000,
            0,
            1_000_000,
            now,
        );
        assert_eq!(
            memo_get(
                &cache.entries,
                &memo_key(key.0.clone(), "OWNER/REPO"),
                1_000_000,
                REPO_META_TTL,
                now
            ),
            Some("body".into())
        );
        for other in [
            memo_key(None, "owner/repo"),
            memo_key(Some("enterprise".into()), "owner/repo"),
            memo_key(key.0.clone(), "owner/other"),
        ] {
            assert!(memo_get(&cache.entries, &other, 1_000_000, REPO_META_TTL, now).is_none());
        }
        assert!(memo_get(&cache.entries, &key, 1_000_000 + 1, REPO_META_TTL, now).is_none());
        assert!(memo_get(
            &cache.entries,
            &key,
            1_000_000,
            REPO_META_TTL,
            now + REPO_META_TTL
        )
        .is_none());
    }

    #[test]
    fn repo_memo_never_stores_nonzero_output() {
        let mut cache = RepoMetaCache::default();
        let key = memo_key(None, "o/r");
        let now = Instant::now();
        let out = GhOutput {
            stdout: b"{\"message\":\"Not Found\"}".to_vec(),
            stderr: "gh: Not Found (HTTP 404)".into(),
            code: 1,
        };
        memo_put_output(&mut cache, key.clone(), &out, 1_000_000, 0, 1_000_000, now);
        assert!(memo_get(&cache.entries, &key, 1_000_000, REPO_META_TTL, now).is_none());
    }

    #[test]
    fn repo_memo_eviction_beats_late_fill_and_fresh_seed() {
        let mut cache = RepoMetaCache::default();
        let key = memo_key(None, "o/r");
        let now = Instant::now();
        let before = cache.generation;
        memo_invalidate(&mut cache, Some("O/R"));
        memo_put(
            &mut cache,
            key.clone(),
            "late".into(),
            1_000_000,
            before,
            1_000_000,
            now,
        );
        assert!(memo_get(&cache.entries, &key, 1_000_000, REPO_META_TTL, now).is_none());
        let generation = cache.generation;
        memo_put(
            &mut cache,
            key.clone(),
            "switched".into(),
            1_000_000,
            generation,
            1_000_000 + 1,
            now,
        );
        assert!(cache.entries.is_empty());
        let body = r#"{"topics":["rust"],"forks_count":2,"stargazers_count":3}"#;
        memo_put(
            &mut cache,
            key.clone(),
            body.into(),
            1_000_000,
            generation,
            1_000_000,
            now,
        );
        assert_eq!(
            memo_get(&cache.entries, &key, 1_000_000, REPO_META_TTL, now).as_deref(),
            Some(body)
        );
        memo_invalidate(&mut cache, None);
        assert!(cache.entries.is_empty());
        assert!(cache.generation > generation);
    }

    #[test]
    fn repo_memo_write_outcomes_evict_except_pre_spawn_refusal() {
        for result in [
            Ok(()),
            Err(AppError::Timeout(30)),
            Err(AppError::Gh("refused".into())),
            Err(AppError::Io(std::io::Error::other("post-send"))),
        ] {
            let mut cache = RepoMetaCache::default();
            let now = Instant::now();
            let key = memo_key(None, "o/r");
            memo_put(
                &mut cache,
                key.clone(),
                "before".into(),
                1_000_000,
                0,
                1_000_000,
                now,
            );
            if write_was_attempted(&result) {
                memo_invalidate(&mut cache, Some("O/R"));
            }
            assert!(cache.entries.is_empty());
            assert_eq!(cache.generation, 1);
        }
        assert!(!write_was_attempted::<()>(&Err(AppError::GhNotFound)));
    }

    #[test]
    fn repo_memo_transfer_destination_accepts_slug_and_issue_url() {
        assert_eq!(
            transfer_destination("new/target"),
            Some("new/target".into())
        );
        assert_eq!(
            transfer_destination("https://github.com/new/target/issues/42"),
            Some("new/target".into())
        );
        for value in ["github.com/new/target", "https://github.com/new/target.git"] {
            assert_eq!(
                transfer_destination(value).as_deref(),
                Some("new/target"),
                "{value}"
            );
        }
        assert_eq!(transfer_destination("invalid"), None);
    }

    #[test]
    fn repo_memo_cap_evicts_only_oldest_and_refresh_keeps_neighbors() {
        let mut cache = RepoMetaCache::default();
        let start = Instant::now();
        let now = start + Duration::from_millis(65);
        for n in 0..65 {
            let key = memo_key(None, &format!("owner/repo{n}"));
            memo_put(
                &mut cache,
                key,
                "body".into(),
                1_000_000,
                0,
                1_000_000,
                start + Duration::from_millis(n),
            );
        }
        assert!(memo_get(
            &cache.entries,
            &memo_key(None, "owner/repo0"),
            1_000_000,
            REPO_META_TTL,
            now
        )
        .is_none());
        for n in 1..65 {
            assert_eq!(
                memo_get(
                    &cache.entries,
                    &memo_key(None, &format!("owner/repo{n}")),
                    1_000_000,
                    REPO_META_TTL,
                    now
                )
                .as_deref(),
                Some("body"),
                "rest served: {n}"
            );
        }
        let key = memo_key(None, "owner/repo1");
        memo_put(
            &mut cache,
            key.clone(),
            "refreshed".into(),
            1_000_000,
            0,
            1_000_000,
            now,
        );
        assert_eq!(cache.entries.len(), 64);
        assert_eq!(
            memo_get(&cache.entries, &key, 1_000_000, REPO_META_TTL, now).as_deref(),
            Some("refreshed")
        );
        assert!(cache.entries.contains_key(&memo_key(None, "owner/repo2")));
    }

    #[test]
    fn repo_memo_epoch_changes_replace_the_same_host_and_slug() {
        let mut cache = RepoMetaCache::default();
        let now = Instant::now();
        for epoch in [1_000_000, 1_000_001] {
            memo_put(
                &mut cache,
                memo_key(Some("github.com".into()), "Owner/Repo"),
                "body".into(),
                epoch,
                0,
                epoch,
                now,
            );
        }
        assert_eq!(cache.entries.len(), 1);
        assert!(memo_get(
            &cache.entries,
            &memo_key(Some("github.com".into()), "owner/repo"),
            1_000_001,
            REPO_META_TTL,
            now
        )
        .is_some());
    }
}
