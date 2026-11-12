// The board return's pure step: what one Back or Forward onto the Projects tab does
// next, given what it already did and what the panel draws now. Import-free, so
// `scripts/board-return.test.mjs` loads it under Node's type stripping.

export type ReadState = "ready" | "loading" | "dead";

/** ready: data present and not a placeholder. dead: no usable data, and the read failed,
 *  is parked, or is enabled with no fetch in flight (a cancelled first load), which
 *  nothing will settle. loading: anything else, a fetch in flight or a disabled read. */
export function readState(q: {
  data: unknown;
  isError: boolean;
  isPaused: boolean;
  isFetching: boolean;
  isEnabled: boolean;
  isPlaceholderData?: boolean;
}): ReadState {
  if (q.data !== undefined && !q.isPlaceholderData) return "ready";
  if (q.isError || q.isPaused) return "dead";
  return q.isEnabled && !q.isFetching ? "dead" : "loading";
}

export type BoardReturnStep =
  | { kind: "wait" }
  /** Drop the request: no focus, no announcement. */
  | { kind: "end" }
  | { kind: "switch-project"; projectId: string }
  | { kind: "pick-view"; viewId: string | null }
  | { kind: "set-archived"; shown: boolean }
  | { kind: "claim"; itemId: string; gone: boolean; recheck: boolean }
  /** A rows layout's own cursor cell. `seedRowKey` is the row to write as the table
   *  cursor first, at column 0: the grids claim nothing on a nonce bump while their
   *  cursor resolves to no row. */
  | { kind: "refocus"; seedRowKey: string | null }
  /** No card to stand on: the body landing. */
  | { kind: "landing"; gone: boolean }
  /** Announce that the card is gone and end, moving no focus: the claim was refused
   *  focus, or a rows grid recovers its own focus. */
  | { kind: "gone-notice" };

export interface BoardReturnStepInput {
  anchor: {
    projectId: string;
    viewId: string | null;
    itemId: string | null;
    showArchived: boolean;
  };
  /** What this request already did: the hook's own latches. */
  applied: { project: boolean; view: boolean; archived: boolean };
  /** The card a `recheck` claim took, else null. */
  claimed: string | null;
  /** Read only with `claimed`: that claim took focus. */
  claimFocused: boolean;
  /** Read only with `claimed` and `claimFocused`: focus is still where that claim
   *  left it, on body, or anywhere inside the drawn grid on a rows layout. */
  focusHeld: boolean;
  gate: "open" | "pending" | "closed";
  catalog: ReadState;
  projectIds: readonly string[];
  /** The board drawn now. */
  projectId: string | null;
  views: ReadState;
  viewIds: readonly string[];
  activeViewId: string | null;
  fields: ReadState;
  items: ReadState;
  itemsFetching: boolean;
  archivedShown: boolean;
  seedPending: boolean;
  layoutDrawn: boolean;
  /** A table or a roadmap is the layout. */
  rows: boolean;
  /** And it draws at least one row. */
  rowsDrawn: boolean;
  /** The rows grid's cursor resolves to a drawn row. */
  rowCursor: boolean;
  /** The first DRAWN row's key, a section header included. */
  firstRowKey: string | null;
  /** The card `claimed ?? anchor.itemId` names is in the columns. */
  cardFound: boolean;
  /** The first DRAWN card or item row. */
  firstItemId: string | null;
}

const WAIT: BoardReturnStep = { kind: "wait" };
const END: BoardReturnStep = { kind: "end" };

/** A real card the settled board no longer draws. */
function goneArm(firstItemId: string | null): BoardReturnStep {
  return firstItemId !== null
    ? { kind: "claim", itemId: firstItemId, gone: true, recheck: false }
    : { kind: "landing", gone: true };
}

/** First match wins. Every arm that can wait on a read tests `dead` first, and every
 *  acting step either sets a latch that disables its own arm or ends the request, so a
 *  request terminates once its reads settle. */
export function boardReturnStep(i: BoardReturnStepInput): BoardReturnStep {
  if (i.gate === "closed") return END;
  if (i.gate === "pending") return WAIT;
  if (i.catalog === "dead") return END;
  if (i.catalog === "loading") return WAIT;

  // The one recheck after a claim made under a refetch.
  if (i.claimed !== null) {
    if (i.items === "dead") return END;
    if (i.itemsFetching) return WAIT;
    if (i.cardFound) return END;
    if (!i.claimFocused) return { kind: "gone-notice" };
    if (!i.focusHeld) return END;
    return i.rows ? { kind: "gone-notice" } : goneArm(i.firstItemId);
  }

  if (i.projectId === null) return { kind: "landing", gone: false };

  const home = i.anchor.projectId === i.projectId;
  if (!home && !i.applied.project && i.projectIds.includes(i.anchor.projectId))
    return { kind: "switch-project", projectId: i.anchor.projectId };

  if (home) {
    if (i.anchor.viewId !== i.activeViewId && !i.applied.view) {
      if (i.views === "dead") return END;
      if (i.views === "loading") return WAIT;
      // The pick reads the field definitions once, so it waits for them.
      if (i.anchor.viewId === null || i.viewIds.includes(i.anchor.viewId)) {
        if (i.fields === "dead") return END;
        if (i.fields === "loading") return WAIT;
        return { kind: "pick-view", viewId: i.anchor.viewId };
      }
    }
    if (!i.applied.archived && i.anchor.showArchived !== i.archivedShown)
      return { kind: "set-archived", shown: i.anchor.showArchived };
  }

  if (i.fields === "dead" || i.items === "dead") return END;
  if (i.seedPending || !i.layoutDrawn) return WAIT;

  const target = home ? i.anchor.itemId : null;
  if (target !== null) {
    if (i.cardFound)
      return {
        kind: "claim",
        itemId: target,
        gone: false,
        recheck: i.itemsFetching,
      };
    // An unfinished read has not yet said the card is gone.
    if (i.itemsFetching) return WAIT;
    return goneArm(i.firstItemId);
  }
  if (i.rows && i.rowsDrawn)
    return {
      kind: "refocus",
      seedRowKey: i.rowCursor ? null : i.firstRowKey,
    };
  if (!i.rows && i.firstItemId !== null)
    return {
      kind: "claim",
      itemId: i.firstItemId,
      gone: false,
      recheck: false,
    };
  return { kind: "landing", gone: false };
}
