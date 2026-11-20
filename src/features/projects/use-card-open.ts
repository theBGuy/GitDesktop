/**
 * Opens a Projects board card's issue or pull request where `cardDestination`
 * says: in place, across the fork, in a local clone of another repository, or
 * on the web. The board keeps its own generation, claim and wait; the shared
 * resolver only proves which clone to land in.
 */
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { claimRepoOpen } from "@/features/repository/useOpenRepoByPath";
import type { BoardItem, RemoteLens } from "@/lib/git/types";
import { sameOpenCheckout } from "@/lib/git/worktree-default-path";
import {
  type LocalLandingTarget,
  openingStatus,
  PENDING_AFFORDANCE_MS,
} from "@/lib/local-landing/match";
import { resolveLocalLanding } from "@/lib/local-landing/resolve";
import { applyRepoLens } from "@/lib/repo-lens/queries";
import type { RecentRepo } from "@/lib/settings/api";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import {
  type CardOpenContext,
  cardDestination,
  cardWebUrl,
  type OpenableContent,
  openedInSideStatus,
  openedInStatus,
} from "./card-destination";

/** The board's open generation. Module scope so it outlives the panel
 *  instance: a continuation from an earlier mount stays superseded. */
let boardOpenGen = 0;

/** Moves the board's open generation on, retiring every pending open.
 *  Outside the hook: the React Compiler can't lower a write to module state. */
function bumpBoardOpenGen(): number {
  boardOpenGen += 1;
  return boardOpenGen;
}

/** A card `openItem` let through: an issue or a pull request. */
type OpenableItem = BoardItem & { content: OpenableContent };

/** Whether the board for `path` is on screen now, read from the live store. */
function boardShowing(path: string): boolean {
  const s = useUiStore.getState();
  return s.view === "repo" && s.repoPath === path && s.repoTab === "projects";
}

export interface CardOpenInput {
  repoPath: string;
  ctx: CardOpenContext;
  /** Run inside the landing where one exists, after its lens write: the panel's
   *  opener ref. Nothing that writes the ui store may run between it and the
   *  landing set (the arrival announcer writes none). */
  noteOpener: (itemId: string) => void;
  /** The board's own polite announcer. */
  announce: (text: string) => void;
  /** An announcer that outlives the repository switch. Optional: a caller without one
   *  speaks no arrival. */
  announceArrival?: (text: string) => void;
}

export function useCardOpen(input: CardOpenInput): {
  openItem: (item: BoardItem) => void;
  /** The second menu row: the browser, whatever the primary row says. */
  openOnWeb: (item: BoardItem) => void;
  /** The item whose open has been resolving past PENDING_AFFORDANCE_MS, while the epoch its
   *  claim was taken under still stands; else null. */
  openingItemId: string | null;
} {
  const { repoPath, ctx, noteOpener, announce, announceArrival } = input;
  const queryClient = useQueryClient();
  const repoName = useUiStore((s) => s.repoName) ?? repoNameFromPath(repoPath);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const openPr = useUiStore((s) => s.openPr);
  const openIssue = useUiStore((s) => s.openIssue);
  const [wait, setWait] = useState<{ itemId: string; epoch: number } | null>(
    null,
  );
  // The claim fails on any epoch move, so the shown wait does too, at once and
  // without an effect; a boolean, so only that flip re-renders the board.
  const waitRetired = useUiStore(
    (s) => wait !== null && s.interactionEpoch !== wait.epoch,
  );
  // Disarms the pending timer, held where an unmount can reach it.
  const disarmRef = useRef<(() => void) | null>(null);
  // The open that owns the shown wait: only it may clear it.
  const waitGenRef = useRef(0);

  // A hidden or unmounted board has no pending open. `<Activity>` runs this on
  // a hide too, and the generation retires every continuation either way.
  useEffect(() => {
    return () => {
      bumpBoardOpenGen();
      disarmRef.current?.();
    };
  }, []);

  function showWait(itemId: string, status: string, epoch: number) {
    setWait({ itemId, epoch });
    announce(status);
  }

  async function openInClone(
    item: OpenableItem,
    target: LocalLandingTarget,
    candidates: RecentRepo[],
    gen: number,
    /** The active lens at the click was Upstream (`ctx.otherSide?.lens === "origin"`). */
    activeIsUpstream: boolean,
  ) {
    const claimed = claimRepoOpen();
    const superseded = () =>
      gen !== boardOpenGen || !claimed() || !boardShowing(repoPath);
    // The epoch the claim was taken under: the shown wait lives only as long.
    const epochAtClaim = useUiStore.getState().interactionEpoch;
    const status = openingStatus(target);
    // Armed before the await: the resolve's first folder check can spend the
    // whole budget, and an open the card doesn't acknowledge reads as dropped.
    const timer = setTimeout(() => {
      if (!superseded()) showWait(item.itemId, status, epochAtClaim);
    }, PENDING_AFFORDANCE_MS);
    const disarm = () => clearTimeout(timer);
    disarmRef.current = disarm;
    // Owned from ARM time, so a superseded open's settle never clears the wait
    // of the open that replaced it.
    waitGenRef.current = gen;
    // `.finally` rather than a try statement, which the React Compiler can't
    // lower: a bail-out would give `openItem` a new identity every render.
    const landing = await resolveLocalLanding(target, candidates, {
      preferWorktree: true,
      superseded,
    }).finally(() => {
      disarm();
      if (disarmRef.current === disarm) disarmRef.current = null;
      if (waitGenRef.current === gen) {
        waitGenRef.current = 0;
        setWait(null);
      }
    });
    if (superseded()) return;
    if (landing.kind === "superseded") return;
    if (landing.kind === "browser") {
      // No toast: the browser opening is its own explanation.
      void openUrl(cardWebUrl(item.content, ctx.forgeHost)).catch(toastError);
      return;
    }
    // Recents can spell the open checkout differently, and the history tells a
    // same-repository hop by strict string equality, so the store's own path.
    const here = sameOpenCheckout(landing.path, repoPath);
    const targetPath = here ? repoPath : landing.path;
    const targetName = here ? repoName : landing.name;
    const switchesToFork = here && activeIsUpstream;
    // The opener goes after the lens write, which can write the store: the anchor
    // read inside the landing set spends the opener, so nothing that writes the
    // ui store may run between the two (the arrival announcer writes none).
    const beforeSelect = () => {
      applyRepoLens(queryClient, targetPath, "origin", {
        clearSelections: true,
        persist: false,
      });
      noteOpener(item.itemId);
      if (!here) announceArrival?.(openedInStatus(target.repoName));
      else if (switchesToFork) announceArrival?.(openedInSideStatus("origin"));
    };
    // Never `claimed()`: the navigator claims again, which would retire this.
    const stillValid = (epochAtRequest: number) =>
      gen === boardOpenGen &&
      useUiStore.getState().interactionEpoch === epochAtRequest;
    if (target.isPullRequest) {
      openPr({
        kind: "remote",
        repoPath: targetPath,
        repoName: targetName,
        ref: String(target.number),
        section: null,
        carryHistory: true,
        beforeSelect,
        stillValid,
      });
    } else {
      openIssue({
        repoPath: targetPath,
        repoName: targetName,
        number: target.number,
        carryHistory: true,
        beforeSelect,
        stillValid,
      });
    }
  }

  // Same repository, other fork side: no resolver, no claim, no wait. The
  // landing can apply in a later task, so a lapsed request must not flip the
  // lens under whatever the user moved to.
  function hopSides(
    item: BoardItem,
    content: OpenableContent,
    lens: RemoteLens,
    gen: number,
  ) {
    const stillValid = (epochAtRequest: number) =>
      gen === boardOpenGen &&
      useUiStore.getState().interactionEpoch === epochAtRequest;
    const beforeSelect = () => {
      applyRepoLens(queryClient, repoPath, lens, {
        clearSelections: true,
        persist: false,
      });
      noteOpener(item.itemId);
      announceArrival?.(openedInSideStatus(lens));
    };
    if (content.kind === "issue") {
      openIssue({
        repoPath,
        repoName,
        number: content.number,
        carryHistory: true,
        beforeSelect,
        stillValid,
      });
    } else {
      openPr({
        kind: "remote",
        repoPath,
        repoName,
        ref: String(content.number),
        section: null,
        carryHistory: true,
        beforeSelect,
        stillValid,
      });
    }
  }

  function openItem(item: BoardItem) {
    const content = item.content;
    // Drafts and redacted items are not opens: a pending one stays pending.
    if (content.kind !== "issue" && content.kind !== "pullRequest") return;
    // Every open supersedes a pending one, the browser arms included.
    const gen = bumpBoardOpenGen();
    setWait(null);
    const dest = cardDestination(content, ctx);
    switch (dest.kind) {
      case "here": {
        const id = String(content.number);
        if (content.kind === "issue") {
          noteOpener(item.itemId);
          selectIssue({ kind: "remote", id });
          setRepoTab("issues");
          return;
        }
        // The landing can apply in a later task, so a lapsed request must not
        // land over whatever the user moved to. It writes no lens and changes
        // no repository, so it carries no history and takes no claim.
        const stillValid = (epochAtRequest: number) =>
          gen === boardOpenGen &&
          useUiStore.getState().interactionEpoch === epochAtRequest;
        openPr({
          kind: "remote",
          repoPath,
          repoName,
          ref: id,
          section: null,
          beforeSelect: () => noteOpener(item.itemId),
          stillValid,
        });
        return;
      }
      case "lens":
        hopSides(item, content, dest.lens, gen);
        return;
      case "clone":
        void openInClone(
          { ...item, content },
          dest.target,
          dest.candidates,
          gen,
          ctx.otherSide?.lens === "origin",
        );
        return;
      case "browser":
        void openUrl(cardWebUrl(content, ctx.forgeHost)).catch(toastError);
        return;
    }
  }

  function openOnWeb(item: BoardItem) {
    const content = item.content;
    if (content.kind !== "issue" && content.kind !== "pullRequest") return;
    // Supersedes a pending open, never claims: it opens no repository.
    bumpBoardOpenGen();
    setWait(null);
    void openUrl(cardWebUrl(content, ctx.forgeHost)).catch(toastError);
  }

  return {
    openItem,
    openOnWeb,
    openingItemId: wait !== null && !waitRetired ? wait.itemId : null,
  };
}
