/**
 * The async half of opening an issue or pull request in a local clone: prove
 * which candidate checkout really is the target's repository, then pick where
 * to land in it (its main workspace, or the worktree holding a PR's proven head
 * branch). Every leg runs under ONE budget, the first folder check included, and
 * every unknown falls to the safe answer: the browser, the main workspace, or
 * the matched checkout.
 */
import { forgePrHeadRef, repoOriginPath, validateRepo } from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import type {
  ForgeProvider,
  PrHeadRef,
  RepoInfo,
  RepoOrigin,
} from "@/lib/git/types";
import { listUserWorktrees, type UserWorktree } from "@/lib/git/worktree";
import type { RecentRepo } from "@/lib/settings/api";
import { asForgeProvider, type LocalLandingTarget } from "./match";

/** One budget for the whole resolve, the first folder check included. Opening
 *  must stay a keypress-fast action and any leg can block for seconds (a stalled
 *  network mount, a slow forge), so legs that spend the budget leave nothing for
 *  later ones, which fall back to the safe landing. */
export const LOCAL_LANDING_BUDGET_MS = 1500;

export type LocalLanding =
  | { kind: "local"; path: string; name: string }
  | { kind: "browser"; reason: "no-candidate" | "unproven" }
  | { kind: "browser"; reason: "stale"; path: string; error: unknown }
  | { kind: "superseded" };

export interface LocalLandingOptions {
  /** false = the main workspace even when a worktree holds the PR's head
   *  (My Work's Shift+Enter / shift-click / context menu). Ignored for issues. */
  preferWorktree: boolean;
  /** The caller's own supersession test, read after every await. */
  superseded: () => boolean;
}

/** Resolves `work` against what's left of `deadline`, answering `fallback` on
 *  both rejection and expiry: the caller treats slow and broken alike. */
function withDeadline<T>(
  work: Promise<T>,
  deadline: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(
        () => resolve(fallback),
        Math.max(0, deadline - Date.now()),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

type Raced =
  | { kind: "value" }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

/** `withDeadline` for a leg that must tell a rejection (its error is the
 *  stale-path evidence) from an expiry (which is evidence of nothing). */
function raceDeadline(
  work: Promise<unknown>,
  deadline: number,
): Promise<Raced> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race<Raced>([
    work.then(
      () => ({ kind: "value" }),
      (error: unknown) => ({ kind: "error", error }),
    ),
    new Promise<Raced>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: "timeout" }),
        Math.max(0, deadline - Date.now()),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * A checkout's navigation target, or null when it can't be validated in time.
 * `root` rather than the caller's path: git prints worktree paths with forward
 * slashes while validate_repo answers the canonical spelling, and every
 * repo-identity consumer compares that form as a plain string, so two spellings
 * of one checkout would read as two different repos.
 */
async function resolveTarget(
  path: string,
  deadline: number,
): Promise<{ path: string; name: string } | null> {
  // A spent budget would race git against a zero-length timeout and discard the
  // result — don't spawn the process at all.
  if (Date.now() >= deadline) return null;
  const info = await withDeadline<RepoInfo | null>(
    validateRepo(path),
    deadline,
    null,
  );
  return info ? { path: info.root, name: info.name } : null;
}

/** Whether `repoPath`'s origin is the target's repository on the target's
 *  instance and integration. Every axis must match: the key's host is a stored
 *  value a re-pointed remote leaves stale, two ports are two instances, and host
 *  plus authority both count so a drift between them opens the browser, never a
 *  wrong repo. `provider` is the live verdict `providerAgrees` can't see. Every
 *  unknown (slow or failed read, empty field, null authority) answers false. */
async function originMatches(
  target: LocalLandingTarget,
  repoPath: string,
  deadline: number,
): Promise<boolean> {
  const origin = await withDeadline<RepoOrigin | null>(
    repoOriginPath(repoPath),
    deadline,
    null,
  );
  const authority = target.authority;
  if (
    origin === null ||
    authority === null ||
    origin.host === "" ||
    origin.authority === "" ||
    origin.path === "" ||
    origin.provider === ""
  ) {
    return false;
  }
  return (
    origin.path.toLowerCase() === target.repoFullName.toLowerCase() &&
    origin.host.toLowerCase() === target.host.toLowerCase() &&
    origin.authority.toLowerCase() === authority &&
    origin.provider === target.provider
  );
}

/**
 * The first candidate whose origin really is the target's repository, else
 * null. Both clones of an ambiguous key can be in recents, so one failed proof
 * says nothing about the rest. Sequential and bounded: an expiry mid-loop stops
 * proving, which the caller treats like any other unproven match, and so does a
 * retired open, which starts no further origin read.
 */
async function provenCandidate(
  target: LocalLandingTarget,
  candidates: readonly RecentRepo[],
  deadline: number,
  superseded: () => boolean,
): Promise<RecentRepo | null> {
  for (const candidate of candidates) {
    if (superseded()) return null;
    // A spent budget would race git against a zero-length timeout and discard
    // the result — stop rather than spawn one per remaining candidate.
    if (Date.now() >= deadline) return null;
    if (await originMatches(target, candidate.path, deadline)) return candidate;
  }
  return null;
}

/**
 * The repo's main worktree when `repoPath` is itself a linked one, else null.
 * A worktree opened through the folder picker lands in recents like any other
 * checkout, so a matched candidate can't be assumed to be the main workspace.
 */
function mainWorktreeOf(
  worktrees: UserWorktree[],
  repoPath: string,
): string | null {
  const main = worktrees.find((w) => w.isMain);
  // normPath for comparison only — git spells worktree paths with forward
  // slashes where validate_repo hands back Windows separators.
  if (!main || normPath(main.path) === normPath(repoPath)) return null;
  return main.path;
}

/**
 * The worktree whose checked-out branch is provably this PR's head, else null.
 * Every unknown (a slow or failed head-ref read, an unproven head, no branch
 * match) is a null. Candidates are not filtered against `repoPath`: a head
 * checked out in the matched checkout itself is still the proven answer, which
 * keeps the main-workspace preference from pulling the user off their branch.
 */
async function branchWorktreeOf(
  target: LocalLandingTarget,
  worktrees: UserWorktree[],
  repoPath: string,
  provider: ForgeProvider,
  deadline: number,
): Promise<string | null> {
  const candidates = worktrees.filter((w) => w.branch !== "");
  if (candidates.length === 0) return null;
  // A spent budget would race the forge CLI against a zero-length timeout and
  // discard the result — don't spawn the process at all.
  if (Date.now() >= deadline) return null;
  const head = await withDeadline<PrHeadRef | null>(
    forgePrHeadRef(provider, repoPath, target.number),
    deadline,
    null,
  );
  // A fork PR's head branch lives in another repository, where the same branch
  // name routinely exists locally too: only a head slug matching the target's
  // repo proves a local branch IS the PR's.
  if (
    !head ||
    head.headRefName === "" ||
    head.headRepoFullName.toLowerCase() !== target.repoFullName.toLowerCase()
  ) {
    return null;
  }
  // Exact compare: git branch names are case-sensitive.
  return candidates.find((w) => w.branch === head.headRefName)?.path ?? null;
}

/** Never rejects. `candidates` is the caller's `openableMatches(...)` result,
 *  in recents order. */
export async function resolveLocalLanding(
  target: LocalLandingTarget,
  candidates: readonly RecentRepo[],
  opts: LocalLandingOptions,
): Promise<LocalLanding> {
  // Callers `void` the open, so a throw (an IPC answer of an unexpected shape)
  // must land as the safe answer rather than an unhandled rejection.
  try {
    return await resolveLanding(target, candidates, opts);
  } catch {
    // A retired open must not come back as the browser; a throwing test of
    // the caller's own is no answer either way.
    try {
      if (opts.superseded()) return { kind: "superseded" };
    } catch {
      // Falls through to the safe answer.
    }
    return { kind: "browser", reason: "unproven" };
  }
}

async function resolveLanding(
  target: LocalLandingTarget,
  candidates: readonly RecentRepo[],
  opts: LocalLandingOptions,
): Promise<LocalLanding> {
  // Taken before the first IPC, so the folder check below spends the same
  // budget as every later leg.
  const deadline = Date.now() + LOCAL_LANDING_BUDGET_MS;
  const { superseded } = opts;
  if (candidates.length === 0)
    return { kind: "browser", reason: "no-candidate" };
  // Recents outlive deleted and moved clones, so the first candidate's folder
  // is checked before anything is read from it. A timeout is no evidence of a
  // stale path, and it has spent the budget every later leg needs.
  const first = await raceDeadline(validateRepo(candidates[0].path), deadline);
  if (superseded()) return { kind: "superseded" };
  if (first.kind === "timeout") return { kind: "browser", reason: "unproven" };
  // A first candidate whose folder check errored ends a single-candidate open
  // and is left out of the proof otherwise: the backend can answer a path's
  // origin from its remote-URL cache without touching the folder, so a proof
  // of that path is no evidence the checkout still opens.
  if (first.kind === "error" && candidates.length === 1) {
    return {
      kind: "browser",
      reason: "stale",
      path: candidates[0].path,
      error: first.error,
    };
  }
  // Which candidate really is the target's is settled first in the budget,
  // ahead of the optional worktree legs, which may spend the rest of it.
  const proven = await provenCandidate(
    target,
    first.kind === "error" ? candidates.slice(1) : candidates,
    deadline,
    superseded,
  );
  if (superseded()) return { kind: "superseded" };
  if (!proven) return { kind: "browser", reason: "unproven" };
  // Listed once and shared by both preferences. Never pruned: an open must not
  // mutate another repository's worktree records.
  const worktrees = await withDeadline(
    listUserWorktrees(proven.path, { prune: false }),
    deadline,
    [],
  );
  if (superseded()) return { kind: "superseded" };
  // The main-workspace fallback is resolved before the optional network leg can
  // spend the budget, so landing there never depends on the head-ref read.
  const mainPath = mainWorktreeOf(worktrees, proven.path);
  // Proving a head matters only when a branch-bearing checkout sits somewhere
  // other than the fallback; otherwise every outcome is the path already held.
  const fallbackPath = mainPath ?? proven.path;
  const lookupCanMove = worktrees.some(
    (w) => w.branch !== "" && normPath(w.path) !== normPath(fallbackPath),
  );
  let landing: { path: string; name: string } | null = null;
  if (mainPath) {
    landing = await resolveTarget(mainPath, deadline);
    if (superseded()) return { kind: "superseded" };
  }
  if (lookupCanMove && target.isPullRequest && opts.preferWorktree) {
    // `providerAgrees` already dropped candidates whose stored provider
    // contradicts the target; the fallback covers unclassified ones.
    const branch = await branchWorktreeOf(
      target,
      worktrees,
      proven.path,
      asForgeProvider(proven.provider) ?? target.provider,
      deadline,
    );
    if (superseded()) return { kind: "superseded" };
    if (branch && normPath(branch) === normPath(proven.path)) {
      // The proven head is the matched checkout itself: stay on the user's own
      // branch rather than moving them to the main workspace.
      landing = null;
    } else if (branch) {
      const branchTarget = await resolveTarget(branch, deadline);
      if (superseded()) return { kind: "superseded" };
      // A branch that won't validate keeps whatever landing is already held.
      if (branchTarget) landing = branchTarget;
    }
  }
  return landing
    ? { kind: "local", path: landing.path, name: landing.name }
    : { kind: "local", path: proven.path, name: proven.name };
}
