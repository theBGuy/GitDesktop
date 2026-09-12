import { load, type Store } from "@tauri-apps/plugin-store";
import { repoIdentity } from "@/lib/git/repo-identity";
import {
  type ChannelPrefs,
  NOTIFICATION_SOURCES,
  type NotificationSettings,
  type NotificationSource,
  PR_CHECK_SCOPE_FILTERS,
  type PrCheckScopeFilter,
} from "@/lib/settings/api";
import { storeName } from "@/lib/test-mode";

/** A repo's adjustments; every absent field inherits the global. */
export interface RepoNotificationOverride {
  /** true = nothing from this repo notifies on any channel; wins over cells. */
  muted?: boolean;
  sources?: Partial<Record<NotificationSource, Partial<ChannelPrefs>>>;
  prChecksScope?: PrCheckScopeFilter;
}

/** The single store key holding `Record<repoKey, RepoNotificationOverride>`. */
const STORE_KEY = "overrides";

// Personal app-data — notification preferences are the user's, never the repo's.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("notification-overrides.json"), {
    autoSave: true,
    defaults: {},
  }).catch((e: unknown) => {
    // A rejected load must not be memoized: the emit gate reads this store on every
    // notification, and a pinned failure would silently ignore every pref for the
    // rest of the session. Drop the memo so the next call retries.
    storePromise = null;
    throw e;
  });
  return storePromise;
}

// Serialize every read-modify-write on this store through one in-process queue:
// autoSave persists on a ~100ms debounce, so two overlapping saves would both read
// the same pre-flush disk snapshot and the later would drop the earlier's change.
// Mirrors automations/store.ts. In-process only; cross-window races remain out of
// scope.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  // Keep the queue alive whether `op` fulfilled or rejected; callers still get `run`.
  opChain = run.catch(() => undefined);
  return run;
}

/** Re-read the file into the in-memory store, tolerating a missing one: `load()`
 *  tolerates it but `reload()` rejects with a raw io error until the first `save()`
 *  creates it, so ANY reload failure proceeds with in-memory state.
 *  `ignoreDefaults: true` matches the store to disk so externally-deleted keys drop.
 *  Call inside the serialized queue so it can't land between a set and its flush. */
async function reloadRaw(store: Store): Promise<void> {
  try {
    await store.reload({ ignoreDefaults: true });
  } catch {
    // Missing file — the next save() creates it.
  }
}

// ── Normalization (every load) ──────────────────────────────────────────────

/** Type-checks one untrusted channel cell, keeping only boolean fields. Returns
 *  undefined for a cell that ends up empty — an inherit-everything cell is no
 *  override. */
function normalizeCell(v: unknown): Partial<ChannelPrefs> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const pair = v as { inApp?: unknown; os?: unknown };
  const cell: Partial<ChannelPrefs> = {};
  if (typeof pair.inApp === "boolean") cell.inApp = pair.inApp;
  if (typeof pair.os === "boolean") cell.os = pair.os;
  return cell.inApp === undefined && cell.os === undefined ? undefined : cell;
}

/** The manifest is the only enumeration, so a key naming no known source drops. */
function normalizeSources(
  v: unknown,
): RepoNotificationOverride["sources"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as Record<string, unknown>;
  const out: Partial<Record<NotificationSource, Partial<ChannelPrefs>>> = {};
  let any = false;
  for (const source of NOTIFICATION_SOURCES) {
    const cell = normalizeCell(obj[source]);
    if (cell) {
      out[source] = cell;
      any = true;
    }
  }
  return any ? out : undefined;
}

/** Type-checks one untrusted override, dropping malformed fields. Returns undefined
 *  when nothing usable survives: an empty override is no override, and storing one
 *  would mark the repo as overridden while it inherits everything. */
function normalizeOverride(v: unknown): RepoNotificationOverride | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as {
    muted?: unknown;
    sources?: unknown;
    prChecksScope?: unknown;
  };
  const out: RepoNotificationOverride = {};
  if (obj.muted === true) out.muted = true;
  const sources = normalizeSources(obj.sources);
  if (sources) out.sources = sources;
  if (
    PR_CHECK_SCOPE_FILTERS.includes(obj.prChecksScope as PrCheckScopeFilter)
  ) {
    out.prChecksScope = obj.prChecksScope as PrCheckScopeFilter;
  }
  if (!out.muted && !out.sources && !out.prChecksScope) return undefined;
  return out;
}

function normalizeOverrides(
  saved: unknown,
): Record<string, RepoNotificationOverride> {
  const out: Record<string, RepoNotificationOverride> = {};
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return out;
  for (const [key, value] of Object.entries(saved)) {
    const override = normalizeOverride(value);
    if (override) out[key] = override;
  }
  return out;
}

// ── Pure resolution ─────────────────────────────────────────────────────────

/** The channels a source actually delivers on for one repo. `muted` is repo-wide
 *  and beats every cell; otherwise each channel falls back to the global. */
export function effectiveChannels(
  global: NotificationSettings,
  override: RepoNotificationOverride | undefined,
  source: NotificationSource,
): ChannelPrefs {
  if (override?.muted) return { inApp: false, os: false };
  return { ...global.sources[source], ...override?.sources?.[source] };
}

/** Which PRs a repo watches for CI checks — orthogonal to the prChecks channels,
 *  so it stays meaningful even while that source is muted. */
export function effectiveChecksScope(
  global: NotificationSettings,
  override: RepoNotificationOverride | undefined,
): PrCheckScopeFilter {
  return override?.prChecksScope ?? global.prChecksScope;
}

/** Whether any of `sources` delivers on any channel — the shape a poll-enable
 *  predicate needs, so a poll can't run for sources that would deliver nothing. */
export function anyChannelOn(
  global: NotificationSettings,
  override: RepoNotificationOverride | undefined,
  sources: readonly NotificationSource[],
): boolean {
  return sources.some((source) => {
    const channels = effectiveChannels(global, override, source);
    return channels.inApp || channels.os;
  });
}

/** Windows paths are case-insensitive, so a legacy checkout-path key can differ in
 *  case from the live `repoPath` (see `addRecentRepo`). Identity keys stay exact —
 *  git reports one spelling of the common dir. */
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Every stored key that is the legacy raw-path form of `repoPath`. Used on read
 *  (the fallback) and on write (the fold), so both see the same set. */
function legacyPathKeys(
  map: Record<string, RepoNotificationOverride>,
  identity: string,
  repoPath: string,
): string[] {
  if (identity === repoPath) return [];
  return Object.keys(map).filter((key) => samePath(key, repoPath));
}

/** A repo's override, looked up by its worktree-stable identity with a legacy
 *  checkout-path fallback (until the next save folds the old key onto the
 *  identity). Pure, so the sync React consumers and the async helper below share
 *  it — the caller resolves `identity` via `repoIdentity`/`useRepoIdentity`. */
export function overrideEntry(
  map: Record<string, RepoNotificationOverride>,
  identity: string,
  repoPath: string,
): RepoNotificationOverride | undefined {
  const exact = map[identity];
  if (exact) return exact;
  const legacy = legacyPathKeys(map, identity, repoPath)[0];
  return legacy === undefined ? undefined : map[legacy];
}

// ── Public store API ────────────────────────────────────────────────────────

/** Every repo's overrides, normalized on each load so partial/hand-edited data
 *  never reaches a consumer. */
export async function loadNotificationOverrides(): Promise<
  Record<string, RepoNotificationOverride>
> {
  const store = await getStore();
  return normalizeOverrides(await store.get<unknown>(STORE_KEY));
}

/** One repo's override. Reads the memoized store instance, so a same-process write
 *  is visible immediately; another window's is not (matching automations). */
export async function overrideForRepo(
  repoPath: string,
): Promise<RepoNotificationOverride | undefined> {
  const map = await loadNotificationOverrides();
  return overrideEntry(map, await repoIdentity(repoPath), repoPath);
}

/** Serialized read-modify-write against fresh disk state. The force-save flushes
 *  past the autoSave debounce so the next queued op's reload sees it. */
function mutateOverrides(
  mutate: (
    current: Record<string, RepoNotificationOverride>,
  ) => Record<string, RepoNotificationOverride>,
): Promise<void> {
  return serialize(async () => {
    const store = await getStore();
    await reloadRaw(store);
    const current = normalizeOverrides(await store.get<unknown>(STORE_KEY));
    await store.set(STORE_KEY, mutate(current));
    await store.save();
  });
}

/** Replaces one repo's override, dropping the entry when it holds nothing usable.
 *  Keys by worktree-stable identity and deletes any legacy checkout-path entry
 *  (folding it), so a repo's overrides apply from every worktree. */
export async function saveRepoNotificationOverride(
  repoPath: string,
  override: RepoNotificationOverride,
): Promise<void> {
  // Resolve the identity before entering the serialized mutator (it's async; the
  // mutator runs synchronously over fresh state).
  const id = await repoIdentity(repoPath);
  const normalized = normalizeOverride(override);
  return mutateOverrides((current) => {
    const next = { ...current };
    // Every case-variant of the raw path goes, not just the live spelling — a
    // survivor would sit beside the identity key as a ghost nothing ever reads.
    for (const key of legacyPathKeys(next, id, repoPath)) delete next[key];
    if (normalized) next[id] = normalized;
    else delete next[id];
    return next;
  });
}

/** Drops one stored key verbatim — the repo-key form the caller read back from
 *  {@link loadNotificationOverrides}, which may still be a legacy checkout path. */
export async function clearNotificationOverride(
  repoKey: string,
): Promise<void> {
  return mutateOverrides((current) => {
    const next = { ...current };
    delete next[repoKey];
    return next;
  });
}
