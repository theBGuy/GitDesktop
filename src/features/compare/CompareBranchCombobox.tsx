import {
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react";
import { type Ref, useMemo } from "react";
import { RelativeTime } from "@/components/relative-time";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { rowCheckoutCopy } from "@/features/repository/checkout-copy";
import { clipTitle, clipTitleFromText } from "@/lib/clip-title";
import { normPath } from "@/lib/git/path";
import { useBranchDivergence, useUserWorktrees } from "@/lib/git/queries";
import type { Branch, BranchDivergence } from "@/lib/git/types";
import {
  ADD_UPSTREAM_VALUE,
  displayCompareValue,
  type RemoteCompareRow,
} from "./compare-remote-ref";

const ADD_UPSTREAM_LABEL = "Add upstream remote";

/** The Remote group's add-upstream action row, when the repo is a GitHub fork
 *  without that remote. */
export interface CompareAddUpstreamRow {
  forkParent: string;
  busy: boolean;
  onAdd: () => void;
}

/**
 * The Compare tab's base-branch picker: a searchable combobox with a "Local"
 * group over the local branches (already filtered by the caller — no current,
 * no `gd/session/*`, no archived) and a "Remote" group over remote-tracking
 * branches. Local rows mirror the BranchSwitcher vocabulary (worktree chip,
 * ahead/behind badges, relative date, default tag) MINUS the PR badge and
 * context menu — this is the daily "what am I about to PR" surface. Remote rows
 * show only their date: divergence is read for local heads only.
 *
 * The ahead/behind badges are computed vs `currentName` (the compare base shown
 * in the header "Compare {current} with"), not vs the default branch. Note the
 * frame: a row's badges describe the ROW's branch (↑ = commits it has that
 * `currentName` lacks) — the subject-is-the-row idiom every BranchSwitcher row
 * uses — while the tab's "N ahead / M behind" reads from `currentName`'s side,
 * so the same two numbers swap labels between a row and the selected
 * comparison. The badge tooltip names the direction.
 *
 * Remote item values are the DISPLAY form `remote/name` (a full-ref value would
 * let the filter match "refs/remotes/" on every row); this boundary maps them
 * to and from the stored full ref.
 */
export function CompareBranchCombobox({
  repoPath,
  branches,
  remoteRows,
  addUpstream,
  currentName,
  defaultName,
  value,
  onValueChange,
  open,
  onOpenChange,
  triggerRef,
  placeholder,
  remoteNotice,
}: {
  repoPath: string;
  /** Already filtered: no current, no gd/session/*, no archived. */
  branches: Branch[];
  /** Already filtered and ordered (see `remoteCompareRows`). */
  remoteRows: RemoteCompareRow[];
  addUpstream: CompareAddUpstreamRow | null;
  /** The compare base; ahead/behind badges are computed vs this branch. */
  currentName: string;
  defaultName: string | null;
  /** The stored pick: a bare local name or a full remote-tracking ref. */
  value: string | null;
  onValueChange: (stored: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: Ref<HTMLButtonElement>;
  /** The trigger's text while nothing is picked. */
  placeholder: string | null;
  /** The remote read's line while it hasn't succeeded (loading or failed);
   *  null once remote rows are known. */
  remoteNotice: string | null;
}) {
  // Popup state drives the N-per-branch git calls below: divergence + worktrees
  // fetch only while open (mirrors BranchSwitcher's `open`-gated queries).

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

  // Branches checked out in *another* checkout → that checkout. Git forbids the
  // same branch in two worktrees; the active repo's own checkout is excluded
  // (that's just the current branch). The main workspace stays IN — git counts
  // it as a worktree, and `isMain` is what lets the row name it properly.
  // Fetched only while open.
  const userWorktrees = useUserWorktrees(repoPath, open);
  const activeNorm = normPath(repoPath);
  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, { path: string; isMain: boolean }>();
    for (const w of userWorktrees.data ?? []) {
      if (w.branch && normPath(w.path) !== activeNorm)
        map.set(w.branch, { path: w.path, isMain: w.isMain });
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

  const branchByName = useMemo(
    () => new Map(sorted.map((b) => [b.name, b] as const)),
    [sorted],
  );
  const remoteByDisplay = useMemo(
    () => new Map(remoteRows.map((r) => [r.display, r] as const)),
    [remoteRows],
  );

  // Item values are STRINGS; Base UI's default contains/case-insensitive filter
  // matches their labels, so typing in the input filters the list. The `items`
  // prop carries the group shape and drives that filtering: the List's
  // render-function form maps the store's `filteredItems`, flattens the groups
  // for arrow keys, and drops a group that filters empty — static children
  // would bypass filtering entirely, so rows MUST come from the render
  // functions. Only non-empty groups are passed.
  const groups = useMemo(() => {
    const local = sorted.map((b) => b.name);
    const remote = [
      ...(addUpstream ? [ADD_UPSTREAM_VALUE] : []),
      ...remoteRows.map((r) => r.display),
    ];
    return [
      ...(local.length ? [{ value: "Local", items: local }] : []),
      ...(remote.length ? [{ value: "Remote", items: remote }] : []),
    ];
  }, [sorted, remoteRows, addUpstream]);

  return (
    <Combobox
      items={groups}
      value={value === null ? null : displayCompareValue(value)}
      // The action row's label is what the filter matches, so typing "remote"
      // or "upstream" still finds it.
      itemToStringLabel={(item: string) =>
        item === ADD_UPSTREAM_VALUE ? ADD_UPSTREAM_LABEL : item
      }
      // Selecting a branch fires this and closes the popup. The action row
      // cancels its own selection: the store never sees it and the popup stays
      // open while the remote is added (the caller closes it on success).
      onValueChange={(picked: string | null, details) => {
        if (picked === ADD_UPSTREAM_VALUE) {
          details.cancel();
          addUpstream?.onAdd();
          return;
        }
        if (picked) onValueChange(remoteByDisplay.get(picked)?.ref ?? picked);
      }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <ComboboxTrigger
        ref={triggerRef}
        aria-label="Compare with branch"
        className="flex w-full items-center justify-between gap-1.5 rounded-none border border-input bg-transparent py-2 pr-2 pl-2.5 text-xs whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50"
      >
        {/* Clamp the selected branch name (the vendored SelectTrigger's
            line-clamp idiom) so a long name truncates and the caret stays put in
            the narrow Compare sidebar. The display form is rendered directly: a
            remote pick is stored as its full ref. */}
        <span
          className="min-w-0 flex-1 truncate text-left"
          onMouseEnter={clipTitleFromText}
        >
          {value === null ? (
            <span className="text-muted-foreground">{placeholder}</span>
          ) : (
            displayCompareValue(value)
          )}
        </span>
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput showTrigger={false} placeholder="Filter branches…" />
        {/* Until the remote read answers, a miss can only speak for the local
            branches. */}
        <ComboboxEmpty>
          {remoteNotice === null
            ? "No branches match"
            : "No local branches match"}
        </ComboboxEmpty>
        <ComboboxList>
          {(group: { value: string; items: string[] }) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(name: string) => {
                  if (name === ADD_UPSTREAM_VALUE && addUpstream)
                    return <AddUpstreamRow key={name} offer={addUpstream} />;
                  const remote = remoteByDisplay.get(name);
                  if (group.value === "Remote" && remote)
                    return <RemoteRow key={name} row={remote} />;
                  return (
                    <BranchRow
                      key={name}
                      name={name}
                      branch={branchByName.get(name)}
                      defaultName={defaultName}
                      currentName={currentName}
                      div={divByName.get(name)}
                      worktree={worktreeByBranch.get(name)}
                    />
                  );
                }}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
        {/* Not an item: arrow keys skip it. */}
        {remoteNotice !== null && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Remote: {remoteNotice}
          </p>
        )}
      </ComboboxContent>
    </Combobox>
  );
}

/** The add-upstream action: a real item, so arrow keys reach it and Enter runs
 *  it. Its busy copy is the caller's, already scoped to the repo the add
 *  started in. */
function AddUpstreamRow({ offer }: { offer: CompareAddUpstreamRow }) {
  return (
    <ComboboxItem value={ADD_UPSTREAM_VALUE}>
      <PlusIcon className="size-3 shrink-0" weight="bold" />
      <span className="shrink-0">
        {offer.busy ? "Adding upstream remote…" : ADD_UPSTREAM_LABEL}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
        onMouseEnter={clipTitleFromText}
      >
        fork of {offer.forkParent}
      </span>
    </ComboboxItem>
  );
}

/** A remote-tracking row: `remote/name` and its tip's date only. */
function RemoteRow({ row }: { row: RemoteCompareRow }) {
  return (
    <ComboboxItem value={row.display}>
      <span
        className="min-w-0 flex-1 truncate"
        onMouseEnter={clipTitle(row.display)}
      >
        {row.display}
      </span>
      {row.lastCommitDate && (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          <RelativeTime date={row.lastCommitDate} />
        </span>
      )}
    </ComboboxItem>
  );
}

/** One local combobox row, keyed by branch name (the value Base UI's Collection
 *  hands the render function). The ItemIndicator check (rendered by the
 *  vendored `ComboboxItem`, its `pr-8` reserving the space) marks the selected
 *  row. The `branch` lookup is defensively optional — `name` always resolves in
 *  practice (both derive from the same sorted list) — so the row still renders
 *  its value even if metadata is momentarily missing. */
function BranchRow({
  name,
  branch,
  defaultName,
  currentName,
  div,
  worktree,
}: {
  name: string;
  branch: Branch | undefined;
  defaultName: string | null;
  currentName: string;
  div: BranchDivergence | undefined;
  /** The other checkout holding this branch, when any. */
  worktree: { path: string; isMain: boolean } | undefined;
}) {
  // Names the holding checkout the way every branch row does. The record's
  // `title` arm is deliberately not used: its "this row opens it" clause is true
  // in the branch dropdown, while this row selects a compare base.
  const copy = rowCheckoutCopy(worktree?.isMain);
  return (
    <ComboboxItem value={name}>
      <span className="min-w-0 flex-1 truncate" onMouseEnter={clipTitle(name)}>
        {name}
        {name === defaultName && (
          <span className="ml-1.5 text-[10px] text-muted-foreground">
            default
          </span>
        )}
      </span>
      {worktree && (
        <span
          className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
          title={copy.blockedTitle(worktree.path)}
        >
          <TreeStructureIcon className="size-3" weight="bold" />
          {copy.noun}
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
