import {
  ALL_MERGE_METHODS,
  type BranchProtection,
  type BranchRulesConfig,
  type MergeMethod,
} from "./types";

/**
 * Combines the repo's shared rules with the user's personal rules into the
 * single config that's actually enforced. Protections and promotion branches
 * are the union of both; the shared team naming policy wins when present, else
 * the personal one applies.
 */
export function mergeBranchRules(
  shared: BranchRulesConfig,
  personal: BranchRulesConfig,
): BranchRulesConfig {
  return {
    naming: shared.naming.enabled ? shared.naming : personal.naming,
    protections: [...shared.protections, ...personal.protections],
    promotionBranches: [
      ...shared.promotionBranches,
      ...personal.promotionBranches,
    ],
  };
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * fnmatch-style glob → anchored RegExp, matching GitHub's branch patterns:
 * `*` spans within a path segment, `**` spans across `/`, `?` is one non-slash
 * char, and `{a,b,c}` is alternation of literals. Everything else is literal.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const parts = glob
          .slice(i + 1, end)
          .split(",")
          .map(escapeLiteral);
        re += `(?:${parts.join("|")})`;
        i = end;
      }
    } else {
      re += escapeLiteral(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/** Whether `name` matches `glob`. A malformed glob simply matches nothing. */
export function matchesGlob(glob: string, name: string): boolean {
  try {
    return globToRegExp(glob).test(name);
  } catch {
    return false;
  }
}

/** Protections whose pattern matches `branch`. */
export function protectionsFor(
  config: BranchRulesConfig,
  branch: string,
): BranchProtection[] {
  return config.protections.filter(
    (p) => p.pattern.trim() !== "" && matchesGlob(p.pattern.trim(), branch),
  );
}

/**
 * Whether `branch` is configured as a promotion branch — a pull request FROM it
 * carries work onward rather than catching up, so the update-from-base offer is
 * withheld. The user's own assertion about this repository, so it needs no
 * topology check to back it up.
 */
export function isPromotionBranch(
  config: BranchRulesConfig,
  branch: string,
): boolean {
  return config.promotionBranches.some(
    (p) => p.trim() !== "" && matchesGlob(p.trim(), branch),
  );
}

/** Whether deleting `branch` is blocked by a protection. */
export function isDeletionBlocked(
  config: BranchRulesConfig,
  branch: string,
): boolean {
  return protectionsFor(config, branch).some((p) => p.blockDeletion);
}

/** Whether force-pushing `branch` (e.g. amending a pushed commit) is blocked. */
export function isForcePushBlocked(
  config: BranchRulesConfig,
  branch: string,
): boolean {
  return protectionsFor(config, branch).some((p) => p.blockForcePush);
}

/**
 * Whether `branch` requires a pull request — no direct commits to it and no
 * direct merges into it. Changes must come through a PR.
 */
export function requiresPullRequest(
  config: BranchRulesConfig,
  branch: string,
): boolean {
  return protectionsFor(config, branch).some((p) => p.requirePr);
}

/**
 * The merge methods allowed when integrating INTO `base`, intersected across
 * every matching protection. `null` means unrestricted (no protection applies).
 */
export function allowedMergeMethods(
  config: BranchRulesConfig,
  base: string,
): MergeMethod[] | null {
  const matched = protectionsFor(config, base);
  if (matched.length === 0) return null;
  return ALL_MERGE_METHODS.filter((m) =>
    matched.every((p) => p.allowedMergeMethods.includes(m)),
  );
}

/** Whether `method` may be used to integrate into `base`. */
export function isMergeMethodAllowed(
  config: BranchRulesConfig,
  base: string,
  method: MergeMethod,
): boolean {
  const allowed = allowedMergeMethods(config, base);
  return allowed === null || allowed.includes(method);
}

/** The human-readable naming requirement when a policy is active, else null. */
export function namingRequirement(config: BranchRulesConfig): string | null {
  const { naming } = config;
  const pattern = naming.pattern.trim();
  if (!naming.enabled || pattern === "") return null;
  const hint = naming.hint.trim();
  return hint
    ? `Branch names must match "${pattern}" (e.g. ${hint})`
    : `Branch names must match "${pattern}"`;
}

/**
 * An error message if `name` violates the naming policy, otherwise null.
 * Empty names pass (the form's `required` validator owns that case).
 */
export function branchNameError(
  config: BranchRulesConfig,
  name: string,
): string | null {
  if (name === "") return null;
  const req = namingRequirement(config);
  if (req === null) return null;
  return matchesGlob(config.naming.pattern.trim(), name) ? null : req;
}

/**
 * A non-blocking hint for the new-branch field: the naming requirement while
 * `name` doesn't yet satisfy the policy (shown for an empty field too, so the
 * convention is visible up front and a disabled Create button is explained).
 */
export function branchNameHint(
  config: BranchRulesConfig,
  name: string,
): string | null {
  const req = namingRequirement(config);
  if (req === null) return null;
  return matchesGlob(config.naming.pattern.trim(), name) ? null : req;
}
