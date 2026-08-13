import type { ForgeRepo, ForgeSearchRepo } from "@/lib/git/types";

/** Compact star/number formatting (1.2k) — module-level so it's built once. */
export const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** A flat, virtualizer-friendly view of owner-grouped repos: a header row per
 *  owner followed by that owner's repos. */
export type ExploreRow =
  | { kind: "header"; owner: string }
  | { kind: "repo"; repo: ForgeSearchRepo };

/**
 * Map a {@link ForgeRepo} (the "your repos" shape) onto the richer
 * {@link ForgeSearchRepo} the Explore rows render — the fields search supplies
 * (stars, language, updatedAt, webUrl, defaultBranch) are null/absent for your
 * own listed repos, so the row degrades gracefully.
 */
export function forgeRepoToSearchRepo(repo: ForgeRepo): ForgeSearchRepo {
  return {
    fullName: repo.fullName,
    owner: repo.owner,
    name: repo.name,
    private: repo.private,
    archived: repo.archived,
    fork: repo.fork,
    cloneUrl: repo.cloneUrl,
    sshUrl: repo.sshUrl,
    description: repo.description,
    updatedAt: repo.pushedAt,
    stars: null,
    language: null,
    webUrl: null,
    defaultBranch: null,
  };
}

/**
 * Group repos by owner — the viewer's own repos first, then other owners
 * alphabetically — and flatten to rows for the virtualizer. Each group keeps its
 * incoming order. Mirrors CloneRepoDialog's `rows` memo so the two surfaces order
 * identically.
 */
export function groupReposByOwner(
  repos: ForgeSearchRepo[],
  viewer: string | null,
): ExploreRow[] {
  const byOwner = new Map<string, ForgeSearchRepo[]>();
  for (const r of repos) {
    const list = byOwner.get(r.owner);
    if (list) list.push(r);
    else byOwner.set(r.owner, [r]);
  }
  const owners = [...byOwner.entries()].sort((a, b) => {
    if (viewer) {
      if (a[0] === viewer) return -1;
      if (b[0] === viewer) return 1;
    }
    return a[0].toLowerCase().localeCompare(b[0].toLowerCase());
  });
  return owners.flatMap(([owner, list]): ExploreRow[] => [
    { kind: "header", owner },
    ...list.map((repo) => ({ kind: "repo" as const, repo })),
  ]);
}

/**
 * Visible text + self-contained accessible label for a star count (role="img"
 * suppresses descendants, so the label must carry number AND unit itself).
 */
export function starParts(
  stars: number | null,
): { text: string; label: string } | null {
  if (stars === null) return null;
  const text = compactNumber.format(stars);
  return { text, label: `${text} ${stars === 1 ? "star" : "stars"}` };
}

/** Stable DOM id per result row, so the search input's aria-activedescendant can
 *  point at the keyboard-highlighted option for screen readers. */
export const exploreOptionId = (fullName: string) =>
  `explore-repo-${fullName.replace(/[^\w-]/g, "_")}`;

export const EXPLORE_LISTBOX_ID = "explore-repo-listbox";
