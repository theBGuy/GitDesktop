import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { create } from "zustand";
import { presentError } from "@/lib/error-summary";
import {
  gitBranches,
  gitCheckoutBranch,
  gitDefaultBranch,
  gitOpState,
  gitSetBranchArchived,
  gitStashAll,
  validateRepo,
} from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import {
  invalidateRepoAfterWrite,
  LOCAL_PR_WRITES_KEY,
  type LocalPrWriteKind,
  readPendingLocalPrWrite,
  repoKeys,
  worktreeKey,
} from "@/lib/git/queries";
import type { RepoOp, RepoOpState } from "@/lib/git/types";
import {
  beginPromoteWindow,
  endPromoteWindow,
  listUserWorktrees,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  touchPromoteWindow,
  type UserWorktree,
  type WorktreeRemoveOutcome,
} from "@/lib/git/worktree";
import { queryClient } from "@/lib/query-client";
import { toastComposedError, toastError } from "@/lib/toast";
import { useStashReapplyMarker } from "./stash-reapply-marker";
import { claimWarmRepoShell, useUiStore } from "./ui";

/** A worktree removal the app is still waiting on. */
export interface WorktreeRemoval {
  /** Absolute path of the worktree being removed (as git reports it). */
  path: string;
  /** What to call it on screen — its branch, or the folder name when detached. */
  name: string;
  /** The branch checked out in the worktree being removed, null when detached.
   *  Distinct from {@link WorktreeRemoval.name}, whose folder-name fallback can
   *  collide with an unrelated branch — match on this one. */
  branch: string | null;
  /** Archive {@link WorktreeRemoval.branch} once the removal succeeds. Held in
   *  memory only: quitting mid-removal drops the intent while the backend
   *  removal still completes, which is accepted over persisting it. */
  archiveWhenDone: boolean;
  /** Epoch ms the removal started. */
  startedAt: number;
  /** Which step of a promote this entry is on. Set only by the promote path — a
   *  plain delete leaves it undefined, and the removal ends with its own step. */
  promotePhase?: "removing" | "stashing" | "checking-out";
}

/** The open delete dialog's hooks for the removal it launched. */
export interface RemovalListener {
  /** The worktree is gone; the dialog has nothing left to confirm. */
  onSuccess: () => void;
  /** Removal failed. `force` is what the attempt used, so the dialog can tell a
   *  "needs --force" refusal from a real failure. */
  onError: (error: unknown, force: boolean) => void;
}

interface WorktreeRemovalState {
  /** repoPath → worktree path → the removal in flight. Keyed by repo so a repo
   *  switch reads an empty set rather than another repo's removals.
   *
   *  The repo key is ALWAYS the ui store's repoPath spelling (`RepoInfo.root`),
   *  because every consumer reads it from there; the worktree key is git's list
   *  spelling. A writer holding git's spelling of the repo (the promote path)
   *  must resolve it through `validateRepo` first, or its entry lands in a
   *  bucket the banner and the manager's rows never read. */
  byRepo: Record<string, Record<string, WorktreeRemoval>>;
  /** Starts a removal and keeps it visible until it settles. Returns null once
   *  started, or the reason it was refused: a second attempt on the same
   *  worktree only queues behind the per-repo git lock and then removes nothing. */
  startRemoval: (args: {
    repoPath: string;
    path: string;
    /** Display name; see {@link WorktreeRemoval.name}. */
    name: string;
    /** The removed worktree's branch; see {@link WorktreeRemoval.branch}. */
    branch: string | null;
    /** Archive `branch` when the removal succeeds. */
    archiveWhenDone: boolean;
    force: boolean;
  }) => string | null;
  /** Starts a promote — remove the worktree to free its branch, then check that
   *  branch out in the main workspace — and keeps its removal step visible the
   *  same way `startRemoval` does. Returns null once started, or the reason it
   *  was refused. Every precondition is the caller's to check first; this runs
   *  past the point of no return with no dialog left to report to. */
  startPromote: (args: {
    /** The main workspace, and the repo the app is switched onto to run this. */
    mainPath: string;
    /** The worktree whose folder goes away to free the branch. */
    worktreePath: string;
    /** The branch to check out in the main workspace once it's free. */
    branch: string;
    /** Stash the main workspace's own uncommitted changes before checking out. */
    willStash: boolean;
  }) => string | null;
}

/** Removal outlives the dialog that started it, so the outcome goes to the
 *  NEWEST dialog still mounted for that target — and to a toast when none is.
 *  That keeps every failure to exactly one, live surface. A stack rather than
 *  one slot: each disposer splices only itself, so an unmounted dialog can
 *  never linger as a stale recipient while a mounted one exists. Listeners
 *  never affect rendering, so they live beside the store, not in its state. */
const listeners = new Map<string, RemovalListener[]>();
// NUL is the one separator no filesystem path can contain — POSIX allows `:`,
// so ("a::b", "c") and ("a", "b::c") would share a "::"-joined key.
const listenerKey = (repoPath: string, path: string) =>
  `${repoPath}\u0000${path}`;

/** Registers a dialog's outcome handlers for one target; call the returned
 *  function on unmount. */
export function registerRemovalListener(
  repoPath: string,
  path: string,
  listener: RemovalListener,
): () => void {
  const key = listenerKey(repoPath, path);
  const stack = listeners.get(key) ?? [];
  stack.push(listener);
  listeners.set(key, stack);
  return () => {
    const cur = listeners.get(key);
    if (!cur) return;
    const i = cur.indexOf(listener);
    if (i !== -1) cur.splice(i, 1);
    if (cur.length === 0) listeners.delete(key);
  };
}

const NO_REMOVALS: WorktreeRemoval[] = [];

/** True while this worktree is being removed, whichever spelling the path
 *  arrived in and under ANY repo key: a worktree folder belongs to one repo, so
 *  a removal marked while viewing another of its checkouts still counts (the
 *  reasoning that makes {@link promotingWorktrees} global). */
function isRemovalInFlight(
  byRepo: Record<string, Record<string, WorktreeRemoval>>,
  path: string,
): boolean {
  const target = normPath(path);
  return Object.values(byRepo).some((entries) =>
    Object.keys(entries).some((p) => normPath(p) === target),
  );
}

/** The worktrees with a plain removal (not a promote's) in flight, under any
 *  repo key, in their {@link normPath} spelling. A FIRE-TIME read of the
 *  store's state; a promote doesn't count, since it frees the branch to check
 *  it out elsewhere. */
export function plainRemovalPaths(): Set<string> {
  const { byRepo } = useWorktreeRemovalStore.getState();
  const paths = new Set<string>();
  for (const entries of Object.values(byRepo))
    for (const [p, r] of Object.entries(entries))
      if (!r.promotePhase) paths.add(normPath(p));
  return paths;
}

/** True while a promote of this branch is in flight under any repo key, in
 *  every phase: once its removal ends, the branch sits in no worktree until
 *  the main workspace checks it out. A FIRE-TIME read, like
 *  {@link plainRemovalPaths}. */
export function isBranchPromoting(branch: string): boolean {
  return Object.values(useWorktreeRemovalStore.getState().byRepo).some(
    (entries) =>
      Object.values(entries).some(
        (r) => r.promotePhase !== undefined && r.branch === branch,
      ),
  );
}

/** Main workspaces with a promote running, keyed by {@link normPath} so the two
 *  spellings can't both pass. Two promotes into the same checkout would fight
 *  over the final `gitCheckoutBranch`, and the dialog that started the first is
 *  gone by then — so the latch lives here, not in a component ref. */
const promotingMains = new Set<string>();

/** Worktrees claimed by a promote, keyed by {@link normPath} and GLOBAL rather
 *  than per-repo: a promote reserves its source before it knows which repo key
 *  it will mark under, and the same folder can be targeted from another
 *  checkout's context. Deliberately NOT a `byRepo` entry — that map paints the
 *  banner, and a promote that fails `validateRepo` would leave a removal on
 *  screen that never started. */
const promotingWorktrees = new Set<string>();

/** True while a promote has claimed this worktree. A FIRE-TIME check only:
 *  {@link promotingWorktrees} is deliberately not store state, so nothing
 *  re-renders when it changes — call this where a mutation would start, never
 *  to decide what a component paints. */
export function isWorktreePromoting(path: string): boolean {
  return promotingWorktrees.has(normPath(path));
}

/** True while a promote has claimed this MAIN workspace as its destination.
 *  Fire-time check only, like {@link isWorktreePromoting} — {@link promotingMains}
 *  is deliberately not store state, so never use this to decide what renders. */
export function isMainPromoting(path: string): boolean {
  return promotingMains.has(normPath(path));
}

/** Fire-time gate for any HEAD- or branch-moving op in `repoPath`, and for branch
 *  deletes: refuses both while a promote targets it as the main workspace and
 *  while it is the promote's source worktree (active until the promote's
 *  `openRepo` moves the app off it). */
export function promotionBlocksCheckout(repoPath: string): boolean {
  return isMainPromoting(repoPath) || isWorktreePromoting(repoPath);
}

/** The refusal every surface shows for a worktree a promote has claimed — one
 *  spelling, so the store's refusals and the callers' can't drift apart. */
export const WORKTREE_PROMOTING_MESSAGE = "This worktree is being promoted.";

/** Both starters' refusal of a duplicate attempt. "Already" is the store's own
 *  word for a second attempt on the same target, and belongs only here — a
 *  caller that never asked for the removal states the state instead. */
const WORKTREE_REMOVING_MESSAGE = "This worktree is already being removed.";

// `_set` unused: every write goes through the module-level helpers below, so a
// runner that outlives its dialog reaches state the same way the starters do.
export const useWorktreeRemovalStore = create<WorktreeRemovalState>()(
  (_set, get) => ({
    byRepo: {},

    startRemoval: ({
      repoPath,
      path,
      name,
      branch,
      archiveWhenDone,
      force,
    }) => {
      // Matched on the directory, not the string or the viewer: the same folder
      // can arrive in either spelling, from any checkout of the repo.
      if (isRemovalInFlight(get().byRepo, path))
        return WORKTREE_REMOVING_MESSAGE;
      if (promotingWorktrees.has(normPath(path)))
        return WORKTREE_PROMOTING_MESSAGE;
      markRemoval({ repoPath, path, name, branch, archiveWhenDone });
      void run({ repoPath, path, force, branch, archiveWhenDone });
      return null;
    },

    startPromote: ({ mainPath, worktreePath, branch, willStash }) => {
      // The entry this would collide with may be keyed under any viewer and
      // spelled the ui store's way; match on the directory, not the string.
      if (isRemovalInFlight(get().byRepo, worktreePath))
        return WORKTREE_REMOVING_MESSAGE;
      if (promotingWorktrees.has(normPath(worktreePath)))
        return WORKTREE_PROMOTING_MESSAGE;
      if (promotingMains.has(normPath(mainPath)))
        return "Another worktree is already being promoted to your main workspace.";
      promotingMains.add(normPath(mainPath));
      // Claim the source worktree BEFORE the first await: `validateRepo` plus
      // the repo switch is long enough for a delete of the same folder to be
      // accepted, and this promote's dialog has already closed.
      promotingWorktrees.add(normPath(worktreePath));
      void runPromote(mainPath, worktreePath, branch, willStash);
      return null;
    },
  }),
);

/** Named arguments rather than positional: `name` and `branch` are both plain
 *  strings that usually hold the same value, and a swap at a call site would
 *  only surface on a detached worktree. */
function markRemoval({
  repoPath,
  path,
  name,
  branch,
  archiveWhenDone,
  promotePhase,
}: {
  repoPath: string;
  path: string;
  name: string;
  branch: string | null;
  archiveWhenDone: boolean;
  promotePhase?: WorktreeRemoval["promotePhase"];
}) {
  useWorktreeRemovalStore.setState((s) => ({
    byRepo: {
      ...s.byRepo,
      [repoPath]: {
        ...s.byRepo[repoPath],
        [path]: {
          path,
          name,
          branch,
          archiveWhenDone,
          startedAt: Date.now(),
          promotePhase,
        },
      },
    },
  }));
}

/** Moves an existing entry on to the next promote step; a missing entry is a
 *  defensive no-op. */
function advancePromotePhase(
  repoKey: string,
  path: string,
  phase: WorktreeRemoval["promotePhase"],
) {
  useWorktreeRemovalStore.setState((s) => {
    const entry = s.byRepo[repoKey]?.[path];
    if (!entry) return s;
    return {
      byRepo: {
        ...s.byRepo,
        [repoKey]: {
          ...s.byRepo[repoKey],
          [path]: { ...entry, promotePhase: phase },
        },
      },
    };
  });
}

function clearRemoval(repoPath: string, path: string) {
  useWorktreeRemovalStore.setState((s) => {
    const repo = s.byRepo[repoPath];
    if (!repo?.[path]) return s;
    const { [path]: _settled, ...rest } = repo;
    const { [repoPath]: _emptied, ...otherRepos } = s.byRepo;
    return {
      byRepo:
        Object.keys(rest).length > 0
          ? { ...s.byRepo, [repoPath]: rest }
          : otherRepos,
    };
  });
}

/** Refreshes what a completed removal changed: the manager's list, plus branches
 *  (a removed worktree frees its branch for checkout elsewhere). Separate from
 *  {@link settleRemoval} because the promote path refreshes at its removal step
 *  while its entry stays on screen for the rest of the composite. */
function invalidateAfterRemoval(repoPath: string) {
  void queryClient.invalidateQueries({ queryKey: worktreeKey(repoPath) });
  void queryClient.invalidateQueries({ queryKey: repoKeys.branches(repoPath) });
}

/** Drops the entry and refreshes what the removal changed. */
function settleRemoval(repoPath: string, path: string) {
  clearRemoval(repoPath, path);
  invalidateAfterRemoval(repoPath);
}

/** The one recovery message for an archive that didn't happen, spelled once so
 *  the two ways it can be refused can't drift apart. */
function toastArchiveRefused(branch: string, e: unknown) {
  toastComposedError({
    title: `Removed the worktree, but couldn't archive ${branch} — you can archive it from the branch menu.`,
    errors: [e],
    description: presentError(e).summary,
  });
}

/** What the archive step after a successful removal did. */
type ArchiveStepOutcome =
  | { kind: "archived" }
  | { kind: "alreadyArchived" }
  | { kind: "isDefault" }
  | { kind: "inUse" }
  | { kind: "failed"; error: unknown };

/** Archives a removed worktree's branch and says what happened, reporting
 *  nothing itself: the delete dialog's path toasts the outcome, Clean up
 *  branches returns it as its row's result. */
async function archiveBranchAfterRemoval(
  repoPath: string,
  branch: string,
): Promise<ArchiveStepOutcome> {
  // Re-resolved at completion time rather than trusted from the dialog: the
  // intent can be minutes old, and archiving the default branch would hide it
  // from every branch surface. This write fails CLOSED — an unreadable default
  // skips the archive and says so, because nobody is watching a deferred write
  // that lands minutes later. The branch menu's guard stays best-effort on the
  // same lookup: it answers a user who is right there to see the result.
  let isDefault: boolean;
  try {
    isDefault = (await gitDefaultBranch(repoPath)) === branch;
  } catch (error) {
    return { kind: "failed", error };
  }
  if (isDefault) return { kind: "isDefault" };
  // Already-archived is re-resolved here too, so a branch archived from the
  // branch menu while the removal ran isn't reported as this step changing
  // something. Unlike the default-branch read this fails OPEN: the set is
  // idempotent, so an unreadable list must not skip an archive that would have
  // succeeded.
  try {
    const found = (await gitBranches(repoPath)).find((b) => b.name === branch);
    if (found?.archived) return { kind: "alreadyArchived" };
    if (found?.isCurrent) return { kind: "inUse" };
  } catch {
    // Fall through to the next read.
  }
  // Archiving a checked-out branch would hide the branch someone is on (the
  // branch menu refuses it), and the freed branch can be checked out again
  // while the removal runs. The branch list's `isCurrent` covers only this
  // checkout, so a fresh worktree list covers the others: the UNFILTERED one,
  // since the user list drops agent-session folders whatever they hold. Its
  // branches arrive short (the backend strips `refs/heads/`). Fails OPEN for
  // the same reason as the already-archived read.
  try {
    const worktrees = await listWorktrees(repoPath);
    if (worktrees.some((w) => w.branch === branch)) return { kind: "inUse" };
  } catch {
    // Fall through to the archive.
  }
  try {
    await gitSetBranchArchived(repoPath, branch, true);
    // `settleRemoval` invalidated before the flag landed; branch surfaces read
    // the archived state, so they need the pass that sees it.
    void queryClient.invalidateQueries({
      queryKey: repoKeys.branches(repoPath),
    });
    return { kind: "archived" };
  } catch (error) {
    return { kind: "failed", error };
  }
}

/** Honours the delete dialog's "archive when done" checkbox, once the removal
 *  has settled. The removal itself has already succeeded here, so nothing in
 *  this step can turn it back into a failure — a refused archive reports itself
 *  and points at the branch menu, which can still do it. */
async function archiveAfterRemoval(repoPath: string, branch: string) {
  const outcome = await archiveBranchAfterRemoval(repoPath, branch);
  switch (outcome.kind) {
    case "isDefault":
      toast.success("Worktree removed");
      toast.info(`Left ${branch} unarchived — it's the default branch.`);
      return;
    case "inUse":
      toast.success("Worktree removed");
      toast.info(`Left ${branch} unarchived — it's checked out again.`);
      return;
    case "alreadyArchived":
      toast.success("Worktree removed");
      toast.info(`${branch} was already archived.`);
      return;
    case "archived":
      toast.success(`Worktree removed and ${branch} archived`);
      return;
    case "failed":
      toastArchiveRefused(branch, outcome.error);
      return;
  }
}

/**
 * Runs one removal to completion. There is deliberately no cancel: the backend
 * removal is uninterruptible past its first steps, and killing it midway strands
 * a half-removed worktree with a live admin entry.
 */
async function run({
  repoPath,
  path,
  force,
  branch,
  archiveWhenDone,
}: {
  repoPath: string;
  path: string;
  force: boolean;
  branch: string | null;
  archiveWhenDone: boolean;
}) {
  let failure: { error: unknown } | null = null;
  try {
    // branch=null: removing a worktree leaves its branch intact (deleting a
    // user's branch is a separate, more destructive action).
    await removeWorktree(repoPath, path, null, force);
    // Best-effort cleanup; a clean remove already drops its own admin entry.
    await pruneWorktrees(repoPath).catch(() => undefined);
  } catch (error) {
    failure = { error };
  }

  // Drop the entry before handing the outcome over, so a dialog re-offering a
  // force remove already sees its Remove button live again.
  settleRemoval(repoPath, path);

  const listener = listeners.get(listenerKey(repoPath, path))?.at(-1);
  if (failure) {
    // A failed removal leaves the worktree — and so the branch's checkout —
    // in place, so the archive intent is not acted on.
    if (listener) listener.onError(failure.error, force);
    else toastError(failure.error);
    return;
  }
  if (!archiveWhenDone || !branch) {
    toast.success("Worktree removed");
    listener?.onSuccess();
    return;
  }
  // Close the dialog before the archive rather than after: the entry has
  // already settled, so one left open would re-offer Remove on a worktree that
  // is gone. The archive reports its own outcome by toast either way.
  listener?.onSuccess();
  await archiveAfterRemoval(repoPath, branch);
}

/** A removal failure's text with the worktree's path stripped, so a folder
 *  NAMED e.g. "docs-in-use" or "locked-tools" can't steer a classifier. */
function removalErrorText(e: unknown, path: string): string {
  return String((e as { message?: string })?.message ?? e).replaceAll(path, "");
}

/** Remove a worktree without forcing it (deleting `branch` too when given, if
 *  its tip hasn't moved), retrying once if the folder is momentarily still held.
 *  A promote has just switched the app off this worktree, and a cleanup's own
 *  status read may still be running inside it: a last in-flight git process (or
 *  the OS) can keep the directory busy for a beat, and `openRepo` applies its
 *  switch in a View Transition callback that can run after the call returns.
 *  The retry covers that window; a real, lasting hold (an editor/terminal in the
 *  folder) still surfaces the actionable error. */
async function removeWorktreeFreeingBranch(
  repoPath: string,
  path: string,
  branch: string | null,
): Promise<WorktreeRemoveOutcome> {
  try {
    return await removeWorktree(repoPath, path, branch, false);
  } catch (e) {
    const msg = removalErrorText(e, path);
    if (/close any program|in use|being used|invalid argument/i.test(msg)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return await removeWorktree(repoPath, path, branch, false);
    }
    throw e;
  }
}

/**
 * Runs one promote to completion: free the branch (remove its worktree, keep the
 * branch) then check it out in the main workspace. Store-owned so the composite
 * survives its dialog, which closes as soon as the store accepts the promote;
 * the main workspace's own removal line carries it step by step, and its removal
 * step shows in the manager's row like any other.
 *
 * The generic removal toast and the listener stack stay out of this path: they
 * are the delete dialog's contract, and promote ends on its own composite toast.
 */
async function runPromote(
  mainPath: string,
  worktreePath: string,
  branch: string,
  willStash: boolean,
) {
  // Track how far the composite got. Once the worktree is removed we're past
  // the point of no return: a later failure needs recovery guidance (the
  // folder is gone, the branch is free but unchecked-out), not git's raw error.
  let removed = false;
  let stashed = false;
  // The key the removal entry was marked under, or null once it has settled.
  let markedKey: string | null = null;
  // The cross-process promote window this run holds, closed in `finally`.
  let windowToken: string | null = null;
  try {
    // Verify the main workspace is reachable BEFORE any mutation: a
    // moved/unmounted main path would otherwise let the app stay on the
    // worktree while we go on to delete it. Throwing here aborts cleanly.
    const info = await validateRepo(mainPath);
    // Before the first mutation, so a refusal (another promote, or an MCP
    // branch change still running) also aborts cleanly.
    windowToken = await beginPromoteWindow(mainPath, branch);
    // The spelling every consumer keys by (see `byRepo`), including the
    // invalidations below, which have to hit the mounted query keys. The git
    // calls keep taking `mainPath`; either spelling works for git.
    const activeKey = info.root;
    // Move the app onto the main workspace — we're about to delete this
    // worktree's folder, and nothing should keep reading git status inside it.
    // There's no fs-watcher (status is polled), so switching away stops future
    // polls; `removeWorktreeFreeingBranch` retries once for any last in-flight
    // poll that hasn't drained (openRepo's switch can apply after it returns).
    // Land the main workspace fully drawn: hold the switch on its shell warm-up
    // (within the 250 ms budget), the same hold every other repo switch takes.
    // Its supersession verdict is ignored: the app must leave this folder.
    await claimWarmRepoShell(info.root)?.settled;
    useUiStore.getState().openRepo(info, { bypassLeaveGuard: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Main is the active repo now, so the removal is visible where the user is.
    // A promote is checking this branch out, not putting it away, so it never
    // archives; the branch doubles as the display name (a promote has one).
    markRemoval({
      repoPath: activeKey,
      path: worktreePath,
      name: branch,
      branch,
      archiveWhenDone: false,
      promotePhase: "removing",
    });
    markedKey = activeKey;
    // Free the branch: remove the worktree but KEEP the branch (null) — we
    // check it out in main next. force=false: the clean-tree guard already ran.
    await removeWorktreeFreeingBranch(mainPath, worktreePath, null);
    removed = true;
    // The removal can run for minutes; restart the window's expiry so the
    // stash and checkout legs still hold MCP branch changes off.
    if (windowToken)
      await touchPromoteWindow(windowToken).catch(() => undefined);
    await pruneWorktrees(mainPath).catch(() => undefined);
    // The removed row leaves the manager's list now; the entry stays on, so the
    // line can go on reporting the tail.
    invalidateAfterRemoval(activeKey);
    advancePromotePhase(
      activeKey,
      worktreePath,
      willStash ? "stashing" : "checking-out",
    );
    // The branch's working tree is free now; stash main's own WIP (if any) so
    // the checkout can't be blocked, then land main on the promoted branch.
    if (willStash) {
      // A new stash buries a recorded reapply backup, so its offer can only refuse.
      useStashReapplyMarker.getState().clearFor(activeKey);
      await gitStashAll(mainPath);
      stashed = true;
      advancePromotePhase(activeKey, worktreePath, "checking-out");
    }
    await gitCheckoutBranch(mainPath, branch);
    settleRemoval(activeKey, worktreePath);
    markedKey = null;
    await invalidateRepoAfterWrite(queryClient, activeKey);
    toast.success(
      willStash
        ? `Promoted ${branch} — your main workspace changes were stashed; Pop latest stash brings them back`
        : `Promoted ${branch} to your main workspace`,
    );
  } catch (e) {
    // Never leave the removal line spinning over a step that has stopped.
    if (markedKey) settleRemoval(markedKey, worktreePath);
    if (removed) {
      // The worktree is already gone and the branch is free but not checked
      // out — surface the recovery path (with git's error as the detail). Which
      // path depends on the step: a promote that wanted a stash and never got
      // one stopped there, and the changes it left in place are exactly what
      // would block "check it out yourself".
      const stashedClause = stashed
        ? " Your changes are stashed — use Pop latest stash."
        : "";
      const message =
        willStash && !stashed
          ? `Removed the worktree, but couldn't stash your main workspace changes — commit or stash them, then check out ${branch} manually.`
          : `Removed the worktree, but couldn't check out ${branch} in your main workspace — switch to it there manually.${stashedClause}`;
      toastComposedError({
        title: message,
        errors: [e],
        description: presentError(e).summary,
      });
    } else {
      toastError(e);
    }
  } finally {
    // Same expressions `startPromote` claimed under, or a latch never releases.
    promotingMains.delete(normPath(mainPath));
    promotingWorktrees.delete(normPath(worktreePath));
    // Best-effort: a close that fails leaves a marker its age gate expires.
    if (windowToken) await endPromoteWindow(windowToken).catch(() => undefined);
  }
}

export type CleanupRemovalOutcome =
  | {
      ok: true;
      /** `keptInUse`: the removal succeeded, and the branch stayed unarchived
       *  because it had been checked out again by the time the archive step
       *  ran. */
      branch:
        | "archived"
        | "deleted"
        | "keptMoved"
        | "keptUnreadable"
        | "keptInUse";
    }
  | { ok: false; reason: string };

// Clean up branches' row reasons read after "Couldn't archive: " / "Couldn't
// delete: ", so each is a lowercase phrase with no period. "Already" stays the
// starters' word for a duplicate attempt and never appears here.
const CLEANUP_REMOVING_REASON = "the worktree is being removed";
const CLEANUP_PROMOTING_REASON = "the worktree is being promoted";
const CLEANUP_UPDATE_ON_BRANCH_REASON = "an update is running on this branch";
const CLEANUP_UPDATE_IN_WORKTREE_REASON =
  "an update is running in this worktree";
const CLEANUP_MERGE_ON_BRANCH_REASON = "a merge is running into this branch";
const CLEANUP_MERGE_IN_WORKTREE_REASON =
  "a merge started from this worktree is running";
const CLEANUP_LOCKED_REASON = "the worktree is locked";
const CLEANUP_DIRTY_REASON = "the worktree has uncommitted changes";
const CLEANUP_DEFAULT_BRANCH_REASON =
  "the worktree was removed first (it is the default branch)";
const CLEANUP_WORKTREE_GONE_REASON = "the worktree was moved or removed";
const CLEANUP_BRANCH_CHANGED_REASON =
  "the worktree no longer has this branch checked out";
const CLEANUP_LIST_UNREADABLE_REASON = "the worktree list was unreadable";
const CLEANUP_OP_IN_PROGRESS_REASON: Record<RepoOp, string> = {
  merge: "the worktree is in the middle of a merge",
  rebase: "the worktree is in the middle of a rebase",
  "cherry-pick": "the worktree is in the middle of a cherry-pick",
  revert: "the worktree is in the middle of a revert",
};
/** Which in-progress flag names the refusal when several are set: outermost
 *  first, since a rebase can stop inside a merge or cherry-pick of its own. */
const OP_IN_PROGRESS_ORDER: [
  "rebasing" | "merging" | "cherryPicking" | "reverting",
  RepoOp,
][] = [
  ["rebasing", "rebase"],
  ["merging", "merge"],
  ["cherryPicking", "cherry-pick"],
  ["reverting", "revert"],
];

/** Why the worktree at `path` no longer matches the `branch` row the user
 *  confirmed, or null: re-read at fire time, since a batch reaches its later
 *  rows minutes after the list they were drawn from. Refuses when the path is
 *  gone from a fresh worktree list, holds another branch or a detached HEAD,
 *  or the list can't be read (fail SAFE: git's unforced remove takes ignored
 *  files, and a detached HEAD's commits, with it), and when a merge, rebase,
 *  cherry-pick or revert is in progress there (an unreadable op state refuses
 *  too). Direct IPC reads, not `fetchQuery`: that joins a fetch already in
 *  flight, whose answer can predate this call. Out of reach: a bisect (op_state
 *  doesn't report it), op_state's quiet answer for an unresolvable git dir, and
 *  anything that changes between these reads and the removal. */
async function fireTimeWorktreeRefusal(
  repoPath: string,
  path: string,
  branch: string,
): Promise<string | null> {
  let worktrees: UserWorktree[];
  try {
    worktrees = await listUserWorktrees(repoPath);
  } catch {
    return CLEANUP_LIST_UNREADABLE_REASON;
  }
  const target = normPath(path);
  const entry = worktrees.find((w) => normPath(w.path) === target);
  if (!entry) return CLEANUP_WORKTREE_GONE_REASON;
  if (entry.isDetached || entry.branch !== branch)
    return CLEANUP_BRANCH_CHANGED_REASON;
  let op: RepoOpState;
  try {
    op = await gitOpState(path);
  } catch (e) {
    return reasonFromError(e);
  }
  const busy = OP_IN_PROGRESS_ORDER.find(([flag]) => op[flag]);
  return busy ? CLEANUP_OP_IN_PROGRESS_REASON[busy[1]] : null;
}

/** The local-PR writes that move a branch inside the worktree holding it:
 *  "Update from…" merges into its head there, a conflict-resolving update's
 *  start (clean) or finish fast-forwards its head there, and a local-PR merge
 *  (or its finish) fast-forwards its base there. Discarding an update moves no
 *  branch, so it has no entry. */
const HOLDER_WRITES: Partial<
  Record<
    LocalPrWriteKind,
    { moves: "head" | "base"; onBranch: string; inWorktree: string }
  >
> = {
  "update-from": {
    moves: "head",
    onBranch: CLEANUP_UPDATE_ON_BRANCH_REASON,
    inWorktree: CLEANUP_UPDATE_IN_WORKTREE_REASON,
  },
  "update-resolve": {
    moves: "head",
    onBranch: CLEANUP_UPDATE_ON_BRANCH_REASON,
    inWorktree: CLEANUP_UPDATE_IN_WORKTREE_REASON,
  },
  "finish-update": {
    moves: "head",
    onBranch: CLEANUP_UPDATE_ON_BRANCH_REASON,
    inWorktree: CLEANUP_UPDATE_IN_WORKTREE_REASON,
  },
  merge: {
    moves: "base",
    onBranch: CLEANUP_MERGE_ON_BRANCH_REASON,
    inWorktree: CLEANUP_MERGE_IN_WORKTREE_REASON,
  },
  "finish-merge": {
    moves: "base",
    onBranch: CLEANUP_MERGE_ON_BRANCH_REASON,
    inWorktree: CLEANUP_MERGE_IN_WORKTREE_REASON,
  },
};

/** Why a pending local-PR write refuses removing the worktree at `path` that
 *  holds `branch`, or null. The branch arm matches under ANY key repo: a write
 *  started while the app views another worktree of the repo keys to that
 *  viewer's path, yet moves the branch inside the holder; it wins over a holder
 *  hit on any other write. The holder arm catches a write started from inside
 *  this worktree, whichever branch it moves. A same-named branch in an
 *  unrelated repo also refuses, the safe direction. */
function pendingHolderWriteRefusal(
  queryClient: QueryClient,
  branch: string,
  path: string,
): string | null {
  const target = normPath(path);
  const pending = queryClient.getMutationCache().findAll({
    mutationKey: LOCAL_PR_WRITES_KEY,
    status: "pending",
  });
  let inWorktree: string | null = null;
  for (const m of pending) {
    // `localPrWriteKey` lays the key out as [prefix, kind, repo]: element 2 is
    // the repo the write was started against.
    const [, kind, keyRepo] = m.options.mutationKey ?? [];
    if (typeof kind !== "string" || !Object.hasOwn(HOLDER_WRITES, kind))
      continue;
    const write = HOLDER_WRITES[kind as LocalPrWriteKind];
    if (!write) continue;
    if (
      readPendingLocalPrWrite(kind, m.state.variables)[write.moves] === branch
    )
      return write.onBranch;
    if (
      inWorktree === null &&
      typeof keyRepo === "string" &&
      normPath(keyRepo) === target
    )
      inWorktree = write.inWorktree;
  }
  return inWorktree;
}

/** An error's summary as a row reason, which reads after "Couldn't …: ": one
 *  trailing period dropped, the text otherwise as presentError gives it. */
function reasonFromError(e: unknown): string {
  return presentError(e).summary.replace(/\.$/, "");
}

/** A Clean up branches row's reason for a removal git refused or that failed.
 *  Without force git refuses a locked or dirty worktree. Locked is matched on
 *  git's own refusal ("cannot remove a locked working tree", git 2.51), and
 *  first, since git echoes the lock's free-text reason after it. */
function cleanupRemovalFailure(e: unknown, path: string): string {
  const msg = removalErrorText(e, path);
  if (/cannot remove a locked working tree/i.test(msg))
    return CLEANUP_LOCKED_REASON;
  if (/modified|untracked/i.test(msg)) return CLEANUP_DIRTY_REASON;
  return reasonFromError(e);
}

/**
 * Removes a linked worktree for Clean up branches (never forced), then archives
 * or deletes its branch, resolving when this row is done. The removal store is
 * marked for the duration, so every surface gating on a removal sees it.
 * Refuses with `{ ok: false }`, starting nothing, when at call time the path is
 * already being removed or promoted, or a local-PR write is moving the branch
 * inside the worktree that holds it, or any such write was started from this
 * worktree (both read from the mutation cache, as refuseWhilePushRuns reads
 * it). Once marked, it also refuses, removing nothing, when the worktree no
 * longer matches the confirmed row ({@link fireTimeWorktreeRefusal}) or such a
 * write started during that re-read. The archive step leaves a branch checked
 * out again by then unarchived (`keptInUse`). Reports only through its result:
 * no toast, and nothing to another removal listener.
 */
export async function removeWorktreeForCleanup(
  queryClient: QueryClient,
  args: {
    repoPath: string;
    path: string;
    name: string;
    branch: string;
    then: "archive" | "delete";
  },
): Promise<CleanupRemovalOutcome> {
  const { repoPath, path, name, branch, then } = args;
  // The same two admission reads `startRemoval` refuses on.
  if (isRemovalInFlight(useWorktreeRemovalStore.getState().byRepo, path))
    return { ok: false, reason: CLEANUP_REMOVING_REASON };
  if (promotingWorktrees.has(normPath(path)))
    return { ok: false, reason: CLEANUP_PROMOTING_REASON };
  const writeRefusal = pendingHolderWriteRefusal(queryClient, branch, path);
  if (writeRefusal) return { ok: false, reason: writeRefusal };
  markRemoval({
    repoPath,
    path,
    name,
    branch,
    archiveWhenDone: then === "archive",
  });

  let removal: WorktreeRemoveOutcome;
  try {
    // The first await: every admission read and the mark above ran before it,
    // so a second call for this path in the same tick refuses off the mark.
    const changed = await fireTimeWorktreeRefusal(repoPath, path, branch);
    if (changed) return { ok: false, reason: changed };
    // Again after the awaits: a write started during them moves the branch too.
    const lateWrite = pendingHolderWriteRefusal(queryClient, branch, path);
    if (lateWrite) return { ok: false, reason: lateWrite };
    // Archive keeps the branch through the removal (null) and archives it after.
    removal = await removeWorktreeFreeingBranch(
      repoPath,
      path,
      then === "delete" ? branch : null,
    );
    // Best-effort cleanup; a clean remove already drops its own admin entry.
    await pruneWorktrees(repoPath).catch(() => undefined);
  } catch (e) {
    return { ok: false, reason: cleanupRemovalFailure(e, path) };
  } finally {
    // Settled before the branch step, so a failed archive can't strand the mark.
    settleRemoval(repoPath, path);
  }

  if (then === "archive") {
    const archived = await archiveBranchAfterRemoval(repoPath, branch);
    switch (archived.kind) {
      // Already archived is this row's end state too: the set is idempotent.
      case "archived":
      case "alreadyArchived":
        return { ok: true, branch: "archived" };
      case "isDefault":
        return { ok: false, reason: CLEANUP_DEFAULT_BRANCH_REASON };
      case "inUse":
        return { ok: true, branch: "keptInUse" };
      case "failed":
        return {
          ok: false,
          reason: `the worktree was removed first (${reasonFromError(archived.error)})`,
        };
      default: {
        const exhaustive: never = archived;
        return exhaustive;
      }
    }
  }
  switch (removal.branchCleanup) {
    // notRequested with a branch passed: the ref was already gone, at the tip
    // pin or when the delete re-read it, which is this row's end state.
    case "deleted":
    case "notRequested":
      return { ok: true, branch: "deleted" };
    case "sparedMoved":
      return { ok: true, branch: "keptMoved" };
    case "sparedUnreadable":
      return { ok: true, branch: "keptUnreadable" };
  }
}

/** The removals in flight for one repo, oldest first. */
export function useWorktreeRemovals(repoPath: string): WorktreeRemoval[] {
  const entries = useWorktreeRemovalStore((s) => s.byRepo[repoPath]);
  if (!entries) return NO_REMOVALS;
  return Object.values(entries).sort((a, b) => a.startedAt - b.startedAt);
}

/** True while this exact worktree is being removed. */
export function useIsRemovingWorktree(
  repoPath: string,
  path: string | undefined,
): boolean {
  return useWorktreeRemovalStore((s) =>
    Boolean(path && s.byRepo[repoPath]?.[path]),
  );
}
