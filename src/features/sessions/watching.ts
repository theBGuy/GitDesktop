import { useUiStore } from "@/lib/stores/ui";

/**
 * True when the user is actually looking at agent surface `id` right now: the
 * window is focused, the run's repo (`runRepoPath`) is the open one, the **Agent
 * tab** is the visible tab, and `id` is the selected plan/session.
 *
 * Both agent stores use this to decide whether a finished run still needs an OS
 * notification — staying quiet only when the result is already on screen.
 * `document.hasFocus()` alone is window-level: it can't tell the Agent tab from
 * Changes/Pulls, so a focused user on a different tab was wrongly treated as
 * "watching" and got no nudge. The repo is the same axis: the surface only lists
 * the OPEN repo's runs, so one finishing for another repo is off screen whatever
 * the tab shows. Plan and session selection are mutually exclusive (see
 * `agentSelect.ts`), so `activeId === id` plus `repoTab === "agent"` is a precise
 * "this exact surface is on screen".
 *
 * `runRepoPath` is the run's REPO, never its worktree (sessions run in per-task
 * worktrees, which never equal the open repo path), compared verbatim like every
 * other repo filter on this surface.
 */
export function isWatchingAgentSurface(
  activeId: string | null,
  id: string,
  runRepoPath: string,
): boolean {
  const ui = useUiStore.getState();
  return (
    document.hasFocus() &&
    ui.repoPath === runRepoPath &&
    ui.repoTab === "agent" &&
    activeId === id
  );
}
