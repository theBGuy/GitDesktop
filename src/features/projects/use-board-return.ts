import { useEffect, useEffectEvent, useState } from "react";
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
 *  or landing and every claim except one made under a refetch, held for one recheck. */
export function useBoardReturn(input: BoardReturnInput): {
  heldAnchor: BoardAnchor | null;
} {
  const [held, setHeld] = useState<HeldReturn | null>(null);
  const boardReturn = useUiStore((s) => s.boardReturn);

  // Its own effect so an <Activity> hide or an unmount drops a held request. Never
  // the consume effect's cleanup: its own clear changes `boardReturn`, and that
  // cleanup would drop the request it just took.
  useEffect(() => () => setHeld(null), []);

  const consume = useEffectEvent((request: BoardReturnRequest) => {
    const store = useUiStore.getState();
    store.clearBoardReturn();
    if (
      store.interactionEpoch !== request.epoch ||
      store.repoPath !== input.repoPath
    )
      return;
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
  const { active } = input;
  useEffect(() => {
    if (active && boardReturn !== null) consume(boardReturn);
  }, [active, boardReturn]);

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
      setHeld(null);
      return;
    }
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

  return { heldAnchor: held?.anchor ?? null };
}
