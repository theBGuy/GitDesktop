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

/** The hold suffix on a menu item that would push a branch marked Keep local.
 *  Its one spelling in src/: the branch menu imports it from here. */
export const KEPT_LOCAL_SUFFIX = " (kept local)";

/** Why a push or publish of `branch` is held while it is marked Keep local. */
export function keptLocalReason(
  branch: string,
  verb: "push" | "publish",
): string {
  return `${branch} is kept local. Turn off Keep local in the branch menu to ${verb} it.`;
}

/** Pull's reason on a kept-local HEAD with no live upstream: the usual ones
 *  advise publishing, which Keep local holds. */
export const KEPT_LOCAL_PULL_REASON: Record<
  "untracked" | "gone",
  (branch: string, upstream: string) => string
> = {
  untracked: (branch) =>
    `Pull — ${branch} is kept local and has no upstream branch to pull from`,
  gone: (branch, upstream) =>
    `Pull — ${branch} is kept local and its upstream ${upstream} was deleted on the remote, so there is nothing to pull`,
};

/** The branch the force-push confirm's Keep local hold names, or null for no
 *  hold. A null captured branch falls back to the live kept-local HEAD; a
 *  captured branch is held only while it is that HEAD. */
export function forceConfirmKeptBranch(
  captured: string | null,
  keptHead: string | null,
): string | null {
  return captured === null || captured === keptHead ? keptHead : null;
}

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
  /** Where a bare push lands, when the status resolved it; null or absent =
   *  unresolved. */
  pushRemote?: string | null;
  pushBranch?: string | null;
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
  /** HEAD's branch-list row is marked Keep local; false while unknown (a stale or
   *  unloaded list leaves Push live, and Rust refuses the push). */
  keptLocal: boolean;
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
    // The negation of branch-sync-state.ts's `willPublish` for a push without an
    // explicit retrack (`setUpstream`); keep the two in step.
    hasUpstream: Boolean(head?.upstream) && !head?.upstreamGone,
    diverged: Boolean(head && head.ahead > 0 && head.behind > 0),
    detached: Boolean(head?.detached),
  };
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** The name-mismatch Push menu for a branch tracking a differently named one.
 *  The sync bar (HEAD) and the branch menu (any row) both build it here, so one
 *  branch gets one answer on both surfaces. */
export function deriveMismatchMenu(i: {
  branch: string;
  remote: string;
  remoteBranch: string;
  ahead: number;
  behind: number;
  /** true only when MEASURED: BranchHead's `=== true`, or the row's boolean. */
  upstreamIsRemoteDefault: boolean;
  remoteNewExists: boolean;
  keptLocal: boolean;
}): MismatchMenu {
  const { branch, remote, remoteBranch, ahead, behind, keptLocal } = i;
  const tracked = `Push to ${remote}/${remoteBranch}`;
  const pushToTracked = ((): MismatchMenuItem | null => {
    if (i.upstreamIsRemoteDefault) return null;
    if (keptLocal)
      return { label: `${tracked}${KEPT_LOCAL_SUFFIX}`, disabled: true };
    if (ahead === 0)
      return { label: `${tracked} (nothing to push)`, disabled: true };
    if (behind > 0)
      return {
        label: `${tracked} (diverged — use the Pull menu first)`,
        disabled: true,
      };
    return { label: tracked, disabled: false };
  })();
  const publishBase = i.remoteNewExists
    ? `Push to ${remote}/${branch} and track it`
    : `Publish as ${remote}/${branch}`;
  // The re-track starts the new upstream at the local tip, so commits only on
  // the old one drop out of the Pull count. On the remote's default branch they
  // are that branch's commits, not this one's, so nothing is held for them.
  // Keep local is structural, so it outranks that transient hold.
  const publish = ((): MismatchMenuItem => {
    switch (true) {
      case keptLocal:
        return { label: `${publishBase}${KEPT_LOCAL_SUFFIX}`, disabled: true };
      case behind > 0 && !i.upstreamIsRemoteDefault:
        return { label: `${publishBase} (pull first)`, disabled: true };
      default:
        return { label: publishBase, disabled: false };
    }
  })();
  return {
    branch,
    remote,
    remoteBranch,
    groupLabel: `${branch} tracks ${remote}/${remoteBranch}`,
    pushToTracked,
    publish,
  };
}

/** A branch-list row's upstream facts, as the row indicator and menu read them. */
export interface RowUpstreamFacts {
  name: string;
  upstream: string | null;
  upstreamGone: boolean;
  upstreamRemote: string | null;
  /** The upstream's branch name on its remote; null for a non-branch ref. */
  upstreamBranch: string | null;
  upstreamAhead: number;
  upstreamBehind: number;
  upstreamIsRemoteDefault: boolean;
  keepLocal: boolean;
}

/** Non-null only for a live upstream on a CONFIGURED remote whose branch name
 *  differs from the row's. A local (`.`) or removed remote is not configured. */
export function rowNameMismatch(
  row: RowUpstreamFacts,
  remoteNames: readonly string[],
): { remote: string; remoteBranch: string; isRemoteDefault: boolean } | null {
  const remote = row.upstreamRemote;
  if (!row.upstream || row.upstreamGone) return null;
  if (remote === null || !remoteNames.includes(remote)) return null;
  if (row.upstreamBranch === null || row.upstreamBranch === row.name)
    return null;
  return {
    remote,
    remoteBranch: row.upstreamBranch,
    isRemoteDefault: row.upstreamIsRemoteDefault,
  };
}

export type RowSyncIndicator =
  | { kind: "none" }
  | { kind: "removedRemote"; label: string }
  | {
      kind: "arrows";
      label: string;
      ahead: number;
      behind: number;
      /** Set when the upstream has another name: the row names it inline. */
      upstreamName: string | null;
    }
  | { kind: "startPoint"; label: string }
  | { kind: "gone"; label: string }
  | { kind: "neverPublished"; label: string };

/** The row's own-upstream marker. No marker on a kept-local row advises
 *  publishing it: the chip already says it stays local. `secondaryClick` is the
 *  sentence-initial secondary-click word. `ownNameOnRemote` (the last fetch
 *  lists the row's own name on its upstream's remote) points a start-point row
 *  at tracking that branch instead of publishing. */
export function rowSyncIndicator(
  row: RowUpstreamFacts,
  remoteNames: readonly string[],
  secondaryClick: string,
  ownNameOnRemote: boolean,
): RowSyncIndicator {
  const remote = row.upstreamRemote;
  // Tracking a removed remote offers neither Push nor Publish, so arrows would
  // imply an action the menu can't honor. A local (`.`) upstream is not one.
  if (
    row.upstream &&
    !row.upstreamGone &&
    remote !== null &&
    remote !== "." &&
    !remoteNames.includes(remote)
  )
    return {
      kind: "removedRemote",
      label: `Tracks ${row.upstream}, but that remote is no longer configured.`,
    };
  if (row.upstream && !row.upstreamGone) {
    const mismatch = rowNameMismatch(row, remoteNames);
    // Created from the remote's default branch: nothing of it is published.
    if (mismatch?.isRemoteDefault) {
      if (row.keepLocal) return { kind: "none" };
      return {
        kind: "startPoint",
        label: ownNameOnRemote
          ? `Tracks ${row.upstream}, where it started. ${mismatch.remote}/${row.name} exists. ${secondaryClick} to track it.`
          : `Not published. Tracks ${row.upstream}, where it started. ${secondaryClick} to publish.`,
      };
    }
    const ahead = row.upstreamAhead;
    const behind = row.upstreamBehind;
    // In sync with the upstream: silence means synced.
    if (ahead === 0 && behind === 0) return { kind: "none" };
    const parts: string[] = [];
    if (ahead > 0) parts.push(`${ahead} to push`);
    if (behind > 0) parts.push(`${behind} to pull`);
    return {
      kind: "arrows",
      label: `${parts.join(", ")} — vs ${row.upstream}`,
      ahead,
      behind,
      upstreamName: mismatch ? row.upstream : null,
    };
  }
  if (row.upstreamGone)
    return {
      kind: "gone",
      label: row.keepLocal
        ? `Upstream ${row.upstream} was deleted on the remote — likely merged.`
        : `Upstream ${row.upstream} was deleted on the remote — likely merged. ${secondaryClick} to publish again or delete.`,
    };
  if (row.keepLocal) return { kind: "none" };
  return {
    kind: "neverPublished",
    label: `Local only — never published. ${secondaryClick} to publish.`,
  };
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
  // Unknown (null) is not the default: the tracked item stays and the publish
  // item keeps its pull-first hold.
  const mismatchMenu =
    mismatch && head?.name && head.upstreamRemote && head.upstreamBranch
      ? deriveMismatchMenu({
          branch: head.name,
          remote: head.upstreamRemote,
          remoteBranch: head.upstreamBranch,
          ahead: aheadCount,
          behind: behindCount,
          upstreamIsRemoteDefault: head.upstreamIsRemoteDefault === true,
          remoteNewExists: input.remoteNewExists,
          keptLocal: input.keptLocal,
        })
      : null;
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
  const keptHeadName = input.keptLocal && head?.name ? head.name : null;
  // Ranks first in every push hold: no other reason matters for a push that
  // can't happen at all.
  const pushKeptLocalReason =
    input.keptLocal && head?.name
      ? keptLocalReason(
          head.name,
          pushLabel === "Publish branch" ? "publish" : "push",
        )
      : undefined;

  // One description per button feeds both its tooltip and its accessible name;
  // each starts with the visible label (WCAG 2.5.3) and, while disabled,
  // carries the reason and the count. Undefined = the bare label suffices.
  // A plain push that git sends somewhere other than the upstream names where it
  // goes, whatever the count: the count is upstream-relative, and the push still
  // sends at zero. The same resolved-and-differs test SyncControls' beginPush uses.
  const pushElsewhere =
    statusKnown &&
    hasUpstream &&
    !mismatch &&
    !diverged &&
    head.pushRemote != null &&
    head.pushBranch != null &&
    (head.pushRemote !== head.upstreamRemote ||
      head.pushBranch !== head.upstreamBranch)
      ? `${head.pushRemote}/${head.pushBranch}`
      : null;
  const aheadLabel = (() => {
    switch (true) {
      case pushElsewhere !== null:
        return `${pushLabel} to ${pushElsewhere}`;
      case aheadCount > 0:
        return `${pushLabel} — ${aheadCount} commit${plural(aheadCount)} to push to ${upstream}`;
      default:
        return undefined;
    }
  })();
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
    // Publish is held while kept local, so nothing here may advise it.
    if (keptHeadName !== null && !hasUpstream)
      return KEPT_LOCAL_PULL_REASON[head.upstreamGone ? "gone" : "untracked"](
        keptHeadName,
        upstream ?? "",
      );
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
    if (pushKeptLocalReason) return `${pushLabel} — ${pushKeptLocalReason}`;
    if (detached)
      return `${pushLabel} — you're on a detached HEAD; check out a branch to push`;
    if (unborn)
      return `${pushLabel} — ${head.name} has no commits yet; make your first commit to publish it`;
    // Never `aheadLabel`: its "to push to <upstream>" is exactly what a bare
    // push can't do here.
    if (mismatchMenu) {
      // A menu with every item held can't open, so the trigger names the remedy
      // instead. That needs an upstream other than the remote's default, whose
      // publish item holds only while behind, so pulling always is.
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
  const push: Hold =
    pushKeptLocalReason !== undefined
      ? { disabled: true, reason: pushKeptLocalReason }
      : hold(
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
    // The empty menu's reason points at Publish, which Keep local holds.
    if (empty && keptHeadName !== null)
      return { disabled, reason: pullDescription };
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
    /** Set while HEAD is marked Keep local: the push hold's reason and the push
     *  hotkey's refusal toast. */
    pushKeptLocalReason,
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
      // A kept-local HEAD keeps the key live so the press reaches its toast,
      // except with no origin, where the bar shows only Publish repository.
      push:
        (pushKeptLocalReason !== undefined && !noOrigin) ||
        (statusKnown &&
          hasOrigin &&
          !busy &&
          !detached &&
          !unborn &&
          !mismatchAllHeld &&
          !offlineHold),
      updateFromUpstream:
        statusKnown && canUpdateUpstream && !busy && !offlineHold,
    },
  };
}
