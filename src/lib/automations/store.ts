import { load, type Store } from "@tauri-apps/plugin-store";
import { toast } from "sonner";
import type { ReviewMode } from "@/lib/ai/types";
import { repoIdentity } from "@/lib/git/repo-identity";
import { storeName } from "@/lib/test-mode";
import {
  type ActionConfig,
  type ActionId,
  type AutomationsConfigV2,
  type BranchConditions,
  type LifecycleConfig,
  type LifecycleEvent,
  type RepoActionOverride,
  type RepoOverride,
  repoEntry,
} from "./types";

const LIFECYCLES: LifecycleEvent[] = ["commit", "pr-open", "pr-sync"];
const ACTIONS: ActionId[] = ["general", "security"];

// Personal app-data — automation rules are the user's, never the repo's.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("automations.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write on this store through one in-process queue:
// autoSave persists on a ~100ms debounce, so two overlapping saves would both read
// the same pre-flush disk snapshot and the later would drop the earlier's change
// (e.g. a per-repo override save clobbering a concurrent global-lifecycles save).
// Mirrors pulls/local.ts and settings/api.ts. In-process only; cross-window races
// remain out of scope.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  // Keep the queue alive whether `op` fulfilled or rejected; callers still get `run`.
  opChain = run.catch(() => undefined);
  return run;
}

/** Re-read `automations.json` into the in-memory store, tolerating a missing file:
 *  `load()` tolerates one but `reload()` rejects with a raw io error until the first
 *  `save()` creates it, so ANY reload failure proceeds with in-memory state.
 *  `ignoreDefaults: true` matches the store to disk so externally-deleted keys drop.
 *  Call inside the serialized queue so it can't land between a set and its flush. */
async function reloadRaw(store: Store): Promise<void> {
  try {
    await store.reload({ ignoreDefaults: true });
  } catch {
    // Missing file — the next save() creates it.
  }
}

/**
 * Serialized read-modify-write against fresh disk state: reload, read the current
 * normalized config, apply `mutate`, persist. The force-save (`store.save()`)
 * flushes past the autoSave debounce so the next queued op's reload sees a current
 * snapshot.
 */
function mutateConfig(
  mutate: (current: AutomationsConfigV2) => AutomationsConfigV2,
): Promise<void> {
  return serialize(async () => {
    const store = await getStore();
    await reloadRaw(store);
    const current = normalizeAutomations(await store.get<unknown>("config"));
    const next = mutate(current);
    await store.set("config", next);
    await store.save();
  });
}

// ── v1 shape (read-only, for migration) ─────────────────────────────────────
// The flat pre-v2 rule list. Kept local to the migration path — the app no longer
// works in these terms, so they aren't exported.

interface V1Rule {
  id: string;
  trigger: LifecycleEvent;
  action: ReviewMode;
  enabled: boolean;
}
interface V1Repo {
  disabledGlobalIds: string[];
  rules: V1Rule[];
}
interface V1Config {
  global: V1Rule[];
  repos: Record<string, V1Repo>;
}

function isReviewMode(v: unknown): v is ReviewMode {
  return v === "general" || v === "security";
}
function isLifecycle(v: unknown): v is LifecycleEvent {
  return v === "commit" || v === "pr-open" || v === "pr-sync";
}

/** A stored value is v1 when it has a `global` array and isn't already v2. */
function isV1(saved: unknown): saved is Partial<V1Config> {
  if (!saved || typeof saved !== "object") return false;
  const obj = saved as { schemaVersion?: unknown; global?: unknown };
  return obj.schemaVersion !== 2 && Array.isArray(obj.global);
}

// ── Normalization (every load) ──────────────────────────────────────────────

/** Type-checks an untrusted BranchConditions, dropping malformed fields. Returns
 *  undefined when nothing usable is present (so an absent conditions stays absent
 *  rather than materializing an empty one). */
function normalizeConditions(v: unknown): BranchConditions | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as {
    include?: unknown;
    exclude?: unknown;
    match?: unknown;
  };
  const strArray = (a: unknown): string[] =>
    Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  const match =
    obj.match === "head" || obj.match === "base" || obj.match === "either"
      ? obj.match
      : "head";
  return {
    include: strArray(obj.include),
    exclude: strArray(obj.exclude),
    match,
  };
}

function normalizeActionConfig(v: unknown): ActionConfig | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as { enabled?: unknown; conditions?: unknown };
  const conditions = normalizeConditions(obj.conditions);
  return {
    enabled: obj.enabled === true,
    ...(conditions ? { conditions } : {}),
  };
}

function normalizeRepoActionOverride(
  v: unknown,
): RepoActionOverride | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as { enabled?: unknown; conditions?: unknown };
  const conditions = normalizeConditions(obj.conditions);
  const out: RepoActionOverride = {};
  if (typeof obj.enabled === "boolean") out.enabled = obj.enabled;
  if (conditions) out.conditions = conditions;
  // A malformed cell with nothing usable is no override at all — returning {}
  // would render a spurious "Overridden" badge for an inherit-everything cell.
  if (out.enabled === undefined && !out.conditions) return undefined;
  return out;
}

function normalizeLifecycles<T>(
  v: unknown,
  cell: (raw: unknown) => T | undefined,
): Partial<Record<LifecycleEvent, Partial<Record<ActionId, T>>>> {
  const out: Partial<Record<LifecycleEvent, Partial<Record<ActionId, T>>>> = {};
  if (!v || typeof v !== "object") return out;
  const obj = v as Record<string, unknown>;
  for (const lifecycle of LIFECYCLES) {
    const rawActions = obj[lifecycle];
    if (!rawActions || typeof rawActions !== "object") continue;
    const actionsObj = rawActions as Record<string, unknown>;
    const cells: Partial<Record<ActionId, T>> = {};
    for (const action of ACTIONS) {
      const normalized = cell(actionsObj[action]);
      if (normalized !== undefined) cells[action] = normalized;
    }
    if (Object.keys(cells).length > 0) out[lifecycle] = cells;
  }
  return out;
}

/**
 * Coerces a loosely-typed (older, hand-edited, or partially corrupt) v2 value
 * into a full AutomationsConfigV2, dropping malformed cells rather than letting
 * one bad entry sink the whole load. Mirrors `normalizeBranchRules`.
 */
export function normalizeAutomations(saved: unknown): AutomationsConfigV2 {
  const obj = (saved ?? {}) as {
    lifecycles?: unknown;
    repos?: unknown;
  };
  const lifecycles: Partial<Record<LifecycleEvent, LifecycleConfig>> = {};
  const rawLifecycles =
    obj.lifecycles && typeof obj.lifecycles === "object"
      ? (obj.lifecycles as Record<string, unknown>)
      : {};
  for (const lifecycle of LIFECYCLES) {
    const rawActions = rawLifecycles[lifecycle];
    if (!rawActions || typeof rawActions !== "object") continue;
    const actionsObj = (rawActions as { actions?: unknown }).actions;
    const cells: Partial<Record<ActionId, ActionConfig>> = {};
    if (actionsObj && typeof actionsObj === "object") {
      const src = actionsObj as Record<string, unknown>;
      for (const action of ACTIONS) {
        const normalized = normalizeActionConfig(src[action]);
        if (normalized) cells[action] = normalized;
      }
    }
    if (Object.keys(cells).length > 0)
      lifecycles[lifecycle] = { actions: cells };
  }

  const repos: Record<string, RepoOverride> = {};
  const rawRepos =
    obj.repos && typeof obj.repos === "object"
      ? (obj.repos as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(rawRepos)) {
    const overrides = normalizeLifecycles(
      (value as { lifecycles?: unknown } | null)?.lifecycles,
      normalizeRepoActionOverride,
    );
    if (Object.keys(overrides).length > 0) {
      repos[key] = { lifecycles: overrides };
    }
  }

  return { schemaVersion: 2, lifecycles, repos };
}

// ── v1 → v2 migration ───────────────────────────────────────────────────────

/** The folded v2 config plus how many enabled duplicate rules collapsed. */
interface MigrationResult {
  config: AutomationsConfigV2;
  collapsed: number;
}

/**
 * Folds a v1 config into v2. Each ENABLED global rule becomes
 * `lifecycles[trigger].actions[action] = { enabled: true }` (N duplicates collapse to
 * one); disabled global rules contribute nothing. Per repo: a `disabledGlobalIds` id
 * naming an enabled v1 global rule becomes a repo override `enabled: false` for that
 * cell, and each enabled repo-local rule a repo override `enabled: true`. Repo keys
 * are preserved verbatim (identities or legacy paths — `repoEntry` resolves both at
 * read time). `collapsed` counts every enabled rule beyond the first in a shared cell.
 */
export function migrateV1(v1: Partial<V1Config>): MigrationResult {
  let collapsed = 0;

  const global: Partial<Record<LifecycleEvent, LifecycleConfig>> = {};
  // Map v1 global rule id → its (trigger, action) cell, so a repo's
  // disabledGlobalIds can address the same cell.
  const globalCells = new Map<
    string,
    { lifecycle: LifecycleEvent; action: ActionId }
  >();

  const setCell = (
    target: Partial<Record<LifecycleEvent, LifecycleConfig>>,
    lifecycle: LifecycleEvent,
    action: ActionId,
    value: ActionConfig,
  ): boolean => {
    const lc = (target[lifecycle] ??= { actions: {} });
    const existed = lc.actions[action] !== undefined;
    lc.actions[action] = value;
    return existed;
  };

  for (const rule of v1.global ?? []) {
    if (!isLifecycle(rule?.trigger) || !isReviewMode(rule?.action)) continue;
    if (rule.id)
      globalCells.set(rule.id, {
        lifecycle: rule.trigger,
        action: rule.action,
      });
    if (!rule.enabled) continue;
    const existed = setCell(global, rule.trigger, rule.action, {
      enabled: true,
    });
    if (existed) collapsed++;
  }

  const repos: Record<string, RepoOverride> = {};
  for (const [key, repo] of Object.entries(v1.repos ?? {})) {
    const overrides: Partial<
      Record<LifecycleEvent, Partial<Record<ActionId, RepoActionOverride>>>
    > = {};
    const seen = new Set<string>();
    const setOverride = (
      lifecycle: LifecycleEvent,
      action: ActionId,
      value: RepoActionOverride,
    ) => {
      const cellKey = `${lifecycle}#${action}`;
      const lc = (overrides[lifecycle] ??= {});
      if (lc[action] !== undefined && seen.has(cellKey)) collapsed++;
      seen.add(cellKey);
      lc[action] = value;
    };

    for (const id of repo?.disabledGlobalIds ?? []) {
      const cell = globalCells.get(id);
      if (cell) setOverride(cell.lifecycle, cell.action, { enabled: false });
    }
    // Enabled repo-local rules → repo override enabling that cell. (A repo-local
    // enable overrides a disable-of-the-same-cell above; both count toward dedup.)
    for (const rule of repo?.rules ?? []) {
      if (!isLifecycle(rule?.trigger) || !isReviewMode(rule?.action)) continue;
      if (!rule.enabled) continue;
      setOverride(rule.trigger, rule.action, { enabled: true });
    }
    if (Object.keys(overrides).length > 0) {
      repos[key] = { lifecycles: overrides };
    }
  }

  return {
    config: { schemaVersion: 2, lifecycles: global, repos },
    collapsed,
  };
}

// ── Public store API ────────────────────────────────────────────────────────

/**
 * Loads the v2 automations config. A stored v1 config is migrated (dedup +
 * one-time toast) and persisted immediately so migration runs exactly once; a v2
 * config (or nothing) is normalized on every load so partial/hand-edited data
 * never crashes the runner.
 */
export async function loadAutomations(): Promise<AutomationsConfigV2> {
  const store = await getStore();
  const saved = await store.get<unknown>("config");
  if (isV1(saved)) {
    const { config, collapsed } = migrateV1(saved);
    // Persist the migrated config through the serialized queue so it can't race a
    // concurrent save. Re-check fresh RAW state inside the chain: if a neighbor
    // already wrote a v2 value mid-migration, leave it intact rather than clobber
    // it with a migration computed from the now-stale v1 blob.
    await serialize(async () => {
      await reloadRaw(store);
      const fresh = await store.get<unknown>("config");
      if (!isV1(fresh)) return;
      await store.set("config", config);
      await store.save();
    });
    if (collapsed > 0) {
      toast.info(
        `Automations updated — ${collapsed} duplicate rule${
          collapsed === 1 ? "" : "s"
        } merged.`,
      );
    }
    return config;
  }
  return normalizeAutomations(saved);
}

/**
 * Persists the GLOBAL lifecycle defaults from `config`. Only `config.lifecycles` is
 * written; per-repo overrides are re-derived from fresh disk state inside the
 * serialized queue rather than taken from the caller's (possibly stale) snapshot, so
 * a concurrent `saveRepoAutomations` isn't clobbered.
 *
 * Its only caller edits lifecycles alone and carries `repos` over unchanged from its
 * last load — a caller that edits `config.repos` would have those edits dropped.
 */
export async function saveAutomations(
  config: AutomationsConfigV2,
): Promise<void> {
  return mutateConfig((current) => ({
    ...current,
    schemaVersion: 2,
    lifecycles: config.lifecycles,
  }));
}

/** A repo's per-repo overrides, keyed by its worktree-stable identity (with a
 *  legacy checkout-path fallback until the next save folds it). Resolve once and
 *  pass into `effectiveActions`. */
export async function repoAutomationsFor(
  config: AutomationsConfigV2,
  repoPath: string,
): Promise<RepoOverride | undefined> {
  const id = await repoIdentity(repoPath);
  return repoEntry(config, id, repoPath);
}

/** Whether a repo override carries any action cell (else it's a no-op to drop). */
function repoHasCells(repo: RepoOverride): boolean {
  return Object.values(repo.lifecycles).some(
    (actions) => actions && Object.keys(actions).length > 0,
  );
}

/** Replaces one repo's overrides, dropping the entry when it holds no cells. Keys
 *  by the repo's worktree-stable identity and drops any legacy checkout-path entry
 *  (folding it), so the overrides are shared across the main checkout and every
 *  worktree. */
export async function saveRepoAutomations(
  repoPath: string,
  repo: RepoOverride,
): Promise<void> {
  // Resolve the identity before entering the serialized mutator (it's async; the
  // mutator runs synchronously over fresh state).
  const id = await repoIdentity(repoPath);
  return mutateConfig((current) => {
    // Re-derive only THIS repo's slice over fresh state, so the write can't clobber
    // a concurrent global-lifecycles or other-repo save.
    const repos = { ...current.repos };
    if (id !== repoPath) delete repos[repoPath];
    if (repoHasCells(repo)) {
      repos[id] = repo;
    } else {
      delete repos[id];
    }
    return { ...current, repos };
  });
}
