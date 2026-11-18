import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { BoardAnchor, BoardReturnRequest } from "@/lib/stores/nav-history";
import { useUiStore } from "@/lib/stores/ui";
import { type BoardReturnStepInput, boardReturnStep } from "./board-return";

type PanelReads = Omit<
  BoardReturnStepInput,
  "anchor" | "applied" | "claimed" | "claimFocused" | "focusHeld" | "cardFound"
>;

/** The Projects panel as the return sees it: its reads now, and the moves it makes. */
export interface BoardReturnInput extends PanelReads {
  active: boolean;
  repoPath: string;
  /** The board cursor's card id as last written, not re-found in the drawn columns. */
  boardCursorId: string | null;
  /** The table cursor's row key as last written. */
  tableCursorKey: string | null;
  /** The table cursor's column as last written: a move between cells of one row
   *  changes it alone. */
  tableCursorCol: number | null;
  /** Announced when the anchor's card is gone, in the drawn layout's words. */
  goneMessage: string;
  root: () => HTMLElement | null;
  /** The drawn rows layout's grid element; null on the board layout. */
  grid: () => HTMLElement | null;
  hasCard: (itemId: string) => boolean;
  /** Moved synchronously by every board or view pick, the hook's own included. */
  pickGeneration: () => number;
  switchProject: (projectId: string) => void;
  pickView: (viewId: string | null) => void;
  setArchived: (shown: boolean) => void;
  /** Re-finds the card by id and writes both cursors; bumps the focus nonce only
   *  with `focus`. */
  claimCard: (itemId: string, options: { focus: boolean }) => void;
  /** Writes the table cursor at `rowKey`, column 0, with no nonce bump. */
  seedRowCursor: (rowKey: string) => void;
  /** The nonce bump alone: the rows grid claims its cursor cell. */
  refocus: () => void;
  focusLanding: () => void;
  announce: (text: string) => void;
}

interface HeldReturn {
  anchor: BoardAnchor;
  epoch: number;
  repoPath: string;
  focusAtConsume: Element | null;
  pickBaseline: number;
  /** Show archived as last seen: at consume, then after the hook's own write. */
  archivedSeen: boolean;
  applied: { project: boolean; view: boolean; archived: boolean };
  claimed: string | null;
  claimFocused: boolean;
  /** The card the hook's last focus-taking claim named. */
  lastClaim: string | null;
}

/** The user's position on the board: both raw cursors (the table's by row key and
 *  column), Show archived and the raw view id. A read arriving does not by itself
 *  move them, but the user is not their only writer: a change made by an effect or
 *  by the hook's own step ends a retired record (or keeps a drop from making one)
 *  just as a user's move does, and the provider then answers the live board. */
interface Marks {
  boardCursorId: string | null;
  tableCursorKey: string | null;
  tableCursorCol: number | null;
  archivedShown: boolean;
  activeViewId: string | null;
}

const marksOf = (input: BoardReturnInput): Marks => ({
  boardCursorId: input.boardCursorId,
  tableCursorKey: input.tableCursorKey,
  tableCursorCol: input.tableCursorCol,
  archivedShown: input.archivedShown,
  activeViewId: input.activeViewId,
});

const sameMarks = (a: Marks, b: Marks) =>
  a.boardCursorId === b.boardCursorId &&
  a.tableCursorKey === b.tableCursorKey &&
  a.tableCursorCol === b.tableCursorCol &&
  a.archivedShown === b.archivedShown &&
  a.activeViewId === b.activeViewId;

/** A return dropped for an interaction epoch move alone, kept only so the departure
 *  that moved the epoch can still record the return's anchor. */
export interface RetiredAnchor {
  anchor: BoardAnchor;
  /** The store's interactionEpoch read at the retirement. */
  epoch: number;
  /** The pick generation the record is pinned to: the dropped return's baseline,
   *  or the panel's at a consume refused for the epoch. */
  pickBaseline: number;
}

interface RetiredRecord extends RetiredAnchor {
  repoPath: string;
  marks: Marks;
}

/** What the Projects anchor provider knows at a read. */
export interface BoardAnchorQuery {
  /** The card an in-app open is leaving from, spent by the read. */
  opener: string | null;
  /** The store's unconsumed return request's anchor. */
  armed: BoardAnchor | null;
  held: BoardAnchor | null;
  retired: RetiredAnchor | null;
  /** The store's interactionEpoch at the read. */
  epoch: number;
  /** The panel's pick generation at the read. */
  pickGeneration: number;
  catalogUnread: boolean;
  projectId: string | null;
  viewId: string | null;
  cursorItemId: string | null;
  showArchived: boolean;
}

/** The anchor the history entry records for the Projects tab, first match: an in-app
 *  open's card; a return armed but not yet consumed; one in flight; one retired since
 *  the last epoch move, while no pick followed it; `undefined` while the catalog is
 *  unread, so the entry keeps its anchor; null with no board; else the live board.
 *  The retired arm tests the live epoch and pick generation here because both can
 *  move with no panel commit between, and never the live repository: a carried hop's
 *  departing read runs after its landing set. */
export function boardAnchorAnswer(
  q: BoardAnchorQuery,
): BoardAnchor | null | undefined {
  if (q.opener !== null)
    return q.projectId === null
      ? null
      : {
          projectId: q.projectId,
          viewId: q.viewId,
          itemId: q.opener,
          showArchived: q.showArchived,
        };
  if (q.armed !== null) return q.armed;
  if (q.held !== null) return q.held;
  if (
    q.retired !== null &&
    q.retired.epoch === q.epoch &&
    q.retired.pickBaseline === q.pickGeneration
  )
    return q.retired.anchor;
  if (q.catalogUnread) return undefined;
  if (q.projectId === null) return null;
  return {
    projectId: q.projectId,
    viewId: q.viewId,
    itemId: q.cursorItemId,
    showArchived: q.showArchived,
  };
}

const SPOT = "[data-card-index], [data-table-cell]";

/** Whether a claim, refocus or landing may move focus now. "take": focus is on body,
 *  the element focused at consume, the panel root, the body landing, or the card or
 *  row the hook last claimed. "user": any card or cell but the hook's last claim, so
 *  the user moved there while the return waited. "refuse": anywhere else, a toolbar
 *  control included. */
function focusVerdict(
  held: HeldReturn,
  root: HTMLElement | null,
): "take" | "refuse" | "user" {
  const active = document.activeElement;
  if (active === null || active === document.body) return "take";
  if (active === held.focusAtConsume || active === root) return "take";
  if (root === null || !root.contains(active)) return "refuse";
  const spot = active.closest(SPOT);
  if (spot !== null && root.contains(spot)) {
    const itemId = spot.closest("[data-item-id]")?.getAttribute("data-item-id");
    return held.lastClaim !== null && itemId === held.lastClaim
      ? "take"
      : "user";
  }
  return active.closest("[data-body-landing]") !== null ? "take" : "refuse";
}

/** Returns the Projects panel to a `boardReturn` anchor: consumed once while
 *  active, pinned to its epoch, repo and pick generation, and ended by every refocus
 *  or landing and every claim except one made under a refetch, held for one recheck.
 *  A return dropped for the epoch alone only answers the provider (`retiredAnchor`)
 *  and never acts again. */
export function useBoardReturn(input: BoardReturnInput): {
  heldAnchor: BoardAnchor | null;
  retiredAnchor: RetiredAnchor | null;
} {
  const [held, setHeld] = useState<HeldReturn | null>(null);
  const [retired, setRetired] = useState<RetiredRecord | null>(null);
  // The marks of the last effect pass that found the return live: the commit that
  // drops it for the epoch can itself carry the user's move.
  const liveMarks = useRef<Marks | null>(null);
  const boardReturn = useUiStore((s) => s.boardReturn);

  // Its own effect so an <Activity> hide or an unmount drops a held request and a
  // retired anchor. Never the consume effect's cleanup: its own clear changes
  // `boardReturn`, and that cleanup would drop the request it just took.
  useEffect(
    () => () => {
      setHeld(null);
      setRetired(null);
    },
    [],
  );

  const consume = useEffectEvent((request: BoardReturnRequest) => {
    const store = useUiStore.getState();
    store.clearBoardReturn();
    setRetired(null);
    if (store.repoPath !== input.repoPath) return;
    if (store.interactionEpoch !== request.epoch) {
      // Refused for the epoch alone: the press that moved it may still be leaving.
      setRetired({
        anchor: request.anchor,
        epoch: store.interactionEpoch,
        pickBaseline: input.pickGeneration(),
        repoPath: input.repoPath,
        marks: marksOf(input),
      });
      return;
    }
    liveMarks.current = marksOf(input);
    setHeld({
      anchor: request.anchor,
      epoch: request.epoch,
      repoPath: input.repoPath,
      focusAtConsume: document.activeElement,
      pickBaseline: input.pickGeneration(),
      archivedSeen: input.archivedShown,
      applied: { project: false, view: false, archived: false },
      claimed: null,
      claimFocused: false,
      lastClaim: null,
    });
  });

  // A retired anchor ends for good once the panel hides, a pick follows, the
  // repository or the epoch moves, or the user moves a mark.
  useEffect(() => {
    if (retired === null) return;
    const store = useUiStore.getState();
    if (
      !input.active ||
      input.pickGeneration() !== retired.pickBaseline ||
      store.repoPath !== retired.repoPath ||
      store.interactionEpoch !== retired.epoch ||
      !sameMarks(retired.marks, marksOf(input))
    )
      setRetired(null);
  });

  // At most one action per commit; each acting step writes `held`, which commits
  // again, and `wait` writes nothing.
  useEffect(() => {
    if (held === null) return;
    const store = useUiStore.getState();
    if (
      !input.active ||
      input.pickGeneration() !== held.pickBaseline ||
      store.repoPath !== held.repoPath ||
      store.interactionEpoch !== held.epoch
    ) {
      // Retired, not lost, when the epoch alone moved and no user move came with it.
      const marks = marksOf(input);
      if (
        input.active &&
        input.pickGeneration() === held.pickBaseline &&
        store.repoPath === held.repoPath &&
        liveMarks.current !== null &&
        sameMarks(liveMarks.current, marks)
      )
        setRetired({
          anchor: held.anchor,
          epoch: store.interactionEpoch,
          pickBaseline: held.pickBaseline,
          repoPath: held.repoPath,
          marks,
        });
      setHeld(null);
      return;
    }
    liveMarks.current = marksOf(input);
    // A Show archived toggle the user made while the return waited stands.
    const h =
      !held.applied.archived && input.archivedShown !== held.archivedSeen
        ? { ...held, applied: { ...held.applied, archived: true } }
        : held;
    const target = h.claimed ?? h.anchor.itemId;
    const focus = document.activeElement;
    const step = boardReturnStep({
      ...input,
      anchor: h.anchor,
      applied: h.applied,
      claimed: h.claimed,
      claimFocused: h.claimFocused,
      focusHeld:
        focus === null ||
        focus === document.body ||
        (input.rows && (input.grid()?.contains(focus) ?? false)),
      cardFound: target !== null && input.hasCard(target),
    });
    switch (step.kind) {
      case "wait":
        if (h !== held) setHeld(h);
        return;
      case "end":
        setHeld(null);
        return;
      case "switch-project":
        input.switchProject(step.projectId);
        setHeld({
          ...h,
          applied: { ...h.applied, project: true },
          pickBaseline: input.pickGeneration(),
        });
        return;
      case "pick-view":
        input.pickView(step.viewId);
        setHeld({
          ...h,
          applied: { ...h.applied, view: true },
          pickBaseline: input.pickGeneration(),
        });
        return;
      case "set-archived":
        input.setArchived(step.shown);
        setHeld({
          ...h,
          applied: { ...h.applied, archived: true },
          archivedSeen: step.shown,
        });
        return;
      case "gone-notice":
        input.announce(input.goneMessage);
        setHeld(null);
        return;
      case "claim": {
        const verdict = focusVerdict(h, input.root());
        input.claimCard(step.itemId, { focus: verdict === "take" });
        // Focus on the user's own card or cell stays there; the cursor still moves
        // to the returned card, and nothing else happens.
        if (verdict === "user") {
          setHeld(null);
          return;
        }
        if (step.gone) input.announce(input.goneMessage);
        if (!step.recheck) {
          setHeld(null);
          return;
        }
        const took = verdict === "take";
        setHeld({
          ...h,
          claimed: step.itemId,
          claimFocused: took,
          lastClaim: took ? step.itemId : h.lastClaim,
        });
        return;
      }
      case "refocus":
        if (focusVerdict(h, input.root()) === "take") {
          if (step.seedRowKey !== null) input.seedRowCursor(step.seedRowKey);
          input.refocus();
        }
        setHeld(null);
        return;
      case "landing": {
        const verdict = focusVerdict(h, input.root());
        if (verdict === "take") input.focusLanding();
        if (step.gone && verdict !== "user") input.announce(input.goneMessage);
        setHeld(null);
        return;
      }
    }
  });

  // Declared after the step effect: in a commit that consumes a new request while
  // an older return is held, the old one is dropped or retired first, from its own
  // last live marks, and the consume's writes land last and stand.
  const { active } = input;
  useEffect(() => {
    if (active && boardReturn !== null) consume(boardReturn);
  }, [active, boardReturn]);

  // Derived at render, so the commit that shows a user's move already stops it.
  const retiredAnchor =
    retired !== null &&
    input.active &&
    input.repoPath === retired.repoPath &&
    sameMarks(retired.marks, marksOf(input))
      ? {
          anchor: retired.anchor,
          epoch: retired.epoch,
          pickBaseline: retired.pickBaseline,
        }
      : null;
  return { heldAnchor: held?.anchor ?? null, retiredAnchor };
}
