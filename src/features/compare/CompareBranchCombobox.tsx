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
import { compareInstantsNewestFirst, parseableDate } from "@/lib/time";
import {
  ADD_UPSTREAM_VALUE,
  collidesWithRemoteRefs,
  compareItemLabel,
  compareItemOf,
  compareItemStored,
  displayCompareValue,
  LOCAL_REF_PREFIX,
  localCompareItem,
  REMOTE_REF_PREFIX,
  type RemoteCompareRow,
} from "./compare-remote-ref";

/** Why a local branch named like a remote ref has no pick in this picker. */
const COLLIDING_ROW_REASON =
  "Can't be picked: Compare reads this name as a remote branch.";

const ADD_UPSTREAM_LABEL = "Add upstream remote";

type TwinKind = "local" | "remote";

/** The closed trigger's word after a pick whose name the other kind shares. */
const TWIN_CUE: Record<TwinKind, string> = {
  local: "local",
  remote: "remote",
};

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
 * Item values are kind-prefixed full refs (`refs/heads/…`, `refs/remotes/…`),
 * so a local branch named like a remote one never shares a value with its row;
 * labels, and so the filter, read the shown name. This boundary maps items to
 * and from the stored pick (a bare local name or a full remote ref).
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
  popupRef,
  placeholder,
  remoteNotice,
  remoteSearched,
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
  /** Popup state; it also gates the per-branch divergence and worktree reads
   *  below (BranchSwitcher's `open`-gated queries). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: Ref<HTMLButtonElement>;
  /** The popup node, for the caller's focus rescue. */
  popupRef?: Ref<HTMLDivElement>;
  /** The trigger's text while nothing is picked. */
  placeholder: string | null;
  /** The remote read's footer line while it hasn't succeeded (loading, failed,
   *  or a failed refresh over cached rows); null once it has. */
  remoteNotice: string | null;
  /** `remoteRows` came from a remote read, fresh or cached under a failed
   *  refresh, so the filter searched them. */
  remoteSearched: boolean;
}) {
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
        return compareInstantsNewestFirst(a.lastCommitDate, b.lastCommitDate);
      }),
    [branches, defaultName],
  );

  const branchByName = useMemo(
    () => new Map(sorted.map((b) => [b.name, b] as const)),
    [sorted],
  );
  const remoteByRef = useMemo(
    () => new Map(remoteRows.map((r) => [r.ref, r] as const)),
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
    const local = sorted.map((b) => localCompareItem(b.name));
    const remote = [
      ...(addUpstream ? [ADD_UPSTREAM_VALUE] : []),
      ...remoteRows.map((r) => r.ref),
    ];
    return [
      ...(local.length ? [{ value: "Local", items: local }] : []),
      ...(remote.length ? [{ value: "Remote", items: remote }] : []),
    ];
  }, [sorted, remoteRows, addUpstream]);

  // A pick whose shown name the other kind also has: a remote pick against the
  // Local rows and the current branch, a local pick against the Remote rows.
  const shownName = value === null ? null : displayCompareValue(value);
  const twinKind = ((): TwinKind | null => {
    if (value === null || shownName === null) return null;
    if (value.startsWith(REMOTE_REF_PREFIX))
      return branchByName.has(shownName) || shownName === currentName
        ? "remote"
        : null;
    return remoteRows.some((r) => r.display === value) ? "local" : null;
  })();

  return (
    <Combobox
      items={groups}
      value={value === null ? null : compareItemOf(value)}
      // The action row's label is what the filter matches, so typing "remote"
      // or "upstream" still finds it.
      itemToStringLabel={(item: string) =>
        item === ADD_UPSTREAM_VALUE
          ? ADD_UPSTREAM_LABEL
          : compareItemLabel(item)
      }
      // Selecting a branch fires this and closes the popup. The action row
      // cancels its own selection: the store never sees it and the popup stays
      // open while the remote is added (the caller closes it on success). A
      // colliding local row is disabled; it cancels here too. The test reads
      // the LOCAL item's name: every remote item starts with `refs/remotes/`.
      onValueChange={(picked: string | null, details) => {
        if (picked === ADD_UPSTREAM_VALUE) {
          details.cancel();
          addUpstream?.onAdd();
          return;
        }
        if (!picked) return;
        const stored = compareItemStored(picked);
        if (
          picked.startsWith(LOCAL_REF_PREFIX) &&
          collidesWithRemoteRefs(stored)
        ) {
          details.cancel();
          return;
        }
        onValueChange(stored);
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
            remote pick is stored as its full ref. Each name node is keyed by
            its form and the shown name: `clipTitleFromText` sets `title` only
            on hover, so a node reused for another name or form would keep the
            old tooltip until the pointer re-enters. */}
        {twinKind === null ? (
          <span
            key={`name:${shownName ?? ""}`}
            className="min-w-0 flex-1 truncate text-left"
            onMouseEnter={clipTitleFromText}
          >
            {shownName === null ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              shownName
            )}
          </span>
        ) : (
          // A twin's two picks show the same name, so the kind is said in words
          // after it; the comma is hidden and the bare space renders nothing
          // between flex items. A remote twin is always marked; `local` follows
          // the remote rows last read and never triggers a read.
          <span
            key="twin"
            className="flex min-w-0 flex-1 items-baseline gap-1.5"
          >
            <span
              key={shownName}
              className="min-w-0 truncate text-left"
              onMouseEnter={clipTitleFromText}
            >
              {shownName}
            </span>
            <span className="sr-only">,</span>{" "}
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {TWIN_CUE[twinKind]}
            </span>
          </span>
        )}
      </ComboboxTrigger>
      <ComboboxContent ref={popupRef}>
        <ComboboxInput showTrigger={false} placeholder="Filter branches…" />
        {/* Until remote rows are known, a miss can only speak for the local
            branches; cached rows a failed refresh left were searched too. */}
        <ComboboxEmpty>
          {remoteSearched ? "No branches match" : "No local branches match"}
        </ComboboxEmpty>
        <ComboboxList aria-label="Branches to compare with">
          {(group: { value: string; items: string[] }) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(item: string) => {
                  if (item === ADD_UPSTREAM_VALUE && addUpstream)
                    return <AddUpstreamRow key={item} offer={addUpstream} />;
                  const remote = remoteByRef.get(item);
                  if (group.value === "Remote" && remote)
                    return <RemoteRow key={item} row={remote} />;
                  // The row and its lookups read the bare name; the maps are
                  // keyed by the branch, divergence and worktree reads' names.
                  const name = compareItemStored(item);
                  return (
                    <BranchRow
                      key={item}
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
      <span className="sr-only">,</span>{" "}
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
    <ComboboxItem value={row.ref}>
      <span
        className="min-w-0 flex-1 truncate"
        onMouseEnter={clipTitle(row.display)}
      >
        {row.display}
      </span>
      {row.lastCommitDate && parseableDate(row.lastCommitDate) && (
        <>
          <span className="sr-only">,</span>{" "}
          <span className="shrink-0 text-[11px] text-muted-foreground">
            <RelativeTime date={row.lastCommitDate} />
          </span>
        </>
      )}
    </ComboboxItem>
  );
}

/** A local row's ↑/↓ badge, preceded by its name separator; nothing when the
 *  branches are even. The arrows describe THIS row's branch vs `currentName`
 *  (the app-wide row-badge frame), not the tab's current-side frame. Worded as
 *  BranchSwitcher's: `role="img"` hides the visible arrows and counts from AT,
 *  so the label is the whole alternative and behind-only still names the base. */
function DivergenceBadge({
  div,
  currentName,
}: {
  div: BranchDivergence;
  currentName: string;
}) {
  if (div.ahead === 0 && div.behind === 0) return null;
  const parts: string[] = [];
  if (div.ahead > 0)
    parts.push(
      `${div.ahead} commit${div.ahead === 1 ? "" : "s"} ahead of ${currentName}`,
    );
  if (div.behind > 0)
    parts.push(
      `${div.behind} commit${div.behind === 1 ? "" : "s"} behind${div.ahead > 0 ? "" : ` ${currentName}`}`,
    );
  const label = parts.join(", ");
  return (
    <>
      <span className="sr-only">,</span>{" "}
      <span
        role="img"
        aria-label={label}
        className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground tabular-nums"
        title={label}
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
    </>
  );
}

/** One local combobox row, given the bare name of its `refs/heads/` item. The
 *  ItemIndicator check (rendered by the vendored `ComboboxItem`, its `pr-8`
 *  reserving the space) marks the selected row. The `branch` lookup is
 *  defensively optional — `name` always resolves in practice (both derive from
 *  the same sorted list) — so the row still renders its value even if metadata
 *  is momentarily missing. */
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
  if (collidesWithRemoteRefs(name)) return <CollidingBranchRow name={name} />;
  // Names the holding checkout the way every branch row does. The record's
  // `title` arm is deliberately not used: its "this row opens it" clause is true
  // in the branch dropdown, while this row selects a compare base.
  const copy = rowCheckoutCopy(worktree?.isMain);
  const date = branch?.lastCommitDate;
  // The option's name comes from its content (every row in this file). A part
  // shown beside the name is led by a hidden comma and a bare space, gated with
  // it so none dangles; a whitespace-only run between flex items renders
  // nothing. A chip inside the name span is hidden from AT and named by one
  // hidden copy after the span that holds its own comma and space.
  return (
    <ComboboxItem value={localCompareItem(name)}>
      <span className="min-w-0 flex-1 truncate" onMouseEnter={clipTitle(name)}>
        {name}
        {/* A separator's space inside this inline span would render, so the
            visible chip is hidden from AT and named by the copy after the span.
            The copy stays a row child: absolutely positioned inside this
            clipped span, it would land past a long name's end, outside the
            row, and widen the list's scroll range. */}
        {name === defaultName && (
          <span
            aria-hidden="true"
            className="ml-1.5 text-[10px] text-muted-foreground"
          >
            default
          </span>
        )}
      </span>
      {name === defaultName && <span className="sr-only">, default</span>}
      {worktree && (
        <>
          <span className="sr-only">,</span>{" "}
          <span
            className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
            title={copy.blockedTitle(worktree.path)}
          >
            <TreeStructureIcon className="size-3" weight="bold" />
            {copy.noun}
          </span>
        </>
      )}
      {div && <DivergenceBadge div={div} currentName={currentName} />}
      {date && parseableDate(date) && (
        <>
          <span className="sr-only">,</span>{" "}
          <span className="shrink-0 text-[11px] text-muted-foreground">
            <RelativeTime date={date} />
          </span>
        </>
      )}
    </ComboboxItem>
  );
}

/** A local branch Compare can't pick: listed, arrow-reachable, refused by Base
 *  UI's `disabled`. A disabled row takes no tooltip, so the full name wraps and
 *  the reason is visible text in the row's name; only the name is dimmed, so
 *  the reason keeps its contrast. */
function CollidingBranchRow({ name }: { name: string }) {
  return (
    <ComboboxItem
      value={localCompareItem(name)}
      disabled
      className="data-disabled:opacity-100"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-all opacity-50">{name}</span>
        <span className="sr-only">,</span>{" "}
        <span className="text-[11px] text-muted-foreground">
          {COLLIDING_ROW_REASON}
        </span>
      </span>
    </ComboboxItem>
  );
}
