/** Which repository a fork's PR/issue surfaces read & write against: the fork
 *  itself ("origin") or its parent ("upstream"). GitHub-only — GitLab/Bitbucket
 *  arms ignore it, so the frontend gates the lens UI to GitHub forks. */
export type RemoteLens = "origin" | "upstream";

/** Server-side list filter for the PR/issue panels. Axes AND-combine; values within
 *  an axis OR-combine. Absent/empty axis = no constraint. The three "mine" members
 *  form ONE OR-union group (assigned OR review-requested OR team-review-requested). */
export interface RemoteListFilter {
  assignedToMe?: boolean;
  reviewRequestedMe?: boolean;
  /** Org-qualified team slugs ("org/slug"), pre-validated against useMyTeams. */
  teams?: string[];
  authors?: string[];
  labels?: string[];
}

/** The boolean axes of {@link RemoteListFilter}, in canonical key order. */
const REMOTE_LIST_FILTER_FLAGS = ["assignedToMe", "reviewRequestedMe"] as const;

/** The list-valued axes of {@link RemoteListFilter}, in canonical key order. */
const REMOTE_LIST_FILTER_LISTS = ["teams", "authors", "labels"] as const;

/**
 * Canonical cache-key form: "" when the filter is empty/null, else a stable string —
 * sorted arrays, dropped empty axes — so two equal filters serialize identically.
 * INVARIANT: a `false` flag and an absent flag are the same filter, as are an empty
 * array and an absent array; both normalize away before serializing.
 */
export function remoteListFilterKey(
  f: RemoteListFilter | null | undefined,
): string {
  if (!f) return "";
  const parts: string[] = [];
  for (const flag of REMOTE_LIST_FILTER_FLAGS) {
    if (f[flag] === true) parts.push(flag);
  }
  for (const axis of REMOTE_LIST_FILTER_LISTS) {
    const values = f[axis];
    if (!values || values.length === 0) continue;
    // JSON-encoded rather than joined, over a COPY (never sort the caller's array):
    // label names and logins may contain the separator, so a plain join would let
    // `["x,y"]` and `["x","y"]` — different server queries — share one cache key.
    parts.push(`${axis}:${JSON.stringify([...values].sort())}`);
  }
  return parts.join("|");
}
