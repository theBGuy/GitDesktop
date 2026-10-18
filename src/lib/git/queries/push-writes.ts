/**
 * The pure pieces of the branch-push bookkeeping: the key every push is filed
 * under, the variables it carries, how a pending push reads back out of the
 * mutation cache, the label a branch row's spinner shows for it, the reasons a
 * push puts on the other controls it holds, and the HEAD-push latch.
 *
 * Import-free at runtime on purpose (types only, erased): sync.ts imports this
 * file, and `scripts/push-writes.test.mjs` loads it straight from `src/` under
 * Node's type stripping. A runtime import added here fails that test.
 */
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
