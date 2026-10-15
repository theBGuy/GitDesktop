use tauri::State;

use crate::error::AppResult;
use crate::git::branches::validate_ref_name;
use crate::git::remote::{
    is_named_remote, parse_upstream_tracking, remote_head_branch, Upstream,
    UPSTREAM_TRACKING_FORMAT,
};
use crate::git::runner::{run_git, DEFAULT_TIMEOUT};
use crate::git::types::{BranchHead, ChangeKind, FileEntry, RepoStatus};
use crate::state::AppState;

/// Core of [`git_status`], callable outside a Tauri context (e.g. the Tier-3 MCP
/// server). The `#[tauri::command]` wrapper only adds the (unused) `State` for
/// IPC; both call this, so there's a single source of truth and no drift.
pub async fn status_core(repo_path: &str) -> AppResult<RepoStatus> {
    let out = run_git(
        Some(repo_path),
        // -uall lists files inside untracked directories individually
        // instead of collapsing them to "dir/"
        //
        // status.aheadBehind=true is pinned defensively: stock git ignores both
        // the config and --no-ahead-behind for porcelain v2 (verified live on
        // 2.51.1 — `branch.ab` always emits for a live upstream), but forks that
        // DO honor the config (large-repo setups often set it false) would
        // otherwise drop `branch.ab` and make every live upstream read as gone.
        // `-c` with an unknown key is ignored by any git, so this is
        // version-safe where an --ahead-behind flag (git ≥ 2.17) is not.
        &[
            "-c",
            "status.aheadBehind=true",
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let mut status = parse_status_v2(&out.stdout_lossy());
    fill_upstream_facts(repo_path, &mut status.branch).await;
    Ok(status)
}

#[tauri::command]
pub async fn git_status(_state: State<'_, AppState>, repo_path: String) -> AppResult<RepoStatus> {
    status_core(&repo_path).await
}

/// Fills the upstream's remote/branch split and the bare-push mismatch facts, which the
/// porcelain's short `branch.upstream` can't carry (remote names may contain `/`).
/// Advisory, failing toward inaction, as [`BranchHead`] documents: a failed tracking read
/// leaves the remote/branch split None; a failed push-config read keeps the split but
/// leaves `push_name_mismatch` false and `upstream_is_remote_default` None; a failed
/// remote-HEAD probe leaves `upstream_is_remote_default` None (unknown). One spawn when
/// there is an upstream; a live, differently-named branch upstream adds one config listing,
/// plus the remote-HEAD probe when that listing says a bare push is refused.
async fn fill_upstream_facts(repo_path: &str, head: &mut BranchHead) {
    let (Some(name), Some(_)) = (head.name.clone(), head.upstream.as_ref()) else {
        return;
    };
    // A for-each-ref pattern globs, so the name is checked first; git's own branch
    // names always pass.
    if validate_ref_name(&name).is_err() {
        return;
    }
    let refname = format!("refs/heads/{name}");
    let Ok(out) = run_git(
        Some(repo_path),
        &["for-each-ref", &refname, UPSTREAM_TRACKING_FORMAT],
        DEFAULT_TIMEOUT,
    )
    .await
    else {
        return;
    };
    let split = upstream_split(
        &name,
        parse_upstream_tracking(&out.stdout_lossy(), &refname),
    );
    head.upstream_remote.clone_from(&split.remote);
    head.upstream_branch.clone_from(&split.branch);
    let (true, Some(remote), Some(up)) = (split.candidate, split.remote, split.branch) else {
        return;
    };
    if bare_push_refused(repo_path, &name, &remote).await != Some(true) {
        return;
    }
    head.push_name_mismatch = true;
    head.upstream_is_remote_default = match remote_head_branch(repo_path, &remote).await {
        Ok(Some(default)) => Some(default == up),
        _ => None,
    };
}

/// What one tracking line says about the upstream, before any config read.
#[derive(Debug, PartialEq)]
struct UpstreamSplit {
    remote: Option<String>,
    branch: Option<String>,
    /// A live branch upstream on a real remote whose name differs from the local one:
    /// the only shape a bare push can be refused for by name. Implies both fields Some.
    candidate: bool,
}

/// Pure: an unborn branch (no line), an untracked branch, and a local (`.`) upstream
/// yield nothing; a non-branch upstream (`refs/pull/N/head`) yields its remote alone;
/// a gone branch upstream keeps both names but is never a candidate.
fn upstream_split(name: &str, tracking: Option<(Upstream, String, bool)>) -> UpstreamSplit {
    let none = UpstreamSplit {
        remote: None,
        branch: None,
        candidate: false,
    };
    let Some((upstream, remote, gone)) = tracking else {
        return none;
    };
    if !is_named_remote(&remote) {
        return none;
    }
    match upstream {
        Upstream::Branch(up) => UpstreamSplit {
            candidate: !gone && up != name,
            remote: Some(remote),
            branch: Some(up),
        },
        Upstream::NotABranch => UpstreamSplit {
            remote: Some(remote),
            ..none
        },
        Upstream::Untracked => none,
    }
}

/// One `git config -z --list` entry: its key in git's canonical form, and its value, `None`
/// for a valueless boolean entry.
type ConfigEntry = (String, Option<String>);

/// Parses `git config -z --list`: NUL-terminated entries, each split at its FIRST newline
/// into key and value (a value may itself hold newlines); no newline is a valueless entry.
fn parse_config_list(text: &str) -> Vec<ConfigEntry> {
    text.split('\0')
        .filter(|entry| !entry.is_empty())
        .map(|entry| match entry.split_once('\n') {
            Some((key, value)) => (canonical_config_key(key), Some(value.to_string())),
            None => (canonical_config_key(entry), None),
        })
        .collect()
}

/// git's canonical key form: section and variable name lowercased, the subsection between
/// them kept exact, since it is case-sensitive.
fn canonical_config_key(key: &str) -> String {
    match (key.find('.'), key.rfind('.')) {
        (Some(first), Some(last)) if first < last => format!(
            "{}{}{}",
            key[..first].to_ascii_lowercase(),
            &key[first..last],
            key[last..].to_ascii_lowercase()
        ),
        _ => key.to_ascii_lowercase(),
    }
}

/// Every value set for `key`, in config order; a valueless entry reads as empty. Exact keys
/// only, never a pattern: a branch name can carry regex metacharacters, and a subsection
/// is case-sensitive.
fn config_values<'a>(entries: &'a [ConfigEntry], key: &str) -> impl Iterator<Item = &'a str> {
    let key = canonical_config_key(key);
    entries
        .iter()
        .filter(move |(k, _)| *k == key)
        .map(|(_, v)| v.as_deref().unwrap_or(""))
}

/// A single-valued key's effective value: the last one set wins.
fn config_last<'a>(entries: &'a [ConfigEntry], key: &str) -> Option<&'a str> {
    config_values(entries, key).last()
}

/// Reads the push config [`bare_push_would_be_refused`] decides on from one config listing;
/// `None` when the listing failed, which the caller treats as "not refused". The branch's
/// own remote is the upstream's, which exists only while `branch.<n>.remote` is set.
async fn bare_push_refused(repo_path: &str, name: &str, upstream_remote: &str) -> Option<bool> {
    let out = run_git(
        Some(repo_path),
        &["config", "-z", "--list"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let config = parse_config_list(&out.stdout_lossy());
    let push_default = config_last(&config, "push.default");
    let branch_push_remote = config_last(&config, &format!("branch.{name}.pushRemote"));
    let remote_push_default = config_last(&config, "remote.pushDefault");
    let push_remote = branch_push_remote
        .or(remote_push_default)
        .unwrap_or(upstream_remote);
    let remote_has_push_refspec = config_values(&config, &format!("remote.{push_remote}.push"))
        .any(|refspec| !refspec.trim().is_empty());
    Some(bare_push_would_be_refused(
        push_default,
        branch_push_remote,
        remote_push_default,
        Some(upstream_remote),
        upstream_remote,
        remote_has_push_refspec,
    ))
}

/// push.default unset/`simple` refuses a bare push when the upstream's name differs
/// and the push lands on the upstream's own remote with no push refspec of its own
/// (git-config push.default; measured in `bare_push_refusal_matrix`).
fn bare_push_would_be_refused(
    push_default: Option<&str>,
    branch_push_remote: Option<&str>,
    remote_push_default: Option<&str>,
    branch_remote: Option<&str>,
    upstream_remote: &str,
    remote_has_push_refspec: bool,
) -> bool {
    let simple = matches!(push_default, None | Some("simple"));
    let push_remote = branch_push_remote.or(remote_push_default).or(branch_remote);
    simple && push_remote == Some(upstream_remote) && !remote_has_push_refspec
}

fn change_kind(c: char) -> Option<ChangeKind> {
    match c {
        'M' => Some(ChangeKind::Modified),
        'T' => Some(ChangeKind::Typechange),
        'A' => Some(ChangeKind::Added),
        'D' => Some(ChangeKind::Deleted),
        'R' => Some(ChangeKind::Renamed),
        'C' => Some(ChangeKind::Copied),
        _ => None,
    }
}

/// Parses `git status --porcelain=v2 --branch -z` output.
/// With -z, records are NUL-separated; a rename/copy record (`2 ...`) is
/// followed by an extra NUL-separated token holding the original path.
pub fn parse_status_v2(text: &str) -> RepoStatus {
    let mut branch = BranchHead {
        name: None,
        detached: false,
        oid: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        upstream_gone: false,
        upstream_remote: None,
        upstream_branch: None,
        push_name_mismatch: false,
        upstream_is_remote_default: None,
    };
    let mut entries = Vec::new();
    // Porcelain v2 has no `[gone]` token. When the upstream ref is gone git still
    // emits `# branch.upstream <name>` but omits `# branch.ab` entirely; a live
    // upstream always produces a `branch.ab` line (even `+0 -0`). So a present
    // upstream with no `branch.ab` seen ⇒ gone.
    //
    // Invariants this relies on (verified live on git for Windows): porcelain v2
    // emits `branch.ab` for a live upstream unconditionally — `status.aheadBehind
    // = false` affects non-porcelain formats only, and `--no-ahead-behind` is
    // ignored by porcelain v2. Porcelain v2 also has no `branch.status` header.
    // Belt-and-braces, `status_core` additionally pins `-c status.aheadBehind=
    // true` on its invocation so even a git fork that honors the config for
    // porcelain output cannot suppress `branch.ab` and fake a gone upstream.
    let mut saw_ab = false;

    let mut tokens = text.split('\0').peekable();
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        if let Some(header) = token.strip_prefix("# ") {
            if let Some(oid) = header.strip_prefix("branch.oid ") {
                branch.oid = (oid != "(initial)").then(|| oid.to_string());
            } else if let Some(head) = header.strip_prefix("branch.head ") {
                if head == "(detached)" {
                    branch.detached = true;
                } else {
                    branch.name = Some(head.to_string());
                }
            } else if let Some(upstream) = header.strip_prefix("branch.upstream ") {
                branch.upstream = Some(upstream.to_string());
            } else if let Some(ab) = header.strip_prefix("branch.ab ") {
                saw_ab = true;
                for part in ab.split(' ') {
                    if let Some(a) = part.strip_prefix('+') {
                        branch.ahead = a.parse().unwrap_or(0);
                    } else if let Some(b) = part.strip_prefix('-') {
                        branch.behind = b.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }

        match token.chars().next() {
            Some('1') => {
                // 1 XY sub mH mI mW hH hI path
                let mut fields = token.splitn(9, ' ');
                let xy = fields.nth(1).unwrap_or("..");
                let path = fields.nth(6).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                entries.push(entry_from_xy(xy, path, None));
            }
            Some('2') => {
                // 2 XY sub mH mI mW hH hI Xscore path  (NUL)  origPath
                let mut fields = token.splitn(10, ' ');
                let xy = fields.nth(1).unwrap_or("..");
                let path = fields.nth(7).unwrap_or("");
                let orig = tokens.next().map(|s| s.to_string());
                if path.is_empty() {
                    continue;
                }
                entries.push(entry_from_xy(xy, path, orig));
            }
            Some('u') => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let path = token.splitn(11, ' ').nth(10).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                entries.push(FileEntry {
                    path: path.to_string(),
                    orig_path: None,
                    staged: None,
                    unstaged: Some(ChangeKind::Conflicted),
                });
            }
            Some('?') => {
                let path = token.split_once(' ').map_or("", |x| x.1);
                if path.is_empty() {
                    continue;
                }
                entries.push(FileEntry {
                    path: path.to_string(),
                    orig_path: None,
                    staged: None,
                    unstaged: Some(ChangeKind::Untracked),
                });
            }
            _ => {} // '!' ignored entries and anything unknown
        }
    }

    branch.upstream_gone = branch.upstream.is_some() && !saw_ab;

    RepoStatus { branch, entries }
}

fn entry_from_xy(xy: &str, path: &str, orig_path: Option<String>) -> FileEntry {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    FileEntry {
        path: path.to_string(),
        orig_path,
        staged: change_kind(x),
        unstaged: change_kind(y),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::runner::run_git_raw;

    fn z(parts: &[&str]) -> String {
        parts.join("\0")
    }

    #[test]
    fn parses_branch_headers_with_upstream() {
        let text = z(&[
            "# branch.oid abc123",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "",
        ]);
        let s = parse_status_v2(&text);
        assert_eq!(s.branch.name.as_deref(), Some("main"));
        assert!(!s.branch.detached);
        assert_eq!(s.branch.oid.as_deref(), Some("abc123"));
        assert_eq!(s.branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!(s.branch.ahead, 2);
        assert_eq!(s.branch.behind, 1);
        // A live upstream always emits a branch.ab line, so it's not gone.
        assert!(!s.branch.upstream_gone);
        assert!(s.entries.is_empty());
    }

    #[test]
    fn upstream_present_without_ab_line_is_gone() {
        // When the remote branch is deleted, git keeps the upstream header but
        // drops the branch.ab line entirely — porcelain v2's only "gone" signal.
        let text = z(&[
            "# branch.oid abc123",
            "# branch.head feature",
            "# branch.upstream origin/feature",
            "",
        ]);
        let s = parse_status_v2(&text);
        assert_eq!(s.branch.upstream.as_deref(), Some("origin/feature"));
        assert!(s.branch.upstream_gone);
        assert_eq!(s.branch.ahead, 0);
        assert_eq!(s.branch.behind, 0);
    }

    #[test]
    fn no_upstream_is_not_gone() {
        // A branch that never had an upstream must not read as gone.
        let text = z(&["# branch.oid abc123", "# branch.head feature", ""]);
        let s = parse_status_v2(&text);
        assert_eq!(s.branch.upstream, None);
        assert!(!s.branch.upstream_gone);
    }

    #[test]
    fn parses_empty_repo_initial_oid() {
        let text = z(&["# branch.oid (initial)", "# branch.head main", ""]);
        let s = parse_status_v2(&text);
        assert_eq!(s.branch.oid, None);
        assert_eq!(s.branch.name.as_deref(), Some("main"));
    }

    #[test]
    fn parses_detached_head() {
        let text = z(&["# branch.oid abc123", "# branch.head (detached)", ""]);
        let s = parse_status_v2(&text);
        assert!(s.branch.detached);
        assert_eq!(s.branch.name, None);
    }

    #[test]
    fn parses_ordinary_entries() {
        let text = z(&[
            "# branch.head main",
            "1 .M N... 100644 100644 100644 e69de29 e69de29 app.js",
            "1 A. N... 000000 100644 100644 0000000 e69de29 staged.txt",
            "1 MD N... 100644 100644 100644 e69de29 e69de29 weird name.txt",
            "",
        ]);
        let s = parse_status_v2(&text);
        assert_eq!(s.entries.len(), 3);
        assert_eq!(s.entries[0].path, "app.js");
        assert_eq!(s.entries[0].staged, None);
        assert_eq!(s.entries[0].unstaged, Some(ChangeKind::Modified));
        assert_eq!(s.entries[1].staged, Some(ChangeKind::Added));
        assert_eq!(s.entries[1].unstaged, None);
        assert_eq!(s.entries[2].path, "weird name.txt");
        assert_eq!(s.entries[2].staged, Some(ChangeKind::Modified));
        assert_eq!(s.entries[2].unstaged, Some(ChangeKind::Deleted));
    }

    #[test]
    fn parses_rename_with_orig_path() {
        let text = z(&[
            "# branch.head main",
            "2 R. N... 100644 100644 100644 e69de29 e69de29 R100 helpers.js",
            "util.js",
            "1 .M N... 100644 100644 100644 e69de29 e69de29 app.js",
            "",
        ]);
        let s = parse_status_v2(&text);
        assert_eq!(s.entries.len(), 2);
        assert_eq!(s.entries[0].path, "helpers.js");
        assert_eq!(s.entries[0].orig_path.as_deref(), Some("util.js"));
        assert_eq!(s.entries[0].staged, Some(ChangeKind::Renamed));
        assert_eq!(s.entries[1].path, "app.js");
    }

    #[test]
    fn parse_leaves_the_upstream_facts_at_their_defaults() {
        let text = z(&[
            "# branch.oid abc123",
            "# branch.head feat/y",
            "# branch.upstream origin/feat/x",
            "# branch.ab +1 -0",
            "",
        ]);
        let b = parse_status_v2(&text).branch;
        assert_eq!(b.upstream_remote, None);
        assert_eq!(b.upstream_branch, None);
        assert!(!b.push_name_mismatch);
        assert_eq!(b.upstream_is_remote_default, None);
    }

    /// Every parameter axis, both polarities, against the all-defaults refusal.
    #[test]
    fn bare_push_would_be_refused_decision_table() {
        let refused = |pd, bpr, rpd, br, has_refspec| {
            bare_push_would_be_refused(pd, bpr, rpd, br, "origin", has_refspec)
        };
        // Unset and explicit `simple` both refuse on the upstream's own remote.
        assert!(refused(None, None, None, Some("origin"), false));
        assert!(refused(Some("simple"), None, None, Some("origin"), false));
        // Any other push.default doesn't.
        for other in [
            "upstream", "tracking", "current", "matching", "nothing", "Simple",
        ] {
            assert!(
                !refused(Some(other), None, None, Some("origin"), false),
                "{other}"
            );
        }
        // branch.<n>.pushRemote outranks remote.pushDefault, which outranks branch.<n>.remote.
        assert!(!refused(None, Some("fork"), None, Some("origin"), false));
        assert!(refused(
            None,
            Some("origin"),
            Some("fork"),
            Some("fork"),
            false
        ));
        assert!(!refused(None, None, Some("fork"), Some("origin"), false));
        assert!(refused(None, None, Some("origin"), Some("fork"), false));
        assert!(!refused(None, None, None, Some("fork"), false));
        assert!(!refused(None, None, None, None, false));
        // A push refspec of the push remote's own replaces the default push.
        assert!(!refused(None, None, None, Some("origin"), true));
        assert!(!refused(Some("simple"), None, None, Some("origin"), true));
    }

    #[test]
    fn config_lookup_folds_section_and_variable_but_not_subsection() {
        let config = parse_config_list("push.default\nsimple\0remote.Origin.push\nrefs/x\0");
        assert_eq!(config_last(&config, "Push.Default"), Some("simple"));
        assert_eq!(config_last(&config, "PUSH.DEFAULT"), Some("simple"));
        assert_eq!(config_last(&config, "REMOTE.Origin.PUSH"), Some("refs/x"));
        assert_eq!(config_last(&config, "remote.origin.push"), None);
        let lower = parse_config_list("remote.origin.push\nrefs/y\0");
        assert_eq!(config_last(&lower, "remote.Origin.push"), None);
        // A dotted subsection keeps its dots: the variable is after the LAST one.
        let dotted = parse_config_list("branch.Feat.Y.pushremote\nfork\0");
        assert_eq!(
            config_last(&dotted, "branch.Feat.Y.pushRemote"),
            Some("fork")
        );
        assert_eq!(config_last(&dotted, "branch.feat.y.pushRemote"), None);
    }

    #[test]
    fn config_list_parse_arms() {
        // Only the first newline splits key from value.
        let config = parse_config_list("alias.two\nline1\nline2\0");
        assert_eq!(
            config,
            vec![("alias.two".to_string(), Some("line1\nline2".to_string()))]
        );
        // A valueless boolean entry has no newline at all; it reads as empty.
        let config = parse_config_list("push.autosetupremote\0");
        assert_eq!(config, vec![("push.autosetupremote".to_string(), None)]);
        assert_eq!(config_last(&config, "push.autoSetupRemote"), Some(""));
        // Last wins for a single-valued key.
        let config = parse_config_list("push.default\nupstream\0push.default\nsimple\0");
        assert_eq!(config_last(&config, "push.default"), Some("simple"));
        // A multi-valued key yields every value, in order.
        let config = parse_config_list(
            "remote.origin.push\nrefs/heads/a:refs/heads/a\0core.bare\nfalse\0remote.origin.push\nrefs/heads/b:refs/heads/b\0",
        );
        assert_eq!(
            config_values(&config, "remote.origin.push").collect::<Vec<_>>(),
            ["refs/heads/a:refs/heads/a", "refs/heads/b:refs/heads/b"]
        );
        // An empty listing has nothing.
        let config = parse_config_list("");
        assert!(config.is_empty());
        assert_eq!(config_last(&config, "push.default"), None);
        assert_eq!(config_values(&config, "remote.origin.push").count(), 0);
    }

    #[test]
    fn upstream_split_arms() {
        use crate::git::remote::Upstream;
        let split = |t: Option<(Upstream, &str, bool)>| {
            upstream_split("feat/y", t.map(|(u, r, g)| (u, r.to_string(), g)))
        };
        let branch = |b: &str| Upstream::Branch(b.to_string());
        let both = |candidate| UpstreamSplit {
            remote: Some("origin".into()),
            branch: Some("feat/x".into()),
            candidate,
        };
        let nothing = UpstreamSplit {
            remote: None,
            branch: None,
            candidate: false,
        };
        // Live, differently named: the one candidate shape.
        assert_eq!(split(Some((branch("feat/x"), "origin", false))), both(true));
        // Gone keeps both names but is never a candidate.
        assert_eq!(split(Some((branch("feat/x"), "origin", true))), both(false));
        // Same name: no mismatch.
        assert_eq!(
            split(Some((branch("feat/y"), "origin", false))),
            UpstreamSplit {
                remote: Some("origin".into()),
                branch: Some("feat/y".into()),
                candidate: false,
            }
        );
        // A non-branch upstream names its remote only.
        assert_eq!(
            split(Some((Upstream::NotABranch, "origin", false))),
            UpstreamSplit {
                remote: Some("origin".into()),
                branch: None,
                candidate: false,
            }
        );
        // Local `.` upstream, empty remotename, untracked, and no line (unborn) yield nothing.
        assert_eq!(split(Some((branch("main"), ".", false))), nothing);
        assert_eq!(split(Some((branch("main"), "", false))), nothing);
        assert_eq!(split(Some((Upstream::Untracked, "", false))), nothing);
        assert_eq!(split(None), nothing);
    }

    /// The camelCase keys the TS `BranchHead` mirror reads, and none of the snake_case
    /// spellings.
    #[test]
    fn branch_head_serializes_the_upstream_facts_in_camel_case() {
        let text = z(&[
            "# branch.head feat/y",
            "# branch.upstream origin/feat/x",
            "",
        ]);
        let mut head = parse_status_v2(&text).branch;
        head.upstream_remote = Some("origin".into());
        head.upstream_branch = Some("feat/x".into());
        head.push_name_mismatch = true;
        head.upstream_is_remote_default = Some(false);
        let wire = serde_json::to_value(&head).unwrap();
        assert_eq!(wire["upstreamRemote"], "origin");
        assert_eq!(wire["upstreamBranch"], "feat/x");
        assert_eq!(wire["pushNameMismatch"], true);
        assert_eq!(wire["upstreamIsRemoteDefault"], false);
        let keys = wire.as_object().unwrap();
        for snake in [
            "upstream_remote",
            "upstream_branch",
            "push_name_mismatch",
            "upstream_is_remote_default",
        ] {
            assert!(!keys.contains_key(snake), "{snake}");
        }
        let unknown = serde_json::to_value(parse_status_v2(&text).branch).unwrap();
        assert!(unknown["upstreamIsRemoteDefault"].is_null());
    }

    // --- Real-repo tests: the predicate pinned against git's own verdict. ---

    async fn git(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap_or_else(|e| panic!("git {args:?} in {repo}: {e}"))
            .stdout_lossy()
    }

    fn temp_base(tag: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-status-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    /// A clone of a bare `origin.git` carrying `main` (its HEAD) and `feat/x`, with a
    /// second remote, standing on `feat/x` checked out tracking `origin/feat/x` and then
    /// renamed to `feat/y`, one commit ahead. Returns the clone's path.
    async fn renamed_branch_fixture(base: &std::path::Path, tag: &str) -> String {
        let dir = base.join(tag);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().into_owned();
        let path = |name: &str| dir.join(name).to_string_lossy().into_owned();
        git(&d, &["init", "-q", "--bare", "-b", "main", "origin.git"]).await;
        git(&d, &["init", "-q", "--bare", "-b", "main", "second.git"]).await;
        git(&d, &["init", "-q", "-b", "main", "seed"]).await;
        let seed = path("seed");
        git(&seed, &["config", "user.email", "t@t.local"]).await;
        git(&seed, &["config", "user.name", "T"]).await;
        std::fs::write(dir.join("seed").join("a.txt"), "a\n").unwrap();
        git(&seed, &["add", "-A"]).await;
        git(&seed, &["commit", "-qm", "seed"]).await;
        let origin = path("origin.git");
        git(
            &seed,
            &["push", "-q", &origin, "main", "main:refs/heads/feat/x"],
        )
        .await;
        git(&seed, &["push", "-q", &path("second.git"), "main"]).await;
        git(
            &d,
            &["-c", "core.autocrlf=false", "clone", "-q", &origin, "work"],
        )
        .await;
        let work = path("work");
        git(&work, &["config", "user.email", "t@t.local"]).await;
        git(&work, &["config", "user.name", "T"]).await;
        git(&work, &["remote", "add", "second", &path("second.git")]).await;
        git(&work, &["fetch", "-q", "second"]).await;
        git(
            &work,
            &["switch", "-q", "-c", "feat/x", "--track", "origin/feat/x"],
        )
        .await;
        git(&work, &["branch", "-m", "feat/x", "feat/y"]).await;
        commit_one(&work, "work.txt").await;
        work
    }

    async fn commit_one(repo: &str, file: &str) {
        std::fs::write(std::path::Path::new(repo).join(file), "x\n").unwrap();
        git(repo, &["add", "-A"]).await;
        git(repo, &["commit", "-qm", file]).await;
    }

    /// Whether every key reads unset in `repo` (exit 1) — a check that needs an axis unset
    /// skips, naming itself (`what`) and the key, when the developer's global config leaks
    /// a value in.
    async fn all_unset(repo: &str, what: &str, keys: &[&str]) -> bool {
        for key in keys {
            let out = run_git_raw(Some(repo), &["config", "--get", key], DEFAULT_TIMEOUT)
                .await
                .unwrap();
            if out.code != 1 {
                eprintln!("skipping {what}: {key} is set outside the fixture");
                return false;
            }
        }
        true
    }

    /// A bare `git push`'s verdict: whether git refused it for the name mismatch.
    async fn bare_push_refused_by_git(repo: &str) -> bool {
        let out = run_git_raw(Some(repo), &["push", "-q"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        let collapsed = out.stderr.split_whitespace().collect::<Vec<_>>().join(" ");
        let refused = collapsed.contains("does not match the name of your current branch");
        assert!(
            refused || out.code == 0,
            "push failed otherwise: {}",
            out.stderr
        );
        refused
    }

    /// The decision table measured against git itself: per push-config row, the status
    /// flag must equal git's own bare-push verdict on a renamed tracking branch. Every axis
    /// a row relies on is written to the repo-local config; the ones it needs unset are
    /// checked unset first.
    #[tokio::test]
    async fn bare_push_refusal_matrix() {
        let (_guard, base) = temp_base("matrix");
        let pd = "push.default";
        let push_remote = "branch.feat/y.pushRemote";
        let remote_pd = "remote.pushDefault";
        let origin_push = "remote.origin.push";
        // (row tag, config to write, keys that must read unset, expected mismatch)
        type Row<'a> = (&'a str, &'a [(&'a str, &'a str)], &'a [&'a str], bool);
        let rows: [Row<'_>; 8] = [
            (
                "a-defaults",
                &[],
                &[pd, push_remote, remote_pd, origin_push],
                true,
            ),
            (
                "b-simple",
                &[(pd, "simple")],
                &[push_remote, remote_pd, origin_push],
                true,
            ),
            (
                "c-push-remote",
                &[(pd, "simple"), (push_remote, "second")],
                &["remote.second.push"],
                false,
            ),
            (
                "d-remote-push-default",
                &[(pd, "simple"), (remote_pd, "second")],
                &[push_remote, "remote.second.push"],
                false,
            ),
            (
                "e-upstream",
                &[(pd, "upstream")],
                &[push_remote, remote_pd],
                false,
            ),
            (
                "f-current",
                &[(pd, "current")],
                &[push_remote, remote_pd],
                false,
            ),
            (
                "g-push-refspec",
                &[
                    (pd, "simple"),
                    (origin_push, "refs/heads/feat/y:refs/heads/feat/y"),
                ],
                &[push_remote, remote_pd],
                false,
            ),
            // remote.pushDefault names the second remote, but the branch's own pushRemote
            // names origin again and outranks it, so git refuses.
            (
                "i-push-remote-outranks",
                &[
                    (pd, "simple"),
                    (remote_pd, "second"),
                    (push_remote, "origin"),
                ],
                &[origin_push],
                true,
            ),
        ];
        for (tag, config, unset, expect) in rows {
            let work = renamed_branch_fixture(&base, tag).await;
            for (key, value) in config {
                git(&work, &["config", key, value]).await;
            }
            if !all_unset(&work, &format!("row {tag}"), unset).await {
                continue;
            }
            let head = status_core(&work).await.unwrap().branch;
            assert_eq!(head.push_name_mismatch, expect, "row {tag}");
            assert_eq!(head.upstream_remote.as_deref(), Some("origin"), "row {tag}");
            assert_eq!(head.upstream_branch.as_deref(), Some("feat/x"), "row {tag}");
            let probed = if expect { Some(false) } else { None };
            assert_eq!(head.upstream_is_remote_default, probed, "row {tag}");
            assert_eq!(
                bare_push_refused_by_git(&work).await,
                expect,
                "git's verdict, row {tag}"
            );
        }
    }

    /// A branch tracking the remote's DEFAULT branch under another name (`checkout -b x
    /// origin/main`): still a mismatch, and the remote-HEAD probe says so.
    #[tokio::test]
    async fn a_mismatch_onto_the_remote_default_branch_is_flagged_as_such() {
        let (_guard, base) = temp_base("default");
        let work = renamed_branch_fixture(&base, "w").await;
        git(&work, &["config", "push.default", "simple"]).await;
        if !all_unset(
            &work,
            "the default-branch check",
            &[
                "branch.topic.pushRemote",
                "remote.pushDefault",
                "remote.origin.push",
            ],
        )
        .await
        {
            return;
        }
        git(
            &work,
            &["switch", "-q", "-c", "topic", "--track", "origin/main"],
        )
        .await;
        commit_one(&work, "topic.txt").await;
        let head = status_core(&work).await.unwrap().branch;
        assert!(head.push_name_mismatch);
        assert_eq!(head.upstream_branch.as_deref(), Some("main"));
        assert_eq!(head.upstream_is_remote_default, Some(true));
    }

    /// The shapes that are never a mismatch, each read off a real repository. The
    /// pull-request row is the measured residual: git refuses its bare push by name, but
    /// with no branch to name it keeps a plain Push and git's own message.
    #[tokio::test]
    async fn status_fill_arms_on_real_repositories() {
        let (_guard, base) = temp_base("arms");
        let work = renamed_branch_fixture(&base, "w").await;
        git(&work, &["config", "push.default", "simple"]).await;
        let origin = base
            .join("w")
            .join("origin.git")
            .to_string_lossy()
            .into_owned();

        // Same name: both names, no mismatch.
        git(
            &work,
            &["switch", "-q", "-c", "feat/x", "--track", "origin/feat/x"],
        )
        .await;
        let head = status_core(&work).await.unwrap().branch;
        assert_eq!(head.upstream_remote.as_deref(), Some("origin"));
        assert_eq!(head.upstream_branch.as_deref(), Some("feat/x"));
        assert!(!head.push_name_mismatch);

        // Untracked: nothing.
        git(&work, &["switch", "-q", "-c", "loose"]).await;
        let head = status_core(&work).await.unwrap().branch;
        assert_eq!((head.upstream_remote, head.upstream_branch), (None, None));

        // Local `.` upstream: nothing.
        git(
            &work,
            &["switch", "-q", "-c", "local-up", "--track", "main"],
        )
        .await;
        let head = status_core(&work).await.unwrap().branch;
        assert!(head.upstream.is_some());
        assert_eq!((head.upstream_remote, head.upstream_branch), (None, None));
        assert!(!head.push_name_mismatch);

        // A pull-request upstream: its remote only, never a mismatch — git still refuses
        // the bare push, which keeps its own message.
        git(
            &origin,
            &["update-ref", "refs/pull/7/head", "refs/heads/main"],
        )
        .await;
        git(
            &work,
            &[
                "config",
                "--add",
                "remote.origin.fetch",
                "+refs/pull/*/head:refs/remotes/origin/pr/*",
            ],
        )
        .await;
        git(&work, &["fetch", "-q", "origin"]).await;
        git(
            &work,
            &["switch", "-q", "--no-track", "-c", "pr-7", "origin/pr/7"],
        )
        .await;
        git(&work, &["config", "branch.pr-7.remote", "origin"]).await;
        git(&work, &["config", "branch.pr-7.merge", "refs/pull/7/head"]).await;
        commit_one(&work, "pr.txt").await;
        let head = status_core(&work).await.unwrap().branch;
        assert!(head.upstream.is_some());
        assert_eq!(head.upstream_remote.as_deref(), Some("origin"));
        assert_eq!(head.upstream_branch, None);
        assert!(!head.push_name_mismatch);
        if all_unset(
            &work,
            "the pr-7 bare-push check",
            &[
                "branch.pr-7.pushRemote",
                "remote.pushDefault",
                "remote.origin.push",
            ],
        )
        .await
        {
            assert!(bare_push_refused_by_git(&work).await);
        }

        // Gone: both names kept, no mismatch.
        git(&work, &["switch", "-q", "feat/y"]).await;
        git(&work, &["update-ref", "-d", "refs/remotes/origin/feat/x"]).await;
        let head = status_core(&work).await.unwrap().branch;
        assert!(head.upstream_gone);
        assert_eq!(head.upstream_remote.as_deref(), Some("origin"));
        assert_eq!(head.upstream_branch.as_deref(), Some("feat/x"));
        assert!(!head.push_name_mismatch);

        // Detached: nothing.
        git(&work, &["switch", "-q", "--detach"]).await;
        let head = status_core(&work).await.unwrap().branch;
        assert_eq!((head.upstream_remote, head.upstream_branch), (None, None));
    }

    #[test]
    fn parses_untracked_and_unmerged() {
        let text = z(&[
            "# branch.head main",
            "? untracked.txt",
            "u UU N... 100644 100644 100644 100644 e69de29 e69de29 e69de29 conflict.txt",
            "",
        ]);
        let s = parse_status_v2(&text);
        assert_eq!(s.entries[0].unstaged, Some(ChangeKind::Untracked));
        assert_eq!(s.entries[1].path, "conflict.txt");
        assert_eq!(s.entries[1].unstaged, Some(ChangeKind::Conflicted));
    }
}
