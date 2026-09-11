import { load, type Store } from "@tauri-apps/plugin-store";
import {
  identityKeyFor,
  mergeById,
  repoIdentity,
} from "@/lib/git/repo-identity";
import { queryClient } from "@/lib/query-client";
import { storeName } from "@/lib/test-mode";
import type { ActionId } from "./types";

/**
 * Every decision the automation pipeline can record. Deliberately absent:
 * "no-rule", "not-author" and "catch-up-deferred" — those are derived from the
 * config (the dialog's header) or self-resolve within minutes, so a durable row
 * would be noise or a stale lie.
 */
export const AUTOMATION_OUTCOME_CODES = [
  "started",
  "delivered",
  "failed",
  "timed-out",
  "cancelled",
  "empty-diff",
  "claim-held",
  "eligibility-error",
  "branch-skip",
  "needs-first-review",
  "head-covered",
  "head-dismissed",
  "already-reviewed",
  "draft-skipped",
  "too-old",
  "paused",
  "resumed",
] as const;

export type AutomationOutcomeCode = (typeof AUTOMATION_OUTCOME_CODES)[number];

/**
 * Outcomes that describe a repo's STEADY state rather than an event: they repeat
 * identically on every poll tick for as long as nothing changes. Recording them
 * verbatim would rewrite the store once a minute per repo, so they coalesce (see
 * {@link recordAutomationActivity}) and are evicted first when the cap bites.
 */
export const STEADY_OUTCOME_CODES: readonly AutomationOutcomeCode[] = [
  "branch-skip",
  "needs-first-review",
  "head-covered",
  "head-dismissed",
  "already-reviewed",
  "draft-skipped",
  "too-old",
];

/** What set this decision in motion — the lifecycle event, the catch-up poll, or
 *  one of the two user-initiated re-fires. */
export type AutomationTrigger =
  | "commit"
  | "pr-open"
  | "pr-sync"
  | "catch-up"
  | "run-now"
  | "re-run";

/** One decision. `action` is null when the decision was made before any action was
 *  considered (an eligibility error, a catch-up pre-filter, a global marker). */
export interface AutomationOutcome {
  action: ActionId | null;
  code: AutomationOutcomeCode;
  detail?: string;
}

/**
 * One recorded automation decision — the evidence a user whose review didn't fire
 * can read. `ref` is the PR number (as a string) or local PR id; for commit-target
 * rows it is the BRANCH name (the branch is the steady axis of a commit scoping
 * decision, and the specific commit rides `headSha`); "" for the global markers.
 */
export interface AutomationHistoryEntry {
  schemaVersion: 1;
  id: string;
  /** ISO-8601. */
  ts: string;
  trigger: AutomationTrigger;
  targetKind: "remote" | "local" | "commit" | "none";
  ref: string;
  title: string;
  headSha: string;
  /** How many times this steady row coalesced (absent = once). */
  count?: number;
  outcomes: AutomationOutcome[];
}

/** Module-load stamp: a "started" outcome older than this belongs to a process
 *  that is gone, so the UI renders it as interrupted rather than in flight. */
export const SESSION_START_MS = Date.now();

/** Query key for one repo's history list. */
export function automationHistoryKey(repoPath: string) {
  return ["automation-history", repoPath] as const;
}

/** Records kept per repo, pruned on every write so the file stays bounded. */
const MAX_PER_REPO = 50;

/** The reserved store key holding the global paused/resumed markers. Hiding AI
 *  features is an app-wide flip, so its markers are NOT repo-identity-keyed —
 *  they merge into every repo's list instead. Never collides with a repo key,
 *  which is always an absolute path. */
const GLOBAL_MARKERS_KEY = "global-markers";

/** Markers retained — only the recent pause/resume flips explain a quiet stretch. */
const MAX_MARKERS = 10;

// Personal app-data, keyed by the repo's worktree-stable identity. Routed through
// storeName() so cold-start/test instances never pollute the real file.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("automation-history.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write through one in-process queue: autoSave persists
// on a ~100ms debounce, so two overlapping writes would both reload the same
// pre-flush disk snapshot and the later would drop the earlier's record (two poll
// ticks and a settling run all write this store). With the force-save below, each
// reload sees fresh state. Cross-INSTANCE overlap still races last-writer-wins like
// the sibling plugin stores.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  // Keep the queue alive whether `op` fulfilled or rejected; callers still get `run`.
  opChain = run.catch(() => undefined);
  return run;
}

async function reloadRaw(): Promise<void> {
  const store = await getStore();
  // Tolerate a missing store file: `load()` tolerates one but `reload()` rejects with
  // a raw io error (os error 2) until the first `save()` creates the file — without
  // this guard the first-ever write throws before reaching `save()`.
  try {
    await store.reload({ ignoreDefaults: true });
  } catch {
    // Missing file — the next save() creates it.
  }
}

const KNOWN_CODES = new Set<string>(AUTOMATION_OUTCOME_CODES);

/** Shape-guard one record out of untrusted store JSON: a hand-edited (or newer)
 *  `automation-history.json` reaches the dialog verbatim, so a malformed record is
 *  dropped rather than blanking the list or throwing mid-render. `code` is checked
 *  against the known set because the UI looks its label up in a Record — an
 *  unrecognized code would render as a blank row. `schemaVersion` is write-only;
 *  `count` and `detail` are typeof-guarded at their render sites. */
function isStoredEntry(x: unknown): x is AutomationHistoryEntry {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.ts === "string" &&
    typeof r.trigger === "string" &&
    typeof r.targetKind === "string" &&
    typeof r.ref === "string" &&
    typeof r.title === "string" &&
    typeof r.headSha === "string" &&
    Array.isArray(r.outcomes) &&
    r.outcomes.every(
      (o) =>
        typeof o === "object" &&
        o !== null &&
        KNOWN_CODES.has((o as { code?: unknown }).code as string),
    )
  );
}

async function readByKey(key: string): Promise<AutomationHistoryEntry[]> {
  const store = await getStore();
  const raw = await store.get<unknown>(key);
  return Array.isArray(raw) ? raw.filter(isStoredEntry) : [];
}

/** Reads a repo's records, merging in any still under a legacy checkout-path key
 *  (folded onto the identity by the next write via `keyFor`). */
async function readMerged(repo: string): Promise<AutomationHistoryEntry[]> {
  const id = await repoIdentity(repo);
  const primary = await readByKey(id);
  const legacy = id === repo ? [] : await readByKey(repo);
  return mergeById(primary, legacy);
}

/** The identity store key for `repo`, folding any legacy checkout-path-keyed records
 *  onto it once. Called inside the serialized queue (after `reloadRaw`) so the fold
 *  is ordered with the write. */
async function keyFor(repo: string): Promise<string> {
  const store = await getStore();
  return identityKeyFor<AutomationHistoryEntry[]>(
    store,
    "automation-history",
    repo,
    mergeById,
  );
}

/** Newest first by `ts`. A record whose stamp doesn't parse can't be ordered, so
 *  those sort after the dated ones and keep their insertion order — a junk stamp
 *  costs its own position, never someone else's. */
function sortNewestFirst(
  records: AutomationHistoryEntry[],
): AutomationHistoryEntry[] {
  return records
    .map((record, index) => {
      const ts = new Date(record.ts).getTime();
      return { record, index, ts: Number.isNaN(ts) ? null : ts };
    })
    .sort((a, b) => {
      if (a.ts === null || b.ts === null) {
        if (a.ts !== b.ts) return a.ts === null ? 1 : -1;
        return a.index - b.index;
      }
      return b.ts - a.ts;
    })
    .map((x) => x.record);
}

/** Whether every outcome describes steady state. An EMPTY list is not steady: the
 *  coalescing path keys on the outcome set, so a row with nothing to match on must
 *  take the plain-append arm. */
function allSteady(outcomes: AutomationOutcome[]): boolean {
  return (
    outcomes.length > 0 &&
    outcomes.every((o) => STEADY_OUTCOME_CODES.includes(o.code))
  );
}

/**
 * Newest {@link MAX_PER_REPO}, two-tier: steady rows are evicted first, and a row
 * carrying any non-steady code is evicted only when those alone exceed the cap. The
 * single `eligibility-error` row that proves a fail-closed trap must not lose its
 * slot to a month of "already reviewed" noise.
 */
function prune(records: AutomationHistoryEntry[]): AutomationHistoryEntry[] {
  const ordered = sortNewestFirst(records);
  if (ordered.length <= MAX_PER_REPO) return ordered;
  const notable = ordered.filter((e) => !allSteady(e.outcomes));
  const keptNotable = notable.slice(0, MAX_PER_REPO);
  const keptSteady = ordered
    .filter((e) => allSteady(e.outcomes))
    .slice(0, Math.max(0, MAX_PER_REPO - keptNotable.length));
  const keep = new Set([...keptNotable, ...keptSteady]);
  return ordered.filter((e) => keep.has(e));
}

function invalidateRepo(repoPath: string): void {
  void queryClient
    .invalidateQueries({ queryKey: automationHistoryKey(repoPath) })
    .catch(() => undefined);
}

/**
 * One repo's history, newest first, with the global pause/resume markers merged in.
 * Reads through the write queue after a fresh reload — `getStore()` memoizes the
 * first `load()`, so a row another instance wrote since then is absent from the
 * cached snapshot. Never rejects: an unreadable store reads as empty.
 */
export async function listAutomationHistory(
  repoPath: string,
): Promise<AutomationHistoryEntry[]> {
  const all = await serialize(async () => {
    await reloadRaw();
    const repoRows = await readMerged(repoPath);
    const markers = await readByKey(GLOBAL_MARKERS_KEY);
    return [...repoRows, ...markers];
  }).catch((): AutomationHistoryEntry[] => []);
  return sortNewestFirst(all);
}

/** The stored input of a record call — everything the caller decides. */
type NewEntry = Omit<
  AutomationHistoryEntry,
  "schemaVersion" | "id" | "ts" | "count"
>;

/**
 * Signature of the last steady row written per `(repo, targetKind, ref)`, so an
 * unchanged poll tick costs ZERO store I/O — no parse, no rewrite, once a minute
 * per repo. Accepted residual: a signature can outlive its row (pruned by a burst
 * of notable rows), which suppresses the re-append until the head or the outcome
 * set changes. Evidence of steady state is exactly the evidence that is cheap to
 * re-derive, so that trade is deliberate.
 */
const steadySignatures = new Map<string, string>();

function signatureKey(
  repoPath: string,
  targetKind: AutomationHistoryEntry["targetKind"],
  ref: string,
): string {
  return `${repoPath}|${targetKind}|${ref}`;
}

/** The sorted (action, code) pair list — order-independent identity of an outcome
 *  set, so two ticks that decide the same things in a different order coalesce. */
function outcomeMultiset(outcomes: AutomationOutcome[]): string {
  return outcomes
    .map((o) => `${o.action ?? "-"}:${o.code}`)
    .sort()
    .join(",");
}

function steadySignature(
  headSha: string,
  outcomes: AutomationOutcome[],
): string {
  return `${headSha}|${outcomeMultiset(outcomes)}`;
}

/** Appends `entry` under an already-resolved key. Caller owns the reload + flush
 *  ordering (it runs inside the serialized queue). */
async function appendUnder(
  store: Store,
  key: string,
  existing: AutomationHistoryEntry[],
  entry: NewEntry,
): Promise<string> {
  const record: AutomationHistoryEntry = {
    ...entry,
    schemaVersion: 1,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
  };
  await store.set(key, prune([record, ...existing]));
  // Flush now instead of on autoSave's debounce, so the next serialized reload
  // can't re-read a pre-write disk snapshot and drop this record.
  await store.save();
  return record.id;
}

async function appendEntry(repoPath: string, entry: NewEntry): Promise<string> {
  await reloadRaw();
  const store = await getStore();
  const key = await keyFor(repoPath);
  const id = await appendUnder(store, key, await readByKey(key), entry);
  invalidateRepo(repoPath);
  return id;
}

/** The all-steady arm: coalesce onto the newest matching steady row when one
 *  exists, else append. Runs inside the serialized queue. */
async function coalesceSteady(
  repoPath: string,
  entry: NewEntry,
  sigKey: string,
  sig: string,
): Promise<string> {
  await reloadRaw();
  const store = await getStore();
  const key = await keyFor(repoPath);
  const all = await readByKey(key);
  const prior = sortNewestFirst(all).find(
    (e) =>
      e.targetKind === entry.targetKind &&
      e.ref === entry.ref &&
      allSteady(e.outcomes),
  );
  let id: string;
  if (
    prior &&
    outcomeMultiset(prior.outcomes) === outcomeMultiset(entry.outcomes)
  ) {
    // `===` rather than `sameSha` (which lives in sync.ts — importing it here would
    // close a history→sync→runner→history cycle), so a provider flipping between a
    // short and a full spelling of the SAME head costs one spurious count bump and a
    // refreshed stamp on the existing row, never a wrong row.
    if (prior.headSha === entry.headSha) {
      // Identical row already on disk (a fresh session's first tick) — seed the map
      // so every later tick short-circuits, and write nothing.
      steadySignatures.set(sigKey, sig);
      return prior.id;
    }
    // Same decision, new head (a push): bump the row rather than append a near-copy.
    const upserted: AutomationHistoryEntry = {
      ...prior,
      ts: new Date().toISOString(),
      headSha: entry.headSha,
      count: (prior.count ?? 1) + 1,
    };
    await store.set(
      key,
      prune([upserted, ...all.filter((e) => e.id !== prior.id)]),
    );
    await store.save();
    id = prior.id;
  } else {
    id = await appendUnder(store, key, all, entry);
  }
  steadySignatures.set(sigKey, sig);
  invalidateRepo(repoPath);
  return id;
}

/**
 * Records one automation decision, returning the stored entry's id — or null when
 * the write was suppressed (an unchanged steady tick) or failed. Never rejects:
 * history is evidence, and evidence must never be able to break the run it records.
 *
 * A "run-now"/"re-run" trigger ALWAYS appends: a user action is a state change by
 * definition, and the UI's promise that a click leaves evidence depends on it. An
 * all-steady outcome set coalesces (see {@link steadySignatures}); anything else
 * appends.
 */
export async function recordAutomationActivity(
  repoPath: string,
  entry: NewEntry,
): Promise<string | null> {
  try {
    const userAction =
      entry.trigger === "run-now" || entry.trigger === "re-run";
    if (!userAction && allSteady(entry.outcomes)) {
      const sigKey = signatureKey(repoPath, entry.targetKind, entry.ref);
      const sig = steadySignature(entry.headSha, entry.outcomes);
      if (steadySignatures.get(sigKey) === sig) return null;
      return await serialize(() =>
        coalesceSteady(repoPath, entry, sigKey, sig),
      );
    }
    return await serialize(() => appendEntry(repoPath, entry));
  } catch {
    return null;
  }
}

/**
 * Replaces an entry's outcomes and refreshes its stamp — how the runner settles a
 * "started" row in place, so a run killed mid-stream leaves the started row behind
 * instead of a lie. A no-op when the id is gone (pruned). Never rejects.
 */
export async function updateAutomationActivity(
  repoPath: string,
  id: string,
  outcomes: AutomationOutcome[],
): Promise<void> {
  try {
    await serialize(async () => {
      await reloadRaw();
      const store = await getStore();
      const key = await keyFor(repoPath);
      const all = await readByKey(key);
      const found = all.find((e) => e.id === id);
      if (!found) return;
      const updated: AutomationHistoryEntry = {
        ...found,
        ts: new Date().toISOString(),
        outcomes,
      };
      await store.set(key, prune([updated, ...all.filter((e) => e.id !== id)]));
      await store.save();
      invalidateRepo(repoPath);
    });
  } catch {
    // best-effort — a history failure must never surface to the run
  }
}

/**
 * Records that automations were paused or resumed app-wide (the Hide-AI flip), so a
 * quiet stretch in every repo's list has its explanation in line. Stored under the
 * reserved global key rather than a repo's, since the flip is not per repo. Never
 * rejects.
 *
 * Markers carry `trigger: "run-now"` — the only user-initiated value in the union,
 * and a flip IS a user action; consumers branch on `targetKind: "none"` first.
 */
export async function recordAutomationPauseMarker(
  paused: boolean,
): Promise<void> {
  try {
    await serialize(async () => {
      await reloadRaw();
      const store = await getStore();
      const all = await readByKey(GLOBAL_MARKERS_KEY);
      const record: AutomationHistoryEntry = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        trigger: "run-now",
        targetKind: "none",
        ref: "",
        title: "",
        headSha: "",
        outcomes: [{ action: null, code: paused ? "paused" : "resumed" }],
      };
      await store.set(
        GLOBAL_MARKERS_KEY,
        sortNewestFirst([record, ...all]).slice(0, MAX_MARKERS),
      );
      await store.save();
      // Markers merge into EVERY repo's list, so invalidate the whole family.
      void queryClient
        .invalidateQueries({ queryKey: ["automation-history"] })
        .catch(() => undefined);
    });
  } catch {
    // best-effort — a history failure must never surface to the caller
  }
}
