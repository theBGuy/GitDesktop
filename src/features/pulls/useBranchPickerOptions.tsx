import { ArchiveIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { type ReactNode, useMemo } from "react";
import { rowCheckoutCopy } from "@/features/repository/checkout-copy";
import { normPath } from "@/lib/git/path";
import { useBranches, useUserWorktrees } from "@/lib/git/queries";

export interface BranchPickerOptions {
  /** Selectable branch names in git order; session + archived branches excluded
   *  (archived ones in `keep` are retained). */
  names: string[];
  /** value → label map for the select controls (`field.SelectField` and the
   *  form-agnostic `SelectControl`). */
  items: Record<string, string>;
  /** value → trailing status chips; only branches with a chip appear here. */
  annotations: Record<string, ReactNode>;
}

/**
 * Branch options for the PR branch pickers — create's head/base pair and the
 * edit dialog's base picker: the filtered name list, the value→label map, and
 * per-branch status chips (checked out in another worktree or the main
 * workspace) rendered after each option.
 *
 * Agent-session branches (`gd/session/*`) are always excluded — they're
 * app-internal and submitting one would push it — and **archived** branches are
 * hidden too, matching the BranchSwitcher (they were archived to get them out of
 * the way). Names passed in `keep` — the picker's seeded defaults, e.g. the
 * current or default branch — are retained even when archived, so a default
 * value stays selectable. `enabled` gates the worktree fetch to while the dialog
 * is open.
 */
export function useBranchPickerOptions(
  repoPath: string,
  enabled: boolean,
  keep?: (string | null | undefined)[],
): BranchPickerOptions {
  const branches = useBranches(repoPath);
  const worktrees = useUserWorktrees(repoPath, enabled);
  const activeNorm = normPath(repoPath);

  // Branches checked out in *another* checkout → that checkout. Git forbids a
  // branch in two worktrees, so this is informational in the picker; the active
  // repo's own checkout is excluded (it's just the current branch). The main
  // workspace stays IN — git counts it as a worktree, and `isMain` names it.
  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, { path: string; isMain: boolean }>();
    for (const w of worktrees.data ?? []) {
      if (w.branch && normPath(w.path) !== activeNorm)
        map.set(w.branch, { path: w.path, isMain: w.isMain });
    }
    return map;
  }, [worktrees.data, activeNorm]);

  // A stable primitive key for the keep-set so the memo below doesn't rerun on
  // every render just because the caller passed a fresh array literal.
  const keepKey = (keep ?? []).filter(Boolean).join("\n");

  return useMemo(() => {
    const keepSet = new Set(keepKey ? keepKey.split("\n") : []);
    const list = (branches.data ?? []).filter(
      (b) =>
        !b.name.startsWith("gd/session/") &&
        (!b.archived || keepSet.has(b.name)),
    );
    const names = list.map((b) => b.name);
    const items = Object.fromEntries(names.map((n) => [n, n]));
    const annotations: Record<string, ReactNode> = {};
    for (const b of list) {
      const wt = worktreeByBranch.get(b.name);
      if (!wt && !b.archived) continue;
      // Muted meta chips named through the shared branch-row copy, so a main
      // workspace reads as one; text (not color) carries the meaning, so it
      // survives WCAG AA / color-blindness.
      const copy = rowCheckoutCopy(wt?.isMain);
      annotations[b.name] = (
        <>
          {wt && (
            <span
              className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
              title={copy.blockedTitle(wt.path)}
            >
              <TreeStructureIcon className="size-3" weight="bold" />
              {copy.noun}
            </span>
          )}
          {b.archived && (
            <span className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground">
              <ArchiveIcon className="size-3" weight="bold" />
              archived
            </span>
          )}
        </>
      );
    }
    return { names, items, annotations };
  }, [branches.data, worktreeByBranch, keepKey]);
}
