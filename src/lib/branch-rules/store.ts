import { load, type Store } from "@tauri-apps/plugin-store";
import { readRepoBranchRules, writeRepoBranchRules } from "@/lib/git/api";
import { identityKeyFor, repoIdentity } from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";
import {
  ALL_MERGE_METHODS,
  type BranchProtection,
  type BranchRulesConfig,
  EMPTY_BRANCH_RULES,
  type MergeMethod,
  type NamingPolicy,
} from "./types";

/**
 * Heals a hand-edited `allowedMergeMethods`: absent = unrestricted (the documented
 * default), an array keeps only real methods, and ANY other shape allows NONE. Junk
 * fails CLOSED because a protection must never heal toward permissiveness — a bare
 * string like `"squash"` restricted by accident before this normalizer ran (the
 * matcher's `includes` was reading it as a substring test), so widening it to all
 * three would unblock merges the file asked to block.
 */
function healMergeMethods(value: unknown): MergeMethod[] {
  if (value == null) return [...ALL_MERGE_METHODS];
  if (!Array.isArray(value)) return [];
  const known: readonly string[] = ALL_MERGE_METHODS;
  return value.filter(
    (m): m is MergeMethod => typeof m === "string" && known.includes(m),
  );
}

/**
 * Coerces a loosely-typed (possibly older or hand-edited) config into a full
 * BranchRulesConfig, filling in per-field defaults so partial data never fails
 * to restrict. The one field that can GAIN a restriction from malformed input
 * is `allowedMergeMethods`, which fails closed — see {@link healMergeMethods}.
 * Shared by the personal store and the repo-committed
 * `.gitdesktop/branch-rules.json` file.
 */
export function normalizeBranchRules(saved: unknown): BranchRulesConfig {
  const obj = (saved ?? {}) as {
    naming?: Partial<NamingPolicy>;
    protections?: Partial<BranchProtection>[];
    promotionBranches?: unknown;
  };
  return {
    naming: { ...EMPTY_BRANCH_RULES.naming, ...obj.naming },
    protections: (obj.protections ?? []).map((p) => ({
      id: p.id ?? crypto.randomUUID(),
      pattern: p.pattern ?? "",
      blockDeletion: p.blockDeletion ?? false,
      blockForcePush: p.blockForcePush ?? false,
      requirePr: p.requirePr ?? false,
      allowedMergeMethods: healMergeMethods(p.allowedMergeMethods),
    })),
    // Typed loosely because the shared file is hand-editable: anything but an
    // array of strings yields no promotion branches rather than throwing away
    // the rest of the config.
    promotionBranches: Array.isArray(obj.promotionBranches)
      ? obj.promotionBranches.filter((p): p is string => typeof p === "string")
      : [],
  };
}

// ── Personal scope: app-data keyed by repo path, never committed ────────────

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("branch-rules.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Keyed by the repo's worktree-stable identity (not its checkout path) so a repo's
// personal branch rules apply the same from the main checkout and every worktree.
// The read prefers the identity key, falling back to a legacy checkout-path key
// (folded onto the identity key by the next save).
export async function loadBranchRules(
  repo: string,
): Promise<BranchRulesConfig> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  const saved =
    (await store.get(id)) ?? (id === repo ? undefined : await store.get(repo));
  return normalizeBranchRules(saved);
}

export async function saveBranchRules(
  repo: string,
  config: BranchRulesConfig,
): Promise<void> {
  const store = await getStore();
  // Resolve the identity key FIRST: identityKeyFor folds + deletes any legacy
  // checkout-path entry (writing the merged value), then we overwrite it with the
  // new config (persisted by the store's autoSave). This order is intentional —
  // folding AFTER store.set would merge the stale legacy entry back over the fresh
  // config. The brief window where disk holds the merged value is harmless: branch
  // rules are GUI-only, so a crash there just leaves valid data one save behind.
  const key = await identityKeyFor<BranchRulesConfig>(
    store,
    "branch-rules",
    repo,
    (identityVal, legacyVal) => identityVal ?? legacyVal,
  );
  await store.set(key, config);
}

// ── Shared scope: committed `<repo>/.gitdesktop/branch-rules.json` ───────────

export async function loadSharedBranchRules(
  repo: string,
): Promise<BranchRulesConfig> {
  const raw = await readRepoBranchRules(repo);
  if (!raw) return EMPTY_BRANCH_RULES;
  try {
    return normalizeBranchRules(JSON.parse(raw));
  } catch {
    // A malformed committed file shouldn't break the app — ignore it.
    return EMPTY_BRANCH_RULES;
  }
}

export async function saveSharedBranchRules(
  repo: string,
  config: BranchRulesConfig,
): Promise<void> {
  // Pretty-printed so the committed file stays diff-friendly.
  await writeRepoBranchRules(repo, `${JSON.stringify(config, null, 2)}\n`);
}
