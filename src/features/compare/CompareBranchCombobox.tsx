import {
  ArrowDownIcon,
  ArrowUpIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import { normPath } from "@/lib/git/path";
import { useBranchDivergence, useUserWorktrees } from "@/lib/git/queries";
import type { Branch, BranchDivergence } from "@/lib/git/types";

/**
 * The Compare tab's base-branch picker: a searchable combobox over the local
 * branches (already filtered by the caller — no current, no `gd/session/*`, no
 * archived). Rows mirror the BranchSwitcher vocabulary (worktree chip,
 * ahead/behind badges, relative date, default tag) MINUS the PR badge and
 * context menu — this is the daily "what am I about to PR" surface.
 *
 * The ahead/behind badges are computed vs `currentName` (the compare base shown
 * in the header "Compare {current} with"), not vs the default branch. Note the
 * frame: a row's badges describe the ROW's branch (↑ = commits it has that
 * `currentName` lacks) — the subject-is-the-row idiom every BranchSwitcher row
 * uses — while the tab's "N ahead / M behind" reads from `currentName`'s side,
 * so the same two numbers swap labels between a row and the selected
 * comparison. The badge tooltip names the direction.
 */
export function CompareBranchCombobox({
  repoPath,
  branches,
  currentName,
  defaultName,
  value,
  onValueChange,
}: {
  repoPath: string;
  /** Already filtered: no current, no gd/session/*, no archived. */
  branches: Branch[];
  /** The compare base; ahead/behind badges are computed vs this branch. */
  currentName: string;
  defaultName: string | null;
  value: string | null;
  onValueChange: (name: string) => void;
}) {
  // Popup state drives the N-per-branch git calls below: divergence + worktrees
  // fetch only while open (mirrors BranchSwitcher's `open`-gated queries).
  const [open, setOpen] = useState(false);

  // Ahead/behind vs the CURRENT branch (the compare base), fetched only while
  // open. Keyed under `currentName` so switching branches re-derives.
  const divergence = useBranchDivergence(repoPath, currentName, open);
  const divByName = useMemo(
    () =>
      new Map((divergence.data ?? []).map((d) => [d.name, d] as const)) as Map<
        string,
        BranchDivergence
      >,
    [divergence.data],
  );

  // Branches checked out in *another* worktree → that worktree's path. Git
  // forbids the same branch in two worktrees; the active repo's own checkout is
  // excluded (that's just the current branch). Fetched only while open.
  const userWorktrees = useUserWorktrees(repoPath, open);
  const activeNorm = normPath(repoPath);
  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of userWorktrees.data ?? []) {
      if (w.branch && normPath(w.path) !== activeNorm)
        map.set(w.branch, w.path);
    }
    return map;
  }, [userWorktrees.data, activeNorm]);

  // Default branch pinned first, then most recently committed. Memoized: the
  // compiler won't hoist the `.sort()` copy, and it would otherwise recompute on
  // every filter keystroke (each re-render).
  const sorted = useMemo(
    () =>
      [...branches].sort((a, b) => {
        if (a.name === defaultName) return -1;
        if (b.name === defaultName) return 1;
        return b.lastCommitDate.localeCompare(a.lastCommitDate);
      }),
    [branches, defaultName],
  );

  // Item values are branch NAME STRINGS (the store holds a string); Base UI's
  // default contains/case-insensitive filter matches those directly, so typing
  // in the input filters the list. The `items` prop drives that filtering: the
  // List's render-function form auto-wraps in a Collection that maps the store's
  // `filteredItems` (a subset of `items`, in order) — static children would
  // bypass filtering entirely, so rows MUST come from the render function.
  const names = useMemo(() => sorted.map((b) => b.name), [sorted]);
  const branchByName = useMemo(
    () => new Map(sorted.map((b) => [b.name, b] as const)),
    [sorted],
  );

  return (
    <Combobox
      items={names}
      value={value}
      // Selecting an item fires this with the branch name and closes the popup.
      onValueChange={(name) => name && onValueChange(name)}
      open={open}
      onOpenChange={setOpen}
    >
      <ComboboxTrigger
        aria-label="Compare with branch"
        className="flex w-full items-center justify-between gap-1.5 rounded-none border border-input bg-transparent py-2 pr-2 pl-2.5 text-xs whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50"
      >
        {/* Clamp the selected branch name (the vendored SelectTrigger's
            line-clamp idiom) so a long name truncates and the caret stays put in
            the narrow Compare sidebar. */}
        <span className="min-w-0 flex-1 truncate text-left">
          <ComboboxValue />
        </span>
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput showTrigger={false} placeholder="Filter branches…" />
        <ComboboxEmpty>No branches match</ComboboxEmpty>
        <ComboboxList>
          {(name: string) => (
            <BranchRow
              key={name}
              name={name}
              branch={branchByName.get(name)}
              defaultName={defaultName}
              currentName={currentName}
              div={divByName.get(name)}
              worktreePath={worktreeByBranch.get(name)}
            />
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/** One combobox row, keyed by branch name (the value Base UI's Collection hands
 *  the render function). The ItemIndicator check (rendered by the vendored
 *  `ComboboxItem`, its `pr-8` reserving the space) marks the selected row. The
 *  `branch` lookup is defensively optional — `name` always resolves in practice
 *  (both derive from the same sorted list) — so the row still renders its value
 *  even if metadata is momentarily missing. */
function BranchRow({
  name,
  branch,
  defaultName,
  currentName,
  div,
  worktreePath,
}: {
  name: string;
  branch: Branch | undefined;
  defaultName: string | null;
  currentName: string;
  div: BranchDivergence | undefined;
  worktreePath: string | undefined;
}) {
  return (
    <ComboboxItem value={name}>
      <span
        className="min-w-0 flex-1 truncate"
        // Only expose the full name as a tooltip when it's actually clipped —
        // measured just-in-time on hover, so no per-row refs.
        onMouseEnter={(e) => {
          const el = e.currentTarget;
          el.title = el.scrollWidth > el.clientWidth ? name : "";
        }}
      >
        {name}
        {name === defaultName && (
          <span className="ml-1.5 text-[10px] text-muted-foreground">
            default
          </span>
        )}
      </span>
      {worktreePath && (
        <span
          className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
          title={`Checked out in another worktree (${worktreePath})`}
        >
          <TreeStructureIcon className="size-3" weight="bold" />
          worktree
        </span>
      )}
      {/* ↑/↓ describe THIS row's branch vs `currentName` (the app-wide row-badge
          frame) — deliberately not the tab's current-side frame; the tooltip
          names the direction. Hidden when the branches are even. */}
      {div && (div.ahead > 0 || div.behind > 0) && (
        <span
          className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums"
          title={`${div.ahead} ahead, ${div.behind} behind ${currentName}`}
        >
          {div.ahead > 0 && (
            <span className="flex items-center gap-0.5">
              <ArrowUpIcon className="size-3" weight="bold" />
              {div.ahead}
            </span>
          )}
          {div.behind > 0 && (
            <span className="flex items-center gap-0.5">
              <ArrowDownIcon className="size-3" weight="bold" />
              {div.behind}
            </span>
          )}
        </span>
      )}
      {branch?.lastCommitDate && (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          <RelativeTime date={branch.lastCommitDate} />
        </span>
      )}
    </ComboboxItem>
  );
}
