/**
 * The synchronous half of finding a local clone for an issue or pull request
 * from any repository: which recents could hold it, the URL authority its origin
 * must answer with, and the spoken line for a slow open.
 *
 * Import-free at runtime on purpose (types only, erased):
 * `scripts/local-landing-match.test.mjs` loads it straight from `src/` under
 * Node's type stripping. A runtime import added here fails that test.
 */
import type { ForgeProvider } from "@/lib/git/types";
import type { RecentRepo } from "@/lib/settings/api";

/** What a surface knows about one issue or pull request, enough to find, prove
 *  and land a local clone of its repository. */
export interface LocalLandingTarget {
  provider: ForgeProvider;
  /** Forge host as the match key spells it ("github.com"); compared
   *  case-insensitively with RecentRepo.host and with the origin's host. */
  host: string;
  /** host[:port] lowercased, the default port dropped (URL.host); null when
   *  unknown, which never proves. */
  authority: string | null;
  repoOwner: string;
  repoName: string;
  /** "owner/name" as the forge spells it; compared with the origin path and
   *  with a PR head's repo. */
  repoFullName: string;
  number: number;
  isPullRequest: boolean;
}

/** The part of a target the synchronous candidate check reads. */
export type LocalMatchKey = Pick<
  LocalLandingTarget,
  "provider" | "host" | "repoOwner" | "repoName"
>;

/** Grace before a resolving open shows its wait. */
export const PENDING_AFFORDANCE_MS = 300;

/** Every provider id, as an exhaustive Record so widening `ForgeProvider` fails
 *  the build here rather than quietly narrowing `asForgeProvider`. */
const FORGE_PROVIDERS: Record<ForgeProvider, true> = {
  github: true,
  gitlab: true,
  bitbucket: true,
};

/** `RecentRepo.provider` is a stored string, so an id this build doesn't know
 *  fails over to the target's own provider rather than reaching the backend as a
 *  tag it can't deserialize — a rejection the open's deadline would swallow into
 *  a silent main-workspace landing. */
export function asForgeProvider(
  value: string | undefined,
): ForgeProvider | null {
  return value !== undefined && Object.hasOwn(FORGE_PROVIDERS, value)
    ? (value as ForgeProvider)
    : null;
}

/**
 * The host/owner/name test a recent must pass to look like the target's, or
 * null when the key can't supply one. Matches on `RecentRepo.repoName` (the name
 * the origin URL spells), falling back to `name`, the FOLDER basename, on rows
 * the owner probe hasn't touched: a heuristic both ways (a renamed clone never
 * matches; a folder named after another repo of the same owner can). A recent
 * missing `owner` or `host` never matches, nor does a key with an empty field.
 */
function localMatcher(
  key: Pick<LocalMatchKey, "host" | "repoOwner" | "repoName">,
): ((r: RecentRepo) => boolean) | null {
  const host = key.host.toLowerCase();
  const owner = key.repoOwner.toLowerCase();
  const name = key.repoName.toLowerCase();
  if (!host || !owner || !name) return null;
  return (r) =>
    !!r.host &&
    !!r.owner &&
    r.host.toLowerCase() === host &&
    r.owner.toLowerCase() === owner &&
    (r.repoName ?? r.name).toLowerCase() === name;
}

/**
 * EVERY recent repository that looks like the target's, in recents order. The
 * key is not always identity: a GitLab owner is only the segment before the repo
 * name, so two different projects can both answer it and only reading each
 * checkout's origin can say which is the target's.
 */
export function matchLocalRepos(
  key: Pick<LocalMatchKey, "host" | "repoOwner" | "repoName">,
  recents: readonly RecentRepo[],
): RecentRepo[] {
  const matches = localMatcher(key);
  return matches ? recents.filter(matches) : [];
}

/**
 * Whether a matched checkout's STORED classification can support opening the
 * target. Repo detection answers from glab's SAVED hosts while forge listings
 * also reach token-only hosts, so a clone of such a host can classify as GitHub
 * while its items arrive as GitLab. Only KNOWN disagreement drops here (no IPC):
 * an unclassified checkout passes, and the origin proof settles it live.
 */
export function providerAgrees(
  recent: RecentRepo,
  key: Pick<LocalMatchKey, "provider">,
): boolean {
  const stored = asForgeProvider(recent.provider);
  return stored === null || stored === key.provider;
}

/**
 * The checkouts an open may land on: key-matched AND classified compatibly. The
 * open resolves from this list and the display sites read it, so an affordance
 * never advertises a local landing the open refuses over a provider. The origin
 * proof is not part of it: it costs a git read per candidate, so it stays an
 * open-time check with the browser as its fallback.
 */
export function openableMatches(
  key: LocalMatchKey,
  recents: readonly RecentRepo[],
): RecentRepo[] {
  return matchLocalRepos(key, recents).filter((r) => providerAgrees(r, key));
}

/** `openableMatches` reduced to its yes/no, for display sites that ask once
 *  per row per render. */
export function hasOpenableMatch(
  key: LocalMatchKey,
  recents: readonly RecentRepo[],
): boolean {
  return matchLocalRepos(key, recents).some((r) => providerAgrees(r, key));
}

/** `new URL(url).host.toLowerCase()`, or null when it won't parse. `URL.host`
 *  drops the scheme's default port (`:443` on https) and keeps any other: the
 *  spelling the origin side answers with. */
export function urlAuthority(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** "Opening <repoName> issue <n>…" / "Opening <repoName> pull request <n>…"
 *  (the ellipsis is the single character U+2026). "pull request" for every
 *  provider, merge requests included, as the rows' type label reads. */
export function openingStatus(
  target: Pick<LocalLandingTarget, "repoName" | "isPullRequest" | "number">,
): string {
  const noun = target.isPullRequest ? "pull request" : "issue";
  return `Opening ${target.repoName} ${noun} ${target.number}…`;
}
