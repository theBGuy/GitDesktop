use tauri::State;

use crate::error::AppResult;
use crate::git::branches::{
    push_destination_fields, read_refs_with_push_destination, validate_ref_name,
};
use crate::git::diff::git_config_bool;
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

/// Fills the upstream's remote/branch split, the bare push's destination and the
/// mismatch facts the porcelain's short `branch.upstream` can't carry. Advisory, failing
/// toward inaction: any failed read leaves its facts None/false. One spawn per upstream
/// (two on a git without the push atoms); a cross-name upstream, a push remote other
/// than the upstream's, or a destination other than a live upstream adds one config
/// listing, and a refused bare push the remote-HEAD probe.
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
    // The shared tracking format plus the push-destination atoms, in this one spawn;
    // the shared constant stays as the push path parses it.
    let Ok(text) =
        read_refs_with_push_destination(repo_path, &refname, UPSTREAM_TRACKING_FORMAT).await
    else {
        return;
    };
    let tracking = parse_upstream_tracking(&text, &refname);
    let (atoms, push_remotename) = tracking_line_push_destination(&text, &refname, &name);
    // A local upstream's remote reads `.`, which the split drops; a named push remote
    // beside it is the same triangular shape as any other.
    let local_upstream = matches!(&tracking, Some((Upstream::Branch(_), r, _)) if r == ".");
    let split = upstream_split(&name, tracking);
    head.upstream_remote.clone_from(&split.remote);
    head.upstream_branch.clone_from(&split.branch);
    (head.push_remote, head.push_branch) = atoms.clone();
    // Atoms that name somewhere other than a live upstream (a non-branch or gone
    // upstream, a push remote of its own) may describe a push git won't make, such as
    // `matching`'s, so the config decides those; the everyday push to its own live
    // upstream reads none.
    let off_upstream = atoms.0.is_some()
        && (atoms != (split.remote.clone(), split.branch.clone()) || head.upstream_gone);
    let remote = match split.remote {
        Some(remote) => remote,
        None if local_upstream => ".".to_string(),
        None => return,
    };
    // A triangular repo pushes to a remote that isn't the upstream's, even where the
    // atoms resolve nothing (`simple` there).
    let triangular = is_named_remote(&push_remotename) && push_remotename != remote;
    if !split.candidate && !triangular && !off_upstream {
        return;
    }
    let config = push_config(repo_path).await;
    (head.push_remote, head.push_branch) =
        configured_destination(config.as_deref(), &name, &remote, atoms);
    let (true, Some(c), Some(up)) = (split.candidate, config, split.branch) else {
        return;
    };
    if !bare_push_refused(&c, &name, &remote) {
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

/// Whether `remote.<r>.mirror` may make a bare push to `r` a mirror push (git-config:
/// "as if --mirror was given"). Read off the raw entry, since a valueless key is true; a
/// value git can't read as a bool counts too, so only a definite false clears it.
fn remote_is_mirror(config: &[ConfigEntry], remote: &str) -> bool {
    let key = canonical_config_key(&format!("remote.{remote}.mirror"));
    config
        .iter()
        .rfind(|(k, _)| *k == key)
        .is_some_and(|(_, v)| git_config_bool(v.as_deref()) != Some(false))
}

/// The one config listing the push decisions read; `None` when it failed, which callers
/// treat as "not refused" and "no destination claimed".
async fn push_config(repo_path: &str) -> Option<Vec<ConfigEntry>> {
    let out = run_git(
        Some(repo_path),
        &["config", "-z", "--list"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    Some(parse_config_list(&out.stdout_lossy()))
}

/// Reads the push config [`bare_push_would_be_refused`] decides on. The branch's own
/// remote is the upstream's, which exists only while `branch.<n>.remote` is set.
fn bare_push_refused(config: &[ConfigEntry], name: &str, upstream_remote: &str) -> bool {
    let push_default = config_last(config, "push.default");
    let branch_push_remote = config_last(config, &format!("branch.{name}.pushRemote"));
    let remote_push_default = config_last(config, "remote.pushDefault");
    let push_remote = branch_push_remote
        .or(remote_push_default)
        .unwrap_or(upstream_remote);
    let remote_has_push_refspec = config_values(config, &format!("remote.{push_remote}.push"))
        .any(|refspec| !refspec.trim().is_empty());
    bare_push_would_be_refused(
        push_default,
        branch_push_remote,
        remote_push_default,
        Some(upstream_remote),
        upstream_remote,
        remote_has_push_refspec,
    )
}

/// Where push.default unset/`simple` sends a bare push whose push remote is not the
/// upstream's: `simple` then acts as `current` (git-config push.default), landing the
/// branch under its own name there, yet `%(push)` resolves nothing for it (measured
/// empty, git 2.51.1, in `push_destination_matrix`). A push remote with its own push
/// refspecs claims nothing: git's bare push sends every one of them, as configured. A
/// mirror push remote is left to [`configured_destination`], which clears it on both paths.
fn triangular_simple_destination(
    config: &[ConfigEntry],
    name: &str,
    upstream_remote: &str,
) -> (Option<String>, Option<String>) {
    if !matches!(config_last(config, "push.default"), None | Some("simple")) {
        return (None, None);
    }
    let push_remote = config_last(config, &format!("branch.{name}.pushRemote"))
        .or(config_last(config, "remote.pushDefault"))
        .unwrap_or(upstream_remote);
    let has_refspec = config_values(config, &format!("remote.{push_remote}.push"))
        .any(|refspec| !refspec.trim().is_empty());
    if push_remote == upstream_remote || !is_named_remote(push_remote) || has_refspec {
        return (None, None);
    }
    (Some(push_remote.to_string()), Some(name.to_string()))
}

/// Where a bare push lands once the push config is read, from the atoms' destination:
/// `push.default=matching` resolves `%(push)` like `current` but only updates branches
/// both ends already have, so it never creates one; triangular `simple` lands where the
/// atoms resolve nothing. The remote must be a configured one (a pushRemote can name a
/// URL) and no mirror (`remote.<r>.mirror`: git's bare push mirrors every ref there, as
/// configured); a failed listing claims nothing.
fn configured_destination(
    config: Option<&[ConfigEntry]>,
    name: &str,
    upstream_remote: &str,
    atoms: (Option<String>, Option<String>),
) -> (Option<String>, Option<String>) {
    let Some(c) = config else {
        return (None, None);
    };
    if config_last(c, "push.default") == Some("matching") {
        return (None, None);
    }
    let dest = match atoms {
        (Some(r), Some(b)) => (Some(r), Some(b)),
        _ => triangular_simple_destination(c, name, upstream_remote),
    };
    let configured = dest.0.as_deref().is_some_and(|r| {
        config_values(c, &format!("remote.{r}.url"))
            .next()
            .is_some()
            && !remote_is_mirror(c, r)
    });
    if configured {
        dest
    } else {
        (None, None)
    }
}

/// The push destination off the first line of a tracking read, its atoms after the
/// shared format's four fields, plus the raw `%(push:remotename)`; None/None and empty
/// when the line is missing, names another ref, or the read fell back without the atoms.
fn tracking_line_push_destination(
    text: &str,
    refname: &str,
    name: &str,
) -> ((Option<String>, Option<String>), String) {
    let none = ((None, None), String::new());
    let Some(line) = text.lines().next() else {
        return none;
    };
    let fields: Vec<&str> = line.split('\0').collect();
    if fields.first() != Some(&refname) {
        return none;
    }
    let upstream_remoteref = fields.get(1).copied().unwrap_or("");
    let upstream_remote = fields.get(2).copied().unwrap_or("");
    let atoms = fields.get(4..).unwrap_or(&[]);
    let dest = push_destination_fields(name, atoms, upstream_remote, upstream_remoteref);
    (dest, atoms.first().copied().unwrap_or("").to_string())
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
        push_remote: None,
        push_branch: None,
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
        head.push_remote = Some("second".into());
        head.push_branch = Some("feat/y".into());
        let wire = serde_json::to_value(&head).unwrap();
        assert_eq!(wire["upstreamRemote"], "origin");
        assert_eq!(wire["upstreamBranch"], "feat/x");
        assert_eq!(wire["pushNameMismatch"], true);
        assert_eq!(wire["upstreamIsRemoteDefault"], false);
        assert_eq!(wire["pushRemote"], "second");
        assert_eq!(wire["pushBranch"], "feat/y");
        let keys = wire.as_object().unwrap();
        for snake in [
            "upstream_remote",
            "upstream_branch",
            "push_name_mismatch",
            "upstream_is_remote_default",
            "push_remote",
            "push_branch",
        ] {
            assert!(!keys.contains_key(snake), "{snake}");
        }
        let unknown = serde_json::to_value(parse_status_v2(&text).branch).unwrap();
        assert!(unknown["upstreamIsRemoteDefault"].is_null());
        // Unresolved serializes as present-and-null, the shape the TS mirror types.
        let unknown = unknown.as_object().unwrap();
        for key in ["pushRemote", "pushBranch"] {
            assert!(unknown.get(key).is_some_and(|v| v.is_null()), "{key}");
        }
    }

    /// `simple` off the upstream's remote lands under the branch's own name there; any
    /// other mode, the upstream's own remote, or a push refspec claims nothing here.
    #[test]
    fn triangular_simple_destination_arms() {
        let dest = |listing: &str| {
            triangular_simple_destination(&parse_config_list(listing), "feat/y", "origin")
        };
        let second = (Some("second".to_string()), Some("feat/y".to_string()));
        assert_eq!(dest("branch.feat/y.pushRemote\nsecond\0"), second);
        assert_eq!(
            dest("remote.pushDefault\nsecond\0push.default\nsimple\0"),
            second
        );
        // The branch's own pushRemote outranks remote.pushDefault.
        assert_eq!(
            dest("remote.pushDefault\nsecond\0branch.feat/y.pushRemote\norigin\0"),
            (None, None)
        );
        assert_eq!(dest(""), (None, None));
        assert_eq!(
            dest("push.default\ncurrent\0branch.feat/y.pushRemote\nsecond\0"),
            (None, None)
        );
        assert_eq!(
            dest("branch.feat/y.pushRemote\nsecond\0remote.second.push\nrefs/heads/*:refs/heads/x/*\0"),
            (None, None)
        );
        assert_eq!(dest("branch.feat/y.pushRemote\n.\0"), (None, None));
    }

    /// The config-read arms: matching claims nothing, triangular `simple` fills in where
    /// the atoms resolved nothing, the remote must be configured, and a failed listing
    /// claims nothing.
    #[test]
    fn configured_destination_arms() {
        let remotes = "remote.origin.url\nhttps://h/o/r\0remote.second.url\nhttps://h/s/r\0";
        let dest = |extra: &str, atoms: (Option<&str>, Option<&str>)| {
            let config = parse_config_list(&format!("{remotes}{extra}"));
            configured_destination(
                Some(&config),
                "topic",
                "origin",
                (atoms.0.map(str::to_string), atoms.1.map(str::to_string)),
            )
        };
        let some = |r: &str, b: &str| (Some(r.to_string()), Some(b.to_string()));
        let none = (None, None);
        // Atoms that resolved pass through; matching claims nothing either way.
        assert_eq!(
            dest("", (Some("origin"), Some("topic"))),
            some("origin", "topic")
        );
        assert_eq!(
            dest("push.default\nmatching\0", (Some("second"), Some("topic"))),
            none
        );
        // Triangular simple, same name: the push remote under the local name.
        assert_eq!(
            dest("remote.pushDefault\nsecond\0", (None, None)),
            some("second", "topic")
        );
        assert_eq!(
            dest(
                "branch.topic.pushRemote\nsecond\0push.default\nmatching\0",
                (None, None)
            ),
            none
        );
        // A pushRemote that is a URL, or names no configured remote, is never claimed.
        assert_eq!(
            dest(
                "branch.topic.pushRemote\nhttps://elsewhere/x.git\0",
                (None, None)
            ),
            none
        );
        assert_eq!(dest("remote.pushDefault\nghost\0", (None, None)), none);
        assert_eq!(dest("", (Some("ghost"), Some("topic"))), none);
        // A mirror push remote is unresolved on both paths, valueless and junk values
        // included; the last entry wins, and a definite false or another remote's mirror
        // leaves the claim.
        for mirror in [
            "remote.second.mirror\ntrue\0",
            "remote.second.mirror\nYes\0",
            "remote.second.mirror\n2\0",
            "remote.second.mirror\0",
            "remote.second.mirror\nmaybe\0",
            "remote.second.mirror\nfalse\0remote.second.mirror\non\0",
        ] {
            assert_eq!(
                dest(mirror, (Some("second"), Some("topic"))),
                none,
                "{mirror:?}"
            );
            assert_eq!(
                dest(
                    &format!("remote.pushDefault\nsecond\0{mirror}"),
                    (None, None)
                ),
                none,
                "{mirror:?}"
            );
        }
        for not_mirror in [
            "remote.second.mirror\nfalse\0",
            "remote.second.mirror\nOFF\0",
            "remote.second.mirror\n\0",
            "remote.second.mirror\non\0remote.second.mirror\n0\0",
            "remote.origin.mirror\ntrue\0",
            "remote.Second.mirror\ntrue\0",
        ] {
            assert_eq!(
                dest(not_mirror, (Some("second"), Some("topic"))),
                some("second", "topic"),
                "{not_mirror:?}"
            );
        }
        assert_eq!(
            configured_destination(
                None,
                "topic",
                "origin",
                (Some("origin".into()), Some("topic".into()))
            ),
            none
        );
    }

    /// A read that fell back without the push atoms keeps every upstream fact and
    /// carries no destination. The shared tracking format's line is what the fallback
    /// reads, so it is fed straight in (the status read's own format can't be swapped
    /// for one with an unknown atom; the live fallback is pinned in branches.rs).
    #[test]
    fn a_tracking_line_without_push_atoms_keeps_the_upstream_facts() {
        let refname = "refs/heads/feat/y";
        let base = format!("{refname}\0refs/heads/feat/x\0origin\0[ahead 1]\n");
        assert_eq!(
            parse_upstream_tracking(&base, refname),
            Some((Upstream::Branch("feat/x".into()), "origin".into(), false))
        );
        assert_eq!(
            tracking_line_push_destination(&base, refname, "feat/y"),
            ((None, None), String::new())
        );
        // The same line WITH the atoms: identical upstream facts, plus the destination.
        let extended = format!(
            "{refname}\0refs/heads/feat/x\0origin\0[ahead 1]\0origin\0\0refs/remotes/origin/feat/y\0refs/remotes/origin/feat/x\n"
        );
        assert_eq!(
            parse_upstream_tracking(&extended, refname),
            parse_upstream_tracking(&base, refname)
        );
        assert_eq!(
            tracking_line_push_destination(&extended, refname, "feat/y"),
            (
                (Some("origin".into()), Some("feat/y".into())),
                "origin".into()
            )
        );
        // A line for another ref (for-each-ref's prefix match) carries nothing.
        assert_eq!(
            tracking_line_push_destination(&extended, "refs/heads/feat", "feat"),
            ((None, None), String::new())
        );
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

    /// Every `refs/heads/*` of a bare remote, name → sha.
    async fn remote_heads(bare: &str) -> std::collections::BTreeMap<String, String> {
        git(
            bare,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads",
            ],
        )
        .await
        .lines()
        .filter_map(|l| {
            let (r, sha) = l.split_once(' ')?;
            Some((r.strip_prefix("refs/heads/")?.to_string(), sha.to_string()))
        })
        .collect()
    }

    /// Where a bare `git push` from `work` actually landed: every `<remote>:<branch>`
    /// created or moved on the fixture's two bare remotes, then any it deleted (a mirror
    /// push can), suffixed ` deleted`. A refused or empty push lands nowhere.
    async fn bare_push_landing(work: &str, dir: &std::path::Path) -> Vec<String> {
        push_landing(work, dir, &["push", "-q"]).await.1
    }

    /// [`bare_push_landing`] for any push argv, with git's exit code and stderr.
    async fn push_landing(
        work: &str,
        dir: &std::path::Path,
        args: &[&str],
    ) -> ((i32, String), Vec<String>) {
        let remotes = [("origin", "origin.git"), ("second", "second.git")];
        let mut before = Vec::new();
        for (_, bare) in remotes {
            before.push(remote_heads(&dir.join(bare).to_string_lossy()).await);
        }
        let out = run_git_raw(Some(work), args, DEFAULT_TIMEOUT)
            .await
            .unwrap();
        let mut landed = Vec::new();
        let mut deleted = Vec::new();
        for ((name, bare), before) in remotes.into_iter().zip(before) {
            let after = remote_heads(&dir.join(bare).to_string_lossy()).await;
            for (branch, sha) in &after {
                if before.get(branch) != Some(sha) {
                    landed.push(format!("{name}:{branch}"));
                }
            }
            for branch in before.keys().filter(|b| !after.contains_key(*b)) {
                deleted.push(format!("{name}:{branch} deleted"));
            }
        }
        landed.extend(deleted);
        ((out.code, out.stderr), landed)
    }

    /// One measured row of [`push_destination_matrix`].
    #[derive(Debug, PartialEq)]
    struct PushRow {
        /// `%(push:remotename)`, `%(push:remoteref)`, `%(push)`, raw.
        atoms: [String; 3],
        /// The status read's destination, `remote:branch`.
        status: Option<String>,
        landed: Vec<String>,
    }

    fn joined(remote: &Option<String>, branch: &Option<String>) -> Option<String> {
        Some(format!("{}:{}", remote.as_deref()?, branch.as_deref()?))
    }

    /// The row's expectation, as `Err` carrying the whole measured and expected rows.
    fn check_row(tag: &str, got: &PushRow, want: &PushRow) -> Result<(), String> {
        if got == want {
            Ok(())
        } else {
            Err(format!("row {tag}: measured {got:?}, expected {want:?}"))
        }
    }

    /// Where a bare push lands, measured per push-config row on a branch (`feat/y`)
    /// tracking a differently named upstream (`origin/feat/x`), or for the `-same-`
    /// rows on that branch renamed to `feat/x`: the raw `%(push…)`
    /// atoms, the destination the status read derives from them, and
    /// the refs a real `git push` then created or moved. Every axis a row relies on is
    /// written to the repo-local config; the ones it needs unset are checked unset
    /// first. The rule under test: a destination the status read claims is exactly
    /// where the push landed; an unresolved one (None) never names a wrong branch.
    #[tokio::test]
    async fn push_destination_matrix() {
        let (_guard, base) = temp_base("push-dest");
        let pd = "push.default";
        let push_remote = "branch.feat/y.pushRemote";
        let push_remote_x = "branch.feat/x.pushRemote";
        let remote_pd = "remote.pushDefault";
        let origin_push = "remote.origin.push";
        let second_push = "remote.second.push";
        let origin_mirror = "remote.origin.mirror";
        let second_mirror = "remote.second.mirror";
        let all = [
            pd,
            push_remote,
            push_remote_x,
            remote_pd,
            origin_push,
            second_push,
            origin_mirror,
            second_mirror,
        ];
        // `git config` can't write a valueless key, so a row value of this sentinel is
        // appended to the config file as a bare `<var>` line instead.
        const VALUELESS: &str = "<valueless>";
        let s = |v: &str| v.to_string();
        let o = |v: &str| Some(v.to_string());
        let atoms = |r: &str, rr: &str, p: &str| [s(r), s(rr), s(p)];
        // (row tag, config to write, refetch after it, expected row)
        type Row<'a> = (&'a str, Vec<(&'a str, &'a str)>, bool, PushRow);
        let remap = (
            "remote.origin.fetch",
            "+refs/heads/*:refs/remotes/origin/team/*",
        );
        let rows: Vec<Row<'_>> = vec![
            // simple refuses the cross-name push; %(push) cannot resolve a single
            // destination.
            (
                "a-unset",
                vec![],
                false,
                PushRow {
                    atoms: atoms("origin", "", ""),
                    status: None,
                    landed: vec![],
                },
            ),
            (
                "b-simple",
                vec![(pd, "simple")],
                false,
                PushRow {
                    atoms: atoms("origin", "", ""),
                    status: None,
                    landed: vec![],
                },
            ),
            // current creates the same-named branch.
            (
                "c-current",
                vec![(pd, "current")],
                false,
                PushRow {
                    atoms: atoms("origin", "", "refs/remotes/origin/feat/y"),
                    status: o("origin:feat/y"),
                    landed: vec![s("origin:feat/y")],
                },
            ),
            (
                "d-upstream",
                vec![(pd, "upstream")],
                false,
                PushRow {
                    atoms: atoms("origin", "", "refs/remotes/origin/feat/x"),
                    status: o("origin:feat/x"),
                    landed: vec![s("origin:feat/x")],
                },
            ),
            // matching resolves %(push) like current but only updates branches both
            // ends have: nothing is created, so the status read claims nothing.
            (
                "e-matching",
                vec![(pd, "matching")],
                false,
                PushRow {
                    atoms: atoms("origin", "", "refs/remotes/origin/feat/y"),
                    status: None,
                    landed: vec![],
                },
            ),
            (
                "f-nothing",
                vec![(pd, "nothing")],
                false,
                PushRow {
                    atoms: atoms("origin", "", ""),
                    status: None,
                    landed: vec![],
                },
            ),
            // simple off the upstream's remote acts as current, which %(push) does
            // not resolve; the status read derives it from the push config it lists.
            (
                "g-push-remote",
                vec![(pd, "simple"), (push_remote, "second")],
                false,
                PushRow {
                    atoms: atoms("second", "", ""),
                    status: o("second:feat/y"),
                    landed: vec![s("second:feat/y")],
                },
            ),
            (
                "h-remote-push-default",
                vec![(pd, "simple"), (remote_pd, "second")],
                false,
                PushRow {
                    atoms: atoms("second", "", ""),
                    status: o("second:feat/y"),
                    landed: vec![s("second:feat/y")],
                },
            ),
            // A push remote with its own push refspecs: git pushes them all as
            // configured, which no single destination describes, so none is claimed.
            (
                "i-push-refspec",
                vec![
                    (pd, "simple"),
                    (origin_push, "refs/heads/feat/y:refs/heads/pushed/y"),
                ],
                false,
                PushRow {
                    atoms: atoms(
                        "origin",
                        "refs/heads/pushed/y",
                        "refs/remotes/origin/pushed/y",
                    ),
                    status: None,
                    landed: vec![s("origin:pushed/y")],
                },
            ),
            // A single-branch fetch refspec maps no tracking ref for the upstream or
            // the destination: nothing resolves (the accepted gap), and current still
            // creates the branch.
            (
                "j-narrow-fetch",
                vec![
                    (pd, "current"),
                    (
                        "remote.origin.fetch",
                        "+refs/heads/main:refs/remotes/origin/main",
                    ),
                ],
                false,
                PushRow {
                    atoms: atoms("origin", "", ""),
                    status: None,
                    landed: vec![s("origin:feat/y")],
                },
            ),
            // A remapped fetch refspec: `team/feat/y` is the tracking name, never the
            // branch, so the destination stays unresolved rather than wrong.
            (
                "k-remapped-current",
                vec![(pd, "current"), remap],
                true,
                PushRow {
                    atoms: atoms("origin", "", "refs/remotes/origin/team/feat/y"),
                    status: None,
                    landed: vec![s("origin:feat/y")],
                },
            ),
            // Remapped, but the destination IS the upstream: read back through it.
            (
                "l-remapped-upstream",
                vec![(pd, "upstream"), remap],
                true,
                PushRow {
                    atoms: atoms("origin", "", "refs/remotes/origin/team/feat/x"),
                    status: o("origin:feat/x"),
                    landed: vec![s("origin:feat/x")],
                },
            ),
            // upstream mode pushing to a remote other than the upstream's: git
            // refuses, and the upstream's tracking ref names no destination there.
            (
                "m-upstream-triangular",
                vec![(pd, "upstream"), (push_remote, "second")],
                false,
                PushRow {
                    atoms: atoms("second", "", "refs/remotes/origin/feat/x"),
                    status: None,
                    landed: vec![],
                },
            ),
            // Rows on a SAME-name branch (`feat/x` tracking origin/feat/x): the everyday push
            // lands on its own upstream, which the push flow takes without a read.
            (
                "n-same-everyday",
                vec![],
                false,
                PushRow {
                    atoms: atoms("origin", "", "refs/remotes/origin/feat/x"),
                    status: o("origin:feat/x"),
                    landed: vec![s("origin:feat/x")],
                },
            ),
            // The fork workflow: simple to another remote lands the branch there.
            (
                "o-same-push-default",
                vec![(pd, "simple"), (remote_pd, "second")],
                false,
                PushRow {
                    atoms: atoms("second", "", ""),
                    status: o("second:feat/x"),
                    landed: vec![s("second:feat/x")],
                },
            ),
            // matching to a remote that lacks the branch creates nothing.
            (
                "p-same-push-remote-matching",
                vec![(pd, "matching"), (push_remote_x, "second")],
                false,
                PushRow {
                    atoms: atoms("second", "", "refs/remotes/second/feat/x"),
                    status: None,
                    landed: vec![],
                },
            ),
            (
                "t-push-list-two",
                vec![
                    (pd, "simple"),
                    (origin_push, "refs/heads/main:refs/heads/main"),
                    (origin_push, "refs/heads/feat/y:refs/heads/pushed/y"),
                ],
                false,
                PushRow {
                    atoms: atoms(
                        "origin",
                        "refs/heads/pushed/y",
                        "refs/remotes/origin/pushed/y",
                    ),
                    status: None,
                    landed: vec![s("origin:pushed/y")],
                },
            ),
            (
                "u-push-wildcard",
                vec![
                    (pd, "simple"),
                    (origin_push, "refs/heads/*:refs/heads/published/*"),
                ],
                false,
                PushRow {
                    atoms: atoms(
                        "origin",
                        "refs/heads/published/feat/y",
                        "refs/remotes/origin/published/feat/y",
                    ),
                    status: None,
                    landed: vec![s("origin:published/feat/y"), s("origin:published/main")],
                },
            ),
            // A push refspec that maps another branch leaves this one with no
            // destination at all.
            (
                "v-push-refspec-unmapped",
                vec![
                    (pd, "simple"),
                    (origin_push, "refs/heads/main:refs/heads/main"),
                ],
                false,
                PushRow {
                    atoms: atoms("origin", "", ""),
                    status: None,
                    landed: vec![],
                },
            ),
            // Rows on a LOCAL upstream (`feat/y` tracking `main` here, remote `.`) with
            // origin as its push remote: the same triangular shape as any other.
            (
                "w-local-matching",
                vec![(pd, "matching"), (push_remote, "origin")],
                false,
                PushRow {
                    atoms: atoms("origin", "", "refs/remotes/origin/feat/y"),
                    status: None,
                    landed: vec![],
                },
            ),
            (
                "x-local-simple",
                vec![(pd, "simple"), (push_remote, "origin")],
                false,
                PushRow {
                    atoms: atoms("origin", "", ""),
                    status: o("origin:feat/y"),
                    landed: vec![s("origin:feat/y")],
                },
            ),
            (
                "y-local-current",
                vec![(pd, "current"), (push_remote, "origin")],
                false,
                PushRow {
                    atoms: atoms("origin", "", "refs/remotes/origin/feat/y"),
                    status: o("origin:feat/y"),
                    landed: vec![s("origin:feat/y")],
                },
            ),
            // A mirror push remote: git's bare push mirrors every ref there (deleting
            // what the clone lacks), and git refuses the app's explicit push to it
            // (`an_explicit_push_to_a_mirror_remote_is_refused`), so none is claimed on
            // either config path.
            (
                "q-mirror-triangular-simple",
                vec![
                    (pd, "simple"),
                    (push_remote, "second"),
                    (second_mirror, "true"),
                ],
                false,
                PushRow {
                    atoms: atoms("second", "", "refs/remotes/second/feat/y"),
                    status: None,
                    landed: vec![s("second:feat/y")],
                },
            ),
            (
                "r-mirror-current",
                vec![
                    (pd, "current"),
                    (push_remote, "second"),
                    (second_mirror, "true"),
                ],
                false,
                PushRow {
                    atoms: atoms("second", "", "refs/remotes/second/feat/y"),
                    status: None,
                    landed: vec![s("second:feat/y")],
                },
            ),
            (
                "s-mirror-valueless",
                vec![
                    (pd, "simple"),
                    (push_remote, "second"),
                    (second_mirror, VALUELESS),
                ],
                false,
                PushRow {
                    atoms: atoms("second", "", "refs/remotes/second/feat/y"),
                    status: None,
                    landed: vec![s("second:feat/y")],
                },
            ),
            // The upstream's own remote as a mirror, off the upstream's name: the
            // atoms differ from the upstream, so the config is read and clears them.
            (
                "z-mirror-upstream-remote",
                vec![(origin_mirror, "true")],
                false,
                PushRow {
                    atoms: atoms("origin", "", "refs/remotes/origin/feat/y"),
                    status: None,
                    landed: vec![s("origin:feat/y"), s("origin:feat/x deleted")],
                },
            ),
            // The same, on a same-named branch: the atoms are the live upstream, so no
            // config is read and the claim is the upstream itself.
            (
                "za-same-mirror-upstream",
                vec![(origin_mirror, "true")],
                false,
                PushRow {
                    atoms: atoms("origin", "", "refs/remotes/origin/feat/x"),
                    status: o("origin:feat/x"),
                    landed: vec![s("origin:feat/x")],
                },
            ),
        ];
        let mut measured = 0;
        for (tag, config, refetch, want) in rows {
            let work = renamed_branch_fixture(&base, tag).await;
            let (local, refname) = if tag.contains("-same-") {
                ("feat/x", "refs/heads/feat/x")
            } else {
                ("feat/y", "refs/heads/feat/y")
            };
            if local != "feat/y" {
                git(&work, &["branch", "-m", "feat/y", local]).await;
            }
            if tag.contains("-local-") {
                git(&work, &["branch", "-q", "--set-upstream-to=main", local]).await;
            }
            // A row's own local value outranks a global one for a single-valued key,
            // but push refspecs are multi-valued: a global entry would add to the
            // row's, so those are checked unset whether or not the row writes them.
            let written: Vec<&str> = config.iter().map(|(k, _)| *k).collect();
            let multi_valued = [origin_push, second_push];
            let unset: Vec<&str> = all
                .iter()
                .copied()
                .filter(|k| !written.contains(k) || multi_valued.contains(k))
                .collect();
            if !all_unset(&work, &format!("row {tag}"), &unset).await {
                continue;
            }
            // A key repeated in a row is multi-valued: its later values are added.
            for (i, (key, value)) in config.iter().enumerate() {
                if *value == VALUELESS {
                    let (section, var) = key.rsplit_once('.').unwrap();
                    let (section, sub) = section.split_once('.').unwrap();
                    let file = std::path::Path::new(&work).join(".git").join("config");
                    let mut text = std::fs::read_to_string(&file).unwrap();
                    text.push_str(&format!("[{section} \"{sub}\"]\n\t{var}\n"));
                    std::fs::write(&file, text).unwrap();
                } else if config[..i].iter().any(|(k, _)| k == key) {
                    git(&work, &["config", "--add", key, value]).await;
                } else {
                    git(&work, &["config", key, value]).await;
                }
            }
            if refetch {
                git(&work, &["fetch", "-q", "origin"]).await;
            }
            let raw = git(
                &work,
                &[
                    "for-each-ref",
                    refname,
                    "--format=%(push:remotename)%00%(push:remoteref)%00%(push)",
                ],
            )
            .await;
            let mut fields = raw.trim_end_matches(['\r', '\n']).split('\0').map(s);
            let atoms = [(); 3].map(|()| fields.next().unwrap_or_default());
            let head = status_core(&work).await.unwrap().branch;
            let got = PushRow {
                atoms,
                status: joined(&head.push_remote, &head.push_branch),
                landed: bare_push_landing(&work, &base.join(tag)).await,
            };
            eprintln!("measured {tag}: {got:?}");
            // The invariant first: a claimed destination is exactly where it landed.
            if let Some(dest) = &got.status {
                assert_eq!(
                    got.landed.as_slice(),
                    std::slice::from_ref(dest),
                    "row {tag}: claimed vs landed"
                );
            }
            // Negative control, on the first fully measured row: the comparison has
            // to reject a landing it was not shown.
            if measured == 0 {
                let wrong = PushRow {
                    atoms: got.atoms.clone(),
                    status: got.status.clone(),
                    landed: vec![s("origin:never")],
                };
                assert!(
                    check_row(tag, &got, &wrong).is_err(),
                    "the harness accepted a wrong landing"
                );
            }
            check_row(tag, &got, &want).unwrap();
            measured += 1;
        }
        if measured == 0 {
            eprintln!("skipping the push destination matrix: every row met leaked config");
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

    /// `pr-7` tracking a fetch-mapped `refs/pull/7/head` on origin, one commit ahead of
    /// it, in a fresh [`renamed_branch_fixture`] under `base/<tag>`. Returns the clone.
    async fn pull_request_branch_fixture(base: &std::path::Path, tag: &str) -> String {
        let work = renamed_branch_fixture(base, tag).await;
        let origin = base
            .join(tag)
            .join("origin.git")
            .to_string_lossy()
            .into_owned();
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
        work
    }

    /// Destinations other than a live upstream, measured against a real push: a
    /// pull-request upstream and a gone one. `matching` resolves `%(push)` like `current`
    /// yet creates nothing, so the status read claims a destination only where the push
    /// landed (`push_destination_matrix`'s rule).
    #[tokio::test]
    async fn push_destination_off_upstream_rows() {
        let (_guard, base) = temp_base("push-off-up");
        // (row tag, push.default, gone same-name branch rather than pr-7, expected
        // status destination, expected landing)
        type Row<'a> = (&'a str, &'a str, bool, Option<&'a str>, &'a [&'a str]);
        let rows: [Row<'_>; 4] = [
            ("pr-matching", "matching", false, None, &[]),
            (
                "pr-current",
                "current",
                false,
                Some("origin:pr-7"),
                &["origin:pr-7"],
            ),
            ("gone-matching", "matching", true, None, &[]),
            (
                "gone-current",
                "current",
                true,
                Some("origin:feat/x"),
                &["origin:feat/x"],
            ),
        ];
        let mut measured = 0;
        for (tag, mode, gone, want_status, want_landed) in rows {
            let (work, local) = if gone {
                let work = renamed_branch_fixture(&base, tag).await;
                git(&work, &["branch", "-m", "feat/y", "feat/x"]).await;
                let origin = base
                    .join(tag)
                    .join("origin.git")
                    .to_string_lossy()
                    .into_owned();
                git(&origin, &["update-ref", "-d", "refs/heads/feat/x"]).await;
                git(&work, &["fetch", "-q", "--prune", "origin"]).await;
                (work, "feat/x")
            } else {
                (pull_request_branch_fixture(&base, tag).await, "pr-7")
            };
            // Pinned locally, so a global value can't reach them: the mode, and the
            // push remote (the upstream's own, which outranks a global
            // remote.pushDefault without changing the shape under test). Push
            // refspecs are multi-valued, so a global one can only be skipped.
            if !all_unset(&work, &format!("row {tag}"), &["remote.origin.push"]).await {
                continue;
            }
            git(&work, &["config", "push.default", mode]).await;
            let push_remote = format!("branch.{local}.pushRemote");
            git(&work, &["config", &push_remote, "origin"]).await;
            let head = status_core(&work).await.unwrap().branch;
            assert_eq!(head.upstream_gone, gone, "row {tag}");
            let status = joined(&head.push_remote, &head.push_branch);
            let landed = bare_push_landing(&work, &base.join(tag)).await;
            eprintln!("measured {tag}: status {status:?}, landed {landed:?}");
            assert_eq!(status.as_deref(), want_status, "row {tag}: status");
            assert_eq!(landed, want_landed, "row {tag}: landed");
            if let Some(dest) = &status {
                assert_eq!(landed.as_slice(), std::slice::from_ref(dest), "row {tag}");
            }
            measured += 1;
        }
        if measured == 0 {
            eprintln!("skipping the off-upstream rows: every row met leaked config");
        }
    }

    /// What git does with the app's explicit push (a named destination refspec, with and
    /// without `-u`) to a mirror remote: it refuses outright, landing nothing, which is
    /// why a mirror push remote stays unresolved. A `false` mirror is the control.
    #[tokio::test]
    async fn an_explicit_push_to_a_mirror_remote_is_refused() {
        let (_guard, base) = temp_base("push-mirror");
        let explicit: &[&str] = &["push", "second", "refs/heads/feat/y:refs/heads/feat/y"];
        let with_u: &[&str] = &[
            "push",
            "-u",
            "second",
            "refs/heads/feat/y:refs/heads/feat/y",
        ];
        // (row tag, remote.second.mirror, push argv, whether git refuses it)
        let rows = [
            ("explicit", "true", explicit, true),
            ("explicit-u", "true", with_u, true),
            ("explicit-not-mirror", "false", explicit, false),
        ];
        let mut measured = 0;
        for (tag, mirror, args, refused) in rows {
            let work = renamed_branch_fixture(&base, tag).await;
            if !all_unset(&work, &format!("row {tag}"), &["remote.second.push"]).await {
                continue;
            }
            git(&work, &["config", "remote.second.mirror", mirror]).await;
            let ((code, stderr), landed) = push_landing(&work, &base.join(tag), args).await;
            eprintln!("measured {tag}: exit {code}, landed {landed:?}, stderr {stderr:?}");
            if refused {
                assert_ne!(code, 0, "row {tag}");
                assert!(
                    stderr.contains("--mirror can't be combined with refspecs"),
                    "row {tag}: {stderr}"
                );
                assert!(landed.is_empty(), "row {tag}: {landed:?}");
            } else {
                assert_eq!(code, 0, "row {tag}: {stderr}");
                assert_eq!(landed, ["second:feat/y"], "row {tag}");
            }
            measured += 1;
        }
        if measured == 0 {
            eprintln!("skipping the mirror push rows: every row met leaked config");
        }
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
