// The History panel's unpushed/editable view, gated on the log and status
// agreeing on HEAD. Free of runtime imports so scripts/editable-set.test.mjs
// loads it under Node's type stripping.

import type { UnpushedBasis } from "@/lib/git/api/status";

export type EditableCommit = { hash: string; isMerge: boolean };

/** Edit history's range cap: the top unpushed commits it offers at most. */
export const EDIT_MAX = 15;

/** True when the log's first (newest) commit is status's HEAD oid. False on
 *  either side missing — pending status, empty log, unborn repo — so a
 *  mismatch always fails toward the snapshot/zero arm. */
export function headAgrees(
  logHead: string | undefined,
  statusOid: string | null | undefined,
): boolean {
  return logHead !== undefined && statusOid != null && logHead === statusOid;
}

/** Whether the unpushed count comes from the separate count read rather than
 *  status's `ahead`: a branch with no upstream, or one whose upstream is
 *  gone. False while status is pending. */
export function isNoUpstream(
  head: { upstream: string | null; upstreamGone: boolean } | null | undefined,
): boolean {
  return head != null && (head.upstream === null || head.upstreamGone);
}

/** One observation of status's HEAD oid against the last one seen. Only
 *  non-null oids are stored (an unborn or pending read keeps the previous
 *  one), and the first observed oid seeds without counting as a change. */
export function observeHeadOid(
  prev: string | null,
  oid: string | null | undefined,
): { next: string | null; changed: boolean } {
  if (oid == null) return { next: prev, changed: false };
  return { next: oid, changed: prev !== null && oid !== prev };
}

export type UnpushedSnapshot<C> = {
  repo: string;
  /** Status branch name at agreement time (null when detached) — a branch
   *  change must fall to the 0 arm, never serve another branch's set. */
  branch: string | null;
  commits: C[];
  count: number;
  /** The no-upstream count read's basis and default branch (null in upstream
   *  mode), carried so a served count never pairs with a live read's basis. */
  basis: UnpushedBasis | null;
  defaultBranch: string | null;
  /** Carried so the edit range's whole-history decrement reads the page state
   *  the snapshot's commits were loaded under. */
  hasNextPage: boolean;
};

/** Whether a no-upstream count's basis still describes status's current branch
 *  (null when detached). The two default-branch bases depend on whether HEAD is
 *  the default branch by exact name, as the Rust side decides it, so a same-tip
 *  switch that moves no oid still invalidates them; every other basis, and a
 *  missing count, is branch-independent. */
export function countBasisAgrees(
  basis: UnpushedBasis | null | undefined,
  defaultBranch: string | null | undefined,
  statusBranch: string | null | undefined,
): boolean {
  if (basis === "on-default-branch") {
    return statusBranch != null && statusBranch === defaultBranch;
  }
  if (basis === "default-branch") return statusBranch !== defaultBranch;
  return true;
}

/** The agreement predicate the unpushed set and the squash / Edit history
 *  gates read: the log's head equals status's oid, and in no-upstream mode
 *  the count read is not errored, at least as fresh as the log, and taken on
 *  the branch status reports ({@link countBasisAgrees}); it carries no HEAD
 *  oid, so freshness and that branch axis are what tie it to the log. */
export function viewAgrees(args: {
  logHead: string | undefined;
  statusOid: string | null | undefined;
  noUpstream: boolean;
  countIsError: boolean;
  countAt: number;
  logAt: number;
  countBasis: UnpushedBasis | null | undefined;
  countDefault: string | null | undefined;
  statusBranch: string | null | undefined;
}): boolean {
  if (!headAgrees(args.logHead, args.statusOid)) return false;
  return (
    !args.noUpstream ||
    (!args.countIsError &&
      args.countAt >= args.logAt &&
      countBasisAgrees(args.countBasis, args.countDefault, args.statusBranch))
  );
}

export type StatusLogAction =
  | "refetch-log"
  | "refresh-side-keys"
  | "refresh-head-set"
  | "refresh-count";

/** How old a no-upstream count read may get against the status tick before the
 *  sync re-reads it: a push from a terminal changes what's on the remotes
 *  without moving HEAD, so nothing else would refresh it before a refocus. */
export const NO_UPSTREAM_COUNT_RECHECK_MS = 30_000;

/** Which invalidations the status/log sync fires for one observation:
 *  - 'refresh-side-keys': once per OBSERVED oid change, whichever side is
 *    stale — those families don't heal through the log refetch.
 *  - 'refresh-head-set': on the same trigger, the rest of the HEAD-dependent
 *    families; the caller re-reads only the ones {@link preMoveStale} passes.
 *  - 'refetch-log': a non-null oid (an unborn repo's settled-empty log must
 *    never refetch per poll), heads differ, the log has data, the LOG is the
 *    stale side and isn't already fetching — at most one call per status
 *    reading, so a log-first window can't loop.
 *  - 'refresh-count': heads agree in no-upstream mode and the count is
 *    errored, older than the log, {@link NO_UPSTREAM_COUNT_RECHECK_MS} older
 *    than the status reading, or older than a status reading whose branch its
 *    basis contradicts ({@link countBasisAgrees}; a status lagging a fresher
 *    count must not loop refetches); never while the count is fetching (a read
 *    slower than one poll must land) or beside 'refresh-side-keys' (which
 *    already covers it).
 *  Null when nothing fires. */
export function statusLogAction(args: {
  oid: string | null | undefined;
  oidChanged: boolean;
  logHead: string | undefined;
  logHasData: boolean;
  logIsFetching: boolean;
  logAt: number;
  statusAt: number;
  noUpstream: boolean;
  countIsError: boolean;
  countIsFetching: boolean;
  countAt: number;
  countBasis: UnpushedBasis | null | undefined;
  countDefault: string | null | undefined;
  statusBranch: string | null | undefined;
}): ReadonlySet<StatusLogAction> | null {
  const actions = new Set<StatusLogAction>();
  const heads = headAgrees(args.logHead, args.oid);
  if (args.oidChanged) {
    actions.add("refresh-side-keys");
    actions.add("refresh-head-set");
  }
  if (
    args.oid != null &&
    !heads &&
    args.logHasData &&
    args.logAt < args.statusAt &&
    !args.logIsFetching
  ) {
    actions.add("refetch-log");
  }
  if (
    heads &&
    args.noUpstream &&
    (args.countIsError ||
      args.countAt < args.logAt ||
      args.statusAt - args.countAt >= NO_UPSTREAM_COUNT_RECHECK_MS ||
      (!countBasisAgrees(
        args.countBasis,
        args.countDefault,
        args.statusBranch,
      ) &&
        args.countAt < args.statusAt)) &&
    !args.countIsFetching &&
    !args.oidChanged
  ) {
    actions.add("refresh-count");
  }
  return actions.size > 0 ? actions : null;
}

/** Whether one query of the HEAD-move set is re-read on an observed outside
 *  HEAD move: only when its data predates the last status reading where the old
 *  oid was still current. A query an in-app write's own invalidation already
 *  refreshed, or is refreshing, is skipped, so the sync rarely double-fetches
 *  after in-app writes. Accepted residuals, each healing on the next focus:
 *  - a read that refetched inside the last poll window before an outside move,
 *    or started before the move and is still running when it is seen (skipped
 *    as fetching), keeps pre-move data;
 *  - an outside move inside an in-app write's window reads as in-app;
 *  - an in-app move the poll sees before the write settles (slow commit hooks,
 *    a multi-commit pick, revert or rebasing pull) re-reads the set twice;
 *  - a read whose own refetch failed is re-read once, acting as a retry;
 *  - an unborn repo's first commit seeds the oid rather than changing it. */
export function preMoveStale(args: {
  fetchStatus: "fetching" | "paused" | "idle";
  dataUpdatedAt: number;
  prevStatusAt: number;
}): boolean {
  return args.fetchStatus === "idle" && args.dataUpdatedAt <= args.prevStatusAt;
}

/** The snapshot advances ONLY on an agreeing render: null until the first
 *  agreement, so a mismatched first render never seeds a skewed pair.
 *  Identity contract (what stops the caller's render-time setState): `prev`
 *  when !agreed, or when it matches `live` on repo, branch, `commits`
 *  identity, count, basis, defaultBranch and hasNextPage; otherwise the very
 *  `live` object. */
export function advanceSnapshot<C>(
  prev: UnpushedSnapshot<C> | null,
  live: UnpushedSnapshot<C>,
  agreed: boolean,
): UnpushedSnapshot<C> | null {
  if (!agreed) return prev;
  if (
    prev !== null &&
    prev.repo === live.repo &&
    prev.branch === live.branch &&
    prev.commits === live.commits &&
    prev.count === live.count &&
    prev.basis === live.basis &&
    prev.defaultBranch === live.defaultBranch &&
    prev.hasNextPage === live.hasNextPage
  ) {
    return prev;
  }
  return live;
}

/** The commits+count+hasNextPage the unpushed markers, squash and Edit
 *  history read: live when the view agrees; during a mismatch, the last
 *  agreeing snapshot only while the live log's head is still the snapshot's
 *  head (status moved first, or a no-upstream count read trails the log) in
 *  the same repo and status branch. Once the log has moved (commits added on
 *  top, a reset, rebase, checkout or rewrite), the live commits with count 0:
 *  nothing marked or editable, so an open Edit history can't replay a set
 *  that would drop commits the log already shows.
 *  Upstream mode caps a served snapshot whose head isn't status's oid at
 *  `max(0, liveAhead - 1)`: a `commit && push` inside one poll reports the
 *  new oid with ahead 0 over the old log, where the uncapped snapshot would
 *  mark pushed commits. No-upstream mode's count is a separate read: no cap.
 *  `basis` and `defaultBranch` come from the arm that supplied the count, so a
 *  served snapshot's count never pairs with the live read's basis. */
export function resolveUnpushedView<C extends { hash: string }>(args: {
  agreed: boolean;
  repo: string;
  branch: string | null;
  statusOid: string | null | undefined;
  liveAhead: number;
  noUpstream: boolean;
  commits: C[];
  count: number;
  basis: UnpushedBasis | null;
  defaultBranch: string | null;
  hasNextPage: boolean;
  snapshot: UnpushedSnapshot<C> | null;
}): {
  commits: C[];
  count: number;
  basis: UnpushedBasis | null;
  defaultBranch: string | null;
  hasNextPage: boolean;
} {
  if (args.agreed) {
    return {
      commits: args.commits,
      count: args.count,
      basis: args.basis,
      defaultBranch: args.defaultBranch,
      hasNextPage: args.hasNextPage,
    };
  }
  const snap = args.snapshot;
  const snapHead = snap?.commits[0]?.hash;
  if (
    snap !== null &&
    snapHead !== undefined &&
    snap.repo === args.repo &&
    snap.branch === args.branch &&
    args.commits[0]?.hash === snapHead
  ) {
    const count =
      !args.noUpstream && args.statusOid !== snapHead
        ? Math.min(snap.count, Math.max(0, args.liveAhead - 1))
        : snap.count;
    return {
      commits: snap.commits,
      count,
      basis: snap.basis ?? null,
      defaultBranch: snap.defaultBranch ?? null,
      hasNextPage: snap.hasNextPage,
    };
  }
  return {
    commits: args.commits,
    count: 0,
    basis: args.basis,
    defaultBranch: args.defaultBranch,
    hasNextPage: args.hasNextPage,
  };
}

/** How many of the top unpushed commits wear the row arrow. On the default
 *  branch of a repo with no configured remote and no remote-tracking refs
 *  nothing is published anywhere, so no row is marked, while squash and Edit
 *  history still read the full count. */
export function arrowCount(
  count: number,
  basis: UnpushedBasis | null | undefined,
): number {
  return basis === "on-default-branch" ? 0 : count;
}

/** The branch the arrow's tooltip says the commits are ahead of: the local
 *  default branch when the count was taken against it, else the upstream. */
export function arrowUpstream(
  upstream: string | null,
  basis: UnpushedBasis | null | undefined,
  defaultBranch: string | null | undefined,
): string | null {
  return basis === "default-branch" ? (defaultBranch ?? null) : upstream;
}

const NOT_ADJACENT_UNPUSHED = " (must be adjacent and unpushed)";

/** Squash's not-adjacent reason per count basis: counted against the local
 *  default branch, nothing need be pushed, so the limit it names is the fork. */
const NOT_ADJACENT_HINT: Record<
  UnpushedBasis,
  (defaultBranch: string | null) => string
> = {
  remotes: () => NOT_ADJACENT_UNPUSHED,
  "default-branch": (branch) =>
    branch === null
      ? NOT_ADJACENT_UNPUSHED
      : ` (must be adjacent and ahead of ${branch})`,
  "on-default-branch": () => NOT_ADJACENT_UNPUSHED,
  unresolved: () => NOT_ADJACENT_UNPUSHED,
};

/** The "not-adjacent-unpushed" hold's menu-row reason, from the same view's
 *  basis the gate's unpushed set came from (null basis = upstream mode). */
export function notAdjacentSquashHint(
  basis: UnpushedBasis | null | undefined,
  defaultBranch: string | null | undefined,
): string {
  return basis == null
    ? NOT_ADJACENT_UNPUSHED
    : NOT_ADJACENT_HINT[basis](defaultBranch ?? null);
}

/** Why squash is held, in display precedence order; null = available. */
export type SquashHold =
  | "op" // an operation is in progress (checked FIRST)
  | "filter-hides-range" // a client filter hides commits inside the range
  | "not-adjacent-unpushed" // non-contiguous, pushed, no base, or merge in range
  | "refreshing"; // the reads don't agree (viewAgrees is false)

/** Squash's gate: the selection must be >1, contiguous in real history (not
 *  the filtered view), entirely unpushed, merge-free above a loaded base, with
 *  the reads agreeing and no operation in progress. Returns a reason code, not
 *  copy, so this module stays free of runtime imports. */
export function squashGate(input: {
  /** Selected positions in HEAD-order real history, ascending (the panel's
   *  `selectedIndices`). */
  selectedIndices: readonly number[];
  /** The loaded log, HEAD-first (CommitSummary satisfies EditableCommit). */
  commits: readonly EditableCommit[];
  /** Hashes currently marked unpushed (the panel's `unpushedHashes`). */
  unpushed: ReadonlySet<string>;
  /** A client filter is active (the panel's `query` is non-empty). */
  filterActive: boolean;
  agreed: boolean;
  opInProgress: boolean;
}): { canSquash: boolean; hold: SquashHold | null } {
  const { selectedIndices, commits } = input;
  const squashMax = selectedIndices.at(-1) ?? -1;
  const contiguous =
    selectedIndices.length > 1 &&
    squashMax - (selectedIndices[0] ?? 0) + 1 === selectedIndices.length;
  const allowed =
    contiguous &&
    selectedIndices.every((i) => input.unpushed.has(commits[i].hash)) &&
    squashMax + 1 < commits.length &&
    // The replayed range (everything above the base) must be merge-free.
    commits.slice(0, squashMax + 1).every((c) => !c.isMerge);
  // Opening also waits for agreement: during a mismatch the view may still
  // serve the last agreeing set while HEAD has moved past it.
  const canSquash = allowed && input.agreed && !input.opInProgress;
  // Adjacency reads the live log either way; only the unpushed set is unknown
  // while the reads disagree.
  const hold = ((): SquashHold | null => {
    if (input.opInProgress) return "op";
    if (input.filterActive && !contiguous) return "filter-hides-range";
    if (!contiguous) return "not-adjacent-unpushed";
    if (!input.agreed) return "refreshing";
    if (allowed) return null;
    return "not-adjacent-unpushed";
  })();
  return { canSquash, hold };
}

/** Edit history's range: the top `count` commits, capped at EDIT_MAX and
 *  stopped at the first merge (merges can't be replayed), keeping the bottom
 *  commit of a fully loaded history as the base. `editBase` is the commit
 *  below the range (the top commit when the range is empty), or "" when that
 *  commit isn't loaded. */
export function deriveEditRange<C extends EditableCommit>(
  commits: C[],
  count: number,
  hasNextPage: boolean,
): { editLen: number; editCommits: C[]; editBase: string } {
  const firstMerge = commits.findIndex((c) => c.isMerge);
  let editLen = Math.min(
    count,
    EDIT_MAX,
    commits.length,
    firstMerge === -1 ? Number.POSITIVE_INFINITY : firstMerge,
  );
  if (editLen === commits.length && !hasNextPage) editLen -= 1;
  const editCommits = commits.slice(0, Math.max(editLen, 0));
  const editBase = commits[Math.max(editLen, 0)]?.hash ?? "";
  return { editLen: Math.max(editLen, 0), editCommits, editBase };
}
