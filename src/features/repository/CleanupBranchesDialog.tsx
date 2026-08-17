import { CheckIcon, MinusIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { RelativeTime, useRelativeNow } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import * as api from "@/lib/git/api";
import { repoKeys, useBranchDivergence } from "@/lib/git/queries";
import type { Branch } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { errorMessage } from "@/lib/tauri/invoke";
import { cn } from "@/lib/utils";

type Mode = "archive" | "delete";

/** Candidate windows offered for the "no commits in N days" staleness signal. */
const AGE_WINDOWS = [30, 60, 90] as const;
const DAY_MS = 86_400_000;

interface Candidate {
  branch: Branch;
  /** Fully merged into the default branch (0 commits it doesn't have). */
  merged: boolean;
  /** Label of the merged pull request this branch's name maps to ("#123"), or
   *  null. Squash and rebase merges leave no ancestor link, so the PR is the
   *  only evidence they landed. */
  prMerged: string | null;
  /** Whole days since the branch tip's commit. */
  ageDays: number;
  /** Idle beyond the selected age window. */
  old: boolean;
}

const pluralBranches = (n: number) => `${n} branch${n === 1 ? "" : "es"}`;

/**
 * What the dialog is entitled to say about the pull-request half of merged
 * detection: `"unavailable"` — it never ran, so pull requests go unmentioned;
 * `"pending"` — still reading; `"failed"` — the read failed, which is a coverage
 * gap worth naming; `"checked"` — read and complete.
 */
export type PrCheckState = "unavailable" | "pending" | "failed" | "checked";

/**
 * Derives that state from the forge capability and the closed-PR query. It takes
 * `canGh` rather than the query flags alone because a repo whose forge has no
 * pull requests never STARTS the query: its flags are indistinguishable from a
 * finished, empty read, and "we looked and found none" is a claim the app hasn't
 * earned there.
 *
 * `isPending` carries the same weight for a query that HAS started: status-pending
 * means no data yet, which is also how an offline read looks, since react-query's
 * default `networkMode: "online"` PAUSES the fetch rather than failing it
 * (`isFetching` false, `isError` false). Without that arm an offline dialog would
 * claim the pull requests came back clean.
 */
export function prCheckStateFrom(
  canGh: boolean,
  closedPrs: {
    isError: boolean;
    isPending: boolean;
    isFetching: boolean;
    isPlaceholderData: boolean;
  },
): PrCheckState {
  if (!canGh) return "unavailable";
  if (closedPrs.isError) return "failed";
  if (closedPrs.isPending) return "pending";
  // Data in hand, but a background refetch or a previous key's rows: still not an
  // answer about THIS repo's pull requests.
  if (closedPrs.isFetching || closedPrs.isPlaceholderData) return "pending";
  return "checked";
}

/** The empty state's merged clause, per PR-check outcome. It names pull requests
 *  only where they were actually read: a failed read gets its own caveat below,
 *  and a check that never ran says nothing about them either way. */
const EMPTY_MERGED_CLAUSE: Record<PrCheckState, string> = {
  checked:
    ", directly or through a recent pull request, and nothing is idle for ",
  pending:
    ", directly or through a recent pull request, and nothing is idle for ",
  failed: " and nothing is idle for ",
  unavailable: " and nothing is idle for ",
};

/** The one state badge a row can carry, in precedence order. Text carries the
 *  meaning — the color never stands alone. */
function RowBadge({
  error,
  merged,
  prMerged,
}: {
  error: string | undefined;
  merged: boolean;
  prMerged: string | null;
}) {
  if (error)
    return (
      <span className="text-destructive" title={error}>
        failed
      </span>
    );
  if (merged) return <span className="text-merged">merged</span>;
  if (prMerged)
    return (
      <span
        className="text-merged"
        title={`Merged via pull request ${prMerged} — matched by branch name`}
      >
        merged {prMerged}
      </span>
    );
  return null;
}

/**
 * Bulk "clean up branches" dialog, launched from the branch switcher. Gathers
 * local branches that are stale — **merged into the default branch** or **idle
 * past the selected age window** — and lets the user Archive (reversible hide via
 * the `gitdesktopArchived` flag) or Delete (`git branch -D`) the selected set in
 * one pass. The current branch, the default branch, and `gd/session/*` branches
 * are never candidates; Delete additionally excludes rule-protected branches.
 *
 * Merged detection has two sources: branch divergence (`ahead === 0`, no extra
 * backend) and the switcher's PR map, which catches the squash and rebase merges
 * divergence can't see. The PR side matches by branch NAME only, so it badges a
 * row but never pre-selects it for deletion.
 */
export function CleanupBranchesDialog({
  repoPath,
  open,
  onClose,
  branches,
  defaultBranch,
  currentBranch,
  isProtected,
  isInWorktree,
  prMergedByBranch,
  prCheckState,
}: {
  repoPath: string;
  open: boolean;
  onClose: () => void;
  branches: Branch[];
  defaultBranch: string | null;
  currentBranch: string | null;
  /** True when a branch is blocked from deletion by an effective branch rule. */
  isProtected: (name: string) => boolean;
  /** True when a branch is checked out in another worktree — git can't delete it,
   *  so it's dropped from the delete candidates (it can still be archived). */
  isInWorktree: (name: string) => boolean;
  /** Branch name → the label of the merged pull request it maps to ("#123").
   *  Name-keyed and limited to the PRs the app has fetched, so it labels rows,
   *  never selects them. */
  prMergedByBranch: Map<string, string>;
  /** How far the pull-request half of merged detection got. Every line that
   *  mentions pull requests renders off this: a read that failed says so, and
   *  one that never ran leaves them out rather than passing for a clean check. */
  prCheckState: PrCheckState;
}) {
  const queryClient = useQueryClient();
  // Shared 30s clock: the idle-past-the-window classification below must
  // re-evaluate as time passes, and a render-position `Date.now()` is invisible
  // to the React Compiler, so a branch crossing the window never becomes stale.
  const now = useRelativeNow();
  const [mode, setMode] = useState<Mode>("archive");
  const [windowDays, setWindowDays] = useState<number>(60);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeName, setActiveName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Batch progress + per-branch failures (kept visible so a partial run is honest).
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [failed, setFailed] = useState<Map<string, string>>(new Map());
  const running = progress !== null;

  // Merged-into-default comes straight from divergence: a branch with 0 commits
  // the default branch lacks is fully contained in it. Fetched only while open.
  const divergence = useBranchDivergence(repoPath, defaultBranch, open);
  const mergedSet = useMemo(
    () =>
      new Set(
        (divergence.data ?? [])
          // ahead 0 = no commits the default branch lacks, AND behind > 0 = the
          // default has since moved past it. Requiring behind > 0 keeps a
          // brand-new branch still sitting on the default tip (ahead 0, behind 0)
          // from being mislabeled "merged".
          .filter((d) => d.ahead === 0 && d.behind > 0)
          .map((d) => d.name),
      ),
    [divergence.data],
  );

  // Branches eligible for cleanup, before the per-mode exclusions. Never the
  // current or default branch, never the app-internal session branches.
  const stale = useMemo(() => {
    const out: Candidate[] = [];
    for (const b of branches) {
      if (
        b.isCurrent ||
        b.name === currentBranch ||
        b.name === defaultBranch ||
        b.name.startsWith("gd/session/")
      )
        continue;
      const ts = Date.parse(b.lastCommitDate);
      const ageDays = Number.isFinite(ts) ? Math.floor((now - ts) / DAY_MS) : 0;
      const merged = mergedSet.has(b.name);
      const prMerged = prMergedByBranch.get(b.name) ?? null;
      const old = ageDays >= windowDays;
      if (merged || old || prMerged)
        out.push({ branch: b, merged, prMerged, ageDays, old });
    }
    return out;
  }, [
    branches,
    currentBranch,
    defaultBranch,
    mergedSet,
    now,
    prMergedByBranch,
    windowDays,
  ]);

  // Mode-specific candidates. Archive hides — already-archived branches are a
  // no-op, so drop them. Delete is permanent — drop rule-protected branches
  // (they'd fail anyway), but keep archived ones (a final sweep may want them).
  const candidates = useMemo(() => {
    const list =
      mode === "archive"
        ? stale.filter((c) => !c.branch.archived)
        : stale.filter(
            (c) => !isProtected(c.branch.name) && !isInWorktree(c.branch.name),
          );
    // Merged first (the safest to clean), then oldest first.
    return list.sort((a, b) => {
      if (a.merged !== b.merged) return a.merged ? -1 : 1;
      return b.ageDays - a.ageDays;
    });
  }, [stale, mode, isProtected, isInWorktree]);

  // Re-check every candidate whenever the set itself changes — opening, switching
  // mode, adjusting the window, or divergence resolving to reveal merged branches.
  const candidateNames = useMemo(
    () => candidates.map((c) => c.branch.name),
    [candidates],
  );
  // Pre-checked rows: the ones this repo's own history proves are done with.
  // A row that only a pull request calls merged is matched by branch NAME, which
  // can't confirm the tip is what that PR merged, so it stays unchecked until the
  // user says otherwise.
  const autoSelectNames = useMemo(
    () => candidates.filter((c) => c.merged || c.old).map((c) => c.branch.name),
    [candidates],
  );
  // Re-seed the selection only when the SET of pre-checked names actually changes,
  // keyed on their joined value rather than the array identity. A parent
  // re-render that yields an equal-but-new `candidates` array — a fresh
  // `isProtected` closure, a no-op branch refetch — would otherwise re-run this
  // and silently wipe the user's deselections. Branch names can't contain
  // newlines (git ref rules), so the join is unambiguous — and it joins a SORTED
  // copy, because the render order shifts as ages tick on the shared 30s clock
  // and a pure reorder must not read as a new set.
  const autoSelectKey = [...autoSelectNames].sort().join("\n");
  useEffect(() => {
    if (running) return; // don't clobber a batch mid-flight
    setSelected(new Set(autoSelectKey ? autoSelectKey.split("\n") : []));
    setActiveName(null);
  }, [autoSelectKey, running]);

  // First load: a merged signal still in flight and nothing has surfaced yet.
  // Age-based candidates already show instantly (branch data is cached), so this
  // only gates the truly-empty first paint.
  const checkingMerged =
    (Boolean(defaultBranch) && divergence.isLoading) ||
    prCheckState === "pending";

  const selectedCount = candidateNames.filter((n) => selected.has(n)).length;
  const allChecked =
    candidates.length > 0 && selectedCount === candidates.length;
  const someChecked = selectedCount > 0;

  function toggle(name: string) {
    if (running) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleAll() {
    if (running) return;
    setSelected(allChecked ? new Set() : new Set(candidateNames));
  }

  // Switching mode or window opens a fresh context, so drop any per-branch
  // failures left from a previous batch — otherwise a "failed" badge from a
  // delete attempt would bleed onto the same branch in archive mode. Done in the
  // handlers (not an effect) so the post-batch refetch keeps the just-failed rows
  // flagged.
  function changeMode(next: Mode) {
    if (running) return;
    setMode(next);
    setFailed(new Map());
  }

  function changeWindow(next: number) {
    if (running) return;
    setWindowDays(next);
    setFailed(new Map());
  }

  const activeIndex = candidates.findIndex((c) => c.branch.name === activeName);
  const onKeyDown = listKeyboardNav({
    items: candidates,
    activeIndex,
    onActivate: (c) => setActiveName(c.branch.name),
    rowKey: (c) => c.branch.name,
  });

  async function runBatch() {
    const names = candidateNames.filter((n) => selected.has(n));
    if (names.length === 0) return;
    const fails = new Map<string, string>();
    setFailed(new Map());
    setProgress({ done: 0, total: names.length });
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      try {
        if (mode === "archive") {
          await api.gitSetBranchArchived(repoPath, name, true);
        } else {
          await api.gitDeleteBranch(repoPath, name);
        }
      } catch (e) {
        fails.set(name, errorMessage(e));
      }
      setProgress({ done: i + 1, total: names.length });
    }
    // One reconciliation for the whole batch (branch mutations aren't optimistic
    // here) — refreshes the switcher list, divergence, and archived section.
    await queryClient.invalidateQueries({
      queryKey: repoKeys.branches(repoPath),
    });
    await queryClient.invalidateQueries({
      queryKey: ["repo", repoPath, "divergence"],
    });
    setProgress(null);

    const ok = names.length - fails.size;
    const verb = mode === "archive" ? "Archived" : "Deleted";
    if (fails.size === 0) {
      toast.success(`${verb} ${pluralBranches(ok)}`);
      onClose();
      return;
    }
    setFailed(fails);
    // The successful ones drop out of the candidate list on refetch, leaving the
    // failures on screen with their reason; the user can retry them.
    toast.error(`${verb} ${ok}, ${fails.size} failed`);
  }

  function onPrimary() {
    if (mode === "delete") setConfirmDelete(true);
    else void runBatch();
  }

  const verb = mode === "archive" ? "Archive" : "Delete";
  const gerund = mode === "archive" ? "Archiving" : "Deleting";
  const primaryLabel = running
    ? `${gerund}… ${progress?.done ?? 0}/${progress?.total ?? 0}`
    : `${verb} ${pluralBranches(selectedCount)}`;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !running) onClose();
        }}
      >
        <DialogContent className="flex flex-col gap-4 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Clean up branches</DialogTitle>
            <DialogDescription>
              Local branches already merged into{" "}
              <span className="font-mono">
                {defaultBranch ?? "the default branch"}
              </span>
              {prCheckState === "unavailable"
                ? ", or with no commits in a while. "
                : " — directly or through a recent pull request — or with no commits in a while. "}
              {mode === "archive"
                ? "Archiving hides them from the switcher — unarchive anytime."
                : "Deleting removes them permanently, including commits only on them."}
            </DialogDescription>
          </DialogHeader>

          {/* Mode + age controls */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              className="inline-flex rounded-none ring-1 ring-border"
              role="group"
              aria-label="Cleanup action"
            >
              {(["archive", "delete"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={running}
                  aria-pressed={mode === m}
                  onClick={() => changeMode(m)}
                  className={cn(
                    "px-3 py-1 text-xs capitalize transition-colors first:border-r first:border-border disabled:opacity-50",
                    mode === m
                      ? m === "delete"
                        ? "bg-destructive text-white"
                        : "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Idle for</span>
              <div
                className="inline-flex rounded-none ring-1 ring-border"
                role="group"
                aria-label="Inactivity window in days"
              >
                {AGE_WINDOWS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    disabled={running}
                    aria-pressed={windowDays === d}
                    onClick={() => changeWindow(d)}
                    className={cn(
                      "px-2 py-1 tabular-nums transition-colors not-last:border-r not-last:border-border disabled:opacity-50",
                      windowDays === d
                        ? "bg-primary text-primary-foreground"
                        : "hover:text-foreground",
                    )}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <span>days</span>
            </div>
          </div>

          {/* Select-all header — a tri-state indicator (the vendored Checkbox
              has no indeterminate visual, and components/ui/ is off-limits). */}
          {candidates.length > 0 && (
            <button
              type="button"
              disabled={running}
              onClick={toggleAll}
              aria-label={allChecked ? "Deselect all" : "Select all"}
              className="flex items-center gap-2 text-xs text-muted-foreground disabled:opacity-50"
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-none border border-input",
                  (allChecked || someChecked) &&
                    "border-primary bg-primary text-primary-foreground",
                )}
              >
                {allChecked ? (
                  <CheckIcon className="size-3.5" />
                ) : someChecked ? (
                  <MinusIcon className="size-3.5" />
                ) : null}
              </span>
              <span>
                {selectedCount} of {candidates.length} selected
              </span>
            </button>
          )}

          {/* List / skeleton / empty */}
          {checkingMerged && candidates.length === 0 ? (
            <div className="space-y-1 py-2" aria-busy>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-7 animate-pulse rounded-none bg-muted/50"
                />
              ))}
            </div>
          ) : candidates.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No stale branches — nothing is merged into{" "}
              <span className="font-mono">
                {defaultBranch ?? "the default branch"}
              </span>
              {EMPTY_MERGED_CLAUSE[prCheckState]}
              {windowDays} days. Try a shorter window.
              {prCheckState === "failed"
                ? " Pull requests couldn't be checked, so a branch merged through one may be missing here."
                : null}
            </p>
          ) : (
            <div
              className="-mx-1 max-h-[45vh] space-y-0.5 overflow-x-hidden overflow-y-auto px-1"
              onKeyDown={onKeyDown}
            >
              {checkingMerged && (
                <p className="px-1 py-1 text-[11px] text-muted-foreground">
                  Checking which branches are merged…
                </p>
              )}
              {prCheckState === "failed" && (
                <p className="px-1 py-1 text-[11px] text-muted-foreground">
                  Pull requests couldn't be checked — a branch merged through
                  one may be missing.
                </p>
              )}
              {candidates.map((c, idx) => {
                const name = c.branch.name;
                const checked = selected.has(name);
                const err = failed.get(name);
                const rovingTab =
                  idx === (activeIndex === -1 ? 0 : activeIndex) ? 0 : -1;
                return (
                  <label
                    key={name}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-none px-1.5 py-1.5 text-xs transition-colors hover:bg-accent",
                      activeName === name && "bg-accent",
                    )}
                  >
                    <Checkbox
                      data-row={name}
                      tabIndex={rovingTab}
                      checked={checked}
                      disabled={running}
                      onCheckedChange={() => toggle(name)}
                      onFocus={() => setActiveName(name)}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {name}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <RowBadge
                        error={err}
                        merged={c.merged}
                        prMerged={c.prMerged}
                      />
                      <span className="tabular-nums text-muted-foreground">
                        <RelativeTime date={c.branch.lastCommitDate} />
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={running}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={mode === "delete" ? "destructive" : "default"}
              disabled={selectedCount === 0 || running}
              onClick={onPrimary}
            >
              {primaryLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        title="Delete branches?"
        body={
          <>
            Permanently deletes {pluralBranches(selectedCount)}, including
            commits that exist only on them. This can't be undone.
          </>
        }
        confirmLabel={`Delete ${pluralBranches(selectedCount)}`}
        confirmVariant="destructive"
        onConfirm={() => {
          setConfirmDelete(false);
          void runBatch();
        }}
      />
    </>
  );
}
