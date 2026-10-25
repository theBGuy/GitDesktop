// Why "Cherry-pick to branch" is held. Free of runtime imports so
// scripts/pick-onto-hold.test.mjs loads it under Node's type stripping.

/** Why the pick-onto rows are held, in display precedence order. */
export type PickOntoHold =
  | "op" // an operation is in progress (checked FIRST)
  | "loading" // the branch list hasn't answered yet
  | "unreadable" // the branch list failed with nothing loaded
  | "all-archived" // every other branch is archived
  | "no-branches"; // no other branch exists

/** The pick-onto gate; null = available. "loading" and "unreadable" read only a
 *  branch list with nothing loaded: loaded data under a failed refetch keeps the
 *  data arms, so only a successful read may claim there are no branches. */
export function pickOntoHold(input: {
  opInProgress: boolean;
  hasData: boolean;
  isPending: boolean;
  isError: boolean;
  /** Offerable destinations (candidates minus the archived ones). */
  targetCount: number;
  /** Every other non-session branch, archived ones included. */
  candidateCount: number;
}): PickOntoHold | null {
  if (input.opInProgress) return "op";
  if (!input.hasData && input.isPending) return "loading";
  if (!input.hasData && input.isError) return "unreadable";
  if (input.targetCount > 0) return null;
  if (input.candidateCount > 0) return "all-archived";
  return "no-branches";
}
