/**
 * The pure pieces of the PR-write bookkeeping, remote and local: the key every PR
 * write is filed under, how a write's variables name what it targets, and the
 * matches a PR view holds its controls by.
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
  | "stack-dissolve"
  | "stack-create"
  | "stack-add"
  | "checkout"
  | "update-branch"
  | "resolve-merge"
  | "abort-resolve";

/** Filter prefix for EVERY PR write ({@link prWriteKey}). */
export const PR_WRITES_KEY = ["pr-write"] as const;

/** A PR write's mutation key. Static per repo, so it never detaches a pending write
 *  across a PR switch, while a repo switch pins the write to the repo it fired in. */
export const prWriteKey = (kind: PrWriteKind, repo: string) =>
  [...PR_WRITES_KEY, kind, repo] as const;

/** One in-flight PR write. `target` is the PR number its variables carry (the
 *  stack number for "stack-dissolve"); `lens` is null where they carry none;
 *  `stack` is the native stack a merge cascades through or a stack add appends to
 *  (GitHub numbers stacks apart from PRs), null for any other; `members` is the PR
 *  list a stack create or add writes, null where the variables carry none. */
export interface PendingPrWrite {
  kind: PrWriteKind;
  target: number | null;
  lens: RemoteLens | null;
  stack: number | null;
  members: number[] | null;
}

/** A value that is a number, or null. */
function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** The numbers in a list, or none when it isn't one. */
function numberList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((n): n is number => typeof n === "number")
    : [];
}

/** Reads a write's variables, which the cache filter sees as `unknown`: a bare
 *  number, a stack create's PR list, or an object carrying `number` and optionally
 *  `lens` and `stack` (a stack add: `pullRequests` and `stackNumber`). A field of
 *  any other type reads as null, so the write holds nothing by it. */
export function pendingPrWriteTarget(
  vars: unknown,
): Omit<PendingPrWrite, "kind"> {
  if (typeof vars === "number")
    return { target: vars, lens: null, stack: null, members: null };
  if (Array.isArray(vars)) {
    const members = numberList(vars);
    return {
      target: null,
      lens: null,
      stack: null,
      members: members.length > 0 ? members : null,
    };
  }
  if (typeof vars !== "object" || vars === null)
    return { target: null, lens: null, stack: null, members: null };
  const { number, lens, stack, pullRequests, stackNumber } = vars as Record<
    string,
    unknown
  >;
  const members = numberList(pullRequests);
  return {
    target: num(number),
    lens: lens === "origin" || lens === "upstream" ? lens : null,
    stack: num(stack) ?? num(stackNumber),
    members: members.length > 0 ? members : null,
  };
}

/** A cache entry's kind and variables as a {@link PendingPrWrite}. */
export const readPendingPrWrite = (
  kind: string,
  vars: unknown,
): PendingPrWrite => ({
  kind: kind as PrWriteKind,
  ...pendingPrWriteTarget(vars),
});

/** One pending mutation as the cache holds it. */
export interface PendingMutationEntry {
  key: readonly unknown[] | undefined;
  vars: unknown;
}

/** The writes among `entries` filed against `repo` (keyed `[prefix, kind, repo]`),
 *  each read through `read`. One keyed to another repo, or with no kind, is dropped:
 *  a hold never crosses repos. */
export function pendingWritesFor<W>(
  entries: readonly PendingMutationEntry[],
  repo: string,
  read: (kind: string, vars: unknown) => W,
): W[] {
  return entries.flatMap((e) => {
    const [, kind, keyRepo] = e.key ?? [];
    return keyRepo === repo && typeof kind === "string"
      ? [read(kind, e.vars)]
      : [];
  });
}

/** The first in-flight write of `kind`, whatever it targets: a repo-wide hold reads
 *  this, and its fields name what the hold is waiting on. */
export function pendingWriteOfKind<W extends { kind: string }>(
  writes: readonly W[],
  kind: W["kind"],
): W | undefined {
  return writes.find((w) => w.kind === kind);
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

/** Whether a stack create or add naming PR `target` among its members is in flight,
 *  whichever PR's offer fired it. A null `target` holds nothing. */
export function isStackWritePendingFor(
  writes: readonly PendingPrWrite[],
  target: number | null,
  lens: RemoteLens,
): boolean {
  if (target === null) return false;
  return writes.some(
    (w) =>
      (w.kind === "stack-create" || w.kind === "stack-add") &&
      (w.members?.includes(target) ?? false) &&
      (w.lens === null || w.lens === lens),
  );
}

/** The local-PR writes whose in-flight state a local PR view holds its controls on. */
export type LocalPrWriteKind = "merge" | "update-from";

/** Filter prefix for EVERY local-PR write ({@link localPrWriteKey}); disjoint from
 *  {@link PR_WRITES_KEY}, so neither aggregate sees the other's writes. */
export const LOCAL_PR_WRITES_KEY = ["local-pr-write"] as const;

/** A local-PR write's mutation key, static per repo like {@link prWriteKey}. */
export const localPrWriteKey = (kind: LocalPrWriteKind, repo: string) =>
  [...LOCAL_PR_WRITES_KEY, kind, repo] as const;

/** One in-flight local-PR write and the branches its variables name: `head` is the
 *  branch it writes into, `base` the one it brings in; null where they carry none. */
export interface PendingLocalPrWrite {
  kind: LocalPrWriteKind;
  base: string | null;
  head: string | null;
}

/** Where each kind's variables carry the branch it writes into. */
const LOCAL_HEAD_FIELD: Record<LocalPrWriteKind, string> = {
  merge: "head",
  "update-from": "branch",
};

/** Reads a local-PR write's variables, which the cache filter sees as `unknown`. A
 *  field of any other type reads as null. */
export function pendingLocalPrWrite(
  kind: LocalPrWriteKind,
  vars: unknown,
): PendingLocalPrWrite {
  if (typeof vars !== "object" || vars === null)
    return { kind, base: null, head: null };
  const fields = vars as Record<string, unknown>;
  const base = fields.base;
  const head = fields[LOCAL_HEAD_FIELD[kind]];
  return {
    kind,
    base: typeof base === "string" ? base : null,
    head: typeof head === "string" ? head : null,
  };
}

/** A cache entry's kind and variables as a {@link PendingLocalPrWrite}. */
export const readPendingLocalPrWrite = (kind: string, vars: unknown) =>
  pendingLocalPrWrite(kind as LocalPrWriteKind, vars);
