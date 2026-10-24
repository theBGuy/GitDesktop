use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::github::runner::{
    gh_auth_epoch, gh_host_for_repo, gh_output_ok, run_gh_cached_get_raw_on_host, GhOutput,
};

const REPO_META_TTL: Duration = Duration::from_secs(60);
const REPO_META_CAP: usize = 64;
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

    fn wiring_body(source: &str, name: &str) -> String {
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

    #[test]
    fn wiring_bodies_ignore_commented_out_evictions() {
        let source =
            "fn write() {\n    // invalidate_stack_memo_after(&slug, &result);\n    result?;\n}";
        assert!(!wiring_body(source, "write").contains("invalidate_stack_memo_after("));
    }

    pub(crate) fn assert_stack_eviction_wiring() {
        let source = include_str!("pr.rs").replace("\r\n", "\n");
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
            let body = wiring_body(&source, name);
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
                    body.contains("let result = run_gh_api_write(&repo_path, &arg_refs).await;")
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
            &include_str!("lifecycle.rs").replace("\r\n", "\n"),
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
        assert_eviction_wiring(
            &include_str!("security.rs").replace("\r\n", "\n"),
            &["apply_feature"],
        );
    }

    #[test]
    fn repo_issue_evictions_follow_attempts() {
        assert_eviction_wiring(
            &include_str!("issue.rs").replace("\r\n", "\n"),
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
            &include_str!("pages.rs").replace("\r\n", "\n"),
            &["gh_pages_enable", "gh_pages_disable"],
        );
    }

    #[test]
    fn repo_collaborator_evictions_follow_attempts() {
        assert_eviction_wiring(
            &include_str!("collaborators.rs").replace("\r\n", "\n"),
            &["gh_collaborator_add", "gh_collaborator_remove"],
        );
    }

    #[test]
    fn repo_draft_conversion_eviction_follows_attempt() {
        assert_eviction_wiring(
            &include_str!("project_item_edits.rs").replace("\r\n", "\n"),
            &["gh_convert_draft_item"],
        );
    }

    #[test]
    fn repo_pr_and_star_and_fork_evictions_follow_attempts() {
        assert_eviction_wiring(
            &include_str!("pr.rs").replace("\r\n", "\n"),
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
    fn repo_settings_patch_evicts_before_topics_can_fail() {
        assert_eviction_wiring(
            &include_str!("repo_settings.rs").replace("\r\n", "\n"),
            &["gh_repo_settings_update"],
        );
    }

    #[test]
    fn repo_named_fork_and_star_evictions_follow_attempts() {
        assert_eviction_wiring(
            &include_str!("../forge/github.rs").replace("\r\n", "\n"),
            &["fork_repo", "star_repo"],
        );
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

    #[test]
    fn write_attempt_includes_timeout_and_server_errors() {
        for result in [
            Ok(()),
            Err(AppError::Timeout(1)),
            Err(AppError::Gh("failed".into())),
        ] {
            assert!(write_was_attempted(&result), "{result:?}");
        }
        assert!(!write_was_attempted::<()>(&Err(AppError::GhNotFound)));
    }
}
