import { useSyncExternalStore } from "react";
import { isSessionBranchName } from "@/lib/git/ref-name";
import type { RemoteBranch } from "@/lib/git/types";
import { compareInstantsNewestFirst } from "@/lib/time";

/** The store keeps a remote pick as its FULL remote-tracking ref, so git never
 *  resolves a same-named local branch or tag instead; a local pick stays the
 *  bare branch name. */
export const REMOTE_REF_PREFIX = "refs/remotes/";

/** The picker's "Add upstream remote" row. ":" is illegal in a ref name, so no
 *  branch can collide with it. */
export const ADD_UPSTREAM_VALUE = "::add-upstream::";

/** Splits `remote/name` at the longest known remote followed by "/", since a
 *  remote name may itself hold "/". Unknown remotes (or none matching) fall
 *  back to the first "/", as the backend does for a remote it doesn't know. */
function splitRemoteDisplay(
  display: string,
  remotes: readonly string[] | undefined,
): { remote: string; name: string } | null {
  let slash = display.indexOf("/");
  for (const r of remotes ?? []) {
    if (r.length > slash && display.startsWith(`${r}/`)) slash = r.length;
  }
  if (slash <= 0 || slash === display.length - 1) return null;
  return { remote: display.slice(0, slash), name: display.slice(slash + 1) };
}

/** Null for a local pick. `remotes` is the repo's remote list when known. */
export function parseRemoteCompareValue(
  v: string | null,
  remotes?: readonly string[],
): { remote: string; name: string; display: string } | null {
  if (v === null || !v.startsWith(REMOTE_REF_PREFIX)) return null;
  const display = v.slice(REMOTE_REF_PREFIX.length);
  const split = splitRemoteDisplay(display, remotes);
  return split === null ? null : { ...split, display };
}

// The remote each remote pick was made against, by repo and stored value:
// removing a slash remote would re-split the stored ref against a shorter one,
// and the fetch stamp that also names it is replaceable. Outlives remounts.
const pickRemotes = new Map<string, string>();
const pickRemoteListeners = new Set<() => void>();
const pickRemoteKey = (repo: string, value: string) => `${repo}\0${value}`;
function notifyPickRemotes() {
  for (const listener of pickRemoteListeners) listener();
}

/** Records only a remote the KNOWN remotes list names: a split made without
 *  one, or a first-slash fallback no listed remote matched, is a guess, and a
 *  recorded guess would outrank the right split once the list catches up. The
 *  backend's split from `listed` is a guess too (it falls back to the first
 *  "/" for an unconfigured remote), so it only resolves, never records.
 *  Returns the pick as {@link resolvePick} now reads it. */
export function recordPickRemote(
  repo: string,
  value: string,
  remotes: readonly string[] | undefined,
  listed?: readonly RemoteBranch[],
): { remote: string; name: string; display: string } | null {
  const key = pickRemoteKey(repo, value);
  const split = parseRemoteCompareValue(value, remotes);
  if (split !== null && remotes?.includes(split.remote)) {
    if (pickRemotes.get(key) !== split.remote) {
      pickRemotes.set(key, split.remote);
      notifyPickRemotes();
    }
  }
  return resolvePick(value, remotes, pickRemotes.get(key) ?? null, listed);
}

/** Test-only: module state would otherwise carry records between cases. */
export function clearPickRemotesForTests() {
  pickRemotes.clear();
  notifyPickRemotes();
}

function subscribePickRemotes(listener: () => void) {
  pickRemoteListeners.add(listener);
  return () => {
    pickRemoteListeners.delete(listener);
  };
}

export function usePickRemote(
  repo: string,
  value: string | null,
): string | null {
  return useSyncExternalStore(subscribePickRemotes, () =>
    value === null
      ? null
      : (pickRemotes.get(pickRemoteKey(repo, value)) ?? null),
  );
}

/** The one identity of a stored pick: its recorded remote when that still
 *  prefixes it, else the split against the current remotes list. A listed
 *  remote strictly longer than the record wins: the record came from an older
 *  list that didn't have it yet. While the list is unknown, an unrecorded pick
 *  takes the backend's split from its row in `listed` (the first "/" only when
 *  no row matches), as {@link remoteCompareRows} does. A backend split longer
 *  than the record also wins: it can only name a configured remote, since the
 *  backend falls back to the first "/". */
export function resolvePick(
  value: string | null,
  remotes: readonly string[] | undefined,
  recorded: string | null,
  listed?: readonly RemoteBranch[],
): { remote: string; name: string; display: string } | null {
  const parsed = parseRemoteCompareValue(value, remotes);
  const listedSplit =
    parsed !== null && remotes === undefined
      ? listedPick(parsed.display, listed)
      : null;
  const split = listedSplit ?? parsed;
  if (
    split === null ||
    recorded === null ||
    !split.display.startsWith(`${recorded}/`) ||
    split.display.length === recorded.length + 1 ||
    (split.remote.startsWith(`${recorded}/`) &&
      (remotes?.includes(split.remote) || listedSplit !== null))
  )
    return split;
  return {
    remote: recorded,
    name: split.display.slice(recorded.length + 1),
    display: split.display,
  };
}

/** The backend row whose `remote/name` is `display`, as a pick. */
function listedPick(
  display: string,
  listed: readonly RemoteBranch[] | undefined,
): { remote: string; name: string; display: string } | null {
  const row = listed?.find((b) => `${b.remote}/${b.name}` === display);
  return row === undefined
    ? null
    : { remote: row.remote, name: row.name, display };
}

export function remoteCompareValue(remote: string, name: string): string {
  return `${REMOTE_REF_PREFIX}${remote}/${name}`;
}

/** What every user-facing surface shows: `remote/name` for a remote pick, the
 *  bare name otherwise. */
export function displayCompareValue(v: string): string {
  return v.startsWith(REMOTE_REF_PREFIX)
    ? v.slice(REMOTE_REF_PREFIX.length)
    : v;
}

export const LOCAL_REF_PREFIX = "refs/heads/";

/** A picker row's combobox value: the full ref of what the row names, so a
 *  local and a remote row never share one. Never stored. */
export function localCompareItem(name: string): string {
  return `${LOCAL_REF_PREFIX}${name}`;
}

/** The item a stored pick selects. A prefix test, never a parse: a stored
 *  value starting `refs/remotes/` passes through unchanged, so it can name only
 *  a remote row, never the local `refs/heads/refs/remotes/…` row; when no
 *  remote row carries that ref, no row is marked. */
export function compareItemOf(stored: string): string {
  return stored.startsWith(REMOTE_REF_PREFIX)
    ? stored
    : localCompareItem(stored);
}

/** What a picked item stores: a local item's bare name, any other item as is. */
export function compareItemStored(item: string): string {
  return item.startsWith(LOCAL_REF_PREFIX)
    ? item.slice(LOCAL_REF_PREFIX.length)
    : item;
}

/** What an item's row shows and the picker's filter matches: the bare name for
 *  a local item, `remote/name` for a remote one. */
export function compareItemLabel(item: string): string {
  return item.startsWith(LOCAL_REF_PREFIX)
    ? compareItemStored(item)
    : displayCompareValue(item);
}

/** A local branch Compare can't pick: its bare name, stored as a local pick,
 *  would read back as a remote one. Name-only, so a row never flips. */
export function collidesWithRemoteRefs(localName: string): boolean {
  return localName.startsWith(REMOTE_REF_PREFIX);
}

export interface RemoteCompareRow {
  /** What the row shows: `remote/name`. */
  display: string;
  /** The stored value and the combobox item: `refs/remotes/remote/name`. */
  ref: string;
  lastCommitDate: string;
}

/** upstream first, then origin, then the rest alphabetically. */
function remoteRank(remote: string): number {
  if (remote === "upstream") return 0;
  if (remote === "origin") return 1;
  return 2;
}

/**
 * The picker's Remote rows: exactly the remote-branch list (every remote) minus
 * each remote's HEAD and agent session branches. A local branch sharing a row's
 * name, even `remote/name`, never hides it: items carry their kind. Ordered by
 * remote (upstream, origin, then alphabetical), each remote's rows by recency.
 * The backend already splits at the longest configured remote. When `remotes`
 * is known each row is re-split against it first, so it stays congruent with
 * `parseRemoteCompareValue` when this list and the backend's read differ (a
 * remote added or removed between them), and the HEAD filter covers that
 * window; without a list the backend's split stands.
 */
export function remoteCompareRows(
  remoteBranches: readonly RemoteBranch[] | undefined,
  remotes?: readonly string[],
): RemoteCompareRow[] {
  return (remoteBranches ?? [])
    .map((b) => ({
      ...(remotes === undefined
        ? b
        : (splitRemoteDisplay(`${b.remote}/${b.name}`, remotes) ?? b)),
      lastCommitDate: b.lastCommitDate,
    }))
    .filter((b) => b.name !== "HEAD" && !isSessionBranchName(b.name))
    .map((b) => ({
      remote: b.remote,
      display: `${b.remote}/${b.name}`,
      ref: remoteCompareValue(b.remote, b.name),
      lastCommitDate: b.lastCommitDate,
    }))
    .sort(
      (a, b) =>
        remoteRank(a.remote) - remoteRank(b.remote) ||
        a.remote.localeCompare(b.remote) ||
        compareInstantsNewestFirst(a.lastCommitDate, b.lastCommitDate),
    )
    .map(({ display, ref, lastCommitDate }) => ({
      display,
      ref,
      lastCommitDate,
    }));
}

/** A pick's fetch finished and the comparison is re-reading: the status line
 *  and Create's hold reason, so the two never disagree. */
export const UPDATING_COMPARISON_COPY = "Updating the comparison…";

/** Why a remote pick can't be compared any more: the status line's words (a
 *  failed fetch may lead them) and the Create PR hold's reason, so the two
 *  never disagree on the cause. */
export const GONE_PICK_COPY: Record<
  "pruned" | "remote-gone" | "missing",
  (remote: string, name: string) => string
> = {
  // Only after this pick's own successful fetch of `remote` left it unlisted.
  pruned: (remote, name) => `${remote}/${name} was deleted on ${remote}.`,
  "remote-gone": (remote) => `${remote} is no longer a remote.`,
  // The ref is unlisted and no successful remotes read or fetch says why.
  missing: (remote, name) =>
    `${remote}/${name} is no longer in your remote branches.`,
};
