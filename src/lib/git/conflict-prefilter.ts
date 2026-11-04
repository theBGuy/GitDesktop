// Runtime-import-free on purpose: scripts/conflict-prefilter.test.mjs loads this
// module under Node's type stripping, which resolves no path aliases. The
// statement-level type import below is erased; an inline `import { type … }`
// would not be.
import type { ConflictSides } from "./conflict";

/** Sides reads in flight at once: each spawns several git processes, and a
 *  "Resolve all" can cover hundreds of conflicts. Same budget as ChangesPanel's
 *  stage-time marker reads. */
export const SIDES_READ_CHUNK = 4;

/** Why a conflicted file never reaches the model. */
export type ConflictBlockReason =
  | "undecodable"
  | "partUndecodable"
  | "unreadableName"
  | "excluded";

/** A sides read the backend refuses on every retry: the file is binary, past
 *  the AI size cap, a symbolic link itself, or reached through a link. */
export type ConflictRefusal =
  | "binary"
  | "tooLarge"
  | "linkedLeaf"
  | "linkedPath";

/** Why "Resolve all with AI" leaves a file out of its walk. `resolved` and the
 *  refusals are the prefilter's own reasons, never part of the blocked gate. */
export type ConflictSkipReason =
  | ConflictBlockReason
  | ConflictRefusal
  | "resolved";

// Twins of conflict.rs's RESOLVE_TOO_LARGE_REFUSAL and RESOLVE_BINARY_REFUSAL,
// and of the path-gate sentence closing on ops.rs's DISCARD_LINKED;
// scripts/conflict-prefilter.test.mjs pins each congruent.
export const TOO_LARGE_REFUSAL = "file is too large for AI conflict resolution";
export const BINARY_REFUSAL = "binary file — resolve this conflict by hand";
export const LINKED_ANCESTOR_TAIL =
  " — it's reached through a symbolic link or junction. Nothing was changed.";

/** Classifies a rejected sides read, or null when a retry could still succeed.
 *  `detail` is the invalid-argument message without its Rust lead; `pathRefusal`
 *  is conflict-banner-state's `conflictPathRefusal` verdict. Only a link
 *  refusal counts among the path-gate refusals: the rest stay for the walk's
 *  blocked screen, which names their reason. */
export function sidesRefusal(
  detail: string,
  pathRefusal: { summary: string; linkedLeaf: boolean } | null,
): ConflictRefusal | null {
  if (detail === TOO_LARGE_REFUSAL) return "tooLarge";
  if (detail === BINARY_REFUSAL) return "binary";
  if (pathRefusal === null) return null;
  if (pathRefusal.linkedLeaf) return "linkedLeaf";
  if (pathRefusal.summary.endsWith(LINKED_ANCESTOR_TAIL)) return "linkedPath";
  return null;
}

type BlockInputs = Pick<
  ConflictSides,
  "undecodable" | "workingUndecodable" | "aiIgnored"
>;

/** ConflictResolveView's blocked gate, with its reason: non-null exactly when
 *  `undecodable || aiIgnored.ignored`. Byte safety outranks the ignore verdict,
 *  and a working file that isn't UTF-8 outranks a stage blob that isn't. */
export function conflictAiBlockReason(
  sides: BlockInputs,
): ConflictBlockReason | null {
  if (sides.undecodable) {
    return sides.workingUndecodable ? "undecodable" : "partUndecodable";
  }
  if (sides.aiIgnored.ignored) {
    return sides.aiIgnored.unreadable ? "unreadableName" : "excluded";
  }
  return null;
}

/** One file's prefilter inputs: the blocked gate's flags plus whether the read
 *  found no unmerged stage (conflict-parse's `noLongerConflicted`). */
export type PrefilterVerdict = BlockInputs & { resolved: boolean };

/** A settled read's input to `partition`: a verdict, or the refusal a
 *  rejected read was classified as. */
export type PrefilterRead = PrefilterVerdict | { refused: ConflictRefusal };

export interface PrefilterSkip {
  path: string;
  reason: ConflictSkipReason;
}

/** Splits click-time paths by their settled reads, index-aligned with `paths`.
 *  A rejected read queues its path: the walk's own screen is the backstop, so
 *  only a refusal the caller classified (`refused`) skips a failed read. */
export function partition(
  paths: string[],
  reads: PromiseSettledResult<PrefilterRead>[],
): { queued: string[]; skipped: PrefilterSkip[] } {
  const queued: string[] = [];
  const skipped: PrefilterSkip[] = [];
  paths.forEach((path, i) => {
    const read = reads[i];
    if (read?.status !== "fulfilled") {
      queued.push(path);
      return;
    }
    const value = read.value;
    const reason: ConflictSkipReason | null =
      "refused" in value
        ? value.refused
        : value.resolved
          ? "resolved"
          : conflictAiBlockReason(value);
    if (reason === null) queued.push(path);
    else skipped.push({ path, reason });
  });
  return { queued, skipped };
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Per-reason copy: `one` follows "Skipped <file> (", `count(n)` follows a
 *  count. None of it names the user's patterns for an unreadable name, which is
 *  withheld with no pattern at all. */
const SKIP_COPY: Record<
  ConflictSkipReason,
  { one: string; count: (n: number) => string }
> = {
  resolved: {
    one: "it's already resolved",
    count: (n) => (n === 1 ? "is already resolved" : "are already resolved"),
  },
  undecodable: {
    one: "it isn't UTF-8 text",
    count: (n) => (n === 1 ? "isn't UTF-8 text" : "aren't UTF-8 text"),
  },
  partUndecodable: {
    one: "part of it isn't UTF-8 text",
    count: (n) =>
      n === 1
        ? "has a part that isn't UTF-8 text"
        : "have parts that aren't UTF-8 text",
  },
  binary: {
    one: "it's a binary file",
    count: (n) => (n === 1 ? "is binary" : "are binary"),
  },
  tooLarge: {
    one: "it's too large for AI",
    count: (n) => (n === 1 ? "is too large for AI" : "are too large for AI"),
  },
  linkedLeaf: {
    one: "it's a symbolic link",
    count: (n) => (n === 1 ? "is a symbolic link" : "are symbolic links"),
  },
  linkedPath: {
    one: "its path goes through a link",
    count: (n) =>
      n === 1 ? "has a path through a link" : "have paths through a link",
  },
  unreadableName: {
    one: "its name isn't readable text",
    count: (n) =>
      n === 1
        ? "has a name that isn't readable text"
        : "have names that aren't readable text",
  },
  excluded: {
    one: "it's excluded from AI",
    count: (n) => (n === 1 ? "is excluded from AI" : "are excluded from AI"),
  },
};

/** Clause order in the count forms. */
const REASON_ORDER: ConflictSkipReason[] = [
  "resolved",
  "undecodable",
  "partUndecodable",
  "binary",
  "tooLarge",
  "linkedLeaf",
  "linkedPath",
  "unreadableName",
  "excluded",
];

const files = (n: number) => (n === 1 ? "file" : "files");

/** Comma-joined "<n> <predicate>" clauses, zero counts omitted; `noun` puts
 *  "file(s)" after the first count. */
function countClauses(skipped: PrefilterSkip[], noun: boolean): string {
  return REASON_ORDER.flatMap((reason) => {
    const n = skipped.filter((s) => s.reason === reason).length;
    return n === 0 ? [] : [{ reason, n }];
  })
    .map(
      ({ reason, n }, i) =>
        `${n}${noun && i === 0 ? ` ${files(n)}` : ""} ${SKIP_COPY[reason].count(n)}`,
    )
    .join(", ");
}

/** The summary toast, or null when nothing was skipped. `total` is the number
 *  of paths at the press. */
export function prefilterToast({
  total,
  queued,
  skipped,
}: {
  total: number;
  queued: string[];
  skipped: PrefilterSkip[];
}): string | null {
  if (skipped.length === 0) return null;
  if (queued.length === 0) {
    if (skipped.length === 1) {
      const [only] = skipped;
      return `Nothing to resolve with AI: ${basename(only.path)} ${SKIP_COPY[only.reason].count(1)}.`;
    }
    return `Nothing to resolve with AI: ${countClauses(skipped, true)}.`;
  }
  const lead = `Resolving ${queued.length} of ${total} ${files(total)} with AI.`;
  if (skipped.length === 1) {
    const [only] = skipped;
    return `${lead} Skipped ${basename(only.path)} (${SKIP_COPY[only.reason].one}).`;
  }
  return `${lead} Skipped ${skipped.length} files: ${countClauses(skipped, false)}.`;
}

/** The banner's hold reason while the prefilter reads. */
export const PREFILTER_READ_REASON = "Reading the conflicted files…";
