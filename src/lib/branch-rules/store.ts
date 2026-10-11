import { withAppStoreLock } from "@/lib/app-store-lock";
import { readRepoBranchRules, writeRepoBranchRules } from "@/lib/git/api";
import { foldIdentityKey, repoIdentity } from "@/lib/git/repo-identity";
import {
  memoizedStoreLoader,
  reloadToleratingEmptyStore,
} from "@/lib/plugin-store";
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

const STORE_FILE = "branch-rules.json";
const getStore = memoizedStoreLoader(STORE_FILE);

// Serializes this module's writes in-process; the cross-instance store lock inside
// each op covers the other processes.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  opChain = run.catch(() => undefined);
  return run;
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
  return serialize(async () => {
    const store = await getStore();
    // Identity resolves (a git spawn) before the lock. Fold BEFORE the set:
    // folding after would merge a stale legacy entry back over the fresh config.
    // The window where disk holds the merged value is harmless: a crash there leaves
    // valid data one save behind.
    const id = await repoIdentity(repo);
    await withAppStoreLock(STORE_FILE, async () => {
      await reloadToleratingEmptyStore(store);
      const key = await foldIdentityKey<BranchRulesConfig>(
        store,
        "branch-rules",
        repo,
        id,
        (identityVal, legacyVal) => identityVal ?? legacyVal,
      );
      await store.set(key, config);
      await store.save();
    });
  });
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
