import { isSessionBranchName } from "@/lib/git/ref-name";
import type { RemoteBranch } from "@/lib/git/types";

/** The store keeps a remote pick as its FULL remote-tracking ref, so git never
 *  resolves a same-named local branch or tag instead; a local pick stays the
 *  bare branch name. */
export const REMOTE_REF_PREFIX = "refs/remotes/";

/** The picker's "Add upstream remote" row. ":" is illegal in a ref name, so no
 *  branch can collide with it. */
export const ADD_UPSTREAM_VALUE = "::add-upstream::";

/** Null for a local pick. Splits once on the first "/" after the prefix, the
 *  same split the backend's remote-branch list makes. */
export function parseRemoteCompareValue(
  v: string | null,
): { remote: string; name: string; display: string } | null {
  if (v === null || !v.startsWith(REMOTE_REF_PREFIX)) return null;
  const display = v.slice(REMOTE_REF_PREFIX.length);
  const slash = display.indexOf("/");
  if (slash <= 0 || slash === display.length - 1) return null;
  return {
    remote: display.slice(0, slash),
    name: display.slice(slash + 1),
    display,
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
 */
export function remoteCompareRows(
  remoteBranches: readonly RemoteBranch[] | undefined,
  localNames: ReadonlySet<string>,
): RemoteCompareRow[] {
  return (remoteBranches ?? [])
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
  "pruned" | "remote-gone",
  (remote: string, name: string) => string
> = {
  pruned: (remote, name) => `${remote}/${name} was deleted on ${remote}.`,
  "remote-gone": (remote) => `${remote} is no longer a remote.`,
};
