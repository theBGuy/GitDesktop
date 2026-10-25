/**
 * The import-free pieces of the branch-push bookkeeping: the key every push is
 * filed under, the variables it carries, how a pending push reads back out of
 * the mutation cache, the label a branch row's spinner shows for it, the reasons
 * a push puts on the other controls it holds, the HEAD-push latch, the one
 * delayed run-list recheck (plus any PR checks reads its arms hand it) armed on a
 * successful push-like write or on the observed head move, and the delayed
 * PR-list re-read a remote-branch delete schedules.
 *
 * Import-free at runtime on purpose (types only, erased): sync.ts imports this
 * file, and `scripts/push-writes.test.mjs` loads it straight from `src/` under
 * Node's type stripping. A runtime import added here fails that test.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { PendingMutationEntry } from "./pr-writes";

/** Filter prefix for every branch push ({@link branchPushKey}). */
export const BRANCH_PUSH_KEY = ["branch-push"] as const;

/** A branch push's mutation key; the branch rides the variables. */
export const branchPushKey = (repo: string) =>
  [...BRANCH_PUSH_KEY, repo] as const;

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
}

/** One push in flight. `branch` null is a HEAD push (no branch in the vars),
 *  which a reader resolves to a row by its `mutationId`. */
export interface BranchPushState {
  mutationId: number | null;
  branch: string | null;
  remote: string | null;
  remoteBranch: string | null;
  setUpstream: boolean;
  paused: boolean;
  fromHeader: boolean;
}

/** The refusal for two kinds of route started while a push is in flight: one
 *  that would queue behind it on the repo's network lock for up to a minute
 *  (another push, a fetch, pull, merge, in-place update or remote delete), and a
 *  rename, delete, rebase or update of the branch being pushed, which would move
 *  or remove the ref it is sending. */
export const BRANCH_PUSH_ACTIVE_MESSAGE =
  "A push is already running — wait for it to finish.";

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
 *  order. Every field is `typeof`-guarded: the cache holds `Mutation<any>`, so the
 *  variables are read through PushVars' own keys (a renamed field fails to
 *  compile here) but never trusted. Non-object variables are no push this hook
 *  sent, and are dropped. An array, not a branch-keyed record, so a branch named
 *  like an `Object.prototype` member can't read as present. */
export function pendingBranchPushesFor(
  entries: readonly PendingMutationEntry[],
  repo: string,
): BranchPushState[] {
  const out: BranchPushState[] = [];
  for (const e of entries) {
    const [prefix, keyRepo] = e.key ?? [];
    if (prefix !== BRANCH_PUSH_KEY[0] || keyRepo !== repo) continue;
    if (typeof e.vars !== "object" || e.vars === null) continue;
    const { setUpstream, branch, remote, remoteBranch, source } =
      e.vars as Partial<Record<keyof PushVars, unknown>>;
    out.push({
      mutationId: typeof e.mutationId === "number" ? e.mutationId : null,
      branch: typeof branch === "string" ? branch : null,
      remote: typeof remote === "string" ? remote : null,
      remoteBranch: typeof remoteBranch === "string" ? remoteBranch : null,
      setUpstream: setUpstream === true,
      paused: e.paused === true,
      fromHeader: source === "header",
    });
  }
  return out;
}

/** A label names a destination only when the push itself fixes one: a push that
 *  names no remote or branch goes wherever git's push routing sends it, which a
 *  row can't know. */
export const branchPublishLabel = (remote: string | null): string =>
  remote === null ? "Publishing branch" : `Publishing to ${remote}`;

/** The row spinner's label, arms in precedence order: a cross-name push names
 *  its exact destination, a push that sets or (re)creates tracking publishes, a
 *  named push of a tracked branch targets its upstream, and a HEAD push (a bare
 *  `git push`) names none. */
export function branchPushLabel(
  push: BranchPushState,
  row: { upstream: string | null; upstreamGone: boolean },
): string {
  if (push.remote !== null && push.remoteBranch !== null)
    return `Pushing to ${push.remote}/${push.remoteBranch}`;
  if (push.setUpstream || row.upstream === null || row.upstreamGone)
    return branchPublishLabel(push.remote);
  if (push.branch === null) return "Pushing";
  return `Pushing to ${row.upstream}`;
}

/** The HEAD-push latch after a render's reads: `pending` is this repo's pushes,
 *  `pendingIds` every repo's. A branch-less push still pending somewhere latches
 *  to `currentName` once, and an id pending in no repo is pruned (a switch away
 *  keeps it, so a switch back still finds it). Null when nothing changes, so a
 *  render-time adjust settles. */
export function nextPushLatch(
  latch: Readonly<Record<number, string>>,
  pending: readonly BranchPushState[],
  pendingIds: readonly number[],
  currentName: string | null,
): Record<number, string> | null {
  const added: [number, string][] = [];
  if (currentName !== null) {
    for (const p of pending) {
      if (
        p.branch === null &&
        p.mutationId !== null &&
        pendingIds.includes(p.mutationId) &&
        !Object.hasOwn(latch, p.mutationId)
      )
        added.push([p.mutationId, currentName]);
    }
  }
  const kept = Object.entries(latch).filter(([id]) =>
    pendingIds.includes(Number(id)),
  );
  if (added.length === 0 && kept.length === Object.keys(latch).length)
    return null;
  return { ...Object.fromEntries(kept), ...Object.fromEntries(added) };
}

/** How long after a push-like write its runs are read once more: the forge
 *  creates a push's runs a few seconds after it lands, after any settle-time
 *  read. */
export const PUSH_RUN_RECHECK_MS = 8_000;

/** A read a push-like write owes the same delayed re-read as the run lists (a PR's
 *  checks rollup, the list's CI badges). Built by the caller, since this file spells
 *  no PR keys. `exact` matches `queryKey` alone; `numberedChild` matches only keys
 *  one segment longer whose last segment is a number (every PR's details in a lens,
 *  for an arm that can't name its PR); neither = prefix match. */
export interface RecheckFilter {
  queryKey: readonly unknown[];
  exact?: boolean;
  numberedChild?: boolean;
}

/** The one pending recheck per repo: a later arm re-arms its timer and adds its
 *  filters to the ones already owed (deduplicated by value), so repeat writes never
 *  stack timers and the one fire covers every coalesced arm. */
const pendingRunRechecks = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; owed: Map<string, RecheckFilter> }
>();

const filterId = (f: RecheckFilter) =>
  JSON.stringify([f.queryKey, f.exact === true, f.numberedChild === true]);

/** One delayed re-read of the write's own repo's run lists plus `extra`; only the
 *  observers active then refetch. A paged list past its first page is skipped: no
 *  automatic refetch replays deep pages (actions.ts `useWorkflowRunPages`), so it
 *  keeps its last full read until something invalidates it (most arms' whole-repo
 *  settle, or the panel's Refresh). */
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
      for (const f of owed.values())
        void queryClient.invalidateQueries(
          f.numberedChild
            ? {
                queryKey: f.queryKey,
                predicate: (query) =>
                  query.queryKey.length === f.queryKey.length + 1 &&
                  typeof query.queryKey[f.queryKey.length] === "number",
              }
            : { queryKey: f.queryKey, exact: f.exact === true },
        );
    }, PUSH_RUN_RECHECK_MS),
  });
}

/** How long after a remote-branch delete the PR list is read once more: GitHub
 *  closes a PR whose head branch is deleted asynchronously, so the settle's own
 *  read can still show it open. */
export const REMOTE_DELETE_PR_RECHECK_MS = 8_000;

/** The one pending PR-list re-read per repo: a later delete re-arms it. */
const pendingPrListRechecks = new Map<string, ReturnType<typeof setTimeout>>();

/** One delayed invalidation of exactly `keys` (the caller builds them: this file
 *  can't import repoKeys, and the PR-list families may be spelled only in core.ts).
 *  The caller owes the review-state map with the PR list (usePrReviewState's
 *  co-invalidation contract); the CI and mergeability maps key on a digest of the
 *  list's rows and re-key on their own. */
export function recheckPrListAfterRemoteDelete(
  queryClient: QueryClient,
  repo: string,
  keys: readonly (readonly unknown[])[],
): void {
  clearTimeout(pendingPrListRechecks.get(repo));
  pendingPrListRechecks.set(
    repo,
    setTimeout(() => {
      pendingPrListRechecks.delete(repo);
      for (const queryKey of keys)
        void queryClient.invalidateQueries({ queryKey });
    }, REMOTE_DELETE_PR_RECHECK_MS),
  );
}
