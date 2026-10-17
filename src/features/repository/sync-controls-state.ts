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

/** A status read still in flight with nothing loaded. Shared with the branch
 *  picker's trigger, so one read has one wording. */
export const STATUS_PENDING_REASON = "Checking branch…";

/** A remotes read still in flight with nothing loaded. Shared with the forge
 *  tabs' not-ready panel, so one read has one wording. */
export const REMOTES_PENDING_REASON = "Checking remotes…";

/** A remotes read that failed with nothing loaded; shared with the forge tabs'
 *  not-ready panel. */
export const REMOTES_FAILED_REASON = "Couldn't read the remotes";

/** Which read a held action is waiting on. Remotes outrank status: they decide
 *  whether this cluster is the right control at all. */
type UnknownRead = "remotesFailed" | "remotes" | "statusFailed" | "status";

const UNKNOWN_READ_REASON: Record<UnknownRead, string> = {
  remotesFailed: REMOTES_FAILED_REASON,
  remotes: REMOTES_PENDING_REASON,
  statusFailed: STATUS_READ_FAILED_REASON,
  status: STATUS_PENDING_REASON,
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
  /** The upstream's remote and its branch name there, read off the merge ref. */
  upstreamRemote: string | null;
  upstreamBranch: string | null;
  /** The backend's verdict that a bare push would be refused for the names
   *  differing (it alone can read the push config). */
  pushNameMismatch: boolean;
  /** Whether `upstreamBranch` is its remote's default branch; null = unknown. */
  upstreamIsRemoteDefault: boolean | null;
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
  /** What a `busy` hold says; {@link SYNC_BUSY_REASON} when absent. A caller
   *  held by another surface's write names that write instead. */
  busyReason?: string;
  /** The offline hold's reason, undefined while online. */
  offlineHold: string | undefined;
  /** The rewrite probe's measured verdicts (all false/0 until it resolves). */
  remoteRebased: boolean;
  mixedRewrite: boolean;
  localAtRisk: number;
  /** Whether refs/remotes/<R>/<new> already exists locally (last-fetch state), from
   *  the remote-branches read; false while unknown — the label upgrade is cosmetic. */
  remoteNewExists: boolean;
}

export interface Hold {
  disabled: boolean;
  /** Read by DisabledReasonButton only while `disabled`. */
  reason: string | undefined;
}

/** One destination in the mismatch Push menu; a held item carries its reason in
 *  the label (a disabled menu item can't show a tooltip). */
export interface MismatchMenuItem {
  label: string;
  disabled: boolean;
}

/** The Push menu shown while the branch's upstream has a different name: every
 *  push from it names its destination outright. */
export interface MismatchMenu {
  /** The local branch (HEAD). */
  branch: string;
  /** The upstream's remote. */
  remote: string;
  /** The upstream's branch name on `remote`. */
  remoteBranch: string;
  groupLabel: string;
  /** Push into the tracked branch; null (omitted) when that branch is known to be
   *  the remote's default — never a one-click push into it. */
  pushToTracked: MismatchMenuItem | null;
  /** Push under the local name on the same remote and track it. */
  publish: MismatchMenuItem;
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
  const busyReason = input.busyReason ?? SYNC_BUSY_REASON;
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
  // git would refuse a bare push here, so Push becomes a menu of explicit
  // destinations. It wins over divergence everywhere: no force arm exists in it.
  const mismatch = Boolean(
    statusKnown &&
      hasUpstream &&
      head.pushNameMismatch &&
      head.name &&
      head.upstreamRemote &&
      head.upstreamBranch,
  );
  const mismatchMenu = ((): MismatchMenu | null => {
    if (
      !mismatch ||
      !head?.name ||
      !head.upstreamRemote ||
      !head.upstreamBranch
    )
      return null;
    const branch = head.name;
    const remote = head.upstreamRemote;
    const remoteBranch = head.upstreamBranch;
    const tracked = `Push to ${remote}/${remoteBranch}`;
    const pushToTracked = ((): MismatchMenuItem | null => {
      if (head.upstreamIsRemoteDefault === true) return null;
      if (aheadCount === 0)
        return { label: `${tracked} (nothing to push)`, disabled: true };
      if (diverged)
        return {
          label: `${tracked} (diverged — use the Pull menu first)`,
          disabled: true,
        };
      return { label: tracked, disabled: false };
    })();
    // The re-track starts the new upstream at the local tip, so commits only on
    // the old one would silently drop out of the Pull count.
    const publishBase = input.remoteNewExists
      ? `Push to ${remote}/${branch} and track it`
      : `Publish as ${remote}/${branch}`;
    const publish =
      behindCount > 0
        ? { label: `${publishBase} (pull first)`, disabled: true }
        : { label: publishBase, disabled: false };
    return {
      branch,
      remote,
      remoteBranch,
      groupLabel: `${branch} tracks ${remote}/${remoteBranch}`,
      pushToTracked,
      publish,
    };
  })();
  const mismatchAllHeld =
    mismatchMenu !== null &&
    (mismatchMenu.pushToTracked?.disabled ?? true) &&
    mismatchMenu.publish.disabled;
  // "Publish branch" sends `-u origin`, so it is offered only for a branch the
  // status has MEASURED as untracked — never for one still loading.
  const pushLabel = (() => {
    if (mismatch) return "Push";
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
    // git reports no ahead/behind for a branch with no commits, so its upstream
    // reads as gone whether or not the remote branch exists; claim neither.
    if (unborn && head.upstreamGone)
      return `Pull — ${head.name} has no commits yet, so it can't be compared with ${upstream}`;
    // Publish is held until the first commit, so the advice names that first.
    if (unborn && !upstream)
      return `Pull — ${head.name} has no commits yet; make your first commit, then publish the branch`;
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
    // Never `aheadLabel`: its "to push to <upstream>" is exactly what a bare
    // push can't do here.
    if (mismatchMenu) {
      // A menu with every item held can't open, so the trigger names the remedy
      // instead; the publish item holds only while behind, so pulling always is.
      const remedy = !mismatchAllHeld
        ? "choose where from the menu"
        : diverged
          ? "use the Pull menu first"
          : "pull first";
      const names = `${mismatchMenu.groupLabel}, which has a different name — ${remedy}`;
      return aheadCount > 0
        ? `Push — ${aheadCount} commit${plural(aheadCount)} to push; ${names}`
        : `Push — ${names}`;
    }
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
    reason: busy ? busyReason : (offlineHold ?? pending ?? description),
  });
  const fetchHold = hold(unknownRead(false), false, undefined);
  const pull = hold(
    unknownRead(true),
    !hasUpstream || diverged,
    pullDescription,
  );
  // A mismatch menu with nothing to offer holds the trigger itself, as the Pull
  // caret holds an empty menu.
  const push = hold(
    unknownRead(true),
    detached || unborn || mismatchAllHeld,
    pushDescription,
  );
  // The caret stays live offline: its items carry their own offline holds.
  const pullOptions = ((): Hold => {
    const pending = unknownRead(true);
    const empty = !hasUpstream && !canUpdateUpstream;
    const disabled = busy || pending !== undefined || empty;
    if (busy) return { disabled, reason: busyReason };
    if (pending !== undefined) return { disabled, reason: pending };
    // An unborn branch has no commits to reconcile, upstream or not, and the
    // empty menu's reason would point at Publish, which Push holds until the
    // first commit; the caret repeats the Pull description instead.
    if (detached || unborn) return { disabled, reason: pullDescription };
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
    mismatch,
    mismatchMenu,
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
        !mismatchAllHeld &&
        !offlineHold,
      updateFromUpstream:
        statusKnown && canUpdateUpstream && !busy && !offlineHold,
    },
  };
}
