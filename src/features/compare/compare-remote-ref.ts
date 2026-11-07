import { useSyncExternalStore } from "react";
import { isSessionBranchName } from "@/lib/git/ref-name";
import type { RemoteBranch } from "@/lib/git/types";

/** The store keeps a remote pick as its FULL remote-tracking ref, so git never
 *  resolves a same-named local branch or tag instead; a local pick stays the
 *  bare branch name. */
export const REMOTE_REF_PREFIX = "refs/remotes/";

/** The picker's "Add upstream remote" row. ":" is illegal in a ref name, so no
 *  branch can collide with it. */
export const ADD_UPSTREAM_VALUE = "::add-upstream::";

/** Splits `remote/name` at the longest known remote followed by "/", since a
 *  remote name may itself hold "/". Unknown remotes (or none matching) fall
 *  back to the first "/", the backend's own split. */
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

/** Records only against a KNOWN remotes list: a split made without one is a
 *  guess, and a recorded guess would outrank the right split once the list
 *  arrives. Returns the pick as {@link resolvePick} now reads it. */
export function recordPickRemote(
  repo: string,
  value: string,
  remotes: readonly string[] | undefined,
): { remote: string; name: string; display: string } | null {
  const key = pickRemoteKey(repo, value);
  const split = parseRemoteCompareValue(value, remotes);
  if (split !== null && remotes !== undefined) {
    if (pickRemotes.get(key) !== split.remote) {
      pickRemotes.set(key, split.remote);
      notifyPickRemotes();
    }
  }
  return resolvePick(value, remotes, pickRemotes.get(key) ?? null);
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
 *  prefixes it, else the split against the current remotes list. */
export function resolvePick(
  value: string | null,
  remotes: readonly string[] | undefined,
  recorded: string | null,
): { remote: string; name: string; display: string } | null {
  const split = parseRemoteCompareValue(value, remotes);
  if (
    split === null ||
    recorded === null ||
    !split.display.startsWith(`${recorded}/`) ||
    split.display.length === recorded.length + 1
  )
    return split;
  return {
    remote: recorded,
    name: split.display.slice(recorded.length + 1),
    display: split.display,
  };
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

export interface RemoteCompareRow {
  /** The combobox value: `remote/name`. */
  display: string;
  /** The stored value: `refs/remotes/remote/name`. */
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
 * The picker's Remote rows: exactly the remote-branch list (every remote, each
 * remote's HEAD already dropped by the backend) minus two filters: agent
 * session branches, and a row whose `remote/name` equals an offered local name
 * (a local literally named `origin/x` would make two identical combobox values).
 * A remote branch merely sharing a local's bare name stays offered. Ordered by
 * remote (upstream, origin, then alphabetical), each remote's rows by recency.
 * Each row is re-split against `remotes` first: the backend splits at the
 * first "/", which mis-splits a remote whose name holds one.
 */
export function remoteCompareRows(
  remoteBranches: readonly RemoteBranch[] | undefined,
  localNames: ReadonlySet<string>,
  remotes?: readonly string[],
): RemoteCompareRow[] {
  return (remoteBranches ?? [])
    .map((b) => ({
      ...(splitRemoteDisplay(`${b.remote}/${b.name}`, remotes) ?? b),
      lastCommitDate: b.lastCommitDate,
    }))
    .filter((b) => !isSessionBranchName(b.name))
    .map((b) => ({
      remote: b.remote,
      display: `${b.remote}/${b.name}`,
      ref: remoteCompareValue(b.remote, b.name),
      lastCommitDate: b.lastCommitDate,
    }))
    .filter((r) => !localNames.has(r.display))
    .sort(
      (a, b) =>
        remoteRank(a.remote) - remoteRank(b.remote) ||
        a.remote.localeCompare(b.remote) ||
        b.lastCommitDate.localeCompare(a.lastCommitDate),
    )
    .map(({ display, ref, lastCommitDate }) => ({
      display,
      ref,
      lastCommitDate,
    }));
}

/** Why a remote pick can't be compared any more: the status line's words and
 *  the Create PR hold's reason, so the two never disagree. */
export const GONE_PICK_COPY: Record<
  "pruned" | "remote-gone" | "missing",
  (remote: string, name: string) => string
> = {
  pruned: (remote, name) => `${remote}/${name} was deleted on ${remote}.`,
  "remote-gone": (remote) => `${remote} is no longer a remote.`,
  // The ref is gone but no successful remotes read says why.
  missing: (remote, name) =>
    `${remote}/${name} is no longer in your remote branches.`,
};
