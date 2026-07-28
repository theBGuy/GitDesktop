import { load } from "@tauri-apps/plugin-store";
import { repoIdentity } from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";

// Best-effort re-homing of every per-repo app-data store when a recents row is
// *relocated* (features/repository/useOpenRepoByPath.ts): that rewrite moves only
// the settings.json entry, so every other store still keys its data under the OLD
// location and would orphan it.
//
// TS-side, not Rust: each store is one shared `@tauri-apps/plugin-store` instance
// app-wide, so loading it here with the same `storeName()` + options mutates the
// instance the feature modules cache — a Rust rewrite behind the plugin's back
// would be lost to the next autosave. `reload()` first because local-prs.json and
// review-notes.json are also written by the Rust MCP server.
//
// The old key can't be recomputed (`--git-common-dir` needs the vanished folder),
// so we match both on-disk forms of the old path — `<oldPath>/.git` (identity) and
// `<oldPath>` verbatim (legacy raw / identity fallback) — collecting ALL matches,
// case-insensitively (Windows paths differ in case in the wild); a false merge
// would need two distinct repos on a case-sensitive filesystem at paths differing
// only by case, one at the exact old location of an explicitly relocated row.
//
// Merge classes — how an old value combines with any value already under the
// new key:
//   - `id-merge`  — arrays of `{ id }`: keep new-key records, append old records
//                   whose id isn't already present.
//   - `inner-key` — `Record`-valued maps: spread old then new, so the new key's
//                   inner entries win per inner key.
//   - `keep-new`  — single values: keep the new-key value if present, else the old.
//
// plans.json / research.json are handled separately: their items carry a RAW
// checkout `repoPath`, rewritten in place.
//
// Deliberately excluded: settings.json (already moved), sessions/*.jsonl (Rust-owned
// append-only; a moved repo's session worktrees are broken at the git level anyway),
// notifications.json (transient), scripts / analytics / agent-numbers /
// jira-field-maps (not per-repo).
//
// Accepted residuals: this runs outside the feature modules' serialized write queues,
// so a peer write landing between a store's reload() and save() loses to our
// write-back; and a store that throws mid-migration orphans its old-key data
// permanently — nothing retries on reopen, and the stores' own legacy folding only
// re-homes the CURRENT checkout's raw-path key, never the departed `<oldPath>/.git`
// key.

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

/** Merge two id-bearing arrays: `keep` first, then old records whose id isn't
 *  already present. First occurrence of an id wins — within `old` as well as
 *  across the two arrays — and `undefined` is an id like any other, so an idless
 *  record suppresses every later idless old one. `keep` itself passes through
 *  verbatim (never deduped); non-object old entries are dropped (they can't be
 *  deduplicated). */
function mergeIds(keep: unknown[], old: unknown[]): unknown[] {
  const seen = new Set(
    keep.filter((r): r is { id: unknown } => isRecord(r)).map((r) => r.id),
  );
  const extra: unknown[] = [];
  for (const r of old) {
    if (!isRecord(r) || seen.has(r.id)) continue;
    seen.add(r.id);
    extra.push(r);
  }
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
    // oldVals[0] (the `/.git` form) is the accumulator base, so it wins on a shared id.
    let mergedOld: unknown[] = [];
    for (const v of oldVals) {
      if (Array.isArray(v)) mergedOld = mergeIds(mergedOld, v);
    }
    return mergeIds(keep, mergedOld);
  }
  if (merge === "inner-key") {
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
  // `undefined` IS the missing-key sentinel: plugin-store's `get` maps absent
  // keys to undefined (dist-js: `return exists ? value : undefined`), never null.
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
