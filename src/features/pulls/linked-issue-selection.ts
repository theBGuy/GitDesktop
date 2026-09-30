// Type-only imports: scripts/linked-issue-selection.test.mjs loads this file
// through Node's type stripping, which erases them but resolves no aliases.
import type { LinkedIssueChip } from "./LinkedIssuesField";
import type { LabelTargetSig } from "./pr-label-selection";

/** The target a chip cluster belongs to. An issue number names a different
 *  issue on a fork than on its parent, so chips are only meaningful under the
 *  target (repo AND lens) they were made for — the label pipeline's sig. */
export type LinkedIssueTargetSig = LabelTargetSig;

/** One target's chip cluster: its chips plus the numbers the user removed
 *  there, which upserts (extraction, AI) skip until a manual pick lifts them. */
export type LinkedIssueBucket = {
  chips: LinkedIssueChip[];
  dismissed: ReadonlySet<number>;
};

/** Every target's bucket, keyed by {@link linkedIssueTargetKey}, stamped with
 *  the reset generation it belongs to. */
export type LinkedIssueBuckets = {
  generation: number;
  byTarget: ReadonlyMap<string, LinkedIssueBucket>;
};

/** Title/state a chip resolves from (an open-page row, a probe, a candidate). */
export type IssueMeta = { title: string; state: string };

/** Equal exactly when `sameLabelTarget` holds: same repoPath AND same lens. */
export function linkedIssueTargetKey(sig: LinkedIssueTargetSig): string {
  return JSON.stringify([sig.repoPath, sig.lens]);
}

/** Shared so an untouched target reads a stable `chips` identity. */
export const EMPTY_LINKED_ISSUE_BUCKET: LinkedIssueBucket = {
  chips: [],
  dismissed: new Set(),
};

export const INITIAL_LINKED_ISSUE_BUCKETS: LinkedIssueBuckets = {
  generation: 0,
  byTarget: new Map(),
};

export function bucketFor(
  buckets: LinkedIssueBuckets,
  key: string,
): LinkedIssueBucket {
  return buckets.byTarget.get(key) ?? EMPTY_LINKED_ISSUE_BUCKET;
}

/** The one write path: apply `update` to the bucket of the target the write was
 *  captured under, whether or not that target is the one on screen, so a
 *  late-settling probe or a stream chunk lands where it was made. A write
 *  captured before the last reset (`generation` behind) is dropped: it belongs
 *  to a cluster that no longer exists. Returns the same object when nothing
 *  changed. */
export function routeBucketUpdate(
  buckets: LinkedIssueBuckets,
  key: string,
  generation: number,
  update: (bucket: LinkedIssueBucket) => LinkedIssueBucket,
): LinkedIssueBuckets {
  if (generation !== buckets.generation) return buckets;
  const prev = bucketFor(buckets, key);
  const next = update(prev);
  if (next === prev) return buckets;
  const byTarget = new Map(buckets.byTarget);
  byTarget.set(key, next);
  return { generation: buckets.generation, byTarget };
}

/** A full reset into `generation`: every target's bucket is dropped and `key`
 *  starts from `chips` with nothing dismissed. The caller owns the counter and
 *  passes the value it just advanced to, so writes stamped with it land. */
export function seedBuckets(
  generation: number,
  key: string,
  chips: LinkedIssueChip[],
): LinkedIssueBuckets {
  return {
    generation,
    byTarget: new Map([[key, { chips, dismissed: new Set<number>() }]]),
  };
}

/** Union the model's proposed numbers into one target's bucket. Both kinds land
 *  as `relates` (the user toggles up); a close proposal sets `aiSuggestedClose`,
 *  upgrading an existing chip without ever downgrading one. Dismissed numbers
 *  and numbers missing from `fed` (never offered to the model) are skipped.
 *  An empty `fed` changes nothing: the run offered the model no issue (or a
 *  reset cleared its set), so no proposal can name one of these chips. */
export function upsertAiIssues(
  bucket: LinkedIssueBucket,
  draft: { closes: number[]; relates: number[] },
  fed: ReadonlyMap<number, IssueMeta>,
): LinkedIssueBucket {
  if (fed.size === 0) return bucket;
  const closeSet = new Set(draft.closes);
  let next = bucket.chips;
  for (const n of new Set([...draft.closes, ...draft.relates])) {
    if (bucket.dismissed.has(n)) continue;
    const suggestedClose = closeSet.has(n);
    const existingIdx = next.findIndex((c) => c.number === n);
    if (existingIdx >= 0) {
      if (suggestedClose && !next[existingIdx].aiSuggestedClose) {
        next = next.map((c, i) =>
          i === existingIdx ? { ...c, aiSuggestedClose: true } : c,
        );
      }
      continue;
    }
    const meta = fed.get(n);
    if (!meta) continue;
    next = [
      ...next,
      {
        number: n,
        title: meta.title,
        state: meta.state,
        keyword: "relates",
        source: "ai",
        aiSuggestedClose: suggestedClose,
      },
    ];
  }
  return next === bucket.chips ? bucket : { ...bucket, chips: next };
}

/** Remove a chip and tombstone its number for later upserts in this target. */
export function dismissIssue(
  bucket: LinkedIssueBucket,
  n: number,
): LinkedIssueBucket {
  const dismissed = new Set(bucket.dismissed);
  dismissed.add(n);
  return { chips: bucket.chips.filter((c) => c.number !== n), dismissed };
}

/** A manual pick is explicit intent: it lifts a dismissal and adds `chip`
 *  unless the number is already present. */
export function pickIssue(
  bucket: LinkedIssueBucket,
  chip: LinkedIssueChip,
): LinkedIssueBucket {
  const dismissed = new Set(bucket.dismissed);
  dismissed.delete(chip.number);
  const present = bucket.chips.some((c) => c.number === chip.number);
  return { chips: present ? bucket.chips : [...bucket.chips, chip], dismissed };
}

export function toggleIssueKeyword(
  bucket: LinkedIssueBucket,
  n: number,
): LinkedIssueBucket {
  if (!bucket.chips.some((c) => c.number === n)) return bucket;
  return {
    ...bucket,
    chips: bucket.chips.map((c) =>
      c.number === n
        ? { ...c, keyword: c.keyword === "closes" ? "relates" : "closes" }
        : c,
    ),
  };
}

/** An extraction seed joins only when the number is neither present nor
 *  dismissed in this target. */
export function addExtractedIssue(
  bucket: LinkedIssueBucket,
  chip: LinkedIssueChip,
): LinkedIssueBucket {
  if (bucket.dismissed.has(chip.number)) return bucket;
  if (bucket.chips.some((c) => c.number === chip.number)) return bucket;
  return { ...bucket, chips: [...bucket.chips, chip] };
}

/** Fill a still-untitled chip's title/state; a titled chip is never touched,
 *  so a probe can't fight an earlier resolution. */
export function fillIssueMeta(
  bucket: LinkedIssueBucket,
  n: number,
  meta: IssueMeta,
): LinkedIssueBucket {
  if (!bucket.chips.some((c) => c.number === n && c.title === ""))
    return bucket;
  return {
    ...bucket,
    chips: bucket.chips.map((c) =>
      c.number === n && c.title === ""
        ? { ...c, title: meta.title, state: meta.state }
        : c,
    ),
  };
}

/** {@link fillIssueMeta} for every untitled chip found on this target's open
 *  page. */
export function backfillFromOpenPage(
  bucket: LinkedIssueBucket,
  openIssues: ReadonlyArray<IssueMeta & { number: number }>,
): LinkedIssueBucket {
  let next = bucket;
  for (const c of bucket.chips) {
    if (c.title !== "") continue;
    const hit = openIssues.find((i) => i.number === c.number);
    if (hit) next = fillIssueMeta(next, c.number, hit);
  }
  return next;
}
