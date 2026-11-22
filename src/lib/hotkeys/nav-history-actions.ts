import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { validateRepo } from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import {
  applyRepoLens,
  cachedLensGone,
  cachedLensVerdict,
} from "@/lib/repo-lens/queries";
import {
  canGoBack,
  canGoForward,
  type NavRestoreOptions,
  type NavSegmentTarget,
  type NavTargetCheck,
  registerNavLensReader,
} from "@/lib/stores/nav-history";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { isAppError } from "@/lib/tauri/invoke";
import { useHotkeyAction } from "./hotkeys";

/** The toast for a press whose check answered "gone". */
const DEAD_TARGET_COPY: Record<-1 | 1, (name: string) => string> = {
  "-1": (name) =>
    `Can't go back to ${name}. Its folder is missing or is no longer a Git repository.`,
  1: (name) =>
    `Can't go forward to ${name}. Its folder is missing or is no longer a Git repository.`,
};

/** The toast for a press whose check answered "refused". Fixed copy: git's own
 *  message is not printed. */
const REFUSED_TARGET_COPY: Record<-1 | 1, (name: string) => string> = {
  "-1": (name) => `Can't go back to ${name}. Git can't open its folder.`,
  1: (name) => `Can't go forward to ${name}. Git can't open its folder.`,
};

const DROPPED_TARGET_COPY: Record<
  "gone" | "refused",
  Record<-1 | 1, (name: string) => string>
> = { gone: DEAD_TARGET_COPY, refused: REFUSED_TARGET_COPY };

/** The toast for a press whose check answered "unknown", in either direction. */
const UNCHECKED_TARGET_COPY = (name: string) =>
  `Couldn't check ${name}. Try again.`;

/** How long a cross-repository Back or Forward waits on its folder check before it
 *  answers "unknown", so the hold ends whatever the backend does. */
const TARGET_CHECK_LIMIT_MS = 10_000;

/** The classified check in flight per folder: `validate_repo` stats the path on a
 *  runtime thread with no bound, so presses on a stalled folder share one backend
 *  check instead of pinning a thread each. An entry lives only until it settles. */
const checksInFlight = new Map<string, Promise<NavTargetCheck>>();

const targetName = (target: NavSegmentTarget) =>
  target.repoName ?? repoNameFromPath(target.repoPath);

/** `repoPath`'s answer from `validate_repo`, which walks upward. "open" for its own
 *  root. "gone" when the backend answered not a directory or not a repository
 *  (`notARepo`), or another root. "refused" when git answered and the folder cannot
 *  be opened: kind `git` with git's fatal exit 128, or kind `command`, which this
 *  check returns only for a working tree git names that is not a directory.
 *  "unknown" for every other rejection, a killed or crashed git included.
 *  Never rejects. */
async function classifyTarget(repoPath: string): Promise<NavTargetCheck> {
  try {
    const info = await validateRepo(repoPath);
    return normPath(info.root) === normPath(repoPath) ? "open" : "gone";
  } catch (e) {
    if (!isAppError(e)) return "unknown";
    if (e.kind === "notARepo") return "gone";
    if (e.kind === "command" || (e.kind === "git" && e.code === 128))
      return "refused";
    return "unknown";
  }
}

/** Keyed by the path verbatim: every press toward one stop passes its segment's
 *  spelling, and folders differing only by case are two repositories on a
 *  case-sensitive disk. */
function sharedCheck(repoPath: string): Promise<NavTargetCheck> {
  const inFlight = checksInFlight.get(repoPath);
  if (inFlight) return inFlight;
  const check = classifyTarget(repoPath);
  checksInFlight.set(repoPath, check);
  void check.finally(() => {
    if (checksInFlight.get(repoPath) === check) checksInFlight.delete(repoPath);
  });
  return check;
}

/** `target`'s folder check, answered "unknown" once {@link TARGET_CHECK_LIMIT_MS}
 *  passes; a later answer reaches nothing. One timer per call. Never rejects. */
async function checkTarget({
  repoPath,
}: NavSegmentTarget): Promise<NavTargetCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<NavTargetCheck>((resolve) => {
    timer = setTimeout(() => resolve("unknown"), TARGET_CHECK_LIMIT_MS);
  });
  try {
    return await Promise.race([sharedCheck(repoPath), limit]);
  } finally {
    clearTimeout(timer);
  }
}

function restoreOptions(queryClient: QueryClient): NavRestoreOptions {
  return {
    validate: checkTarget,
    applyLens: (repoPath, lens) =>
      applyRepoLens(queryClient, repoPath, lens, {
        clearSelections: true,
        persist: false,
      }),
    onDead: (target, delta, reason) => {
      toast.error(DROPPED_TARGET_COPY[reason][delta](targetName(target)));
    },
    onUnchecked: (target) => {
      toast.error(UNCHECKED_TARGET_COPY(targetName(target)));
    },
    lensGone: (repoPath, lens) => cachedLensGone(queryClient, repoPath, lens),
  };
}

/** Registers Go back and Go forward for the whole app. Mounted once, by App.
 *  An empty direction keeps its registration, disabled, so the chord is still
 *  consumed rather than reaching the webview's native back. Under an open modal
 *  both are inert through dispatchShortcut, focus on <body> included. Also
 *  registers the history's lens reader (a lens only once no missing input could
 *  change it), here because App mounts this in every view, so a landing made
 *  under an overlay still has one. */
export function useNavHistoryActions(): void {
  const queryClient = useQueryClient();
  // Only a lens no missing input could change: a provisional one would read as real
  // and start or skip a segment wrongly. A cached Fork choice is such a lens, since no
  // gate turns it into Upstream.
  useEffect(
    () =>
      registerNavLensReader((repoPath) =>
        cachedLensVerdict(queryClient, repoPath),
      ),
    [queryClient],
  );
  const canBack = useUiStore(canGoBack);
  const canForward = useUiStore(canGoForward);
  useHotkeyAction(
    "go-back",
    () => useUiStore.getState().goBack(restoreOptions(queryClient)),
    canBack,
  );
  useHotkeyAction(
    "go-forward",
    () => useUiStore.getState().goForward(restoreOptions(queryClient)),
    canForward,
  );
}
