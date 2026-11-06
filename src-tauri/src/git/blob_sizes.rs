use crate::error::{AppError, AppResult};
#[cfg(windows)]
use crate::git::diff::NO_VERBATIM_FORM;
use crate::git::diff::{is_repo_relative, worktree_entry, WorktreeEntry};
use crate::git::ops::{discard_rel_path, discard_shown};
use crate::git::runner::{run_git_raw_input_env, DEFAULT_TIMEOUT};

// A full id in a partial clone otherwise fetches from the promisor inside a read.
// Honoured from git 2.45.0 and in the 2.39.4+ security releases of older tracks;
// 2.44.0 and unpatched older releases ignore it, so a read there can still fetch.
const NO_LAZY_FETCH: [(&str, &str); 1] = [("GIT_NO_LAZY_FETCH", "1")];

const UNKNOWN: BlobSizes = BlobSizes {
    old_size: None,
    new_size: None,
};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobSizes {
    pub old_size: Option<u64>,
    pub new_size: Option<u64>,
}

fn is_hex(id: &str) -> bool {
    id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn invalid_id(raw: &str) -> AppError {
    let shown = if raw.is_empty() {
        "an empty id".to_string()
    } else {
        discard_shown(raw)
    };
    AppError::InvalidArgument(format!("invalid object id: {shown}"))
}

/// A side's id as the `index` line spells it: 4..=64 hex, lowercased; `None` when
/// absent or all-zero.
pub(crate) fn side_id(raw: Option<String>) -> AppResult<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if !(4..=64).contains(&raw.len()) || !is_hex(&raw) {
        return Err(invalid_id(&raw));
    }
    let id = raw.to_ascii_lowercase();
    Ok((!id.bytes().all(|b| b == b'0')).then_some(id))
}

fn anchor_id(raw: &str) -> AppResult<String> {
    if !matches!(raw.len(), 40 | 64) || !is_hex(raw) {
        return Err(invalid_id(raw));
    }
    Ok(raw.to_ascii_lowercase())
}

/// One `--batch-check` answer: the size only when git named a full id extending
/// `input` with the expected type. git truncates an overlong input to its hash
/// width, so the prefix check is what refuses a 41..64-hex spelling.
fn batch_size(line: &str, input: &str, expected: &str) -> Option<u64> {
    let mut tokens = line.split_whitespace();
    let (Some(id), Some(kind), Some(size), None) =
        (tokens.next(), tokens.next(), tokens.next(), tokens.next())
    else {
        return None;
    };
    if !matches!(id.len(), 40 | 64) || !is_hex(id) || !id.starts_with(input) || kind != expected {
        return None;
    }
    size.parse().ok()
}

/// Whether `check-attr -z filter working-tree-encoding` leaves the worktree bytes
/// possibly the blob's: both attributes unspecified or unset. Any other answer (set,
/// or set to a value) is "no", which skips hashing a filtered file such as an LFS
/// object.
fn attrs_leave_bytes_alone(stdout: &[u8]) -> bool {
    let text = String::from_utf8_lossy(stdout);
    let fields: Vec<&str> = text.split('\0').collect();
    let [_, filter, filter_value, _, encoding, encoding_value, ""] = fields.as_slice() else {
        return false;
    };
    *filter == "filter"
        && *encoding == "working-tree-encoding"
        && [filter_value, encoding_value]
            .iter()
            .all(|v| matches!(**v, "unspecified" | "unset"))
}

/// Whether the file's bytes, hashed with no conversion, are the blob `new_id` names.
/// The diff's id hashes the CLEANED content, so a match means no autocrlf, eol,
/// `ident` or other conversion changed a byte, and a file edited since fails it.
async fn bytes_are_the_blob(repo: &str, rel: &str, new_id: &str) -> AppResult<bool> {
    let out = run_git_raw_input_env(
        Some(repo),
        &["hash-object", "--no-filters", "--", rel],
        None,
        &NO_LAZY_FETCH,
        DEFAULT_TIMEOUT,
    )
    .await?;
    // git reads the plain spelling: a file it can't open (a reserved device name on
    // Windows, one deleted since the stat) has no hash to compare, so it stays unknown.
    if out.code != 0 {
        return Ok(false);
    }
    let text = out.stdout_lossy();
    let id = text.trim();
    Ok(matches!(id.len(), 40 | 64) && is_hex(id) && id.starts_with(new_id))
}

/// A regular file's length and modified time, as one stat reads them.
type FileStamp = (u64, std::time::SystemTime);

/// Stamps the file at `path` without following a link; anything but a regular
/// file with a readable modified time has none.
fn file_stamp(path: &std::path::Path) -> Option<FileStamp> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some((meta.len(), meta.modified().ok()?))
}

/// `worktree_entry` plus a stamp of the regular file it names, read from the same
/// verbatim spelling; no stamp when that stat disagrees with the entry's length.
fn stamped_entry(repo: &str, rel: &str) -> AppResult<(WorktreeEntry, Option<FileStamp>)> {
    let entry = worktree_entry(repo, rel)?;
    let stamp = match &entry {
        WorktreeEntry::Regular { path, len } => file_stamp(path).filter(|s| s.0 == *len),
        _ => None,
    };
    Ok((entry, stamp))
}

async fn stamped_entry_blocking(
    repo: &str,
    rel: &str,
) -> AppResult<(WorktreeEntry, Option<FileStamp>)> {
    let (owned_repo, target) = (repo.to_string(), rel.to_string());
    tokio::task::spawn_blocking(move || stamped_entry(&owned_repo, &target))
        .await
        .map_err(|e| AppError::Command(e.to_string()))?
}

/// The length a matched hash answers with: the first stat's, only when a stat
/// after the hash finds the same regular file, length and modified time. The hash
/// re-opens the path, so a file rewritten between the two would otherwise pair one
/// content's hash with another's length.
fn settled_len(before: Option<FileStamp>, after: Option<FileStamp>) -> Option<u64> {
    match (before, after) {
        (Some(b), Some(a)) if a == b => Some(b.0),
        _ => None,
    }
}

async fn worktree_size(repo: &str, rel: String, new_id: &str) -> AppResult<Option<u64>> {
    let attrs = run_git_raw_input_env(
        Some(repo),
        &[
            "check-attr",
            "-z",
            "filter",
            "working-tree-encoding",
            "--",
            &rel,
        ],
        None,
        &NO_LAZY_FETCH,
        DEFAULT_TIMEOUT,
    )
    .await?
    .exit_verdict()?;
    if !attrs_leave_bytes_alone(&attrs.stdout) {
        return Ok(None);
    }
    let (entry, before) = stamped_entry_blocking(repo, &rel).await?;
    match entry {
        WorktreeEntry::Regular { .. } => {
            if !bytes_are_the_blob(repo, &rel, new_id).await? {
                return Ok(None);
            }
            // A failed re-stat leaves the size unknown, never fails the whole read.
            let after = stamped_entry_blocking(repo, &rel)
                .await
                .ok()
                .and_then(|(_, stamp)| stamp);
            Ok(settled_len(before, after))
        }
        WorktreeEntry::Absent | WorktreeEntry::Linked | WorktreeEntry::NotRegular => Ok(None),
        #[cfg(windows)]
        WorktreeEntry::NoVerbatim => Err(AppError::InvalidArgument(format!(
            "Can't size {} — {NO_VERBATIM_FORM}.",
            discard_shown(&rel)
        ))),
    }
}

/// Byte sizes of a binary diff section's sides, from the ids on its `index` line
/// (a null id = that side is absent). `None` is unknown, never a claim of absence.
/// `worktree_file` sizes the new side from that file on disk, answering only while
/// its raw bytes hash to `new_oid` (no id, no answer) and a stat after the hash
/// still finds the same length and modified time; the blob is never read.
/// `anchor_commit` is the full commit a PR surface shows; every lookup answers
/// only when it is a local commit in a full clone. Shallow and partial clones
/// cannot prove that forge-abbreviated blob ids name the intended objects.
#[tauri::command]
pub async fn git_blob_sizes(
    repo_path: String,
    old_oid: Option<String>,
    new_oid: Option<String>,
    worktree_file: Option<String>,
    anchor_commit: Option<String>,
) -> AppResult<BlobSizes> {
    let old = side_id(old_oid)?;
    let new = side_id(new_oid)?;
    let anchor = anchor_commit.as_deref().map(anchor_id).transpose()?;
    let worktree = match worktree_file {
        Some(raw) => {
            if !is_repo_relative(&raw) {
                return Err(AppError::InvalidArgument(format!(
                    "invalid path: {}",
                    discard_shown(&raw)
                )));
            }
            let rel = discard_rel_path(&raw).map_err(|why| {
                AppError::InvalidArgument(format!("Can't size {} — {why}.", discard_shown(&raw)))
            })?;
            Some(rel)
        }
        None => None,
    };
    if old.is_none() && new.is_none() {
        return Ok(UNKNOWN);
    }
    // No real commit is all-zero, so such an anchor withholds both sizes rather
    // than dropping the gate.
    if anchor
        .as_deref()
        .is_some_and(|id| id.bytes().all(|b| b == b'0'))
    {
        return Ok(UNKNOWN);
    }
    if anchor.is_some() && incomplete_clone(&repo_path).await? {
        return Ok(UNKNOWN);
    }
    let (new, worktree) = match worktree {
        Some(rel) => (None, new.map(|id| (rel, id))),
        None => (new, None),
    };

    let queries: Vec<(&str, &str)> = [
        old.as_deref().map(|id| (id, "blob")),
        new.as_deref().map(|id| (id, "blob")),
        anchor.as_deref().map(|id| (id, "commit")),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut answers = if queries.is_empty() {
        Vec::new()
    } else {
        let input: String = queries.iter().map(|(id, _)| format!("{id}\n")).collect();
        let out = run_git_raw_input_env(
            Some(&repo_path),
            &[
                "cat-file",
                "--batch-check=%(objectname) %(objecttype) %(objectsize)",
            ],
            Some(&input),
            &NO_LAZY_FETCH,
            DEFAULT_TIMEOUT,
        )
        .await?
        .exit_verdict()?;
        let text = out.stdout_lossy();
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() == queries.len() {
            lines
                .iter()
                .zip(&queries)
                .map(|(line, (id, kind))| batch_size(line, id, kind))
                .collect()
        } else {
            vec![None; queries.len()]
        }
    }
    .into_iter();
    let old_size = old.and_then(|_| answers.next().flatten());
    let mut new_size = new.and_then(|_| answers.next().flatten());
    if anchor.is_some() && answers.next().flatten().is_none() {
        return Ok(UNKNOWN);
    }
    if let Some((rel, id)) = worktree {
        new_size = worktree_size(&repo_path, rel, &id).await?;
    }
    Ok(BlobSizes { old_size, new_size })
}

// Abbreviated forge ids cannot be proven in shallow or partial clones.
async fn incomplete_clone(repo: &str) -> AppResult<bool> {
    let shallow = run_git_raw_input_env(
        Some(repo),
        &["rev-parse", "--is-shallow-repository"],
        None,
        &NO_LAZY_FETCH,
        DEFAULT_TIMEOUT,
    )
    .await?
    .exit_verdict()?;
    let partial = run_git_raw_input_env(
        Some(repo),
        &[
            "config",
            "--get-regexp",
            "^(remote\\..*\\.promisor|extensions\\.partialclone)$",
        ],
        None,
        &NO_LAZY_FETCH,
        DEFAULT_TIMEOUT,
    )
    .await?;
    let is_partial = match partial.code {
        0 => !partial.stdout.is_empty(),
        1 if partial.stdout.is_empty() => false,
        _ => return partial.exit_verdict().map(|_| false),
    };
    Ok(shallow.stdout_lossy().trim() == "true" || is_partial)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::runner::{run_git, run_git_input, run_git_raw, run_git_raw_input};
    use std::path::Path;

    const BOGUS: &str = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    async fn git(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
            .trim()
            .to_string()
    }

    /// Pins what a developer's global config would otherwise leak into the run.
    async fn pin_config(repo: &str) {
        for (key, value) in [
            ("user.email", "t@t"),
            ("user.name", "t"),
            ("commit.gpgSign", "false"),
            ("core.abbrev", "7"),
            ("core.autocrlf", "false"),
            ("core.attributesFile", ""),
        ] {
            git(repo, &["config", key, value]).await;
        }
        let info = Path::new(repo).join(".git").join("info");
        std::fs::create_dir_all(&info).unwrap();
        std::fs::write(info.join("attributes"), "").unwrap();
    }

    async fn init_repo(dir: &Path, extra: &[&str]) -> Option<String> {
        let repo = dir.to_string_lossy().into_owned();
        let mut args = vec!["init", "-q"];
        args.extend_from_slice(extra);
        let init = run_git_raw(Some(&repo), &args, DEFAULT_TIMEOUT)
            .await
            .unwrap();
        if init.code != 0 {
            eprintln!(
                "SKIPPED: this git can't init {extra:?} ({})",
                init.stderr.trim()
            );
            return None;
        }
        pin_config(&repo).await;
        Some(repo)
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        repo: String,
        small: String,
        mid: String,
        large: String,
        empty: String,
        commit: String,
        tree: String,
    }

    /// Binary blobs of 3, 7 and 11 bytes plus an empty one, committed.
    async fn fixture(extra: &[&str]) -> Option<Fixture> {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path(), extra).await?;
        for (name, bytes) in [
            ("small.bin", &b"\0ab"[..]),
            ("mid.bin", &b"\0abcdef"[..]),
            ("large.bin", &b"\0abcdefghij"[..]),
            ("empty.bin", &b""[..]),
        ] {
            std::fs::write(dir.path().join(name), bytes).unwrap();
        }
        git(&repo, &["add", "-A"]).await;
        git(&repo, &["commit", "-q", "-m", "blobs"]).await;
        let id = |spec: &'static str| {
            let repo = repo.clone();
            async move { git(&repo, &["rev-parse", spec]).await }
        };
        Some(Fixture {
            small: id("HEAD:small.bin").await,
            mid: id("HEAD:mid.bin").await,
            large: id("HEAD:large.bin").await,
            empty: id("HEAD:empty.bin").await,
            commit: id("HEAD").await,
            tree: id("HEAD^{tree}").await,
            repo,
            _dir: dir,
        })
    }

    async fn sizes(
        repo: &str,
        old: Option<&str>,
        new: Option<&str>,
        worktree: Option<&str>,
        anchor: Option<&str>,
    ) -> AppResult<(Option<u64>, Option<u64>)> {
        git_blob_sizes(
            repo.to_string(),
            old.map(str::to_string),
            new.map(str::to_string),
            worktree.map(str::to_string),
            anchor.map(str::to_string),
        )
        .await
        .map(|s| (s.old_size, s.new_size))
    }

    /// The id of `path`'s bytes exactly as they sit on disk.
    async fn raw_id(repo: &str, path: &str) -> String {
        git(repo, &["hash-object", "--no-filters", "--", path]).await
    }

    /// A repo path that does not exist: any spawn or stat against it fails, so an Ok
    /// or an InvalidArgument from it proves none ran.
    fn nowhere() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").to_string_lossy().into_owned();
        (dir, path)
    }

    #[tokio::test]
    async fn sizes_answer_for_full_short_and_any_case_ids() {
        let f = fixture(&[]).await.unwrap();
        assert_eq!(f.small.len(), 40);
        let short = &f.small[..7];
        let four = &f.mid[..4];
        let found = git(&f.repo, &["rev-parse", &format!("--disambiguate={four}")]).await;
        assert_eq!(
            found.lines().count(),
            1,
            "{four} must be unique here: {found}"
        );
        for (old, new) in [
            (f.small.clone(), f.mid.clone()),
            (short.to_string(), four.to_string()),
            (
                f.small.to_ascii_uppercase(),
                f.mid[..7].to_ascii_uppercase(),
            ),
        ] {
            assert_eq!(
                sizes(&f.repo, Some(&old), Some(&new), None, None)
                    .await
                    .unwrap(),
                (Some(3), Some(7)),
                "{old} {new}"
            );
        }
        assert_eq!(
            sizes(&f.repo, Some(&f.large), Some(&f.empty), None, None)
                .await
                .unwrap(),
            (Some(11), Some(0))
        );
    }

    #[tokio::test]
    async fn sizes_answer_in_a_sha256_repository() {
        let Some(f) = fixture(&["--object-format=sha256"]).await else {
            eprintln!("SKIPPED sizes_answer_in_a_sha256_repository: no sha256 support");
            return;
        };
        assert_eq!(f.small.len(), 64);
        for old in [f.small.as_str(), &f.small[..7]] {
            assert_eq!(
                sizes(&f.repo, Some(old), Some(&f.large[..7]), None, None)
                    .await
                    .unwrap(),
                (Some(3), Some(11))
            );
        }
    }

    #[tokio::test]
    async fn ids_outside_four_to_sixty_four_hex_are_refused_before_any_spawn() {
        let (_dir, repo) = nowhere();
        let long = "a".repeat(65);
        for bad in [
            "",
            "abc",
            "zzzz",
            "-abcd",
            "abcd\n",
            "ab cd",
            "HEAD",
            long.as_str(),
        ] {
            for (old, new) in [(Some(bad), None), (None, Some(bad))] {
                let err = sizes(&repo, old, new, None, None).await.unwrap_err();
                assert!(
                    matches!(&err, AppError::InvalidArgument(m) if m.starts_with("invalid object id: ")),
                    "{bad:?}: {err:?}"
                );
            }
        }
        let err = sizes(&repo, Some(""), None, None, None).await.unwrap_err();
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m == "invalid object id: an empty id"),
            "{err:?}"
        );
        for anchor in ["abcdef1", &"a".repeat(41)] {
            let err = sizes(&repo, Some("abcd"), None, None, Some(anchor))
                .await
                .unwrap_err();
            assert!(
                matches!(err, AppError::InvalidArgument(_)),
                "{anchor}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_side_naming_no_single_blob_is_none_while_the_other_side_answers() {
        let f = fixture(&[]).await.unwrap();
        let truncated = format!("{}0", f.small);
        for bad in [BOGUS, "deadbee", f.commit.as_str(), &f.tree, &truncated] {
            assert_eq!(
                sizes(&f.repo, Some(bad), Some(&f.mid), None, None)
                    .await
                    .unwrap(),
                (None, Some(7)),
                "old {bad}"
            );
            assert_eq!(
                sizes(&f.repo, Some(&f.large), Some(bad), None, None)
                    .await
                    .unwrap(),
                (Some(11), None),
                "new {bad}"
            );
        }

        // 1000 small blobs give 4-hex collisions; the groups are found at runtime.
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path(), &[]).await.unwrap();
        let stream: String = (1..=1000)
            .map(|i| {
                let data = format!("f{i}\n");
                format!("blob\nmark :{i}\ndata {}\n{data}\n", data.len())
            })
            .collect();
        run_git_input(
            Some(&repo),
            &["fast-import", "--quiet"],
            Some(&stream),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        let listing = git(
            &repo,
            &[
                "cat-file",
                "--batch-all-objects",
                "--batch-check=%(objectname)",
            ],
        )
        .await;
        let mut by_prefix = std::collections::BTreeMap::<&str, Vec<&str>>::new();
        for id in listing.lines() {
            by_prefix.entry(&id[..4]).or_default().push(id);
        }
        let (prefix, group) = by_prefix
            .iter()
            .find(|(_, ids)| ids.len() >= 2)
            .expect("at least one colliding 4-hex blob group");
        assert_eq!(
            sizes(&repo, Some(prefix), Some(group[0]), None, None)
                .await
                .unwrap()
                .0,
            None
        );
        assert!(sizes(&repo, Some(prefix), Some(group[0]), None, None)
            .await
            .unwrap()
            .1
            .is_some());
    }

    #[tokio::test]
    async fn all_zero_sides_are_absent_and_skip_the_spawn() {
        let f = fixture(&[]).await.unwrap();
        let zero = "0".repeat(40);
        assert_eq!(
            sizes(&f.repo, Some(&zero[..7]), Some(&f.mid), None, None)
                .await
                .unwrap(),
            (None, Some(7))
        );
        let (_dir, nowhere) = nowhere();
        assert_eq!(
            sizes(&nowhere, Some(&zero), Some(&zero[..7]), None, None)
                .await
                .unwrap(),
            (None, None)
        );
        assert_eq!(
            sizes(&nowhere, None, None, None, None).await.unwrap(),
            (None, None)
        );
        for (old, new) in [(None, None), (Some(zero.as_str()), Some(&zero[..7]))] {
            assert_eq!(
                sizes(&nowhere, old, new, None, Some(BOGUS)).await.unwrap(),
                (None, None)
            );
        }
        assert!(matches!(
            sizes(&nowhere, Some("bad-id"), None, None, Some(BOGUS)).await,
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[tokio::test]
    async fn the_anchor_gates_every_lookup_on_a_local_commit() {
        let f = fixture(&[]).await.unwrap();
        std::fs::write(Path::new(&f.repo).join("wt.bin"), b"\0abcd").unwrap();
        let wt = raw_id(&f.repo, "wt.bin").await;
        assert_eq!(
            sizes(&f.repo, Some(&f.small), Some(&f.mid), None, Some(&f.commit))
                .await
                .unwrap(),
            (Some(3), Some(7))
        );
        assert_eq!(
            sizes(
                &f.repo,
                Some(&f.small),
                Some(&wt),
                Some("wt.bin"),
                Some(&f.commit)
            )
            .await
            .unwrap(),
            (Some(3), Some(5))
        );
        let zero = "0".repeat(40);
        for anchor in [BOGUS, f.small.as_str(), &f.tree, &zero] {
            for (new, worktree) in [(&f.mid, None), (&wt, Some("wt.bin"))] {
                assert_eq!(
                    sizes(&f.repo, Some(&f.small), Some(new), worktree, Some(anchor))
                        .await
                        .unwrap(),
                    (None, None),
                    "anchor {anchor} worktree {worktree:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn the_worktree_side_sizes_the_file_only_while_it_hashes_to_new_oid() {
        let f = fixture(&[]).await.unwrap();
        let dir = Path::new(&f.repo);
        std::fs::write(dir.join("wt.bin"), b"\0abcd").unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();
        let wt = raw_id(&f.repo, "wt.bin").await;
        for new in [wt.as_str(), &wt[..7], &wt.to_ascii_uppercase()] {
            assert_eq!(
                sizes(&f.repo, Some(&f.small), Some(new), Some("wt.bin"), None)
                    .await
                    .unwrap(),
                (Some(3), Some(5)),
                "{new}"
            );
        }
        // An id the bytes don't hash to (another blob's, or the file's before an
        // edit made since the diff) and a request with no id leave the side unknown.
        for new in [Some(BOGUS), Some(f.mid.as_str()), None, Some(wt.as_str())] {
            if new == Some(wt.as_str()) {
                std::fs::write(dir.join("wt.bin"), b"\0abce").unwrap();
            }
            assert_eq!(
                sizes(&f.repo, Some(&f.small), new, Some("wt.bin"), None)
                    .await
                    .unwrap(),
                (Some(3), None),
                "{new:?}"
            );
        }
        for absent in ["gone.bin", "sub", "sub/gone.bin"] {
            assert_eq!(
                sizes(&f.repo, Some(&f.small), Some(&f.mid), Some(absent), None)
                    .await
                    .unwrap(),
                (Some(3), None),
                "{absent}"
            );
        }
    }

    #[cfg(any(windows, unix))]
    fn directory_link(link: &Path, target: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let made = std::process::Command::new("cmd")
                .args([
                    "/C",
                    "mklink",
                    "/J",
                    &link.to_string_lossy(),
                    &target.to_string_lossy(),
                ])
                .output()
                .expect("run mklink");
            assert!(made.status.success(), "{made:?}");
        }
    }

    #[cfg(any(windows, unix))]
    #[tokio::test]
    async fn a_linked_ancestor_never_leaks_the_target_size() {
        let f = fixture(&[]).await.unwrap();
        let dir = Path::new(&f.repo);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("x.bin"), [7u8; 13]).unwrap();
        directory_link(&dir.join("linked"), outside.path());
        // The target's own id, so only the link refusal can withhold the size.
        let target = raw_id(&f.repo, &outside.path().join("x.bin").to_string_lossy()).await;
        assert_eq!(
            sizes(
                &f.repo,
                Some(&f.small),
                Some(&target),
                Some("linked/x.bin"),
                None
            )
            .await
            .unwrap(),
            (Some(3), None)
        );
        #[cfg(windows)]
        std::fs::remove_dir(dir.join("linked")).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(dir.join("linked")).unwrap();
        std::fs::create_dir(dir.join("linked")).unwrap();
        std::fs::write(dir.join("linked/x.bin"), b"\0abcd").unwrap();
        let plain = raw_id(&f.repo, "linked/x.bin").await;
        assert_eq!(
            sizes(&f.repo, None, Some(&plain), Some("linked/x.bin"), None)
                .await
                .unwrap(),
            (None, Some(5))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_leaf_symlink_never_leaks_the_target_size() {
        let f = fixture(&[]).await.unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("x.bin");
        std::fs::write(&target, [7u8; 13]).unwrap();
        std::os::unix::fs::symlink(&target, Path::new(&f.repo).join("leaf.bin")).unwrap();
        let id = raw_id(&f.repo, &target.to_string_lossy()).await;
        assert_eq!(
            sizes(&f.repo, None, Some(&id), Some("leaf.bin"), None)
                .await
                .unwrap(),
            (None, None)
        );
    }

    #[tokio::test]
    async fn worktree_paths_outside_the_tree_are_refused() {
        let f = fixture(&[]).await.unwrap();
        let absolute = std::env::temp_dir()
            .join("x.bin")
            .to_string_lossy()
            .into_owned();
        let mut refused = vec![
            ("../x.bin", "invalid path: "),
            ("sub/../../x.bin", "invalid path: "),
            (absolute.as_str(), "invalid path: "),
            (".git/config", "Can't size "),
        ];
        if cfg!(windows) {
            refused.extend([
                ("dir./x.bin", "Can't size "),
                (
                    "x.{0AFACED1-E828-11D1-9187-B532F1E9575D}/f.bin",
                    "Can't size ",
                ),
            ]);
        }
        for (raw, lead) in refused {
            let err = sizes(&f.repo, None, None, Some(raw), None)
                .await
                .unwrap_err();
            assert!(
                matches!(&err, AppError::InvalidArgument(m) if m.starts_with(lead)),
                "{raw}: {err:?}"
            );
        }
        let err = sizes(&f.repo, None, None, Some("../a\u{7}.bin"), None)
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m == "invalid path: ../a\u{fffd}.bin"),
            "{err:?}"
        );
    }

    /// A reserved device name stats as a plain file through the verbatim chain, and
    /// git can't open it to hash, so the device is never sized.
    #[tokio::test]
    async fn a_reserved_device_name_never_sizes_the_device() {
        let f = fixture(&[]).await.unwrap();
        let dir = Path::new(&f.repo);
        std::fs::write(dir.join("plain.bin"), [1u8; 9]).unwrap();
        let id = raw_id(&f.repo, "plain.bin").await;
        assert_eq!(
            sizes(&f.repo, None, Some(&id), Some("plain.bin"), None)
                .await
                .unwrap(),
            (None, Some(9))
        );
        assert_eq!(
            sizes(&f.repo, None, Some(&id), Some("nul.bin"), None)
                .await
                .unwrap(),
            (None, None)
        );
        // The device reads empty, so a git that opened it would hash the empty blob.
        const EMPTY_BLOB_ID: &str = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
        assert_eq!(f.empty, EMPTY_BLOB_ID, "the fixture is SHA-1");
        #[cfg(windows)]
        {
            let reserved = crate::fsops::verbatim_path(&dir.join("nul.bin")).unwrap();
            std::fs::write(&reserved, [1u8; 9]).unwrap();
            let got = sizes(&f.repo, None, Some(&id), Some("nul.bin"), None).await;
            let device = sizes(&f.repo, None, Some(EMPTY_BLOB_ID), Some("nul.bin"), None).await;
            std::fs::remove_file(&reserved).unwrap();
            assert_eq!(got.unwrap(), (None, None));
            assert_eq!(device.unwrap(), (None, None));
        }
    }

    /// What `worktree_size` does after the hash matched, read from source: it
    /// re-stats the path, reads a failed re-stat as no stamp, and answers through
    /// `settled_len`. No fixture can rewrite the file between the hash and the
    /// re-stat, so the order is pinned here.
    fn restat_violations(src: &str) -> Vec<&'static str> {
        let src = src.replace("\r\n", "\n");
        let Some(start) = src.find("async fn worktree_size(") else {
            return vec!["worktree_size not found"];
        };
        let body = &src[start..];
        let body = &body[..body.find("\n}\n").unwrap_or(body.len())];
        let Some(hash) = body.find("bytes_are_the_blob(repo, &rel, new_id)") else {
            return vec!["worktree_size's hash check not found"];
        };
        let tail = &body[hash..];
        let Some(restat) = tail.find("stamped_entry_blocking(repo, &rel)") else {
            return vec!["no re-stat after the hash"];
        };
        let stmt = &tail[restat..];
        let stmt = &stmt[..stmt.find(';').unwrap_or(stmt.len())];
        let mut problems = Vec::new();
        if stmt.contains('?') || !stmt.contains(".ok()") {
            problems.push("a failed re-stat must read as an unknown size");
        }
        if !tail[restat..].contains("Ok(settled_len(before, after))") {
            problems.push("the answer must come from settled_len over both stamps");
        }
        problems
    }

    #[test]
    fn worktree_size_re_stats_after_the_hash() {
        let src = include_str!("blob_sizes.rs");
        assert_eq!(restat_violations(src), Vec::<&str>::new());
        let src = src.replace("\r\n", "\n");
        for (from, to) in [
            (
                "Ok(settled_len(before, after))\n        }",
                "Ok(before.map(|b| b.0))\n        }",
            ),
            (
                "let after = stamped_entry_blocking(repo, &rel)\n                .await\n                .ok()\n                .and_then(|(_, stamp)| stamp);",
                "let (_, after) = stamped_entry_blocking(repo, &rel).await?;",
            ),
        ] {
            assert_eq!(src.matches(from).count(), 1, "control anchor: {from}");
            assert_ne!(
                restat_violations(&src.replacen(from, to, 1)),
                Vec::<&str>::new(),
                "control not caught: {to}"
            );
        }
    }

    /// The size answers only when a stat after the hash matches the one before it:
    /// a rewrite between them that moves the modified time (same length, new bytes)
    /// or a removal answers unknown.
    #[test]
    fn a_file_changed_after_its_stat_never_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.bin");
        std::fs::write(&path, [1u8; 9]).unwrap();
        let before = file_stamp(&path);
        let (len, modified) = before.unwrap();
        assert_eq!(len, 9);
        assert_eq!(settled_len(before, file_stamp(&path)), Some(9));
        assert_eq!(settled_len(None, file_stamp(&path)), None);

        std::fs::write(&path, [2u8; 9]).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified + std::time::Duration::from_secs(5))
            .unwrap();
        assert_eq!(file_stamp(&path).map(|s| s.0), Some(9));
        assert_eq!(settled_len(before, file_stamp(&path)), None);

        std::fs::write(&path, [1u8; 4]).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(file_stamp(&path).map(|s| s.1), Some(modified));
        assert_eq!(settled_len(before, file_stamp(&path)), None);

        std::fs::remove_file(&path).unwrap();
        assert_eq!(settled_len(before, file_stamp(&path)), None);
    }

    #[tokio::test]
    async fn a_filter_or_encoding_attribute_withholds_the_worktree_side() {
        let f = fixture(&[]).await.unwrap();
        let dir = Path::new(&f.repo);
        std::fs::write(dir.join("wt.bin"), b"\0abcd").unwrap();
        let wt = raw_id(&f.repo, "wt.bin").await;
        for (attrs, want) in [
            ("*.bin filter=lfs\n", None),
            ("*.bin -filter\n", Some(5)),
            ("*.bin working-tree-encoding=UTF-16\n", None),
            ("", Some(5)),
        ] {
            std::fs::write(dir.join(".gitattributes"), attrs).unwrap();
            assert_eq!(
                sizes(&f.repo, Some(&f.small), Some(&wt), Some("wt.bin"), None)
                    .await
                    .unwrap(),
                (Some(3), want),
                "{attrs:?}"
            );
        }
    }

    /// `-diff` alone keeps `text`, so autocrlf still converts the file: its diff's new
    /// id hashes the LF content while the disk holds CRLF bytes.
    #[tokio::test]
    async fn a_line_ending_conversion_withholds_the_worktree_side() {
        let f = fixture(&[]).await.unwrap();
        let dir = Path::new(&f.repo);
        git(&f.repo, &["config", "core.autocrlf", "true"]).await;
        std::fs::write(dir.join(".gitattributes"), "*.lock -diff\n").unwrap();
        std::fs::write(dir.join("pkg.lock"), "a\nb\n").unwrap();
        git(&f.repo, &["add", "-A"]).await;
        git(&f.repo, &["commit", "-q", "-m", "lock"]).await;
        let old = git(&f.repo, &["rev-parse", "HEAD:pkg.lock"]).await;
        for (autocrlf, bytes, want) in [
            ("true", "a\r\nb\r\nc\r\n", None),
            ("false", "a\nb\nc\n", Some(6)),
        ] {
            git(&f.repo, &["config", "core.autocrlf", autocrlf]).await;
            std::fs::write(dir.join("pkg.lock"), bytes).unwrap();
            let new = git(&f.repo, &["hash-object", "--", "pkg.lock"]).await;
            let diff = git(&f.repo, &["diff", "--no-ext-diff", "--", "pkg.lock"]).await;
            assert!(
                diff.contains(&format!("index {}..{}", &old[..7], &new[..7]))
                    && diff.contains("Binary files"),
                "{diff}"
            );
            assert_eq!(
                sizes(
                    &f.repo,
                    Some(&old[..7]),
                    Some(&new[..7]),
                    Some("pkg.lock"),
                    None
                )
                .await
                .unwrap(),
                (Some(4), want),
                "autocrlf={autocrlf}"
            );
        }
    }

    /// Whether `git --version` names a git that honours GIT_NO_LAZY_FETCH, as git's
    /// own source reads at each tag: from 2.45.0, and in the May 2024 security
    /// releases of older tracks (2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, 2.44.1).
    /// Not monotonic: 2.43.4 honours it and 2.44.0 doesn't. Each dot part counts its
    /// leading digits only, so vendor suffixes parse; anything unreadable is "no".
    fn honours_no_lazy_fetch(version: &str) -> bool {
        let mut parts = version
            .trim()
            .trim_start_matches("git version ")
            .split('.')
            .map(|p| {
                let digits: String = p.chars().take_while(char::is_ascii_digit).collect();
                digits.parse::<u32>().ok()
            });
        let (Some(Some(major)), Some(Some(minor))) = (parts.next(), parts.next()) else {
            return false;
        };
        let patch = parts.next().flatten().unwrap_or(0);
        match (major, minor) {
            (2, 45..) => true,
            (2, 44) => patch >= 1,
            (2, 43) => patch >= 4,
            (2, 42) => patch >= 2,
            (2, 41) => patch >= 1,
            (2, 40) => patch >= 2,
            (2, 39) => patch >= 4,
            (major, _) => major > 2,
        }
    }

    #[test]
    fn honours_no_lazy_fetch_follows_the_security_releases() {
        for (version, want) in [
            ("git version 2.44.0", false),
            ("git version 2.44.1", true),
            ("git version 2.45.0", true),
            ("git version 2.43.3", false),
            ("git version 2.43.4", true),
            ("git version 2.42.1", false),
            ("git version 2.42.2", true),
            ("git version 2.41.0", false),
            ("git version 2.41.1", true),
            ("git version 2.40.1", false),
            ("git version 2.40.2", true),
            ("git version 2.39.3", false),
            ("git version 2.39.4", true),
            ("git version 2.38.5", false),
            ("git version 2.39.5 (Apple Git-154)", true),
            ("git version 2.51.1.windows.1", true),
            ("git version 2.44", false),
            ("not a version", false),
            ("", false),
        ] {
            assert_eq!(honours_no_lazy_fetch(version), want, "{version:?}");
        }
    }

    fn file_url(path: &Path) -> String {
        let spelled = path.to_string_lossy().replace('\\', "/");
        if spelled.starts_with('/') {
            format!("file://{spelled}")
        } else {
            format!("file:///{spelled}")
        }
    }

    #[tokio::test]
    async fn anchored_sizes_withhold_in_shallow_and_partial_clones_only() {
        let f = fixture(&[]).await.unwrap();
        std::fs::write(Path::new(&f.repo).join("second.txt"), "second commit\n").unwrap();
        git(&f.repo, &["add", "second.txt"]).await;
        git(&f.repo, &["commit", "-q", "-m", "second"]).await;
        let head = git(&f.repo, &["rev-parse", "HEAD"]).await;
        git(&f.repo, &["config", "uploadpack.allowFilter", "true"]).await;
        let root = tempfile::tempdir().unwrap();
        let mut ran = Vec::new();
        for (name, flags, incomplete) in [
            ("shallow", vec!["--depth", "1"], true),
            ("partial", vec!["--filter=blob:none"], true),
            ("full", vec![], false),
        ] {
            let target = root.path().join(name);
            let url = file_url(Path::new(&f.repo));
            let target_text = target.to_string_lossy();
            let mut args = vec!["clone", "-q"];
            args.extend(flags);
            args.extend([url.as_str(), target_text.as_ref()]);
            let out = run_git_raw(Some(&f.repo), &args, DEFAULT_TIMEOUT)
                .await
                .unwrap();
            if out.code != 0 {
                eprintln!("SKIPPED {name} clone: {}", out.stderr.trim());
                continue;
            }
            let repo = target.to_string_lossy().into_owned();
            pin_config(&repo).await;
            assert_eq!(git(&repo, &["rev-parse", "HEAD"]).await, head);
            assert_eq!(
                git(&repo, &["rev-parse", "--is-shallow-repository"]).await,
                if name == "shallow" { "true" } else { "false" }
            );
            if name == "partial" {
                assert_eq!(
                    git(&repo, &["config", "--get", "remote.origin.promisor"]).await,
                    "true"
                );
            }
            assert_eq!(incomplete_clone(&repo).await.unwrap(), incomplete);
            // Checkout populated these blobs locally, even in the partial clone.
            assert_eq!(
                sizes(&repo, Some(&f.small[..7]), Some(&f.mid[..7]), None, None)
                    .await
                    .unwrap(),
                (Some(3), Some(7)),
                "{name} unanchored"
            );
            for worktree in [None, Some("mid.bin")] {
                assert_eq!(
                    sizes(
                        &repo,
                        Some(&f.small[..7]),
                        Some(&f.mid[..7]),
                        worktree,
                        Some(&head)
                    )
                    .await
                    .unwrap(),
                    if incomplete {
                        (None, None)
                    } else {
                        (Some(3), Some(7))
                    },
                    "{name} anchored, worktree {worktree:?}"
                );
            }
            ran.push(name);
        }
        // Any failed partial clone skips that arm; shallow and full must run.
        assert!(ran.contains(&"shallow") && ran.contains(&"full"), "{ran:?}");
    }

    #[tokio::test]
    async fn any_partial_clone_marker_withholds_only_anchored_reads() {
        for (key, value) in [
            ("remote.other.promisor", "false"),
            ("extensions.partialClone", "origin"),
        ] {
            let f = fixture(&[]).await.unwrap();
            git(&f.repo, &["config", key, value]).await;
            assert!(incomplete_clone(&f.repo).await.unwrap());
            assert_eq!(
                sizes(&f.repo, Some(&f.small), None, None, Some(&f.commit))
                    .await
                    .unwrap(),
                (None, None)
            );
            assert_eq!(
                sizes(&f.repo, Some(&f.small), None, None, None)
                    .await
                    .unwrap(),
                (Some(3), None)
            );
        }
        let (_dir, missing) = nowhere();
        assert!(incomplete_clone(&missing).await.is_err());
    }

    /// Absence probes that never fetch: `--missing=print` and the no-lazy-fetch env.
    async fn blob_missing(clone: &str, id: &str) -> bool {
        let out = run_git_raw_input_env(
            Some(clone),
            &["rev-list", "--objects", "--missing=print", "--all"],
            None,
            &NO_LAZY_FETCH,
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .exit_verdict()
        .unwrap();
        let want = format!("?{id}");
        out.stdout_lossy().lines().any(|line| line == want)
    }

    /// Absence from the local object stores; enumerating them never lazy-fetches,
    /// whatever the git version (`cat-file -e` lazy-fetches wherever git ignores
    /// GIT_NO_LAZY_FETCH).
    async fn object_missing(clone: &str, id: &str) -> bool {
        let out = run_git_raw(
            Some(clone),
            &[
                "cat-file",
                "--batch-all-objects",
                "--batch-check=%(objectname)",
            ],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .exit_verdict()
        .unwrap();
        !out.stdout_lossy().lines().any(|line| line == id)
    }

    #[tokio::test]
    async fn commits_by_prefix_and_blob_sizes_never_lazy_fetch_in_a_partial_clone() {
        let version = git(".", &["--version"]).await;
        let prevents = honours_no_lazy_fetch(&version);
        let root = tempfile::tempdir().unwrap();
        let src = root.path().join("src");
        std::fs::create_dir(&src).unwrap();
        let src = init_repo(&src, &[]).await.unwrap();
        let data = Path::new(&src).join("data.bin");
        std::fs::write(&data, b"\0one").unwrap();
        git(&src, &["add", "-A"]).await;
        git(&src, &["commit", "-q", "-m", "one"]).await;
        let old_blob = git(&src, &["rev-parse", "HEAD:data.bin"]).await;
        std::fs::write(&data, b"\0second").unwrap();
        git(&src, &["commit", "-q", "-am", "two"]).await;
        let bare = root.path().join("bare.git").to_string_lossy().into_owned();
        git(&src, &["clone", "-q", "--bare", &src, &bare]).await;
        git(&bare, &["config", "uploadpack.allowFilter", "true"]).await;
        git(&bare, &["config", "uploadpack.allowAnySHA1InWant", "true"]).await;
        let clone_path = root.path().join("pc");
        let cloned = run_git_raw(
            Some(&src),
            &[
                "clone",
                "-q",
                "--filter=blob:none",
                "--no-checkout",
                &file_url(Path::new(&bare)),
                &clone_path.to_string_lossy(),
            ],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        if cloned.code != 0 {
            eprintln!(
                "SKIPPED commits_by_prefix_and_blob_sizes_never_lazy_fetch_in_a_partial_clone: \
                 the partial clone failed ({})",
                cloned.stderr.trim()
            );
            return;
        }
        let clone = clone_path.to_string_lossy().into_owned();
        std::fs::write(&data, b"\0third!").unwrap();
        git(&src, &["commit", "-q", "-am", "three"]).await;
        let late_commit = git(&src, &["rev-parse", "HEAD"]).await;
        git(&src, &["push", "-q", &bare, "HEAD:refs/heads/late"]).await;
        assert!(
            blob_missing(&clone, &old_blob).await,
            "fixture is not partial"
        );
        assert!(object_missing(&clone, &late_commit).await);
        let clone_head = git(&clone, &["rev-parse", "HEAD"]).await;
        assert!(
            !object_missing(&clone, &clone_head).await,
            "the absence probe misses local objects"
        );

        if prevents {
            assert_eq!(
                sizes(&clone, Some(&old_blob), None, None, None)
                    .await
                    .unwrap(),
                (None, None)
            );
            assert!(
                blob_missing(&clone, &old_blob).await,
                "the blob read fetched"
            );
            assert_eq!(
                sizes(&clone, Some(&old_blob[..7]), None, None, Some(&late_commit))
                    .await
                    .unwrap(),
                (None, None)
            );
            assert!(
                object_missing(&clone, &late_commit).await,
                "the anchor read fetched"
            );
        } else {
            eprintln!(
                "SKIPPED the lazy-fetch prevention arms: this git ignores GIT_NO_LAZY_FETCH \
                 (honoured from 2.45.0 and in the 2.39.4+ security releases; {version})"
            );
        }

        // The prefix lookup feeds git only local ids, so even a full id the clone
        // lacks answers empty without a fetch, on every git version.
        let found =
            crate::git::history::git_find_commits_by_prefix(clone.clone(), late_commit.clone())
                .await
                .unwrap();
        assert!(found.is_empty(), "{found:?}");
        assert!(
            object_missing(&clone, &late_commit).await,
            "the prefix lookup fetched"
        );

        // Negative control, LAST because it fetches: without the env the same read
        // does fetch, so the absences above are prevention, not an unfetchable fixture.
        if prevents {
            let fetched = run_git_raw_input(
                Some(&clone),
                &[
                    "cat-file",
                    "--batch-check=%(objectname) %(objecttype) %(objectsize)",
                ],
                Some(&format!("{old_blob}\n")),
                DEFAULT_TIMEOUT,
            )
            .await
            .unwrap();
            assert_eq!(fetched.stdout_lossy().trim(), format!("{old_blob} blob 4"));
            assert!(!blob_missing(&clone, &old_blob).await);
        }
    }

    #[test]
    fn blob_sizes_serialize_camel_case_with_null_sides() {
        assert_eq!(
            serde_json::to_value(BlobSizes {
                old_size: Some(1),
                new_size: None,
            })
            .unwrap(),
            serde_json::json!({ "oldSize": 1, "newSize": null })
        );
    }
}
