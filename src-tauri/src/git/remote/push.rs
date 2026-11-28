use super::*;

/// `expected_branch` / `expected_head` pin the push to the branch it was pressed on (the
/// short name, or `HEAD` for a detached HEAD) and the tip its confirm showed; `creates`
/// says the caller's own check found the destination absent. All absent is unpinned.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // the push inputs plus the three optional pins
pub async fn git_push(
    state: State<'_, AppState>,
    repo_path: String,
    set_upstream: bool,
    force: bool,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    expected_branch: Option<String>,
    expected_head: Option<String>,
    creates: Option<bool>,
) -> AppResult<PushGuardWire> {
    let pins = PushPins::from_wire(expected_branch, expected_head)?;
    // Boxed: the invoke handler builds a command's future on the UI-thread stack.
    Box::pin(git_push_core(
        &state,
        repo_path,
        set_upstream,
        force,
        branch,
        remote,
        remote_branch,
        pins,
        creates.unwrap_or(false),
    ))
    .await
}

/// `git_push`'s return value: [`PushGuard`] plus the one outcome only the GUI's pinned
/// force push can reach. The camelCase wire strings mirror the `PushGuard` union in
/// `src/lib/git/api/sync.ts`, pinned by `push_guard_wire_serializes_to_the_camel_case_wire_values`.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)] // the shared `Lease` prefix IS the shared guarantee
pub(crate) enum PushGuardWire {
    LeaseAndIncludes,
    LeaseOnlyOldGit,
    LeaseOnlyNoReflog,
    /// `--force-if-includes` refused a clone with no fetch history for the tracking ref;
    /// the retry ran under a lease pinned to the tracking tip read before the first try.
    LeasePinnedNoTrackingReflog,
}

impl From<PushGuard> for PushGuardWire {
    fn from(guard: PushGuard) -> Self {
        match guard {
            PushGuard::LeaseAndIncludes => Self::LeaseAndIncludes,
            PushGuard::LeaseOnlyOldGit => Self::LeaseOnlyOldGit,
            PushGuard::LeaseOnlyNoReflog => Self::LeaseOnlyNoReflog,
        }
    }
}

/// What a GUI push pins: HEAD's branch (never [`crate::git::commit::ExpectedRef::Any`]) and,
/// optionally, its tip. Compared after the early HEAD read and before every spawn.
#[derive(Debug, Clone)]
pub(super) struct PushPins {
    branch: crate::git::commit::ExpectedRef,
    head: Option<String>,
}

impl PushPins {
    /// The IPC form: `expected_head` is a full object id and needs `expected_branch`.
    pub(super) fn from_wire(
        expected_branch: Option<String>,
        expected_head: Option<String>,
    ) -> AppResult<Option<Self>> {
        use crate::git::commit::ExpectedRef;
        let branch = ExpectedRef::from_wire(expected_branch)?;
        if let Some(head) = &expected_head {
            let hex = head.bytes().all(|b| b.is_ascii_hexdigit());
            if !(matches!(head.len(), 40 | 64) && hex) {
                return Err(AppError::InvalidArgument(format!(
                    "expected head must be a full commit id: {head}"
                )));
            }
            if branch == ExpectedRef::Any {
                return Err(AppError::InvalidArgument(
                    "expected head requires an expected branch".to_string(),
                ));
            }
        }
        Ok((branch != ExpectedRef::Any).then_some(PushPins {
            branch,
            head: expected_head,
        }))
    }

    /// The pinned branch in its wire form: the short name, or `HEAD` when detached.
    fn expected(&self) -> String {
        match &self.branch {
            crate::git::commit::ExpectedRef::Branch(b) => b.clone(),
            _ => "HEAD".to_string(),
        }
    }

    /// Compares HEAD (`head_ref`, git's full ref; None when detached) with the pinned
    /// branch. Spawns nothing.
    fn check_branch(&self, head_ref: Option<&str>) -> AppResult<()> {
        use crate::git::commit::ExpectedRef;
        let on = head_ref.map(|r| r.strip_prefix("refs/heads/").unwrap_or(r));
        let same = match &self.branch {
            ExpectedRef::Branch(b) => on == Some(b.as_str()),
            ExpectedRef::Detached => head_ref.is_none(),
            ExpectedRef::Any => true,
        };
        if !same {
            return Err(AppError::PushHeadMoved {
                expected: self.expected(),
            });
        }
        Ok(())
    }

    /// [`Self::check_branch`], then HEAD's commit with the pinned tip. A failed tip read
    /// is that read's error.
    async fn check(&self, repo_path: &str, head_ref: Option<&str>) -> AppResult<()> {
        self.check_branch(head_ref)?;
        if let Some(want) = &self.head {
            let out = run_git(
                Some(repo_path),
                &["rev-parse", "--verify", "HEAD^{commit}"],
                DEFAULT_TIMEOUT,
            )
            .await?;
            if !out.stdout_lossy().trim().eq_ignore_ascii_case(want) {
                return Err(AppError::PushTipMoved {
                    branch: self.expected(),
                });
            }
        }
        Ok(())
    }

    /// [`Self::check`] against HEAD read now.
    async fn check_now(&self, repo_path: &str) -> AppResult<()> {
        let head_ref = crate::git::branches::current_branch_ref(repo_path).await?;
        self.check(repo_path, head_ref.as_deref()).await
    }
}

/// A force push's lease pinned to an explicit expected tip: only [`git_push_core`]'s
/// tracking-reflog degrade retry passes one. The tip was read for `remote`, so a retry
/// that git would now route elsewhere returns `refusal` (the first attempt's `code` and
/// `stderr`) instead of spawning.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct LeasePin {
    remote: String,
    dest: String,
    sha: String,
    refusal: (i32, String),
}

/// The degrade retry's routing check, run early and again at spawn: `remote` is where git
/// routes the push now.
fn refuse_moved_lease_route(pin: &LeasePin, remote: Option<&str>) -> AppResult<()> {
    if remote == Some(pin.remote.as_str()) {
        return Ok(());
    }
    let (code, stderr) = pin.refusal.clone();
    Err(AppError::Git { code, stderr })
}

/// Which guarantee a completed push actually ran under. Only meaningful for a
/// FORCE push: a non-force push has no lease to degrade, and reports
/// [`PushGuard::LeaseAndIncludes`] as the neutral value.
///
/// Crosses the IPC boundary as `git_push`'s return value, so the caller's
/// success toast can name a degraded guarantee instead of overclaiming. The
/// camelCase wire strings mirror the `PushGuard` union in `src/lib/git/api/sync.ts`
/// and are pinned by `push_guard_serializes_to_the_camel_case_wire_values`.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)] // the shared `Lease` prefix IS the shared guarantee
pub(crate) enum PushGuard {
    /// `--force-with-lease --force-if-includes`, the intended pair.
    LeaseAndIncludes,
    /// This git predates `--force-if-includes` (2.30) — the lease alone.
    LeaseOnlyOldGit,
    /// The branch has no reflog for `--force-if-includes` to walk, so the check
    /// could never pass — the lease alone.
    LeaseOnlyNoReflog,
}

/// `remote_branch` names the DESTINATION branch when it differs from the local one
/// (pushing a maintainer's local work back to a contributor's fork head). It only
/// means anything alongside an explicit `branch` and `remote`, so any other
/// combination is rejected rather than silently ignored.
///
/// Private to `git::remote` on purpose: MCP tools push only through
/// [`git_push_same_name_core`] (refuses a named push onto a differently named
/// branch of a named remote) and [`git_force_push_head_core`] (HEAD only, so git's
/// push.default applies), never through this pinned, follow-the-routing-rule entry.
///
/// A force push of HEAD pinned to a branch and its tip carries one more fallback: on a
/// clone whose tracking ref has no reflog `--force-if-includes` refuses although nothing
/// moved, so the push is retried once under a lease pinned to the tracking tip read
/// before the first attempt, when [`tracking_reflog_retry_allowed`] proves all three legs.
#[allow(clippy::too_many_arguments)] // the push inputs plus the GUI's pins
pub(super) async fn git_push_core(
    state: &AppState,
    repo_path: String,
    set_upstream: bool,
    force: bool,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    pins: Option<PushPins>,
    creates: bool,
) -> AppResult<PushGuardWire> {
    let degrade = match (&pins, force, &branch, set_upstream) {
        (Some(p), true, None, false) if p.head.is_some() => {
            tracking_degrade_preread(&repo_path, p).await
        }
        _ => None,
    };
    let first = git_push_with_policy(
        state,
        repo_path.clone(),
        set_upstream,
        force,
        branch.clone(),
        remote.clone(),
        remote_branch.clone(),
        CrossNameUpstream::Follow,
        pins.as_ref(),
        creates,
        false,
        None,
    )
    .await;
    match (first, degrade) {
        (Err(AppError::Git { code, stderr }), Some(pre))
            if stderr.contains(IF_INCLUDES_REJECTION) =>
        {
            let allowed =
                tracking_reflog_retry_allowed(&repo_path, &pre.branch_ref, &pre.tracking, &pre.sha)
                    .await;
            if !allowed {
                return Err(AppError::Git { code, stderr });
            }
            let lease = LeasePin {
                remote: pre.remote,
                dest: pre.dest,
                sha: pre.sha,
                refusal: (code, stderr),
            };
            git_push_with_policy(
                state,
                repo_path,
                set_upstream,
                force,
                branch,
                remote,
                remote_branch,
                CrossNameUpstream::Follow,
                pins.as_ref(),
                creates,
                false,
                Some(&lease),
            )
            .await?;
            Ok(PushGuardWire::LeasePinnedNoTrackingReflog)
        }
        (result, _) => result.map(PushGuardWire::from),
    }
}

/// The values the tracking-reflog degrade retry is decided on, read before the first
/// attempt for the PINNED branch, never HEAD.
#[derive(Debug)]
struct DegradePreread {
    /// `refs/heads/<pinned branch>`.
    branch_ref: String,
    /// The destination's remote-tracking ref: git's own `%(push)`, or for a triangular
    /// `simple` push the standard `refs/remotes/<push remote>/<branch>`.
    tracking: String,
    /// The push remote, the destination branch and the tracking ref's commit id when read.
    remote: String,
    dest: String,
    sha: String,
}

/// Reads [`DegradePreread`] for a pinned branch; None (the arm off) when the pin is not
/// a branch or the destination, its tracking ref or that ref's id doesn't resolve. Where
/// `%(push)` resolves nothing, a triangular `simple` push still lands on its push remote
/// under the local name, so that destination is read when the remote keeps git's
/// standard fetch layout (any other layout leaves the arm off); matching never gets here
/// with a pin, since its pinned force push is refused first.
async fn tracking_degrade_preread(repo_path: &str, pins: &PushPins) -> Option<DegradePreread> {
    use crate::git::commit::{CasRef, ExpectedRef};
    let ExpectedRef::Branch(name) = &pins.branch else {
        return None;
    };
    let CasRef::Branch(branch_ref) = pins.branch.cas_ref(repo_path).await.ok()? else {
        return None;
    };
    let text = crate::git::branches::read_refs_with_push_destination(
        repo_path,
        &branch_ref,
        UPSTREAM_TRACKING_FORMAT,
    )
    .await
    .ok()?;
    let line = tracking_line(&text, &branch_ref)?;
    let (remote, dest, tracking) = match bare_push_destination(&text, &branch_ref, name) {
        (Some(remote), Some(dest)) => {
            let tracking = line
                .atoms()
                .get(PUSH_TRACKING_ATOM_INDEX)
                .copied()
                .filter(|t| t.starts_with("refs/"))?
                .to_string();
            (remote, dest, tracking)
        }
        _ => {
            let config = crate::git::status::push_config_strict(repo_path)
                .await
                .ok()?;
            let (Some(remote), Some(dest)) =
                config.triangular_simple_destination(name, line.upstream_remote())
            else {
                return None;
            };
            if !config.has_standard_fetch_refspec(&remote) {
                return None;
            }
            let tracking = format!("refs/remotes/{remote}/{dest}");
            (remote, dest, tracking)
        }
    };
    crate::git::branches::validate_ref_name(&dest).ok()?;
    let sha = ref_commit(repo_path, &tracking).await?;
    Some(DegradePreread {
        branch_ref,
        tracking,
        remote,
        dest,
        sha,
    })
}

/// `full_ref`'s commit id, None when it doesn't resolve or the read fails.
async fn ref_commit(repo_path: &str, full_ref: &str) -> Option<String> {
    let peeled = format!("{full_ref}^{{commit}}");
    let out = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--verify", "--quiet", &peeled],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let id = out.stdout_lossy().trim().to_string();
    (out.code == 0 && !id.is_empty()).then_some(id)
}

/// Whether the degrade retry may run, on three proofs; any other answer (entries
/// present, a non-zero exit, a failed spawn) keeps git's refusal:
/// 1. `tracking` has zero reflog entries (`reflog show -n 1` exits 0 and prints nothing);
/// 2. `tracking` still points at `pre_id`;
/// 3. `pre_id` is reachable from an entry of `branch_ref`'s reflog: `--force-if-includes`'s
///    test, made on the pushed branch, where git uses the destination-named local ref
///    (the two differ for a cross-name push): one `rev-list --stdin` fed `pre_id` and a
///    `^<entry>` line per entry prints nothing (`--not --stdin` does not negate stdin
///    lines on git 2.51.1, measured).
async fn tracking_reflog_retry_allowed(
    repo_path: &str,
    branch_ref: &str,
    tracking: &str,
    pre_id: &str,
) -> bool {
    let reflog = |full_ref: &str, limit: bool| {
        let mut args = vec!["reflog", "show"];
        if limit {
            args.extend(["-n", "1"]);
        }
        args.extend(["--format=%H", full_ref]);
        let args: Vec<String> = args.into_iter().map(str::to_string).collect();
        async move {
            let argv: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git_raw(Some(repo_path), &argv, DEFAULT_TIMEOUT)
                .await
                .ok()
                .filter(|out| out.code == 0)
                .map(|out| out.stdout_lossy())
        }
    };
    match reflog(tracking, true).await {
        Some(text) if text.trim().is_empty() => {}
        _ => return false,
    }
    if ref_commit(repo_path, tracking).await.as_deref() != Some(pre_id) {
        return false;
    }
    let Some(entries) = reflog(branch_ref, false).await else {
        return false;
    };
    let mut seen = std::collections::HashSet::new();
    let mut input = format!("{pre_id}\n");
    for id in entries.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if seen.insert(id) {
            input.push('^');
            input.push_str(id);
            input.push('\n');
        }
    }
    crate::git::runner::run_git_raw_input(
        Some(repo_path),
        &["rev-list", "-n", "1", "--stdin"],
        Some(&input),
        DEFAULT_TIMEOUT,
    )
    .await
    .is_ok_and(|out| out.code == 0 && out.stdout_lossy().trim().is_empty())
}

/// The MCP `push` tool's entry. A named push whose tracking would land it on a
/// differently named branch of a real remote is refused before any push runs: an
/// agent cannot see where a named push lands. `set_upstream` publishes under the
/// local name instead.
pub(crate) async fn git_push_same_name_core(
    state: &AppState,
    repo_path: String,
    set_upstream: bool,
    branch: Option<String>,
    remote: Option<String>,
) -> AppResult<PushGuard> {
    git_push_with_policy(
        state,
        repo_path,
        set_upstream,
        false,
        branch,
        remote,
        None,
        CrossNameUpstream::Refuse,
        None,
        false,
        false,
        None,
    )
    .await
}

/// The remote rename's push of its new name: the same-name `-u` publish of `branch` to
/// `remote`, always under the create-only lease (a fetch that re-created the tracking ref
/// can't disarm it) and with `--no-follow-tags`, so `push.followTags` can't turn a refused
/// tag into a failed push of a branch that landed.
pub(crate) async fn git_push_creating_core(
    state: &AppState,
    repo_path: String,
    branch: String,
    remote: String,
) -> AppResult<PushGuard> {
    git_push_with_policy(
        state,
        repo_path,
        true,
        false,
        Some(branch),
        Some(remote),
        None,
        CrossNameUpstream::Refuse,
        None,
        true,
        true,
        None,
    )
    .await
}

/// The MCP `force_push` tool's entry: HEAD only, so git's own push.default applies.
pub(crate) async fn git_force_push_head_core(
    state: &AppState,
    repo_path: String,
) -> AppResult<PushGuard> {
    git_push_with_policy(
        state,
        repo_path,
        false,
        true,
        None,
        None,
        None,
        CrossNameUpstream::Refuse,
        None,
        false,
        false,
        None,
    )
    .await
}

#[derive(Clone, Copy, PartialEq)]
enum CrossNameUpstream {
    Follow,
    Refuse,
}

/// Where a HEAD push goes: `Bare` resolves the remote from HEAD at spawn, and `Publish`
/// is the `-u` publish to HEAD's configured push remote, else origin (a detached or
/// invalidly named HEAD always publishes the literal `-u origin HEAD`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum HeadRoute {
    Bare,
    Publish,
}

/// What a push re-reads under the network lock before each spawn: the route's own reads,
/// then the pins last, when the push carries any, so only the two pin reads separate
/// the final compare from the spawn.
#[derive(Clone, Copy, Debug)]
pub(super) struct SpawnRecheck<'a> {
    pub(super) route: RecheckRoute<'a>,
    pub(super) pins: Option<&'a PushPins>,
    /// A HEAD route's force flag and degrade lease, which [`refuse_head_push`] and
    /// [`refuse_moved_lease_route`] re-read; a named route ignores both.
    pub(super) force: bool,
    pub(super) lease: Option<&'a LeasePin>,
}

/// `Head` re-runs every HEAD read; `Named` is an argv pinned to a branch, remote and
/// destination, so it re-runs only the branch's publishing refusal (the remote's mirror
/// flag is read once, early).
#[derive(Clone, Copy, Debug)]
pub(super) enum RecheckRoute<'a> {
    Head(HeadRoute),
    Named(&'a str),
}

impl<'a> SpawnRecheck<'a> {
    /// An unpinned recheck of a named branch's argv.
    pub(super) fn named(branch: &'a str) -> Self {
        SpawnRecheck {
            route: RecheckRoute::Named(branch),
            pins: None,
            force: false,
            lease: None,
        }
    }

    pub(super) async fn run(self, repo_path: &str) -> AppResult<()> {
        match self.route {
            RecheckRoute::Head(route) => {
                let head = refuse_head_push(repo_path, route, self.pins, self.force).await?;
                if let Some(pin) = self.lease {
                    refuse_moved_lease_route(pin, head.remote.as_deref())?;
                }
            }
            RecheckRoute::Named(branch) => refuse_publishing_branch(repo_path, branch).await?,
        }
        #[cfg(test)]
        let _ = RECHECK_PINS_HOOK.try_with(|hook| hook());
        if let Some(pins) = self.pins {
            pins.check_now(repo_path).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
tokio::task_local! {
    /// Runs in [`SpawnRecheck::run`] between the route's reads and the final pin check.
    static RECHECK_PINS_HOOK: std::sync::Arc<dyn Fn() + Send + Sync>;
}

/// What [`refuse_head_push`] read: HEAD's full ref and branch (None when detached), and
/// the remote the route pushes to (None for a bare push git has no destination for).
#[derive(Debug)]
struct HeadPush {
    head_ref: Option<String>,
    branch: Option<String>,
    remote: Option<String>,
}

/// The remote a HEAD push authenticates against and is mirror-checked on. `Bare` is
/// git's own routing ([`crate::git::status::PushConfig::bare_push_remote`]), None if the winner is
/// empty; `Publish` is HEAD's configured push remote (unusable refuses), else origin.
/// `remotes` is consulted only for a validly named HEAD. With no push remote configured,
/// `tracking` (HEAD's upstream read) refuses an Untracked HEAD as the named route does
/// ([`untracked_branch_remote`]); it never picks the destination.
fn head_push_remote(
    config: &crate::git::status::PushConfig,
    route: HeadRoute,
    head: Option<&str>,
    remotes: &[String],
    tracking: Option<(&Upstream, &str)>,
) -> AppResult<Option<String>> {
    match route {
        HeadRoute::Bare => Ok(config.bare_push_remote(head).map(str::to_string)),
        HeadRoute::Publish => {
            let valid = head.filter(|b| crate::git::branches::validate_ref_name(b).is_ok());
            let configured = match valid {
                Some(b) => configured_push_remote_checked(config, remotes, b)?,
                None => None,
            };
            if let (None, Some(b), Some((upstream, remotename))) = (configured, valid, tracking) {
                untracked_branch_remote(config, remotes, b, upstream, remotename)?;
            }
            Ok(Some(configured.unwrap_or("origin").to_string()))
        }
    }
}

/// `branch`'s push remote ([`crate::git::status::PushConfig::push_remote_setting`]), validated:
/// empty, an invalid name or not one of `remotes` is
/// [`PushRemoteUnusable`](AppError::PushRemoteUnusable), naming the key that won.
fn configured_push_remote_checked<'c>(
    config: &'c crate::git::status::PushConfig,
    remotes: &[String],
    branch: &str,
) -> AppResult<Option<&'c str>> {
    let Some((key, value)) = config.push_remote_setting(branch) else {
        return Ok(None);
    };
    let usable = !value.is_empty()
        && crate::git::branches::validate_ref_name(value).is_ok()
        && remotes.iter().any(|r| r == value);
    if !usable {
        return Err(AppError::PushRemoteUnusable {
            branch: branch.to_string(),
            key,
            value: redact_url_userinfo(value),
        });
    }
    Ok(Some(value))
}

/// Every pre-spawn read of a HEAD push, run early and again at spawn for an argv that
/// resolves HEAD there: HEAD's branch (`None` when detached), its publishing refusal,
/// and one config listing for the push remote and its mirror refusal. `pins`' branch is
/// compared first, so a moved HEAD answers that and never the other branch's refusal. A
/// pinned bare FORCE push (the sync bar's) is refused where git's routing would send more
/// refs than the pinned one ([`PushForceMultiRef`](AppError::PushForceMultiRef)); a plain
/// or unpinned push keeps git's configured routing.
async fn refuse_head_push(
    repo_path: &str,
    route: HeadRoute,
    pins: Option<&PushPins>,
    force: bool,
) -> AppResult<HeadPush> {
    use crate::git::status::{mirror_refusal, push_config_strict, PushRemote};
    // git's own full ref, so the destination read's pattern is never rebuilt from a name.
    let head_ref = crate::git::branches::current_branch_ref(repo_path).await?;
    if let Some(pins) = pins {
        pins.check_branch(head_ref.as_deref())?;
    }
    let head = head_ref
        .as_deref()
        .and_then(|r| r.strip_prefix("refs/heads/"))
        .map(str::to_string);
    if let Some(b) = &head {
        refuse_publishing_branch(repo_path, b).await?;
    }
    let config = push_config_strict(repo_path).await?;
    let publish_head = head.as_deref().filter(|_| route == HeadRoute::Publish);
    let configured = publish_head.is_some_and(|b| config.push_remote_setting(b).is_some());
    // Only an unconfigured HEAD with `branch.<b>.remote` set can meet the untracked refusal.
    let branch_remote = !configured
        && publish_head.is_some_and(|b| config.branch_remote(b).is_some_and(|n| !n.is_empty()));
    let remotes = if configured || branch_remote {
        git_remotes(repo_path.to_string()).await?
    } else {
        Vec::new()
    };
    let tracking = match (branch_remote, head_ref.as_deref()) {
        (true, Some(refname)) => {
            let out = run_git(
                Some(repo_path),
                &["for-each-ref", refname, UPSTREAM_TRACKING_FORMAT],
                DEFAULT_TIMEOUT,
            )
            .await?;
            parse_upstream_tracking(&out.stdout_lossy(), refname)
        }
        _ => None,
    };
    let tracking = tracking.as_ref().map(|(up, name, _)| (up, name.as_str()));
    let remote = head_push_remote(&config, route, head.as_deref(), &remotes, tracking)?;
    // A bare push git has no destination for is git's own failure, never a mirror push.
    match (route, remote.as_deref()) {
        (HeadRoute::Bare, Some(_)) => mirror_refusal(
            &config,
            PushRemote::Bare {
                head: head.as_deref(),
            },
        )?,
        (HeadRoute::Publish, Some(r)) => mirror_refusal(&config, PushRemote::Named(r))?,
        (_, None) => {}
    }
    if let (HeadRoute::Bare, true, Some(_), Some(r)) = (route, force, pins, remote.as_deref()) {
        if let Some(cause) = config.multi_ref_cause(r) {
            return Err(AppError::PushForceMultiRef {
                branch: head.clone().unwrap_or_else(|| "HEAD".to_string()),
                remote: redact_url_userinfo(r),
                cause,
            });
        }
    }
    // A bare push of a non-session HEAD lands on a session branch only under
    // push.default=upstream, which the push atoms resolve; matching and a push remote's
    // own refspecs send refs the user configured and stay out of reach. The atom's push
    // remote agrees with the mirror verdict's for every tracked HEAD; an untracked one
    // reads empty, which resolves nothing here.
    if let (HeadRoute::Bare, Some(refname), Some(b)) = (route, head_ref.as_deref(), head.as_deref())
    {
        let text = crate::git::branches::read_refs_with_push_destination(
            repo_path,
            refname,
            UPSTREAM_TRACKING_FORMAT,
        )
        .await?;
        // A push remote of `.` beside a branch upstream pushes into this repository, under
        // every push.default; a push remote configured beside it sends the push there.
        // A GONE `.` upstream is refused too: the named arm retargets it at origin, git doesn't.
        if let Some(upstream) = bare_push_local_upstream(&text, refname) {
            return Err(AppError::PushUpstreamIsLocal {
                branch: b.to_string(),
                upstream,
            });
        }
        if let (Some(remote), Some(dest)) = bare_push_destination(&text, refname, b) {
            refuse_session_destination(b, &remote, &dest)?;
        }
    }
    Ok(HeadPush {
        head_ref,
        branch: head,
        remote,
    })
}

#[allow(clippy::too_many_arguments)] // push inputs, the caller's policy, pins and leases
async fn git_push_with_policy(
    state: &AppState,
    repo_path: String,
    set_upstream: bool,
    force: bool,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    cross_name: CrossNameUpstream,
    pins: Option<&PushPins>,
    creates: bool,
    no_follow_tags: bool,
    lease_pin: Option<&LeasePin>,
) -> AppResult<PushGuard> {
    if remote_branch.is_some() && (branch.is_none() || remote.is_none()) {
        return Err(AppError::InvalidArgument(
            "remote branch requires an explicit branch and remote".to_string(),
        ));
    }
    // The credential config is scoped to the remote we actually push to, resolved
    // below; None (a bare push git has no destination for) builds none.
    let cred_remote: Option<String>;
    // The HEAD path's `-u` publish names its branch explicitly (see that arm).
    let mut head_branch: Option<String> = None;
    // `(branch, remote, dest)` when the argv carries the create-only lease, so its
    // `(stale info)` refusal can be named.
    let mut create_lease: Option<(String, String, String)> = None;
    // Owned Strings: a named-branch push interpolates the branch into a refspec,
    // which can't borrow from a temporary.
    let args: Vec<String> = match &branch {
        None => {
            // A remote can only be chosen for an explicit branch: the HEAD path follows
            // git's own routing, or publishes to HEAD's push remote (see `HeadRoute`).
            if remote.is_some() {
                return Err(AppError::InvalidArgument(
                    "remote requires an explicit branch".to_string(),
                ));
            }
            // Bare and force pushes resolve HEAD at spawn, after the credential and lock
            // waits, so the spawn re-checks too, pins included. This early read is the
            // fast failure.
            let route = if set_upstream {
                HeadRoute::Publish
            } else {
                HeadRoute::Bare
            };
            let head = refuse_head_push(&repo_path, route, pins, force).await?;
            if let Some(pin) = lease_pin {
                refuse_moved_lease_route(pin, head.remote.as_deref())?;
            }
            if let Some(pins) = pins {
                pins.check(&repo_path, head.head_ref.as_deref()).await?;
            }
            if set_upstream && crate::git::branches::head_is_unborn(&repo_path).await? {
                return Err(crate::git::branches::unborn_head_error());
            }
            cred_remote = head.remote.clone();
            let mut a = head_push_argv(force, lease_pin);
            if set_upstream {
                // Pin the branch read above as an explicit same-name pair so the push and
                // upstream repair agree after the lock wait. Detached HEAD or a name
                // failing validate_ref_name keeps the literal `-u origin HEAD`, unleased.
                head_branch = head
                    .branch
                    .filter(|b| crate::git::branches::validate_ref_name(b).is_ok());
                match head_branch.as_deref() {
                    Some(b) => {
                        let target = head.remote.unwrap_or_else(|| "origin".to_string());
                        if !force
                            && (creates || !tracking_ref_present(&repo_path, &target, b).await)
                        {
                            a.push(create_lease_arg(b));
                            create_lease = Some((b.to_string(), target.clone(), b.to_string()));
                        }
                        a.extend(["-u".to_string(), target, publish_refspec(b)]);
                    }
                    None => a.extend(["-u", "origin", "HEAD"].map(str::to_string)),
                }
            }
            a
        }
        Some(b) => {
            crate::git::branches::validate_ref_name(b)?;
            refuse_publishing_branch(&repo_path, b).await?;
            if let Some(pins) = pins {
                pins.check_now(&repo_path).await?;
            }
            // A caller-chosen remote is validated for shape AND verified to exist
            // BEFORE any mutation: the existence check is the primary guard (a URL
            // can never appear in `git remote` output — and it requires `:`, which
            // validate_ref_name's blocklist already rejects). We never interpolate
            // the remote into a refspec — it's the bare `push <remote>` argument.
            if let Some(r) = &remote {
                // `validate_ref_name` is the checker, but its message speaks of a
                // "branch name" — remap it so an invalid remote reads accurately.
                crate::git::branches::validate_ref_name(r).map_err(|_| {
                    AppError::InvalidArgument(format!("invalid remote name: {r}"))
                })?;
            }
            let remotes = git_remotes(repo_path.clone()).await?;
            if let Some(r) = &remote {
                if !remotes.iter().any(|n| n == r) {
                    return Err(AppError::InvalidArgument(format!("unknown remote: {r}")));
                }
            }
            // The destination name IS interpolated into the refspec's right-hand
            // side, so it takes the same blocklist as the local branch (`*` would
            // mirror-push, `:` would add a refspec field).
            if let Some(rb) = &remote_branch {
                crate::git::branches::validate_ref_name(rb).map_err(|_| {
                    AppError::InvalidArgument(format!("invalid remote branch name: {rb}"))
                })?;
            }
            // Resolve b's tracking state in one read-only call. `for-each-ref`
            // matches a pattern as a prefix up to a slash (`refs/heads/feat` also
            // matches `refs/heads/feat/sub`), so emitting `%(refname)` and requiring
            // an exact match (in `parse_upstream_tracking`) is what makes this an
            // exact-name lookup. `%(upstream:track)` carries `[gone]`.
            let out = run_git(
                Some(&repo_path),
                &[
                    "for-each-ref",
                    &format!("refs/heads/{b}"),
                    UPSTREAM_TRACKING_FORMAT,
                ],
                DEFAULT_TIMEOUT,
            )
            .await?;
            // No exact-refname line ⇒ no such local branch (an *untracked* branch
            // still emits `refs/heads/<b>\0\0\0`).
            let Some((upstream, remotename, gone)) =
                parse_upstream_tracking(&out.stdout_lossy(), &format!("refs/heads/{b}"))
            else {
                if crate::git::branches::head_is_unborn(&repo_path).await?
                    && crate::git::branches::current_branch_name(&repo_path)
                        .await?
                        .as_deref()
                        == Some(b.as_str())
                {
                    return Err(crate::git::branches::unborn_head_error());
                }
                return Err(AppError::InvalidArgument(format!("no such branch: {b}")));
            };
            let config = crate::git::status::push_config_strict(&repo_path).await?;
            // Phase 1: the MCP policy's cross-name refusal is decided against the
            // upstream's own remote first; when it holds, the push config is not consulted
            // and the flow below is the one that policy always had.
            let mcp_refuses = cross_name == CrossNameUpstream::Refuse
                && cross_name_refusal(
                    b,
                    &upstream,
                    &remotename,
                    gone,
                    set_upstream,
                    None,
                    None,
                    remote_branch.as_deref(),
                )
                .is_some();
            // Phase 2: an explicit remote always wins and the push config is never read
            // for it; otherwise the configured push remote, validated.
            let configured = if remote.is_none() && !mcp_refuses {
                configured_push_remote_checked(&config, &remotes, b)?
            } else {
                None
            };
            let remotename = if remote.is_none() && configured.is_none() {
                untracked_branch_remote(&config, &remotes, b, &upstream, &remotename)?
            } else {
                remotename
            };
            let route = NamedRoute {
                branch: b,
                upstream: &upstream,
                remotename: &remotename,
                gone,
                set_upstream,
                requested: remote.as_deref(),
                configured,
                remote_branch: remote_branch.as_deref(),
            };
            // The credential config targets the remote the push goes to.
            let target = route.refuse(&config, &remotes, cross_name)?;
            let dest = route.dest();
            let tracked =
                force || !route.publishes() || tracking_ref_present(&repo_path, &target, b).await;
            let lease = CreateLease {
                creates,
                dest_tracked: tracked,
            };
            let args = route.argv(force, lease);
            if args.contains(&create_lease_arg(dest)) {
                create_lease = Some((b.clone(), target.clone(), dest.to_string()));
            }
            cred_remote = Some(target);
            args
        }
    };
    let mut args = args;
    if no_follow_tags {
        args.insert(1, "--no-follow-tags".to_string());
    }
    let cred = match &cred_remote {
        Some(r) => crate::forge::credential_config_for_remote(&repo_path, r).await?,
        None => Vec::new(),
    };
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    // Only an argv naming no branch resolves HEAD at spawn; a pinned one re-reads its mark.
    let route = match (branch.as_deref().or(head_branch.as_deref()), set_upstream) {
        (Some(pinned), _) => RecheckRoute::Named(pinned),
        (None, false) => RecheckRoute::Head(HeadRoute::Bare),
        (None, true) => RecheckRoute::Head(HeadRoute::Publish),
    };
    let recheck = Some(SpawnRecheck {
        route,
        pins,
        force,
        lease: lease_pin,
    });
    let (repo, timeout) = (repo_path.as_str(), NETWORK_TIMEOUT);
    match run_git_mutating_with_creds_checked(state, repo, &cred, &argv, timeout, recheck).await {
        Ok(_) => Ok(PushGuard::LeaseAndIncludes),
        Err(AppError::Git { stderr, .. })
            if argv.contains(&FORCE_IF_INCLUDES) && is_unknown_push_option(&stderr) =>
        {
            // git < 2.30 doesn't know `--force-if-includes`. Unknown options are
            // rejected while parsing argv, before any network I/O, so this retry
            // can't push twice; it degrades to the lease alone.
            let retry = without_force_if_includes(&argv);
            run_git_mutating_with_creds_checked(state, repo, &cred, &retry, timeout, recheck)
                .await?;
            Ok(PushGuard::LeaseOnlyOldGit)
        }
        Err(AppError::Git { code, stderr })
            if argv.contains(&FORCE_IF_INCLUDES) && stderr.contains(IF_INCLUDES_REJECTION) =>
        {
            // The flag proves inclusion by walking the local branch's reflog, so
            // with no reflog it can never pass: an amend with the remote left
            // untouched is rejected (measured) under core.logAllRefUpdates=false.
            // The lease still guards the retry — at worst, pre-change behavior.
            // Left standing on purpose: a PRESENT reflog with expired entries
            // (gc.reflogExpire), and a cross-name push colliding with a stale
            // local branch named like the destination (git walks THAT branch's
            // reflog — measured); neither can prove inclusion, so both reject.
            let pinned = branch.as_deref().or(head_branch.as_deref());
            let Some(b) = pushed_branch(&repo_path, pinned).await else {
                return Err(AppError::Git { code, stderr });
            };
            if branch_has_reflog(&repo_path, &b).await {
                return Err(AppError::Git { code, stderr });
            }
            let retry = without_force_if_includes(&argv);
            run_git_mutating_with_creds_checked(state, repo, &cred, &retry, timeout, recheck)
                .await?;
            Ok(PushGuard::LeaseOnlyNoReflog)
        }
        // The create-only lease refuses only a destination that exists at another commit.
        // Several `To` blocks (one per push URL) may have created it on another URL first,
        // so only a one-destination report is named; the rest keeps git's text.
        Err(AppError::Git { stderr, .. })
            if create_lease.is_some()
                && is_stale_lease_rejection(&stderr)
                && stderr
                    .lines()
                    .filter(|l| l.trim().starts_with("To "))
                    .count()
                    == 1 =>
        {
            let (branch, remote, dest) = create_lease.unwrap_or_default();
            Err(AppError::PushDestinationExists {
                branch,
                remote,
                dest,
            })
        }
        // Only the bare HEAD push reaches git's push.default=simple name check: every
        // named arm passes an explicit refspec.
        Err(AppError::Git { code, stderr })
            if branch.is_none() && !set_upstream && is_push_simple_name_refusal(&stderr) =>
        {
            Err(confirmed_name_mismatch(&repo_path)
                .await
                .unwrap_or(AppError::Git { code, stderr }))
        }
        Err(other) => Err(other),
    }
}

/// Whether git's push report refuses a ref for a stale lease: a line whose status start
/// ([`rejection_status_line`]) is `! [rejected]` and whose end is `(stale info)` (`<src>
/// -> <dest>` and `(delete) -> <dest>` alike). Server text arrives behind `remote:`, so it
/// never matches.
pub(crate) fn is_stale_lease_rejection(stderr: &str) -> bool {
    stderr.lines().any(|line| {
        let line = rejection_status_line(line);
        line.starts_with("! [rejected]") && line.ends_with("(stale info)")
    })
}

/// One push-report line, trimmed and without its leading SGR color sequences: under
/// `color.transport=always` git colors the status flag even though the runner pins
/// `color.ui=false`.
pub(crate) fn rejection_status_line(line: &str) -> &str {
    let mut rest = line.trim();
    while let Some(after) = rest.strip_prefix("\x1b[") {
        match after.find(|c: char| !(c.is_ascii_digit() || c == ';')) {
            Some(end) if after[end..].starts_with('m') => rest = &after[end + 1..],
            _ => break,
        }
    }
    rest
}

/// git's `push.default=simple` refusal for an upstream with a different name
/// (`die_push_simple`). git wraps it across lines, so it is matched with every
/// whitespace run collapsed; the runner's `LC_ALL=C` keeps it English.
const PUSH_SIMPLE_NAME_REFUSAL: &str = "does not match the name of your current branch";

fn is_push_simple_name_refusal(stderr: &str) -> bool {
    stderr
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .contains(PUSH_SIMPLE_NAME_REFUSAL)
}

/// The typed refusal for HEAD's branch, built only from tracking re-read now: a live
/// BRANCH upstream on a real remote whose name differs. Anything unconfirmed (detached,
/// a failed read, a non-branch or local `.` upstream) is `None`, so the caller keeps
/// git's own error rather than naming unverified refs.
async fn confirmed_name_mismatch(repo_path: &str) -> Option<AppError> {
    // git's own full ref for HEAD, so the lookup pattern is never rebuilt from a name.
    let refname = crate::git::branches::current_branch_ref(repo_path)
        .await
        .ok()
        .flatten()?;
    let head = refname.strip_prefix("refs/heads/")?.to_string();
    let out = run_git(
        Some(repo_path),
        &["for-each-ref", &refname, UPSTREAM_TRACKING_FORMAT],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    match parse_upstream_tracking(&out.stdout_lossy(), &refname)? {
        (Upstream::Branch(up), remote, false) if up != head && is_named_remote(&remote) => {
            Some(AppError::PushUpstreamNameMismatch {
                branch: head,
                remote,
                remote_branch: up,
            })
        }
        _ => None,
    }
}

/// Companion to `--force-with-lease`: git refuses the push unless the remote tip
/// is already incorporated into the local branch, so a background fetch can't
/// satisfy the lease on a teammate's unseen work. Git 2.30+.
pub(super) const FORCE_IF_INCLUDES: &str = "--force-if-includes";

/// git's per-ref reason when `--force-if-includes` finds the remote tip missing
/// from the local branch's reflog — verbatim from `! [rejected] … (…)`.
const IF_INCLUDES_REJECTION: &str = "remote ref updated since checkout";

/// The local branch a push targeted: the caller's explicit name, else HEAD's own
/// branch. `None` on a detached HEAD (and on a spawn failure) — no branch means
/// no reflog to reason about, so callers must not retry. Git itself walks the
/// local ref named after the DESTINATION when one exists (measured); the source
/// name probed here covers the app's same-name default — see the arm's comment.
/// Every consumer here rebuilds `refs/heads/<name>` from the result.
async fn pushed_branch(repo_path: &str, branch: Option<&str>) -> Option<String> {
    if let Some(b) = branch {
        return Some(b.to_string());
    }
    crate::git::branches::current_branch_name(repo_path)
        .await
        .ok()
        .flatten()
}

/// Whether `refs/heads/<branch>` has a reflog (`git reflog exists`, exit 0/1). An
/// unrunnable probe counts as "has one": the degrading retry only fires on
/// positive proof that `--force-if-includes` had nothing to walk.
async fn branch_has_reflog(repo_path: &str, branch: &str) -> bool {
    run_git_raw(
        Some(repo_path),
        &["reflog", "exists", &format!("refs/heads/{branch}")],
        DEFAULT_TIMEOUT,
    )
    .await
    .map_or(true, |out| out.code == 0)
}

/// Whether git rejected an unknown command-line option — for a push, the signal
/// that this git predates `--force-if-includes` (2.30). The matched text is the
/// runner's `full_failure_text`, which can carry remote-relayed lines, so a
/// server-echoed phrase triggers the retry too; that only degrades to the lease.
fn is_unknown_push_option(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("unknown switch")
        || lower.contains("unknown option")
        || lower.contains("usage: git push")
}

/// The push argv minus `--force-if-includes`, everything else kept in order.
fn without_force_if_includes<'a>(argv: &[&'a str]) -> Vec<&'a str> {
    argv.iter()
        .copied()
        .filter(|a| *a != FORCE_IF_INCLUDES)
        .collect()
}

/// The push-destination contract, the one routing rule every named push follows: an
/// explicit remote always wins and the push configuration is never read for it; else
/// `branch.<b>.pushRemote`, else `remote.pushDefault` (a set, unusable value is
/// [`PushRemoteUnusable`](AppError::PushRemoteUnusable), never a fallback); else the
/// LIVE upstream's remote; else `origin`. The destination branch is the upstream's name
/// only when the push goes to the upstream's own remote; anywhere else it is the local
/// name. The HEAD `-u` publish takes the configured push remote, else origin, never the
/// upstream's remote. The bare and force HEAD pushes follow git's own routing instead,
/// pinned to the branch (and, for a force push, the tip) they were pressed on.
///
/// Out of the contract, with their status (counts are of the owner's 109 repos, measured
/// when the status read's destination claim shipped):
/// 1. a push remote with its own push refspecs (0): documented, git's bare push sends them;
/// 2. several pushurls (0): documented;
/// 3. a narrow or remapped fetch refspec (1, a fixture): documented;
/// 4. a git without the `%(push)` atoms (unmeasured): documented, destinations read unknown;
/// 5. force pushes: closed by the branch and tip pins;
/// 6. presence as last-fetch remote-tracking state: open, no network read before a push;
///    the create-only lease bounds its damage on the arms that set the upstream. A single
///    pushurl naming another repository than the fetch URL is this class too: the
///    presence read describes the fetch side.
///
/// The lease's presence probe can misread two shapes: a remote whose name contains a
/// slash (`refs/remotes/a/b/c` is both remote `a/b` branch `c` and remote `a` branch
/// `b/c`, so a present answer may belong to the other and the lease is not armed), and a
/// remapped fetch refspec (the tracking ref lives elsewhere, so the probe reads absent
/// and the lease arms, which can only refuse).
///
/// Pure so the decision table stays unit-testable; shared by the argv builder, the
/// policy's refusals and [`NamedPushRouting::destination`], so there is one resolver.
fn resolve_push_target<'a>(
    requested_remote: Option<&'a str>,
    configured: Option<&'a str>,
    remotename: &'a str,
    gone: bool,
) -> &'a str {
    match requested_remote.or(configured) {
        Some(r) => r,
        None if !remotename.is_empty() && !gone => remotename,
        None => "origin",
    }
}

/// The upstream remote a named push naming no remote, with no configured push remote,
/// routes by; the argv builder and [`NamedPushRouting::destination`] both read it, so the
/// row and the push agree. It is `remotename` except on an untracked read, which publishes
/// by D2 (the empty answer: the configured push remote, else origin) when
/// `branch.<b>.remote` names a listed remote, or holds a value with a leading `.`, or one
/// holding `/`, a backslash or `:`; any other unlisted name is `unknown remote` (never a
/// silent retarget at origin). The HEAD publish applies the same refusal
/// ([`head_push_remote`]).
fn untracked_branch_remote(
    config: &crate::git::status::PushConfig,
    remotes: &[String],
    branch: &str,
    upstream: &Upstream,
    remotename: &str,
) -> AppResult<String> {
    if !matches!(upstream, Upstream::Untracked) || !remotename.is_empty() {
        return Ok(remotename.to_string());
    }
    let Some(name) = config.branch_remote(branch).filter(|n| !n.is_empty()) else {
        return Ok(String::new());
    };
    let url_or_path =
        name.starts_with('.') || name.contains('/') || name.contains(':') || name.contains('\\');
    if remotes.iter().any(|r| r == name) || url_or_path {
        return Ok(String::new());
    }
    Err(AppError::InvalidArgument(format!("unknown remote: {name}")))
}

/// The tracked arm's destination, shared by the argv builder and the MCP policy: the
/// upstream's branch, only when the push goes to the upstream's own remote.
fn tracked_push_upstream<'a>(
    upstream: &'a Upstream,
    remotename: &str,
    gone: bool,
    set_upstream: bool,
    requested_remote: Option<&str>,
    configured: Option<&str>,
    remote_branch: Option<&str>,
) -> Option<&'a str> {
    match upstream {
        Upstream::Branch(up)
            if !gone
                && !set_upstream
                && remote_branch.is_none()
                && resolve_push_target(requested_remote, configured, remotename, gone)
                    == remotename =>
        {
            Some(up)
        }
        _ => None,
    }
}

/// Refuse only cross-name tracked destinations on named remotes; local tracking
/// has no remote destination for the MCP remedy to offer.
#[allow(clippy::too_many_arguments)] // the tracking inputs plus the push's routing
fn cross_name_refusal<'a>(
    branch: &str,
    upstream: &'a Upstream,
    remotename: &str,
    gone: bool,
    set_upstream: bool,
    requested_remote: Option<&str>,
    configured: Option<&str>,
    remote_branch: Option<&str>,
) -> Option<&'a str> {
    if !is_named_remote(remotename) {
        return None;
    }
    tracked_push_upstream(
        upstream,
        remotename,
        gone,
        set_upstream,
        requested_remote,
        configured,
        remote_branch,
    )
    .filter(|up| *up != branch)
}

/// One named-branch push's routing inputs, from its tracking read and the caller.
///
/// - `upstream`: what the branch tracks, see [`parse_upstream_tracking`];
/// - `remotename`: `%(upstream:remotename)` (the tracked upstream's remote);
/// - `gone`: the tracked ref was deleted (`[gone]`);
/// - `requested`: an explicit push target, which always wins;
/// - `configured`: the validated configured push remote, consulted only without one;
/// - `remote_branch`: an explicit DESTINATION branch name, only ever with `requested`.
#[derive(Clone, Copy, Debug)]
struct NamedRoute<'a> {
    branch: &'a str,
    upstream: &'a Upstream,
    remotename: &'a str,
    gone: bool,
    set_upstream: bool,
    requested: Option<&'a str>,
    configured: Option<&'a str>,
    remote_branch: Option<&'a str>,
}

impl<'a> NamedRoute<'a> {
    /// The remote `T` the push goes to ([`resolve_push_target`]).
    fn target(&self) -> &'a str {
        resolve_push_target(self.requested, self.configured, self.remotename, self.gone)
    }

    fn tracked(&self) -> Option<&'a str> {
        tracked_push_upstream(
            self.upstream,
            self.remotename,
            self.gone,
            self.set_upstream,
            self.requested,
            self.configured,
            self.remote_branch,
        )
    }

    /// Whether the push publishes and tracks (`-u`): untracked, gone, or asked to, never
    /// with an explicit destination; a non-branch upstream retracks only on request.
    fn publishes(&self) -> bool {
        self.remote_branch.is_none()
            && match self.upstream {
                Upstream::Untracked => true,
                Upstream::Branch(_) => self.gone || self.set_upstream,
                Upstream::NotABranch => self.set_upstream,
            }
    }

    /// The destination branch: the named one, else the tracked upstream's, else the
    /// local name.
    fn dest(&self) -> &'a str {
        self.remote_branch
            .or_else(|| self.tracked())
            .unwrap_or(self.branch)
    }

    /// The routing refusals, in order, against `T`: a mirror remote, a local `.`
    /// upstream, a destination in gd/session/, the MCP policy's cross-name refusal, a
    /// remote that is not one of `remotes` or fails `validate_ref_name`, and a destination
    /// that would fail it as the full ref `refs/heads/<dest>`. Answers `T`.
    fn refuse(
        &self,
        config: &crate::git::status::PushConfig,
        remotes: &[String],
        cross_name: CrossNameUpstream,
    ) -> AppResult<String> {
        let target = self.target();
        crate::git::status::mirror_refusal(config, crate::git::status::PushRemote::Named(target))?;
        // A live `.` upstream targets this repository (an explicit remote never is `.`),
        // set_upstream included.
        if let (".", Upstream::Branch(up)) = (target, self.upstream) {
            return Err(AppError::PushUpstreamIsLocal {
                branch: self.branch.to_string(),
                upstream: up.clone(),
            });
        }
        // The local name is already checked; before the cross-name refusal, so both
        // policies answer with the session copy.
        if is_named_remote(target) {
            refuse_session_destination(self.branch, target, self.dest())?;
        }
        if cross_name == CrossNameUpstream::Refuse {
            if let Some(up) = cross_name_refusal(
                self.branch,
                self.upstream,
                self.remotename,
                self.gone,
                self.set_upstream,
                self.requested,
                self.configured,
                self.remote_branch,
            ) {
                return Err(AppError::PushUpstreamNameMismatch {
                    branch: self.branch.to_string(),
                    remote: self.remotename.to_string(),
                    remote_branch: up.to_string(),
                });
            }
        }
        // Both names can come from config and reach argv: the remote bare, where `-x` would
        // read as an option; the destination only behind `refs/heads/`, where a leading dash
        // is valid, so it passes exactly where that full ref passes `validate_ref_name`.
        if !remotes.iter().any(|r| r == target) {
            return Err(AppError::InvalidArgument(format!(
                "unknown remote: {target}"
            )));
        }
        if crate::git::branches::validate_ref_name(target).is_err() {
            return Err(AppError::InvalidArgument(format!(
                "invalid remote name: {target}"
            )));
        }
        let dest = self.dest();
        let body = dest.trim_start_matches('-');
        let bad = !body.is_empty() && crate::git::branches::validate_ref_name(body).is_err();
        if dest.is_empty() || bad {
            return Err(AppError::InvalidArgument(format!(
                "invalid branch name: {dest}"
            )));
        }
        Ok(target.to_string())
    }

    fn argv(&self, force: bool, lease: CreateLease) -> Vec<String> {
        build_push_args(self, force, lease)
    }
}

/// When a non-force named push carries the create-only lease: on the caller's `creates`
/// on any arm, and on an arm that sets the upstream whenever the destination's tracking
/// ref is not proven present (`dest_tracked`).
#[derive(Clone, Copy, Debug, PartialEq)]
struct CreateLease {
    creates: bool,
    dest_tracked: bool,
}

impl CreateLease {
    /// Never leased: no create recorded, the destination proven tracked.
    #[cfg(test)]
    const NONE: Self = CreateLease {
        creates: false,
        dest_tracked: true,
    };
}

/// `--force-with-lease=refs/heads/<dest>:` (empty expected value): git refuses the push
/// unless `dest` is absent on the remote or already at the pushed commit.
fn create_lease_arg(dest: &str) -> String {
    format!("--force-with-lease=refs/heads/{dest}:")
}

/// `--force-with-lease=refs/heads/<dest>:<sha>`, the lease pinned to an explicit tip.
fn pinned_lease_arg(dest: &str, sha: &str) -> String {
    format!("--force-with-lease=refs/heads/{dest}:{sha}")
}

/// A HEAD push's argv up to its `-u` part: a force push takes the lease pinned to
/// `lease_pin` alone, else the lease plus `--force-if-includes`, which refuses to clobber
/// remote work this branch hasn't integrated (a bare lease is satisfied by any fetch).
fn head_push_argv(force: bool, lease_pin: Option<&LeasePin>) -> Vec<String> {
    let mut a = vec!["push".to_string()];
    match (force, lease_pin) {
        (true, Some(pin)) => a.push(pinned_lease_arg(&pin.dest, &pin.sha)),
        (true, None) => {
            a.push("--force-with-lease".to_string());
            a.push(FORCE_IF_INCLUDES.to_string());
        }
        (false, _) => {}
    }
    a
}

/// Whether `refs/remotes/<remote>/<branch>` exists (`show-ref --verify --quiet` exit 0).
/// Any other answer, a failed spawn included, reads absent: that arms the create-only
/// lease, which can only refuse a destination that differs.
async fn tracking_ref_present(repo_path: &str, remote: &str, branch: &str) -> bool {
    let tracking = format!("refs/remotes/{remote}/{branch}");
    run_git_raw(
        Some(repo_path),
        &["show-ref", "--verify", "--quiet", &tracking],
        DEFAULT_TIMEOUT,
    )
    .await
    .is_ok_and(|out| out.code == 0)
}

/// Decide the `git push` args for pushing a NAMED local branch, from its
/// [`NamedRoute`]. Pure — no git calls — so the decision table is unit-testable.
///
/// The target `T` is [`resolve_push_target`]. Rules:
/// - `remote_branch` = `rb` → `push T refs/heads/<branch>:refs/heads/<rb>`, no `-u`:
///   an explicitly named destination pins the refspec and leaves tracking alone.
/// - untracked / gone branch / `set_upstream` → `-u T
///   refs/heads/<branch>:refs/heads/<branch>` (publish + track). A *gone* upstream
///   publishes under the LOCAL name, deliberately not resurrecting a differently-named
///   deleted ref.
/// - tracked branch `up` and `T == remotename`: `push T
///   refs/heads/<branch>:refs/heads/<up>` (a bare `push T <branch>` would advance the
///   WRONG remote ref when the names differ).
/// - tracked and `T != remotename` (a configured push remote, or an explicit copy
///   elsewhere), or a non-branch upstream: `push T refs/heads/<branch>:refs/heads/<branch>`
///   with NO `-u` — the local name, upstream config untouched.
///
/// Refspecs are fully qualified so a branch named `+x`/`-x` can't be read as a
/// force/delete indicator; the remote is only ever the bare `push <remote>` arg.
/// `force` prepends `--force-with-lease --force-if-includes` in every arm and never
/// takes the create-only lease, which otherwise sits ahead of `-u` and the remote.
fn build_push_args(route: &NamedRoute<'_>, force: bool, lease: CreateLease) -> Vec<String> {
    let branch = route.branch;
    let publish = route.publishes();
    let dest = route.dest();
    let mut args = vec!["push".to_string()];
    if force {
        args.push("--force-with-lease".to_string());
        args.push(FORCE_IF_INCLUDES.to_string());
    } else if lease.creates || (publish && !lease.dest_tracked) {
        args.push(create_lease_arg(dest));
    }
    if publish {
        args.push("-u".to_string());
    }
    args.push(route.target().to_string());
    args.push(format!("refs/heads/{branch}:refs/heads/{dest}"));
    args
}

/// Where a named push of a branch goes under the routing rule, for the branch list.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum NamedPushDestination {
    To {
        remote: String,
        branch: String,
    },
    /// Refused for a routing reason (see [`NamedPushRouting::destination`]).
    Refused,
}

/// The two reads [`NamedPushRouting::destination`] decides on, read once per listing.
pub(crate) struct NamedPushRouting {
    config: crate::git::status::PushConfig,
    remotes: Vec<String>,
}

/// One push-config listing plus the repository's remotes.
pub(crate) async fn named_push_routing(repo_path: &str) -> AppResult<NamedPushRouting> {
    Ok(NamedPushRouting {
        config: crate::git::status::push_config_strict(repo_path).await?,
        remotes: git_remotes(repo_path.to_string()).await?,
    })
}

impl NamedPushRouting {
    /// Where a GUI push of `branch` naming no remote and asking no retrack lands, through
    /// the same functions that build its argv. `Refused` exactly where that push refuses
    /// for a routing reason: an unusable configured push remote, a `.` remote beside a
    /// branch upstream, a mirror remote, a remote that is not configured, a remote name
    /// that fails `validate_ref_name` or a destination that would fail it as `refs/heads/<dest>`,
    /// a destination in gd/session/, a `branch.<b>.remote` no remote has
    /// ([`untracked_branch_remote`]), or a branch name that fails it or is itself a session
    /// branch. Keep local and an unborn branch are not routing refusals.
    pub(crate) fn destination(
        &self,
        branch: &str,
        upstream: &Upstream,
        remotename: &str,
        gone: bool,
    ) -> NamedPushDestination {
        if crate::git::branches::validate_ref_name(branch).is_err()
            || crate::git::branches::is_session_branch_name(branch)
        {
            return NamedPushDestination::Refused;
        }
        let Ok(configured) = configured_push_remote_checked(&self.config, &self.remotes, branch)
        else {
            return NamedPushDestination::Refused;
        };
        let remotename = match configured {
            Some(_) => remotename.to_string(),
            None => match untracked_branch_remote(
                &self.config,
                &self.remotes,
                branch,
                upstream,
                remotename,
            ) {
                Ok(r) => r,
                Err(_) => return NamedPushDestination::Refused,
            },
        };
        let route = NamedRoute {
            branch,
            upstream,
            remotename: &remotename,
            gone,
            set_upstream: false,
            requested: None,
            configured,
            remote_branch: None,
        };
        match route.refuse(&self.config, &self.remotes, CrossNameUpstream::Follow) {
            Ok(remote) => NamedPushDestination::To {
                remote,
                branch: route.dest().to_string(),
            },
            Err(_) => NamedPushDestination::Refused,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::remote::tests::{
        assert_kept_local, assert_rejection_reason, feat_x_tip, git_push_core_unpinned, init_repo,
        keep_local_origin, pins, run, seeded_origin, seeded_origin_unpinned_push_default,
        temp_base, up, STALE_LEASE_REJECTION,
    };
    use crate::git::runner::{TestGitEnv, TEST_GIT_HANG_GUARD};

    #[test]
    fn push_untracked_publishes_with_upstream() {
        // Empty upstream → first-time publish + track.
        assert_eq!(
            build_push_args_today("feature", &up(""), "", false, false, false, None, None),
            vec!["push", "-u", "origin", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_gone_upstream_publishes_with_upstream() {
        // A deleted upstream ref (still named by %(upstream:remoteref)) republishes.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feature"),
                "origin",
                true,
                false,
                false,
                None,
                None
            ),
            vec![
                "push",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn push_tracked_same_name_plain_push() {
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feature"),
                "origin",
                false,
                false,
                false,
                None,
                None
            ),
            vec!["push", "origin", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_tracked_different_name_uses_refspec() {
        // Local `feature` tracks `origin/feat` → explicit refspec so we advance
        // the right remote ref, not `origin/feature`.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                false,
                false,
                false,
                None,
                None
            ),
            vec!["push", "origin", "refs/heads/feature:refs/heads/feat"]
        );
    }

    #[test]
    fn push_tracked_non_origin_default_targets_own_remote() {
        // No requested remote + a branch tracking a fork's `upstream/main` targets
        // its OWN remote: T == remotename → the refspec-to-`up` arm.
        assert_eq!(
            build_push_args_today(
                "main",
                &up("main"),
                "upstream",
                false,
                false,
                false,
                None,
                None
            ),
            vec!["push", "upstream", "refs/heads/main:refs/heads/main"]
        );
    }

    #[test]
    fn push_requested_remote_matches_tracked_remote() {
        // Explicitly requesting the branch's OWN tracked remote is the same arm:
        // T == remotename → advance the tracked remote-branch name explicitly.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                false,
                false,
                false,
                Some("origin"),
                None
            ),
            vec!["push", "origin", "refs/heads/feature:refs/heads/feat"]
        );
    }

    #[test]
    fn push_requested_remote_differs_from_tracked_remote() {
        // A tracked-on-origin branch pushed explicitly to `upstream` → a copy under
        // the LOCAL name, no `-u`, upstream config untouched.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                false,
                false,
                false,
                Some("upstream"),
                None
            ),
            vec!["push", "upstream", "refs/heads/feature:refs/heads/feature"]
        );
    }

    #[test]
    fn push_requested_remote_on_untracked_publish() {
        // Publishing an untracked branch to a chosen remote: `-u <remote>` under
        // the local name.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up(""),
                "",
                false,
                false,
                false,
                Some("fork"),
                None
            ),
            vec![
                "push",
                "-u",
                "fork",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn push_set_upstream_forces_upstream_form_even_when_tracked() {
        // An explicit set_upstream request retracks even a tracked branch.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feature"),
                "origin",
                false,
                true,
                false,
                None,
                None
            ),
            vec![
                "push",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn push_force_flag_precedes_refspec_args() {
        // The force pair sits right after `push`, before the refspec.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                false,
                false,
                true,
                None,
                None
            ),
            vec![
                "push",
                "--force-with-lease",
                "--force-if-includes",
                "origin",
                "refs/heads/feature:refs/heads/feat"
            ]
        );
        assert_eq!(
            build_push_args_today("feature", &up(""), "", false, false, true, None, None),
            vec![
                "push",
                "--force-with-lease",
                "--force-if-includes",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn push_force_flag_precedes_refspec_on_requested_remote() {
        // Force + a requested non-tracked remote: the force pair still sits right
        // after `push`, then the bare remote, then the fully-qualified refspec.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                false,
                false,
                true,
                Some("upstream"),
                None
            ),
            vec![
                "push",
                "--force-with-lease",
                "--force-if-includes",
                "upstream",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn unknown_push_option_matches_gits_phrasings_only() {
        assert!(is_unknown_push_option("error: unknown option `force-if-includes'"));
        assert!(is_unknown_push_option(
            "fatal: unknown switch `force-if-includes'"
        ));
        assert!(is_unknown_push_option(
            "usage: git push [<options>] [<repository> [<refspec>...]]"
        ));
        // A real rejection must NOT trigger the pre-2.30 retry.
        assert!(!is_unknown_push_option(
            " ! [rejected]        feature -> feature (stale info)\nerror: failed to push some refs to 'C:/temp/remote.git'"
        ));
    }

    #[test]
    fn strip_removes_only_the_if_includes_flag() {
        assert_eq!(
            without_force_if_includes(&[
                "push",
                "--force-with-lease",
                "--force-if-includes",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature",
            ]),
            vec![
                "push",
                "--force-with-lease",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
        // Nothing to strip: the argv survives untouched.
        assert_eq!(
            without_force_if_includes(&["push", "-u", "origin", "HEAD"]),
            vec!["push", "-u", "origin", "HEAD"]
        );
    }

    #[test]
    fn named_push_policy_agrees_with_every_destination_arm() {
        use Upstream::{Branch, NotABranch, Untracked};

        let cases = [
            (
                "default remote", Branch("main".into()), "origin", false, false, None, None,
                Some("main"), Some("main"), vec!["push", "origin", "refs/heads/x:refs/heads/main"],
            ),
            (
                "explicit equal remote", Branch("main".into()), "origin", false, false,
                Some("origin"), None, Some("main"), Some("main"),
                vec!["push", "origin", "refs/heads/x:refs/heads/main"],
            ),
            (
                "same name", Branch("x".into()), "origin", false, false, None, None,
                Some("x"), None, vec!["push", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "gone", Branch("main".into()), "origin", true, false, None, None,
                None, None, vec!["push", "-u", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "publish", Branch("main".into()), "origin", false, true, None, None,
                None, None, vec!["push", "-u", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "different remote", Branch("main".into()), "upstream", false, false,
                Some("origin"), None, None, None,
                vec!["push", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "untracked", Untracked, "", false, false, None, None, None, None,
                vec!["push", "-u", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "non-branch", NotABranch, "origin", false, false, None, None, None, None,
                vec!["push", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "gone non-branch", NotABranch, "origin", true, false, None, None, None, None,
                vec!["push", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "publish non-branch", NotABranch, "origin", false, true, None, None, None, None,
                vec!["push", "-u", "origin", "refs/heads/x:refs/heads/x"],
            ),
            (
                "local upstream", Branch("main".into()), ".", false, false, None, None,
                Some("main"), None, vec!["push", ".", "refs/heads/x:refs/heads/main"],
            ),
            (
                "explicit destination", Branch("main".into()), "origin", false, false,
                Some("origin"), Some("main"), None, None,
                vec!["push", "origin", "refs/heads/x:refs/heads/main"],
            ),
            (
                "explicit destination overrides publish", Branch("main".into()), "origin",
                true, true, Some("origin"), Some("main"), None, None,
                vec!["push", "origin", "refs/heads/x:refs/heads/main"],
            ),
        ];
        for (label, upstream, remote, gone, set, requested, destination, tracked, refuse, argv)
            in cases
        {
            let actual =
                tracked_push_upstream(&upstream, remote, gone, set, requested, None, destination);
            assert_eq!(actual, tracked, "{label}");
            assert_eq!(
                cross_name_refusal(
                    "x",
                    &upstream,
                    remote,
                    gone,
                    set,
                    requested,
                    None,
                    destination
                ),
                refuse,
                "{label}",
            );
            assert_eq!(
                build_push_args_today(
                    "x",
                    &upstream,
                    remote,
                    gone,
                    set,
                    false,
                    requested,
                    destination
                ),
                argv,
                "{label}",
            );
        }
    }

    #[tokio::test]
    async fn named_push_refuses_cross_name_upstream_but_follow_keeps_destination() {
        let (_guard, base, origin, _url) = seeded_origin("named-push-policy").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["checkout", "-q", "-b", "x", "origin/main"]).await;
        run(&work, &["commit", "-qm", "on x", "--allow-empty"]).await;
        let old_main = run(&origin, &["rev-parse", "refs/heads/main"]).await;
        let tip = run(&work, &["rev-parse", "refs/heads/x"]).await;
        assert_ne!(old_main, tip);
        let state = AppState::default();

        for remote in [None, Some("origin".to_string())] {
            let result = git_push_same_name_core(
                &state,
                work.clone(),
                false,
                Some("x".into()),
                remote,
            )
            .await;
            let main = run(&origin, &["rev-parse", "refs/heads/main"]).await;
            assert!(result.is_err(), "named push must refuse a cross-name upstream");
            assert_eq!(main, old_main);
            let err = result.unwrap_err();
            assert!(
                matches!(
                    &err,
                    AppError::PushUpstreamNameMismatch { branch, remote, remote_branch }
                        if branch == "x" && remote == "origin" && remote_branch == "main"
                ),
                "{err:?}",
            );
        }

        git_push_core_unpinned(&state, work, false, false, Some("x".into()), None, None)
            .await
            .expect("Follow pushes to the tracked destination");
        assert_eq!(run(&origin, &["rev-parse", "refs/heads/main"]).await, tip);
    }

    #[tokio::test]
    async fn head_push_refuses_session_publish_in_core() {
        let (_guard, base, _origin, _url) = seeded_origin("session-publish").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["checkout", "-q", "-b", "GD/Session/Mixed"]).await;
        run(&work, &["config", "push.autoSetupRemote", "true"]).await;
        let state = AppState::default();
        for (set_upstream, force, mcp_core) in [
            (true, false, false),
            (false, false, false),
            (false, true, false),
            (false, true, true),
        ] {
            let result = if mcp_core {
                super::git_force_push_head_core(&state, work.clone())
                    .await
                    .map(super::PushGuardWire::from)
            } else {
                git_push_core_unpinned(&state, work.clone(), set_upstream, force, None, None, None)
                    .await
            };
            match result.expect_err("session HEAD must not publish") {
                e @ AppError::BranchIsAgentSession { .. } => assert_eq!(
                    e.to_string(),
                    "\"GD/Session/Mixed\" is in gd/session/, which is reserved for agent sessions, so GitDesktop won't push or publish it."
                ),
                other => panic!("expected the publishing refusal, got {other:?}"),
            }
            assert!(!run(&work, &["ls-remote", "origin"])
                .await
                .to_ascii_lowercase()
                .contains("gd/session/"));
        }
    }

    #[tokio::test]
    async fn named_push_refuses_session_publish_in_core() {
        let (_guard, base, _origin, _url) = seeded_origin("session-publish-named").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["branch", "gd/session/abc"]).await;
        let error = git_push_core_unpinned(
            &AppState::default(),
            work.clone(),
            true,
            false,
            Some("gd/session/abc".into()),
            None,
            None,
        )
        .await
        .expect_err("named session branch must not publish");
        match error {
            e @ AppError::BranchIsAgentSession { .. } => assert_eq!(
                e.to_string(),
                "\"gd/session/abc\" is in gd/session/, which is reserved for agent sessions, so GitDesktop won't push or publish it."
            ),
            other => panic!("expected the publishing refusal, got {other:?}"),
        }
        assert!(!run(&work, &["ls-remote", "origin"])
            .await
            .to_ascii_lowercase()
            .contains("gd/session/"));
    }

    /// Every GUI push arm refuses a marked branch before git runs and lands nothing; with
    /// the mark off, the same push lands.
    #[tokio::test]
    async fn keep_local_refuses_every_push_arm_and_the_unmarked_twin_lands() {
        let (_guard, work, origin) = keep_local_origin("keep-local-arms").await;
        let state = AppState::default();
        let published = run(&origin, &["rev-parse", "refs/heads/feat/x"])
            .await
            .trim()
            .to_string();
        let some = |s: &str| Some(s.to_string());
        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", true)
            .await
            .unwrap();
        for (row, set_upstream, force, branch, remote, remote_branch) in [
            ("HEAD bare", false, false, None, None, None),
            ("HEAD forced", false, true, None, None, None),
            ("HEAD -u", true, false, None, None, None),
            ("named", false, false, some("feat/x"), None, None),
            (
                "named + remote",
                false,
                false,
                some("feat/x"),
                some("origin"),
                None,
            ),
            (
                "named + remote branch",
                true,
                false,
                some("feat/x"),
                some("origin"),
                some("other"),
            ),
        ] {
            let result = git_push_core_unpinned(
                &state,
                work.clone(),
                set_upstream,
                force,
                branch,
                remote,
                remote_branch,
            )
            .await;
            assert_kept_local(result, "feat/x", row);
        }
        assert_kept_local(
            super::git_force_push_head_core(&state, work.clone()).await,
            "feat/x",
            "MCP force core",
        );
        assert_kept_local(
            git_push_same_name_core(&state, work.clone(), false, Some("feat/x".into()), None).await,
            "feat/x",
            "MCP named core",
        );
        // The remote default, marked and pushed by name from another branch.
        crate::git::branches::set_branch_keep_local_core(&work, "main", true)
            .await
            .unwrap();
        assert_kept_local(
            git_push_core_unpinned(
                &state,
                work.clone(),
                false,
                false,
                Some("main".into()),
                None,
                None,
            )
            .await,
            "main",
            "remote default",
        );
        let refs = run(&work, &["ls-remote", "origin"]).await;
        assert!(
            refs.contains(&format!("{published}\trefs/heads/feat/x")),
            "{refs}"
        );
        assert!(!refs.contains("refs/heads/other"), "{refs}");

        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", false)
            .await
            .unwrap();
        git_push_core_unpinned(&state, work.clone(), false, false, None, None, None)
            .await
            .expect("the unmarked twin lands");
        assert_eq!(
            run(&origin, &["rev-parse", "refs/heads/feat/x"]).await,
            run(&work, &["rev-parse", "refs/heads/feat/x"]).await
        );
    }

    /// A bare or forced HEAD push pressed on an unmarked branch re-reads the mark at spawn:
    /// a switch to a marked branch during the lock wait refuses, and nothing lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn keep_local_queued_head_push_rechecks_at_spawn() {
        use crate::git::runner::acquire_repo_lock;
        let (_guard, work, origin) = keep_local_origin("keep-local-queued").await;
        run(&work, &["config", "push.autoSetupRemote", "true"]).await;
        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", true)
            .await
            .unwrap();
        let published = run(&origin, &["rev-parse", "refs/heads/feat/x"])
            .await
            .trim()
            .to_string();
        for force in [false, true] {
            run(&work, &["switch", "-q", "-C", "pressed"]).await;
            let state = std::sync::Arc::new(AppState::default());
            let domain = state.network_lock(&work).await;
            let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
                .await
                .expect("the network domain is free");
            let (queued_tx, queued_rx) = tokio::sync::oneshot::channel::<()>();
            let queued_tx = std::sync::Mutex::new(Some(queued_tx));
            let queued: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
                if let Some(tx) = queued_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            });
            let push = tokio::spawn({
                let (state, work) = (std::sync::Arc::clone(&state), work.clone());
                let run = async move {
                    if force {
                        super::git_force_push_head_core(&state, work)
                            .await
                            .map(super::PushGuardWire::from)
                    } else {
                        git_push_core_unpinned(&state, work, false, false, None, None, None).await
                    }
                };
                NETWORK_LOCK_WAIT_HOOK.scope(queued, run)
            });
            queued_rx.await.expect("the push reached the network lock");
            run(&work, &["switch", "-q", "feat/x"]).await;
            drop(held);
            let result = tokio::time::timeout(Duration::from_secs(60), push)
                .await
                .expect("the push finishes once the domain frees")
                .unwrap();
            assert_kept_local(result, "feat/x", &format!("force={force}"));
            let pushed = run(&work, &["ls-remote", "origin"]).await;
            assert!(!pushed.contains("pressed"), "force={force}: {pushed}");
            assert!(
                pushed.contains(&format!("{published}\trefs/heads/feat/x")),
                "force={force}: {pushed}"
            );
        }
    }

    /// A marked HEAD is refused by the early check, before the network lock: with the
    /// domain held, a bare and a forced push return the refusal without ever queueing.
    #[tokio::test(flavor = "multi_thread")]
    async fn keep_local_early_head_check_refuses_before_the_network_lock() {
        use crate::git::runner::acquire_repo_lock;
        let (_guard, work, _origin) = keep_local_origin("keep-local-early").await;
        crate::git::branches::set_branch_keep_local_core(&work, "feat/x", true)
            .await
            .unwrap();
        let state = std::sync::Arc::new(AppState::default());
        let domain = state.network_lock(&work).await;
        let _held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
            .await
            .expect("the network domain is free");
        for force in [false, true] {
            let queued = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
                let queued = std::sync::Arc::clone(&queued);
                move || queued.store(true, std::sync::atomic::Ordering::SeqCst)
            });
            let (state, work) = (std::sync::Arc::clone(&state), work.clone());
            let push = async move {
                if force {
                    super::git_force_push_head_core(&state, work)
                        .await
                        .map(super::PushGuardWire::from)
                } else {
                    git_push_core_unpinned(&state, work, false, false, None, None, None).await
                }
            };
            let result = tokio::time::timeout(
                Duration::from_secs(30),
                NETWORK_LOCK_WAIT_HOOK.scope(hook, push),
            )
            .await
            .unwrap_or_else(|_| panic!("force={force}: the refusal waited on the held lock"));
            assert_kept_local(result, "feat/x", &format!("force={force}"));
            assert!(
                !queued.load(std::sync::atomic::Ordering::SeqCst),
                "force={force}: the push reached the network lock"
            );
        }
    }

    /// A push pinned to a branch (named, a named publish, a HEAD publish pinned to its
    /// branch) re-reads the mark at spawn: a mark set while it waits on the network lock
    /// refuses and nothing lands; with no mark set, the same push lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn keep_local_pinned_push_rechecks_the_mark_at_spawn() {
        let (_guard, work, origin) = keep_local_origin("keep-local-pinned").await;
        let state = AppState::default();
        let tip = |repo: String| async move {
            run(&repo, &["rev-parse", "refs/heads/feat/x"])
                .await
                .trim()
                .to_string()
        };
        for (row, set_upstream, branch, remote) in [
            ("named", false, Some("feat/x"), None),
            ("named publish", true, Some("feat/x"), Some("origin")),
            ("pinned HEAD publish", true, None, None),
        ] {
            run(&work, &["commit", "-q", "--allow-empty", "-m", row]).await;
            let published = tip(origin.clone()).await;
            for mark in [true, false] {
                let fired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
                    let (fired, work) = (std::sync::Arc::clone(&fired), work.clone());
                    move || {
                        fired.store(true, std::sync::atomic::Ordering::SeqCst);
                        if mark {
                            let key = crate::git::branches::keep_local_key("feat/x");
                            let set = std::process::Command::new("git")
                                .test_git_env()
                                .current_dir(&work)
                                .args(["config", &key, "true"])
                                .status()
                                .unwrap();
                            assert!(set.success(), "the mark is set during the wait");
                        }
                    }
                });
                let push = git_push_core_unpinned(
                    &state,
                    work.clone(),
                    set_upstream,
                    false,
                    branch.map(str::to_string),
                    remote.map(str::to_string),
                    None,
                );
                let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
                let row = format!("{row}, mark={mark}");
                assert!(fired.load(std::sync::atomic::Ordering::SeqCst), "{row}");
                if mark {
                    assert_kept_local(result, "feat/x", &row);
                    assert_eq!(tip(origin.clone()).await, published, "{row}");
                    crate::git::branches::set_branch_keep_local_core(&work, "feat/x", false)
                        .await
                        .unwrap();
                } else {
                    result.unwrap_or_else(|e| panic!("{row}: the unmarked twin lands: {e:?}"));
                    assert_eq!(tip(origin.clone()).await, tip(work.clone()).await, "{row}");
                }
            }
        }
    }

    /// [`keep_local_origin`] plus a second bare remote, both pinned non-mirror, with
    /// `extra` on origin, a branch the clone lacks (a mirror push would delete it).
    /// Returns (guard, work, origin, second).
    async fn mirror_origin(tag: &str) -> (tempfile::TempDir, String, String, String) {
        let (guard, work, origin) = keep_local_origin(tag).await;
        let second = guard
            .path()
            .join("second.git")
            .to_string_lossy()
            .replace('\\', "/");
        run(
            &guard.path().to_string_lossy(),
            &["init", "-q", "--bare", "-b", "main", "second.git"],
        )
        .await;
        run(&work, &["remote", "add", "second", &second]).await;
        run(&work, &["config", "remote.second.mirror", "false"]).await;
        run(&work, &["push", "-q", "second", "main"]).await;
        run(&work, &["push", "-q", "origin", "main:refs/heads/extra"]).await;
        run(&work, &["update-ref", "-d", "refs/remotes/origin/extra"]).await;
        (guard, work, origin, second)
    }

    fn assert_mirror(
        result: crate::error::AppResult<impl std::fmt::Debug>,
        remote: &str,
        row: &str,
    ) {
        match result.expect_err(row) {
            AppError::PushRemoteIsMirror { remote: r } => assert_eq!(r, remote, "{row}"),
            other => panic!("{row}: expected the mirror refusal, got {other:?}"),
        }
    }

    /// Every GUI and MCP push arm refuses a mirror remote before git runs, the remote's
    /// refs untouched (`extra` survives); a mirror on a remote the push doesn't use never
    /// refuses, and the push lands.
    #[tokio::test]
    async fn mirror_refusal_on_every_push_arm_and_the_twin_lands() {
        let (_guard, work, origin, second) = mirror_origin("mirror-arms").await;
        let state = AppState::default();
        let refs_before = run(&origin, &["for-each-ref"]).await;
        let some = |s: &str| Some(s.to_string());
        run(&work, &["config", "remote.origin.mirror", "true"]).await;
        for (row, set_upstream, force, branch, remote, remote_branch) in [
            ("HEAD bare", false, false, None, None, None),
            ("HEAD forced", false, true, None, None, None),
            ("HEAD -u", true, false, None, None, None),
            ("named", false, false, some("feat/x"), None, None),
            (
                "named + remote",
                false,
                false,
                some("feat/x"),
                some("origin"),
                None,
            ),
            (
                "named + remote branch",
                true,
                false,
                some("feat/x"),
                some("origin"),
                some("other"),
            ),
        ] {
            let result = git_push_core_unpinned(
                &state,
                work.clone(),
                set_upstream,
                force,
                branch,
                remote,
                remote_branch,
            )
            .await;
            assert_mirror(result, "origin", row);
        }
        assert_mirror(
            super::git_force_push_head_core(&state, work.clone()).await,
            "origin",
            "MCP force core",
        );
        assert_mirror(
            git_push_same_name_core(&state, work.clone(), false, Some("feat/x".into()), None).await,
            "origin",
            "MCP named core",
        );
        // A detached bare push routes by remote.pushDefault: a mirror there refuses.
        run(&work, &["config", "remote.second.mirror", "true"]).await;
        run(&work, &["config", "remote.pushDefault", "second"]).await;
        run(&work, &["switch", "-q", "--detach", "feat/x"]).await;
        assert_mirror(
            git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await,
            "second",
            "detached pushDefault",
        );
        run(&work, &["switch", "-q", "feat/x"]).await;
        run(&work, &["config", "remote.pushDefault", "origin"]).await;
        assert_eq!(run(&origin, &["for-each-ref"]).await, refs_before);
        assert!(!run(&second, &["for-each-ref"]).await.contains("feat/x"));

        // The twin: the mirror only on `second`, which this push doesn't use.
        run(&work, &["config", "remote.origin.mirror", "false"]).await;
        assert_mirror(
            git_push_core_unpinned(
                &state,
                work.clone(),
                false,
                false,
                some("feat/x"),
                some("second"),
                None,
            )
            .await,
            "second",
            "named on the mirror second",
        );
        git_push_core_unpinned(&state, work.clone(), false, false, None, None, None)
            .await
            .expect("a mirror on another remote doesn't refuse");
        assert_eq!(
            run(&origin, &["rev-parse", "refs/heads/feat/x"]).await,
            run(&work, &["rev-parse", "refs/heads/feat/x"]).await
        );
        assert!(run(&origin, &["for-each-ref"])
            .await
            .contains("refs/heads/extra"));
    }

    /// Remote-branch delete, tag push and tag delete refuse a mirror `origin` before git
    /// runs: the remote branch and tag stay, and the refused tag delete keeps the LOCAL
    /// tag. With the mirror off, each lands.
    #[tokio::test]
    async fn mirror_refusal_on_remote_delete_and_tag_routes() {
        let (_guard, work, origin, _second) = mirror_origin("mirror-delete-tags").await;
        let state = AppState::default();
        run(&work, &["tag", "v1"]).await;
        run(&work, &["push", "-q", "origin", "refs/tags/v1"]).await;
        run(&work, &["tag", "v2"]).await;
        run(&work, &["config", "remote.origin.mirror", "true"]).await;
        assert_mirror(
            crate::git::branches::git_delete_remote_branch_core(
                &state,
                work.clone(),
                "origin".into(),
                "extra".into(),
            )
            .await,
            "origin",
            "remote branch delete",
        );
        assert_mirror(
            crate::git::ops::git_push_tag_core(&state, work.clone(), "v2".into()).await,
            "origin",
            "tag push",
        );
        assert_mirror(
            crate::git::ops::git_delete_tag_core(&state, work.clone(), "v1".into(), true).await,
            "origin",
            "tag delete",
        );
        assert!(
            !run(&work, &["tag", "--list", "v1"]).await.trim().is_empty(),
            "the refused tag delete keeps the local tag"
        );
        let refs = run(&origin, &["for-each-ref"]).await;
        assert!(refs.contains("refs/heads/extra"), "{refs}");
        assert!(refs.contains("refs/tags/v1"), "{refs}");
        assert!(!refs.contains("refs/tags/v2"), "{refs}");

        run(&work, &["config", "remote.origin.mirror", "false"]).await;
        crate::git::branches::git_delete_remote_branch_core(
            &state,
            work.clone(),
            "origin".into(),
            "extra".into(),
        )
        .await
        .expect("the delete lands");
        crate::git::ops::git_push_tag_core(&state, work.clone(), "v2".into())
            .await
            .expect("the tag push lands");
        crate::git::ops::git_delete_tag_core(&state, work.clone(), "v1".into(), true)
            .await
            .expect("the tag delete lands");
        let refs = run(&origin, &["for-each-ref"]).await;
        assert!(!refs.contains("refs/heads/extra"), "{refs}");
        assert!(refs.contains("refs/tags/v2"), "{refs}");
        assert!(!refs.contains("refs/tags/v1"), "{refs}");
    }

    /// A bare or forced HEAD push pressed on a branch that routes to a plain remote
    /// re-reads the route at spawn: a switch during the lock wait to a branch whose
    /// pushRemote is a mirror refuses, and nothing lands there.
    #[tokio::test(flavor = "multi_thread")]
    async fn mirror_refusal_queued_head_push_rechecks_at_spawn() {
        use crate::git::runner::acquire_repo_lock;
        let (_guard, work, _origin, second) = mirror_origin("mirror-queued").await;
        run(&work, &["config", "push.autoSetupRemote", "true"]).await;
        run(&work, &["config", "remote.second.mirror", "true"]).await;
        run(&work, &["config", "branch.feat/x.pushRemote", "second"]).await;
        let second_before = run(&second, &["for-each-ref"]).await;
        for force in [false, true] {
            run(&work, &["switch", "-q", "-C", "pressed"]).await;
            let state = std::sync::Arc::new(AppState::default());
            let domain = state.network_lock(&work).await;
            let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
                .await
                .expect("the network domain is free");
            let (queued_tx, queued_rx) = tokio::sync::oneshot::channel::<()>();
            let queued_tx = std::sync::Mutex::new(Some(queued_tx));
            let queued: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
                if let Some(tx) = queued_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            });
            let push = tokio::spawn({
                let (state, work) = (std::sync::Arc::clone(&state), work.clone());
                let run = async move {
                    if force {
                        super::git_force_push_head_core(&state, work)
                            .await
                            .map(super::PushGuardWire::from)
                    } else {
                        git_push_core_unpinned(&state, work, false, false, None, None, None).await
                    }
                };
                NETWORK_LOCK_WAIT_HOOK.scope(queued, run)
            });
            queued_rx.await.expect("the push reached the network lock");
            run(&work, &["switch", "-q", "feat/x"]).await;
            drop(held);
            let result = tokio::time::timeout(Duration::from_secs(60), push)
                .await
                .expect("the push finishes once the domain frees")
                .unwrap();
            assert_mirror(result, "second", &format!("force={force}"));
            assert_eq!(
                run(&second, &["for-each-ref"]).await,
                second_before,
                "force={force}"
            );
        }
    }

    /// git's last resort for a bare push is the ONLY remote when there is one, whatever its
    /// name: a mirror `up` with no `origin` refuses naming `up`, on a branch and detached,
    /// with `extra` (a branch only `up` holds) kept. Skips when a global config adds a
    /// remote or a push remote, since either moves git's route.
    #[tokio::test]
    async fn mirror_refusal_routes_a_bare_push_to_the_only_remote() {
        let (_guard, base) = temp_base("mirror-only-remote");
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work").to_string_lossy().into_owned();
        let up = base.join("up.git").to_string_lossy().replace('\\', "/");
        run(&base_s, &["init", "-q", "--bare", "-b", "main", "up.git"]).await;
        run(&base_s, &["init", "-q", "-b", "main", "work"]).await;
        for (key, value) in [
            ("user.name", "t"),
            ("user.email", "t@example.com"),
            ("push.default", "simple"),
        ] {
            run(&work, &["config", key, value]).await;
        }
        run(&work, &["remote", "add", "up", &up]).await;
        run(&work, &["config", "remote.up.mirror", "false"]).await;
        let leaked = run(
            &work,
            &["config", "--name-only", "--get-regexp", "^remote\\."],
        )
        .await;
        if leaked.lines().any(|k| !k.starts_with("remote.up.")) {
            eprintln!("skipping: a global config sets {leaked:?}");
            return;
        }
        run(&work, &["commit", "-q", "--allow-empty", "-m", "seed"]).await;
        run(
            &work,
            &["push", "-q", "up", "main", "main:refs/heads/extra"],
        )
        .await;
        run(&work, &["update-ref", "-d", "refs/remotes/up/extra"]).await;
        run(&work, &["switch", "-q", "-c", "loose"]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "ahead"]).await;
        let state = AppState::default();
        let before = run(&up, &["for-each-ref"]).await;

        run(&work, &["config", "remote.up.mirror", "true"]).await;
        assert_mirror(
            git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await,
            "up",
            "untracked bare",
        );
        assert_mirror(
            super::git_force_push_head_core(&state, work.clone()).await,
            "up",
            "untracked forced",
        );
        run(&work, &["switch", "-q", "--detach"]).await;
        assert_mirror(
            git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await,
            "up",
            "detached bare",
        );
        assert_eq!(run(&up, &["for-each-ref"]).await, before);

        // Two remotes, neither `origin`: git routes to `origin`, which is no mirror, and
        // refuses on its own; nothing lands.
        run(&work, &["remote", "add", "second", &up]).await;
        run(&work, &["config", "remote.second.mirror", "false"]).await;
        run(&work, &["switch", "-q", "loose"]).await;
        match git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await {
            Err(AppError::Git { stderr, .. }) => {
                assert!(
                    stderr.contains("No configured push destination"),
                    "{stderr}"
                )
            }
            other => panic!("two remotes: expected git's own refusal, got {other:?}"),
        }
        run(&work, &["remote", "remove", "second"]).await;
        assert_eq!(run(&up, &["for-each-ref"]).await, before);

        // The twins, mirror off: the bare push lands on `up`; detached, git refuses on its own.
        run(&work, &["config", "remote.up.mirror", "false"]).await;
        run(&work, &["config", "push.autoSetupRemote", "true"]).await;
        run(&work, &["switch", "-q", "--detach"]).await;
        match git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await {
            Err(AppError::Git { stderr, .. }) => {
                assert!(stderr.contains("not currently on a branch"), "{stderr}")
            }
            other => panic!("detached twin: expected git's own refusal, got {other:?}"),
        }
        run(&work, &["switch", "-q", "loose"]).await;
        git_push_core_unpinned(&state, work.clone(), false, false, None, None, None)
            .await
            .expect("the bare push lands on the only remote");
        assert_eq!(
            run(&up, &["rev-parse", "refs/heads/loose"]).await,
            run(&work, &["rev-parse", "refs/heads/loose"]).await
        );
        assert!(run(&up, &["for-each-ref"])
            .await
            .contains("refs/heads/extra"));
    }

    /// A bare or force HEAD push re-reads HEAD after its lock wait: a switch to a
    /// session branch while it queues refuses the push, and nothing is published.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_queued_head_push_rechecks_session_publish_at_spawn() {
        use crate::git::runner::acquire_repo_lock;
        let (_guard, base, _origin, _url) = seeded_origin("session-publish-queued").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["config", "push.autoSetupRemote", "true"]).await;
        run(&work, &["branch", "gd/session/x"]).await;
        for force in [false, true] {
            run(&work, &["switch", "-q", "-C", "pressed"]).await;
            let state = std::sync::Arc::new(AppState::default());
            let domain = state.network_lock(&work).await;
            let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
                .await
                .expect("the network domain is free");
            let (queued_tx, queued_rx) = tokio::sync::oneshot::channel::<()>();
            let queued_tx = std::sync::Mutex::new(Some(queued_tx));
            let queued: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
                if let Some(tx) = queued_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            });
            let push = tokio::spawn({
                let (state, work) = (std::sync::Arc::clone(&state), work.clone());
                let run = async move {
                    if force {
                        super::git_force_push_head_core(&state, work)
                            .await
                            .map(super::PushGuardWire::from)
                    } else {
                        git_push_core_unpinned(&state, work, false, false, None, None, None).await
                    }
                };
                NETWORK_LOCK_WAIT_HOOK.scope(queued, run)
            });
            // Past the early check; the push waits on the domain the test holds.
            queued_rx.await.expect("the push reached the network lock");
            run(&work, &["switch", "-q", "gd/session/x"]).await;
            drop(held);
            let result = tokio::time::timeout(Duration::from_secs(60), push)
                .await
                .expect("the push finishes once the domain frees")
                .unwrap();
            match result.expect_err("a session HEAD at spawn must not publish") {
                e @ AppError::BranchIsAgentSession { .. } => assert_eq!(
                    e.to_string(),
                    "\"gd/session/x\" is in gd/session/, which is reserved for agent sessions, so GitDesktop won't push or publish it.",
                    "force={force}"
                ),
                other => panic!("force={force}: expected the publishing refusal, got {other:?}"),
            }
            let pushed = run(&work, &["ls-remote", "origin"]).await;
            assert!(
                !pushed.contains("gd/session/") && !pushed.contains("pressed"),
                "force={force}: {pushed}"
            );
        }
    }

    /// Whether every key reads unset (git exits 1); otherwise logs the skip.
    async fn unset_outside(repo: &str, what: &str, keys: &[&str]) -> bool {
        for key in keys {
            let out = run_git_raw(Some(repo), &["config", "--get", key], TEST_GIT_HANG_GUARD)
                .await
                .unwrap();
            if out.code != 1 {
                eprintln!("skipping {what}: {key} is set outside the fixture");
                return false;
            }
        }
        true
    }

    /// A work repo pinned against a hostile global config: a bare `origin` behind a
    /// three-slash `file:///` URL (mirror off, `remote.pushDefault` pinned to it) holding
    /// `main`, `feature` and the full ref `dest_ref`; HEAD on `topic`, one commit ahead,
    /// tracking `dest_ref`. `None` when `branch.topic.pushRemote` is set outside the
    /// fixture. Returns (guard, work, origin).
    async fn session_destination_origin(
        tag: &str,
        dest_ref: &str,
    ) -> Option<(tempfile::TempDir, String, String)> {
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
        if !unset_outside(&work, "session destination", &["branch.topic.pushRemote"]).await {
            return None;
        }
        for (key, value) in [
            ("user.name", "t"),
            ("user.email", "t@example.com"),
            ("push.default", "simple"),
            ("branch.autoSetupMerge", "false"),
            ("remote.pushDefault", "origin"),
        ] {
            run(&work, &["config", key, value]).await;
        }
        let url = format!("file:///{}", origin.trim_start_matches('/'));
        run(&work, &["remote", "add", "origin", &url]).await;
        run(&work, &["config", "remote.origin.mirror", "false"]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "seed"]).await;
        run(
            &work,
            &["push", "-q", "origin", "main", "main:refs/heads/feature"],
        )
        .await;
        run(&origin, &["update-ref", dest_ref, "refs/heads/main"]).await;
        run(&work, &["fetch", "-q", "origin"]).await;
        run(&work, &["switch", "-q", "-c", "topic"]).await;
        run(&work, &["config", "branch.topic.remote", "origin"]).await;
        run(&work, &["config", "branch.topic.merge", dest_ref]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "ahead"]).await;
        Some((guard, work, origin))
    }

    fn session_destination_copy(branch: &str, remote: &str, dest: &str) -> String {
        format!(
            "\"{branch}\" would push to {remote}/{dest}, which is in gd/session/ — reserved for agent sessions, so GitDesktop won't push to it."
        )
    }

    fn assert_session_destination(
        result: crate::error::AppResult<impl std::fmt::Debug>,
        expected: &str,
        row: &str,
    ) {
        match result.expect_err(row) {
            e @ AppError::PushDestinationIsAgentSession { .. } => {
                assert_eq!(e.to_string(), expected, "{row}")
            }
            other => panic!("{row}: expected the session-destination refusal, got {other:?}"),
        }
    }

    /// A named push whose tracked or explicit destination is a session branch is refused on
    /// both policies, in any case spelling, and nothing lands; a cross-name non-session
    /// upstream still pushes under Follow.
    #[tokio::test]
    async fn session_destination_refuses_named_pushes_onto_a_session_branch() {
        for dest_ref in ["refs/heads/gd/session/x", "refs/heads/GD/Session/X"] {
            let dest = dest_ref.strip_prefix("refs/heads/").unwrap();
            let Some((_guard, work, origin)) =
                session_destination_origin("session-dest-named", dest_ref).await
            else {
                return;
            };
            let state = AppState::default();
            let before = run(&origin, &["for-each-ref"]).await;
            let refused = session_destination_copy("topic", "origin", dest);
            let topic = || Some("topic".to_string());
            for (row, force) in [("tracked", false), ("tracked, forced", true)] {
                let result =
                    git_push_core_unpinned(&state, work.clone(), false, force, topic(), None, None)
                        .await;
                assert_session_destination(result, &refused, &format!("{dest}: {row}"));
            }
            assert_session_destination(
                git_push_same_name_core(&state, work.clone(), false, topic(), None).await,
                &refused,
                &format!("{dest}: MCP same-name"),
            );
            run(
                &work,
                &["config", "branch.topic.merge", "refs/heads/feature"],
            )
            .await;
            let explicit = git_push_core_unpinned(
                &state,
                work.clone(),
                false,
                false,
                topic(),
                Some("origin".into()),
                Some(dest.into()),
            )
            .await;
            assert_session_destination(explicit, &refused, &format!("{dest}: explicit"));
            assert_eq!(run(&origin, &["for-each-ref"]).await, before, "{dest}");

            git_push_core_unpinned(&state, work.clone(), false, false, topic(), None, None)
                .await
                .expect("a cross-name non-session upstream pushes under Follow");
            assert_eq!(
                run(&origin, &["rev-parse", "refs/heads/feature"]).await,
                run(&work, &["rev-parse", "refs/heads/topic"]).await,
                "{dest}"
            );
        }
    }

    /// Under push.default=upstream a bare or forced HEAD push resolves to the tracked session
    /// branch and is refused by the early check, before the network lock; under `current`
    /// the same push resolves to HEAD's own name and lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn session_destination_refuses_bare_and_forced_head_pushes_under_upstream() {
        use crate::git::runner::acquire_repo_lock;
        let Some((_guard, work, origin)) =
            session_destination_origin("session-dest-bare", "refs/heads/gd/session/x").await
        else {
            return;
        };
        run(&work, &["config", "push.default", "upstream"]).await;
        let before = run(&origin, &["for-each-ref"]).await;
        let refused = session_destination_copy("topic", "origin", "gd/session/x");
        let state = std::sync::Arc::new(AppState::default());
        let domain = state.network_lock(&work).await;
        let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
            .await
            .expect("the network domain is free");
        for force in [false, true] {
            let queued = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
                let queued = std::sync::Arc::clone(&queued);
                move || queued.store(true, std::sync::atomic::Ordering::SeqCst)
            });
            let (state, work) = (std::sync::Arc::clone(&state), work.clone());
            let push = async move {
                if force {
                    super::git_force_push_head_core(&state, work)
                        .await
                        .map(super::PushGuardWire::from)
                } else {
                    git_push_core_unpinned(&state, work, false, false, None, None, None).await
                }
            };
            let result = tokio::time::timeout(
                Duration::from_secs(30),
                NETWORK_LOCK_WAIT_HOOK.scope(hook, push),
            )
            .await
            .unwrap_or_else(|_| panic!("force={force}: the refusal waited on the held lock"));
            assert_session_destination(result, &refused, &format!("force={force}"));
            assert!(
                !queued.load(std::sync::atomic::Ordering::SeqCst),
                "force={force}: the push reached the network lock"
            );
        }
        drop(held);
        assert_eq!(run(&origin, &["for-each-ref"]).await, before);

        run(&work, &["config", "push.default", "current"]).await;
        git_push_core_unpinned(&state, work.clone(), false, false, None, None, None)
            .await
            .expect("under current the bare push lands on topic");
        assert_eq!(
            run(&origin, &["rev-parse", "refs/heads/topic"]).await,
            run(&work, &["rev-parse", "refs/heads/topic"]).await
        );
        assert_eq!(
            run(&origin, &["rev-parse", "refs/heads/gd/session/x"]).await,
            run(&work, &["rev-parse", "refs/heads/main"]).await
        );
    }

    /// The bare arm's destination check is case-insensitive too; its own bare repository,
    /// since two case spellings of one ref can't share one on Windows.
    #[tokio::test]
    async fn session_destination_refuses_a_mixed_case_bare_push() {
        let dest_ref = "refs/heads/GD/Session/X";
        let Some((_guard, work, origin)) =
            session_destination_origin("session-dest-bare-case", dest_ref).await
        else {
            return;
        };
        run(&work, &["config", "push.default", "upstream"]).await;
        let before = run(&origin, &["for-each-ref"]).await;
        let refused = session_destination_copy("topic", "origin", "GD/Session/X");
        let state = AppState::default();
        let bare =
            git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await;
        assert_session_destination(bare, &refused, "bare, mixed case");
        let forced = super::git_force_push_head_core(&state, work.clone()).await;
        assert_session_destination(forced, &refused, "forced, mixed case");
        assert_eq!(run(&origin, &["for-each-ref"]).await, before);
    }

    /// A bare or forced push queued behind the network lock re-reads HEAD's destination at
    /// spawn: an upstream re-pointed at a session branch during the wait refuses, and
    /// nothing lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn session_destination_rechecks_a_queued_bare_push_at_spawn() {
        use crate::git::runner::acquire_repo_lock;
        let Some((_guard, work, origin)) =
            session_destination_origin("session-dest-queued", "refs/heads/gd/session/x").await
        else {
            return;
        };
        run(&work, &["config", "push.default", "upstream"]).await;
        let before = run(&origin, &["for-each-ref"]).await;
        let refused = session_destination_copy("topic", "origin", "gd/session/x");
        for force in [false, true] {
            run(
                &work,
                &["config", "branch.topic.merge", "refs/heads/feature"],
            )
            .await;
            let state = std::sync::Arc::new(AppState::default());
            let domain = state.network_lock(&work).await;
            let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
                .await
                .expect("the network domain is free");
            let (queued_tx, queued_rx) = tokio::sync::oneshot::channel::<()>();
            let queued_tx = std::sync::Mutex::new(Some(queued_tx));
            let queued: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
                if let Some(tx) = queued_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            });
            let push = tokio::spawn({
                let (state, work) = (std::sync::Arc::clone(&state), work.clone());
                let run = async move {
                    if force {
                        super::git_force_push_head_core(&state, work)
                            .await
                            .map(super::PushGuardWire::from)
                    } else {
                        git_push_core_unpinned(&state, work, false, false, None, None, None).await
                    }
                };
                NETWORK_LOCK_WAIT_HOOK.scope(queued, run)
            });
            queued_rx.await.expect("the push reached the network lock");
            run(
                &work,
                &["config", "branch.topic.merge", "refs/heads/gd/session/x"],
            )
            .await;
            drop(held);
            let result = tokio::time::timeout(Duration::from_secs(60), push)
                .await
                .expect("the push finishes once the domain frees")
                .unwrap();
            assert_session_destination(result, &refused, &format!("force={force}"));
            assert_eq!(
                run(&origin, &["for-each-ref"]).await,
                before,
                "force={force}"
            );
        }
    }

    /// The atom's push remote and the mirror verdict's agree beside a session upstream: a
    /// `pushRemote` naming `second` makes the atom read `second`, so nothing resolves to the
    /// session branch on origin and nothing lands; marking `second` a mirror refuses naming
    /// `second` on the identical config.
    #[tokio::test]
    async fn session_destination_push_remote_agreement_rows() {
        let Some((guard, work, origin)) =
            session_destination_origin("session-dest-agree", "refs/heads/gd/session/x").await
        else {
            return;
        };
        let second = guard
            .path()
            .join("second.git")
            .to_string_lossy()
            .replace('\\', "/");
        run(
            &guard.path().to_string_lossy(),
            &["init", "-q", "--bare", "-b", "main", "second.git"],
        )
        .await;
        let url = format!("file:///{}", second.trim_start_matches('/'));
        run(&work, &["remote", "add", "second", &url]).await;
        run(&work, &["config", "remote.second.mirror", "false"]).await;
        run(&work, &["push", "-q", "second", "main"]).await;
        run(&work, &["config", "push.default", "upstream"]).await;
        run(&work, &["config", "branch.topic.pushRemote", "second"]).await;
        let state = AppState::default();
        let (origin_before, second_before) = (
            run(&origin, &["for-each-ref"]).await,
            run(&second, &["for-each-ref"]).await,
        );
        let atom = run(
            &work,
            &[
                "for-each-ref",
                "refs/heads/topic",
                "--format=%(push:remotename)",
            ],
        )
        .await;
        assert_eq!(atom.trim(), "second");

        match git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await {
            Err(e @ AppError::PushDestinationIsAgentSession { .. }) => {
                panic!("row a: refused as a session destination: {e:?}")
            }
            Err(e @ AppError::PushUpstreamIsLocal { .. }) => {
                panic!("row a: refused as a local upstream: {e:?}")
            }
            _ => {}
        }
        assert_eq!(run(&origin, &["for-each-ref"]).await, origin_before);
        assert_eq!(run(&second, &["for-each-ref"]).await, second_before);

        run(&work, &["config", "remote.second.mirror", "true"]).await;
        assert_mirror(
            git_push_core_unpinned(&state, work.clone(), false, false, None, None, None).await,
            "second",
            "row b",
        );
        assert_eq!(run(&origin, &["for-each-ref"]).await, origin_before);
        assert_eq!(run(&second, &["for-each-ref"]).await, second_before);
    }

    /// A work repo pinned against a hostile global config, with three bare remotes
    /// (`origin` holding `main`, `up`, `second`) behind three-slash `file:///` URLs, mirror
    /// off; HEAD on `feat`, one commit ahead of local `main`, which it tracks (remote `.`).
    /// `None` when a push remote is set outside the fixture. Returns (guard, work, remotes
    /// by name).
    async fn local_upstream_repo(
        tag: &str,
    ) -> Option<(tempfile::TempDir, String, Vec<(&'static str, String)>)> {
        let (guard, base) = temp_base(tag);
        let base_s = base.to_string_lossy().into_owned();
        let work = base.join("work").to_string_lossy().into_owned();
        run(&base_s, &["init", "-q", "-b", "main", "work"]).await;
        let keys = ["remote.pushDefault", "branch.feat.pushRemote"];
        if !unset_outside(&work, "local upstream", &keys).await {
            return None;
        }
        for (key, value) in [
            ("user.name", "t"),
            ("user.email", "t@example.com"),
            ("push.default", "simple"),
            ("branch.autoSetupMerge", "false"),
        ] {
            run(&work, &["config", key, value]).await;
        }
        let mut remotes = Vec::new();
        for name in ["origin", "up", "second"] {
            let dir = format!("{name}.git");
            run(&base_s, &["init", "-q", "--bare", "-b", "main", &dir]).await;
            let path = base.join(&dir).to_string_lossy().replace('\\', "/");
            let url = format!("file:///{}", path.trim_start_matches('/'));
            run(&work, &["remote", "add", name, &url]).await;
            let mirror = format!("remote.{name}.mirror");
            run(&work, &["config", &mirror, "false"]).await;
            remotes.push((name, path));
        }
        run(&work, &["commit", "-q", "--allow-empty", "-m", "seed"]).await;
        run(&work, &["push", "-q", "origin", "main"]).await;
        run(&work, &["switch", "-q", "-c", "feat"]).await;
        run(&work, &["config", "branch.feat.remote", "."]).await;
        run(&work, &["config", "branch.feat.merge", "refs/heads/main"]).await;
        run(&work, &["commit", "-q", "--allow-empty", "-m", "ahead"]).await;
        Some((guard, work, remotes))
    }

    fn assert_local_upstream(result: crate::error::AppResult<impl std::fmt::Debug>, row: &str) {
        match result.expect_err(row) {
            AppError::PushUpstreamIsLocal { branch, upstream } => {
                let got = (branch.as_str(), upstream.as_str());
                assert_eq!(got, ("feat", "main"), "{row}")
            }
            other => panic!("{row}: expected the local-upstream refusal, got {other:?}"),
        }
    }

    async fn tip(repo: &str, refname: &str) -> String {
        run(repo, &["rev-parse", refname]).await
    }

    async fn push_remote_atom(work: &str) -> String {
        let format = "--format=%(push:remotename)";
        let atom = run(work, &["for-each-ref", "refs/heads/feat", format]).await;
        atom.trim().to_string()
    }

    /// Named pushes (Follow, MCP same-name, set_upstream) and bare / forced HEAD pushes of a
    /// branch tracking a local branch refuse with the typed error under push.default simple
    /// and upstream, and local `main` never moves; an explicit remote and a GONE `.`
    /// upstream still push to origin.
    #[tokio::test]
    async fn local_upstream_refuses_named_and_bare_pushes() {
        let Some((_guard, work, remotes)) = local_upstream_repo("local-upstream").await else {
            return;
        };
        let origin = &remotes[0].1;
        let state = AppState::default();
        let main_before = run(&work, &["rev-parse", "refs/heads/main"]).await;
        let feat = || Some("feat".to_string());
        for force in [false, true] {
            let row = format!("named, force={force}");
            let result =
                git_push_core_unpinned(&state, work.clone(), false, force, feat(), None, None);
            assert_local_upstream(result.await, &row);
        }
        for set_upstream in [false, true] {
            let row = format!("MCP same-name, set_upstream={set_upstream}");
            let result = git_push_same_name_core(&state, work.clone(), set_upstream, feat(), None);
            assert_local_upstream(result.await, &row);
        }
        for push_default in ["simple", "upstream"] {
            run(&work, &["config", "push.default", push_default]).await;
            assert_eq!(push_remote_atom(&work).await, ".", "{push_default}");
            let bare = git_push_core_unpinned(&state, work.clone(), false, false, None, None, None);
            assert_local_upstream(bare.await, &format!("bare, {push_default}"));
            let forced = super::git_force_push_head_core(&state, work.clone());
            assert_local_upstream(forced.await, &format!("forced, {push_default}"));
        }
        assert_eq!(tip(&work, "refs/heads/main").await, main_before);
        assert!(!run(origin, &["for-each-ref"]).await.contains("feat"));

        run(&work, &["config", "push.default", "simple"]).await;
        let explicit = Some("origin".to_string());
        git_push_core_unpinned(&state, work.clone(), false, false, feat(), explicit, None)
            .await
            .expect("an explicit remote pushes to it");
        let feat_tip = run(&work, &["rev-parse", "refs/heads/feat"]).await;
        assert_eq!(tip(origin, "refs/heads/feat").await, feat_tip);
        assert_eq!(tip(&work, "refs/heads/main").await, main_before);

        run(&work, &["commit", "-q", "--allow-empty", "-m", "more"]).await;
        run(&work, &["branch", "-q", "-D", "main"]).await;
        // The bare arm refuses a gone `.` upstream; the named arm then publishes it.
        let pushed = tip(origin, "refs/heads/feat").await;
        let bare = git_push_core_unpinned(&state, work.clone(), false, false, None, None, None);
        assert_local_upstream(bare.await, "bare, gone `.` upstream");
        let forced = super::git_force_push_head_core(&state, work.clone());
        assert_local_upstream(forced.await, "forced, gone `.` upstream");
        assert_eq!(tip(origin, "refs/heads/feat").await, pushed);
        assert!(!run(&work, &["for-each-ref"])
            .await
            .contains("refs/heads/main"));

        git_push_core_unpinned(&state, work.clone(), false, false, feat(), None, None)
            .await
            .expect("a gone local upstream publishes to origin");
        let feat_tip = run(&work, &["rev-parse", "refs/heads/feat"]).await;
        assert_eq!(tip(origin, "refs/heads/feat").await, feat_tip);
    }

    /// Beside a `.` upstream the bare push follows the push remote git resolves: a
    /// configured one (`remote.pushDefault`, a `pushRemote` outranking it) sends the push
    /// there and it lands, while `remote.pushDefault=.` refuses. Each allowed row pairs
    /// the atom it read with its mirror twin, where 1a's config order names the same remote.
    #[tokio::test]
    async fn local_upstream_bare_push_follows_the_push_remote() {
        let Some((_guard, work, remotes)) = local_upstream_repo("local-upstream-remote").await
        else {
            return;
        };
        let path = |name: &str| remotes.iter().find(|(n, _)| *n == name).unwrap().1.clone();
        let state = AppState::default();
        let main_before = run(&work, &["rev-parse", "refs/heads/main"]).await;
        let bare = || git_push_core_unpinned(&state, work.clone(), false, false, None, None, None);
        let rows = [
            (
                "pushDefault",
                vec![("remote.pushDefault", "second")],
                "second",
            ),
            (
                "pushRemote over pushDefault",
                vec![
                    ("remote.pushDefault", "second"),
                    ("branch.feat.pushRemote", "up"),
                ],
                "up",
            ),
        ];
        for (row, config, lands_on) in rows {
            for (key, value) in config {
                run(&work, &["config", key, value]).await;
            }
            assert_eq!(push_remote_atom(&work).await, lands_on, "{row}");
            bare().await.unwrap_or_else(|e| panic!("{row}: {e:?}"));
            assert_eq!(
                run(&path(lands_on), &["rev-parse", "refs/heads/feat"]).await,
                run(&work, &["rev-parse", "refs/heads/feat"]).await,
                "{row}"
            );
            let mirror = format!("remote.{lands_on}.mirror");
            run(&work, &["config", &mirror, "true"]).await;
            assert_mirror(bare().await, lands_on, &format!("{row}: mirror twin"));
            run(&work, &["config", &mirror, "false"]).await;
            run(&work, &["commit", "-q", "--allow-empty", "-m", row]).await;
        }
        run(&work, &["config", "--unset", "branch.feat.pushRemote"]).await;
        run(&work, &["config", "remote.pushDefault", "."]).await;
        assert_eq!(push_remote_atom(&work).await, ".");
        assert_local_upstream(bare().await, "pushDefault=.");
        assert_eq!(tip(&work, "refs/heads/main").await, main_before);

        // A non-branch `.` upstream and an untracked HEAD are never this refusal.
        run(&work, &["config", "--unset", "remote.pushDefault"]).await;
        run(&work, &["tag", "v1", "refs/heads/main"]).await;
        run(&work, &["config", "branch.feat.merge", "refs/tags/v1"]).await;
        let result = bare().await;
        assert!(
            !matches!(result, Err(AppError::PushUpstreamIsLocal { .. })),
            "not a branch: {result:?}"
        );
        run(&work, &["config", "--unset", "branch.feat.merge"]).await;
        run(&work, &["config", "--unset", "branch.feat.remote"]).await;
        let result = bare().await;
        assert!(
            !matches!(result, Err(AppError::PushUpstreamIsLocal { .. })),
            "untracked: {result:?}"
        );
        assert_eq!(tip(&work, "refs/heads/main").await, main_before);
    }

    fn assert_unborn_push_refusal(error: AppError) {
        let AppError::InvalidArgument(expected) = crate::git::branches::unborn_head_error() else {
            panic!("unborn HEAD refusal must be an invalid argument");
        };
        match error {
            AppError::InvalidArgument(message) => assert_eq!(message, expected),
            other => panic!("expected the unborn HEAD refusal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn named_push_refuses_fresh_unborn_head() {
        for with_origin in [false, true] {
            let (_guard, base) = temp_base("named-push-unborn");
            let repo_s = base.to_string_lossy().into_owned();
            run(&repo_s, &["init", "-q", "-b", "main"]).await;
            if with_origin {
                run(
                    &repo_s,
                    &["remote", "add", "origin", "./missing-origin.git"],
                )
                .await;
            }
            let state = AppState::default();
            for set_upstream in [false, true] {
                let error = git_push_core_unpinned(
                    &state,
                    repo_s.clone(),
                    set_upstream,
                    false,
                    Some("main".into()),
                    None,
                    None,
                )
                .await
                .unwrap_err();
                assert_unborn_push_refusal(error);
            }
        }
    }

    #[tokio::test]
    async fn head_publish_refuses_fresh_unborn_head() {
        for with_origin in [false, true] {
            let (_guard, base) = temp_base("head-publish-unborn");
            let repo_s = base.to_string_lossy().into_owned();
            run(&repo_s, &["init", "-q", "-b", "main"]).await;
            if with_origin {
                run(
                    &repo_s,
                    &["remote", "add", "origin", "./missing-origin.git"],
                )
                .await;
            }
            let state = AppState::default();
            let error = git_push_core_unpinned(&state, repo_s, true, false, None, None, None)
                .await
                .unwrap_err();
            assert_unborn_push_refusal(error);
        }
    }

    #[tokio::test]
    async fn named_push_refuses_orphan_head() {
        let (_guard, base) = temp_base("named-push-orphan");
        let repo_s = base.to_string_lossy().into_owned();
        init_repo(&repo_s, "seed.txt").await;
        run(&repo_s, &["switch", "--orphan", "fresh"]).await;
        let state = AppState::default();
        let error = git_push_core_unpinned(
            &state,
            repo_s,
            true,
            false,
            Some("fresh".into()),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_unborn_push_refusal(error);
    }

    #[tokio::test]
    async fn named_push_preserves_missing_branch_refusal() {
        for with_commits in [false, true] {
            let (_guard, base) = temp_base("named-push-missing");
            let repo_s = base.to_string_lossy().into_owned();
            run(&repo_s, &["init", "-q", "-b", "main"]).await;
            if with_commits {
                init_repo(&repo_s, "seed.txt").await;
            }
            let state = AppState::default();
            let error = git_push_core_unpinned(
                &state,
                repo_s,
                true,
                false,
                Some("missing".into()),
                None,
                None,
            )
            .await
            .unwrap_err();
            match error {
                AppError::InvalidArgument(message) => {
                    assert_eq!(message, "no such branch: missing")
                }
                other => panic!("expected the missing branch refusal, got {other:?}"),
            }
        }
    }

    /// A tracked branch pushes to its upstream's real branch when a tag named
    /// `origin/<branch>` shortens the upstream to `remotes/origin/<branch>` — never to a
    /// brand-new `remotes/origin/<branch>` branch on the remote.
    #[tokio::test]
    async fn push_targets_the_upstream_branch_shadowed_by_a_tag() {
        let (_guard, base, origin_s, _url) = seeded_origin("push-upstream-tag-shadow").await;
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();
        run(&work_s, &["switch", "-q", "-c", "feat"]).await;
        run(&work_s, &["push", "-q", "-u", "origin", "feat"]).await;
        run(&work_s, &["tag", "origin/feat"]).await;
        std::fs::write(work.join("f.txt"), "f\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "feat work"]).await;
        let tip = run(&work_s, &["rev-parse", "HEAD"]).await;

        let state = AppState::default();
        git_push_core_unpinned(
            &state,
            work_s.clone(),
            false,
            false,
            Some("feat".into()),
            None,
            None,
        )
        .await
        .expect("the push succeeds");
        assert_eq!(run(&origin_s, &["rev-parse", "refs/heads/feat"]).await, tip);
        let published = run(
            &origin_s,
            &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        )
        .await;
        assert!(!published.contains("refs/heads/remotes/"), "{published}");
    }

    /// A HEAD-path publish names the branch checked out when it was asked for, in the
    /// argv AND the repair: switched away while the push queues behind the network
    /// lock, it still publishes and tracks that branch, never the one checked out at
    /// spawn.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_head_publish_queued_behind_the_network_lock_keeps_its_branch() {
        use crate::git::runner::{
            acquire_repo_lock, release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK,
        };
        let (_guard, base, origin_s, _url) = seeded_origin("push-head-pin").await;
        let work = base.join("work");
        let work_s = work.to_string_lossy().into_owned();
        for b in ["pressed", "later"] {
            run(&work_s, &["branch", b]).await;
        }
        run(&work_s, &["switch", "-q", "pressed"]).await;
        let state = std::sync::Arc::new(AppState::default());
        let domain = state.network_lock(&work_s).await;
        let held = acquire_repo_lock(&domain, Duration::ZERO, "a fetch")
            .await
            .expect("the network domain is free");

        let lock = work.join(".git").join("config.lock");
        std::fs::write(&lock, b"").unwrap();
        let (hook, attempts) = release_config_lock_before_attempt(lock, 2);
        let (queued_tx, queued_rx) = tokio::sync::oneshot::channel::<()>();
        let queued_tx = std::sync::Mutex::new(Some(queued_tx));
        let queued: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new(move || {
            if let Some(tx) = queued_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        });
        let push = tokio::spawn({
            let (state, work_s) = (std::sync::Arc::clone(&state), work_s.clone());
            let run = async move {
                git_push_core_unpinned(&state, work_s, true, false, None, None, None).await
            };
            NETWORK_LOCK_WAIT_HOOK.scope(queued, CONFIG_WRITE_ATTEMPT_HOOK.scope(hook, run))
        });
        // The push is about to wait on the domain the test holds; only now does the
        // user switch away.
        queued_rx.await.expect("the push reached the network lock");
        run(&work_s, &["switch", "-q", "later"]).await;
        drop(held);
        tokio::time::timeout(Duration::from_secs(60), push)
            .await
            .expect("the push finishes once the domain frees")
            .unwrap()
            .expect("the push succeeds");

        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
        let pushed = run(
            &origin_s,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
        )
        .await;
        assert!(pushed.lines().any(|l| l == "pressed"), "{pushed}");
        assert!(!pushed.lines().any(|l| l == "later"), "{pushed}");
        let upstream = run_git(
            Some(&work_s),
            &["rev-parse", "--abbrev-ref", "pressed@{upstream}"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .expect("the pressed branch tracks");
        assert_eq!(upstream.stdout_lossy().trim(), "origin/pressed");
    }

    /// A bare push from a renamed tracking branch: git's push.default=simple refusal maps
    /// to the typed error carrying the re-read names, forced or not, and nothing moves on
    /// the remote. Then the two explicit destinations the sync bar's menu offers land
    /// exactly where they say: the tracked branch with tracking untouched, and the new
    /// name on the SAME remote, retracked.
    #[tokio::test]
    async fn a_bare_push_refused_for_a_name_mismatch_names_both_branches() {
        let (_guard, base, origin_s, _url) = seeded_origin("name-mismatch").await;
        let work_s = base.join("work").to_string_lossy().into_owned();
        run(&work_s, &["config", "push.default", "simple"]).await;
        for key in ["branch.feat/y.pushRemote", "remote.origin.push"] {
            let out = run_git_raw(
                Some(&work_s),
                &["config", "--get", key],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
            if out.code != 1 {
                eprintln!("skipping: {key} is set outside the fixture");
                return;
            }
        }
        run(&work_s, &["push", "-q", "origin", "main:refs/heads/feat/x"]).await;
        run(&work_s, &["fetch", "-q", "origin"]).await;
        run(
            &work_s,
            &["switch", "-q", "-c", "feat/x", "--track", "origin/feat/x"],
        )
        .await;
        run(&work_s, &["branch", "-m", "feat/x", "feat/y"]).await;
        std::fs::write(base.join("work").join("y.txt"), "y\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "on feat/y"]).await;
        let tip = run(&work_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        let main_tip = run(&origin_s, &["rev-parse", "refs/heads/main"])
            .await
            .trim()
            .to_string();

        let state = AppState::default();
        for force in [false, true] {
            let err =
                git_push_core_unpinned(&state, work_s.clone(), false, force, None, None, None)
                    .await
                    .expect_err("git refuses the bare push");
            let AppError::PushUpstreamNameMismatch {
                branch,
                remote,
                remote_branch,
            } = &err
            else {
                panic!("force={force}: expected the typed refusal, got {err:?}")
            };
            assert_eq!(
                (branch.as_str(), remote.as_str(), remote_branch.as_str()),
                ("feat/y", "origin", "feat/x")
            );
        }
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/feat/x"])
                .await
                .trim(),
            main_tip
        );

        // "Push to origin/feat/x": the named destination, tracking untouched.
        git_push_core_unpinned(
            &state,
            work_s.clone(),
            false,
            false,
            Some("feat/y".into()),
            Some("origin".into()),
            Some("feat/x".into()),
        )
        .await
        .expect("push to the tracked branch");
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/feat/x"])
                .await
                .trim(),
            tip
        );
        let upstream = || {
            let work_s = work_s.clone();
            async move {
                run(
                    &work_s,
                    &["rev-parse", "--symbolic-full-name", "feat/y@{upstream}"],
                )
                .await
                .trim()
                .to_string()
            }
        };
        assert_eq!(upstream().await, "refs/remotes/origin/feat/x");

        // "Publish as origin/feat/y": the same remote, retracked to the new name.
        git_push_core_unpinned(
            &state,
            work_s.clone(),
            true,
            false,
            Some("feat/y".into()),
            Some("origin".into()),
            None,
        )
        .await
        .expect("publish under the new name");
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/feat/y"])
                .await
                .trim(),
            tip
        );
        assert_eq!(upstream().await, "refs/remotes/origin/feat/y");
        git_push_core_unpinned(&state, work_s.clone(), false, false, None, None, None)
            .await
            .expect("a bare push works again once the names match");
    }

    /// "Push to origin/<new> and track it" when that branch already exists: the publish
    /// arm fast-forwards it, and refuses rather than overwrite one holding other work.
    #[tokio::test]
    async fn publishing_onto_an_existing_remote_branch_fast_forwards_or_refuses() {
        let (_guard, base, origin_s, _url) = seeded_origin("publish-existing").await;
        let work_s = base.join("work").to_string_lossy().into_owned();
        let main_tip = run(&work_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        let seeds = [
            "HEAD:refs/heads/feat/x",
            "HEAD:refs/heads/feat/y",
            "HEAD:refs/heads/feat/z",
        ];
        run(
            &work_s,
            &[&["push", "-q", "origin"][..], &seeds[..]].concat(),
        )
        .await;
        run(&work_s, &["fetch", "-q", "origin"]).await;
        // feat/z on the remote gets work the local branch never saw.
        run(
            &work_s,
            &["switch", "-q", "-c", "other", "--no-track", "origin/feat/z"],
        )
        .await;
        std::fs::write(base.join("work").join("z.txt"), "z\n").unwrap();
        run(&work_s, &["add", "-A"]).await;
        run(&work_s, &["commit", "-qm", "remote-only"]).await;
        run(&work_s, &["push", "-q", "origin", "HEAD:refs/heads/feat/z"]).await;
        let z_tip = run(&work_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();

        let state = AppState::default();
        for (local, full, existing_tip) in [
            ("feat/y", "refs/heads/feat/y", &main_tip),
            ("feat/z", "refs/heads/feat/z", &z_tip),
        ] {
            run(
                &work_s,
                &["switch", "-q", "-c", local, "--track", "origin/feat/x"],
            )
            .await;
            std::fs::write(base.join("work").join("w.txt"), local).unwrap();
            run(&work_s, &["add", "-A"]).await;
            run(&work_s, &["commit", "-qm", local]).await;
            let tip = run(&work_s, &["rev-parse", "HEAD"])
                .await
                .trim()
                .to_string();
            let published = git_push_core_unpinned(
                &state,
                work_s.clone(),
                true,
                false,
                Some(local.to_string()),
                Some("origin".into()),
                None,
            )
            .await;
            let remote_tip = run(&origin_s, &["rev-parse", full])
                .await
                .trim()
                .to_string();
            if existing_tip == &main_tip {
                published.expect("an ancestor fast-forwards");
                assert_eq!(remote_tip, tip);
            } else {
                assert!(published.is_err(), "a diverged remote branch is refused");
                assert_eq!(&remote_tip, existing_tip, "never overwritten");
            }
        }
    }

    /// git refuses a pull-request upstream's bare push with the same message, but there
    /// is no branch to name, so the error passes through untouched. Canary for the
    /// whitespace-collapsed match against git's real, line-wrapped text.
    #[tokio::test]
    async fn a_name_refusal_without_a_branch_upstream_keeps_gits_own_error() {
        let (_guard, base, origin_s, _url) = seeded_origin("pull-upstream").await;
        let work_s = base.join("work").to_string_lossy().into_owned();
        run(&work_s, &["config", "push.default", "simple"]).await;
        for key in ["branch.pr-7.pushRemote", "remote.origin.push"] {
            let out = run_git_raw(
                Some(&work_s),
                &["config", "--get", key],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
            if out.code != 1 {
                eprintln!("skipping: {key} is set outside the fixture");
                return;
            }
        }
        run(
            &origin_s,
            &["update-ref", "refs/pull/7/head", "refs/heads/main"],
        )
        .await;
        run(
            &work_s,
            &[
                "config",
                "--add",
                "remote.origin.fetch",
                "+refs/pull/*/head:refs/remotes/origin/pr/*",
            ],
        )
        .await;
        run(&work_s, &["fetch", "-q", "origin"]).await;
        run(
            &work_s,
            &["switch", "-q", "--no-track", "-c", "pr-7", "origin/pr/7"],
        )
        .await;
        run(&work_s, &["config", "branch.pr-7.remote", "origin"]).await;
        run(
            &work_s,
            &["config", "branch.pr-7.merge", "refs/pull/7/head"],
        )
        .await;

        let state = AppState::default();
        let err = git_push_core_unpinned(&state, work_s.clone(), false, false, None, None, None)
            .await
            .expect_err("git refuses the bare push");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's own error, got {err:?}")
        };
        assert!(is_push_simple_name_refusal(stderr), "{stderr}");
        assert!(!is_push_simple_name_refusal(
            "does not match\nthe name of another branch"
        ));
    }

    /// The wire values the TS `PushGuard` union (src/lib/git/api/sync.ts) mirrors: the
    /// success toast keys on these exact strings, so a variant rename that skips
    /// the mirror would silently stop reporting a degraded force push.
    #[test]
    fn push_guard_serializes_to_the_camel_case_wire_values() {
        for (guard, wire) in [
            (PushGuard::LeaseAndIncludes, "leaseAndIncludes"),
            (PushGuard::LeaseOnlyOldGit, "leaseOnlyOldGit"),
            (PushGuard::LeaseOnlyNoReflog, "leaseOnlyNoReflog"),
        ] {
            assert_eq!(
                serde_json::to_value(&guard).unwrap(),
                serde_json::Value::String(wire.to_string()),
                "{guard:?} must stay on the wire as {wire:?}"
            );
        }
    }

    /// The gap `--force-if-includes` closes, driven end to end: a plain `fetch`
    /// alone satisfies the bare lease, so with the lease only, clone1's amend would
    /// clobber a commit clone2 pushed and clone1 never integrated. Integrating it
    /// (`pull --rebase`) is what lets the same force push land.
    #[tokio::test]
    async fn force_push_refuses_fetched_but_unintegrated_remote_work() {
        let (_guard, base, origin_s, url) = seeded_origin("if-includes").await;
        let base_s = base.to_string_lossy().into_owned();

        for name in ["clone1", "clone2"] {
            run(&base_s, &["-c", "core.autocrlf=false", "clone", "-q", &url, name]).await;
            let c = base.join(name).to_string_lossy().into_owned();
            run(&c, &["config", "core.autocrlf", "false"]).await;
            run(&c, &["config", "user.email", "t@t.local"]).await;
            run(&c, &["config", "user.name", "T"]).await;
        }
        let clone1 = base.join("clone1");
        let clone2 = base.join("clone2");
        let clone1_s = clone1.to_string_lossy().into_owned();
        let clone2_s = clone2.to_string_lossy().into_owned();

        // clone2 lands a commit of its own on the shared branch.
        std::fs::write(clone2.join("b.txt"), "theirs\n").unwrap();
        run(&clone2_s, &["add", "-A"]).await;
        run(&clone2_s, &["commit", "-qm", "from clone2"]).await;
        run(&clone2_s, &["push", "-q"]).await;
        let theirs = run(&clone2_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        // clone1 only FETCHES it — the whole point: that alone used to satisfy the
        // lease. Its amend adds a NEW file so the later replay stays conflict-free.
        run(&clone1_s, &["fetch", "-q"]).await;
        std::fs::write(clone1.join("c.txt"), "mine\n").unwrap();
        run(&clone1_s, &["add", "-A"]).await;
        run(&clone1_s, &["commit", "-q", "--amend", "-m", "amended seed"]).await;

        let state = AppState::default();
        let err = git_push_core_unpinned(&state, clone1_s.clone(), false, true, None, None, None)
            .await
            .expect_err("a merely-fetched remote commit must not be clobbered");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected a git error, got {err:?}")
        };
        assert_rejection_reason(stderr, IF_INCLUDES_REJECTION);
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/main"]).await.trim(),
            theirs,
            "clone2's commit is still origin's tip"
        );

        // Integrating the remote work unblocks the very same push.
        run(&clone1_s, &["pull", "--rebase", "-q"]).await;
        assert_eq!(
            git_push_core_unpinned(&state, clone1_s.clone(), false, true, None, None, None)
                .await
                .expect("an integrated branch force-pushes"),
            super::PushGuardWire::LeaseAndIncludes
        );
        let landed = run(&origin_s, &["ls-tree", "--name-only", "refs/heads/main"]).await;
        assert!(
            landed.contains("b.txt") && landed.contains("c.txt"),
            "both sides' work is on the new tip: {landed}"
        );
    }

    /// `--force-if-includes` walks the local branch's REFLOG, so a repo with
    /// reflogs off rejects every force push — even with the remote untouched and
    /// nothing to clobber. The push must still land, degraded to the lease alone
    /// and reported as such.
    #[tokio::test]
    async fn force_push_falls_back_to_the_lease_when_the_branch_has_no_reflog() {
        let (_guard, base, origin_s, url) = seeded_origin("no-reflog").await;
        let base_s = base.to_string_lossy().into_owned();

        // Reflogs off at CLONE time: set afterwards, `.git/logs/` already exists and
        // the check would pass. This is `git clone`'s OWN `-c`, which writes the key
        // into the new repo's config — git's one-shot `-c` (before the subcommand)
        // would not persist, and the first ref update would re-enable reflogs.
        run(
            &base_s,
            &[
                "-c",
                "core.autocrlf=false",
                "clone",
                "-q",
                "-c",
                "core.logAllRefUpdates=false",
                &url,
                "nolog",
            ],
        )
        .await;
        let clone = base.join("nolog");
        let clone_s = clone.to_string_lossy().into_owned();
        run(&clone_s, &["config", "core.autocrlf", "false"]).await;
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;

        // Rewrite the tip; the remote is untouched, so the lease has no complaint.
        std::fs::write(clone.join("c.txt"), "mine\n").unwrap();
        run(&clone_s, &["add", "-A"]).await;
        run(&clone_s, &["commit", "-q", "--amend", "-m", "amended seed"]).await;
        let amended = run(&clone_s, &["rev-parse", "HEAD"]).await.trim().to_string();
        // The discriminating state, in the retry gate's own terms — asserted AFTER
        // the amend, since a ref update would otherwise create the reflog.
        assert!(
            run_git(
                Some(&clone_s),
                &["reflog", "exists", "refs/heads/main"],
                TEST_GIT_HANG_GUARD
            )
            .await
            .is_err(),
            "the fixture's branch must have no reflog for the flag to walk"
        );

        let state = AppState::default();
        assert_eq!(
            git_push_core_unpinned(&state, clone_s.clone(), false, true, None, None, None)
                .await
                .expect("a no-reflog rejection is spurious; the push must still land"),
            super::PushGuardWire::LeaseOnlyNoReflog
        );
        assert_eq!(
            run(&origin_s, &["rev-parse", "refs/heads/main"]).await.trim(),
            amended,
            "the amended commit is origin's tip"
        );
    }

    #[test]
    fn push_plus_prefixed_branch_is_not_a_force() {
        // Security regression guard: a branch named `+main` is a VALID git ref,
        // and as a BARE refspec source `+` is git's force indicator. Fully
        // qualifying the refspec embeds the `+` inside `refs/heads/+main`, never
        // as its leading char, so git can't read it as a force-push.
        assert_eq!(
            build_push_args_today("+main", &up(""), "", false, false, false, None, None),
            vec!["push", "-u", "origin", "refs/heads/+main:refs/heads/+main"]
        );
    }

    #[test]
    fn push_gone_different_name_publishes_under_local_name() {
        // Deliberate: a gone upstream publishes under the LOCAL name (a fresh
        // `origin/feature`), not the deleted `feat` — matching the "Publish"
        // affordance and toast.
        assert_eq!(
            build_push_args_today(
                "feature",
                &up("feat"),
                "origin",
                true,
                false,
                false,
                None,
                None
            ),
            vec![
                "push",
                "-u",
                "origin",
                "refs/heads/feature:refs/heads/feature"
            ]
        );
    }

    #[test]
    fn push_explicit_remote_branch_pins_the_destination_refspec() {
        // Untracked local branch, explicit remote + destination.
        assert_eq!(
            build_push_args_today(
                "local",
                &up(""),
                "",
                false,
                false,
                false,
                Some("fork"),
                Some("contrib")
            ),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // A destination name never re-tracks, so `set_upstream` can't add `-u`.
        assert_eq!(
            build_push_args_today(
                "local",
                &up(""),
                "",
                false,
                true,
                false,
                Some("fork"),
                Some("contrib")
            ),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // A gone upstream likewise can't drag the publish arm back in.
        assert_eq!(
            build_push_args_today(
                "local",
                &up("local"),
                "origin",
                true,
                false,
                false,
                Some("fork"),
                Some("contrib")
            ),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // Tracked elsewhere: the refspec still targets `contrib`, upstream untouched.
        assert_eq!(
            build_push_args_today(
                "local",
                &up("local"),
                "origin",
                false,
                false,
                false,
                Some("fork"),
                Some("contrib")
            ),
            vec!["push", "fork", "refs/heads/local:refs/heads/contrib"]
        );
        // `force` keeps its position ahead of the target, as in every other arm.
        assert_eq!(
            build_push_args_today(
                "local",
                &up(""),
                "",
                false,
                false,
                true,
                Some("fork"),
                Some("contrib")
            ),
            vec![
                "push",
                "--force-with-lease",
                "--force-if-includes",
                "fork",
                "refs/heads/local:refs/heads/contrib"
            ]
        );
    }

    /// The routing rule: explicit, else configured, else the live upstream's remote, else
    /// origin.
    #[test]
    fn resolve_push_target_prefers_request_then_configured_then_tracked_then_origin() {
        for (requested, configured, remotename, gone, want) in [
            (Some("x"), Some("fork"), "upstream", false, "x"),
            (Some("x"), None, "upstream", false, "x"),
            (None, Some("fork"), "upstream", false, "fork"),
            (None, Some("fork"), "upstream", true, "fork"),
            (None, Some("fork"), "", false, "fork"),
            (None, None, "upstream", false, "upstream"),
            (None, None, "", false, "origin"),
            (None, None, "upstream", true, "origin"),
        ] {
            assert_eq!(
                resolve_push_target(requested, configured, remotename, gone),
                want,
                "{requested:?} {configured:?} {remotename:?} gone={gone}"
            );
        }
    }

    /// A non-branch upstream (`refs/pull/<n>/head`, which a pull fetch refspec makes
    /// trackable) is pushed under the local name with NO `-u`: there is no branch to
    /// push into, and retracking would drop the branch's pull request association.
    #[test]
    fn parse_upstream_tracking_routes_a_non_branch_upstream_to_a_local_name_copy() {
        let parsed = parse_upstream_tracking(
            "refs/heads/pr-7\0refs/pull/7/head\0origin\0",
            "refs/heads/pr-7",
        );
        assert_eq!(parsed, Some((Upstream::NotABranch, "origin".into(), false)));
        let (upstream, remotename, gone) = parsed.unwrap();
        assert_eq!(
            build_push_args_today(
                "pr-7",
                &upstream,
                &remotename,
                gone,
                false,
                false,
                None,
                None
            ),
            vec!["push", "origin", "refs/heads/pr-7:refs/heads/pr-7"]
        );
    }

    /// A hand-edited bare `branch.<b>.merge = main` on a local (`.`) upstream comes
    /// back raw from `%(upstream:remoteref)`; git DWIMs it to the branch, and so does
    /// the push.
    #[test]
    fn parse_upstream_tracking_reads_a_bare_merge_value_as_the_branch() {
        let parsed = parse_upstream_tracking("refs/heads/x\0main\0.\0", "refs/heads/x");
        assert_eq!(parsed, Some((up("main"), ".".into(), false)));
        let (upstream, remotename, gone) = parsed.unwrap();
        assert_eq!(
            build_push_args_today("x", &upstream, &remotename, gone, false, false, None, None),
            vec!["push", ".", "refs/heads/x:refs/heads/main"]
        );
    }

    // --- Push routing, pins and leases (the push package). ---

    /// Today's 8-input argv: no configured push remote, never the create-only lease.
    #[allow(clippy::too_many_arguments)] // the decision table's flat inputs
    fn build_push_args_today(
        branch: &str,
        upstream: &Upstream,
        remotename: &str,
        gone: bool,
        set_upstream: bool,
        force: bool,
        requested: Option<&str>,
        remote_branch: Option<&str>,
    ) -> Vec<String> {
        let route = super::NamedRoute {
            branch,
            upstream,
            remotename,
            gone,
            set_upstream,
            requested,
            configured: None,
            remote_branch,
        };
        super::build_push_args(&route, force, super::CreateLease::NONE)
    }

    fn sv(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// The named-push routing table. Mark `u`: the create-only lease when the destination's
    /// tracking ref is unproven or on `creates`; `c`: only on `creates`; `-`: never.
    /// Each row also runs [`super::NamedPushRouting::destination`] against the argv.
    #[test]
    fn named_push_routing_table_and_its_destination_agree() {
        use super::NamedPushDestination::{Refused, To};
        let b = |n: &str| Upstream::Branch(n.to_string());
        let lease = "--force-with-lease=refs/heads/b:";
        #[rustfmt::skip]
        #[allow(clippy::type_complexity)] // one flat tuple per table row
        let rows: Vec<(&str, Upstream, &str, bool, bool, bool, Option<&str>, Option<&str>, Option<&str>, Vec<&str>, char)> = vec![
            ("tracked same, none", b("b"), "origin", false, false, false, None, None, None, vec!["push", "origin", "refs/heads/b:refs/heads/b"], 'c'),
            ("tracked same, fork", b("b"), "origin", false, false, false, None, Some("fork"), None, vec!["push", "fork", "refs/heads/b:refs/heads/b"], 'c'),
            ("tracked other, fork", b("other"), "origin", false, false, false, None, Some("fork"), None, vec!["push", "fork", "refs/heads/b:refs/heads/b"], 'c'),
            ("tracked other, origin", b("other"), "origin", false, false, false, None, Some("origin"), None, vec!["push", "origin", "refs/heads/b:refs/heads/other"], 'c'),
            ("tracked other, none", b("other"), "origin", false, false, false, None, None, None, vec!["push", "origin", "refs/heads/b:refs/heads/other"], 'c'),
            ("untracked, fork", Upstream::Untracked, "", false, false, false, None, Some("fork"), None, vec!["push", "-u", "fork", "refs/heads/b:refs/heads/b"], 'u'),
            ("untracked, none", Upstream::Untracked, "", false, false, false, None, None, None, vec!["push", "-u", "origin", "refs/heads/b:refs/heads/b"], 'u'),
            ("gone, none", b("b"), "fork", true, false, false, None, None, None, vec!["push", "-u", "origin", "refs/heads/b:refs/heads/b"], 'u'),
            ("gone, fork", b("b"), "origin", true, false, false, None, Some("fork"), None, vec!["push", "-u", "fork", "refs/heads/b:refs/heads/b"], 'u'),
            ("set_upstream up/main", b("main"), "up", false, true, false, None, None, None, vec!["push", "-u", "up", "refs/heads/b:refs/heads/b"], 'u'),
            ("set_upstream same, fork", b("b"), "origin", false, true, false, None, Some("fork"), None, vec!["push", "-u", "fork", "refs/heads/b:refs/heads/b"], 'u'),
            ("non-branch, fork", Upstream::NotABranch, "origin", false, false, false, None, Some("fork"), None, vec!["push", "fork", "refs/heads/b:refs/heads/b"], 'c'),
            ("non-branch, none", Upstream::NotABranch, "origin", false, false, false, None, None, None, vec!["push", "origin", "refs/heads/b:refs/heads/b"], 'c'),
            ("explicit X", b("b"), "origin", false, false, false, Some("up"), None, None, vec!["push", "up", "refs/heads/b:refs/heads/b"], 'c'),
            ("explicit = configured", b("b"), "origin", false, false, false, Some("fork"), None, None, vec!["push", "fork", "refs/heads/b:refs/heads/b"], 'c'),
            ("explicit + rb", b("b"), "origin", false, false, false, Some("fork"), None, Some("rb"), vec!["push", "fork", "refs/heads/b:refs/heads/rb"], 'c'),
            ("local ., fork", b("main"), ".", false, false, false, None, Some("fork"), None, vec!["push", "fork", "refs/heads/b:refs/heads/b"], 'c'),
            ("force", b("b"), "origin", false, false, true, None, None, None, vec!["push", "--force-with-lease", "--force-if-includes", "origin", "refs/heads/b:refs/heads/b"], '-'),
            ("force publish", Upstream::Untracked, "", false, false, true, None, Some("fork"), None, vec!["push", "--force-with-lease", "--force-if-includes", "-u", "fork", "refs/heads/b:refs/heads/b"], '-'),
        ];
        let remotes = sv(&["origin", "fork", "up"]);
        for (
            label,
            upstream,
            remotename,
            gone,
            set,
            force,
            requested,
            configured,
            rb,
            want,
            mark,
        ) in rows
        {
            let route = super::NamedRoute {
                branch: "b",
                upstream: &upstream,
                remotename,
                gone,
                set_upstream: set,
                requested,
                configured,
                remote_branch: rb,
            };
            let with_lease = |argv: &[&str]| {
                let mut v = sv(argv);
                v.insert(1, lease.to_string());
                v
            };
            let leased = with_lease(&want);
            let lease_of = |creates, dest_tracked| {
                route.argv(
                    force,
                    super::CreateLease {
                        creates,
                        dest_tracked,
                    },
                )
            };
            let leased = if rb.is_some() {
                let mut v = sv(&want);
                v.insert(1, "--force-with-lease=refs/heads/rb:".to_string());
                v
            } else if label.starts_with("tracked other, origin") || label == "tracked other, none" {
                let mut v = sv(&want);
                v.insert(1, "--force-with-lease=refs/heads/other:".to_string());
                v
            } else {
                leased
            };
            assert_eq!(lease_of(false, true), sv(&want), "{label}: no lease");
            let untracked = lease_of(false, false);
            let created = lease_of(true, true);
            match mark {
                'u' => {
                    assert_eq!(untracked, leased, "{label}: unproven tracking");
                    assert_eq!(created, leased, "{label}: creates");
                }
                'c' => {
                    assert_eq!(untracked, sv(&want), "{label}: unproven tracking");
                    assert_eq!(created, leased, "{label}: creates");
                }
                _ => {
                    assert_eq!(untracked, sv(&want), "{label}: force");
                    assert_eq!(created, sv(&want), "{label}: force");
                }
            }
            // The destination answers only for no explicit remote, no retrack.
            if requested.is_some() || set {
                continue;
            }
            let listing = match configured {
                Some(c) => format!("branch.b.pushremote\n{c}\0"),
                None => String::new(),
            };
            let routing = super::NamedPushRouting {
                config: crate::git::status::PushConfig::from_listing(&listing),
                remotes: remotes.clone(),
            };
            let target = want[want.len() - 2].to_string();
            let dest = want[want.len() - 1]
                .rsplit_once(":refs/heads/")
                .unwrap()
                .1
                .to_string();
            assert_eq!(
                routing.destination("b", &upstream, remotename, gone),
                To {
                    remote: target,
                    branch: dest
                },
                "{label}: destination"
            );
        }

        // The routing refusals, each answered `Refused` and refused by the call the push
        // makes there: `v` validate_ref_name, `s` the session check, `c` the configured
        // push remote's check, `r` the route's own refusals.
        let mirror = "remote.fork.mirror\ntrue\0branch.b.pushremote\nfork\0";
        #[rustfmt::skip]
        let refused: Vec<(&str, &str, &str, Upstream, &str, char)> = vec![
            ("local . upstream", "b", "", b("main"), ".", 'r'),
            ("mirror push remote", "b", mirror, Upstream::Untracked, "", 'r'),
            ("unusable push remote", "b", "branch.b.pushremote\nnope\0", Upstream::Untracked, "", 'c'),
            ("unlisted upstream remote", "b", "", b("b"), "ghost", 'r'),
            ("dash-named upstream remote", "b", "", b("b"), "-x", 'r'),
            ("branch remote no remote has", "b", "branch.b.remote\nmissing\0", Upstream::Untracked, "", 'u'),
            ("destination holding a colon", "b", "", b("a:b"), "origin", 'r'),
            ("session destination", "b", "", b("gd/session/x"), "origin", 'r'),
            ("invalid branch name", "bad:name", "", Upstream::Untracked, "", 'v'),
            ("session branch", "gd/session/x", "", Upstream::Untracked, "", 's'),
        ];
        let remotes = sv(&["origin", "fork", "up", "-x"]);
        for (label, branch, listing, upstream, remotename, push_side) in refused {
            let routing = super::NamedPushRouting {
                config: crate::git::status::PushConfig::from_listing(listing),
                remotes: remotes.clone(),
            };
            assert_eq!(
                routing.destination(branch, &upstream, remotename, false),
                Refused,
                "{label}"
            );
            let config = &routing.config;
            let refusal = match push_side {
                'v' => crate::git::branches::validate_ref_name(branch).err(),
                's' => super::refuse_publishing_session_branch(branch).err(),
                'c' => super::configured_push_remote_checked(config, &remotes, branch).err(),
                'u' => {
                    super::untracked_branch_remote(config, &remotes, branch, &upstream, remotename)
                        .err()
                }
                _ => {
                    let configured =
                        super::configured_push_remote_checked(config, &remotes, branch).unwrap();
                    let route = super::NamedRoute {
                        branch,
                        upstream: &upstream,
                        remotename,
                        gone: false,
                        set_upstream: false,
                        requested: None,
                        configured,
                        remote_branch: None,
                    };
                    route
                        .refuse(config, &remotes, super::CrossNameUpstream::Follow)
                        .err()
                }
            };
            assert!(refusal.is_some(), "{label}: the push's own check");
        }

        // An untracked read publishes by D2 whatever `branch.<b>.remote` holds: a listed
        // remote (no merge key, or no fetch refspec, reads untracked), `.`, a URL or a path
        // goes to the configured push remote, else origin, on the row and the push alike.
        for (listing, remote) in [
            ("branch.b.remote\nfork\0", "origin"),
            ("branch.b.remote\nfork\0remote.pushdefault\nup\0", "up"),
            ("branch.b.remote\n.\0", "origin"),
            ("branch.b.remote\nhttps://example.invalid/r.git\0", "origin"),
            ("branch.b.remote\n../r.git\0", "origin"),
            ("branch.b.remote\nmirrors/fork.git\0", "origin"),
        ] {
            let routing = super::NamedPushRouting {
                config: crate::git::status::PushConfig::from_listing(listing),
                remotes: remotes.clone(),
            };
            assert_eq!(
                routing.destination("b", &Upstream::Untracked, "", false),
                To {
                    remote: remote.to_string(),
                    branch: "b".to_string()
                },
                "{listing:?}"
            );
            assert_eq!(
                super::untracked_branch_remote(
                    &routing.config,
                    &remotes,
                    "b",
                    &Upstream::Untracked,
                    ""
                )
                .unwrap(),
                "",
                "{listing:?}: the push"
            );
        }

        // A destination with a leading dash is a valid ref behind `refs/heads/`: it routes.
        let dashed = b("-x");
        let routing = super::NamedPushRouting {
            config: crate::git::status::PushConfig::from_listing(""),
            remotes: remotes.clone(),
        };
        assert_eq!(
            routing.destination("b", &dashed, "origin", false),
            To {
                remote: "origin".to_string(),
                branch: "-x".to_string()
            }
        );
        let route = super::NamedRoute {
            branch: "b",
            upstream: &dashed,
            remotename: "origin",
            gone: false,
            set_upstream: false,
            requested: None,
            configured: None,
            remote_branch: None,
        };
        assert_eq!(
            route.argv(false, super::CreateLease::NONE),
            sv(&["push", "origin", "refs/heads/b:refs/heads/-x"])
        );
    }

    /// An unusable configured push remote names the key that won, for each key and shape.
    #[test]
    fn an_unusable_configured_push_remote_names_its_key() {
        let remotes = sv(&["origin", "fork"]);
        let own = "branch.b.pushRemote";
        let pd = "remote.pushDefault";
        #[rustfmt::skip]
        let rows = [
            ("branch.b.pushremote\n\0", own, ""),
            ("branch.b.pushremote\nbad:name\0", own, "bad:name"),
            ("branch.b.pushremote\nghost\0", own, "ghost"),
            ("remote.pushdefault\n\0", pd, ""),
            ("remote.pushdefault\nbad:name\0", pd, "bad:name"),
            ("remote.pushdefault\nghost\0", pd, "ghost"),
            ("remote.pushdefault\nfork\0branch.b.pushremote\n\0", own, ""),
            // A URL's userinfo is redacted; scheme, host and path still name the value.
            ("branch.b.pushremote\nhttps://user:token@host/o/r\0", own, "https://***@host/o/r"),
            ("remote.pushdefault\nhttps://token@host/o/r\0", pd, "https://***@host/o/r"),
            ("branch.b.pushremote\nuser:pass@host:o/r.git\0", own, "***@host:o/r.git"),
            ("branch.b.pushremote\nssh://git@host:22/o/r\0", own, "ssh://***@host:22/o/r"),
            ("branch.b.pushremote\nhttps://host/o/r\0", own, "https://host/o/r"),
            ("remote.pushdefault\nme@work\0", pd, "me@work"),
        ];
        for (listing, key, value) in rows {
            let config = crate::git::status::PushConfig::from_listing(listing);
            match super::configured_push_remote_checked(&config, &remotes, "b") {
                Err(AppError::PushRemoteUnusable {
                    branch,
                    key: k,
                    value: v,
                }) => {
                    assert_eq!((branch.as_str(), k.as_str(), v.as_str()), ("b", key, value))
                }
                other => panic!("{listing:?}: {other:?}"),
            }
        }
        let config = crate::git::status::PushConfig::from_listing("remote.pushdefault\nfork\0");
        assert_eq!(
            super::configured_push_remote_checked(&config, &remotes, "b").unwrap(),
            Some("fork")
        );
        let none = crate::git::status::PushConfig::from_listing("");
        assert_eq!(
            super::configured_push_remote_checked(&none, &remotes, "b").unwrap(),
            None
        );
    }

    /// The remote a HEAD push authenticates against: git's own routing for the bare push
    /// (None for an empty winner), the configured push remote else origin for `-u`.
    #[test]
    fn head_push_remote_follows_the_route() {
        use super::HeadRoute::{Bare, Publish};
        let remotes = sv(&["origin", "fork"]);
        let read = |listing: &str, route, head: Option<&str>, tracking| {
            let config = crate::git::status::PushConfig::from_listing(listing);
            super::head_push_remote(&config, route, head, &remotes, tracking)
        };
        let on = |listing: &str, route, head: Option<&str>| read(listing, route, head, None);
        let some = |r: &str| Some(r.to_string());
        assert_eq!(
            on("remote.solo.url\nu\0", Bare, Some("feat")).unwrap(),
            some("solo")
        );
        for push_default in ["simple", "current", "upstream", "matching"] {
            let triangular = format!(
                "push.default\n{push_default}\0branch.feat.remote\norigin\0branch.feat.pushremote\nfork\0"
            );
            assert_eq!(
                on(&triangular, Bare, Some("feat")).unwrap(),
                some("fork"),
                "{push_default}"
            );
        }
        assert_eq!(
            on(
                "remote.pushdefault\nfork\0branch.feat.remote\norigin\0",
                Bare,
                Some("feat")
            )
            .unwrap(),
            some("fork")
        );
        assert_eq!(
            on("remote.pushdefault\n\0", Bare, Some("feat")).unwrap(),
            None
        );
        assert_eq!(
            on("remote.pushdefault\nfork\0", Bare, None).unwrap(),
            some("fork")
        );
        assert_eq!(
            on("remote.pushdefault\nfork\0", Publish, Some("feat")).unwrap(),
            some("fork")
        );
        assert_eq!(
            on("remote.pushdefault\nfork\0", Publish, None).unwrap(),
            some("origin")
        );
        assert_eq!(on("", Publish, Some("feat")).unwrap(), some("origin"));
        assert!(matches!(
            on("branch.feat.pushremote\nnope\0", Publish, Some("feat")),
            Err(AppError::PushRemoteUnusable { .. })
        ));

        // An Untracked HEAD publishes by D2 whatever `branch.<b>.remote` holds, except an
        // unlisted plain name with no push remote configured, refused as the named route
        // refuses it; a tracked HEAD and a configured push remote are not.
        let untracked = Some((&Upstream::Untracked, ""));
        let ghost = "branch.feat.remote\nghost\0";
        assert!(matches!(
            read(ghost, Publish, Some("feat"), untracked),
            Err(AppError::InvalidArgument(m)) if m == "unknown remote: ghost"
        ));
        for listing in [
            "branch.feat.remote\nfork\0",
            "branch.feat.remote\nmirrors/fork.git\0",
            "",
        ] {
            assert_eq!(
                read(listing, Publish, Some("feat"), untracked).unwrap(),
                some("origin"),
                "{listing:?}"
            );
        }
        let pushdefault = format!("{ghost}remote.pushdefault\nfork\0");
        assert_eq!(
            read(&pushdefault, Publish, Some("feat"), untracked).unwrap(),
            some("fork")
        );
        let tracked = Upstream::Branch("feat".to_string());
        assert_eq!(
            read(ghost, Publish, Some("feat"), Some((&tracked, "ghost"))).unwrap(),
            some("origin")
        );
    }

    #[test]
    fn push_guard_wire_serializes_to_the_camel_case_wire_values() {
        use super::PushGuardWire;
        for (guard, wire) in [
            (PushGuardWire::LeaseAndIncludes, "leaseAndIncludes"),
            (PushGuardWire::LeaseOnlyOldGit, "leaseOnlyOldGit"),
            (PushGuardWire::LeaseOnlyNoReflog, "leaseOnlyNoReflog"),
            (
                PushGuardWire::LeasePinnedNoTrackingReflog,
                "leasePinnedNoTrackingReflog",
            ),
        ] {
            assert_eq!(
                serde_json::to_value(&guard).unwrap(),
                serde_json::Value::String(wire.to_string()),
            );
        }
        assert_eq!(
            PushGuardWire::from(PushGuard::LeaseOnlyOldGit),
            PushGuardWire::LeaseOnlyOldGit
        );
    }

    #[test]
    fn push_pins_parse_the_wire_form() {
        use super::PushPins;
        let hex40 = "A".repeat(40);
        let hex64 = "b".repeat(64);
        assert!(PushPins::from_wire(None, None).unwrap().is_none());
        assert!(PushPins::from_wire(Some("HEAD".into()), None)
            .unwrap()
            .is_some());
        assert!(PushPins::from_wire(Some("feat".into()), Some(hex40))
            .unwrap()
            .is_some());
        assert!(
            PushPins::from_wire(Some("feat".into()), Some(hex64.clone()))
                .unwrap()
                .is_some()
        );
        for (branch, head) in [
            (None, Some(hex64)),
            (Some("feat".to_string()), Some("abc".to_string())),
            (Some("feat".to_string()), Some("g".repeat(40))),
        ] {
            assert!(matches!(
                PushPins::from_wire(branch, head),
                Err(AppError::InvalidArgument(_))
            ));
        }
        assert_eq!(
            super::create_lease_arg("feat"),
            "--force-with-lease=refs/heads/feat:"
        );
        assert_eq!(
            super::pinned_lease_arg("a", "0123"),
            "--force-with-lease=refs/heads/a:0123"
        );
    }

    /// Adds a bare `fork` remote beside `seeded_origin`'s origin; returns its path.
    async fn add_fork(base: &std::path::Path, work: &str) -> String {
        let base_s = base.to_string_lossy().into_owned();
        run(&base_s, &["init", "-q", "--bare", "-b", "main", "fork.git"]).await;
        let fork = base.join("fork.git").to_string_lossy().into_owned();
        let url = format!("file://{}", fork.replace('\\', "/"));
        run(work, &["remote", "add", "fork", &url]).await;
        run(work, &["config", "remote.fork.mirror", "false"]).await;
        fork
    }

    async fn tip_of(repo: &str, full_ref: &str) -> Option<String> {
        run_git_raw(
            Some(repo),
            &["rev-parse", "--verify", "--quiet", full_ref],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .ok()
        .filter(|o| o.code == 0)
        .map(|o| o.stdout_lossy().trim().to_string())
    }

    /// The MCP core follows the configured push remote for a same-name push, and keeps the
    /// cross-name refusal when its push remote is another remote or a mirror.
    #[tokio::test]
    async fn mcp_named_push_follows_the_push_remote_but_keeps_the_cross_name_refusal() {
        let (_guard, base, origin, _url) = seeded_origin("mcp-push-remote").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let fork = add_fork(&base, &work).await;
        let state = AppState::default();
        run(&work, &["checkout", "-q", "-b", "x"]).await;
        run(&work, &["push", "-q", "-u", "origin", "x"]).await;
        run(&work, &["commit", "-qm", "on x", "--allow-empty"]).await;
        run(&work, &["config", "branch.x.pushRemote", "fork"]).await;
        let origin_x = tip_of(&origin, "refs/heads/x").await;
        git_push_same_name_core(&state, work.clone(), false, Some("x".into()), None)
            .await
            .expect("a same-name push follows the push remote");
        assert_eq!(
            tip_of(&fork, "refs/heads/x").await,
            tip_of(&work, "refs/heads/x").await
        );
        assert_eq!(tip_of(&origin, "refs/heads/x").await, origin_x);
        assert_eq!(
            run(&work, &["config", "branch.x.remote"]).await.trim(),
            "origin"
        );

        run(&work, &["checkout", "-q", "-b", "y", "origin/main"]).await;
        run(&work, &["commit", "-qm", "on y", "--allow-empty"]).await;
        run(&work, &["config", "branch.y.pushRemote", "fork"]).await;
        let main = tip_of(&origin, "refs/heads/main").await;
        for mirror in [false, true] {
            run(
                &work,
                &["config", "remote.fork.mirror", &mirror.to_string()],
            )
            .await;
            let err = git_push_same_name_core(&state, work.clone(), false, Some("y".into()), None)
                .await
                .expect_err("a cross-name push refuses");
            assert!(
                matches!(&err, AppError::PushUpstreamNameMismatch { remote_branch, .. } if remote_branch == "main"),
                "mirror={mirror}: {err:?}"
            );
            assert_eq!(tip_of(&origin, "refs/heads/main").await, main);
            assert_eq!(tip_of(&fork, "refs/heads/y").await, None);
        }
    }

    /// The HEAD `-u` publish goes to the configured push remote and tracks it; an
    /// unusable one refuses with nothing pushed anywhere.
    #[tokio::test]
    async fn head_publish_follows_the_configured_push_remote() {
        let (_guard, base, origin, _url) = seeded_origin("head-publish-remote").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let fork = add_fork(&base, &work).await;
        let state = AppState::default();
        run(&work, &["checkout", "-q", "-b", "b"]).await;
        run(&work, &["commit", "-qm", "on b", "--allow-empty"]).await;
        run(&work, &["config", "remote.pushDefault", "fork"]).await;
        git_push_same_name_core(&state, work.clone(), true, None, None)
            .await
            .expect("the HEAD publish lands on the push remote");
        assert_eq!(
            tip_of(&fork, "refs/heads/b").await,
            tip_of(&work, "refs/heads/b").await
        );
        assert_eq!(tip_of(&origin, "refs/heads/b").await, None);
        assert_eq!(
            run(&work, &["config", "branch.b.remote"]).await.trim(),
            "fork"
        );

        run(&work, &["checkout", "-q", "-b", "c"]).await;
        run(&work, &["config", "branch.c.pushRemote", "nope"]).await;
        let err = git_push_same_name_core(&state, work.clone(), true, None, None)
            .await
            .expect_err("an unusable push remote refuses");
        assert!(
            matches!(&err, AppError::PushRemoteUnusable { key, value, .. } if key == "branch.c.pushRemote" && value == "nope"),
            "{err:?}"
        );
        assert_eq!(tip_of(&fork, "refs/heads/c").await, None);
        assert_eq!(tip_of(&origin, "refs/heads/c").await, None);
    }

    /// The HEAD publish of an untracked branch with no push remote: an unlisted
    /// `branch.<b>.remote` refuses with nothing pushed; a listed one publishes to origin.
    #[tokio::test]
    async fn head_publish_refuses_an_unlisted_branch_remote() {
        let (_guard, base, origin, _url) =
            seeded_origin_unpinned_push_default("head-publish-ghost").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let fork = add_fork(&base, &work).await;
        let state = AppState::default();
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["commit", "-qm", "on feat", "--allow-empty"]).await;
        run(&work, &["config", "branch.feat.remote", "ghost"]).await;
        let err = git_push_same_name_core(&state, work.clone(), true, None, None)
            .await
            .expect_err("an unlisted branch remote refuses");
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m == "unknown remote: ghost"),
            "{err:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/feat").await, None);
        assert_eq!(tip_of(&fork, "refs/heads/feat").await, None);

        run(&work, &["config", "branch.feat.remote", "fork"]).await;
        git_push_same_name_core(&state, work.clone(), true, None, None)
            .await
            .expect("a listed branch remote publishes to origin");
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await,
            tip_of(&work, "refs/heads/feat").await
        );
        assert_eq!(tip_of(&fork, "refs/heads/feat").await, None);
    }

    /// An empty `remote.pushDefault` leaves a bare push no destination: no credentials
    /// are built and git's own refusal stands.
    #[tokio::test]
    async fn an_empty_push_default_bare_push_is_gits_refusal() {
        let (_guard, base, _origin, _url) = seeded_origin_unpinned_push_default("empty-pd").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["config", "remote.pushDefault", ""]).await;
        run(&work, &["commit", "-qm", "more", "--allow-empty"]).await;
        let state = AppState::default();
        match git_push_core_unpinned(&state, work, false, false, None, None, None).await {
            Err(AppError::Git { stderr, .. }) => assert!(
                stderr.contains("No configured push destination"),
                "{stderr}"
            ),
            other => panic!("expected git's refusal, got {other:?}"),
        }
    }

    /// Runs `git <args>` in `repo` synchronously, for a hook.
    fn git_sync(repo: &str, args: &[&str]) {
        let status = std::process::Command::new("git")
            .test_git_env()
            .current_dir(repo)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    /// A pinned push re-reads HEAD at spawn: HEAD moved to another branch while the push
    /// waits on the network lock refuses the bare and the force push; one more commit on
    /// the same branch lands the plain push and refuses the force push's tip pin. Unpinned,
    /// the moved-HEAD bare push still runs (the negative control).
    #[tokio::test(flavor = "multi_thread")]
    async fn pinned_pushes_recheck_head_and_tip_at_spawn() {
        let (_guard, base, origin, _url) = seeded_origin("pinned-recheck").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["branch", "other"]).await;
        let state = AppState::default();
        for force in [false, true] {
            run(&work, &["commit", "-qm", "next", "--allow-empty"]).await;
            let tip = tip_of(&work, "refs/heads/main").await.unwrap();
            let published = tip_of(&origin, "refs/heads/main").await;
            let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
                let work = work.clone();
                move || git_sync(&work, &["symbolic-ref", "HEAD", "refs/heads/other"])
            });
            let head = force.then_some(tip.as_str());
            let push = super::git_push_core(
                &state,
                work.clone(),
                false,
                force,
                None,
                None,
                None,
                Some(pins("main", head)),
                false,
            );
            let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
            assert!(
                matches!(&result, Err(AppError::PushHeadMoved { expected }) if expected == "main"),
                "force={force}: {result:?}"
            );
            assert_eq!(tip_of(&origin, "refs/heads/main").await, published);
            run(&work, &["symbolic-ref", "HEAD", "refs/heads/main"]).await;
        }

        // One more commit on the same branch during the wait.
        let hook = || -> std::sync::Arc<dyn Fn() + Send + Sync> {
            let work = work.clone();
            std::sync::Arc::new(move || {
                git_sync(&work, &["commit", "-qm", "late", "--allow-empty"])
            })
        };
        let tip = tip_of(&work, "refs/heads/main").await.unwrap();
        let published = tip_of(&origin, "refs/heads/main").await;
        let push = super::git_push_core(
            &state,
            work.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("main", Some(&tip))),
            false,
        );
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook(), push).await;
        assert!(
            matches!(&result, Err(AppError::PushTipMoved { branch }) if branch == "main"),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/main").await, published);
        let push = super::git_push_core(
            &state,
            work.clone(),
            false,
            false,
            None,
            None,
            None,
            Some(pins("main", None)),
            false,
        );
        NETWORK_LOCK_WAIT_HOOK
            .scope(hook(), push)
            .await
            .expect("a branch-only pin lands a commit made on the same branch");
        assert_eq!(
            tip_of(&origin, "refs/heads/main").await,
            tip_of(&work, "refs/heads/main").await
        );

        // Negative control: unpinned, the moved-HEAD push runs and pushes `other`, which
        // tracks a same-named branch so `simple` sends it.
        run(&work, &["push", "-q", "-u", "origin", "other"]).await;
        run(&work, &["symbolic-ref", "HEAD", "refs/heads/other"]).await;
        run(&work, &["commit", "-qm", "on other", "--allow-empty"]).await;
        run(&work, &["symbolic-ref", "HEAD", "refs/heads/main"]).await;
        let main_published = tip_of(&origin, "refs/heads/main").await;
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let work = work.clone();
            move || git_sync(&work, &["symbolic-ref", "HEAD", "refs/heads/other"])
        });
        let push = git_push_core_unpinned(&state, work.clone(), false, false, None, None, None);
        NETWORK_LOCK_WAIT_HOOK
            .scope(hook, push)
            .await
            .expect("an unpinned push follows the moved HEAD");
        assert_eq!(
            tip_of(&origin, "refs/heads/other").await,
            tip_of(&work, "refs/heads/other").await
        );
        assert_eq!(tip_of(&origin, "refs/heads/main").await, main_published);
    }

    /// The no-local-reflog degrade retry is a second spawn, so it re-checks the pins: HEAD
    /// moved on the hook's SECOND firing refuses it and nothing lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_degrade_retry_rechecks_the_pins() {
        let (_guard, base, origin_s, url) = seeded_origin("degrade-recheck").await;
        let base_s = base.to_string_lossy().into_owned();
        run(
            &base_s,
            &[
                "-c",
                "core.autocrlf=false",
                "clone",
                "-q",
                "-c",
                "core.logAllRefUpdates=false",
                &url,
                "nolog",
            ],
        )
        .await;
        let clone_s = base.join("nolog").to_string_lossy().into_owned();
        run(&clone_s, &["config", "user.email", "t@t.local"]).await;
        run(&clone_s, &["config", "user.name", "T"]).await;
        run(&clone_s, &["branch", "other"]).await;
        run(
            &clone_s,
            &["commit", "-q", "--allow-empty", "--amend", "-m", "amended"],
        )
        .await;
        let amended = tip_of(&clone_s, "refs/heads/main").await.unwrap();
        let published = tip_of(&origin_s, "refs/heads/main").await;
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let (fired, clone_s) = (std::sync::Arc::clone(&fired), clone_s.clone());
            move || {
                if fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                    git_sync(&clone_s, &["symbolic-ref", "HEAD", "refs/heads/other"]);
                }
            }
        });
        let state = AppState::default();
        let push = super::git_push_core(
            &state,
            clone_s.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("main", Some(&amended))),
            false,
        );
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
        assert_eq!(
            fired.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "{result:?}"
        );
        assert!(
            matches!(&result, Err(AppError::PushHeadMoved { .. })),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin_s, "refs/heads/main").await, published);
    }

    /// Puts `sha` on `remote`'s `refs/heads/feat` and drops this clone's tracking ref, so
    /// the destination exists unfetched.
    async fn plant_unfetched(work: &str, remote: &str, sha: &str) {
        run(work, &["branch", "-f", "plant", sha]).await;
        run(work, &["push", "-q", "-f", remote, "plant:feat"]).await;
        let tracking = format!("refs/remotes/{remote}/feat");
        let _ = run_git_raw(
            Some(work),
            &["update-ref", "-d", &tracking],
            TEST_GIT_HANG_GUARD,
        )
        .await;
        assert_eq!(tip_of(work, &tracking).await, None);
    }

    /// The `-u` arm's create-only lease, one row per remote state: absent creates; the
    /// same commit is clean; an unfetched ancestor or unrelated tip is refused with the
    /// remote unchanged (and, as the negative control, the same push without the lease
    /// fast-forwards the ancestor); a fetched branch takes no lease.
    #[tokio::test]
    async fn the_publish_arm_carries_the_create_only_lease() {
        let (_guard, base, origin, _url) = seeded_origin("create-lease").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let state = AppState::default();
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["commit", "-qm", "feat", "--allow-empty"]).await;
        let feat = tip_of(&work, "refs/heads/feat").await.unwrap();
        let tree = run(&work, &["rev-parse", "feat^{tree}"])
            .await
            .trim()
            .to_string();
        let unrelated = run(&work, &["commit-tree", &tree, "-m", "unrelated"])
            .await
            .trim()
            .to_string();
        let publish = || {
            git_push_core_unpinned(
                &state,
                work.clone(),
                false,
                false,
                Some("feat".into()),
                None,
                None,
            )
        };
        let reset = |work: String| async move {
            let _ = run_git_raw(
                Some(&work),
                &["config", "--unset", "branch.feat.remote"],
                TEST_GIT_HANG_GUARD,
            )
            .await;
            let _ = run_git_raw(
                Some(&work),
                &["config", "--unset", "branch.feat.merge"],
                TEST_GIT_HANG_GUARD,
            )
            .await;
            let _ = run_git_raw(
                Some(&work),
                &["push", "-q", "origin", ":refs/heads/feat"],
                TEST_GIT_HANG_GUARD,
            )
            .await;
            let _ = run_git_raw(
                Some(&work),
                &["update-ref", "-d", "refs/remotes/origin/feat"],
                TEST_GIT_HANG_GUARD,
            )
            .await;
        };

        publish().await.expect("an absent destination is created");
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await.as_deref(),
            Some(feat.as_str())
        );
        assert_eq!(
            run(&work, &["config", "branch.feat.remote"]).await.trim(),
            "origin"
        );

        reset(work.clone()).await;
        plant_unfetched(&work, "origin", &feat).await;
        publish().await.expect("the same commit exits clean");
        assert_eq!(
            run(&work, &["config", "branch.feat.remote"]).await.trim(),
            "origin"
        );

        for (row, planted) in [("ancestor", &main), ("unrelated", &unrelated)] {
            reset(work.clone()).await;
            plant_unfetched(&work, "origin", planted).await;
            let err = publish().await.expect_err(row);
            assert!(
                matches!(&err, AppError::PushDestinationExists { branch, remote, dest } if branch == "feat" && remote == "origin" && dest == "feat"),
                "{row}: {err:?}"
            );
            assert_eq!(
                tip_of(&origin, "refs/heads/feat").await.as_deref(),
                Some(planted.as_str()),
                "{row}"
            );
        }
        // Negative control: the same argv without the lease fast-forwards the ancestor.
        reset(work.clone()).await;
        plant_unfetched(&work, "origin", &main).await;
        run(
            &work,
            &[
                "push",
                "-q",
                "-u",
                "origin",
                "refs/heads/feat:refs/heads/feat",
            ],
        )
        .await;
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await.as_deref(),
            Some(feat.as_str())
        );

        // A fetched existing branch: no lease, a fast-forward.
        reset(work.clone()).await;
        run(&work, &["branch", "-f", "plant", &main]).await;
        run(&work, &["push", "-q", "origin", "plant:feat"]).await;
        assert!(tip_of(&work, "refs/remotes/origin/feat").await.is_some());
        publish().await.expect("a fetched branch fast-forwards");
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await.as_deref(),
            Some(feat.as_str())
        );
    }

    /// The copy arm leases only on `creates`: without it an unfetched ancestor on the
    /// other remote fast-forwards (the recorded consequence); with it, it is refused.
    #[tokio::test]
    async fn the_copy_arm_leases_only_on_creates() {
        let (_guard, base, _origin, _url) = seeded_origin("copy-lease").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let fork = add_fork(&base, &work).await;
        let state = AppState::default();
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["push", "-q", "-u", "origin", "feat"]).await;
        run(&work, &["commit", "-qm", "feat", "--allow-empty"]).await;
        let feat = tip_of(&work, "refs/heads/feat").await.unwrap();
        for creates in [true, false] {
            plant_unfetched(&work, "fork", &main).await;
            let result = super::git_push_core(
                &state,
                work.clone(),
                false,
                false,
                Some("feat".into()),
                Some("fork".into()),
                None,
                None,
                creates,
            )
            .await;
            if creates {
                assert!(
                    matches!(&result, Err(AppError::PushDestinationExists { remote, .. }) if remote == "fork"),
                    "{result:?}"
                );
                assert_eq!(
                    tip_of(&fork, "refs/heads/feat").await.as_deref(),
                    Some(main.as_str())
                );
            } else {
                result.expect("no create recorded: the copy fast-forwards");
                assert_eq!(
                    tip_of(&fork, "refs/heads/feat").await.as_deref(),
                    Some(feat.as_str())
                );
            }
        }
    }

    /// A bare origin whose `a` is one commit past `main`, cloned fresh, `a` switched to and
    /// amended: (guard, base, origin, url, clone, amended tip).
    async fn fresh_clone_amended(
        tag: &str,
    ) -> (
        tempfile::TempDir,
        std::path::PathBuf,
        String,
        String,
        String,
        String,
    ) {
        let (guard, base, origin, url) = seeded_origin(tag).await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["checkout", "-q", "-b", "a"]).await;
        run(&work, &["commit", "-qm", "on a", "--allow-empty"]).await;
        run(&work, &["push", "-q", "origin", "a"]).await;
        let base_s = base.to_string_lossy().into_owned();
        run(
            &base_s,
            &["-c", "core.autocrlf=false", "clone", "-q", &url, "fresh"],
        )
        .await;
        let fresh = base.join("fresh").to_string_lossy().into_owned();
        run(&fresh, &["config", "user.email", "t@t.local"]).await;
        run(&fresh, &["config", "user.name", "T"]).await;
        run(&fresh, &["config", "remote.origin.mirror", "false"]).await;
        run(&fresh, &["switch", "-q", "a"]).await;
        run(
            &fresh,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "--amend",
                "-m",
                "rewritten",
            ],
        )
        .await;
        let amended = tip_of(&fresh, "refs/heads/a").await.unwrap();
        (guard, base, origin, url, fresh, amended)
    }

    /// The three legs of the tracking-reflog degrade retry, on fixtures, independent of
    /// whether this git reproduces the false refusal.
    #[tokio::test]
    async fn the_tracking_reflog_retry_needs_all_three_legs() {
        let (_guard, _base, _origin, _url, fresh, _amended) = fresh_clone_amended("fii-legs").await;
        let tracking = "refs/remotes/origin/a";
        let pre = tip_of(&fresh, tracking).await.unwrap();
        let main = tip_of(&fresh, "refs/remotes/origin/main").await.unwrap();
        let allowed = |pre: String| {
            let fresh = fresh.clone();
            async move {
                super::tracking_reflog_retry_allowed(&fresh, "refs/heads/a", tracking, &pre).await
            }
        };
        let entries = run(
            &fresh,
            &["reflog", "show", "-n", "1", "--format=%H", tracking],
        )
        .await;
        if entries.trim().is_empty() {
            assert!(allowed(pre.clone()).await, "fresh clone + amend");
        } else {
            eprintln!(
                "this git writes a reflog for a cloned tracking ref; the fresh-clone row is moot"
            );
        }
        assert!(
            !allowed(main.clone()).await,
            "tracking ref moved since the pre-read"
        );

        // A branch re-pointed at a tip its reflog never held.
        run(&fresh, &["branch", "c", "origin/main"]).await;
        run(&fresh, &["branch", "-q", "--set-upstream-to=origin/a", "c"]).await;
        assert!(
            !super::tracking_reflog_retry_allowed(&fresh, "refs/heads/c", tracking, &pre).await,
            "--set-upstream-to at an unheld tip"
        );

        run(
            &fresh,
            &[
                "update-ref",
                "--create-reflog",
                "-m",
                "away",
                tracking,
                &main,
            ],
        )
        .await;
        run(&fresh, &["update-ref", "-m", "back", tracking, &pre]).await;
        assert!(
            !allowed(pre.clone()).await,
            "a tracking reflog with one entry"
        );
        run(&fresh, &["reflog", "expire", "--expire=now", tracking]).await;
        assert!(
            run(&fresh, &["reflog", "show", "--format=%H", tracking])
                .await
                .trim()
                .is_empty(),
            "the expired reflog has no entries"
        );
        assert!(allowed(pre).await, "a tracking reflog with zero entries");
    }

    /// The pinned force push lands on a fresh clone whatever this git does about the
    /// missing tracking reflog; a remote moved by another clone and not fetched is still
    /// refused; the MCP core, on a fixture of its own, never takes the arm.
    #[tokio::test]
    async fn a_pinned_force_push_lands_on_a_fresh_clone() {
        let state = AppState::default();
        let (_mcp_guard, _, mcp_origin, _, mcp_fresh, mcp_amended) =
            fresh_clone_amended("fii-mcp").await;
        match super::git_force_push_head_core(&state, mcp_fresh).await {
            Ok(guard) => {
                eprintln!("the MCP core landed with {guard:?}: this git no longer refuses");
                assert_eq!(
                    tip_of(&mcp_origin, "refs/heads/a").await.as_deref(),
                    Some(mcp_amended.as_str())
                );
            }
            Err(AppError::Git { stderr, .. }) => {
                assert_rejection_reason(&stderr, IF_INCLUDES_REJECTION)
            }
            Err(other) => panic!("the MCP core: {other:?}"),
        }

        let (_guard, base, origin, url, fresh, amended) = fresh_clone_amended("fii-e2e").await;
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let fired = std::sync::Arc::clone(&fired);
            move || {
                fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        });
        let push = super::git_push_core(
            &state,
            fresh.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("a", Some(&amended))),
            false,
        );
        let guard = NETWORK_LOCK_WAIT_HOOK
            .scope(hook, push)
            .await
            .expect("the pinned force push lands");
        eprintln!("the pinned force push reported {guard:?}");
        // One lock wait is the first attempt landing; two is the degrade retry, which
        // must say so.
        match fired.load(std::sync::atomic::Ordering::SeqCst) {
            1 => assert_eq!(guard, super::PushGuardWire::LeaseAndIncludes),
            2 => assert_eq!(guard, super::PushGuardWire::LeasePinnedNoTrackingReflog),
            n => panic!("{n} lock waits: {guard:?}"),
        }
        assert_eq!(
            tip_of(&origin, "refs/heads/a").await.as_deref(),
            Some(amended.as_str())
        );

        // Moved by another clone, not fetched: the first attempt's own lease is stale and
        // refuses it, so the degrade arm never runs; the remote is unchanged.
        let base_s = base.to_string_lossy().into_owned();
        run(
            &base_s,
            &["-c", "core.autocrlf=false", "clone", "-q", &url, "other"],
        )
        .await;
        let other = base.join("other").to_string_lossy().into_owned();
        run(&other, &["config", "user.email", "t@t.local"]).await;
        run(&other, &["config", "user.name", "T"]).await;
        run(&other, &["switch", "-q", "a"]).await;
        run(&other, &["commit", "-qm", "theirs", "--allow-empty"]).await;
        run(&other, &["push", "-q", "origin", "a"]).await;
        let theirs = tip_of(&origin, "refs/heads/a").await;
        run(
            &fresh,
            &["commit", "-q", "--allow-empty", "--amend", "-m", "again"],
        )
        .await;
        let again = tip_of(&fresh, "refs/heads/a").await.unwrap();
        let result = super::git_push_core(
            &state,
            fresh.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("a", Some(&again))),
            false,
        )
        .await;
        match &result {
            Err(AppError::Git { stderr, .. }) => {
                assert_rejection_reason(stderr, STALE_LEASE_REJECTION)
            }
            other => panic!("the moved remote: {other:?}"),
        }
        assert_eq!(tip_of(&origin, "refs/heads/a").await, theirs);
    }

    /// The degrade retry's argv is the pinned lease alone; every other HEAD force push
    /// takes the bare lease plus `--force-if-includes`.
    #[test]
    fn the_head_force_argv_takes_one_lease_or_the_pair() {
        let sha = "c".repeat(40);
        let pin = super::LeasePin {
            remote: "origin".to_string(),
            dest: "a".to_string(),
            sha: sha.clone(),
            refusal: (1, String::new()),
        };
        let pinned = format!("--force-with-lease=refs/heads/a:{sha}");
        assert_eq!(
            super::head_push_argv(true, Some(&pin)),
            sv(&["push", &pinned])
        );
        assert_eq!(
            super::head_push_argv(true, None),
            sv(&["push", "--force-with-lease", FORCE_IF_INCLUDES])
        );
        assert_eq!(super::head_push_argv(false, Some(&pin)), sv(&["push"]));
        assert_eq!(super::head_push_argv(false, None), sv(&["push"]));
    }

    /// The degrade retry runs under the lease pinned to the pre-read tracking tip: a
    /// commit another clone pushes between the first attempt and the retry (the hook's
    /// SECOND firing), fetched into this clone's tracking ref so an implicit lease would
    /// pass, refuses the retry and stays on the remote.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_degrade_retry_keeps_its_pinned_lease() {
        let (_guard, base, origin, url, fresh, amended) = fresh_clone_amended("fii-race").await;
        let base_s = base.to_string_lossy().into_owned();
        run(
            &base_s,
            &["-c", "core.autocrlf=false", "clone", "-q", &url, "other"],
        )
        .await;
        let other = base.join("other").to_string_lossy().into_owned();
        run(&other, &["config", "user.email", "t@t.local"]).await;
        run(&other, &["config", "user.name", "T"]).await;
        run(&other, &["switch", "-q", "a"]).await;
        run(&other, &["commit", "-qm", "theirs", "--allow-empty"]).await;
        let theirs = tip_of(&other, "refs/heads/a").await.unwrap();
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let (fired, other, fresh) =
                (std::sync::Arc::clone(&fired), other.clone(), fresh.clone());
            move || {
                if fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                    git_sync(&other, &["push", "-q", "origin", "a"]);
                    git_sync(
                        &fresh,
                        &["fetch", "-q", "origin", "a:refs/remotes/origin/a"],
                    );
                }
            }
        });
        assert!(
            super::branch_has_reflog(&fresh, "a").await,
            "the degrade arm needs a branch reflog"
        );
        let state = AppState::default();
        let push = super::git_push_core(
            &state,
            fresh.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("a", Some(&amended))),
            false,
        );
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
        let firings = fired.load(std::sync::atomic::Ordering::SeqCst);
        // A git whose `--force-if-includes` accepts a tracking ref with no reflog lands the
        // first attempt (one firing); one that refuses it runs the degrade retry (two).
        if firings == 1 && matches!(result, Ok(super::PushGuardWire::LeaseAndIncludes)) {
            assert_eq!(
                tip_of(&origin, "refs/heads/a").await.as_deref(),
                Some(amended.as_str())
            );
            return;
        }
        // Two firings: the first attempt is refused and the degrade retry runs.
        assert_eq!(firings, 2, "{result:?}");
        match &result {
            Err(AppError::Git { stderr, .. }) => {
                assert_rejection_reason(stderr, STALE_LEASE_REJECTION)
            }
            other => panic!("the retry over a moved remote: {other:?}"),
        }
        assert_eq!(
            tip_of(&origin, "refs/heads/a").await.as_deref(),
            Some(theirs.as_str())
        );
    }

    /// The degrade retry's tip was read for origin: a `remote.pushDefault` switched to
    /// another remote before the retry (the hook's SECOND firing) repeats the first
    /// attempt's refusal, and that remote's branch, sitting at exactly the pinned tip,
    /// keeps it.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_degrade_retry_refuses_a_moved_route() {
        let (_guard, base, origin, _url, fresh, amended) = fresh_clone_amended("fii-route").await;
        let base_s = base.to_string_lossy().into_owned();
        run(
            &base_s,
            &["init", "-q", "--bare", "-b", "main", "second.git"],
        )
        .await;
        let second = base.join("second.git").to_string_lossy().into_owned();
        let second_url = format!("file://{}", second.replace('\\', "/"));
        run(&fresh, &["remote", "add", "second", &second_url]).await;
        run(&fresh, &["config", "remote.second.mirror", "false"]).await;
        run(
            &fresh,
            &["push", "-q", "second", "refs/remotes/origin/a:refs/heads/a"],
        )
        .await;
        let pinned_tip = tip_of(&second, "refs/heads/a").await;
        let published = tip_of(&origin, "refs/heads/a").await;
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let (fired, fresh) = (std::sync::Arc::clone(&fired), fresh.clone());
            move || {
                if fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                    git_sync(&fresh, &["config", "remote.pushDefault", "second"]);
                }
            }
        });
        let state = AppState::default();
        let push = super::git_push_core(
            &state,
            fresh.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("a", Some(&amended))),
            false,
        );
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
        let firings = fired.load(std::sync::atomic::Ordering::SeqCst);
        if firings == 1 && matches!(result, Ok(super::PushGuardWire::LeaseAndIncludes)) {
            assert_eq!(
                tip_of(&origin, "refs/heads/a").await.as_deref(),
                Some(amended.as_str())
            );
            assert_eq!(tip_of(&second, "refs/heads/a").await, pinned_tip);
            return;
        }
        // Two firings: the first attempt is refused and the degrade retry runs.
        assert_eq!(firings, 2, "{result:?}");
        match &result {
            Err(AppError::Git { stderr, .. }) => {
                assert_rejection_reason(stderr, IF_INCLUDES_REJECTION)
            }
            other => panic!("the retry over a moved route: {other:?}"),
        }
        assert_eq!(tip_of(&second, "refs/heads/a").await, pinned_tip);
        assert_eq!(tip_of(&origin, "refs/heads/a").await, published);
    }

    /// The fresh-clone fallback also covers a triangular `simple` push (upstream on one
    /// remote, `remote.pushDefault` another), where `%(push)` resolves nothing: the pinned
    /// force push lands on the push remote and the upstream's remote is untouched.
    #[tokio::test]
    async fn a_pinned_triangular_force_push_lands_on_a_fresh_clone() {
        let (_guard, base, origin, url, fresh, amended) = fresh_clone_amended("fii-tri").await;
        let base_s = base.to_string_lossy().into_owned();
        run(&base_s, &["clone", "-q", "--bare", &url, "upstream.git"]).await;
        let upstream = base.join("upstream.git").to_string_lossy().into_owned();
        let upstream_url = format!("file://{}", upstream.replace('\\', "/"));
        run(&fresh, &["remote", "add", "upstream", &upstream_url]).await;
        run(&fresh, &["config", "remote.upstream.mirror", "false"]).await;
        run(&fresh, &["fetch", "-q", "upstream"]).await;
        run(
            &fresh,
            &["branch", "-q", "--set-upstream-to=upstream/a", "a"],
        )
        .await;
        run(&fresh, &["config", "remote.pushDefault", "origin"]).await;
        let upstream_tip = tip_of(&upstream, "refs/heads/a").await;
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let fired = std::sync::Arc::clone(&fired);
            move || {
                fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        });
        let state = AppState::default();
        let push = super::git_push_core(
            &state,
            fresh.clone(),
            false,
            true,
            None,
            None,
            None,
            Some(pins("a", Some(&amended))),
            false,
        );
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, push).await;
        let firings = fired.load(std::sync::atomic::Ordering::SeqCst);
        if firings == 1 && matches!(result, Ok(super::PushGuardWire::LeaseAndIncludes)) {
            assert_eq!(
                tip_of(&origin, "refs/heads/a").await.as_deref(),
                Some(amended.as_str())
            );
            assert_eq!(tip_of(&upstream, "refs/heads/a").await, upstream_tip);
            return;
        }
        let guard = result.expect("the pinned triangular force push lands");
        // Two lock waits: the first attempt is refused and the triangular fallback retries.
        assert_eq!(firings, 2);
        assert_eq!(guard, super::PushGuardWire::LeasePinnedNoTrackingReflog);
        assert_eq!(
            tip_of(&origin, "refs/heads/a").await.as_deref(),
            Some(amended.as_str())
        );
        assert_eq!(tip_of(&upstream, "refs/heads/a").await, upstream_tip);
    }

    /// A pinned bare FORCE push is refused where git's routing sends more than HEAD's
    /// branch: under `push.default=matching` nothing lands, `other`'s rewrite included,
    /// while the pinned PLAIN push still runs as git routes it; a push remote with push
    /// refspecs is refused the same way. Unpinned (the MCP shape), the force push keeps
    /// git's routing and rewrites `other`, the control that the fixture reaches it.
    #[tokio::test]
    async fn a_pinned_force_push_refuses_a_multi_ref_route() {
        use crate::error::PushMultiRefCause;
        let (_guard, base, origin, _url) = seeded_origin("force-multi-ref").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let state = AppState::default();
        run(&work, &["branch", "other"]).await;
        run(&work, &["push", "-q", "origin", "other"]).await;
        run(&work, &["config", "push.default", "matching"]).await;
        run(&work, &["checkout", "-q", "other"]).await;
        run(&work, &["commit", "-qm", "plain other", "--allow-empty"]).await;
        run(&work, &["checkout", "-q", "main"]).await;
        run(&work, &["commit", "-qm", "plain", "--allow-empty"]).await;
        super::git_push_core(
            &state,
            work.clone(),
            false,
            false,
            None,
            None,
            None,
            Some(pins("main", None)),
            false,
        )
        .await
        .expect("a pinned plain push under matching runs");
        assert_eq!(
            tip_of(&origin, "refs/heads/main").await,
            tip_of(&work, "refs/heads/main").await
        );
        assert_eq!(
            tip_of(&origin, "refs/heads/other").await,
            tip_of(&work, "refs/heads/other").await,
            "the plain push keeps git's matching routing"
        );

        let tree = run(&work, &["rev-parse", "HEAD^{tree}"]).await;
        let root = run(
            &work,
            &["commit-tree", tree.trim(), "-m", "rewritten other"],
        )
        .await;
        run(&work, &["branch", "-f", "other", root.trim()]).await;
        run(
            &work,
            &["commit", "-q", "--allow-empty", "--amend", "-m", "amended"],
        )
        .await;
        let tip = tip_of(&work, "refs/heads/main").await.unwrap();
        let main_before = tip_of(&origin, "refs/heads/main").await;
        let other_before = tip_of(&origin, "refs/heads/other").await;
        let force = || {
            super::git_push_core(
                &state,
                work.clone(),
                false,
                true,
                None,
                None,
                None,
                Some(pins("main", Some(&tip))),
                false,
            )
        };
        let result = force().await;
        assert!(
            matches!(&result, Err(AppError::PushForceMultiRef { branch, remote, cause: PushMultiRefCause::Matching }) if branch == "main" && remote == "origin"),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/main").await, main_before);
        assert_eq!(tip_of(&origin, "refs/heads/other").await, other_before);

        run(&work, &["config", "--unset", "push.default"]).await;
        run(
            &work,
            &[
                "config",
                "remote.origin.push",
                "refs/heads/main:refs/heads/main",
            ],
        )
        .await;
        let result = force().await;
        assert!(
            matches!(&result, Err(AppError::PushForceMultiRef { branch, remote, cause: PushMultiRefCause::Refspecs }) if branch == "main" && remote == "origin"),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/main").await, main_before);

        // Matching set between the early check and the spawn: the spawn recheck refuses.
        run(&work, &["config", "--unset", "remote.origin.push"]).await;
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let (fired, work) = (std::sync::Arc::clone(&fired), work.clone());
            move || {
                if fired.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    git_sync(&work, &["config", "push.default", "matching"]);
                }
            }
        });
        let result = NETWORK_LOCK_WAIT_HOOK.scope(hook, force()).await;
        assert_eq!(
            fired.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "{result:?}"
        );
        assert!(
            matches!(
                &result,
                Err(AppError::PushForceMultiRef {
                    cause: PushMultiRefCause::Matching,
                    ..
                })
            ),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/main").await, main_before);
        assert_eq!(tip_of(&origin, "refs/heads/other").await, other_before);

        run(&work, &["config", "push.default", "matching"]).await;
        git_push_core_unpinned(&state, work.clone(), false, true, None, None, None)
            .await
            .expect("an unpinned force push keeps git's routing");
        assert_eq!(
            tip_of(&origin, "refs/heads/other").await.as_deref(),
            Some(root.trim())
        );
    }

    /// A URL push remote's userinfo never reaches the multi-ref refusal, field or message.
    #[tokio::test]
    async fn a_multi_ref_refusal_redacts_a_url_push_remote() {
        use crate::error::PushMultiRefCause;
        const URL: &str = "https://user:secret@example.invalid/o/r.git";
        const REDACTED: &str = "https://***@example.invalid/o/r.git";
        let (_guard, base, _origin, _url) = seeded_origin("force-multi-ref-redact").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["config", "remote.pushDefault", URL]).await;
        run(&work, &["config", "push.default", "matching"]).await;
        let Err(err) = super::refuse_head_push(
            &work,
            super::HeadRoute::Bare,
            Some(&pins("main", None)),
            true,
        )
        .await
        else {
            panic!("a forced matching push to a URL remote is refused");
        };
        assert!(
            matches!(&err, AppError::PushForceMultiRef { branch, remote, cause: PushMultiRefCause::Matching } if branch == "main" && remote == REDACTED),
            "{err:?}"
        );
        assert!(!format!("{err:?}").contains("secret"), "{err:?}");
        assert!(!serde_json::to_string(&err).unwrap().contains("secret"));

        run(&work, &["config", "--unset", "push.default"]).await;
        run(
            &work,
            &[
                "config",
                "remote.https://user:secret@example.invalid/o/r.git.push",
                "refs/heads/main:refs/heads/main",
            ],
        )
        .await;
        let Err(err) = super::refuse_head_push(
            &work,
            super::HeadRoute::Bare,
            Some(&pins("main", None)),
            true,
        )
        .await
        else {
            panic!("a forced push to a URL remote with push refspecs is refused");
        };
        assert!(
            matches!(&err, AppError::PushForceMultiRef { branch, remote, cause: PushMultiRefCause::Refspecs } if branch == "main" && remote == REDACTED),
            "{err:?}"
        );
        assert_eq!(
            err.to_string(),
            "https://***@example.invalid/o/r.git has push refspecs of its own, so a force push could rewrite other branches too. Nothing was pushed. Force-push main from a terminal, naming the branch."
        );
        assert!(!format!("{err:?}").contains("secret"), "{err:?}");
        assert!(!serde_json::to_string(&err).unwrap().contains("secret"));
    }

    /// The rename's push always arms the create-only lease, even with the destination's
    /// tracking ref present, and never follows tags; the same-name core, under the same
    /// `push.followTags`, does follow them (the control that the setting is live).
    #[tokio::test]
    async fn the_creating_core_always_leases_and_never_follows_tags() {
        let (_guard, base, origin, _url) = seeded_origin("creating-core").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let state = AppState::default();
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["commit", "-qm", "feat", "--allow-empty"]).await;
        run(&work, &["push", "-q", "origin", "main:feat"]).await;
        assert!(tip_of(&work, "refs/remotes/origin/feat").await.is_some());
        let err =
            super::git_push_creating_core(&state, work.clone(), "feat".into(), "origin".into())
                .await
                .expect_err("an ancestor already at the name");
        assert!(
            matches!(&err, AppError::PushDestinationExists { branch, remote, dest } if branch == "feat" && remote == "origin" && dest == "feat"),
            "{err:?}"
        );
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await.as_deref(),
            Some(main.as_str())
        );

        run(&work, &["config", "push.followTags", "true"]).await;
        run(&work, &["checkout", "-q", "-b", "fresh"]).await;
        run(&work, &["commit", "-qm", "fresh", "--allow-empty"]).await;
        run(&work, &["tag", "-a", "v-fresh", "-m", "t"]).await;
        super::git_push_creating_core(&state, work.clone(), "fresh".into(), "origin".into())
            .await
            .expect("the new name publishes");
        assert_eq!(
            tip_of(&origin, "refs/heads/fresh").await,
            tip_of(&work, "refs/heads/fresh").await
        );
        assert_eq!(tip_of(&origin, "refs/tags/v-fresh").await, None);
        assert_eq!(
            run(&work, &["config", "--get", "branch.fresh.remote"])
                .await
                .trim(),
            "origin"
        );

        run(&work, &["checkout", "-q", "-b", "tagged"]).await;
        run(&work, &["commit", "-qm", "tagged", "--allow-empty"]).await;
        run(&work, &["tag", "-a", "v-tagged", "-m", "t"]).await;
        super::git_push_same_name_core(&state, work.clone(), true, Some("tagged".into()), None)
            .await
            .expect("the same-name core publishes");
        assert!(
            tip_of(&origin, "refs/tags/v-tagged").await.is_some(),
            "push.followTags is live in this fixture"
        );
    }

    /// The stale-lease predicate reads git's own ref status line, the create and delete
    /// shapes measured on git 2.51.1; `remote:` text and other rejections never match.
    #[test]
    fn the_stale_lease_predicate_reads_only_gits_status_line() {
        use super::is_stale_lease_rejection as stale;
        assert!(stale(
            " ! [rejected]        feature -> feature (stale info)\nerror: failed to push some refs to 'C:/temp/remote.git'"
        ));
        assert!(stale(
            "To ../o.git\n ! [rejected]        (delete) -> old (stale info)\nerror: failed to push some refs to '../o.git'"
        ));
        assert!(stale(
            "To x\r\n ! [rejected]        a -> a (stale info)\r\n"
        ));
        assert!(!stale(
            "remote: ! [rejected] a -> a (stale info)\nTo x\n ! [remote rejected] a -> a (pre-receive hook declined)"
        ));
        assert!(!stale(
            "remote: hook text (stale info)\nTo x\n ! [rejected]        a -> a (non-fast-forward)"
        ));
        assert!(!stale(" ! [rejected]        a -> a (fetch first)"));
        assert!(!stale(""));
        // color.transport=always colors the flag; the status line reads through it.
        assert!(stale(
            "To x\n \x1b[31m! [rejected]        \x1b[m a -> a (stale info)\n"
        ));
        assert!(stale(" \x1b[1m\x1b[31;1m! [rejected] a -> a (stale info)"));
        assert!(!stale("remote: \x1b[31m! [rejected] a -> a (stale info)"));
        assert_eq!(super::rejection_status_line(" \x1b[31m! x "), "! x");
        assert_eq!(super::rejection_status_line("\x1b[31x! x"), "\x1b[31x! x");
    }

    /// The HEAD `-u` publish carries the create-only lease: an unfetched ancestor on the
    /// destination is refused and the remote is unchanged.
    #[tokio::test]
    async fn the_head_publish_carries_the_create_only_lease() {
        let (_guard, base, origin, _url) = seeded_origin("head-create-lease").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let state = AppState::default();
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["commit", "-qm", "feat", "--allow-empty"]).await;
        plant_unfetched(&work, "origin", &main).await;
        // The same refusal under color.transport=always, which colors git's status line.
        for color in ["false", "always"] {
            run(&work, &["config", "color.transport", color]).await;
            let err = super::git_push_same_name_core(&state, work.clone(), true, None, None)
                .await
                .expect_err("an unfetched ancestor");
            assert!(
                matches!(&err, AppError::PushDestinationExists { branch, remote, dest } if branch == "feat" && remote == "origin" && dest == "feat"),
                "color.transport={color}: {err:?}"
            );
            assert_eq!(
                tip_of(&origin, "refs/heads/feat").await.as_deref(),
                Some(main.as_str())
            );
        }
    }

    /// A followed tag lands beside the branch the create-only lease refuses: the refusal
    /// still names the destination, and its text says only the branch wasn't pushed.
    #[tokio::test]
    async fn a_followed_tag_beside_a_stale_lease_still_names_the_destination() {
        let (_guard, base, origin, _url) = seeded_origin("followed-tag-lease").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let state = AppState::default();
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&work, &["config", "push.followTags", "true"]).await;
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        plant_unfetched(&work, "origin", &main).await;
        let rows = [
            ("false", "v-plain", "refs/tags/v-plain"),
            ("always", "v-color", "refs/tags/v-color"),
        ];
        for (color, tag, tag_ref) in rows {
            run(&work, &["config", "color.transport", color]).await;
            run(&work, &["commit", "-qm", tag, "--allow-empty"]).await;
            run(&work, &["tag", "-a", tag, "-m", "t"]).await;
            let err = super::git_push_same_name_core(&state, work.clone(), true, None, None)
                .await
                .expect_err("an unfetched ancestor");
            assert!(
                matches!(&err, AppError::PushDestinationExists { branch, remote, dest } if branch == "feat" && remote == "origin" && dest == "feat"),
                "color.transport={color}: {err:?}"
            );
            assert!(
                !err.to_string().contains("nothing was pushed"),
                "color.transport={color}: {err}"
            );
            assert!(tip_of(&origin, tag_ref).await.is_some(), "{tag_ref} landed");
            assert_eq!(
                tip_of(&origin, "refs/heads/feat").await.as_deref(),
                Some(main.as_str())
            );
        }
    }

    /// A remote with two push URLs reports one `To` block per URL, and the first may have
    /// created the branch: a stale lease on the second keeps git's own text, never
    /// "nothing was pushed".
    #[tokio::test]
    async fn a_two_push_url_publish_keeps_gits_report() {
        let (_guard, base, origin, url) = seeded_origin("two-push-urls").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let base_s = base.to_string_lossy().into_owned();
        let state = AppState::default();
        run(&base_s, &["clone", "-q", "--bare", &url, "second.git"]).await;
        let second = base.join("second.git").to_string_lossy().into_owned();
        let second_url = format!("file://{}", second.replace('\\', "/"));
        let main = tip_of(&work, "refs/heads/main").await.unwrap();
        run(&second, &["update-ref", "refs/heads/feat", &main]).await;
        run(&work, &["config", "--add", "remote.origin.pushurl", &url]).await;
        run(
            &work,
            &["config", "--add", "remote.origin.pushurl", &second_url],
        )
        .await;
        run(&work, &["checkout", "-q", "-b", "feat"]).await;
        run(&work, &["commit", "-qm", "feat", "--allow-empty"]).await;
        let err = super::git_push_same_name_core(&state, work.clone(), true, None, None)
            .await
            .expect_err("the second URL holds the name");
        match &err {
            AppError::Git { stderr, .. } => assert_rejection_reason(stderr, STALE_LEASE_REJECTION),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            tip_of(&origin, "refs/heads/feat").await,
            tip_of(&work, "refs/heads/feat").await
        );
        assert_eq!(
            tip_of(&second, "refs/heads/feat").await.as_deref(),
            Some(main.as_str())
        );
    }

    /// A pinned push whose HEAD moved to a branch carrying a refusal of its own (Keep
    /// local) answers `PushHeadMoved`, never the other branch's refusal.
    #[tokio::test]
    async fn a_moved_head_outranks_the_other_branch_refusal() {
        let (_guard, work, origin) = keep_local_origin("pin-precedence").await;
        run(&work, &["branch", "other"]).await;
        crate::git::branches::set_branch_keep_local_core(&work, "other", true)
            .await
            .unwrap();
        run(&work, &["symbolic-ref", "HEAD", "refs/heads/other"]).await;
        let published = feat_x_tip(&origin).await;
        let state = AppState::default();
        for force in [false, true] {
            let result = super::git_push_core(
                &state,
                work.clone(),
                false,
                force,
                None,
                None,
                None,
                Some(pins("feat/x", None)),
                false,
            )
            .await;
            assert!(
                matches!(&result, Err(AppError::PushHeadMoved { expected }) if expected == "feat/x"),
                "force={force}: {result:?}"
            );
            assert_eq!(feat_x_tip(&origin).await, published);
        }
    }

    /// The spawn recheck compares the pins after the route's reads, on both routes (the
    /// bare push rechecks HEAD, the `-u` publish its named branch): HEAD moved between
    /// them (the hook) refuses the push and nothing lands.
    #[tokio::test]
    async fn the_spawn_recheck_compares_the_pins_last() {
        let (_guard, base, origin, _url) = seeded_origin("pin-order").await;
        let work = base.join("work").to_string_lossy().into_owned();
        run(&work, &["branch", "other"]).await;
        run(&work, &["commit", "-qm", "next", "--allow-empty"]).await;
        let published = tip_of(&origin, "refs/heads/main").await;
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = std::sync::Arc::new({
            let work = work.clone();
            move || git_sync(&work, &["symbolic-ref", "HEAD", "refs/heads/other"])
        });
        let state = AppState::default();
        for set_upstream in [false, true] {
            run(&work, &["symbolic-ref", "HEAD", "refs/heads/main"]).await;
            let push = super::git_push_core(
                &state,
                work.clone(),
                set_upstream,
                false,
                None,
                None,
                None,
                Some(pins("main", None)),
                false,
            );
            let result = super::RECHECK_PINS_HOOK.scope(hook.clone(), push).await;
            assert!(
                matches!(&result, Err(AppError::PushHeadMoved { expected }) if expected == "main"),
                "set_upstream={set_upstream}: {result:?}"
            );
            assert_eq!(
                tip_of(&origin, "refs/heads/main").await,
                published,
                "set_upstream={set_upstream}"
            );
        }
    }

    /// A named push of a branch tracking a remote named `-x` (a live upstream through its
    /// fetch refspec) is refused as an invalid remote name before anything is spawned toward
    /// it; a branch whose `branch.<b>.remote` names no remote at all is refused as unknown.
    #[tokio::test]
    async fn a_dash_named_upstream_remote_is_refused() {
        let (_guard, base, _origin, _url) =
            seeded_origin_unpinned_push_default("dash-remote").await;
        let work = base.join("work").to_string_lossy().into_owned();
        let base_s = base.to_string_lossy().into_owned();
        run(&base_s, &["init", "-q", "--bare", "-b", "main", "dash.git"]).await;
        let dash = base.join("dash.git").to_string_lossy().into_owned();
        let url = format!("file://{}", dash.replace('\\', "/"));
        run(&work, &["remote", "add", "--", "-x", &url]).await;
        run(&work, &["config", "remote.-x.mirror", "false"]).await;
        assert_eq!(
            run(&work, &["config", "--get", "remote.-x.fetch"])
                .await
                .trim(),
            "+refs/heads/*:refs/remotes/-x/*"
        );
        run(&work, &["branch", "feat"]).await;
        run(
            &work,
            &["update-ref", "refs/remotes/-x/feat", "refs/heads/feat"],
        )
        .await;
        run(
            &work,
            &["config", "--replace-all", "branch.feat.remote", "-x"],
        )
        .await;
        run(&work, &["config", "branch.feat.merge", "refs/heads/feat"]).await;
        let format = "--format=%(upstream:remotename)|%(upstream:remoteref)";
        assert_eq!(
            run(&work, &["for-each-ref", format, "refs/heads/feat"])
                .await
                .trim(),
            "-x|refs/heads/feat",
            "a live upstream on the dash-named remote"
        );
        let state = AppState::default();
        let push = || {
            git_push_core_unpinned(
                &state,
                work.clone(),
                false,
                false,
                Some("feat".into()),
                None,
                None,
            )
        };
        let result = push().await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(m)) if m == "invalid remote name: -x"),
            "{result:?}"
        );
        assert_eq!(tip_of(&dash, "refs/heads/feat").await, None);

        // A missing remote empties every upstream atom: refused, never published to origin.
        let origin = base.join("origin.git").to_string_lossy().into_owned();
        run(&work, &["branch", "topic"]).await;
        run(&work, &["config", "branch.topic.remote", "missing"]).await;
        run(&work, &["config", "branch.topic.merge", "refs/heads/topic"]).await;
        let format = "--format=%(upstream:remotename)|%(upstream:remoteref)";
        assert_eq!(
            run(&work, &["for-each-ref", format, "refs/heads/topic"])
                .await
                .trim(),
            "|",
            "the atoms read empty"
        );
        let result = git_push_core_unpinned(
            &state,
            work.clone(),
            false,
            false,
            Some("topic".into()),
            None,
            None,
        )
        .await;
        assert!(
            matches!(&result, Err(AppError::InvalidArgument(m)) if m == "unknown remote: missing"),
            "{result:?}"
        );
        assert_eq!(tip_of(&origin, "refs/heads/topic").await, None);
        assert_eq!(
            run(&work, &["config", "--get", "branch.topic.remote"])
                .await
                .trim(),
            "missing",
            "tracking is left alone"
        );
    }

    /// A `HEAD` pin matches only a detached HEAD and a branch pin never does; over an
    /// unborn HEAD the pinned tip's read is that read's error.
    #[tokio::test]
    async fn push_pins_compare_a_detached_head() {
        let moved = |result: crate::error::AppResult<()>, want: &str| {
            assert!(
                matches!(&result, Err(AppError::PushHeadMoved { expected }) if expected == want),
                "{want}: {result:?}"
            );
        };
        let head = pins("HEAD", None);
        moved(head.check("", Some("refs/heads/main")).await, "HEAD");
        head.check("", None).await.expect("detached, as pinned");
        moved(pins("main", None).check("", None).await, "main");

        let (_guard, base) = temp_base("pins-unborn");
        let repo = base.to_string_lossy().into_owned();
        run(&repo, &["init", "-q", "-b", "main"]).await;
        let tip = "a".repeat(40);
        let result = pins("main", Some(&tip)).check_now(&repo).await;
        assert!(
            matches!(&result, Err(AppError::Git { .. })),
            "an unborn HEAD's tip read: {result:?}"
        );
    }

    /// A destination branch name is meaningless without both an explicit branch and
    /// an explicit remote, so those combinations are refused rather than silently
    /// dropping the destination. Guarded before any git call — no repo needed.
    /// The MESSAGE is the assertion: the remote-without-branch row would ALSO be
    /// satisfied by the next guard's "remote requires an explicit branch", so a
    /// variant-only match cannot tell which one refused it.
    #[tokio::test]
    async fn remote_branch_requires_both_branch_and_remote() {
        let state = AppState::default();
        for (branch, remote) in [
            (None, None),
            (Some("local".to_string()), None),
            (None, Some("fork".to_string())),
        ] {
            let err = git_push_core_unpinned(
                &state,
                "/definitely/not/a/repo".into(),
                false,
                false,
                branch.clone(),
                remote.clone(),
                Some("contrib".into()),
            )
            .await
            .expect_err("a lone remote_branch is refused");
            assert!(
                matches!(&err, AppError::InvalidArgument(m) if m.contains("remote branch requires")),
                "branch={branch:?} remote={remote:?} → {err:?}"
            );
        }
    }

    /// The destination name is interpolated into the refspec's right-hand side, so
    /// it takes the same refspec-injection blocklist as the local branch: `*` would
    /// mirror-push, `:` would add a refspec field. Then the accepted arm is driven
    /// end to end against a real bare remote.
    #[tokio::test]
    async fn push_to_a_named_remote_branch_validates_then_lands_on_that_ref() {
        let (_base, base) = temp_base("remote-branch");
        let repo = base.join("repo");
        let fork = base.join("fork.git");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&fork).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        let fork_s = fork.to_string_lossy().into_owned();

        run(&fork_s, &["init", "-q", "--bare"]).await;
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "local"]).await;
        run(&repo_s, &["remote", "add", "fork", &fork_s]).await;

        let state = AppState::default();
        for bad in ["a*b", "a?b", "a[b", "a:b", "a b"] {
            let err = git_push_core_unpinned(
                &state,
                repo_s.clone(),
                false,
                false,
                Some("local".into()),
                Some("fork".into()),
                Some(bad.into()),
            )
            .await
            .expect_err("refspec metacharacters are rejected");
            assert!(
                matches!(err, AppError::InvalidArgument(_)),
                "{bad:?} → {err:?}"
            );
        }
        // Nothing was pushed while validating.
        assert!(run(&fork_s, &["for-each-ref", "refs/heads/"])
            .await
            .trim()
            .is_empty());

        git_push_core_unpinned(
            &state,
            repo_s.clone(),
            false,
            false,
            Some("local".into()),
            Some("fork".into()),
            Some("contrib".into()),
        )
        .await
        .expect("push to the named destination succeeds");

        // The commit landed under the DESTINATION name, not the local one.
        assert_eq!(
            run(&fork_s, &["rev-parse", "refs/heads/contrib"]).await.trim(),
            run(&repo_s, &["rev-parse", "refs/heads/local"]).await.trim()
        );
        assert!(
            run_git(
                Some(&fork_s),
                &["rev-parse", "refs/heads/local"],
                TEST_GIT_HANG_GUARD
            )
            .await
            .is_err(),
            "the local name must not be published"
        );
        // And no `-u`: the local branch is still untracked.
        assert!(
            run_git(
                Some(&repo_s),
                &["rev-parse", "--abbrev-ref", "local@{upstream}"],
                TEST_GIT_HANG_GUARD
            )
            .await
            .is_err(),
            "a named destination must not set upstream"
        );
    }
}
