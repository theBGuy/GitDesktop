import { ArchiveIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { type ReactNode, useMemo } from "react";
import { useBranches, useUserWorktrees } from "@/lib/git/queries";

/** Lower-cased, forward-slashed path for cross-source comparison — git emits
 *  "/", the app stores "\" on Windows (mirrors BranchSwitcher's helper). */
const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();

export interface BranchPickerOptions {
  /** Selectable branch names in git order; session + archived branches excluded
   *  (archived ones in `keep` are retained). */
  names: string[];
  /** value → label map for `field.SelectField`. */
  items: Record<string, string>;
  /** value → trailing status chips; only branches with a chip appear here. */
  annotations: Record<string, ReactNode>;
}

/**
 * Branch options for the PR branch pickers — create's head/base pair and the
 * edit dialog's base picker: the filtered name list, the value→label map, and
 * per-branch status chips (checked out in another worktree) rendered after each
 * option.
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

  // Branches checked out in *another* worktree → that worktree's path. Git
  // forbids a branch in two worktrees, so this is informational in the picker;
  // the active repo's own checkout is excluded (it's just the current branch).
  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of worktrees.data ?? []) {
      if (w.branch && normPath(w.path) !== activeNorm)
        map.set(w.branch, w.path);
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
      const wtPath = worktreeByBranch.get(b.name);
      if (!wtPath && !b.archived) continue;
      // Muted meta chips, matching BranchSwitcher's worktree idiom; text (not
      // color) carries the meaning, so it survives WCAG AA / color-blindness.
      annotations[b.name] = (
        <>
          {wtPath && (
            <span
              className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
              title={`Checked out in another worktree (${wtPath})`}
            >
              <TreeStructureIcon className="size-3" weight="bold" />
              worktree
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
