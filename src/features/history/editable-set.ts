// The History panel's unpushed/editable view, gated on the log and status
// agreeing on HEAD. Free of runtime imports so scripts/editable-set.test.mjs
// loads it under Node's type stripping.

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
  /** Carried so the edit range's whole-history decrement reads the page state
   *  the snapshot's commits were loaded under. */
  hasNextPage: boolean;
};

/** The agreement predicate the unpushed set and the squash / Edit history
 *  gates read: the log's head equals status's oid, and in no-upstream mode
 *  the count read is not errored and at least as fresh as the log (it
 *  carries no HEAD, so freshness is its only axis). */
export function viewAgrees(args: {
  logHead: string | undefined;
  statusOid: string | null | undefined;
  noUpstream: boolean;
  countIsError: boolean;
  countAt: number;
  logAt: number;
}): boolean {
  if (!headAgrees(args.logHead, args.statusOid)) return false;
  return !args.noUpstream || (!args.countIsError && args.countAt >= args.logAt);
}

export type StatusLogAction =
  | "refetch-log"
  | "refresh-side-keys"
  | "refresh-count";

/** Which invalidations the status/log sync fires for one observation:
 *  - 'refresh-side-keys': once per OBSERVED oid change, whichever side is
 *    stale — those families don't heal through the log refetch.
 *  - 'refetch-log': a non-null oid (an unborn repo's settled-empty log must
 *    never refetch per poll), heads differ, the log has data, the LOG is the
 *    stale side and isn't already fetching — at most one call per status
 *    reading, so a log-first window can't loop.
 *  - 'refresh-count': heads agree in no-upstream mode and the count is
 *    errored or older than the log; never while the count is fetching (a read
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
}): ReadonlySet<StatusLogAction> | null {
  const actions = new Set<StatusLogAction>();
  const heads = headAgrees(args.logHead, args.oid);
  if (args.oidChanged) actions.add("refresh-side-keys");
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
    (args.countIsError || args.countAt < args.logAt) &&
    !args.countIsFetching &&
    !args.oidChanged
  ) {
    actions.add("refresh-count");
  }
  return actions.size > 0 ? actions : null;
}

/** The snapshot advances ONLY on an agreeing render: null until the first
 *  agreement, so a mismatched first render never seeds a skewed pair.
 *  Identity contract (what stops the caller's render-time setState): `prev`
 *  when !agreed, or when it matches `live` on repo, branch, `commits`
 *  identity, count and hasNextPage; otherwise the very `live` object. */
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
 *  mark pushed commits. No-upstream mode's count is a separate read: no cap. */
export function resolveUnpushedView<C extends { hash: string }>(args: {
  agreed: boolean;
  repo: string;
  branch: string | null;
  statusOid: string | null | undefined;
  liveAhead: number;
  noUpstream: boolean;
  commits: C[];
  count: number;
  hasNextPage: boolean;
  snapshot: UnpushedSnapshot<C> | null;
}): { commits: C[]; count: number; hasNextPage: boolean } {
  if (args.agreed) {
    return {
      commits: args.commits,
      count: args.count,
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
    return { commits: snap.commits, count, hasNextPage: snap.hasNextPage };
  }
  return { commits: args.commits, count: 0, hasNextPage: args.hasNextPage };
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
