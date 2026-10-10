// The sync bar's labels, holds, and hotkey gates as a pure function of what the
// reads know. Import-free: scripts/sync-controls-state.test.mjs loads it under
// Node's type stripping, which resolves no bundler aliases.

/** The sync buttons' hold while any fetch, pull, push or recovery runs — none of
 *  them is necessarily the pressed button's own write. */
export const SYNC_BUSY_REASON = "A sync is still running…";

/** The caret's hold when its menu would be empty: no tracking upstream to pull
 *  from and no fork `upstream` remote to update from. */
export const PULL_OPTIONS_UNPUBLISHED_REASON =
  "Publish the branch first to pull it";

/** A status read that failed with nothing loaded. Shared with the branch picker's
 *  trigger and popover, so both surfaces name the same failure the same way. */
export const STATUS_READ_FAILED_REASON = "Couldn't read the repository status";

/** A remotes read still in flight with nothing loaded. Shared with the forge
 *  tabs' not-ready panel, so one read has one wording. */
export const REMOTES_PENDING_REASON = "Checking remotes…";

/** Which read a held action is waiting on. Remotes outrank status: they decide
 *  whether this cluster is the right control at all. */
type UnknownRead = "remotesFailed" | "remotes" | "statusFailed" | "status";

const UNKNOWN_READ_REASON: Record<UnknownRead, string> = {
  remotesFailed: "Couldn't read the remotes",
  remotes: REMOTES_PENDING_REASON,
  statusFailed: STATUS_READ_FAILED_REASON,
  status: "Checking branch…",
};

/** The fields of `RepoStatus.branch` the sync bar reads. */
export interface SyncHead {
  name: string | null;
  detached: boolean;
  /** HEAD's commit; null on a branch with no commits yet. */
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
}

export interface SyncControlsInput {
  /** `status.data?.branch`: undefined while the status read has no data for
   *  THIS repo. Never a previous repo's placeholder — that would act on its
   *  branch. */
  head: SyncHead | undefined;
  /** `status.data === undefined && status.errorUpdateCount > 0`; only consulted
   *  while `head` is undefined. Never `isError`: a never-loaded query that
   *  errored goes back to pending on every refetch, flipping the reason per poll. */
  statusError: boolean;
  /** `remotes.data`: undefined while the remotes read has no data. */
  remotes: readonly string[] | undefined;
  /** `remotes.data === undefined && remotes.errorUpdateCount > 0` (sticky across
   *  refetches, as `statusError`); only consulted while `remotes` is undefined. */
  remotesError: boolean;
  busy: boolean;
  /** The offline hold's reason, undefined while online. */
  offlineHold: string | undefined;
  /** The rewrite probe's measured verdicts (all false/0 until it resolves). */
  remoteRebased: boolean;
  mixedRewrite: boolean;
  localAtRisk: number;
}

export interface Hold {
  disabled: boolean;
  /** Read by DisabledReasonButton only while `disabled`. */
  reason: string | undefined;
}

/** The branch facts the rewrite probe needs before the full derivation runs. A
 *  gone upstream (remote branch deleted, config lingers) reads as no upstream; a
 *  diverged branch has commits on both sides; a detached HEAD has no branch. */
export function headFacts(head: SyncHead | undefined): {
  hasUpstream: boolean;
  diverged: boolean;
  detached: boolean;
} {
  return {
    hasUpstream: Boolean(head?.upstream) && !head?.upstreamGone,
    diverged: Boolean(head && head.ahead > 0 && head.behind > 0),
    detached: Boolean(head?.detached),
  };
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

export function deriveSyncControls(input: SyncControlsInput) {
  const { head, remotes, busy, offlineHold } = input;
  const statusKnown = head !== undefined;
  const remotesKnown = remotes !== undefined;
  const statusFailed = !statusKnown && input.statusError;
  const noOrigin = remotesKnown && !remotes.includes("origin");
  const hasOrigin = remotesKnown && remotes.includes("origin");
  // A fork carries an `upstream` remote pointing at the source repo.
  const hasUpstreamRemote = remotesKnown && remotes.includes("upstream");
  const { hasUpstream, diverged, detached } = headFacts(head);
  // Merging upstream INTO a detached HEAD would orphan the merge commit.
  const canUpdateUpstream = hasUpstreamRemote && !detached;
  // Strict: a head without an `oid` field reads as born, never as unborn.
  const unborn = statusKnown && !head.detached && head.oid === null;

  const aheadCount = head?.ahead ?? 0;
  const behindCount = head?.behind ?? 0;
  const upstream = head?.upstream;
  // "Publish branch" sends `-u origin`, so it is offered only for a branch the
  // status has MEASURED as untracked — never for one still loading.
  const pushLabel = (() => {
    if (diverged) return "Force push";
    if (statusKnown && !hasUpstream) return "Publish branch";
    return "Push";
  })();

  // One description per button feeds both its tooltip and its accessible name;
  // each starts with the visible label (WCAG 2.5.3) and, while disabled,
  // carries the reason and the count. Undefined = the bare label suffices.
  const aheadLabel =
    aheadCount > 0
      ? `${pushLabel} — ${aheadCount} commit${plural(aheadCount)} to push to ${upstream}`
      : undefined;
  const behindLabel =
    behindCount > 0
      ? `Pull — ${behindCount} commit${plural(behindCount)} to pull from ${upstream}`
      : undefined;
  // An upstream that already HOLDS these commits under other ids makes the
  // standing "rebase or merge" advice duplicate them.
  const divergedPullDescription = (() => {
    if (input.remoteRebased)
      return `Pull — ${upstream} already has your commits under different ids; use "Reset to ${upstream}" from the Pull menu`;
    // A merge here re-imports the twinned changes beside the copies already
    // upstream, so the menu's merge item is disabled and the advice narrows.
    if (input.mixedRewrite)
      return `Pull — ${upstream} already has some of your commits under different ids and you have ${input.localAtRisk} it doesn't; use Pull with rebase from the menu`;
    return `Pull — branch has diverged (${behindCount} commit${plural(behindCount)} behind ${upstream}); use Pull with rebase or merge from the menu`;
  })();
  const pullDescription = (() => {
    if (!statusKnown) return undefined;
    if (diverged) return divergedPullDescription;
    if (detached)
      return "Pull — you're on a detached HEAD; check out a branch to pull";
    // An empty clone's upstream ref never existed, so nothing was deleted.
    if (unborn && head.upstreamGone)
      return `Pull — ${upstream} doesn't exist on the remote yet`;
    // Configured-but-dead (deleted on the remote, e.g. after a merge) is not
    // never-published; say so.
    if (head.upstreamGone)
      return `Pull — upstream ${upstream} was deleted on the remote (likely merged); use Publish branch to recreate it`;
    if (!hasUpstream)
      return "Pull — no upstream branch to pull from yet; publish the branch first";
    return behindLabel;
  })();
  const pushDescription = (() => {
    if (detached)
      return `${pushLabel} — you're on a detached HEAD; check out a branch to push`;
    if (unborn)
      return `${pushLabel} — ${head.name} has no commits yet; make your first commit to publish it`;
    if (input.remoteRebased)
      return `${pushLabel} — ${upstream} already has your commits under different ids; force pushing would replace them with your copies`;
    return aheadLabel;
  })();

  // Fetch reads only the remotes; the other three also act on the branch.
  const unknownRead = (needsStatus: boolean): string | undefined => {
    let read: UnknownRead | undefined;
    if (!remotesKnown) read = input.remotesError ? "remotesFailed" : "remotes";
    else if (needsStatus && statusFailed) read = "statusFailed";
    else if (needsStatus && !statusKnown) read = "status";
    return read && UNKNOWN_READ_REASON[read];
  };
  // Every hold carries a reason so no flip between them drops focus to a native
  // disable. Precedence: a running sync, offline, an unknown read, then the
  // state's own description.
  const hold = (
    pending: string | undefined,
    blocked: boolean,
    description: string | undefined,
  ): Hold => ({
    disabled: busy || !!offlineHold || pending !== undefined || blocked,
    reason: busy ? SYNC_BUSY_REASON : (offlineHold ?? pending ?? description),
  });
  const fetchHold = hold(unknownRead(false), false, undefined);
  const pull = hold(
    unknownRead(true),
    !hasUpstream || diverged,
    pullDescription,
  );
  const push = hold(unknownRead(true), detached || unborn, pushDescription);
  // The caret stays live offline: its items carry their own offline holds.
  const pullOptions = ((): Hold => {
    const pending = unknownRead(true);
    const empty = !hasUpstream && !canUpdateUpstream;
    const disabled = busy || pending !== undefined || empty;
    if (busy) return { disabled, reason: SYNC_BUSY_REASON };
    if (pending !== undefined) return { disabled, reason: pending };
    if (detached) return { disabled, reason: pullDescription };
    return {
      disabled,
      reason: empty ? PULL_OPTIONS_UNPUBLISHED_REASON : undefined,
    };
  })();

  return {
    statusKnown,
    remotesKnown,
    statusFailed,
    noOrigin,
    hasOrigin,
    hasUpstreamRemote,
    hasUpstream,
    diverged,
    detached,
    canUpdateUpstream,
    aheadCount,
    behindCount,
    pushLabel,
    pullDescription,
    pushDescription,
    /** Accessible names: the description, else the bare visible label — never
     *  the button's CONTENT, whose text label is hidden below `md`. */
    pullName: pullDescription ?? "Pull",
    pushName: pushDescription ?? pushLabel,
    fetch: fetchHold,
    pull,
    pullOptions,
    push,
    // Hotkeys mirror the buttons' holds. Pull needs no `!detached` term: the
    // backend leaves a detached HEAD's upstream null, so `hasUpstream` is false.
    hotkeys: {
      fetch: hasOrigin && !busy && !offlineHold,
      pull:
        statusKnown &&
        hasOrigin &&
        !busy &&
        hasUpstream &&
        !diverged &&
        !offlineHold,
      push:
        statusKnown &&
        hasOrigin &&
        !busy &&
        !detached &&
        !unborn &&
        !offlineHold,
      updateFromUpstream:
        statusKnown && canUpdateUpstream && !busy && !offlineHold,
    },
  };
}
