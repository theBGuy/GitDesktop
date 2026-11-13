import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  gitBranches,
  gitBranchTips,
  gitCreateBranch,
  gitFindCommitsByPrefix,
  gitObjectsPresent,
  gitSetBranchKeepLocal,
} from "@/lib/git/api";
import { FULL_OID_RE } from "@/lib/git/oid";
import { normPath } from "@/lib/git/path";
import { invalidateRepoAfterWrite, repoKeys } from "@/lib/git/queries";
import type { Branch } from "@/lib/git/types";
import { landedIn } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { toastErrorWithNote } from "@/lib/toast";
import {
  couldntRestoreTitle,
  DELETED_TOAST_MS,
  NAME_EXISTS_DESCRIPTION,
  NAME_EXISTS_NOTICE_OPEN,
  prunedDescription,
  RESTORED_ALL_UPSTREAMS,
  restoreActionLabel,
  restoredAllTitle,
  restoredDescription,
  restoredSomeTitle,
  restoredTitle,
  restoreFailedNote,
  restoreFailedNoticeOpenNote,
  UNREADABLE_RECORDED_TIP,
  UNRESTORED_REASON,
  unrecordedNote,
  unrestoredDescription,
  unrestoredNoticeOpenDescription,
} from "./copy";
import {
  DELETED_BRANCHES_KEY,
  type DeletedBranchEntry,
  forgetDeletedBranch,
} from "./store";

// Restores run as plain functions over the api module with the repo they were
// started for, never through mutation hooks: a toast outlives its host, and a
// mutate after a repo switch would build from the live repo's options.

export type TipState = "present" | "pruned" | "unknown";

export type RestoreOutcome =
  /** `alreadyBack`: the name was at the recorded commit before this restore,
   *  so nothing was created and that branch keeps whatever upstream it has. */
  | { status: "restored"; alreadyBack?: true }
  | { status: "nameExists" }
  | { status: "pruned" }
  | { status: "failed"; error: unknown };

/** "pruned" needs both reads to agree: `git_objects_present` answers false on
 *  any failed spawn too, so its false is confirmed by the prefix lookup, and any
 *  failed read is "unknown". Never rejects. */
export async function readTipState(
  repoPath: string,
  tip: string,
): Promise<TipState> {
  try {
    if (await gitObjectsPresent(repoPath, [tip])) return "present";
    const matches = await gitFindCommitsByPrefix(repoPath, tip);
    const want = tip.toLowerCase();
    if (matches.some((m) => m.commit.hash.toLowerCase() === want))
      return "present";
    return matches.length === 0 ? "pruned" : "unknown";
  } catch {
    return "unknown";
  }
}

/** One call for a whole list. Never rejects. */
export async function readTipStates(
  repoPath: string,
  tips: readonly string[],
): Promise<Map<string, TipState>> {
  const distinct = [...new Set(tips)];
  const states = new Map<string, TipState>();
  if (distinct.length === 0) return states;
  try {
    if (await gitObjectsPresent(repoPath, distinct)) {
      for (const tip of distinct) states.set(tip, "present");
      return states;
    }
  } catch {
    // Read per tip below.
  }
  for (const tip of distinct)
    states.set(tip, await readTipState(repoPath, tip));
  return states;
}

/** Whether the entry's name is free, back at its recorded tip, or taken at
 *  another commit. Presence comes from the checked branch list, which rejects
 *  when git fails (the tips read answers "absent" then); a present name whose
 *  tip can't be read counts as taken, which sets no mark and creates nothing. */
async function nameState(
  repoPath: string,
  entry: DeletedBranchEntry,
): Promise<"absent" | "atTip" | "elsewhere"> {
  const branches = await gitBranches(repoPath);
  if (!branches.some((b) => b.name === entry.name)) return "absent";
  let tip: string | undefined;
  try {
    tip = (await gitBranchTips(repoPath, [entry.name]))[entry.name];
  } catch {
    tip = undefined;
  }
  return tip !== undefined && tip.toLowerCase() === entry.tip.toLowerCase()
    ? "atTip"
    : "elsewhere";
}

/** Git work + record removal only; no toast, no cache work. Never rejects. */
export async function restoreDeletedBranch(
  repoPath: string,
  entry: DeletedBranchEntry,
): Promise<RestoreOutcome> {
  // A start point that isn't a full object id could resolve as a ref name.
  if (!FULL_OID_RE.test(entry.tip))
    return { status: "failed", error: new Error(UNREADABLE_RECORDED_TIP) };
  try {
    const state = await nameState(repoPath, entry);
    if (state === "elsewhere") return { status: "nameExists" };
    if (state === "atTip") {
      // Already at the recorded commit (another window's restore, or re-created
      // by hand), and a hand-made one has no mark: set it before forgetting.
      if (entry.keptLocal)
        await gitSetBranchKeepLocal(repoPath, entry.name, true);
      await forgetDeletedBranch(repoPath, entry.id);
      return { status: "restored", alreadyBack: true };
    }
    if ((await readTipState(repoPath, entry.tip)) === "pruned")
      return { status: "pruned" };
    // Marked before the branch exists, so it is never pushable for a moment.
    if (entry.keptLocal)
      await gitSetBranchKeepLocal(repoPath, entry.name, true);
    try {
      await gitCreateBranch(repoPath, entry.name, false, entry.tip, true);
    } catch (error) {
      return rollBackFailedCreate(repoPath, entry, error);
    }
    await forgetDeletedBranch(repoPath, entry.id);
    return { status: "restored" };
  } catch (error) {
    return { status: "failed", error };
  }
}

/** After a create that rejected: the Keep local mark stays, even on a name git
 *  confirms absent, since another restore of the name may have set it for a
 *  create still pending, and a leftover mark errs toward kept local. A present
 *  name at the recorded tip is this restore's own create landing despite the
 *  rejection. */
async function rollBackFailedCreate(
  repoPath: string,
  entry: DeletedBranchEntry,
  error: unknown,
): Promise<RestoreOutcome> {
  let state: Awaited<ReturnType<typeof nameState>>;
  try {
    state = await nameState(repoPath, entry);
  } catch {
    return { status: "failed", error };
  }
  if (state === "absent") return { status: "failed", error };
  if (state === "elsewhere") return { status: "nameExists" };
  await forgetDeletedBranch(repoPath, entry.id);
  return { status: "restored" };
}

/** The local branch rows, read fresh before a delete: the cached list can predate
 *  a Keep local mark set in another window or with `git config`. Read straight
 *  from git, never through the query cache, whose fetch would join a read
 *  already in flight that started before such a mark. Null when the read fails. */
export async function readBranchRowsFresh(
  repoPath: string,
): Promise<ReadonlyMap<string, Branch> | null> {
  try {
    const rows = await gitBranches(repoPath);
    return new Map(rows.map((b) => [b.name, b] as const));
  } catch {
    return null;
  }
}

/** What a delete records for Restore to re-apply. A failed read or a missing
 *  row restores marked Keep local, the safe direction. */
export function deletedBranchFacts(
  rows: ReadonlyMap<string, Branch> | null,
  name: string,
): Pick<DeletedBranchEntry, "keptLocal" | "upstream"> {
  const row = rows?.get(name);
  return {
    keptLocal: row ? row.keepLocal : true,
    upstream: row?.upstream ?? null,
  };
}

/** One cache settle after one or many restores. Resolves once the refetches
 *  land, which a parked or slow forge read can hold indefinitely, so the
 *  reporters below start it and never wait on it before their toast. */
async function settleRestores(
  queryClient: QueryClient,
  repoPath: string,
): Promise<void> {
  const settles = [
    invalidateRepoAfterWrite(queryClient, repoPath),
    queryClient.invalidateQueries({ queryKey: DELETED_BRANCHES_KEY }),
  ];
  // Another checkout of the same repository lists the same branches.
  const live = useUiStore.getState().repoPath;
  if (live !== null && normPath(live) !== normPath(repoPath))
    settles.push(
      queryClient.invalidateQueries({ queryKey: repoKeys.branches(live) }),
    );
  await Promise.all(settles);
}

/** `noticeStays`: an unrecorded entry is still unsettled, so its delete notice
 *  stays open and is the place to retry; Recover lost work doesn't list it. */
function reportOutcome(
  outcome: RestoreOutcome,
  entry: DeletedBranchEntry,
  away: string,
  noticeStays: boolean,
) {
  switch (outcome.status) {
    case "restored": {
      const description = restoredDescription(
        entry.keptLocal,
        outcome.alreadyBack ? null : entry.upstream,
      );
      toast.success(
        restoredTitle(entry.name, away),
        description === undefined ? undefined : { description },
      );
      return;
    }
    case "nameExists":
      toast.info(couldntRestoreTitle(entry.name, away), {
        description: noticeStays
          ? NAME_EXISTS_NOTICE_OPEN
          : NAME_EXISTS_DESCRIPTION,
      });
      return;
    case "pruned":
      toast.error(couldntRestoreTitle(entry.name, away), {
        description: prunedDescription(entry.tip),
      });
      return;
    case "failed":
      toastErrorWithNote(
        outcome.error,
        noticeStays
          ? restoreFailedNoticeOpenNote(entry.name, away)
          : restoreFailedNote(entry.name, away),
      );
      return;
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/** One follow-up toast for several restores; `noticeStays` as above. */
function reportAll(
  outcomes: readonly RestoreOutcome[],
  entries: readonly DeletedBranchEntry[],
  away: string,
  noticeStays: boolean,
) {
  const unrestored = { nameExists: 0, pruned: 0, failed: 0 };
  let restored = 0;
  let upstreams = false;
  outcomes.forEach((outcome, i) => {
    if (outcome.status === "restored") {
      restored++;
      if (entries[i].upstream !== null && !outcome.alreadyBack)
        upstreams = true;
    } else {
      unrestored[outcome.status]++;
    }
  });
  const total = entries.length;
  if (restored === total) {
    toast.success(
      restoredAllTitle(total, away),
      upstreams ? { description: RESTORED_ALL_UPSTREAMS } : undefined,
    );
    return;
  }
  const reasons = (["nameExists", "pruned", "failed"] as const)
    .filter((k) => unrestored[k] > 0)
    .map((k) => UNRESTORED_REASON[k](unrestored[k]))
    .join("; ");
  toast.error(restoredSomeTitle(restored, total, away), {
    duration: DELETED_TOAST_MS,
    description: (noticeStays
      ? unrestoredNoticeOpenDescription
      : unrestoredDescription)(total - restored, reasons),
  });
}

/** Sequential restores, in order. */
async function restoreEach(
  repoPath: string,
  entries: readonly DeletedBranchEntry[],
): Promise<RestoreOutcome[]> {
  const outcomes: RestoreOutcome[] = [];
  for (const entry of entries)
    outcomes.push(await restoreDeletedBranch(repoPath, entry));
  return outcomes;
}

/** restore -> settle (started) -> the outcome toast. Returns the outcome. */
export async function restoreAndReport(
  queryClient: QueryClient,
  repoPath: string,
  entry: DeletedBranchEntry,
): Promise<RestoreOutcome> {
  const outcome = await restoreDeletedBranch(repoPath, entry);
  void settleRestores(queryClient, repoPath);
  reportOutcome(outcome, entry, landedIn(repoPath).away, false);
  return outcome;
}

/** Sequential restores, one settle, one follow-up toast. */
export async function restoreAllAndReport(
  queryClient: QueryClient,
  repoPath: string,
  entries: readonly DeletedBranchEntry[],
): Promise<void> {
  const outcomes = await restoreEach(repoPath, entries);
  void settleRestores(queryClient, repoPath);
  reportAll(outcomes, entries, landedIn(repoPath).away, false);
}

let deletedToastSeq = 0;

/** sonner options for a delete toast: duration, Restore action, not-recorded
 *  note. `single` marks the branch menu's delete, whose title names the commit.
 *  An unrecorded entry has no other home, so its toast stays open (explicit id,
 *  default-prevented action click) until every unrecorded entry is restored or
 *  pruned; a press retries only entries not yet settled, one run at a time. */
export function deletedToastOptions(
  queryClient: QueryClient,
  repoPath: string,
  entries: readonly DeletedBranchEntry[],
  unrecordedIds: ReadonlySet<string>,
  single = false,
): {
  id?: string;
  duration: number;
  description?: string;
  action?: {
    label: string;
    onClick: (e: {
      currentTarget: HTMLElement;
      preventDefault: () => void;
    }) => void;
  };
} {
  const pinned = [...entries];
  const keepsOpen = unrecordedIds.size > 0;
  const id = keepsOpen ? `deleted-branches-${++deletedToastSeq}` : undefined;
  const options = {
    ...(id !== undefined && { id }),
    duration: keepsOpen ? Number.POSITIVE_INFINITY : DELETED_TOAST_MS,
    ...(keepsOpen && {
      description: unrecordedNote(unrecordedIds.size, pinned.length, single),
    }),
  };
  if (pinned.length === 0) return options;
  const label = restoreActionLabel(pinned.length);
  if (id === undefined) {
    // Only the first press acts: sonner keeps the action clickable while the
    // toast animates out.
    let pressed = false;
    return {
      ...options,
      action: {
        label,
        onClick: (e) => {
          // Blurred first so sonner's focus restore runs before anything it opens.
          e.currentTarget.blur();
          if (pressed) return;
          pressed = true;
          if (pinned.length === 1)
            void restoreAndReport(queryClient, repoPath, pinned[0]);
          else void restoreAllAndReport(queryClient, repoPath, pinned);
        },
      },
    };
  }
  const settled = new Set<string>();
  let running = false;
  const run = async () => {
    const todo = pinned.filter((entry) => !settled.has(entry.id));
    const outcomes = await restoreEach(repoPath, todo);
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "restored" || outcome.status === "pruned")
        settled.add(todo[i].id);
    });
    void settleRestores(queryClient, repoPath);
    const stays = [...unrecordedIds].some((u) => !settled.has(u));
    const { away } = landedIn(repoPath);
    if (pinned.length === 1 && todo.length === 1)
      reportOutcome(outcomes[0], todo[0], away, stays);
    else if (todo.length > 0) reportAll(outcomes, todo, away, stays);
    if (!stays) toast.dismiss(id);
  };
  return {
    ...options,
    action: {
      label,
      onClick: (e) => {
        // Keeps sonner from closing the toast on this click.
        e.preventDefault();
        e.currentTarget.blur();
        if (running) return;
        running = true;
        void run().finally(() => {
          running = false;
        });
      },
    },
  };
}
