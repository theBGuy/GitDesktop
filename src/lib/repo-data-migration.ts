import { load } from "@tauri-apps/plugin-store";
import { repoIdentity } from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";

// Best-effort migration of every per-repo app-data store when a recents row is
// *relocated* — the user pointed GitDesktop at a repo's new folder after it moved
// on disk (see features/repository/useOpenRepoByPath.ts). The relocate row-rewrite
// only moves the settings.json recents entry; every other per-repo store still keys
// its data under the OLD location, which would orphan the repo's local PRs/issues,
// review history + drafts, review notes, automations config, Jira link, etc. This
// re-homes each store's entries onto the new identity key.
//
// **Why TS-side, not Rust:** every store here is a `@tauri-apps/plugin-store` file
// that returns ONE shared instance per file app-wide. Loading a file here via the
// same `storeName()` wrapper + load options mutates the exact instance the feature
// modules cache, so the change is coherent with their in-memory state (a Rust-side
// file rewrite behind the plugin's back would be silently overwritten on the next
// autosave). We `reload()` before each mutation because `local-prs.json` and
// `review-notes.json` are also written by the Rust MCP server — reload-before-mutate
// is the repo's established reconcile pattern, and it's harmless for the rest.
//
// **Why the old key can't be recomputed:** a repo's identity key is
// `git rev-parse --git-common-dir` on its checkout, but the old folder no longer
// exists so git can't resolve it. Instead we match stored keys against the old path
// in its two possible on-disk forms:
//   - the identity form of a main checkout: `<oldPath>/.git`
//   - a legacy raw-path key or an identity-fallback key: `<oldPath>` verbatim
// (both forms may coexist across stores, or even within one store, so we collect
// ALL matches). Matching is case-insensitive because Windows paths differ in case
// in the wild (e.g. `C:\temp` vs `C:\Temp`); a false merge would require two
// distinct repos on a case-sensitive filesystem at paths differing only by case,
// one of them at the exact old location of an explicitly relocated row —
// acceptable and documented.
//
// **Merge classes** (how an old value combines with any value already under the
// new key):
//   - `id-merge`   — arrays of `{ id }` records: keep new-key records, append old
//                    records whose id isn't already present.
//   - `inner-key`  — `Record`-valued maps: spread old then new, so the new key's
//                    inner entries win per inner key.
//   - `keep-new`   — single values: keep the new-key value if present, else move
//                    the old one.
// plans.json / research.json are handled separately: their items carry a RAW
// checkout `repoPath` (not an identity key), rewritten from old to new in place.
//
// **Deliberate exclusions:** settings.json (the relocate row-rewrite already moved
// it); sessions/*.jsonl (Rust-owned append-only, and a moved repo's session
// worktrees are broken at the git level regardless); notifications.json (transient
// 50-cap inbox); scripts / analytics / agent-numbers / jira-field-maps (global or
// per-site, not per-repo).
//
// **Accepted residual — concurrent writers:** this surgery runs outside the feature
// modules' own serialized write queues, so a peer write landing between a store's
// `reload()` and `save()` (an automation runner, an MCP-server write) loses to our
// whole-object write-back. The window is milliseconds wide and requires relocating
// a repo at the exact moment a background writer fires; it matches the risk the
// MCP-vs-GUI dual-writer stores already carry by design (reload-before-mutate).

/** Load a store with the exact shared-instance options every feature module uses,
 *  so we mutate the same cached instance rather than a private copy. */
function loadStore(file: string) {
  return load(storeName(file), { autoSave: true, defaults: {} });
}

/** Normalize a path/key for comparison: forward slashes, no trailing slash,
 *  lower-cased (Windows paths differ in case in the wild). */
function norm(s: string): string {
  return s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** How a store's per-repo values combine when both the old and new keys hold data. */
type MergeClass = "id-merge" | "inner-key" | "keep-new";

/** An identity-keyed store: a top-level `Record<repoKey, V>` we re-home by key. */
interface IdentityStore {
  file: string;
  merge: MergeClass;
  /** For nested layouts (automations.json), the top-level key holding the config
   *  object, plus how to read/write the per-repo `Record<repoKey, V>` within it. */
  nested?: {
    configKey: string;
    getMap: (
      config: Record<string, unknown>,
    ) => Record<string, unknown> | undefined;
  };
}

const IDENTITY_STORES: IdentityStore[] = [
  { file: "local-prs.json", merge: "id-merge" },
  { file: "local-issues.json", merge: "id-merge" },
  { file: "pr-reviews.json", merge: "id-merge" },
  { file: "pr-review-drafts.json", merge: "inner-key" },
  { file: "review-notes.json", merge: "inner-key" },
  { file: "automation-dismissals.json", merge: "inner-key" },
  { file: "own-comments-digest.json", merge: "inner-key" },
  { file: "jira-links.json", merge: "keep-new" },
  { file: "repo-lens.json", merge: "keep-new" },
  { file: "branch-rules.json", merge: "keep-new" },
  {
    file: "automations.json",
    merge: "keep-new",
    nested: {
      configKey: "config",
      getMap: (config) => {
        const repos = (config as { repos?: unknown }).repos;
        return repos && typeof repos === "object" && !Array.isArray(repos)
          ? (repos as Record<string, unknown>)
          : undefined;
      },
    },
  },
];

/** plans.json / research.json: `Record<topKey, Item[]>` whose items carry a raw
 *  checkout `repoPath` field (not an identity key). */
const RAW_PATH_STORES: { file: string; key: string }[] = [
  { file: "plans.json", key: "plans" },
  { file: "research.json", key: "research" },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Merge two id-bearing arrays: keep-array records first, append old records whose
 *  id isn't already present. Non-object/idless entries in the old array are dropped
 *  (they can't be de-duped and shouldn't shadow real records). */
function mergeIds(keep: unknown[], old: unknown[]): unknown[] {
  const seen = new Set(
    keep.filter((r): r is { id: unknown } => isRecord(r)).map((r) => r.id),
  );
  const extra = old.filter(
    (r): r is { id: unknown } =>
      isRecord(r) && !seen.has((r as { id: unknown }).id),
  );
  return [...keep, ...extra];
}

/** Collect the old-key candidates present in `keys` that match `oldPath` (either
 *  the `<oldPath>/.git` identity form or the raw `<oldPath>` form), ordered so the
 *  `/.git` form comes first (it wins on inner-value collisions). Never returns
 *  `newKey` itself. */
function matchingOldKeys(
  keys: string[],
  oldPath: string,
  newKey: string,
): string[] {
  const dotGit = `${norm(oldPath)}/.git`;
  const raw = norm(oldPath);
  const newNorm = norm(newKey);
  const gitForm: string[] = [];
  const rawForm: string[] = [];
  for (const k of keys) {
    const nk = norm(k);
    if (nk === newNorm) continue;
    if (nk === dotGit) gitForm.push(k);
    else if (nk === raw) rawForm.push(k);
  }
  // `/.git`-form values win over raw-form on collision, so list them first.
  return [...gitForm, ...rawForm];
}

/** Fold the values under all matched old keys into one, per the merge class (the
 *  first-listed old key, the `/.git` form, wins on collision), then combine that
 *  onto whatever's under `newKey`. Returns the value to store under `newKey`, or
 *  `undefined` when the combined result should NOT create an entry (empty map). */
function combine(
  merge: MergeClass,
  newVal: unknown,
  oldVals: unknown[],
): unknown {
  if (merge === "id-merge") {
    const keep = Array.isArray(newVal) ? newVal : [];
    // Fold the old arrays together first (the `/.git` form, oldVals[0], wins on a
    // shared id since it's the accumulator base), then fold that onto the new key.
    let mergedOld: unknown[] = [];
    for (const v of oldVals) {
      if (Array.isArray(v)) mergedOld = mergeIds(mergedOld, v);
    }
    return mergeIds(keep, mergedOld);
  }
  if (merge === "inner-key") {
    // Fold old maps together with the first-listed (`/.git`) form winning, then
    // let the new key's inner entries win over all of them.
    const mergedOld: Record<string, unknown> = {};
    // Iterate in reverse so earlier-listed old keys overwrite later ones.
    for (let i = oldVals.length - 1; i >= 0; i--) {
      const v = oldVals[i];
      if (isRecord(v)) Object.assign(mergedOld, v);
    }
    const newInner = isRecord(newVal) ? newVal : {};
    const result = { ...mergedOld, ...newInner };
    // Empty map → don't create an entry (review-notes treats empty as delete).
    return Object.keys(result).length > 0 ? result : undefined;
  }
  // keep-new: the new key's value wins when present; else the first old value.
  return newVal !== undefined ? newVal : oldVals[0];
}

/** Migrate one identity-keyed store (optionally nested inside a config object). */
async function migrateIdentityStore(
  desc: IdentityStore,
  oldPath: string,
  newKey: string,
): Promise<void> {
  const store = await loadStore(desc.file);
  await store.reload();

  if (desc.nested) {
    const { configKey, getMap } = desc.nested;
    const config = await store.get<unknown>(configKey);
    if (!isRecord(config)) return;
    const map = getMap(config);
    if (!isRecord(map)) return;
    const oldKeys = matchingOldKeys(Object.keys(map), oldPath, newKey);
    if (oldKeys.length === 0) return;
    const oldVals = oldKeys.map((k) => map[k]);
    const combined = combine(desc.merge, map[newKey], oldVals);
    if (combined !== undefined) map[newKey] = combined;
    for (const k of oldKeys) delete map[k];
    await store.set(configKey, config);
    await store.save();
    return;
  }

  const oldKeys = matchingOldKeys(await store.keys(), oldPath, newKey);
  if (oldKeys.length === 0) return;
  const oldVals = await Promise.all(oldKeys.map((k) => store.get<unknown>(k)));
  const newVal = await store.get<unknown>(newKey);
  const combined = combine(desc.merge, newVal, oldVals);
  if (combined !== undefined) await store.set(newKey, combined);
  for (const k of oldKeys) await store.delete(k);
  await store.save();
}

/** Migrate one raw-path store: rewrite each item's `repoPath` from old to new. */
async function migrateRawPathStore(
  file: string,
  key: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const store = await loadStore(file);
  await store.reload();
  const items = await store.get<unknown>(key);
  if (!Array.isArray(items)) return;
  const rawOld = norm(oldPath);
  let changed = false;
  for (const item of items) {
    if (
      isRecord(item) &&
      typeof item.repoPath === "string" &&
      norm(item.repoPath) === rawOld
    ) {
      item.repoPath = newPath;
      changed = true;
    }
  }
  if (!changed) return;
  await store.set(key, items);
  await store.save();
}

/**
 * Re-home every per-repo app-data store from `oldPath` to `newPath` after a repo
 * was relocated on disk. Best-effort and never throws: each store is migrated in
 * its own try/catch (a corrupt store can't sink the rest), and the whole function
 * has a top-level catch. Skips any store where nothing matches — it never rewrites
 * a file that didn't change.
 */
export async function migrateRepoData(
  oldPath: string,
  newPath: string,
): Promise<void> {
  try {
    // Even a fallback (raw-path) new key is fine to proceed with — the stores' own
    // legacy folding will re-home it onto the true identity later.
    const newKey = await repoIdentity(newPath);
    for (const desc of IDENTITY_STORES) {
      try {
        await migrateIdentityStore(desc, oldPath, newKey);
      } catch {
        // Unreadable/corrupt store — skip it, migrate the rest.
      }
    }
    for (const { file, key } of RAW_PATH_STORES) {
      try {
        await migrateRawPathStore(file, key, oldPath, newPath);
      } catch {
        // Unreadable/corrupt store — skip it, migrate the rest.
      }
    }
  } catch {
    // Identity resolution or anything unforeseen — the open must never block on us.
  }
}
