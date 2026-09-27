/**
 * The pure pieces of how a write settles into the cache: which entity keys an
 * optimistic patch touched, merging a write's answer over only those, rolling
 * only those back, which in-flight reads a whole-repo settle must heal, and the
 * heal itself over an injected cache surface.
 *
 * Import-free at runtime on purpose (types only, erased) so
 * `scripts/write-settle.test.mjs` can load it straight from `src/` under Node's
 * type stripping. A runtime import added here fails that test.
 */
import type {
  ProjectPatch,
  ProjectV2Ref,
  ProjectViewDef,
  ProjectViewPatch,
} from "../types";

/** Keys merged from the answer WITH a patched key: when `closed` is touched, the
 *  answer's `viewerCanClose`/`viewerCanReopen` are GitHub's authoritative verdicts
 *  for the project's new state, which no optimistic patch can supply. */
const PROJECT_DERIVED: Partial<
  Record<keyof ProjectPatch, readonly (keyof ProjectV2Ref)[]>
> = {
  closed: ["viewerCanClose", "viewerCanReopen"],
};

/** The project keys a details write touches: each key the patch carries, plus
 *  its derived group. */
export function projectTouchedKeys(
  patch: ProjectPatch,
): (keyof ProjectV2Ref)[] {
  const keys: (keyof ProjectV2Ref)[] = [];
  for (const key of Object.keys(patch) as (keyof ProjectPatch)[]) {
    if (patch[key] === undefined) continue;
    keys.push(key, ...(PROJECT_DERIVED[key] ?? []));
  }
  return keys;
}

/** The view keys a view write touches. No derived group: a layout write's answer
 *  was probed to carry the view's other config (filter, fields, grouping, sort)
 *  back unchanged. */
export function viewTouchedKeys(
  patch: ProjectViewPatch,
): (keyof ProjectViewDef)[] {
  return (Object.keys(patch) as (keyof ProjectViewPatch)[]).filter(
    (key) => patch[key] !== undefined,
  );
}

/** Equality for the values a patch touches — JSON scalars and id lists — with an
 *  absent key equal only to another absent one. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `entity` with `key` set to `value`, or deleted when `value` is absent: an
 *  optional key reads as ABSENT, never as a present `undefined`. */
function assign<T extends object>(entity: T, key: keyof T, value: unknown) {
  if (value === undefined) Reflect.deleteProperty(entity, key);
  else Reflect.set(entity, key, value);
}

/**
 * `target` with each of `keys` taken from `source` — deleted where `source` lacks
 * it — and every other key as `target` holds it. A write's success merges its
 * answer this way, so a sibling write's landed change to a key this one never
 * touched survives the answer.
 */
export function mergeTouched<T extends object>(
  target: T,
  keys: readonly (keyof T)[],
  source: T,
): T {
  const next = { ...target };
  for (const key of keys) assign(next, key, source[key]);
  return next;
}

/**
 * `current` with each of `keys` put back to `before` (deleted where `before`
 * lacked it), but only while `current` still holds the value `optimistic` wrote
 * there: a later write's landed value for the same key survives this rollback.
 * Untouched keys are never read. Returns `current` itself when nothing is restored.
 * Named edge: a later write that set the SAME value is indistinguishable from this
 * one's, so its value is rolled back too until the settle's re-read.
 */
export function restoreTouched<T extends object>(
  current: T,
  keys: readonly (keyof T)[],
  optimistic: T,
  before: T,
): T {
  let next = current;
  for (const key of keys) {
    if (!sameValue(current[key], optimistic[key])) continue;
    if (next === current) next = { ...current };
    assign(next, key, before[key]);
  }
  return next;
}

/**
 * Whether a read in flight at a whole-repo settle would land AFTER that settle's
 * invalidation with an answer from before the write, and stamp it fresh. Two kinds
 * only: an INACTIVE read (the invalidation refetches active queries alone, so
 * nothing replaces it) and a read with NO data yet (query-core joins a first load
 * already running instead of restarting it). An active read that has data is
 * restarted by the invalidation's own refetch, and a paused one sends its request
 * only once it resumes.
 */
export function readStraddlesSettle(query: {
  isActive(): boolean;
  state: { fetchStatus: string; data: unknown };
}): boolean {
  return (
    query.state.fetchStatus === "fetching" &&
    (query.state.data === undefined || !query.isActive())
  );
}

/**
 * Where a watched straddling read stands after one query-cache event:
 * `"landed"` once it is no longer fetching (succeeded, failed, reverted or paused
 * by its own path) — the cue to heal it; `"removed"` when the query left the
 * cache, leaving nothing to heal; null while it is still in flight.
 */
export function straddleOutcome(event: {
  type: string;
  query: { state: { fetchStatus: string } };
}): "landed" | "removed" | null {
  if (event.type === "removed") return "removed";
  if (event.type === "updated" && event.query.state.fetchStatus !== "fetching")
    return "landed";
  return null;
}

/** The cache surface a straddle heal drives, injected so the orchestration runs
 *  without query-core: a cache-event subscription, and the re-invalidation of one
 *  landed read's exact key. */
export interface StraddleHealCache<Q> {
  subscribe(listener: (event: { type: string; query: Q }) => void): () => void;
  invalidate(query: Q): void;
}

/**
 * Chains a heal after each straddling read ({@link readStraddlesSettle}): once a
 * read lands, its key is invalidated again, one round trip after the stale answer
 * instead of a staleTime later. The read itself is never touched.
 *
 * A read already watched is skipped, so a second settle inside one round trip adds
 * no second watch — the first one's heal runs after both. A landed or removed read
 * leaves the watch set, so a later settle can watch it again; a removed one has
 * nothing to heal. The subscription ends with its last read. `defer` holds the
 * invalidation off the cache notification that reports the landing, which must
 * not start a fetch from inside itself.
 */
export function createStraddleHealer<
  Q extends { state: { fetchStatus: string } },
>(defer: (run: () => void) => void = queueMicrotask) {
  const healing = new WeakSet<Q>();
  return {
    isHealing: (query: Q) => healing.has(query),
    /** Watch every read of `reads` not already watched. */
    watch(cache: StraddleHealCache<Q>, reads: readonly Q[]): void {
      const waiting = new Set(reads.filter((query) => !healing.has(query)));
      if (waiting.size === 0) return;
      for (const query of waiting) healing.add(query);
      const unsubscribe = cache.subscribe((event) => {
        if (!waiting.has(event.query)) return;
        const outcome = straddleOutcome(event);
        if (outcome === null) return;
        waiting.delete(event.query);
        healing.delete(event.query);
        if (outcome === "landed") {
          const landed = event.query;
          defer(() => cache.invalidate(landed));
        }
        if (waiting.size === 0) unsubscribe();
      });
    },
  };
}
