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

/** One observation of a polled value against the last one seen. Only non-null
 *  values are stored (a pending or failed read keeps the previous one; `""` is
 *  a value), and the first value seeds without counting as a change. */
export function observeSeeded(
  prev: string | null,
  value: string | null | undefined,
): { next: string | null; changed: boolean } {
  if (value == null) return { next: prev, changed: false };
  return { next: value, changed: prev !== null && value !== prev };
}

/** {@link observeSeeded} over status's HEAD oid: an unborn or pending read
 *  keeps the previous oid. */
export function observeHeadOid(
  prev: string | null,
  oid: string | null | undefined,
): { next: string | null; changed: boolean } {
  return observeSeeded(prev, oid);
}

const SIG_FIELD_SEP = String.fromCharCode(0);
const SIG_NULL = String.fromCharCode(1);

function codeUnitOrder(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function fnv1a32(text: string, offset: number): string {
  let h = offset >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A short signature of status's entries (path, staged, unstaged; never the
 *  branch or oid, which `refresh-side-keys` already follows), so the sync can
 *  re-read op state when a stop or abort from a terminal moves no HEAD.
 *  `<entry count>:<64-bit hash>` over the triples sorted by path in code-unit
 *  order; null while status is pending. Unseen by design (no op-state poll;
 *  each heals on refocus, a tab show or a menu open): any `--quit` (index and
 *  tree kept, so no entry changes), a stop that changes no entry and moves no
 *  HEAD (a pick stopped on a commit that became empty), and a stop plus its
 *  abort inside one 5 s status poll (which needs no heal). */
export function statusContentSignature(
  entries:
    | readonly {
        path: string;
        staged: string | null;
        unstaged: string | null;
      }[]
    | undefined,
): string | null {
  if (entries === undefined) return null;
  const rows = entries.map((e) =>
    [e.path, e.staged ?? SIG_NULL, e.unstaged ?? SIG_NULL].join(SIG_FIELD_SEP),
  );
  rows.sort(codeUnitOrder);
  const text = rows.join(SIG_FIELD_SEP + SIG_FIELD_SEP);
  return `${entries.length}:${fnv1a32(text, 0x811c9dc5)}${fnv1a32(text, 0x01c9dc58)}`;
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
 *  the count read was taken on that same HEAD (`countHead`, the oid it
 *  counted from), is not errored (retained data carries an old success's
 *  head), and was taken on the branch status reports ({@link countBasisAgrees}:
 *  a same-tip switch moves no oid). Read order between the count and the log
 *  never matters. */
export function viewAgrees(args: {
  logHead: string | undefined;
  statusOid: string | null | undefined;
  noUpstream: boolean;
  countIsError: boolean;
  countHead: string | null | undefined;
  countBasis: UnpushedBasis | null | undefined;
  countDefault: string | null | undefined;
  statusBranch: string | null | undefined;
}): boolean {
  if (!headAgrees(args.logHead, args.statusOid)) return false;
  return (
    !args.noUpstream ||
    (!args.countIsError &&
      args.countHead === args.statusOid &&
      countBasisAgrees(args.countBasis, args.countDefault, args.statusBranch))
  );
}

export type StatusLogAction =
  | "refetch-log"
  | "refresh-side-keys"
  | "refresh-head-set"
  | "refresh-ref-set"
  | "refresh-op-state"
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
 *  - 'refresh-ref-set': the refs stamp moved; the caller re-reads only the
 *    ref-derived reads {@link preMoveStale} passes.
 *  - 'refresh-op-state': status's entries changed with the oid held (a stop or
 *    abort from a terminal moves no HEAD); an oid change already covers it.
 *  - 'refetch-log': a non-null oid (an unborn repo's settled-empty log must
 *    never refetch per poll), heads differ, the log has data, the LOG is the
 *    stale side (its last success AND last failure both predate the status
 *    reading) and isn't already fetching: at most one call per status reading
 *    whatever else runs the sync, so a log-first window can't loop.
 *  - 'refresh-count': heads agree in no-upstream mode, the count's last success
 *    and last failure both predate the status reading (a count that read a
 *    newer HEAD than a lagging status must not re-fire itself), and the count is
 *    errored, taken on another head, {@link NO_UPSTREAM_COUNT_RECHECK_MS} older
 *    than the status reading, or on a basis the status branch contradicts
 *    ({@link countBasisAgrees}); never while the count is fetching (a read
 *    slower than one poll must land), nor beside 'refresh-side-keys' or
 *    'refresh-ref-set'. The one accepted slip: any count refreshed since the
 *    previous stamp reading is skipped by the ref set's {@link preMoveStale} and
 *    suppressed for 'refresh-count' in the same run; it heals on the next
 *    status reading.
 *  Null when nothing fires. */
export function statusLogAction(args: {
  oid: string | null | undefined;
  oidChanged: boolean;
  refsChanged: boolean;
  contentChanged: boolean;
  logHead: string | undefined;
  logHasData: boolean;
  logIsFetching: boolean;
  logAt: number;
  logErrorAt: number;
  statusAt: number;
  noUpstream: boolean;
  countIsError: boolean;
  countIsFetching: boolean;
  countAt: number;
  countErrorAt: number;
  countHead: string | null | undefined;
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
  if (args.refsChanged) actions.add("refresh-ref-set");
  if (args.contentChanged && !args.oidChanged) {
    actions.add("refresh-op-state");
  }
  if (
    args.oid != null &&
    !heads &&
    args.logHasData &&
    args.logAt < args.statusAt &&
    args.logErrorAt < args.statusAt &&
    !args.logIsFetching
  ) {
    actions.add("refetch-log");
  }
  if (
    heads &&
    args.noUpstream &&
    Math.max(args.countAt, args.countErrorAt) < args.statusAt &&
    (args.countIsError ||
      args.countHead !== args.oid ||
      args.statusAt - args.countAt >= NO_UPSTREAM_COUNT_RECHECK_MS ||
      !countBasisAgrees(
        args.countBasis,
        args.countDefault,
        args.statusBranch,
      )) &&
    !args.countIsFetching &&
    !args.oidChanged &&
    !args.refsChanged
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
 *  head (status moved first, or the no-upstream count read is errored, names
 *  another head, or rests on a basis the status branch contradicts) in
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

/** Why Edit history is held, in display precedence order; null = available. */
export type EditHistoryHold =
  | "op" // an operation is in progress (checked FIRST)
  | "refreshing" // the reads don't agree (viewAgrees is false)
  | "nothing-unpushed" // the count basis leaves nothing to edit
  | "merge-on-top" // the newest commit is a merge
  | "shallow-boundary" // the lone commit's parent isn't in the clone
  | "lone-commit"; // the lone commit has no older commit to rebase onto

/** Edit history's gate over deriveEditRange's result, as a reason code (not
 *  copy, so this module stays free of runtime imports). The editLen-0 causes
 *  follow deriveEditRange's own arithmetic: no count, a merge at the top, or
 *  the bottom-commit decrement leaving nothing above the base. Takes the
 *  head-is-merge primitive rather than the commits array, so the panel's call
 *  never receives the array its CommitList cache order guards. */
export function editHistoryHold(input: {
  /** deriveEditRange's editLen over the same view. */
  editLen: number;
  /** The view's unpushed count. */
  count: number;
  /** The view's newest commit is a merge. */
  headIsMerge: boolean;
  /** The panel measured the lone commit's parent as missing (shallow clone). */
  shallowBoundary: boolean;
  agreed: boolean;
  opInProgress: boolean;
}): EditHistoryHold | null {
  if (input.opInProgress) return "op";
  if (!input.agreed) return "refreshing";
  if (input.editLen >= 1) return null;
  if (input.count === 0) return "nothing-unpushed";
  if (input.headIsMerge) return "merge-on-top";
  if (input.shallowBoundary) return "shallow-boundary";
  return "lone-commit";
}

/** Why Undo is held over what's published; null = nothing published blocks it. */
export type UndoPushedHold =
  | "refreshing" // the count is unread, or the reads don't agree
  | "unpushed-unchecked" // the count read failed (even after an earlier success)
  | "already-pushed"; // HEAD's commit is on the upstream or a remote branch

/** Undo's published-commit gate. An upstream branch reads `ahead`. A
 *  no-upstream branch reads the LIVE count read, never a served snapshot
 *  (whose basis can predate it): only the "remotes" basis can say HEAD's
 *  commit is published, so the other bases offer Undo without waiting for
 *  agreement. */
export function undoPushedHold(args: {
  noUpstream: boolean;
  ahead: number;
  countLoaded: boolean;
  countFailed: boolean;
  basis: UnpushedBasis | null;
  count: number;
  agreed: boolean;
}): UndoPushedHold | null {
  if (!args.noUpstream) return args.ahead > 0 ? null : "already-pushed";
  if (args.countFailed) return "unpushed-unchecked";
  if (!args.countLoaded) return "refreshing";
  if (args.basis !== "remotes") return null;
  if (!args.agreed) return "refreshing";
  return args.count > 0 ? null : "already-pushed";
}
