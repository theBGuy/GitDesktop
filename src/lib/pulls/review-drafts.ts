import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { load, type Store } from "@tauri-apps/plugin-store";
import {
  identityKeyFor,
  mergeById,
  repoIdentity,
} from "@/lib/git/repo-identity";
import type { RemoteLens } from "@/lib/git/types";
import { storeName } from "@/lib/test-mode";

/** One pending draft comment in a not-yet-submitted batch review. `id` is a local
 *  uuid (these drafts never leave the client until the review is submitted). */
export interface ReviewDraft {
  id: string;
  path: string;
  line: number;
  /** "new" (right side) or "old" (left side). */
  side: "new" | "old";
  /** First line of a multi-line range (1-based); omitted for a single line. */
  startLine?: number;
  body: string;
  createdAt: string;
}

/** Drafts for one PR/MR, keyed `${lens}#${number}`. The lens is part of the key
 *  because a fork's origin and upstream lenses surface DIFFERENT PRs under the same
 *  number — without it a draft written on one would be submitted against the other. */
type PrDrafts = Record<string, ReviewDraft[]>;

const draftKey = (lens: RemoteLens, number: number) => `${lens}#${number}`;

/** The bare-number key this lens key supersedes — records written before the lens
 *  dimension existed, which can only have been the origin lens. */
const legacyDraftKey = (lens: RemoteLens, number: number) =>
  lens === "origin" ? String(number) : undefined;

// Personal app-data, keyed by repo path → per-PR drafts — never written into the
// repo itself. Mirrors `local.ts`'s store idiom.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(storeName("pr-review-drafts.json"), {
    autoSave: true,
    defaults: {},
  });
  return storePromise;
}

// Serialize every read-modify-write on this store through one in-process queue.
// Without it, two overlapping mutations each reload the SAME pre-flush disk
// snapshot — autoSave persists on a ~100ms debounce, so the first write isn't on
// disk yet — and the later write drops the earlier one's change (a lost update).
// Running them one at a time, plus the force-save in writeAll, guarantees each
// read sees a current snapshot. (This repo has been bitten by store write races.)
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const run = opChain.then(op, op);
  // Keep the queue alive whether `op` fulfilled or rejected; callers still get `run`.
  opChain = run.catch(() => undefined);
  return run;
}

/** Merge two per-PR draft maps, de-duplicating each PR's drafts by id (`keep`
 *  wins). Folds a legacy checkout-path draft map into the identity key's. */
function mergeDrafts(keep: PrDrafts | undefined, extra: PrDrafts): PrDrafts {
  const out: PrDrafts = { ...(keep ?? {}) };
  for (const [num, drafts] of Object.entries(extra)) {
    out[num] = mergeById(out[num], drafts);
  }
  return out;
}

// Keyed by the repo's worktree-stable identity (not its checkout path) so draft
// reviews are shared across the main checkout and every worktree. Reads merge in
// any drafts still under a legacy checkout-path key (folded on the next write).
async function readMerged(repo: string): Promise<PrDrafts> {
  const store = await getStore();
  const id = await repoIdentity(repo);
  const primary = (await store.get<PrDrafts>(id)) ?? {};
  const legacy = id === repo ? {} : ((await store.get<PrDrafts>(repo)) ?? {});
  return mergeDrafts(primary, legacy);
}

/** Identity store key for `repo`, folding any legacy checkout-path drafts onto it
 *  once. Call inside the serialized queue. */
async function keyFor(repo: string): Promise<string> {
  const store = await getStore();
  return identityKeyFor<PrDrafts>(store, "pr-review-drafts", repo, mergeDrafts);
}

async function readByKey(key: string): Promise<PrDrafts> {
  const store = await getStore();
  return (await store.get<PrDrafts>(key)) ?? {};
}

async function writeRepo(key: string, drafts: PrDrafts): Promise<void> {
  const store = await getStore();
  await store.set(key, drafts);
  // Flush now instead of on autoSave's debounce, so the next serialized read can't
  // re-read a pre-write disk snapshot and drop this change.
  await store.save();
}

/** Folds a pre-lens bare-number entry onto its `origin#…` key, returning the map to
 *  mutate. Non-destructive and incremental like the checkout-path fold above: the
 *  drafts move with the caller's own write, one PR at a time, never as a sweep. */
function foldLegacyKey(
  all: PrDrafts,
  lens: RemoteLens,
  number: number,
): PrDrafts {
  const legacy = legacyDraftKey(lens, number);
  if (legacy === undefined || all[legacy] === undefined) return all;
  const k = draftKey(lens, number);
  const next = { ...all, [k]: mergeById(all[k], all[legacy]) };
  delete next[legacy];
  return next;
}

export async function listDrafts(
  repo: string,
  lens: RemoteLens,
  number: number,
): Promise<ReviewDraft[]> {
  const all = await readMerged(repo);
  const own = all[draftKey(lens, number)];
  const legacy = legacyDraftKey(lens, number);
  const legacyDrafts = legacy === undefined ? undefined : all[legacy];
  return legacyDrafts ? mergeById(own, legacyDrafts) : (own ?? []);
}

export async function addDraft(
  repo: string,
  lens: RemoteLens,
  number: number,
  draft: ReviewDraft,
): Promise<void> {
  return serialize(async () => {
    const repoKey = await keyFor(repo);
    const all = foldLegacyKey(await readByKey(repoKey), lens, number);
    const k = draftKey(lens, number);
    await writeRepo(repoKey, { ...all, [k]: [...(all[k] ?? []), draft] });
  });
}

export async function updateDraft(
  repo: string,
  lens: RemoteLens,
  number: number,
  id: string,
  body: string,
): Promise<void> {
  return serialize(async () => {
    const repoKey = await keyFor(repo);
    const all = foldLegacyKey(await readByKey(repoKey), lens, number);
    const k = draftKey(lens, number);
    const next = (all[k] ?? []).map((d) => (d.id === id ? { ...d, body } : d));
    await writeRepo(repoKey, { ...all, [k]: next });
  });
}

export async function removeDraft(
  repo: string,
  lens: RemoteLens,
  number: number,
  id: string,
): Promise<void> {
  return serialize(async () => {
    const repoKey = await keyFor(repo);
    const all = foldLegacyKey(await readByKey(repoKey), lens, number);
    const k = draftKey(lens, number);
    await writeRepo(repoKey, {
      ...all,
      [k]: (all[k] ?? []).filter((d) => d.id !== id),
    });
  });
}

export async function clearDrafts(
  repo: string,
  lens: RemoteLens,
  number: number,
): Promise<void> {
  return serialize(async () => {
    const repoKey = await keyFor(repo);
    // Fold first: a discard must take the pre-lens entry with it, or `listDrafts`
    // would read the legacy drafts straight back after the clear. Copied before the
    // delete — the fold passes the store's own object through when there's nothing
    // to fold, and that must not be mutated in place.
    const next = { ...foldLegacyKey(await readByKey(repoKey), lens, number) };
    delete next[draftKey(lens, number)];
    await writeRepo(repoKey, next);
  });
}

// ── React-query wrappers ─────────────────────────────────────────────────────

const reviewDraftsKey = (repo: string, lens: RemoteLens, number: number) =>
  ["repo", repo, "pr", lens, number, "review-drafts"] as const;

/** The persisted pending-review drafts for a PR/MR. */
export function useReviewDrafts(
  repo: string,
  lens: RemoteLens,
  number: number,
) {
  return useQuery({
    queryKey: reviewDraftsKey(repo, lens, number),
    queryFn: () => listDrafts(repo, lens, number),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useAddReviewDraft(
  repo: string,
  lens: RemoteLens,
  number: number,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: ReviewDraft) => addDraft(repo, lens, number, draft),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: reviewDraftsKey(repo, lens, number),
      }),
  });
}

export function useUpdateReviewDraft(
  repo: string,
  lens: RemoteLens,
  number: number,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; body: string }) =>
      updateDraft(repo, lens, number, args.id, args.body),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: reviewDraftsKey(repo, lens, number),
      }),
  });
}

export function useRemoveReviewDraft(
  repo: string,
  lens: RemoteLens,
  number: number,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => removeDraft(repo, lens, number, id),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: reviewDraftsKey(repo, lens, number),
      }),
  });
}

export function useClearReviewDrafts(
  repo: string,
  lens: RemoteLens,
  number: number,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => clearDrafts(repo, lens, number),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: reviewDraftsKey(repo, lens, number),
      }),
  });
}
