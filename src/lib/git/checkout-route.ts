import type { ForgeProvider } from "./types";

/** Which engine runs a PR checkout: the gh CLI, or the app's own git engine. */
export type CheckoutRoute = "gh" | "native";

export type CheckoutFlavor = "plain" | "worktree";

/** The gh release that grew `pr checkout --worktree`. */
const WORKTREE_FLOOR: readonly [bigint, bigint, bigint] = [
  BigInt(2),
  BigInt(98),
  BigInt(0),
];

/** The largest value the backend's `u64` part parse accepts. */
const U64_MAX = BigInt("18446744073709551615");

/** Mirrors the backend's `gh_version_triple`: each part reads its leading ASCII
 *  digits as a `u64`, missing minor/patch read 0, and a part with no leading
 *  digit (the empty string included) or one past `u64::MAX` makes the whole
 *  version unparseable. BigInt, so no part is rounded on the way. */
function versionTriple(version: string): [bigint, bigint, bigint] | null {
  const parts = version.split(".");
  const read = (part: string | undefined): bigint | null => {
    if (part === undefined) return BigInt(0);
    const digits = /^[0-9]+/.exec(part)?.[0];
    if (digits === undefined) return null;
    const value = BigInt(digits);
    return value > U64_MAX ? null : value;
  };
  const major = read(parts[0]);
  const minor = read(parts[1]);
  const patch = read(parts[2]);
  if (major === null || minor === null || patch === null) return null;
  return [major, minor, patch];
}

function atLeastFloor(version: string): boolean {
  const v = versionTriple(version);
  if (v === null) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== WORKTREE_FLOOR[i]) return v[i] > WORKTREE_FLOOR[i];
  }
  return true;
}

/** The plain checkout stays on gh wherever GitHub is (or may be) the host: the
 *  native engine sets up tracking only for a proven same-repo PR, while gh also
 *  tracks a fork's head. The worktree flavor takes gh only on GitHub with a
 *  known gh at the floor; an unknown provider goes native, which re-detects the
 *  provider itself. `ghVersion` is the cached gh-accounts answer, undefined when
 *  nothing is cached. */
export function checkoutRoute(
  flavor: CheckoutFlavor,
  provider: ForgeProvider | null | undefined,
  ghVersion: string | undefined,
): CheckoutRoute {
  if (provider === "gitlab" || provider === "bitbucket") return "native";
  if (flavor === "plain") return "gh";
  if (provider !== "github" || ghVersion === undefined) return "native";
  return atLeastFloor(ghVersion) ? "gh" : "native";
}

export interface PrBranchFacts {
  provider: ForgeProvider | null | undefined;
  headRefName: string;
  /** The PR repository's default branch, which gh's fork naming keys on; null
   *  when unknown. */
  defaultBranchName: string | null;
  crossRepository: boolean | null | undefined;
  headRepositoryOwner: string | null | undefined;
}

/** The local branch the backend names a PR's worktree checkout, or null when no
 *  local branch can be trusted as the PR's. Only `crossRepository === true` is
 *  evidence of a fork; a non-fork shape earns the bare head only with a known
 *  owner, except on GitLab, whose owner is never set and whose cross flag is
 *  computed from project ids. */
export function prLocalBranch(
  pr: Omit<PrBranchFacts, "defaultBranchName">,
): string | null {
  const owner = pr.headRepositoryOwner?.trim() || null;
  if (pr.crossRepository === true)
    return owner === null ? null : `${owner}/${pr.headRefName}`;
  if (owner !== null || pr.provider === "gitlab") return pr.headRefName;
  return null;
}

/** Whether gh may name a fork's plain checkout bare: it owner-prefixes a fork
 *  head named like the default branch, so an unknown default can't rule it out. */
function forkHeadMayBeBare(pr: PrBranchFacts): boolean {
  return (
    pr.defaultBranchName !== null && pr.headRefName !== pr.defaultBranchName
  );
}

/** The branch the PLAIN checkout leaves checked out, or null when the frontend
 *  can't know it: gh names it by the bare head (a fork's only while
 *  `forkHeadMayBeBare`), the native engine as `prLocalBranch` does. */
export function plainCheckoutBranch(pr: PrBranchFacts): string | null {
  if (checkoutRoute("plain", pr.provider, undefined) !== "gh")
    return prLocalBranch(pr);
  return pr.crossRepository === true && !forkHeadMayBeBare(pr)
    ? null
    : pr.headRefName;
}

/** Every local branch name that reads as this PR checked out. A fork also
 *  matches its bare head where the plain checkout runs on gh, since gh names a
 *  fork's branch bare; the native engine names it `owner/head`. Not when the
 *  head is the default branch's name: gh prefixes that one too, so the bare name
 *  is the user's own branch. */
export function checkedOutNames(pr: PrBranchFacts): ReadonlySet<string> {
  const local = prLocalBranch(pr);
  if (local === null) return new Set();
  const names = new Set([local]);
  if (
    local !== pr.headRefName &&
    forkHeadMayBeBare(pr) &&
    checkoutRoute("plain", pr.provider, undefined) === "gh"
  )
    names.add(pr.headRefName);
  return names;
}
