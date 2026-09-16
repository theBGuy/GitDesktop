// The automation decisions that are plain data in, plain data out. They live
// apart from their callers so `scripts/*.test.mjs` can import this file under
// Node's type stripping: every import here must stay type-only and every path
// relative (stripping erases types but resolves no bundler aliases), or the
// tests stop resolving.
import type { Branch } from "../git/types";
import type { AutomationRunResult } from "./results";

/**
 * Whether the local `base`/`head` refs can stand in for the provider's PR diff.
 * A stale-but-present local ref returns a clean but WRONG diff, so the answer is
 * false for everything unverifiable: no head sha, no local head branch, a head
 * that moved, or a base whose own upstream tracking can't vouch for it.
 * `sameSha` is injected because its home (`./sync`) reaches Tauri — tolerating
 * short-vs-full shas is the caller's contract, not this predicate's.
 *
 * `headSha`, `base` and `head` are three adjacent strings — a swapped call site
 * compiles, so keep the argument order matched against the runner's call.
 */
export function localRefsFresh(
  tips: Record<string, string>,
  branches: Branch[],
  headSha: string,
  base: string,
  head: string,
  sameSha: (a: string, b: string) => boolean,
): boolean {
  if (!headSha) return false;
  const tip = tips[head];
  if (!tip || !sameSha(tip, headSha)) return false;
  const baseBranch = branches.find((b) => b.name === base);
  return (
    baseBranch !== undefined &&
    baseBranch.upstream !== null &&
    !baseBranch.upstreamGone &&
    baseBranch.upstreamAhead === 0 &&
    baseBranch.upstreamBehind === 0
  );
}

/** Shape-guard one record out of untrusted store JSON: a hand-edited (or older)
 *  `automation-results.json` reaches the dialog verbatim, so a malformed record is
 *  dropped rather than blanking the list or throwing mid-render. Every field left
 *  unchecked is guarded at its consumer instead: `mode` / `phase` / `timedOut` are
 *  compared by exact value in `AutomationResultDialog` and `error` is typeof-guarded
 *  at its render site there, `repoPath` is dereferenced only on the write path
 *  (`persist`, whose caller is runner-typed), and `schemaVersion` is write-only. */
export function isStoredResult(x: unknown): x is AutomationRunResult {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.text === "string" &&
    typeof r.subject === "string" &&
    typeof r.createdAt === "string" &&
    typeof r.hash === "string"
  );
}

/** Newest `max` by `createdAt`. A record whose stamp doesn't parse can't be
 *  ordered, so those sort after the dated ones and keep their insertion order —
 *  a junk stamp costs its own position, never someone else's. */
export function pruneByCreatedAt<T extends { createdAt: string }>(
  records: T[],
  max: number,
): T[] {
  return records
    .map((record, index) => {
      const ts = new Date(record.createdAt).getTime();
      return { record, index, ts: Number.isNaN(ts) ? null : ts };
    })
    .sort((a, b) => {
      if (a.ts === null || b.ts === null) {
        if (a.ts !== b.ts) return a.ts === null ? 1 : -1;
        return a.index - b.index;
      }
      return b.ts - a.ts;
    })
    .slice(0, max)
    .map((x) => x.record);
}
