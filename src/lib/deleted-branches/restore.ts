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
import {
  branchesOptions,
  invalidateRepoAfterWrite,
  repoKeys,
} from "@/lib/git/queries";
import type { Branch } from "@/lib/git/types";
import { landedIn } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { toastErrorWithNote } from "@/lib/toast";
import {
  couldntRestoreTitle,
  DELETED_TOAST_MS,
  NAME_EXISTS_DESCRIPTION,
  prunedDescription,
  RESTORED_ALL_UPSTREAMS,
  restoreActionLabel,
  restoredAllTitle,
  restoredDescription,
  restoredSomeTitle,
  restoredTitle,
  restoreFailedNote,
  UNREADABLE_RECORDED_TIP,
  UNRESTORED_REASON,
  unrecordedNote,
  unrestoredDescription,
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
  | { status: "restored" }
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

const holdsName = async (repoPath: string, name: string) =>
  Object.hasOwn(await gitBranchTips(repoPath, [name]), name);

/** Git work + record removal only; no toast, no cache work. Never rejects. */
export async function restoreDeletedBranch(
  repoPath: string,
  entry: DeletedBranchEntry,
): Promise<RestoreOutcome> {
  // A start point that isn't a full object id could resolve as a ref name.
  if (!FULL_OID_RE.test(entry.tip))
    return { status: "failed", error: new Error(UNREADABLE_RECORDED_TIP) };
  try {
    if (await holdsName(repoPath, entry.name)) return { status: "nameExists" };
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

/** After a create that rejected. Presence is read through the checked branch
 *  list, which rejects when git fails (the tips read answers "absent" then), so
 *  the mark is unset only on a name git confirmed absent. A present name at the
 *  recorded tip is this restore's own create landing despite the rejection. */
async function rollBackFailedCreate(
  repoPath: string,
  entry: DeletedBranchEntry,
  error: unknown,
): Promise<RestoreOutcome> {
  let exists: boolean;
  try {
    const branches = await gitBranches(repoPath);
    exists = branches.some((b) => b.name === entry.name);
  } catch {
    return { status: "failed", error };
  }
  if (!exists) {
    if (entry.keptLocal) {
      try {
        await gitSetBranchKeepLocal(repoPath, entry.name, false);
      } catch {
        // Best-effort: a leftover mark errs toward kept local.
      }
    }
    return { status: "failed", error };
  }
  let tip: string | undefined;
  try {
    tip = (await gitBranchTips(repoPath, [entry.name]))[entry.name];
  } catch {
    tip = undefined;
  }
  if (tip === undefined || tip.toLowerCase() !== entry.tip.toLowerCase())
    return { status: "nameExists" };
  await forgetDeletedBranch(repoPath, entry.id);
  return { status: "restored" };
}

/** The local branch rows, read fresh before a delete: the cached list can predate
 *  a Keep local mark set in another window or with `git config`. Null when the
 *  read fails. */
export async function readBranchRowsFresh(
  queryClient: QueryClient,
  repoPath: string,
): Promise<ReadonlyMap<string, Branch> | null> {
  try {
    const rows = await queryClient.fetchQuery({
      ...branchesOptions(repoPath),
      staleTime: 0,
    });
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
export async function settleRestores(
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

function reportOutcome(
  outcome: RestoreOutcome,
  entry: DeletedBranchEntry,
  away: string,
) {
  switch (outcome.status) {
    case "restored": {
      const description = restoredDescription(entry.keptLocal, entry.upstream);
      toast.success(
        restoredTitle(entry.name, away),
        description === undefined ? undefined : { description },
      );
      return;
    }
    case "nameExists":
      toast.info(couldntRestoreTitle(entry.name, away), {
        description: NAME_EXISTS_DESCRIPTION,
      });
      return;
    case "pruned":
      toast.error(couldntRestoreTitle(entry.name, away), {
        description: prunedDescription(entry.tip),
      });
      return;
    case "failed":
      toastErrorWithNote(outcome.error, restoreFailedNote(entry.name, away));
      return;
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/** restore -> settle (started) -> the outcome toast. Returns the outcome. */
export async function restoreAndReport(
  queryClient: QueryClient,
  repoPath: string,
  entry: DeletedBranchEntry,
): Promise<RestoreOutcome> {
  const outcome = await restoreDeletedBranch(repoPath, entry);
  void settleRestores(queryClient, repoPath);
  reportOutcome(outcome, entry, landedIn(repoPath).away);
  return outcome;
}

/** Sequential restores, one settle, one follow-up toast. */
export async function restoreAllAndReport(
  queryClient: QueryClient,
  repoPath: string,
  entries: readonly DeletedBranchEntry[],
): Promise<void> {
  const unrestored = { nameExists: 0, pruned: 0, failed: 0 };
  let restored = 0;
  let upstreams = false;
  for (const entry of entries) {
    const outcome = await restoreDeletedBranch(repoPath, entry);
    if (outcome.status === "restored") {
      restored++;
      if (entry.upstream !== null) upstreams = true;
    } else {
      unrestored[outcome.status]++;
    }
  }
  void settleRestores(queryClient, repoPath);
  const { away } = landedIn(repoPath);
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
    description: unrestoredDescription(total - restored, reasons),
  });
}

/** sonner options for a delete toast: duration, Restore action, not-recorded
 *  note. `single` marks the branch menu's delete, whose title names the commit. */
export function deletedToastOptions(
  queryClient: QueryClient,
  repoPath: string,
  entries: readonly DeletedBranchEntry[],
  unrecorded: number,
  single = false,
): {
  duration: number;
  description?: string;
  action?: {
    label: string;
    onClick: (e: { currentTarget: HTMLElement }) => void;
  };
} {
  const pinned = [...entries];
  const options = {
    // Unrecorded entries can be restored only from here, so it stays until closed.
    duration: unrecorded > 0 ? Number.POSITIVE_INFINITY : DELETED_TOAST_MS,
    ...(unrecorded > 0 && {
      description: unrecordedNote(unrecorded, pinned.length, single),
    }),
  };
  if (pinned.length === 0) return options;
  return {
    ...options,
    action: {
      label: restoreActionLabel(pinned.length),
      onClick: (e) => {
        // Blurred first so sonner's focus restore runs before anything it opens.
        e.currentTarget.blur();
        if (pinned.length === 1)
          void restoreAndReport(queryClient, repoPath, pinned[0]);
        else void restoreAllAndReport(queryClient, repoPath, pinned);
      },
    },
  };
}
