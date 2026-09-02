use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify, OnceCell};

use crate::git::types::GitInfo;
use crate::git::worktree::normalize_wt_path;

/// The agent cancel registry: run id → the `Notify` the cancel command fires.
type AgentCancels = SyncMutex<HashMap<String, CancelEntry>>;

/// One registry entry. `tombstoned_at` is set ONLY while the entry is a tombstone — one
/// a cancel created ahead of any run — and is the seam both the adoption age-gate and
/// the sweep read; a live run's entry never carries it.
struct CancelEntry {
    notify: Arc<Notify>,
    tombstoned_at: Option<Instant>,
}

impl CancelEntry {
    /// A fresh handle for a live run, so it is never age-checked.
    fn live() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            tombstoned_at: None,
        }
    }

    /// A cancel that found no registered run: same handle, stamped so adoption and the
    /// sweep can tell an adoptable race from a leftover.
    fn tombstone() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            tombstoned_at: Some(Instant::now()),
        }
    }

    /// A tombstone past the adoption window — its permit belongs to a run that has
    /// already ended.
    fn is_stale_tombstone(&self) -> bool {
        self.tombstoned_at
            .is_some_and(|at| at.elapsed() > TOMBSTONE_ADOPTION_WINDOW)
    }
}

/// The label of whatever currently holds a domain's lock, readable WITHOUT holding
/// it — a waiter that times out reads this to name the operation it lost to. A
/// blocking mutex because every critical section is one `Option` read or write.
pub(crate) type HolderSlot = Arc<SyncMutex<Option<&'static str>>>;

/// One lock domain for one repo path: the mutex plus its holder label. Cloning
/// hands out the same two `Arc`s, so every caller shares one domain.
#[derive(Clone, Default)]
pub struct LockDomain {
    lock: Arc<Mutex<()>>,
    holder: HolderSlot,
}

impl LockDomain {
    pub(crate) fn lock(&self) -> Arc<Mutex<()>> {
        Arc::clone(&self.lock)
    }

    pub(crate) fn holder_slot(&self) -> HolderSlot {
        Arc::clone(&self.holder)
    }

    /// What holds this domain right now, or `None` when it is free (or held by an
    /// unlabeled acquisition).
    pub(crate) fn holder_label(&self) -> Option<&'static str> {
        *self.holder.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// The lock domains every checkout of one repository SHARES, keyed by the common
/// git dir. Separate mutexes from the working-tree domain (and from each other)
/// precisely so a multi-minute worktree removal can't stall staging or a commit.
#[derive(Clone, Default)]
struct SharedDomains {
    worktree_admin: LockDomain,
    network: LockDomain,
}

/// What one input spelling resolves to: the CHECKOUT it names, and the repository
/// that checkout belongs to. Two keys because the domains split that way — see
/// [`AppState::working_tree_lock`].
///
/// Both are folded through [`normalize_wt_path`], the same transform git::worktree
/// uses for cross-source path comparison: git prints forward slashes while the GUI
/// passes native separators (`validate_repo` normalizes to backslashes), and Windows
/// paths are case-insensitive, so one checkout is reachable under several spellings
/// that must land on one mutex. Its lower-casing can only MERGE two case-distinct
/// Unix paths onto one lock, which over-serializes — the safe direction.
#[derive(Clone)]
struct LockKeys {
    checkout: String,
    shared: String,
}

pub struct AppState {
    /// Input spelling → its resolved [`LockKeys`], so the two git probes run once per
    /// spelling instead of once per acquisition. Bounded by the paths a session
    /// touches, like the domain maps themselves.
    lock_keys: Mutex<HashMap<String, LockKeys>>,
    /// Working-tree domains keyed by checkout identity.
    checkout_domains: Mutex<HashMap<String, LockDomain>>,
    /// Worktree-admin and network domains keyed by shared repository identity.
    shared_domains: Mutex<HashMap<String, SharedDomains>>,
    pub git_info: OnceCell<GitInfo>,
    /// In-flight agent-CLI reviews and sessions keyed by a frontend-supplied id, so a
    /// separate cancel command can signal the streaming run to stop. A blocking mutex:
    /// every critical section is a map lookup, which lets the tombstone sweep run
    /// without an async accessor. The `Arc` lets that sweep task outlive the borrow of
    /// `self` that scheduled it.
    agent_cancels: Arc<AgentCancels>,
    /// Whether closing the window hides the app to the tray (keeping it running)
    /// instead of quitting. Mirrors the user's setting, pushed from the frontend;
    /// defaults to true so the first close behaves correctly before that sync.
    close_to_tray: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            lock_keys: Mutex::new(HashMap::new()),
            checkout_domains: Mutex::new(HashMap::new()),
            shared_domains: Mutex::new(HashMap::new()),
            git_info: OnceCell::new(),
            agent_cancels: Arc::new(SyncMutex::new(HashMap::new())),
            close_to_tray: AtomicBool::new(true),
        }
    }
}

impl AppState {
    /// The lock keys for `repo_path`, resolved through git once per spelling.
    ///
    /// Both probes run WITHOUT the cache lock held, so one repo's first touch never
    /// queues every other repo's behind a git spawn. Two callers racing a first touch
    /// both resolve and the first insert wins — the same value either way.
    ///
    /// Each resolver degrades to the raw spelling when git can't answer, and an
    /// UNRESOLVED pair is deliberately never cached: a transient failure (a timeout,
    /// an antivirus hold) would otherwise pin that spelling to raw-path keys for the
    /// process lifetime, permanently outside the domains of the repo it names.
    async fn resolve_lock_keys(&self, repo_path: &str) -> LockKeys {
        if let Some(keys) = self.lock_keys.lock().await.get(repo_path) {
            return keys.clone();
        }
        let toplevel = crate::git::runner::worktree_toplevel(repo_path).await;
        let identity = crate::git::repo::repo_identity(repo_path).await;
        // `repo_identity` answers with its input on failure, so equality with the
        // input is the fallback-detection seam. A caller passing the common git dir
        // ITSELF can read as unresolved (when the spellings match exactly) — a
        // re-probe per call at worst, never a wrong key.
        let resolved = toplevel.is_ok() && identity != repo_path;
        let keys = LockKeys {
            checkout: normalize_wt_path(toplevel.as_deref().unwrap_or(repo_path)),
            shared: normalize_wt_path(&identity),
        };
        if !resolved {
            return keys;
        }
        self.lock_keys
            .lock()
            .await
            .entry(repo_path.to_string())
            .or_insert(keys)
            .clone()
    }

    /// The two shared-identity domains for `repo_path`, created on first use.
    async fn shared(&self, repo_path: &str) -> SharedDomains {
        let key = self.resolve_lock_keys(repo_path).await.shared;
        self.shared_domains
            .lock()
            .await
            .entry(key)
            .or_default()
            .clone()
    }

    /// The **working-tree** domain: index, HEAD and ref mutations of the checkout
    /// at `repo_path` — the lock that keeps concurrent git invocations from
    /// fighting over `.git/index.lock`.
    ///
    /// Keyed by the CHECKOUT (`rev-parse --show-toplevel`), so any subdirectory or
    /// alternate spelling of one checkout shares its lock while each linked worktree
    /// keeps its own: the index and HEAD are per-checkout, and keying this domain by
    /// the common git dir would queue the user's staging behind an agent session's
    /// unbounded commit holds in a session worktree.
    ///
    /// Lock ordering across domains, which keeps the wait graph acyclic: a task may
    /// take NETWORK while holding WORKING-TREE (a pull is a transfer plus a merge)
    /// and never the reverse; the ADMIN domain nests with neither, and no task takes
    /// two locks of one domain.
    pub(crate) async fn working_tree_lock(&self, repo_path: &str) -> LockDomain {
        let key = self.resolve_lock_keys(repo_path).await.checkout;
        self.checkout_domains
            .lock()
            .await
            .entry(key)
            .or_default()
            .clone()
    }

    /// The **worktree-admin** domain: every `git worktree
    /// add/remove/prune/move/lock/unlock/repair` on the repo. Separate from the
    /// working tree because a removal holds it for minutes while staging and
    /// committing must keep working. Never nested with another domain (see
    /// [`working_tree_lock`](Self::working_tree_lock) for the ordering rule).
    ///
    /// Keyed by the SHARED identity (the common git dir): the `.git/worktrees`
    /// registry is one file tree for every checkout, so a command run from inside a
    /// linked worktree serializes with one run from the main checkout.
    pub(crate) async fn worktree_admin_lock(&self, repo_path: &str) -> LockDomain {
        self.shared(repo_path).await.worktree_admin
    }

    /// The **network** domain: fetch, push, set-head and pull transfers, serialized
    /// so a user pull's fetch can't race the background auto-fetch at the ref level.
    /// May be taken while holding the working-tree lock, never the reverse (see
    /// [`working_tree_lock`](Self::working_tree_lock)).
    ///
    /// Keyed by the SHARED identity: `refs/remotes/*` lives in the common git dir
    /// (FETCH_HEAD does not — it is per-worktree, measured via `--git-path`), so a
    /// worktree session's fetch and the main window's auto-fetch race on the same
    /// tracking refs — the very race this domain exists to prevent.
    pub(crate) async fn network_lock(&self, repo_path: &str) -> LockDomain {
        self.shared(repo_path).await.network
    }

    /// Register (or adopt) the cancellation handle for a run id and return it. The
    /// caller awaits `notified()` and must remove the entry when done (agent.rs does
    /// that with an RAII guard).
    ///
    /// A cancel that landed FIRST left a tombstone holding a `notify_one` permit: adopt
    /// it (clearing the stamp — it is a live entry from here) so the run this cancel was
    /// aimed at still stops. That race is sub-second, since registration is the
    /// command's first statement. A tombstone past `TOMBSTONE_ADOPTION_WINDOW` is
    /// REPLACED instead, permit discarded: it can only be a Stop aimed at a run that
    /// already ended, and session turns reuse one id, so adopting it would silently
    /// blank the next turn.
    pub fn register_agent_cancel(&self, id: &str) -> Arc<Notify> {
        let mut map = self
            .agent_cancels
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        match map.entry(id.to_string()) {
            Entry::Occupied(mut e) => {
                if e.get().is_stale_tombstone() {
                    let entry = CancelEntry::live();
                    let notify = Arc::clone(&entry.notify);
                    e.insert(entry);
                    notify
                } else {
                    e.get_mut().tombstoned_at = None;
                    Arc::clone(&e.get().notify)
                }
            }
            Entry::Vacant(e) => Arc::clone(&e.insert(CancelEntry::live()).notify),
        }
    }

    /// Remove `id` from the registry (idempotent — safe on every exit path).
    pub fn clear_agent_cancel(&self, id: &str) {
        self.agent_cancels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
    }

    /// Signal an in-flight run to cancel — firing the registered handle when present,
    /// else leaving a tombstone for a registration racing just behind it (only within
    /// `TOMBSTONE_ADOPTION_WINDOW`). `notify_one` stores a permit, so a cancel is never
    /// lost whether it arrives mid-run or a moment ahead of the command's registration.
    ///
    /// A tombstone this call CREATES may never be adopted (the run already finished, or
    /// never started), which would grow the map unbounded — so in that case only,
    /// schedule `sweep_unadopted_tombstone` to reclaim it.
    pub fn cancel_agent(&self, id: &str) {
        let mut map = self
            .agent_cancels
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let (notify, created) = match map.entry(id.to_string()) {
            // A live run already registered here → fire its handle (do NOT sweep: the
            // command's RAII guard removes the entry when it returns).
            Entry::Occupied(e) => (Arc::clone(&e.get().notify), false),
            // Absent → leave a tombstone for a registration racing just behind (or for
            // the sweep below to reclaim if none arrives).
            Entry::Vacant(e) => (Arc::clone(&e.insert(CancelEntry::tombstone()).notify), true),
        };
        drop(map);
        notify.notify_one();
        if created {
            let registry = Arc::clone(&self.agent_cancels);
            let id = id.to_string();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(TOMBSTONE_SWEEP_DELAY).await;
                sweep_unadopted_tombstone(&registry, &id);
            });
        }
    }

    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    pub fn set_close_to_tray(&self, enabled: bool) {
        self.close_to_tray.store(enabled, Ordering::Relaxed);
    }
}

/// How long a cancel-created tombstone stays adoptable. The race it exists for is
/// sub-second — registration is the run command's first statement — while a Stop
/// clicked between two turns of one session (same id, still-enabled button) lands with
/// no run registered too, and its permit must never reach the next turn.
const TOMBSTONE_ADOPTION_WINDOW: Duration = Duration::from_secs(5);

/// A tombstone that outlived adoptability has no reason to live, so sweep and window
/// are the same age by construction.
const TOMBSTONE_SWEEP_DELAY: Duration = TOMBSTONE_ADOPTION_WINDOW;

/// Remove `id` ONLY IF it's still an unadopted tombstone: the stamp is still set (a run
/// that adopted it cleared the stamp) and the map holds the sole `Arc` — a live run
/// holds a clone via its RAII guard and removes the entry itself.
fn sweep_unadopted_tombstone(registry: &AgentCancels, id: &str) {
    let mut map = registry.lock().unwrap_or_else(|p| p.into_inner());
    if map
        .get(id)
        .is_some_and(|e| e.tombstoned_at.is_some() && Arc::strong_count(&e.notify) == 1)
    {
        map.remove(id);
    }
}

#[cfg(test)]
mod lock_key_tests {
    use super::*;
    use crate::git::runner::{run_git, DEFAULT_TIMEOUT};

    async fn git(repo: &str, args: &[&str]) {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap_or_else(|e| panic!("git {args:?} in {repo} failed: {e:?}"));
    }

    fn temp_dir(marker: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(&format!("gd-lockkey-{marker}-"))
            .tempdir()
            .expect("create temp dir")
    }

    /// The spelling a fixture hands to git. Canonicalized off Windows because macOS
    /// puts temp dirs under `/var/folders/…`, a symlink to `/private/var/…`: the
    /// shared-key assertions would otherwise rest on git's two probes agreeing about
    /// that symlink. Windows keeps the plain path — canonicalizing there yields a
    /// `\\?\` verbatim spelling, which is not what the app passes.
    fn fixture_path(dir: &std::path::Path) -> String {
        #[cfg(not(windows))]
        let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        dir.to_string_lossy().into_owned()
    }

    /// Turns an existing directory into a repo with one commit.
    async fn init_repo(repo: &str) {
        git(repo, &["init"]).await;
        git(repo, &["config", "user.email", "t@t"]).await;
        git(repo, &["config", "user.name", "t"]).await;
        std::fs::write(std::path::Path::new(repo).join("a.txt"), "v0\n").unwrap();
        git(repo, &["add", "."]).await;
        git(repo, &["commit", "-m", "base"]).await;
    }

    /// A real repo with one commit, under its own temp dir (which must outlive the
    /// test — dropping it removes the repo).
    async fn setup_repo(marker: &str) -> (tempfile::TempDir, String) {
        let dir = temp_dir(marker);
        let repo = fixture_path(dir.path());
        init_repo(&repo).await;
        (dir, repo)
    }

    /// Domain identity is the mutex itself: two lookups share a domain exactly when
    /// they handed back the same `Arc`.
    fn same(a: &LockDomain, b: &LockDomain) -> bool {
        Arc::ptr_eq(&a.lock, &b.lock)
    }

    /// All three domains of one spelling, in (working-tree, admin, network) order.
    async fn domains_of(state: &AppState, path: &str) -> (LockDomain, LockDomain, LockDomain) {
        (
            state.working_tree_lock(path).await,
            state.worktree_admin_lock(path).await,
            state.network_lock(path).await,
        )
    }

    /// A path inside the checkout names the same checkout and the same repo, so all
    /// three domains must be the root spelling's. The MCP server takes `--repo`
    /// verbatim, so a subdirectory reaches these accessors.
    #[tokio::test]
    async fn a_subdirectory_spelling_shares_every_domain_with_the_root() {
        let (_dir, repo) = setup_repo("subdir").await;
        let sub = std::path::Path::new(&repo).join("sub");
        std::fs::create_dir(&sub).unwrap();
        let sub = sub.to_string_lossy().into_owned();

        let state = AppState::default();
        let root = domains_of(&state, &repo).await;
        let inner = domains_of(&state, &sub).await;
        assert!(
            same(&root.0, &inner.0),
            "a subdirectory is the same checkout"
        );
        assert!(same(&root.1, &inner.1), "and the same worktree registry");
        assert!(same(&root.2, &inner.2), "and the same remote refs");
    }

    /// The differentiated keying, in one test: a linked worktree has its OWN index
    /// and HEAD (so its own working-tree lock, which is what keeps a session's
    /// unbounded holds off the user's staging) but shares the `.git/worktrees`
    /// registry and `refs/remotes/*` with the main checkout.
    #[tokio::test]
    async fn a_linked_worktree_keeps_its_own_working_tree_domain_but_shares_the_repo() {
        let (_dir, repo) = setup_repo("worktree").await;
        let holder = temp_dir("linked");
        // `git worktree add` requires the path NOT to exist yet, so the HOLDER is what
        // gets canonicalized.
        let linked = std::path::Path::new(&fixture_path(holder.path())).join("wt");
        let linked = linked.to_string_lossy().into_owned();
        git(&repo, &["worktree", "add", "-b", "gd-lockkey-wt", &linked]).await;

        let state = AppState::default();
        let main = domains_of(&state, &repo).await;
        let wt = domains_of(&state, &linked).await;
        assert!(
            !same(&main.0, &wt.0),
            "each checkout owns its index/HEAD lock"
        );
        assert!(
            same(&main.1, &wt.1),
            "the .git/worktrees registry is shared, so admin ops serialize"
        );
        assert!(
            same(&main.2, &wt.2),
            "refs/remotes is shared, so fetches serialize"
        );
    }

    /// The control: unrelated repos must serialize nothing against each other.
    #[tokio::test]
    async fn two_repos_share_no_domain() {
        let (_a_dir, a) = setup_repo("distinct-a").await;
        let (_b_dir, b) = setup_repo("distinct-b").await;

        let state = AppState::default();
        let da = domains_of(&state, &a).await;
        let db = domains_of(&state, &b).await;
        assert!(!same(&da.0, &db.0));
        assert!(!same(&da.1, &db.1));
        assert!(!same(&da.2, &db.2));
    }

    /// A path git can't resolve falls back to its own spelling, which is what keeps
    /// the fake-path callers (the runner's lock tests) meaningful: one path is still
    /// one mutex, and two are still two.
    #[tokio::test]
    async fn a_non_repo_path_falls_back_to_its_own_spelling() {
        let state = AppState::default();
        let fake = domains_of(&state, "C:/repos/gd-lockkey-absent").await;
        let again = domains_of(&state, "C:/repos/gd-lockkey-absent").await;
        let other = domains_of(&state, "C:/repos/gd-lockkey-absent-other").await;

        assert!(
            same(&fake.0, &again.0) && same(&fake.1, &again.1) && same(&fake.2, &again.2),
            "the same unresolvable path must find the same mutexes"
        );
        assert!(
            !same(&fake.0, &other.0) && !same(&fake.1, &other.1) && !same(&fake.2, &other.2),
            "two unresolvable paths must stay independent"
        );
    }

    /// A resolution that failed must not be remembered: the same spelling has to
    /// rejoin the real domains once git can answer for it, or one transient probe
    /// failure exiles it for the process lifetime. A path that does not exist yet is
    /// the deterministic failure — git can't even be spawned there.
    #[tokio::test]
    async fn a_failed_resolution_is_never_cached() {
        let holder = temp_dir("late");
        let repo_dir = std::path::Path::new(&fixture_path(holder.path())).join("repo");
        let repo = repo_dir.to_string_lossy().into_owned();

        let state = AppState::default();
        let absent = domains_of(&state, &repo).await;

        std::fs::create_dir(&repo_dir).unwrap();
        init_repo(&repo).await;
        let present = domains_of(&state, &repo).await;
        let sub = repo_dir.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let via_sub = domains_of(&state, &sub.to_string_lossy()).await;

        assert!(
            !same(&absent.1, &present.1),
            "the failed probe must not have been cached — the shared key is the repo's \
             common git dir, never its work-tree path"
        );
        assert!(same(&present.0, &via_sub.0), "working tree");
        assert!(same(&present.1, &via_sub.1), "worktree admin");
        assert!(same(&present.2, &via_sub.2), "network");
    }

    /// Windows reaches one checkout under several spellings — git's forward slashes,
    /// the GUI's backslashes, and any casing — and the filesystem treats them as one
    /// path, so the locks must too.
    #[cfg(windows)]
    #[tokio::test]
    async fn case_and_slash_variants_share_every_domain() {
        let (_dir, repo) = setup_repo("spelling").await;
        let state = AppState::default();
        let base = domains_of(&state, &repo).await;

        for variant in [repo.replace('\\', "/"), repo.to_uppercase()] {
            let got = domains_of(&state, &variant).await;
            assert!(same(&base.0, &got.0), "working tree: {variant}");
            assert!(same(&base.1, &got.1), "worktree admin: {variant}");
            assert!(same(&base.2, &got.2), "network: {variant}");
        }
    }
}

#[cfg(test)]
mod agent_cancel_tests {
    use super::*;

    /// The cancel-before-register race: the frontend can fire a cancel before the
    /// command has reached its registration (fast Esc, or a teardown right after
    /// start). The permit must survive for the later registration to adopt.
    #[tokio::test]
    async fn cancel_before_register_delivers_permit() {
        let state = AppState::default();
        let id = "cancel-before-register-0001";
        state.cancel_agent(id);
        let notify = state.register_agent_cancel(id);
        // A zero-duration timeout still resolves ⇒ the permit was waiting.
        let got = tokio::time::timeout(Duration::ZERO, notify.notified()).await;
        assert!(
            got.is_ok(),
            "the cancel permit must be waiting for the later-registering run"
        );
        state.clear_agent_cancel(id);
    }

    /// The counter-case: a Stop clicked in the gap between two turns of one session
    /// (turn N's guard already dropped, turn N+1 not yet started — the same cancel id
    /// throughout) must NOT carry into the next turn, which would complete it blank.
    #[tokio::test]
    async fn stale_tombstone_is_not_adopted() {
        let state = AppState::default();
        let id = "stale-tombstone-0005";
        state.cancel_agent(id);
        {
            let mut map = state
                .agent_cancels
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let entry = map.get_mut(id).expect("the cancel left a tombstone");
            entry.tombstoned_at = Some(
                Instant::now()
                    .checked_sub(2 * TOMBSTONE_ADOPTION_WINDOW)
                    .expect("the monotonic clock must be older than two windows"),
            );
        }

        let notify = state.register_agent_cancel(id);
        let got = tokio::time::timeout(Duration::ZERO, notify.notified()).await;
        assert!(
            got.is_err(),
            "a stale tombstone's permit must not cancel the next run under that id"
        );
        state.clear_agent_cancel(id);
    }

    /// The ordinary order, but with the cancel landing before the run polls: a stored
    /// permit means it is still delivered on the first poll.
    #[tokio::test]
    async fn cancel_after_register_before_poll_delivers_permit() {
        let state = AppState::default();
        let id = "register-then-cancel-0002";
        let notify = state.register_agent_cancel(id);
        state.cancel_agent(id);
        let got = tokio::time::timeout(Duration::ZERO, notify.notified()).await;
        assert!(got.is_ok(), "a post-register cancel must still deliver");
        state.clear_agent_cancel(id);
    }

    #[tokio::test]
    async fn sweep_reclaims_only_unadopted_tombstones() {
        let state = AppState::default();
        let unadopted = "tombstone-unadopted-0003";
        let adopted = "tombstone-adopted-0004";
        state.cancel_agent(unadopted);
        state.cancel_agent(adopted);
        // A run that registers later adopts the tombstone, CLEARING its stamp — the
        // stamp short-circuit is what saves it from the sweep; the strong-count arm
        // guards the separate transient-clone race, not this path.
        let _held = state.register_agent_cancel(adopted);

        sweep_unadopted_tombstone(&state.agent_cancels, unadopted);
        sweep_unadopted_tombstone(&state.agent_cancels, adopted);

        let map = state
            .agent_cancels
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        assert!(
            !map.contains_key(unadopted),
            "an unadopted tombstone must be reclaimed"
        );
        assert!(
            map.contains_key(adopted),
            "an adopted entry belongs to its run's guard, not the sweep"
        );
    }
}
