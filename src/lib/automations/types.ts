import type { ReviewMode } from "@/lib/ai/types";
import { matchesGlob } from "@/lib/branch-rules/match";

/** The moments an automation can fire on. */
export type LifecycleEvent = "commit" | "pr-open" | "pr-sync";

/** What an automation runs — the same modes as the manual Review tab. */
export type ActionId = ReviewMode; // "general" | "security"

/**
 * Which branches an action applies to. `include`/`exclude` are fnmatch-style
 * globs (see {@link matchesGlob}); an empty `include` means "all branches", and
 * `exclude` always wins over `include`. `match` chooses which branch a PR event
 * is tested against (a commit event only ever has one branch, so it's ignored).
 */
export interface BranchConditions {
  /** Globs; empty = all branches. */
  include: string[];
  /** Globs; a matching exclude beats any include. */
  exclude: string[];
  /** PR events only; ignored for commit. */
  match: "head" | "base" | "either";
}

/** One action cell: whether it fires, and the branches it's scoped to. */
export interface ActionConfig {
  enabled: boolean;
  conditions?: BranchConditions;
}

/** The actions configured for one lifecycle event. A missing action cell = off. */
export interface LifecycleConfig {
  actions: Partial<Record<ActionId, ActionConfig>>;
}

/** A repo's override of one action cell; `undefined` fields inherit the global. */
export interface RepoActionOverride {
  enabled?: boolean;
  conditions?: BranchConditions;
}

/** A repo's adjustments on top of the global lifecycle config. */
export interface RepoOverride {
  lifecycles: Partial<
    Record<LifecycleEvent, Partial<Record<ActionId, RepoActionOverride>>>
  >;
}

/**
 * The automations config, v2. Lifecycle-keyed rather than a flat rule list, so a
 * given lifecycle×action cell exists at most once — duplicates are structurally
 * unrepresentable.
 */
export interface AutomationsConfigV2 {
  schemaVersion: 2;
  lifecycles: Partial<Record<LifecycleEvent, LifecycleConfig>>;
  /** Keyed by the repo's worktree-stable identity (its common git dir), so a
   *  repo's overrides apply the same from the main checkout and every worktree.
   *  Older entries may still be keyed by a checkout path until the next save
   *  folds them onto the identity (see `repoEntry` / `repoAutomationsFor`). */
  repos: Record<string, RepoOverride>;
}

export const EMPTY_AUTOMATIONS_V2: AutomationsConfigV2 = {
  schemaVersion: 2,
  lifecycles: {},
  repos: {},
};

export const LIFECYCLE_LABELS: Record<LifecycleEvent, string> = {
  commit: "On commit",
  "pr-open": "On pull request opened",
  "pr-sync": "On new commits to a reviewed PR",
};

export const ACTION_LABELS: Record<ActionId, string> = {
  general: "AI code review",
  security: "AI security audit",
};

/** The action ids in a stable display order. */
export const ALL_ACTION_IDS: ActionId[] = ["general", "security"];

/**
 * A repo's per-repo overrides, looked up by its worktree-stable identity with a
 * legacy checkout-path fallback (until the next save folds the old key onto the
 * identity). Pure, so it's shared by the sync React consumers and the async store
 * helper — the caller resolves `identity` via `repoIdentity`/`useRepoIdentity`.
 */
export function repoEntry(
  config: AutomationsConfigV2,
  identity: string,
  repoPath: string,
): RepoOverride | undefined {
  return (
    config.repos[identity] ??
    (identity === repoPath ? undefined : config.repos[repoPath])
  );
}

/**
 * The actions that actually run for a repo and lifecycle, after merging the repo
 * override onto the global config. For each action cell: `enabled` is the repo
 * override's value when set, else the global's (an absent global cell counts as
 * disabled), and `conditions` likewise prefers the repo override. A repo override
 * can therefore ENABLE a cell that's globally off. Only merged-enabled cells are
 * returned. Pure + sync so it stays cheap on the hot path — the caller owns
 * identity resolution (see {@link repoEntry}).
 */
export function effectiveActions(
  config: AutomationsConfigV2,
  repo: RepoOverride | undefined,
  lifecycle: LifecycleEvent,
): { action: ActionId; conditions?: BranchConditions }[] {
  const global = config.lifecycles[lifecycle]?.actions ?? {};
  const overrides = repo?.lifecycles[lifecycle] ?? {};
  // Union of action ids present in either scope, so a repo-only enable surfaces.
  const ids = new Set<ActionId>([
    ...(Object.keys(global) as ActionId[]),
    ...(Object.keys(overrides) as ActionId[]),
  ]);
  const result: { action: ActionId; conditions?: BranchConditions }[] = [];
  for (const action of ALL_ACTION_IDS) {
    if (!ids.has(action)) continue;
    const g = global[action];
    const o = overrides[action];
    const enabled = o?.enabled ?? g?.enabled ?? false;
    if (!enabled) continue;
    const conditions = o?.conditions ?? g?.conditions;
    result.push({ action, conditions });
  }
  return result;
}

/**
 * Whether the user has ANY automation turned on anywhere — the question behind the
 * Settings → General note that hiding AI features pauses them. A repo override can
 * enable a cell the global config leaves off, so overrides count on their own.
 */
export function anyAutomationEnabled(config: AutomationsConfigV2): boolean {
  // Each `?? {}` fallback is annotated: an unannotated one widens `Object.values`
  // to `any[]`, which would silently accept a misspelled `.enabled`.
  const globalOn = Object.values(config.lifecycles).some((lifecycle) => {
    const actions: LifecycleConfig["actions"] = lifecycle?.actions ?? {};
    return Object.values(actions).some((a) => a?.enabled === true);
  });
  if (globalOn) return true;
  return Object.values(config.repos).some((repo) => {
    const lifecycles: RepoOverride["lifecycles"] = repo?.lifecycles ?? {};
    return Object.values(lifecycles).some((overrides) => {
      const cells: Partial<Record<ActionId, RepoActionOverride>> =
        overrides ?? {};
      return Object.values(cells).some((o) => o?.enabled === true);
    });
  });
}

/**
 * Whether an event's branch(es) satisfy an action's branch conditions. An action
 * runs iff `enabled` (checked by the caller) AND (`include` empty OR ≥1 include
 * glob matches) AND no `exclude` glob matches. Commit events test `event.branch`;
 * PR events test head / base / either per `conditions.match`. An empty/unknown
 * branch name matches no glob, so a non-empty `include` skips it and an `exclude`
 * can't fire on it. Undefined conditions always pass.
 */
export function branchConditionsPass(
  conditions: BranchConditions | undefined,
  event: {
    kind: LifecycleEvent;
    branch?: string;
    head?: string;
    base?: string;
  },
): boolean {
  if (!conditions) return true;
  const branches =
    event.kind === "commit"
      ? [event.branch ?? ""]
      : branchesForMatch(conditions.match, event.head ?? "", event.base ?? "");

  // Globs are trimmed and blank ones ignored, mirroring branch-rules'
  // `protectionsFor` — a pattern saved with stray whitespace still matches.
  const matchesAny = (globs: string[]) =>
    globs.some((g) => {
      const glob = g.trim();
      return (
        glob !== "" && branches.some((b) => b !== "" && matchesGlob(glob, b))
      );
    });

  // Exclude wins: any exclude glob matching any candidate branch skips the action.
  if (conditions.exclude.length > 0 && matchesAny(conditions.exclude)) {
    return false;
  }
  // Empty include = all branches; otherwise ≥1 include glob must match.
  if (conditions.include.length === 0) return true;
  return matchesAny(conditions.include);
}

/** The candidate branch(es) a PR event is tested against, per the match mode. */
function branchesForMatch(
  match: BranchConditions["match"],
  head: string,
  base: string,
): string[] {
  switch (match) {
    case "head":
      return [head];
    case "base":
      return [base];
    default:
      return [head, base];
  }
}
