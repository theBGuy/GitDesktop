import { repoIdentity } from "@/lib/git/repo-identity";
import {
  memoizedStoreLoader,
  reloadToleratingEmptyStore,
} from "@/lib/plugin-store";
import {
  AUTOMATION_KIND_FILTERS,
  type AutomationKindFilter,
  type ChannelPrefs,
  isOutcomeSource,
  NOTIFICATION_SOURCES,
  type NotificationOutcome,
  type NotificationSettings,
  type NotificationSource,
  OUTCOME_CLASSES,
  OUTCOME_FILTERS,
  OUTCOME_SOURCES,
  type OutcomeFilter,
  type OutcomeSource,
  PR_CHECK_SCOPE_FILTERS,
  type PrCheckScopeFilter,
} from "@/lib/settings/api";
// Type-only: `stores/notifications` imports nothing of ours, and importing only its
// type keeps it that way at runtime.
import type { NotificationKind } from "@/lib/stores/notifications";

/** A repo's adjustments; every absent field inherits the global. */
export interface RepoNotificationOverride {
  /** true = nothing from this repo notifies on any channel; wins over cells. */
  muted?: boolean;
  sources?: Partial<Record<NotificationSource, Partial<ChannelPrefs>>>;
  prChecksScope?: PrCheckScopeFilter;
  /** Which results notify, per CI source; an absent key inherits the global. */
  outcomes?: Partial<Record<OutcomeSource, OutcomeFilter>>;
  /** Which automation results notify; absent inherits the global. */
  automationKinds?: AutomationKindFilter;
}

/** The single store key holding `Record<repoKey, RepoNotificationOverride>`. */
const STORE_KEY = "overrides";

// Personal app-data — notification preferences are the user's, never the repo's.
const getStore = memoizedStoreLoader("notification-overrides.json");

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

/** Same manifest rule for the outcome axis: a key naming no outcome source, or a
 *  value naming no filter, drops. */
function normalizeOutcomes(
  v: unknown,
): RepoNotificationOverride["outcomes"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as Record<string, unknown>;
  const out: Partial<Record<OutcomeSource, OutcomeFilter>> = {};
  let any = false;
  for (const source of OUTCOME_SOURCES) {
    const filter = obj[source];
    if (OUTCOME_FILTERS.includes(filter as OutcomeFilter)) {
      out[source] = filter as OutcomeFilter;
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
    outcomes?: unknown;
    automationKinds?: unknown;
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
  const outcomes = normalizeOutcomes(obj.outcomes);
  if (outcomes) out.outcomes = outcomes;
  if (
    AUTOMATION_KIND_FILTERS.includes(
      obj.automationKinds as AutomationKindFilter,
    )
  ) {
    out.automationKinds = obj.automationKinds as AutomationKindFilter;
  }
  if (
    !out.muted &&
    !out.sources &&
    !out.prChecksScope &&
    !out.outcomes &&
    !out.automationKinds
  ) {
    return undefined;
  }
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

/** Which results a repo notifies on for one CI source — orthogonal to that source's
 *  channels, like the scope, so it stays meaningful while the source is muted. */
export function effectiveOutcomeFilter(
  global: NotificationSettings,
  override: RepoNotificationOverride | undefined,
  source: OutcomeSource,
): OutcomeFilter {
  return override?.outcomes?.[source] ?? global.outcomes[source];
}

/** Which automation results a repo notifies on — orthogonal to the automations
 *  channels, like the scope and the outcome filters, so it stays meaningful while
 *  that source is muted. */
export function effectiveAutomationKindFilter(
  global: NotificationSettings,
  override: RepoNotificationOverride | undefined,
): AutomationKindFilter {
  return override?.automationKinds ?? global.automationKinds;
}

/** The set each filter delivers, spelled out rather than derived: every filter names
 *  a non-empty set, which is the invariant the poll-enable gates lean on. */
const FILTER_DELIVERS: Record<OutcomeFilter, readonly NotificationOutcome[]> = {
  all: OUTCOME_CLASSES,
  failures: ["failure"],
  successes: ["success"],
};

/** Whether one result passes a filter. Pure; module-private, since
 *  {@link deliveredChannels} is the seam every caller asks through. */
function outcomeAllowed(
  filter: OutcomeFilter,
  outcome: NotificationOutcome,
): boolean {
  return FILTER_DELIVERS[filter].includes(outcome);
}

/** The kinds each automations filter delivers. `null` is the identity filter: the
 *  default delivers everything INCLUDING kinds this app doesn't emit yet, so a new
 *  one can never go dark on an existing user. The trailing `satisfies` closes EVERY
 *  entry over real kinds — a set cannot opt out of that check — while the declared
 *  value type stays `string`, since a delivered row's kind is untrusted on read (see
 *  `AppNotification.kind`). */
const AUTOMATION_KIND_DELIVERS: Record<
  AutomationKindFilter,
  readonly string[] | null
> = {
  all: null,
  failures: ["review-failed"],
} satisfies Record<AutomationKindFilter, readonly NotificationKind[] | null>;

/** Whether one automation event's kind passes a filter. Pure; module-private, since
 *  {@link deliveredChannels} is the seam every caller asks through. */
function automationKindAllowed(
  filter: AutomationKindFilter,
  kind: string,
): boolean {
  const delivers = AUTOMATION_KIND_DELIVERS[filter];
  return delivers === null || delivers.includes(kind);
}

/**
 * THE delivery seam: the channels a source delivers on for one repo and one event,
 * across both event axes — the CI sources' outcome filter and the automations
 * source's kind filter. Either is all-or-nothing today — a filtered-out event
 * delivers nowhere — so this zeroes the pair the channel resolution produced. A
 * per-CHANNEL axis would change only this body: every producer and the emit gate
 * already ask the question in the shape that answer needs.
 */
export function deliveredChannels(
  global: NotificationSettings,
  override: RepoNotificationOverride | undefined,
  source: NotificationSource,
  outcome?: NotificationOutcome,
  kind?: string,
): ChannelPrefs {
  const channels = effectiveChannels(global, override, source);
  if (outcome !== undefined && isOutcomeSource(source)) {
    const filter = effectiveOutcomeFilter(global, override, source);
    if (!outcomeAllowed(filter, outcome)) return { inApp: false, os: false };
  }
  // Gated on the SOURCE, never the kind alone: the `reviews` source mints the same
  // kind strings as the automation runner (see stores/notifications.ts), and this
  // axis must never reach it.
  if (source === "automations" && kind !== undefined) {
    const filter = effectiveAutomationKindFilter(global, override);
    if (!automationKindAllowed(filter, kind))
      return { inApp: false, os: false };
  }
  return channels;
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

/** Both repo-key forms here are PATHS — the identity is the git common dir, whose
 *  casing follows however the repo was opened — and Windows paths are
 *  case-insensitive, so every key comparison goes through this (see `addRecentRepo`).
 *  Deliberately unconditional on every platform, matching the recents store's
 *  trade-off: case-twin paths naming genuinely distinct repos on a case-sensitive
 *  filesystem would share one entry — accepted; a platform-aware compare belongs in
 *  a shared helper adopted by all stores at once, never a per-store fork. */
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Every stored key naming `path`, whatever its casing. Used on read (lookup) and on
 *  write (the fold), so neither arm can see a key the other misses. */
function keysMatching(
  map: Record<string, RepoNotificationOverride>,
  path: string,
): string[] {
  return Object.keys(map).filter((key) => samePath(key, path));
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
  const own = keysMatching(map, identity)[0];
  if (own !== undefined) return map[own];
  if (samePath(identity, repoPath)) return undefined;
  const legacy = keysMatching(map, repoPath)[0];
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
 *  is visible immediately; another window's is not (matching automations).
 *  `knownIdentity` is an already-resolved key: pass it from any caller that may
 *  hold a DEAD `repoPath`, since resolving one here caches the raw-path fallback
 *  for the session under the key every identity-keyed store reads. Handing the raw
 *  path through is well-defined — {@link overrideEntry} then reads the legacy key
 *  alone. */
export async function overrideForRepo(
  repoPath: string,
  knownIdentity?: string,
): Promise<RepoNotificationOverride | undefined> {
  const map = await loadNotificationOverrides();
  const identity = knownIdentity ?? (await repoIdentity(repoPath));
  return overrideEntry(map, identity, repoPath);
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
    await reloadToleratingEmptyStore(store);
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
    // Drop every case-variant of BOTH key forms before writing back under the
    // freshly resolved casing — a survivor would be a ghost entry that
    // `overrideEntry` might return instead, and that no save could reach again.
    for (const key of keysMatching(next, id)) delete next[key];
    if (!samePath(id, repoPath)) {
      for (const key of keysMatching(next, repoPath)) delete next[key];
    }
    if (normalized) next[id] = normalized;
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
