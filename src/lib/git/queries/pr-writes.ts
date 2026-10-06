/**
 * The pure pieces of the PR-write bookkeeping: the key every PR write is filed
 * under, how a write's variables name what it targets, and the matches a PR view
 * holds its controls by.
 *
 * Import-free at runtime on purpose (types only, erased): `scripts/pr-writes.test.mjs`
 * loads it straight from `src/` under Node's type stripping, which resolves no
 * bundler aliases. A runtime import added here fails that test.
 */
import type { RemoteLens } from "../types";

/** The PR writes whose in-flight state a PR view holds its controls on. */
export type PrWriteKind =
  | "comment"
  | "merge"
  | "close"
  | "reopen"
  | "set-draft"
  | "approve"
  | "unapprove"
  | "request-changes"
  | "unrequest-changes"
  | "gl-arm-auto-merge"
  | "gl-cancel-auto-merge"
  | "stack-dissolve";

/** Filter prefix for EVERY PR write ({@link prWriteKey}). */
export const PR_WRITES_KEY = ["pr-write"] as const;

/** A PR write's mutation key. Static per repo, so it never detaches a pending write
 *  across a PR switch, while a repo switch pins the write to the repo it fired in. */
export const prWriteKey = (kind: PrWriteKind, repo: string) =>
  [...PR_WRITES_KEY, kind, repo] as const;

/** One in-flight PR write. `target` is the PR number its variables carry (the
 *  stack number for "stack-dissolve"); `lens` is null where they carry none;
 *  `stack` is the native stack a merge cascades through, null for any other. */
export interface PendingPrWrite {
  kind: PrWriteKind;
  target: number | null;
  lens: RemoteLens | null;
  stack: number | null;
}

/** Reads a write's variables, which the cache filter sees as `unknown`: a bare
 *  number, or an object carrying `number` and optionally `lens` and `stack`. A
 *  field of any other type reads as null, so the write holds nothing by it. */
export function pendingPrWriteTarget(
  vars: unknown,
): Omit<PendingPrWrite, "kind"> {
  if (typeof vars === "number")
    return { target: vars, lens: null, stack: null };
  if (typeof vars !== "object" || vars === null)
    return { target: null, lens: null, stack: null };
  const { number, lens, stack } = vars as Record<string, unknown>;
  return {
    target: typeof number === "number" ? number : null,
    lens: lens === "origin" || lens === "upstream" ? lens : null,
    stack: typeof stack === "number" ? stack : null,
  };
}

/** Whether a `kind` write targeting `target` is in flight: its number, and its lens
 *  where the variables carry one (a lens-less write matches either lens). A null
 *  `target` (nothing to match) holds nothing. */
export function isPendingFor(
  writes: readonly PendingPrWrite[],
  kind: PrWriteKind,
  target: number | null,
  lens: RemoteLens,
): boolean {
  if (target === null) return false;
  return writes.some(
    (w) =>
      w.kind === kind &&
      w.target === target &&
      (w.lens === null || w.lens === lens),
  );
}

/** Whether a merge cascading through native stack `stack` (in `lens`) is in flight —
 *  one fired from any member. A null `stack` (unstacked, or not a native stack)
 *  holds nothing. */
export function isStackMergePendingFor(
  writes: readonly PendingPrWrite[],
  stack: number | null,
  lens: RemoteLens,
): boolean {
  if (stack === null) return false;
  return writes.some(
    (w) =>
      w.kind === "merge" &&
      w.stack === stack &&
      (w.lens === null || w.lens === lens),
  );
}
