use std::collections::HashSet;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::ignored_guard::{self, ignored_files_in_the_way, name_paths};
use crate::git::runner::{
    acquire_repo_lock, acquire_repo_lock_unbounded, config_lock_busy, holder_label,
    is_config_lock_contention, run_git, run_git_config_write, run_git_config_write_held,
    run_git_raw, run_git_raw_index_retry, run_git_worktree_admin, subcommand_of,
    try_acquire_repo_lock, with_config_write_lock, ConfigWriteHeld, GitOutput, DEFAULT_TIMEOUT,
    LOCK_WAIT_TIMEOUT, NETWORK_LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT, WORKTREE_OP_TIMEOUT,
};
use crate::git::types::{Branch, BranchDivergence, RemoteBranch};
use crate::state::AppState;

mod config_repair;
mod create_checkout;
mod default_branch;
mod delete;
mod divergence;
mod in_use;
mod listing;
mod marks;
mod names;
mod refs;
mod remote_branch;
mod rename;
mod renamed_copy;
mod spelling;
mod unpushed;
mod update;
mod upstream_rewrite;

pub(crate) use config_repair::*;
pub use create_checkout::*;
pub use default_branch::*;
pub use delete::*;
pub use divergence::*;
pub(crate) use in_use::*;
pub use listing::*;
pub use marks::*;
pub(crate) use names::*;
pub(crate) use refs::*;
pub use remote_branch::*;
pub use rename::*;
pub(crate) use renamed_copy::*;
pub(crate) use spelling::*;
pub use unpushed::*;
pub use update::*;
pub use upstream_rewrite::*;

#[cfg(test)]
type TestHook = std::sync::Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync,
>;

#[cfg(test)]
tokio::task_local! {
    /// Awaited inside [`run_minting_write`] after the leftover-settings cleanup, before git.
    static MINT_CLEANUP_HOOK: TestHook;
    /// Awaited in [`git_branches`] after its `for-each-ref` read, before any reflog spawn.
    static LISTING_REFLOG_HOOK: TestHook;
    /// Awaited in [`git_branches`] after its flag read, before the push-routing read.
    static LISTING_ROUTING_HOOK: TestHook;
    /// While set, [`section_records_now`] answers [`SECTION_REREAD_FAILURE`] without
    /// running git, so the leftover-settings drop sees its re-read fail.
    static SECTION_REREAD_FAILS: ();
}

/// The `AppError::Command` message of a re-read [`SECTION_REREAD_FAILS`] failed.
#[cfg(test)]
const SECTION_REREAD_FAILURE: &str = "test seam: the branch settings re-read failed";

#[cfg(test)]
async fn run_test_hook(hook: &'static tokio::task::LocalKey<TestHook>) {
    if let Ok(wait) = hook.try_with(|hook| hook()) {
        wait.await;
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::git::runner::TEST_GIT_HANG_GUARD;
    use std::sync::Arc;

    pub(super) async fn git_ok(repo: &str, args: &[&str]) -> bool {
        run_git_raw(Some(repo), args, TEST_GIT_HANG_GUARD)
            .await
            .unwrap()
            .code
            == 0
    }

    /// Moves a folder, retrying while Windows still holds a handle in it (a scanner, say).
    /// A spawn whose working directory was moved away fails before git runs.
    pub(super) fn move_dir(from: &str, to: &str) {
        for _ in 0..100 {
            if std::fs::rename(from, to).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("couldn't move {from} to {to}");
    }

    /// A repository whose `origin` is itself, never fetched (so no
    /// `refs/remotes/origin/HEAD` until a row pins one), with reflogs on.
    pub(super) async fn copy_repo(tag: &str) -> (tempfile::TempDir, std::path::PathBuf, String) {
        let (guard, base, repo) = keep_local_repo(tag).await;
        run(&repo, &["config", "core.logAllRefUpdates", "true"]).await;
        run(&repo, &["remote", "add", "origin", &repo]).await;
        (guard, base, repo)
    }

    /// `name` created tracking `origin/<up>`, its tracking ref minted at HEAD.
    pub(super) async fn tracking_branch(repo: &str, name: &str, up: &str) {
        let tracking = format!("refs/remotes/origin/{up}");
        run(repo, &["update-ref", &tracking, "HEAD"]).await;
        run(repo, &["branch", "--track", name, &tracking]).await;
    }

    /// Pins the local `refs/remotes/origin/HEAD` to `origin/<target>`, or removes it, and
    /// asserts the pin before any row reads it.
    pub(super) async fn pin_remote_head(repo: &str, target: Option<&str>) {
        if let Some(target) = target {
            let to = format!("refs/remotes/origin/{target}");
            run(repo, &["symbolic-ref", "refs/remotes/origin/HEAD", &to]).await;
        } else {
            let _ = git_ok(repo, &["symbolic-ref", "-d", "refs/remotes/origin/HEAD"]).await;
        }
        let present = git_ok(repo, &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).await;
        assert_eq!(present, target.is_some(), "the remote-HEAD pin");
    }

    // --- Real-repo test for the `--no-track` seam (temp_dir, git on PATH). ---

    pub(super) async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, TEST_GIT_HANG_GUARD)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// A unique temp base dir for a test — the returned `TempDir` guard removes it
    /// on Drop, so a panicking or killed run cannot leak the fixture.
    pub(super) fn temp_base(tag: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-branches-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    /// Whether a `git worktree list --porcelain` listing registers a worktree whose
    /// folder is named `folder`. Compares the last path component: the throwaway
    /// worktrees sit inside [`temp_base`]'s random dir, which can itself contain `folder`.
    pub(super) fn worktree_listed(porcelain: &str, folder: &str) -> bool {
        crate::git::ops::parse_worktree_paths(porcelain)
            .iter()
            .any(|path| {
                std::path::Path::new(path).file_name() == Some(std::ffi::OsStr::new(folder))
            })
    }

    #[test]
    fn worktree_listed_matches_the_folder_name_only() {
        let main_only = "worktree /tmp/gd-branches-update-deleted-base-wtX3Nv/repo\n\
                         HEAD 0123456789abcdef0123456789abcdef01234567\n\
                         branch refs/heads/main\n\n";
        assert!(worktree_listed(main_only, "repo"));
        assert!(!worktree_listed(main_only, "deleted-base-wt"));
        let with_wt = format!(
            "{main_only}worktree /tmp/gd-branches-update-deleted-base-wtX3Nv/deleted-base-wt/\n\
             HEAD 0123456789abcdef0123456789abcdef01234567\n\
             detached\n\n"
        );
        assert!(worktree_listed(&with_wt, "deleted-base-wt"));
        assert!(!worktree_listed(&with_wt, "base-wt"));
        // Windows `Path` also splits on a backslash.
        #[cfg(windows)]
        assert!(worktree_listed(
            "worktree C:\\t\\deleted-base-wt\n",
            "deleted-base-wt"
        ));
    }

    /// Pins the files ref backend: several tests read or write loose ref, reflog and
    /// lock files, which a machine default of `reftable` would not create.
    pub(super) async fn init_repo(repo_s: &str, seed_file: &str) {
        run(repo_s, &["-c", "init.defaultRefFormat=files", "init", "-q"]).await;
        run(repo_s, &["config", "user.email", "t@t.local"]).await;
        run(repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(std::path::Path::new(repo_s).join(seed_file), "hello\n").unwrap();
        run(repo_s, &["add", "-A"]).await;
        run(repo_s, &["commit", "-qm", "seed"]).await;
    }

    /// The branch's own tip, read through the full ref so no same-named tag answers.
    pub(super) async fn local_tip(repo: &str, branch: &str) -> String {
        branch_tip_sha(repo, branch)
            .await
            .expect("the tip reads")
            .expect("the branch exists")
    }

    /// A repo whose `branch` is `ahead` commits past a base and tracks a local `up`
    /// branch one conflicting commit past it; `branch` is NOT checked out. Returns
    /// (repo, base, up's tip).
    pub(super) async fn diverged_local_upstream(
        base: &std::path::Path,
        branch: &str,
        up: &str,
        ahead: usize,
    ) -> (String, String, String) {
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        let fork = run(&repo_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["branch", up]).await;
        run(&repo_s, &["switch", "-qc", branch]).await;
        for n in 0..ahead {
            std::fs::write(repo.join("a.txt"), format!("mine {n}\n")).unwrap();
            run(&repo_s, &["commit", "-qam", &format!("mine {n}")]).await;
        }
        run(&repo_s, &["switch", "-q", up]).await;
        std::fs::write(repo.join("a.txt"), "theirs\n").unwrap();
        run(&repo_s, &["commit", "-qam", "theirs"]).await;
        let up_tip = local_tip(&repo_s, up).await;
        run(&repo_s, &["switch", "-q", "--detach"]).await;
        run(&repo_s, &["branch", "--set-upstream-to", up, branch]).await;
        (repo_s, fork, up_tip)
    }

    /// Points the marker root, where the holder arm mints its update marker, at a
    /// `worktrees` dir beside `repo`. The guards must span the test's awaits; bound in
    /// order, they drop override first, then the serializing lock.
    pub(super) fn holder_marker_root(
        repo: &str,
    ) -> (
        std::sync::MutexGuard<'static, ()>,
        crate::git::update_marker::TestRootOverride,
        std::path::PathBuf,
    ) {
        use crate::git::update_marker as marker;
        let root = std::path::Path::new(repo)
            .parent()
            .unwrap()
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let serialized = marker::test_root_lock();
        let installed = marker::TestRootOverride::set(&root);
        (serialized, installed, root)
    }

    pub(super) async fn commit_file(dir: &str, file: &str, body: &str) {
        std::fs::write(std::path::Path::new(dir).join(file), body).unwrap();
        run(dir, &["add", "-A"]).await;
        run(dir, &["commit", "-qm", file]).await;
    }

    /// A repo whose `branch` carries BOTH an upstream and the archived flag, so a stale
    /// `branch.<name>` section has something to show, plus a remote-tracking ref
    /// `origin/<tracked>` (synthesized, never fetched) at a commit whose tree DIFFERS
    /// from HEAD's, so a test can tell a moved working tree from an untouched one.
    pub(super) async fn repo_with_branch_settings(
        tag: &str,
        branch: &str,
        tracked: &str,
    ) -> (tempfile::TempDir, std::path::PathBuf, String) {
        let (guard, base) = temp_base(tag);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        run(&repo_s, &["branch", branch]).await;
        run(
            &repo_s,
            &["branch", "--set-upstream-to", main.trim(), branch],
        )
        .await;
        let flag = format!("branch.{branch}.gitdesktopArchived");
        run(&repo_s, &["config", &flag, "true"]).await;
        let nowhere = base.join("nowhere.git").to_string_lossy().into_owned();
        run(&repo_s, &["remote", "add", "origin", &nowhere]).await;
        run(&repo_s, &["switch", "-q", "-c", "remote-side"]).await;
        std::fs::write(repo.join("a.txt"), "remote\n").unwrap();
        std::fs::write(repo.join("remote.txt"), "remote\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "remote side"]).await;
        let tracking = format!("refs/remotes/origin/{tracked}");
        run(&repo_s, &["update-ref", &tracking, "HEAD"]).await;
        run(&repo_s, &["switch", "-q", main.trim()]).await;
        run(&repo_s, &["branch", "-q", "-D", "remote-side"]).await;
        (guard, repo, repo_s)
    }

    /// Every `branch.<name>.*` entry, empty when the section is gone.
    pub(super) async fn branch_section(repo: &str, branch: &str) -> String {
        let pattern = format!(r"^branch\.{branch}\.");
        run_git_raw(
            Some(repo),
            &["config", "--get-regexp", &pattern],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap()
        .stdout_lossy()
    }

    pub(super) async fn branch_exists(repo: &str, name: &str) -> bool {
        !run(repo, &["branch", "--list", name])
            .await
            .trim()
            .is_empty()
    }

    /// A repo on its default branch with `feat` at the seed commit carrying an upstream
    /// and the Keep local mark, and `main_tip` one commit past it on the checked-out
    /// branch. Reflogs are pinned on, so a global `core.logAllRefUpdates` can't hide one.
    /// Returns (guard, repo, feat's tip, the checked-out branch's tip).
    pub(super) async fn delete_fixture(tag: &str) -> (tempfile::TempDir, String, String, String) {
        let (guard, base) = temp_base(tag);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["config", "core.logAllRefUpdates", "true"]).await;
        run(&repo_s, &["branch", "feat"]).await;
        for (key, value) in [
            ("remote", "origin"),
            ("merge", "refs/heads/feat"),
            ("gitdesktopLocalOnly", "true"),
        ] {
            run(&repo_s, &["config", &format!("branch.feat.{key}"), value]).await;
        }
        std::fs::write(repo.join("a.txt"), "next\n").unwrap();
        run(&repo_s, &["commit", "-qam", "next"]).await;
        let feat = full_ref_tip(&repo_s, "refs/heads/feat").await.unwrap();
        let head = full_ref_tip(&repo_s, "HEAD").await.unwrap();
        (guard, repo_s, feat, head)
    }

    pub(super) async fn full_ref_tip(repo: &str, rev: &str) -> Option<String> {
        let out = run_git_raw(
            Some(repo),
            &["rev-parse", "--verify", "--quiet", rev],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        (out.code == 0).then(|| out.stdout_lossy().trim().to_string())
    }

    pub(super) async fn delete(
        state: &AppState,
        repo: &str,
        name: &str,
        pin: Option<&str>,
    ) -> Result<DeleteBranchOutcome, AppError> {
        git_delete_branch_core(state, repo.into(), name.into(), pin.map(str::to_string)).await
    }

    /// Whether `name` is aliased in `repo`: `for-each-ref` lists no ref of that exact
    /// spelling, yet `show-ref --verify` answers, as it does on a case-insensitive
    /// filesystem that resolves the spelling to another name's loose file.
    pub(crate) async fn is_aliased(repo: &str, name: &str) -> bool {
        let full_ref = super::branch_full_ref(name).unwrap();
        let listed = run(repo, &["for-each-ref", "--format=%(refname)", &full_ref]).await;
        let shown = run_git_raw(
            Some(repo),
            &["show-ref", "--verify", "--quiet", &full_ref],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        listed.trim().is_empty() && shown.code == 0
    }

    /// `delete_fixture` plus a `chore/x` branch, so a later `Chore/z` lands in the existing
    /// `chore/` folder and is listed as `chore/z`.
    pub(super) async fn aliasing_fixture(tag: &str) -> (tempfile::TempDir, String) {
        let (g, repo, _feat, _head) = delete_fixture(tag).await;
        run(&repo, &["branch", "chore/x"]).await;
        (g, repo)
    }

    /// HEAD on `Chore/z` (stored as `chore/z`) at `z1`, with `up` one commit ahead and set
    /// as `chore/z`'s upstream. Returns (guard, repo, z1, up's tip), or `None` on a
    /// case-sensitive filesystem or a non-files ref backend, where `Chore/z` is a ref of
    /// its own.
    pub(super) async fn aliased_current_fixture(
        tag: &str,
    ) -> Option<(tempfile::TempDir, String, String, String)> {
        let (g, repo) = aliasing_fixture(tag).await;
        let commit = |repo: String, file: &'static str| async move {
            std::fs::write(std::path::Path::new(&repo).join(file), "z\n").unwrap();
            run(&repo, &["add", "-A"]).await;
            run(&repo, &["commit", "-qm", file]).await;
        };
        run(&repo, &["switch", "-q", "-c", "Chore/z"]).await;
        commit(repo.clone(), "z1.txt").await;
        run(&repo, &["switch", "-q", "-c", "up"]).await;
        commit(repo.clone(), "z2.txt").await;
        run(&repo, &["switch", "-q", "Chore/z"]).await;
        if !is_aliased(&repo, "Chore/z").await {
            return None;
        }
        assert_eq!(
            run(&repo, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/Chore/z",
            "fixture sanity"
        );
        run(&repo, &["config", "branch.chore/z.remote", "."]).await;
        run(&repo, &["config", "branch.chore/z.merge", "refs/heads/up"]).await;
        let z1 = full_ref_tip(&repo, "HEAD").await.unwrap();
        let up = full_ref_tip(&repo, "refs/heads/up").await.unwrap();
        Some((g, repo, z1, up))
    }

    /// `delete_fixture` plus `<dir>/x`, then `held` (the stored `<dir>/z` or its
    /// capitalized spelling) checked out at `z1` in a linked worktree when `linked`, else
    /// here, with `up` one commit ahead. Returns (guard, repo, checkout, z1, up), or
    /// `None` when the capitalized spelling is not aliased: a case-sensitive filesystem,
    /// or a non-files ref backend (`GIT_DEFAULT_REF_FORMAT` beats the fixture's `-c` pin).
    pub(super) async fn held_spelling_fixture(
        tag: &str,
        dir: &str,
        held: &str,
        linked: bool,
    ) -> Option<(tempfile::TempDir, String, String, String, String)> {
        let (g, repo, _feat, _head) = delete_fixture(tag).await;
        run(&repo, &["branch", &format!("{dir}/x")]).await;
        let aliased = format!("{}{}/z", dir[..1].to_uppercase(), &dir[1..]);
        let checkout = if linked {
            let wt = g.path().join("held-wt").to_string_lossy().into_owned();
            run(&repo, &["worktree", "add", "-q", "-b", held, &wt]).await;
            wt
        } else {
            run(&repo, &["switch", "-q", "-c", held]).await;
            repo.clone()
        };
        let commit = |at: String, file: &'static str| async move {
            std::fs::write(std::path::Path::new(&at).join(file), "z\n").unwrap();
            run(&at, &["add", "-A"]).await;
            run(&at, &["commit", "-qm", file]).await;
        };
        commit(checkout.clone(), "z1.txt").await;
        run(&checkout, &["switch", "-q", "-c", "up"]).await;
        commit(checkout.clone(), "z2.txt").await;
        run(&checkout, &["switch", "-q", held]).await;
        if !is_aliased(&repo, &aliased).await {
            return None;
        }
        let z1 = full_ref_tip(&checkout, "HEAD").await.unwrap();
        let up = full_ref_tip(&repo, "refs/heads/up").await.unwrap();
        Some((g, repo, checkout, z1, up))
    }

    /// `delete_fixture` with `Feat` packed at the seed and `feat` loose at the next commit,
    /// or back at the seed when `same`, created with the reflog message "loose twin", plus
    /// `up`, a child of the next commit, as `Feat`'s upstream. Returns (guard, repo, seed,
    /// feat's tip, up), or `None` when raw git reads the two apart: a case-sensitive
    /// filesystem or a non-files ref backend.
    pub(super) async fn packed_twin_fixture(
        tag: &str,
        same: bool,
    ) -> Option<(tempfile::TempDir, String, String, String, String)> {
        let (g, repo, seed, head) = delete_fixture(tag).await;
        run(&repo, &["pack-refs", "--all"]).await;
        run(&repo, &["update-ref", "refs/heads/Feat", &seed]).await;
        run(&repo, &["pack-refs", "--all"]).await;
        run(&repo, &["update-ref", "-d", "refs/heads/feat", &seed]).await;
        run(
            &repo,
            &["update-ref", "-m", "loose twin", "refs/heads/feat", &head],
        )
        .await;
        let shown = run(
            &repo,
            &["show-ref", "--verify", "--hash", "refs/heads/Feat"],
        )
        .await;
        let listed = run(
            &repo,
            &["for-each-ref", "--format=%(objectname)", "refs/heads/Feat"],
        )
        .await;
        if shown.trim() != head || listed.trim() != seed {
            return None;
        }
        let tree = format!("{head}^{{tree}}");
        let up = run(&repo, &["commit-tree", &tree, "-p", &head, "-m", "up"]).await;
        let up = up.trim().to_string();
        run(&repo, &["update-ref", "refs/heads/up", &up]).await;
        run(&repo, &["config", "branch.Feat.remote", "."]).await;
        run(&repo, &["config", "branch.Feat.merge", "refs/heads/up"]).await;
        let tip = if same {
            run(&repo, &["update-ref", "refs/heads/feat", &seed, &head]).await;
            seed.clone()
        } else {
            head
        };
        Some((g, repo, seed, tip, up))
    }

    /// `feat` checked out here, or in a linked worktree when `linked`; the checkout's path.
    pub(super) async fn twin_checkout(g: &tempfile::TempDir, repo: &str, linked: bool) -> String {
        if linked {
            let wt = g.path().join("twin-wt").to_string_lossy().into_owned();
            run(repo, &["worktree", "add", "-q", &wt, "feat"]).await;
            wt
        } else {
            run(repo, &["switch", "-q", "feat"]).await;
            repo.to_string()
        }
    }

    /// Both twins at their fixture tips, the checkout's HEAD at `head` over a clean tree,
    /// and the loose file still named `feat`, all read through raw git and the disk.
    pub(super) async fn assert_twins_intact(repo: &str, checkout: &str, seed: &str, tip: &str, head: &str) {
        let listed = run(
            repo,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads/",
            ],
        )
        .await;
        assert!(
            listed.contains(&format!("refs/heads/Feat {seed}")),
            "{listed}"
        );
        assert!(
            listed.contains(&format!("refs/heads/feat {tip}")),
            "{listed}"
        );
        assert_eq!(full_ref_tip(checkout, "HEAD").await.as_deref(), Some(head));
        assert_eq!(run(checkout, &["status", "--porcelain"]).await.trim(), "");
        let loose: Vec<String> =
            std::fs::read_dir(std::path::Path::new(repo).join(".git/refs/heads"))
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
        assert!(loose.iter().any(|n| n == "feat"), "{loose:?}");
        assert!(!loose.iter().any(|n| n == "Feat"), "{loose:?}");
    }

    pub(super) const TWIN_REFUSAL: &str = "Feat and feat differ only in letter case, which this disk \
        can't keep apart. Rename one of them, then try again.";

    /// Holds `repo`'s config-write mutex from another task until the sender fires.
    pub(crate) async fn hold_config_mutex(
        repo: &str,
    ) -> (
        tokio::task::JoinHandle<()>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (held_tx, held_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let repo = repo.to_string();
        let holder = tokio::spawn(async move {
            crate::git::runner::with_config_write_lock(&repo, |_held| async move {
                let _ = held_tx.send(());
                let _ = release_rx.await;
            })
            .await
        });
        held_rx.await.expect("the test holds the mutex");
        (holder, release_tx)
    }

    /// A [`CONFIG_WRITE_LOCK_EVENTS`] hook that fires the receiver at the first
    /// "waiting"; dropped unfired, the receiver errs instead of hanging.
    pub(crate) fn on_first_waiting() -> (
        Arc<dyn Fn(&'static str) + Send + Sync>,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let tx = std::sync::Mutex::new(Some(tx));
        let hook = move |event| {
            if event == "waiting" {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        };
        (Arc::new(hook), rx)
    }

    /// The branch `repo`'s HEAD names, `None` when detached.
    pub(super) async fn symbolic_head(repo: &str) -> Option<String> {
        let out = run_git_raw(
            Some(repo),
            &["symbolic-ref", "-q", "HEAD"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        (out.code == 0).then(|| out.stdout_lossy().trim().to_string())
    }

    pub(super) async fn upstream_of(repo: &str, branch: &str) -> Option<String> {
        let spec = format!("{branch}@{{upstream}}");
        run_git(
            Some(repo),
            &["rev-parse", "--abbrev-ref", &spec],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .ok()
        .map(|out| out.stdout_lossy().trim().to_string())
    }

    /// `branch.<name>.remote` and `.merge`, or `None` for each that is unset.
    pub(super) async fn tracking_of(repo: &str, branch: &str) -> (Option<String>, Option<String>) {
        let get = |key: &'static str| {
            let key = format!("branch.{branch}.{key}");
            async move {
                let out = run_git_raw(Some(repo), &["config", "--get", &key], TEST_GIT_HANG_GUARD)
                    .await
                    .unwrap();
                (out.code == 0).then(|| out.stdout_lossy().trim().to_string())
            }
        };
        (get("remote").await, get("merge").await)
    }

    // --- Keep local flag and the remote-default branch-list field. ---

    /// A repo on an explicitly named `main`, with the identity pinned repo-locally.
    pub(super) async fn keep_local_repo(tag: &str) -> (tempfile::TempDir, std::path::PathBuf, String) {
        let (guard, base) = temp_base(tag);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q", "-b", "main"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "seed"]).await;
        (guard, base, repo_s)
    }

    pub(super) fn append_config(repo: &str, text: &str) {
        use std::io::Write;
        let path = std::path::Path::new(repo).join(".git").join("config");
        let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    /// The new-name refusal for `Feat` beside the stored `feat`.
    pub(super) const NEW_NAME_TWIN_REFUSAL: &str = "Feat differs from the existing branch feat only in \
        letter case, which this disk can't keep apart. Use a different name, or rename feat \
        first.";

    /// Whether `repo`'s refs alias, read by git alone: a fresh LOOSE `oracle-loose` read as
    /// `ORACLE-LOOSE` (a packed-only twin under test can't be read that way), asserted equal
    /// to [`super::refs_can_alias`] before a test branches on it. Call it after any
    /// `pack-refs` the fixture runs and before any the test runs later.
    pub(super) async fn case_twin_alias_oracle(repo: &str) -> bool {
        run(repo, &["branch", "oracle-loose"]).await;
        let observed = is_aliased(repo, "ORACLE-LOOSE").await;
        assert_eq!(
            super::refs_can_alias(repo).await,
            observed,
            "the alias verdict matches git's own reads"
        );
        observed
    }

    /// Every stored branch name, read with raw git.
    pub(super) async fn case_twin_listed(repo: &str) -> Vec<String> {
        run(
            repo,
            &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        )
        .await
        .lines()
        .filter_map(|line| line.strip_prefix("refs/heads/"))
        .map(str::to_string)
        .collect()
    }

    /// HEAD's symbolic ref (or detached sha) and the local config, which a refused mint
    /// must leave as they were.
    pub(super) async fn case_twin_snapshot(repo: &str) -> (Option<String>, Option<String>, String) {
        let config = run(repo, &["config", "--list", "--local"]).await;
        (
            symbolic_head(repo).await,
            full_ref_tip(repo, "HEAD").await,
            config,
        )
    }
}
