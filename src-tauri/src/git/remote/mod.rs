use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::branches::{restore_upstream, UPSTREAM_ATOM_INDEX, UPSTREAM_WRITE_FAILED};
use crate::git::ignored_guard::{self, ignored_files_in_the_way};
use crate::git::runner::{
    acquire_repo_lock, config_lock_busy, holder_label, is_config_lock_contention, run_git,
    run_git_config_write_held, run_git_mutating_config_write, run_git_raw, subcommand_of,
    with_config_write_lock, ConfigWriteHeld, GitOutput, CONFIG_LOCK_BUSY_LEAD, DEFAULT_TIMEOUT,
    LOCK_WAIT_TIMEOUT, NETWORK_LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT, WORKTREE_OP_TIMEOUT,
};
use crate::state::AppState;

mod creds;
mod default_branch;
mod fetch;
mod publish;
mod pull;
mod push;
mod redact;
mod remotes;
#[cfg(test)]
mod stderr_canaries;
mod tracking;

pub(crate) use creds::*;
pub use default_branch::*;
pub use fetch::*;
pub(crate) use publish::*;
pub use pull::*;
pub use push::*;
pub(crate) use redact::*;
pub use remotes::*;
pub(crate) use tracking::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::runner::TEST_GIT_HANG_GUARD;

    // --- Origins and push helpers other files' tests share; the origins' hostile-config test. ---

    /// The upstream a decision-table row tracks: `""` is none, else that branch.
    pub(super) fn up(name: &str) -> Upstream {
        if name.is_empty() {
            Upstream::Untracked
        } else {
            Upstream::Branch(name.to_string())
        }
    }

    /// Set up a bare origin seeded with one commit on `main`, and return the temp
    /// guard, the base dir, and the origin's path plus its `file://` URL. The work
    /// repo pins `remote.origin.mirror=false` and `remote.pushDefault=origin` locally,
    /// so a hostile global config can't turn its pushes into mirror pushes or route
    /// them elsewhere.
    pub(super) async fn seeded_origin(tag: &str) -> (tempfile::TempDir, std::path::PathBuf, String, String) {
        seeded_origin_pinned(tag, true).await
    }

    /// [`seeded_origin`] without the `remote.pushDefault` pin, for tests that assert
    /// that key starts absent locally; a global `remote.pushDefault` stays out of reach.
    pub(super) async fn seeded_origin_unpinned_push_default(
        tag: &str,
    ) -> (tempfile::TempDir, std::path::PathBuf, String, String) {
        seeded_origin_pinned(tag, false).await
    }

    async fn seeded_origin_pinned(
        tag: &str,
        pin_push_default: bool,
    ) -> (tempfile::TempDir, std::path::PathBuf, String, String) {
        let (guard, base) = temp_base(tag);
        let origin = base.join("origin.git");
        let work = base.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let base_s = base.to_string_lossy().into_owned();
        let work_s = work.to_string_lossy().into_owned();
        let url = format!("file://{}", origin.to_string_lossy().replace('\\', "/"));

        run(&base_s, &["init", "-q", "--bare", "-b", "main", "origin.git"]).await;
        init_repo(&work_s, "a.txt").await;
        run(&work_s, &["branch", "-M", "main"]).await;
        run(&work_s, &["remote", "add", "origin", &url]).await;
        run(&work_s, &["config", "remote.origin.mirror", "false"]).await;
        if pin_push_default {
            run(&work_s, &["config", "remote.pushDefault", "origin"]).await;
        }
        run(&work_s, &["push", "-q", "-u", "origin", "main"]).await;
        (guard, base, origin.to_string_lossy().into_owned(), url)
    }

    /// Reads `key` in `repo` with a hostile global config file pointed at by
    /// `GIT_CONFIG_GLOBAL` on this one spawn; `local` restricts it to the repo's own file.
    async fn config_under_hostile_global(
        repo: &str,
        global: &str,
        key: &str,
        local: bool,
    ) -> crate::git::runner::GitOutput {
        let mut args = vec!["config"];
        if local {
            args.push("--local");
        }
        args.extend(["--get", key]);
        crate::git::runner::run_git_raw_env(
            Some(repo),
            &args,
            &[("GIT_CONFIG_GLOBAL", global)],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn seeded_origin_holds_under_a_hostile_global_config() {
        let (_g, scratch) = temp_base("hostile-global");
        let global = scratch.join("hostile.gitconfig");
        std::fs::write(
            &global,
            "[remote \"origin\"]\n\tmirror = true\n[remote]\n\tpushDefault = elsewhere\n",
        )
        .unwrap();
        let global = global.to_string_lossy().into_owned();
        let read =
            |out: crate::git::runner::GitOutput| (out.code, out.stdout_lossy().trim().to_string());
        // The hostile file is live: a repo without the pins reads its values.
        let control_dir = scratch.join("control");
        run(&scratch.to_string_lossy(), &["init", "-q", "control"]).await;
        let control = control_dir.to_string_lossy().into_owned();
        let mirror = config_under_hostile_global(&control, &global, "remote.origin.mirror", false);
        assert_eq!(read(mirror.await), (0, "true".into()), "control");

        let (_guard, base, _origin, _url) = seeded_origin("hostile-pinned").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let mirror = config_under_hostile_global(&work, &global, "remote.origin.mirror", false);
        assert_eq!(read(mirror.await), (0, "false".into()));
        let push = config_under_hostile_global(&work, &global, "remote.pushDefault", false);
        assert_eq!(read(push.await), (0, "origin".into()));

        let (_guard, base, _origin, _url) =
            seeded_origin_unpinned_push_default("hostile-unpinned").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let mirror = config_under_hostile_global(&work, &global, "remote.origin.mirror", false);
        assert_eq!(read(mirror.await), (0, "false".into()));
        let local_push = config_under_hostile_global(&work, &global, "remote.pushDefault", true);
        assert_eq!(read(local_push.await).0, 1, "no local remote.pushDefault");
    }

    /// A work repo pinned against a hostile global config, with a local bare `origin`
    /// holding `main` and `feat/x` (tracked), HEAD on `feat/x` one commit ahead of it.
    /// Returns (guard, work, origin).
    pub(super) async fn keep_local_origin(tag: &str) -> (tempfile::TempDir, String, String) {
        let (guard, base) = temp_base(tag);
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work").to_string_lossy().into_owned();
        let origin = base.join("origin.git").to_string_lossy().replace('\\', "/");
        run(
            &base_s,
            &["init", "-q", "--bare", "-b", "main", "origin.git"],
        )
        .await;
        run(&base_s, &["init", "-q", "-b", "main", "work"]).await;
        for (key, value) in [
            ("user.name", "t"),
            ("user.email", "t@example.com"),
            ("push.default", "simple"),
            ("branch.autoSetupMerge", "true"),
        ] {
            run(&work, &["config", key, value]).await;
        }
        run(&work, &["remote", "add", "origin", &origin]).await;
        run(&work, &["config", "remote.origin.mirror", "false"]).await;
        run(&work, &["config", "remote.pushDefault", "origin"]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "seed"]).await;
        run(&work, &["push", "-q", "-u", "origin", "main"]).await;
        run(&work, &["switch", "-q", "-c", "feat/x"]).await;
        run(&work, &["push", "-q", "-u", "origin", "feat/x"]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "ahead"]).await;
        (guard, work, origin)
    }

    pub(super) fn assert_kept_local(
        result: crate::error::AppResult<impl std::fmt::Debug>,
        branch: &str,
        row: &str,
    ) {
        match result.expect_err(row) {
            AppError::BranchKeptLocal { branch: b } => assert_eq!(b, branch, "{row}"),
            other => panic!("{row}: expected the Keep local refusal, got {other:?}"),
        }
    }

    /// `feat/x`'s tip in `repo`.
    pub(super) async fn feat_x_tip(repo: &str) -> String {
        run(repo, &["rev-parse", "refs/heads/feat/x"])
            .await
            .trim()
            .to_string()
    }

    /// git's per-ref reason when `--force-with-lease` finds the remote-tracking ref
    /// behind the real remote — verbatim from `! [rejected] … (…)`. The prod-side
    /// twin is `push::IF_INCLUDES_REJECTION`; this one only ever appears in git's report.
    pub(super) const STALE_LEASE_REJECTION: &str = "stale info";

    /// Assert git's failure report still carries a `! [rejected] … (<reason>)` line
    /// — the exact shape `PUSH_REJECTION_SUMMARIES` (src/lib/error-summary.ts)
    /// anchors on to turn a blocked force push into one human line. Keep the two
    /// lists in step: a reason git renames goes back to raw stderr in the toast.
    pub(super) fn assert_rejection_reason(report: &str, reason: &str) {
        let marked = format!("({reason})");
        assert!(
            report
                .lines()
                .any(|l| l.trim_start().starts_with("! [rejected]") && l.contains(&marked)),
            "git no longer emits `! [rejected] … {marked}` — the frontend summary is now blind \
             to this rejection. Actual report:\n{report}"
        );
    }

    /// `git_push_core` with today's seven inputs: no pins, no recorded create.
    pub(super) async fn git_push_core_unpinned(
        state: &AppState,
        repo_path: String,
        set_upstream: bool,
        force: bool,
        branch: Option<String>,
        remote: Option<String>,
        remote_branch: Option<String>,
    ) -> crate::error::AppResult<super::PushGuardWire> {
        super::git_push_core(
            state,
            repo_path,
            set_upstream,
            force,
            branch,
            remote,
            remote_branch,
            None,
            false,
        )
        .await
    }

    pub(super) fn pins(branch: &str, head: Option<&str>) -> super::PushPins {
        super::PushPins::from_wire(Some(branch.to_string()), head.map(str::to_string))
            .unwrap()
            .expect("a branch pin")
    }

    // --- Real-repo helpers the other files' tests share (temp_dir, git on PATH). ---

    pub(super) async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, TEST_GIT_HANG_GUARD)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// A unique temp base dir for a test — the returned `TempDir` guard removes it
    /// (and every subdir under it) on Drop, so a panicking or killed run cannot
    /// leak the fixture.
    pub(super) fn temp_base(tag: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-remote-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    pub(super) async fn init_repo(repo_s: &str, seed_file: &str) {
        run(repo_s, &["init", "-q"]).await;
        run(repo_s, &["config", "user.email", "t@t.local"]).await;
        run(repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(std::path::Path::new(repo_s).join(seed_file), "hello\n").unwrap();
        run(repo_s, &["add", "-A"]).await;
        run(repo_s, &["commit", "-qm", "seed"]).await;
    }
}
