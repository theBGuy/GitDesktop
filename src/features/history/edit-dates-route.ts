/**
 * Where "Edit dates…" takes a commit: HEAD gets its own small dialog, an
 * unpushed commit Edit history can reach opens there, and anything else is
 * held with a reason. Pure and import-free, so scripts/edit-dates-route.test.mjs
 * loads it under Node's type stripping; it takes primitives only.
 */

/** `head-sync`: the log and status disagree on HEAD, which no count read
 *  settles, or the row isn't in the loaded log; `refreshing`: the log and the unpushed count disagree. */
export type EditDatesHold =
  | "op"
  | "head-sync"
  | "refreshing"
  | "pushed"
  | "out-of-range";

export type EditDatesRoute =
  | { kind: "head" }
  | { kind: "history" }
  | { kind: "held"; hold: EditDatesHold };

export function editDatesRoute(input: {
  hash: string;
  /** Position in the loaded log, -1 when not loaded. */
  index: number;
  /** Status's HEAD. */
  headOid: string | null | undefined;
  opInProgress: boolean;
  /** Whether the log and the unpushed count agree (HistoryPanel's `agreed`). */
  viewAgreed: boolean;
  unpushedCount: number;
  /** The hashes Edit history would list. */
  editable: readonly string[];
}): EditDatesRoute {
  const { hash, index, headOid } = input;
  // The order the backend refuses in: an operation in progress outranks HEAD.
  if (input.opInProgress) return { kind: "held", hold: "op" };
  if (index === 0 && hash === headOid) return { kind: "head" };
  // The log and status disagree on HEAD, or the row left the log: what this
  // commit is stays unknown until they agree again.
  if (index <= 0 || hash === headOid)
    return { kind: "held", hold: "head-sync" };
  if (!input.viewAgreed) return { kind: "held", hold: "refreshing" };
  if (input.editable.includes(hash)) return { kind: "history" };
  if (index < input.unpushedCount)
    return { kind: "held", hold: "out-of-range" };
  return { kind: "held", hold: "pushed" };
}
