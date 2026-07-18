import { TreeStructureIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
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
  ComboboxValue,
} from "@/components/ui/combobox";
import {
  useBranches,
  useRemoteBranches,
  useUserWorktrees,
} from "@/lib/git/queries";
import type { Branch } from "@/lib/git/types";
import { formatRelativeTime } from "@/lib/time";

/** Lower-cased, forward-slashed path for cross-source comparison — git emits
 *  "/", the app stores "\" on Windows (mirrors BranchSwitcher's helper). */
const normPath = (p: string) => p.replace(/\\/g, "/").toLowerCase();

/** Whether a local branch may be offered as a base: drop the agent-session
 *  namespace (a hard repo invariant — every branch surface filters
 *  `gd/session/*`) and archived branches, EXCEPT always keep the current branch
 *  even if archived (it's the seeded value and must render). Single-sourced so
 *  the picker's Local group and the `useHasBaseOptions` gate can't drift. */
function isOfferableLocal(b: Branch, currentName: string | null): boolean {
  return (
    !b.name.startsWith("gd/session/") && (!b.archived || b.name === currentName)
  );
}

/** Whether a remote branch's short name may be offered as a base — drops the
 *  agent-session namespace. (The full `remote/name` value's collision drop with
 *  a same-named local lives inside the component; it can't affect emptiness —
 *  if the only remote collides with a local, that local exists and the Local
 *  group is non-empty.) */
function isOfferableRemoteName(name: string): boolean {
  return !name.startsWith("gd/session/");
}

/** Metadata a combobox row renders, keyed off the option's value string. */
interface RowMeta {
  /** ISO-8601 committer date of the branch tip (recency chip). */
  lastCommitDate: string;
  /** Set when this branch is checked out in ANOTHER worktree. */
  worktreePath?: string;
}

/**
 * The create-branch dialog's base picker: a searchable combobox grouped into
 * Local and Remote branches, modeled on CompareBranchCombobox. Unlike the
 * compare picker it OWNS its data — the dialog opens from the command palette
 * without the branch-switcher popover, so it can't reuse the switcher's
 * popover-gated queries. It has NO divergence query (that's compare-specific).
 *
 * A remote base (`origin/epic/x`) is a valid start point even when a same-named
 * local branch exists — the local may be stale or checked out in another
 * worktree — so remote rows are NOT deduped against locals (unlike the
 * switcher's checkout list). `onValueChange` reports whether the picked value
 * is a remote-tracking ref, which drives the create's `--no-track` seam.
 */
export function BaseBranchCombobox({
  repoPath,
  open,
  currentName,
  defaultName,
  value,
  onValueChange,
}: {
  repoPath: string;
  /** The create-branch DIALOG's open state — gates the queries. */
  open: boolean;
  currentName: string | null;
  defaultName: string | null;
  value: string | null;
  /** isRemote: whether the picked value is a remote-tracking ref (drives
   *  --no-track). */
  onValueChange: (value: string, isRemote: boolean) => void;
}) {
  // useBranches is cached app-wide; the remote list + worktrees fetch only while
  // the dialog is open (same open-gating idiom as CompareBranchCombobox).
  const branches = useBranches(repoPath);
  const remoteBranches = useRemoteBranches(repoPath, open);
  const userWorktrees = useUserWorktrees(repoPath, open);

  // Branches checked out in *another* worktree → that worktree's path. Git
  // forbids the same branch in two worktrees; the active repo's own checkout is
  // excluded (that's just the current branch).
  const activeNorm = normPath(repoPath);
  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of userWorktrees.data ?? []) {
      if (w.branch && normPath(w.path) !== activeNorm)
        map.set(w.branch, w.path);
    }
    return map;
  }, [userWorktrees.data, activeNorm]);

  // Local group: keep only offerable branches (see `isOfferableLocal`). Order:
  // current first, then default, then most-recently-committed.
  const localBranches = useMemo(() => {
    const list = (branches.data ?? []).filter((b) =>
      isOfferableLocal(b, currentName),
    );
    return list.sort((a, b) => {
      if (a.name === currentName) return -1;
      if (b.name === currentName) return 1;
      if (a.name === defaultName) return -1;
      if (b.name === defaultName) return 1;
      return b.lastCommitDate.localeCompare(a.lastCommitDate);
    });
  }, [branches.data, currentName, defaultName]);

  const localNames = useMemo(
    () => localBranches.map((b) => b.name),
    [localBranches],
  );
  const localSet = useMemo(() => new Set(localNames), [localNames]);

  // Remote group: `${remote}/${name}` values across ALL remotes (a fork's
  // `upstream/x` is a valid base). Drop the session namespace and any remote
  // value that literally collides with an existing local branch name (a local
  // named `origin/x` would create a duplicate combobox value). Do NOT dedupe a
  // remote merely because a same-named LOCAL exists — offering `origin/epic/x`
  // alongside a stale local `epic/x` IS the motivating case. Order by recency.
  const remoteBranchList = useMemo(() => {
    return (remoteBranches.data ?? [])
      .filter((b) => isOfferableRemoteName(b.name))
      .map((b) => ({ value: `${b.remote}/${b.name}`, meta: b }))
      .filter((r) => !localSet.has(r.value))
      .sort((a, b) =>
        b.meta.lastCommitDate.localeCompare(a.meta.lastCommitDate),
      );
  }, [remoteBranches.data, localSet]);

  const remoteNames = useMemo(
    () => remoteBranchList.map((r) => r.value),
    [remoteBranchList],
  );
  const remoteSet = useMemo(() => new Set(remoteNames), [remoteNames]);

  // Row metadata by option value, spanning both groups. Local rows key off the
  // Branch; remote rows carry only a date (no worktree — a remote-tracking ref
  // is never a checked-out worktree branch).
  const metaByValue = useMemo(() => {
    const map = new Map<string, RowMeta>();
    for (const b of localBranches) {
      map.set(b.name, {
        lastCommitDate: b.lastCommitDate,
        worktreePath: worktreeByBranch.get(b.name),
      });
    }
    for (const r of remoteBranchList) {
      map.set(r.value, { lastCommitDate: r.meta.lastCommitDate });
    }
    return map;
  }, [localBranches, remoteBranchList, worktreeByBranch]);

  // Only non-empty groups are passed to `items` — Base UI flattens groups for
  // keyboard nav, filters per-group, and drops a group that filters empty. The
  // `items` prop MUST carry the group shape (with `items` arrays) so the List's
  // render-function form maps `filteredItems`; static children bypass filtering.
  const groups = useMemo(
    () => [
      ...(localNames.length ? [{ value: "Local", items: localNames }] : []),
      ...(remoteNames.length ? [{ value: "Remote", items: remoteNames }] : []),
    ],
    [localNames, remoteNames],
  );

  return (
    <Combobox
      items={groups}
      value={value}
      onValueChange={(name) => name && onValueChange(name, remoteSet.has(name))}
    >
      <ComboboxTrigger className="flex w-full items-center justify-between gap-1.5 rounded-none border border-input bg-transparent py-2 pr-2 pl-2.5 text-xs whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50">
        {/* Clamp a long branch value so it truncates and the caret stays put. */}
        <span className="min-w-0 flex-1 truncate text-left">
          <ComboboxValue />
        </span>
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput showTrigger={false} placeholder="Filter branches…" />
        <ComboboxEmpty>No branches match</ComboboxEmpty>
        <ComboboxList>
          {(group: { value: string; items: string[] }) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(name: string) => (
                  <BaseBranchRow
                    key={name}
                    name={name}
                    meta={metaByValue.get(name)}
                    currentName={currentName}
                    defaultName={defaultName}
                  />
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/**
 * Whether the picker would render ANY offerable base — the single source of
 * truth for the dialog's "hide the whole field" gate. It subscribes to the SAME
 * two queries the combobox does (`useBranches`, `useRemoteBranches`; react-query
 * dedupes) and applies the SAME offerable predicates, so the field can never
 * show with an empty dropdown (e.g. detached HEAD + only-archived locals + no
 * remotes) the way a raw-count gate could.
 */
export function useHasBaseOptions(
  repoPath: string,
  open: boolean,
  currentName: string | null,
): boolean {
  const branches = useBranches(repoPath);
  const remoteBranches = useRemoteBranches(repoPath, open);
  return useMemo(() => {
    const hasLocal = (branches.data ?? []).some((b) =>
      isOfferableLocal(b, currentName),
    );
    const hasRemote = (remoteBranches.data ?? []).some((b) =>
      isOfferableRemoteName(b.name),
    );
    return hasLocal || hasRemote;
  }, [branches.data, remoteBranches.data, currentName]);
}

/** First offerable seed among [current, default] — "" when neither is offerable
 *  (⇒ create from HEAD). Single-sourced with the picker's predicates so the
 *  seeded value can never be one the list won't show. */
export function useSeedBase(
  repoPath: string,
  currentName: string | null,
  defaultName: string | null,
): string {
  const branches = useBranches(repoPath);
  return useMemo(() => {
    const byName = new Map<string, Branch>();
    for (const b of branches.data ?? []) byName.set(b.name, b);
    for (const candidate of [currentName, defaultName]) {
      if (!candidate) continue;
      const b = byName.get(candidate);
      // When the branch is loaded, only seed it if the picker would offer it.
      // When it isn't loaded yet (data momentarily absent), fall back to the
      // session-namespace check alone — preserving today's seed behavior until
      // the offerability check can run against real data.
      const offerable = b
        ? isOfferableLocal(b, currentName)
        : !candidate.startsWith("gd/session/");
      if (offerable) return candidate;
    }
    return "";
  }, [branches.data, currentName, defaultName]);
}

/** One combobox row, keyed by the option value Base UI's Collection hands the
 *  render function (a local branch name or a `remote/name` string). */
function BaseBranchRow({
  name,
  meta,
  currentName,
  defaultName,
}: {
  name: string;
  meta: RowMeta | undefined;
  currentName: string | null;
  defaultName: string | null;
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
        {name === currentName && (
          <span className="ml-1.5 text-[10px] text-muted-foreground">
            (current)
          </span>
        )}
        {name === defaultName && (
          <span className="ml-1.5 text-[10px] text-muted-foreground">
            default
          </span>
        )}
      </span>
      {meta?.worktreePath && (
        <span
          className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
          title={`Checked out in another worktree (${meta.worktreePath})`}
        >
          <TreeStructureIcon className="size-3" weight="bold" />
          worktree
        </span>
      )}
      {meta?.lastCommitDate && (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatRelativeTime(meta.lastCommitDate)}
        </span>
      )}
    </ComboboxItem>
  );
}
