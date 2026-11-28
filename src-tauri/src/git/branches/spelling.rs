use super::*;

/// Whether two branch spellings are equal under Unicode lowercasing, as NTFS folds
/// non-ASCII letters too. Folded per character: a filesystem's table has no context
/// rules, and `str::to_lowercase`'s final-sigma rule would pair the wrong names.
pub(crate) fn eq_ignoring_case(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
        || a.chars()
            .flat_map(char::to_lowercase)
            .eq(b.chars().flat_map(char::to_lowercase))
}

/// Whether `new` differs from `old` only in letter case. The remote rename refuses such a
/// rename wherever local refs can alias, since the remote's own folding can't be read, and
/// [`rename_mode`] reads it to pick the local rename's flag.
pub(super) fn is_case_only_rename(old: &str, new: Option<&str>) -> bool {
    new.is_some_and(|new| new != old && eq_ignoring_case(old, new))
}

/// Whether a write through the HEAD of a checkout on `now`, which holds the stored
/// `branch`, must be refused. A write there goes to `now`'s ref file, so a different leaf
/// (compared byte for byte) renames or twins `branch`, while a folder-only difference
/// writes the stored leaf in place; a HEAD that resolves to no commit (`head_resolves`
/// false) under any other spelling is refused too, since git can't read it there.
pub(crate) fn writes_through_another_spelling(
    now: &str,
    branch: &str,
    head_resolves: bool,
) -> bool {
    let leaf = |name: &str| name.rsplit('/').next().map(str::to_owned);
    leaf(now) != leaf(branch) || (!head_resolves && now != branch)
}

/// The refusal for a checkout that [`writes_through_another_spelling`] stops: a retry
/// refuses alike until that checkout names the branch exactly.
pub(crate) fn other_spelling_message(holder: &str, now: &str, branch: &str) -> String {
    format!(
        "The checkout at {holder} is on {now}, a different capitalization of {branch}, so \
         nothing was updated there. Check out {branch} by its exact name there, then try \
         again. {branch} is unchanged."
    )
}

/// How a branch name stands against the stored names, letter case folded by
/// [`eq_ignoring_case`].
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BranchSpelling {
    /// An exact ref at `tip`; where the twin check ran, no other stored name equal to it
    /// ignoring case.
    Own { tip: String },
    /// No exact ref, git reads a ref by this spelling, and exactly this one stored name
    /// equals it ignoring case.
    StoredAs(String),
    /// An exact ref at `tip`, and `twin`, another stored name equal to it ignoring case.
    Twin { tip: String, twin: String },
    /// No exact ref, git reads a ref by this spelling, and two or more stored names equal
    /// it ignoring case; `first` and `second` are the first two in refname order. git
    /// reads the one loose twin, and no tip is offered: a write would move it by a name
    /// it doesn't store.
    FoldedTwins { first: String, second: String },
    /// No exact ref, and either git reads no ref by this spelling or no stored name
    /// equals it ignoring case.
    Missing,
}

/// Classifies `name` by [`exact_branch_tip`], then by one listing of the stored names
/// only when the answer needs it: with `find_twin` false an exact ref answers `Own`
/// unlisted, for a site that only asks whether the name is stored under another
/// spelling. Without an exact ref, a spelling git reads no ref by is `Missing` unlisted:
/// only the disk decides whether two spellings name one branch, so a case-sensitive disk
/// (or a packed-only stored name) never swaps one in. A failed `for-each-ref` read is the
/// `Err`; any `show-ref` failure reads as no ref, so it classes as `Missing`.
pub(crate) async fn branch_spelling(
    repo_path: &str,
    name: &str,
    find_twin: bool,
) -> AppResult<BranchSpelling> {
    let exact = exact_branch_tip(repo_path, name).await?;
    if let (Some(tip), false) = (&exact, find_twin) {
        return Ok(BranchSpelling::Own { tip: tip.clone() });
    }
    if exact.is_none() && shown_branch_tip(repo_path, name).await?.is_none() {
        return Ok(BranchSpelling::Missing);
    }
    let stored = stored_branch_names(repo_path).await?;
    let mut others = stored
        .into_iter()
        .filter(|stored| stored != name && eq_ignoring_case(stored, name));
    let first = others.next();
    let second = others.next();
    Ok(match (exact, first, second) {
        (Some(tip), None, _) => BranchSpelling::Own { tip },
        (Some(tip), Some(twin), _) => BranchSpelling::Twin { tip, twin },
        (None, Some(stored), None) => BranchSpelling::StoredAs(stored),
        (None, Some(first), Some(second)) => BranchSpelling::FoldedTwins { first, second },
        (None, None, _) => BranchSpelling::Missing,
    })
}

/// `name` as git stores it: the stored name when git reads `name` as that one case
/// variant's ref ([`BranchSpelling::StoredAs`]), else `name` itself, folded twins
/// included: no single stored name answers there, and [`bare_move_tip`] refuses them.
/// A branch literally named `@` (which git stores and pushes, but no rev-taking site
/// admits) passes [`validate_ref_name`] alone and answers itself: it has no case variant.
pub(crate) async fn stored_branch_spelling(repo_path: &str, name: &str) -> AppResult<String> {
    if name == "@" {
        validate_ref_name(name)?;
        return Ok(name.to_string());
    }
    Ok(match branch_spelling(repo_path, name, false).await? {
        BranchSpelling::StoredAs(stored) => stored,
        _ => name.to_string(),
    })
}

/// Whether this repository's ref names can alias one another, read from the disk rather
/// than `core.ignorecase`, which a user may set false on a disk that still folds case. A
/// reftable repository, recognized by [`is_reftable_store`], never aliases, since its ref
/// names are table keys rather than file names; any other answers by its disk. A common
/// dir that can't be resolved, or a disk probe that fails, counts as aliasing, toward
/// refusing.
pub(crate) async fn refs_can_alias(repo_path: &str) -> bool {
    refs_can_alias_strict(repo_path).await.unwrap_or(true)
}

/// [`refs_can_alias`] for a caller whose `true` authorizes a write through a checkout on
/// another spelling: a common dir that can't be resolved, or a disk probe that fails, is
/// the `Err`, never "can alias".
pub(crate) async fn refs_can_alias_strict(repo_path: &str) -> AppResult<bool> {
    let common = crate::git::worktree::git_common_dir(repo_path).await?;
    Ok(refs_can_alias_at(std::path::Path::new(&common))?)
}

/// Whether a checkout on `now`, which [`holds_branch`] says holds the stored `branch`, may
/// be written through for it, as far as the store can tell: the same name, or a store whose
/// names alias ([`refs_can_alias_strict`]). Where names can't alias, two spellings are two
/// refs whatever `holds_branch`'s conservative reads answered. No spawn for the same name.
pub(crate) async fn spelling_reaches_branch(
    checkout: &str,
    now: &str,
    branch: &str,
) -> AppResult<bool> {
    if now == branch {
        return Ok(true);
    }
    refs_can_alias_strict(checkout).await
}

/// [`refs_can_alias`] over a resolved common dir: false for a reftable store, else
/// [`refs_dir_folds_case`].
pub(super) fn refs_can_alias_at(common: &std::path::Path) -> std::io::Result<bool> {
    if is_reftable_store(common) {
        return Ok(false);
    }
    refs_dir_folds_case(common)
}

/// Whether `common` holds a reftable ref store: `reftable/tables.list` beside a
/// `refs/heads` that is a FILE, the stub `git init --ref-format=reftable` leaves (git
/// 2.51.1). A files repository keeps its branches in a `refs/heads` directory, so a stray
/// `reftable` folder beside one never reads as reftable.
fn is_reftable_store(common: &std::path::Path) -> bool {
    common.join("refs").join("heads").is_file()
        && common.join("reftable").join("tables.list").is_file()
}

/// Whether `<common>/refs` exists and its upper-cased spelling `REFS` resolves too; a
/// missing `refs` answers true, and a read that fails is the `Err`.
fn refs_dir_folds_case(common: &std::path::Path) -> std::io::Result<bool> {
    if !common.join("refs").try_exists()? {
        return Ok(true);
    }
    common.join("REFS").try_exists()
}

/// The refusal for a bare move of `branch` beside `twin`, a stored name that differs
/// from it only in letter case.
pub(crate) fn twin_refusal(branch: &str, twin: &str) -> AppError {
    AppError::Command(format!(
        "{branch} and {twin} differ only in letter case, which this disk can't keep \
         apart. Rename one of them, then try again."
    ))
}

/// The refusal for minting `name` beside `twin`, a stored name that differs from it only
/// in letter case.
fn new_name_twin_refusal(name: &str, twin: &str) -> AppError {
    AppError::Command(format!(
        "{name} differs from the existing branch {twin} only in letter case, which this \
         disk can't keep apart. Use a different name, or rename {twin} first."
    ))
}

/// The stored name that a new branch `name` would be a case twin of, folded as
/// [`branch_spelling`] folds. `None` when `name` itself is stored, so git's own "already
/// exists" answers, and `replaces` (the branch a rename moves off) never counts.
fn case_twin_of<'a>(stored: &'a [String], name: &str, replaces: Option<&str>) -> Option<&'a str> {
    if stored.iter().any(|stored| stored == name) {
        return None;
    }
    stored
        .iter()
        .map(String::as_str)
        .find(|stored| Some(*stored) != replaces && eq_ignoring_case(stored, name))
}

/// The twin check shared by the routes that mint a branch name here (create, rename,
/// remote checkout, the autostash tracking arm, new-branch worktree add): refuses `name`
/// when a stored name other than `replaces` equals it ignoring case and refs can alias
/// ([`refs_can_alias`]), since git refuses only a twin of a LOOSE ref. Takes no lock: each
/// caller supplies its hold, and only a call inside the config-write mutex held through
/// the write makes check-then-create atomic. A failed listing is the `Err`; the disk is
/// probed only when a stored name folds to `name`. It first refuses any `name` that
/// [`validate_branch_name`] refuses, so a route that mints through here can't compare a rev
/// expression's literal spelling while git creates the branch it expands to.
pub(crate) async fn refuse_new_name_twin(
    repo_path: &str,
    name: &str,
    replaces: Option<&str>,
) -> AppResult<()> {
    validate_branch_name(name)?;
    let stored = stored_branch_names(repo_path).await?;
    let Some(twin) = case_twin_of(&stored, name, replaces) else {
        return Ok(());
    };
    if refs_can_alias(repo_path).await {
        return Err(new_name_twin_refusal(name, twin));
    }
    Ok(())
}

/// The tip a bare move of `branch` (a ref write no checkout's HEAD goes through) compares
/// against: the exact tip of a branch with its own ref, a twin's included where refs
/// can't alias; `None` without an exact ref. A twin where refs can alias is the
/// [`twin_refusal`]: git writes a loose file that the twin's spelling also reads, under
/// any checkout on the twin. Folded twins are refused too. A failed read is the `Err`.
pub(crate) async fn bare_move_tip(repo_path: &str, branch: &str) -> AppResult<Option<String>> {
    let spelling = branch_spelling(repo_path, branch, true).await?;
    let can_alias =
        matches!(spelling, BranchSpelling::Twin { .. }) && refs_can_alias(repo_path).await;
    bare_move_gate(branch, spelling, can_alias)
}

/// [`bare_move_tip`]'s verdict for a classified `branch`; `can_alias` is read only for a
/// twin.
fn bare_move_gate(
    branch: &str,
    spelling: BranchSpelling,
    can_alias: bool,
) -> AppResult<Option<String>> {
    match spelling {
        BranchSpelling::Own { tip } => Ok(Some(tip)),
        BranchSpelling::Twin { twin, .. } if can_alias => Err(twin_refusal(branch, &twin)),
        BranchSpelling::Twin { tip, .. } => Ok(Some(tip)),
        // Whatever the disk probe says: git read `branch` through a name it doesn't store,
        // which only aliasing does. The pair named is the variant's first two stored names.
        BranchSpelling::FoldedTwins { first, second } => Err(twin_refusal(&first, &second)),
        BranchSpelling::StoredAs(_) | BranchSpelling::Missing => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        commit_file, delete_fixture, full_ref_tip, is_aliased, packed_twin_fixture, run, temp_base,
        NEW_NAME_TWIN_REFUSAL, TWIN_REFUSAL,
    };
    use crate::git::runner::TEST_GIT_HANG_GUARD;

    #[test]
    fn eq_ignoring_case_folds_non_ascii_letters() {
        for (a, b, same) in [
            ("É/z", "é/z", true),
            ("Chore/z", "chore/z", true),
            ("é/z", "e/z", false),
            ("feat", "fear", false),
            // Measured on NTFS: a capital sigma aliases the medial one, never the final.
            ("AΣ", "aσ", true),
            ("AΣ", "aς", false),
            ("aσ", "aς", false),
        ] {
            assert_eq!(super::eq_ignoring_case(a, b), same, "{a} vs {b}");
        }
    }

    /// The bare-move verdict for each class: a twin is refused only where refs can alias,
    /// and a name without an exact ref has no tip to compare against.
    #[test]
    fn bare_move_gate_refuses_a_twin_only_where_refs_can_alias() {
        use super::{bare_move_gate, BranchSpelling};
        let own = || BranchSpelling::Own { tip: "a".into() };
        let twin = || BranchSpelling::Twin {
            tip: "a".into(),
            twin: "feat".into(),
        };
        for can_alias in [true, false] {
            assert_eq!(
                bare_move_gate("Feat", own(), can_alias).unwrap(),
                Some("a".to_string())
            );
            assert_eq!(
                bare_move_gate("Feat", BranchSpelling::StoredAs("feat".into()), can_alias).unwrap(),
                None
            );
            assert_eq!(
                bare_move_gate("Feat", BranchSpelling::Missing, can_alias).unwrap(),
                None
            );
            let folded = BranchSpelling::FoldedTwins {
                first: "Feat".into(),
                second: "feat".into(),
            };
            assert!(matches!(
                bare_move_gate("FEAT", folded, can_alias),
                Err(AppError::Command(m)) if m == TWIN_REFUSAL
            ));
        }
        assert!(matches!(
            bare_move_gate("Feat", twin(), true),
            Err(AppError::Command(m)) if m == TWIN_REFUSAL
        ));
        assert_eq!(
            bare_move_gate("Feat", twin(), false).unwrap(),
            Some("a".to_string())
        );
    }

    /// Another spelling is stored as a branch only where git reads a ref by it: a loose
    /// stored name read by the capitalized spelling is `StoredAs`, while a packed-only one
    /// (whose lookup never folds case, standing in for a case-sensitive disk) is
    /// `Missing`. Returns early on a case-sensitive filesystem or a non-files ref backend.
    #[tokio::test]
    async fn branch_spelling_takes_another_spelling_only_where_git_reads_it() {
        let (_g, repo, _feat, _head) = delete_fixture("spelling-read").await;
        run(&repo, &["branch", "solo"]).await;
        run(&repo, &["pack-refs", "--all"]).await;
        run(&repo, &["branch", "loose"]).await;
        if !is_aliased(&repo, "LOOSE").await {
            return;
        }
        assert_eq!(
            super::branch_spelling(&repo, "LOOSE", false).await.unwrap(),
            super::BranchSpelling::StoredAs("loose".to_string())
        );
        for find_twin in [false, true] {
            assert_eq!(
                super::branch_spelling(&repo, "SOLO", find_twin)
                    .await
                    .unwrap(),
                super::BranchSpelling::Missing,
                "find_twin {find_twin}"
            );
        }
        assert_eq!(
            super::stored_branch_spelling(&repo, "SOLO").await.unwrap(),
            "SOLO"
        );
    }

    /// The reftable arm over each layout: only git's reftable layout (a `refs/heads` stub
    /// file beside a `reftable/tables.list` file) reads as reftable and never aliases;
    /// every near miss, a missing `refs` included, answers as the disk folds (true on a
    /// case-insensitive one, and for a missing `refs` on any). A probe the OS can't run
    /// (a path with a NUL) is the `Err`, never "can alias".
    #[test]
    fn refs_can_alias_at_reads_reftable_only_from_its_layout() {
        use super::{is_reftable_store, refs_can_alias_at, refs_dir_folds_case};
        // `heads`: "file", "dir" or "" (no `refs` at all); `tables`: "file", "dir" (a
        // `tables.list` directory), "empty" (a bare `reftable` folder) or "".
        let (_g, base) = temp_base("reftable-layout");
        let layout = |name: &str, heads: &str, tables: &str| {
            let common = base.join(name);
            std::fs::create_dir_all(&common).unwrap();
            let refs = common.join("refs");
            match heads {
                "file" => {
                    std::fs::create_dir_all(&refs).unwrap();
                    std::fs::write(refs.join("heads"), "stub\n").unwrap();
                }
                "dir" => std::fs::create_dir_all(refs.join("heads")).unwrap(),
                _ => {}
            }
            let reftable = common.join("reftable");
            match tables {
                "file" => {
                    std::fs::create_dir_all(&reftable).unwrap();
                    std::fs::write(reftable.join("tables.list"), "").unwrap();
                }
                "dir" => std::fs::create_dir_all(reftable.join("tables.list")).unwrap(),
                "empty" => std::fs::create_dir_all(&reftable).unwrap(),
                _ => {}
            }
            common
        };
        let common = layout("reftable", "file", "file");
        assert!(is_reftable_store(&common));
        assert!(!refs_can_alias_at(&common).unwrap());
        for (name, heads, tables) in [
            ("stray-tables", "dir", "file"),
            ("stub-only", "file", ""),
            ("files", "dir", ""),
            ("empty-reftable", "dir", "empty"),
            ("stub-empty-reftable", "file", "empty"),
            ("tables-dir", "file", "dir"),
            ("no-refs", "", "file"),
        ] {
            let common = layout(name, heads, tables);
            assert!(!is_reftable_store(&common), "{name}");
            assert_eq!(
                refs_can_alias_at(&common).unwrap(),
                refs_dir_folds_case(&common).unwrap(),
                "{name}"
            );
        }
        assert!(refs_can_alias_at(&base.join("no-refs")).unwrap());
        assert!(refs_can_alias_at(&base.join("bad\0name")).is_err());
    }

    /// A reftable repository never aliases ref names, on any disk: an unborn checkout on
    /// `Feat` does not hold the stored `feat`, and the case twin `Topic` beside `topic`
    /// passes the bare-move gate at its own tip. Returns early when this git can't create
    /// a reftable repository.
    #[tokio::test]
    async fn a_reftable_repository_never_aliases_ref_names() {
        let (_g, base) = temp_base("reftable-alias");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.to_string_lossy().into_owned();
        let init = run_git_raw(
            Some(&repo),
            &["init", "-q", "--ref-format=reftable"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        if init.code != 0 {
            eprintln!("note: this git can't create a reftable repo; skipping");
            return;
        }
        run(&repo, &["config", "user.email", "t@t.local"]).await;
        run(&repo, &["config", "user.name", "T"]).await;
        commit_file(&repo, "a.txt", "seed\n").await;
        let seed = full_ref_tip(&repo, "HEAD").await.unwrap();
        run(&repo, &["branch", "feat"]).await;
        assert!(!super::refs_can_alias(&repo).await);

        let wt = base.join("unborn-wt").to_string_lossy().into_owned();
        run(&repo, &["worktree", "add", "-q", "--detach", &wt]).await;
        run(&wt, &["symbolic-ref", "HEAD", "refs/heads/Feat"]).await;
        assert!(!super::refs_can_alias(&wt).await);
        assert!(!super::holds_branch(&repo, "Feat", "feat").await);
        assert_eq!(
            super::worktree_holding_branch_checked(&repo, "feat")
                .await
                .unwrap(),
            None
        );

        run(&repo, &["branch", "topic"]).await;
        commit_file(&repo, "b.txt", "next\n").await;
        let next = full_ref_tip(&repo, "HEAD").await.unwrap();
        run(&repo, &["branch", "Topic"]).await;
        assert!(matches!(
            super::branch_spelling(&repo, "Topic", true).await.unwrap(),
            super::BranchSpelling::Twin { .. }
        ));
        assert_eq!(
            super::bare_move_tip(&repo, "Topic").await.unwrap(),
            Some(next)
        );
        assert_eq!(
            super::bare_move_tip(&repo, "topic").await.unwrap(),
            Some(seed)
        );
    }

    /// The classifier reads the packed-twin fixture as twins (and a third spelling, which
    /// git reads through the loose twin, as folded twins), and the disk probe says refs
    /// can alias here whatever `core.ignorecase` says, so the bare-move gate refuses both
    /// twins with the key set false too (the move itself is not run). Returns early on a
    /// case-sensitive filesystem or a non-files ref backend.
    #[tokio::test]
    async fn bare_move_gate_refuses_a_twin_where_the_disk_folds_case() {
        let Some((_g, repo, seed, _tip, _up)) = packed_twin_fixture("twin-gate", false).await
        else {
            return;
        };
        assert_eq!(
            super::branch_spelling(&repo, "Feat", true).await.unwrap(),
            super::BranchSpelling::Twin {
                tip: seed.clone(),
                twin: "feat".to_string()
            }
        );
        assert_eq!(
            super::branch_spelling(&repo, "Feat", false).await.unwrap(),
            super::BranchSpelling::Own { tip: seed.clone() }
        );
        for find_twin in [false, true] {
            assert_eq!(
                super::branch_spelling(&repo, "FEAT", find_twin)
                    .await
                    .unwrap(),
                super::BranchSpelling::FoldedTwins {
                    first: "Feat".to_string(),
                    second: "feat".to_string()
                },
                "find_twin {find_twin}"
            );
        }
        assert!(matches!(
            super::bare_move_tip(&repo, "FEAT").await,
            Err(AppError::Command(m)) if m == TWIN_REFUSAL
        ));
        assert_eq!(
            super::branch_spelling(&repo, "UP", false).await.unwrap(),
            super::BranchSpelling::StoredAs("up".to_string())
        );
        assert!(matches!(
            super::bare_move_tip(&repo, "Feat").await,
            Err(AppError::Command(m)) if m == TWIN_REFUSAL
        ));
        assert!(super::bare_move_tip(&repo, "up").await.unwrap().is_some());
        assert!(super::refs_can_alias(&repo).await);
        run(&repo, &["config", "core.ignorecase", "false"]).await;
        assert!(super::refs_can_alias(&repo).await);
        for name in ["Feat", "feat"] {
            assert!(
                matches!(
                    super::bare_move_tip(&repo, name).await,
                    Err(AppError::Command(m)) if m.contains("differ only in letter case")
                ),
                "{name}"
            );
        }
    }

    #[test]
    fn case_twin_of_skips_the_exact_name_and_the_renamed_branch() {
        // Stored names, the new name, the branch a rename moves off, the expected twin.
        type Row<'a> = (&'a [&'a str], &'a str, Option<&'a str>, Option<&'a str>);
        let rows: [Row; 9] = [
            (&["feat"], "feat", None, None),
            (&["main", "feat"], "Feat", None, Some("feat")),
            (&["feat"], "Feat", Some("feat"), None),
            (&["feat", "FEAT"], "Feat", Some("feat"), Some("FEAT")),
            (&["chore/z"], "Chore/z", None, Some("chore/z")),
            (&["é/z"], "É/z", None, Some("é/z")),
            (&["aσ"], "AΣ", None, Some("aσ")),
            (&["feat", "aς"], "fear", None, None),
            (&["feat", "Feat"], "Feat", None, None),
        ];
        for (stored, name, replaces, twin) in rows {
            let stored: Vec<String> = stored.iter().map(|s| s.to_string()).collect();
            assert_eq!(
                super::case_twin_of(&stored, name, replaces),
                twin,
                "{stored:?} {name} {replaces:?}"
            );
        }
        let refusal = super::new_name_twin_refusal("Feat", "feat");
        assert!(
            matches!(&refusal, AppError::Command(m) if m == NEW_NAME_TWIN_REFUSAL),
            "{refusal:?}"
        );
    }
}
