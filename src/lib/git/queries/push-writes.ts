/**
 * The import-free pieces of the branch-push bookkeeping: the key every push is
 * filed under, the variables it carries, how a pending push reads back out of
 * the mutation cache, the label a branch row's spinner shows for it, the reasons
 * a push puts on the other controls it holds, the HEAD-push latch, the one
 * delayed run-list recheck (plus any PR checks reads its arms hand it) armed by a
 * successful write whose own default trigger starts CI for the code it touches
 * (the boundary at {@link PUSH_RUN_RECHECK_MS}), or by the observed head move, and
 * the delayed list re-read a remote-branch delete or a PR/issue state change
 * schedules.
 *
 * Import-free at runtime on purpose (types only, erased): sync.ts imports this
 * file, and `scripts/push-writes.test.mjs` loads it straight from `src/` under
 * Node's type stripping. A runtime import added here fails that test.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { PendingMutationEntry } from "./pr-writes";

/** Filter prefix for every branch push ({@link branchPushKey}). */
export const BRANCH_PUSH_KEY = ["branch-push"] as const;

/** A branch push's mutation key; the branch rides the variables. The path stays
 *  element 1, so a path-prefix read still finds its own pushes only, and the
 *  repository identity (when resolved) is element 2, where a sibling worktree's
 *  fire-time check matches it. */
export const branchPushKey = (repo: string, identity?: string) =>
  identity === undefined
    ? ([...BRANCH_PUSH_KEY, repo] as const)
    : ([...BRANCH_PUSH_KEY, repo, identity] as const);

/** The variables every push mutation carries (usePush's args type). */
export interface PushVars {
  setUpstream: boolean;
  force?: boolean;
  /** Absent = HEAD (the header's plain push). */
  branch?: string;
  remote?: string;
  /** Destination branch name when it differs from the local one (pushing to a
   *  fork PR's head); requires `branch` and `remote`, and never tracks. */
  remoteBranch?: string;
  /** Client-only provenance: "header" = started by SyncControls, which holds its
   *  bar only on its own pushes. usePush's mutationFn never forwards it. */
  source?: "header";
  /** Client-only: for a HEAD push (no `branch`), the branch the app last saw
   *  checked out when the push started, which keeps that branch held after a
   *  checkout. Null or absent on a detached HEAD. usePush's mutationFn never
   *  forwards it. */
  startedOn?: string | null;
  /** Forwarded: the branch HEAD must still be on (`"HEAD"` = detached); the
   *  backend refuses before every spawn when it moved. Absent = not pinned. */
  expectedBranch?: string;
  /** Forwarded: the commit id HEAD must still be at (a force push's confirmed
   *  tip); needs `expectedBranch`. */
  expectedHead?: string;
  /** Forwarded: the starter's pre-push check found the branch absent on the
   *  remote, so this push creates it there (the row reads "Publishing") and the
   *  backend refuses it if the destination appeared at another commit. */
  creates?: boolean;
}

/** A remote rename's variables (useRenameBranchOnRemote's args type). Filed
 *  under {@link branchPushKey} while it runs: it pushes the new name and deletes
 *  the old one, so the family's holds cover it. */
export interface RemoteRenameVars {
  oldName: string;
  newName: string;
  remote: string;
  expectedOldTip: string | null;
}

/** The sync bar's publish check in flight for one repository: the branch it was
 *  pressed on and, once the row read named it, the remote it checks. */
export interface HeaderDetection {
  token: object;
  branch: string;
  remote: string | null;
}

/** Module store, so an entry outlives the SyncControls mount that wrote it and
 *  the branch switcher can paint and hold that branch's row from it. */
const headerDetections = new Map<string, HeaderDetection>();
const headerDetectionListeners = new Set<() => void>();
const notifyHeaderDetections = () => {
  for (const l of headerDetectionListeners) l();
};

/** Starts `repo`'s header check (replacing any older one) and returns the token
 *  its later writes must present. */
export function beginHeaderDetection(repo: string, branch: string): object {
  const token = {};
  headerDetections.set(repo, { token, branch, remote: null });
  notifyHeaderDetections();
  return token;
}

const entryOfToken = (token: object): [string, HeaderDetection] | undefined =>
  [...headerDetections].find(([, d]) => d.token === token);

/** Compare-and-set: a late read from an older press never writes a newer entry. */
export function setHeaderDetectionRemote(token: object, remote: string): void {
  const found = entryOfToken(token);
  if (found === undefined) return;
  headerDetections.set(found[0], { ...found[1], remote });
  notifyHeaderDetections();
}

/** Compare-and-clear: an older press's settle never clears a newer entry. */
export function endHeaderDetection(token: object): void {
  const found = entryOfToken(token);
  if (found === undefined) return;
  headerDetections.delete(found[0]);
  notifyHeaderDetections();
}

export const headerDetectionFor = (repo: string): HeaderDetection | null =>
  headerDetections.get(repo) ?? null;

export function subscribeHeaderDetections(listener: () => void): () => void {
  headerDetectionListeners.add(listener);
  return () => {
    headerDetectionListeners.delete(listener);
  };
}

/** One push in flight. `branch` null is a HEAD push (no branch in the vars):
 *  `startedOn` names the branch it started on when the caller recorded one, and
 *  otherwise a reader resolves it to a row by its `mutationId`. */
export interface BranchPushState {
  mutationId: number | null;
  branch: string | null;
  startedOn: string | null;
  remote: string | null;
  remoteBranch: string | null;
  setUpstream: boolean;
  paused: boolean;
  fromHeader: boolean;
  /** Filed by another checkout of the same repository (matched by identity). */
  foreign: boolean;
  /** The starter recorded that this push creates the branch on the remote. */
  creates: boolean;
  /** A remote rename, read back as two states (its old name and its new one),
   *  since the row carries the old name until the local rename lands. */
  renaming: boolean;
}

/** The refusal for two kinds of route started while a push is in flight: one
 *  that would queue behind it on the repo's network lock for up to a minute
 *  (another push, a fetch, pull, merge, in-place update or remote delete), and
 *  one that moves or removes the ref the push is sending (a rename, delete,
 *  archive, reset, rebase or update of that branch, or a history edit of it such
 *  as undo, reset to commit or amend). */
export const BRANCH_PUSH_ACTIVE_MESSAGE =
  "A push is already running — wait for it to finish.";

/** The ref-moving refusal when only another worktree's push holds the branch:
 *  this checkout shows no push of its own to wait for. */
export const BRANCH_PUSH_ELSEWHERE_MESSAGE =
  "Another worktree is pushing this branch. Wait for that push to finish.";

/** Why a control that isn't the push is held by one. A push parked offline is
 *  waiting for the connection; the held control itself sends nothing, so the
 *  generic parked-write copy ("this sends…") would misdescribe it. */
export const branchPushHoldReason = (paused: boolean): string =>
  paused ? "A push is waiting for the connection." : "A push is running.";

/** The menu-label twin of {@link branchPushHoldReason}, for the parenthetical a
 *  disabled item carries. */
export const branchPushHoldItemReason = (paused: boolean): string =>
  paused ? "a push is waiting for the connection" : "a push is running";

/** The pushes among `entries` filed against `repo`, one per invocation in cache
 *  order, plus (when `identity` is given) those another checkout filed under the
 *  same identity, marked `foreign`; an absent identity never matches an absent
 *  one. Every field is `typeof`-guarded: the cache holds `Mutation<any>`, so the
 *  variables are read through PushVars' own keys (a renamed field fails to
 *  compile here) but never trusted. Non-object variables are no push this hook
 *  sent, and are dropped. An array, not a branch-keyed record, so a branch named
 *  like an `Object.prototype` member can't read as present. A remote rename
 *  (string `oldName`, `newName` and `remote`) reads back as two states that push
 *  `newName` to its remote, one per name, so one mutation id can appear twice. */
export function pendingBranchPushesFor(
  entries: readonly PendingMutationEntry[],
  repo: string,
  identity?: string,
): BranchPushState[] {
  const out: BranchPushState[] = [];
  for (const e of entries) {
    const [prefix, keyRepo, keyIdentity] = e.key ?? [];
    if (prefix !== BRANCH_PUSH_KEY[0]) continue;
    const foreign = keyRepo !== repo;
    if (foreign && (identity === undefined || keyIdentity !== identity))
      continue;
    if (typeof e.vars !== "object" || e.vars === null) continue;
    const mutationId = typeof e.mutationId === "number" ? e.mutationId : null;
    const paused = e.paused === true;
    const {
      oldName,
      newName,
      remote: renameRemote,
    } = e.vars as Partial<Record<keyof RemoteRenameVars, unknown>>;
    if (
      typeof oldName === "string" &&
      typeof newName === "string" &&
      typeof renameRemote === "string"
    ) {
      for (const name of [oldName, newName])
        out.push({
          mutationId,
          branch: name,
          startedOn: null,
          remote: renameRemote,
          remoteBranch: newName,
          setUpstream: true,
          paused,
          fromHeader: false,
          foreign,
          creates: false,
          renaming: true,
        });
      continue;
    }
    const {
      setUpstream,
      branch,
      remote,
      remoteBranch,
      source,
      startedOn,
      creates,
    } = e.vars as Partial<Record<keyof PushVars, unknown>>;
    out.push({
      mutationId,
      branch: typeof branch === "string" ? branch : null,
      startedOn: typeof startedOn === "string" ? startedOn : null,
      remote: typeof remote === "string" ? remote : null,
      remoteBranch: typeof remoteBranch === "string" ? remoteBranch : null,
      setUpstream: setUpstream === true,
      paused,
      fromHeader: source === "header",
      foreign,
      creates: creates === true,
      renaming: false,
    });
  }
  return out;
}

/** Whether one of `pushes` is sending `branch`. A HEAD push names no branch
 *  (`branch` null) and counts as both the branch it recorded starting on
 *  (`startedOn`) and the current branch, or ANY branch while the current name is
 *  unknown, failing toward refusal: the hold costs one toast, a miss moves the ref
 *  mid-send. The current branch holds because the backend resolves HEAD itself,
 *  after the app's last status read, so a checkout outside the app can move it
 *  first; the push's `expectedBranch` pin then refuses rather than send another
 *  branch, but only once git runs. A `foreign` HEAD push (another worktree's)
 *  holds only its recorded start: `currentName` describes THIS checkout's HEAD.
 *  Limit: two checkouts during one push waiting on that lock (A to B to C) leave
 *  the branch git sends (B) unheld. */
export function pushesBranch(
  pushes: readonly {
    branch: string | null;
    startedOn?: string | null;
    foreign?: boolean;
  }[],
  branch: string,
  currentName: string | null,
): boolean {
  return pushes.some((p) => {
    if (p.branch !== null) return p.branch === branch;
    if ((p.startedOn ?? null) === branch) return true;
    if (p.foreign === true) return false;
    return currentName === null || currentName === branch;
  });
}

/** A label names a destination only when the push itself fixes one: a push that
 *  names no remote or branch goes wherever git's push routing sends it, which a
 *  row can't know. */
export const branchPublishLabel = (remote: string | null): string =>
  remote === null ? "Publishing branch" : `Publishing to ${remote}`;

/** The row spinner's label while the pre-push check runs, before it has decided
 *  whether the push creates the branch; null = the check named no remote. */
export const branchPreparingLabel = (remote: string | null): string =>
  remote === null ? "Preparing to push" : `Preparing to push to ${remote}`;

/** The row spinner's label, arms in precedence order: a remote rename names its
 *  remote, a cross-name push names its exact destination, only a push its
 *  starter recorded as creating the branch publishes, a HEAD push (a bare
 *  `git push`) names none, a push to the row's resolved destination (`target`,
 *  from the backend's routing) names it, a push that keeps a live upstream
 *  targets it, and otherwise the push's own remote. */
export function branchPushLabel(
  push: BranchPushState,
  row: { upstream: string | null; upstreamGone: boolean },
  target: { remote: string; branch: string } | null,
): string {
  if (push.renaming && push.remote !== null)
    return `Renaming on ${push.remote}`;
  if (push.remote !== null && push.remoteBranch !== null)
    return `Pushing to ${push.remote}/${push.remoteBranch}`;
  if (push.creates) return branchPublishLabel(push.remote);
  if (push.branch === null) return "Pushing";
  if (
    !push.setUpstream &&
    target !== null &&
    (push.remote === null || push.remote === target.remote)
  )
    return `Pushing to ${target.remote}/${target.branch}`;
  if (row.upstream !== null && !row.upstreamGone && !push.setUpstream)
    return `Pushing to ${row.upstream}`;
  if (push.remote !== null) return `Pushing to ${push.remote}`;
  return "Pushing";
}

/** The HEAD-push latch after a render's reads: `pending` is this repo's pushes,
 *  `pendingIds` every repo's. A branch-less push still pending somewhere latches
 *  once, to the branch it recorded starting on or else to `currentName`, and an
 *  id pending in no repo is pruned (a switch away keeps it, so a switch back
 *  still finds it). Null when nothing changes, so a render-time adjust settles. */
export function nextPushLatch(
  latch: Readonly<Record<number, string>>,
  pending: readonly BranchPushState[],
  pendingIds: readonly number[],
  currentName: string | null,
): Record<number, string> | null {
  const added: [number, string][] = [];
  for (const p of pending) {
    const on = p.startedOn ?? currentName;
    if (
      on !== null &&
      p.branch === null &&
      p.mutationId !== null &&
      pendingIds.includes(p.mutationId) &&
      !Object.hasOwn(latch, p.mutationId)
    )
      added.push([p.mutationId, on]);
  }
  const kept = Object.entries(latch).filter(([id]) =>
    pendingIds.includes(Number(id)),
  );
  if (added.length === 0 && kept.length === Object.keys(latch).length)
    return null;
  return { ...Object.fromEntries(kept), ...Object.fromEntries(added) };
}

/** How long after an armed write the runs are read once more: the forge can
 *  surface the run, or flip its status, after the settle-time read. Armed writes
 *  are those whose own default trigger starts CI for the code they touch: pushing
 *  commits or tags; renaming a branch on its remote; opening or reopening a pull
 *  request, landing it on the origin lens, or updating its branch; publishing or
 *  deleting a release; publishing a repository; creating a linked branch on the
 *  origin lens; dispatching a workflow; and re-running, playing or approving a
 *  run. Out of scope: non-default activity types (ready-for-review) and other
 *  events (labels, comments, reviews, Pages builds). Deletion pushes and cancel
 *  are reasoned exclusions. */
export const PUSH_RUN_RECHECK_MS = 8_000;

/** A read such a write owes the same delayed re-read as the run lists (a PR's
 *  checks rollup, the list's CI badges). Built by the caller: this import-free file
 *  can't import repoKeys, and the pr-ci family may be spelled only in core.ts.
 *  `exact` matches `queryKey` alone; `numberedChild` matches only keys one segment
 *  longer whose last segment is a number (every PR's details in a lens, for an arm
 *  that can't name its PR); neither = prefix match. */
export interface RecheckFilter {
  queryKey: readonly unknown[];
  exact?: boolean;
  numberedChild?: boolean;
}

/** The one pending recheck per repo: a later arm re-arms its timer and adds its
 *  filters to the ones already owed (deduplicated by value), so repeat writes never
 *  stack timers and the one fire covers every coalesced arm. The fire drops the
 *  entry, so the next arm owes only its own filters. */
const pendingRunRechecks = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; owed: Map<string, RecheckFilter> }
>();

const filterId = (f: RecheckFilter) =>
  JSON.stringify([f.queryKey, f.exact === true, f.numberedChild === true]);

/** Whether `key` starts with `prefix`, segment by segment. Filter keys hold only
 *  primitives, so a serialized compare is exact. */
const startsWithKey = (key: readonly unknown[], prefix: readonly unknown[]) =>
  key.length >= prefix.length &&
  prefix.every((s, i) => JSON.stringify(key[i]) === JSON.stringify(s));

/** {@link RecheckFilter}'s three match modes, applied to one query key. */
export function recheckFilterMatches(
  f: RecheckFilter,
  key: readonly unknown[],
): boolean {
  if (!startsWithKey(key, f.queryKey)) return false;
  if (f.numberedChild)
    return (
      key.length === f.queryKey.length + 1 &&
      typeof key[f.queryKey.length] === "number"
    );
  return f.exact !== true || key.length === f.queryKey.length;
}

/** One delayed re-read of the write's own repo's run lists plus `extra`; only the
 *  observers active then refetch. A paged list past its first page is skipped: no
 *  automatic refetch replays deep pages (actions.ts `useWorkflowRunPages`), so it
 *  keeps its last full read until something invalidates it (most arms' whole-repo
 *  settle, or the panel's Refresh). The owed filters fire as ONE invalidation over
 *  their union: two overlapping filters as two calls would invalidate a query twice
 *  in one tick, and the second call's refetch cancels the first's. */
export function recheckRunsAfterPush(
  queryClient: QueryClient,
  repo: string,
  extra: readonly RecheckFilter[] = [],
): void {
  const pending = pendingRunRechecks.get(repo);
  clearTimeout(pending?.timer);
  const owed = pending?.owed ?? new Map<string, RecheckFilter>();
  for (const f of extra) owed.set(filterId(f), f);
  pendingRunRechecks.set(repo, {
    owed,
    timer: setTimeout(() => {
      pendingRunRechecks.delete(repo);
      for (const kind of ["notify", "latest", "runs"])
        void queryClient.invalidateQueries({
          queryKey: ["repo", repo, "actions", kind],
        });
      void queryClient.invalidateQueries({
        queryKey: ["repo", repo, "actions", "runs-paged"],
        predicate: (query) =>
          ((query.state.data as { pages?: unknown[] } | undefined)?.pages
            ?.length ?? 0) <= 1,
      });
      const filters = [...owed.values()];
      if (filters.length > 0)
        void queryClient.invalidateQueries({
          predicate: (query) =>
            filters.some((f) => recheckFilterMatches(f, query.queryKey)),
        });
    }, PUSH_RUN_RECHECK_MS),
  });
}

/** How long after an armed write the PR or issue lists are read once more: the
 *  forge updates list membership asynchronously (GitHub closes a PR whose head
 *  branch is deleted later; a search-backed list lags a merge, close or reopen),
 *  so the settle's own read can still file the row under its old state. */
export const LIST_RECHECK_MS = 8_000;

/** The one pending list re-read per repo: a later arm re-arms its timer and adds
 *  its keys to the ones already owed (deduplicated by value); the fire drops the
 *  entry, so the next arm owes only its own keys. */
const pendingListRechecks = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>;
    owed: Map<string, readonly unknown[]>;
  }
>();

/** One delayed invalidation of every key prefix owed since the last fire. Armed by
 *  a remote-branch delete (unlensed PR-list prefixes) and by a PR merge, close or
 *  reopen and an issue close or reopen (lens-scoped list prefixes); a PR merge
 *  also hands the lens's issue list and issue detail prefixes. The caller
 *  builds the keys: this file can't import repoKeys, and the list families may be
 *  spelled only in core.ts. A PR-list caller owes the review-state map with the
 *  list (usePrReviewState's co-invalidation contract); the CI and mergeability
 *  maps key on a digest of the list's rows and re-key on their own. The owed keys
 *  fire as ONE invalidation, for the reason {@link recheckRunsAfterPush} gives. */
export function recheckListsLater(
  queryClient: QueryClient,
  repo: string,
  keys: readonly (readonly unknown[])[],
): void {
  const pending = pendingListRechecks.get(repo);
  clearTimeout(pending?.timer);
  const owed = pending?.owed ?? new Map<string, readonly unknown[]>();
  for (const key of keys) owed.set(JSON.stringify(key), key);
  pendingListRechecks.set(repo, {
    owed,
    timer: setTimeout(() => {
      pendingListRechecks.delete(repo);
      const prefixes = [...owed.values()];
      void queryClient.invalidateQueries({
        predicate: (query) =>
          prefixes.some((prefix) => startsWithKey(query.queryKey, prefix)),
      });
    }, LIST_RECHECK_MS),
  });
}
