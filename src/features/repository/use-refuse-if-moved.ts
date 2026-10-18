import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useUiStore } from "@/lib/stores/ui";
import { useLatestRef } from "@/lib/use-latest-ref";

/**
 * For a conflict view's handler that awaits before it writes: returns a check
 * that says (and toasts) whether the repository closed, the view went away, or
 * the view moved to another repo since `startedIn`, since a mutate called then
 * builds from options this view no longer describes. Compares the view's OWN
 * `repoPath` prop, not the live repo (the shared `refuseIfSwitched`), because a
 * PR's resolve worktree hosts these views as well as the open repo.
 */
export function useRefuseIfMoved(repoPath: string) {
  const repoPathRef = useLatestRef(repoPath);
  // Cleared on unmount (and an <Activity> hide), when the ref above keeps its
  // last value: an answer that lands after that belongs to a view that is gone.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return (
    startedIn: string,
    outcome: string,
    during = "while the dialog was open",
  ) => {
    if (useUiStore.getState().repoPath === null) {
      toast.info(`You closed the repository ${during} — ${outcome}.`);
      return true;
    }
    if (!mountedRef.current) {
      toast.info(`You left this file ${during} — ${outcome}.`);
      return true;
    }
    if (repoPathRef.current === startedIn) return false;
    toast.info(`You switched repositories ${during} — ${outcome}.`);
    return true;
  };
}
