import { load, type Store } from "@tauri-apps/plugin-store";
import type { ReviewMode } from "@/lib/ai/types";
import {
  identityKeyFor,
  mergeById,
  repoIdentity,
} from "@/lib/git/repo-identity";
import type { RemoteLens } from "@/lib/git/types";
import { storeName } from "@/lib/test-mode";

/**
 * A finished AI review, persisted so the NEXT run of the same PR + mode can feed
 * it back as soft context. Free-form `text` is never parsed into structured data
 * — it stays the model's own markdown, which the next run must re-verify against
 * the current diff. Identity for "the previous review" is `(lens, kind, ref, mode)`;
 * `mode` is part of the key so a security re-run never inherits general findings.
 */
export interface PersistedReview {
  schemaVersion: 1;
  id: string;
  kind: "remote" | "local";
  /** Remote PR number (as a string) or local PR id. */
  ref: string;
  /** Which lens's PR this review covers — a fork's origin and upstream lenses
   *  surface DIFFERENT PRs under the same number. Optional and additive
   *  (`schemaVersion` stays 1): records written before the lens dimension read as
   *  "origin", which is what they were. Local PRs carry the same "origin". */
  lens?: RemoteLens;
  mode: ReviewMode;
  model: string;
  title: string;
  /** Raw finding markdown — the soft context fed into the next run. */
  text: string;
  /** The agentic run's streamed working narration ("Let me check…"), shown behind
   *  a collapsed "Thought process" disclosure. DISPLAY-ONLY metadata — never fed
   *  into the next run's soft context (that reads `text` alone). Absent for
   *  non-agentic / codex runs. Additive optional field; schemaVersion stays 1. */
  thoughts?: string;
  /** PR head at the time this review ran — the delta anchor for the next run. */
  headSha: string;
  startedAt: number;
  finishedAt: number;
  /** Present only on a PARTIAL record: a run that failed with output worth keeping.
   *  Its absence is what makes a record a completed review, so every reader that means
   *  "the previous review" goes through {@link listReviews} / {@link getLatestReview},
   *  which drop partials. Additive optional field; schemaVersion stays 1. */
  phase?: "error";
  /** Why a partial run stopped, as shown to the user. Partial records only. */
  error?: string;
  /** The partial run was killed at its timeout (rather than failing outright) — the
   *  distinction the kept output is labeled with. Partial records only. */
  timedOut?: boolean;
}

/** Whether a stored record is a kept PARTIAL run rather than a completed review.
 *  Store JSON is untrusted, so the flag is compared by exact value, never coerced. */
export function isPartialReview(r: Pick<PersistedReview, "phase">): boolean {
  return r.phase === "error";
}

/** A stored record's findings text, type-checked out of untrusted store JSON (a
 *  hand-edited `pr-reviews.json` reaches the UI verbatim): a non-string `text` reads
 *  as no text instead of throwing mid-render. Shared by every surface that renders a
 *  record's body. */
export const reviewText = (r: Pick<PersistedReview, "text">): string =>
  typeof r.text === "string" ? r.text : "";

/** A partial record's stop reason, type-checked out of untrusted store JSON: a
 *  non-boolean `timedOut` reads as "failed", a non-string `error` as no reason. */
export function partialReviewReason(
  r: Pick<PersistedReview, "timedOut" | "error">,
): { timedOut: boolean; error: string } {
  return {
    timedOut: r.timedOut === true,
    error: typeof r.error === "string" ? r.error : "",
  };
}

/** Reviews kept per `(lens, kind, ref, mode)` — enough to show iteration, bounded
 *  so the store file never balloons. Pruned on every write. */
const MAX_PER_GROUP = 3;

/** Partial runs are grouped separately and capped at one: the latest kept output is
 *  all the panel offers, and a run of timeouts must never evict completed reviews. */
const MAX_PARTIAL_PER_GROUP = 1;

/** A record's lens, defaulting the absent field on pre-lens records to the lens
 *  they were written under. */
const lensOf = (r: Pick<PersistedReview, "lens">): RemoteLens =>
  r.lens ?? "origin";

const groupKey = (
  r: Pick<PersistedReview, "lens" | "kind" | "ref" | "mode" | "phase">,
) =>
  `${lensOf(r)}#${r.kind}#${r.ref}#${r.mode}#${isPartialReview(r) ? "partial" : "done"}`;

// Personal app-data, keyed by the repo's worktree-stable identity — never written
// into the repo itself (the text quotes user source + may contain AI false
// positives). Routed through storeName() so cold-start/test mode never pollutes
// real history.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("pr-reviews.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write on this store through one in-process queue:
// autoSave persists on a ~100ms debounce, so two overlapping mutations would both
// reload the same pre-flush disk snapshot and the later would drop the earlier's
// change (e.g. an automation's review finishing while the user edits another's text).
// Unlike local-prs.json this file has NO external MCP writer, so the overlap is
// entirely in-process. With the force-save in writeAll, each reload sees fresh state.
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
  // this guard the first-ever mutation throws before reaching `save()` and the store
  // can never bootstrap (an external delete of the file breaks every mutation until
  // restart the same way). Fall back to the loaded in-memory state on ANY reload failure.
  try {
    await store.reload({ ignoreDefaults: true });
  } catch {
    // Missing file — the next save() creates it.
  }
}

// Keyed by the repo's worktree-stable identity, so reads merge in any records still
// under a legacy checkout-path key (folded onto the identity by the next write via
// `keyFor`).
async function readMerged(repo: string): Promise<PersistedReview[]> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  const primary = (await store.get<PersistedReview[]>(id)) ?? [];
  const legacy =
    id === repo ? [] : ((await store.get<PersistedReview[]>(repo)) ?? []);
  return mergeById(primary, legacy);
}

/** The identity store key for `repo`, folding any legacy checkout-path-keyed
 *  records onto it once. Call inside the serialized queue (after `reloadRaw`) so
 *  the fold is ordered with the mutation and a delete can't leave a lingering
 *  legacy record that would reappear via `readMerged`'s read-merge. */
async function keyFor(repo: string): Promise<string> {
  const store = await getStore();
  return identityKeyFor<PersistedReview[]>(
    store,
    "pr-reviews",
    repo,
    mergeById,
  );
}

async function readByKey(key: string): Promise<PersistedReview[]> {
  const store = await getStore();
  return (await store.get<PersistedReview[]>(key)) ?? [];
}

async function writeAll(
  key: string,
  records: PersistedReview[],
): Promise<void> {
  const store = await getStore();
  await store.set(key, records);
  // Flush now instead of on autoSave's debounce, so the next serialized reload can't
  // re-read a pre-write disk snapshot and drop this change.
  await store.save();
}

/** Keeps only the newest few records per `(lens, kind, ref, mode)` — completed
 *  reviews and kept partial runs are separate groups with their own caps. */
function prune(records: PersistedReview[]): PersistedReview[] {
  const groups = new Map<string, PersistedReview[]>();
  for (const r of records) {
    const key = groupKey(r);
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }
  const kept: PersistedReview[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => b.finishedAt - a.finishedAt);
    // Every member of a group shares its partial-ness (it's part of the key), so the
    // first member decides the cap.
    const cap = isPartialReview(group[0])
      ? MAX_PARTIAL_PER_GROUP
      : MAX_PER_GROUP;
    kept.push(...group.slice(0, cap));
  }
  return kept;
}

/** Reads the merged records, optionally re-reading the store from disk first.
 *  `fresh` is what the automation gates need: the automation claim is an OS-atomic
 *  lock covering CONCURRENT runs only — after delivery THIS store's record is the
 *  authority, and the plugin-store's per-process cache is otherwise launch-time, so
 *  a second instance would gate on "never reviewed" and re-review. Runs inside the
 *  serialize queue so the reload is ordered with in-flight mutations. */
async function read(
  repo: string,
  opts?: { fresh?: boolean },
): Promise<PersistedReview[]> {
  if (!opts?.fresh) return readMerged(repo);
  return serialize(async () => {
    await reloadRaw();
    return readMerged(repo);
  });
}

/** The most recent review for a specific PR + mode, or undefined if none. `fresh`
 *  re-reads the store from disk first — see {@link read}. */
export async function getLatestReview(
  repo: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
  mode: ReviewMode,
  opts?: { fresh?: boolean },
): Promise<PersistedReview | undefined> {
  const all = await read(repo, opts);
  return all
    .filter(
      (r) =>
        lensOf(r) === lens &&
        r.kind === kind &&
        r.ref === ref &&
        r.mode === mode &&
        !isPartialReview(r),
    )
    .sort((a, b) => b.finishedAt - a.finishedAt)[0];
}

/** Query key for {@link listReviews}. Homed here beside the read it keys, for the
 *  same reason as {@link reviewPartialKey}: the review store and the automations
 *  runner both invalidate it after a write, and neither may pull `queries.ts`'s
 *  react-query/forge-status graph in to do so. */
export const reviewHistoryKey = (
  repo: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
) => ["review-history", repo, lens, kind, ref] as const;

/** Query key for {@link getLatestPartialReview}. Lives here, beside the read it keys,
 *  so all three consumers share one builder: any writer that can remove a partial
 *  record (history clear, per-record delete) must invalidate it, and a hand-written
 *  copy that drifts leaves deleted output on screen. Homed in this module rather than
 *  `queries.ts` so the review store can use it without pulling that module's
 *  react-query/forge-status graph in. */
export const reviewPartialKey = (
  repo: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
) => ["review-partial", repo, lens, kind, ref] as const;

/** The most recent kept PARTIAL run for a PR (either mode), or undefined if none —
 *  the output a timed-out run left behind, which the panel can show after a restart.
 *  Deliberately its own read: a partial is not a review, so nothing that builds on
 *  "the previous review" (prior context, the automation coverage gates) may see it. */
export async function getLatestPartialReview(
  repo: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
): Promise<PersistedReview | undefined> {
  const all = await read(repo);
  return all
    .filter(
      (r) =>
        lensOf(r) === lens &&
        r.kind === kind &&
        r.ref === ref &&
        isPartialReview(r),
    )
    .sort((a, b) => b.finishedAt - a.finishedAt)[0];
}

/** Query key for {@link listPartialReviews}. Deliberately a CHILD of
 *  {@link reviewPartialKey}: react-query matches by prefix, so every writer that already
 *  invalidates that key refreshes this list too, and the set of keys a partial-removing
 *  writer must remember stays at two. */
export const reviewPartialsKey = (
  repo: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
) => [...reviewPartialKey(repo, lens, kind, ref), "list"] as const;

/** Every kept PARTIAL run for a PR, newest first — at most one per mode, so at most two.
 *  A separate read rather than a widening of {@link listReviews} because that read's other
 *  consumers are the automation coverage gates (the runner's pr-open/pr-sync gate and
 *  `prOpenEligible`): a partial visible there would mark a head as already reviewed and
 *  silently stop the automated re-review the timeout made necessary. */
export async function listPartialReviews(
  repo: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
): Promise<PersistedReview[]> {
  const all = await read(repo);
  return all
    .filter(
      (r) =>
        lensOf(r) === lens &&
        r.kind === kind &&
        r.ref === ref &&
        isPartialReview(r),
    )
    .sort((a, b) => b.finishedAt - a.finishedAt);
}

/** Every COMPLETED review for a PR (both modes), newest first. Three consumers, so
 *  what this returns is not a UI-only concern: the "Previous reviews" disclosure, the
 *  runner's pr-open/pr-sync gate, and `prOpenEligible` — the two gates read the whole
 *  retained set to decide whether a head was already covered. Kept partial runs are
 *  excluded for that reason above all — a timed-out run must not mark a head as reviewed
 *  ({@link getLatestPartialReview} is the one reader that wants them). `fresh`
 *  re-reads the store from disk first — see {@link read}. */
export async function listReviews(
  repo: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
  opts?: { fresh?: boolean },
): Promise<PersistedReview[]> {
  const all = await read(repo, opts);
  return all
    .filter(
      (r) =>
        lensOf(r) === lens &&
        r.kind === kind &&
        r.ref === ref &&
        !isPartialReview(r),
    )
    .sort((a, b) => b.finishedAt - a.finishedAt);
}

/** Upserts a finished review — or a kept partial run — by id, then prunes its group
 *  to the newest few. */
export async function saveReview(
  repo: string,
  record: PersistedReview,
): Promise<void> {
  return serialize(async () => {
    await reloadRaw();
    const key = await keyFor(repo);
    const all = await readByKey(key);
    const without = all.filter((r) => r.id !== record.id);
    await writeAll(key, prune([record, ...without]));
  });
}

/** Replaces a stored review's text — backs "trim before re-running" so a user
 *  can delete a false finding and have the edit persist across rounds. */
export async function updateReviewText(
  repo: string,
  id: string,
  text: string,
): Promise<void> {
  return serialize(async () => {
    await reloadRaw();
    const key = await keyFor(repo);
    const all = await readByKey(key);
    await writeAll(
      key,
      all.map((r) => (r.id === id ? { ...r, text } : r)),
    );
  });
}

export async function deleteReview(repo: string, id: string): Promise<void> {
  return serialize(async () => {
    await reloadRaw();
    const key = await keyFor(repo);
    const all = await readByKey(key);
    await writeAll(
      key,
      all.filter((r) => r.id !== id),
    );
  });
}

/** Clears every persisted record for ONE PR (both modes) — completed reviews AND
 *  kept partial runs, since the filter deliberately carries no phase test: "clear this
 *  PR's history" means every stored copy of its output. Scoped so clearing from a PR's
 *  panel never touches the other PRs' history in the same repo, nor the other lens's
 *  same-numbered PR. */
export async function clearReviewsFor(
  repo: string,
  lens: RemoteLens,
  kind: "remote" | "local",
  ref: string,
): Promise<void> {
  return serialize(async () => {
    await reloadRaw();
    const key = await keyFor(repo);
    const all = await readByKey(key);
    await writeAll(
      key,
      all.filter(
        (r) => !(lensOf(r) === lens && r.kind === kind && r.ref === ref),
      ),
    );
  });
}
