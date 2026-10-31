/**
 * Which state a reference card's pull request may claim. When the PR details
 * read fails, the issue read stands in: it tells merged from closed but has no
 * draft axis, so its OPEN can't rule out a draft and renders a neutral
 * "open or draft" instead of a definite state.
 *
 * Must stay free of imports: scripts/ref-card-state.test.mjs loads it directly
 * under Node's type stripping.
 */

export type RefCardStateChoice = "openOrDraft" | "definite";

/** States a stand-in can't claim outright; a state absent here is definite. */
const UNCERTAIN_STATE: Partial<Record<string, "openOrDraft">> = {
  OPEN: "openOrDraft",
};

export function refCardStateChoice(item: {
  flavor: "issue" | "pr";
  state: string;
  stateUncertain?: boolean;
}): RefCardStateChoice {
  if (item.flavor !== "pr" || item.stateUncertain !== true) return "definite";
  return UNCERTAIN_STATE[item.state] ?? "definite";
}

/** The visible state word for the neutral form; written out, never
 *  `capitalize`d, which would paint every word's initial. */
export const OPEN_OR_DRAFT_VISIBLE = "Open or draft";

/** The neutral form's state AND kind for a reader: `noun` with its first
 *  letter upper-cased, then ", open or draft". */
export function openOrDraftWord(noun: string): string {
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)}, open or draft`;
}
