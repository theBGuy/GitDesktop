/**
 * The one wording for staging a conflicted file that may still carry conflict
 * markers. Mark resolved and every generic stage route (row button, menus,
 * Stage all, palette) ask through it, so no route poses a different question.
 * Import-free: `scripts/conflict-confirms.test.mjs` loads it under Node's type
 * stripping. Prompts go through `useConfirm.getState().ask(...)`.
 */

/** A conflicted file a stage would carry markers into; `unchecked` = its sides
 *  read failed, for any cause (oversize, binary, a git error). */
export interface MarkerFlag {
  name: string;
  unchecked: boolean;
}

/** Up to three base names, else a count. */
function flaggedNames(flags: MarkerFlag[]): string {
  return flags.length <= 3
    ? flags.map((f) => f.name).join(", ")
    : `${flags.length} files`;
}

/** The stage-over-markers prompt for a non-empty `flags`. A `bulk` action never
 *  titles itself after one file, since it stages more. */
export function markerStagePrompt(flags: MarkerFlag[], bulk: boolean) {
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
  if (unchecked.length > 0)
    clauses.push(
      `${flaggedNames(unchecked)} couldn't be checked for conflict markers.`,
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
