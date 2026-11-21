/**
 * The one wording for staging a conflicted file that may still carry conflict
 * markers. Mark resolved and every generic stage route (row button, menus,
 * Stage all, palette) ask through it, so no route poses a different question.
 * Import-free: `scripts/conflict-confirms.test.mjs` loads it under Node's type
 * stripping. Prompts go through `useConfirm.getState().ask(...)`.
 */

/** A conflicted file a stage would carry markers into; `unchecked` = its
 *  markers couldn't be checked, for any cause (binary, a failed scan of a file
 *  too large to read, a git error). `cause` names
 *  the read's refusal when the caller knows it; without one the prompt says
 *  only that the file couldn't be checked. */
export interface MarkerFlag {
  name: string;
  unchecked: boolean;
  cause?: MarkerCheckCause;
}

export type MarkerCheckCause = "binary" | "tooLarge";

/** Up to three base names, else a count. */
function flaggedNames(flags: MarkerFlag[]): string {
  return flags.length <= 3
    ? flags.map((f) => f.name).join(", ")
    : `${flags.length} files`;
}

/** Why a caused group went unchecked; the clauses differ only before ", so". */
const CAUSE_CLAUSE: Record<MarkerCheckCause, { one: string; many: string }> = {
  binary: {
    one: "looks like a binary file, so it wasn't checked for conflict markers.",
    many: "look like binary files, so they weren't checked for conflict markers.",
  },
  tooLarge: {
    one: "is too large to read here, so it wasn't checked for conflict markers.",
    many: "are too large to read here, so they weren't checked for conflict markers.",
  },
};

/** Caused groups in the order the prompt names them. */
const CAUSE_ORDER: readonly MarkerCheckCause[] = ["binary", "tooLarge"];

/** The binary-only prompt's title: a bulk action never titles itself after
 *  one file, and one file's title stays singular. */
function binaryStageTitle(flags: MarkerFlag[], bulk: boolean): string {
  if (flags.length > 1) return "Stage binary files as they are on disk?";
  return bulk
    ? "Stage a binary file as it is on disk?"
    : `Stage ${flags[0].name} as it is on disk?`;
}

/** The prompt when every flag is a binary file: it makes no claim about
 *  markers, since a binary file's content can't be checked at all. */
function binaryStagePrompt(flags: MarkerFlag[], bulk: boolean) {
  const one = flags.length === 1;
  return {
    title: binaryStageTitle(flags, bulk),
    body: one
      ? `${flags[0].name} looks like a binary file, so GitDesktop can't merge it or check what it holds. Staging it marks the conflict resolved with the file exactly as it is on disk now.`
      : `${flaggedNames(flags)} look like binary files, so GitDesktop can't merge them or check what they hold. Staging them marks those conflicts resolved with the files exactly as they are on disk now.`,
    confirmLabel: "Stage anyway",
    confirmVariant: "destructive" as const,
  };
}

/** The stage-over-markers prompt for a non-empty `flags`. A `bulk` action never
 *  titles itself after one file, since it stages more. */
export function markerStagePrompt(flags: MarkerFlag[], bulk: boolean) {
  if (flags.every((f) => f.cause === "binary"))
    return binaryStagePrompt(flags, bulk);
  const marked = flags.filter((f) => !f.unchecked);
  const unchecked = flags.filter((f) => f.unchecked);
  const markers =
    unchecked.length > 0 ? "possible conflict markers" : "conflict markers";
  const which = unchecked.length > 0 ? "any" : "the";
  const one = flags.length === 1;
  const clauses: string[] = [];
  if (marked.length > 0)
    clauses.push(
      `${flaggedNames(marked)} still ${marked.length === 1 ? "has" : "have"} conflict markers.`,
    );
  for (const cause of CAUSE_ORDER) {
    const group = unchecked.filter((f) => f.cause === cause);
    if (group.length === 0) continue;
    const clause = CAUSE_CLAUSE[cause];
    clauses.push(
      `${flaggedNames(group)} ${group.length === 1 ? clause.one : clause.many}`,
    );
  }
  const uncaused = unchecked.filter((f) => f.cause === undefined);
  if (uncaused.length > 0)
    clauses.push(
      `${flaggedNames(uncaused)} couldn't be checked for conflict markers.`,
    );
  clauses.push(
    one
      ? `Staging it marks the conflict resolved with ${which} markers in the file, and they'll be committed unless you remove them first.`
      : `Staging them marks those conflicts resolved with ${which} markers in the files, and they'll be committed unless you remove them first.`,
  );
  return {
    title:
      one && !bulk
        ? `Stage ${flags[0].name} with ${markers}?`
        : `Stage files with ${markers}?`,
    body: clauses.join(" "),
    confirmLabel: "Stage anyway",
    confirmVariant: "destructive" as const,
  };
}
