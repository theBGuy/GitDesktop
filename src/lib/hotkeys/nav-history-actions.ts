import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { validateRepo } from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import {
  applyRepoLens,
  cachedLensInputsComplete,
  cachedRepoLens,
} from "@/lib/repo-lens/queries";
import {
  canGoBack,
  canGoForward,
  type NavRestoreOptions,
  type NavSegmentTarget,
  registerNavLensReader,
} from "@/lib/stores/nav-history";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { useHotkeyAction } from "./hotkeys";
import { focusInOpenModal } from "./open-modal";

/** The toast for a press whose target repository can no longer be opened. */
const DEAD_TARGET_COPY: Record<-1 | 1, (name: string) => string> = {
  "-1": (name) =>
    `Can't go back to ${name}. Its folder is missing or is no longer a Git repository.`,
  1: (name) =>
    `Can't go forward to ${name}. Its folder is missing or is no longer a Git repository.`,
};

/** Whether `target`'s folder still opens as that repository. `validate_repo` walks
 *  upward, so an answer naming an enclosing repository counts as gone. Every
 *  rejection reads as gone too, a transient IPC failure included. Never rejects. */
async function targetStillOpens({ repoPath }: NavSegmentTarget) {
  try {
    const info = await validateRepo(repoPath);
    return normPath(info.root) === normPath(repoPath);
  } catch {
    return false;
  }
}

function restoreOptions(queryClient: QueryClient): NavRestoreOptions {
  return {
    validate: targetStillOpens,
    applyLens: (repoPath, lens) =>
      applyRepoLens(queryClient, repoPath, lens, {
        clearSelections: true,
        persist: false,
      }),
    onDead: (target, delta) => {
      toast.error(
        DEAD_TARGET_COPY[delta](
          target.repoName ?? repoNameFromPath(target.repoPath),
        ),
      );
    },
  };
}

/** Registers Go back and Go forward for the whole app. Mounted once, by App.
 *  An empty direction keeps its registration, disabled, so the chord is still
 *  consumed rather than reaching the webview's native back. A modal holding focus
 *  stands both down at fire time; App's own dialogs and the gated ones come in as
 *  `dialogOpen`. Also registers the history's lens reader, here because App mounts
 *  this in every view, so a landing made under an overlay still has one. */
export function useNavHistoryActions(dialogOpen: boolean): void {
  const queryClient = useQueryClient();
  // The cached lens only once its inputs answered: before that the provisional lens
  // would read as a real one and start or skip a segment wrongly.
  useEffect(
    () =>
      registerNavLensReader((repoPath) =>
        cachedLensInputsComplete(queryClient, repoPath)
          ? cachedRepoLens(queryClient, repoPath)
          : null,
      ),
    [queryClient],
  );
  const canBack = useUiStore(canGoBack);
  const canForward = useUiStore(canGoForward);
  useHotkeyAction(
    "go-back",
    () => {
      if (focusInOpenModal()) return;
      useUiStore.getState().goBack(restoreOptions(queryClient));
    },
    canBack && !dialogOpen,
  );
  useHotkeyAction(
    "go-forward",
    () => {
      if (focusInOpenModal()) return;
      useUiStore.getState().goForward(restoreOptions(queryClient));
    },
    canForward && !dialogOpen,
  );
}
