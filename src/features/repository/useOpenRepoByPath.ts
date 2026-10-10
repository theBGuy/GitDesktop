import { useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { toast } from "sonner";
import { usePlanStore } from "@/features/plan/store";
import { useResearchStore } from "@/features/research/store";
import { track } from "@/lib/analytics";
import { validateRepo } from "@/lib/git/api";
import type { RepoInfo } from "@/lib/git/types";
import { migrateRepoData } from "@/lib/repo-data-migration";
import { scriptsKeys } from "@/lib/scripts/queries";
import {
  useAddRecentRepo,
  useRelocateRecentRepo,
  useRemoveRecentRepo,
  useSettings,
} from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { repoNameFromPath } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { isAppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import { warmRepoShell } from "./repo-shell-prefetch";

/** Request order across every repo open, recorded or worktree. Recents writes
 *  serialize, so an earlier open would otherwise land first and retire the newer
 *  one through the epoch check; numbering requests keeps the latest the winner. */
let latestOpenRequest = 0;

/** Claims an open at its REQUEST: the returned check passes only while no newer
 *  open was requested and no other navigation moved `interactionEpoch` (the
 *  store's settle-late contract). */
function claimRepoOpen(): () => boolean {
  const request = ++latestOpenRequest;
  const epoch = useUiStore.getState().interactionEpoch;
  return () =>
    request === latestOpenRequest &&
    useUiStore.getState().interactionEpoch === epoch;
}

/**
 * The one tail every open of a recorded repo runs once its path has validated,
 * and the only place that switches to one: warm the repo's shell reads, record it
 * in recents, wait out the warm-up budget, then switch, unless a newer open or
 * navigation arrived meanwhile (silently: that newer action is what the user sees).
 * The recents write finishes BEFORE the switch, so the row exists when
 * RepositoryView mounts and its open-time visibility probe persists onto it; it is
 * best-effort, since a settings-write failure must never block opening. Resolves
 * whether it switched. `stillCurrent` defaults to a claim taken on entry; a caller
 * with awaits of its own claims before them.
 */
export function useOpenRecordedRepo() {
  const openRepo = useUiStore((s) => s.openRepo);
  const { mutateAsync: addRecent } = useAddRecentRepo();
  const queryClient = useQueryClient();
  return useCallback(
    async (
      info: RepoInfo,
      stillCurrent: () => boolean = claimRepoOpen(),
    ): Promise<boolean> => {
      const warmed = warmRepoShell(queryClient, info.root);
      await addRecent({ path: info.root, name: info.name }).catch(
        () => undefined,
      );
      await warmed;
      if (!stillCurrent()) return false;
      openRepo(info);
      return true;
    },
    [addRecent, openRepo, queryClient],
  );
}

/**
 * Opens a repository by path: validates it, records it in recents, and switches
 * the app to it. A `source: "recent"` path that's no longer a git repo offers a
 * toast to **Locate…** the folder's new home (moved on disk) or **Remove** the
 * stale row; a `source: "picker"` one is a folder the user just chose rather
 * than a recents row to repair, so it only reports that it isn't a repository.
 * Resolves whether the app switched: false on a failure (which toasts) and when a
 * newer open or navigation superseded this one (silent).
 * Callers: the shared recents list, macOS File → Open Recent, the folder
 * picker in {@link usePickAndOpenRepo}, and a submodule opened as its own
 * repository from the Submodules dialog.
 */
export function useOpenRepoByPath() {
  const openRecorded = useOpenRecordedRepo();
  const removeRecent = useRemoveRecentRepo();
  const relocate = useRelocateRecentRepo();
  const settings = useSettings();
  const recentRepos = settings.data?.recentRepos;
  const queryClient = useQueryClient();

  const recordOpenAndTrack = useCallback(
    async (
      info: RepoInfo,
      source: "recent" | "picker" | "relocate",
      stillCurrent: () => boolean,
    ) => {
      const opened = await openRecorded(info, stillCurrent);
      if (opened) track({ name: "repo_opened", properties: { source } });
      return opened;
    },
    [openRecorded],
  );

  // A recents row whose folder moved: pick the new folder, validate it, repoint
  // the existing row in place (preserving alias + probed metadata), then open.
  const locateAndReopen = useCallback(
    async (oldPath: string) => {
      const picked = await openDialog({
        directory: true,
        title: "Locate repository",
      });
      if (typeof picked !== "string") return;
      try {
        const info = await validateRepo(picked);
        // Any git repo validates, but the OLD folder is gone so we can't verify
        // it's the SAME repo — picking a different one would irreversibly fold
        // this repo's app data into another's identity keys. Confirm first (the
        // house rule for destructive paths). The name comes from the recents row
        // (alias or name), else the moved folder's basename.
        const oldRow = recentRepos?.find((r) => r.path === oldPath);
        const oldName =
          oldRow?.alias?.trim() || oldRow?.name || repoNameFromPath(oldPath);
        const confirmed = await useConfirm.getState().ask({
          title: `Relocate "${oldName}"?`,
          body: `GitDesktop will point this entry at ${info.root} — its alias, local PRs, issues, review history, and settings will follow the folder. If this is a different repository, that data is merged in and can't be undone.`,
          confirmLabel: "Relocate",
        });
        if (!confirmed) return;
        // Claimed past the prompt, which the user answers in place: the window
        // this guards is the relocate, re-home, and open that follow.
        const stillCurrent = claimRepoOpen();
        // Best-effort, like the addRecent write below — a settings failure must
        // never block opening. Repoint before addRecent so the follow-up write
        // finds the row at its new path and just refreshes name/order.
        await relocate
          .mutateAsync({ oldPath, newPath: info.root })
          .catch(() => undefined);
        // Re-home every per-repo app-data store (local PRs/issues, review history,
        // automations, Jira link, …) onto the new location's identity key. Purely
        // best-effort — a migration failure must never block opening the repo.
        await migrateRepoData(oldPath, info.root).catch(() => undefined);
        // The task config is cached under one global key, and a save made from a
        // pre-migration snapshot would persist the old scope keys back over the
        // re-home — in their identity form, which folding won't repair. Reset
        // rather than invalidate: observers drop to pending (a brief skeleton)
        // instead of serving stale tasks through the refetch. Not awaited, so it
        // can never hold up the open.
        void queryClient
          .resetQueries({ queryKey: scriptsKeys.config })
          .catch(() => undefined);
        // The plan/research stores hydrate once at startup, so their live runs
        // still carry the old path — repoint them, or the sidebar loses them and
        // their debounced autosave writes the pre-migration paths back to disk.
        usePlanStore.getState().relocateRepoPath(oldPath, info.root);
        useResearchStore.getState().relocateRepoPath(oldPath, info.root);
        await recordOpenAndTrack(info, "relocate", stillCurrent);
      } catch (e) {
        if (isAppError(e) && e.kind === "notARepo") {
          // The picked folder isn't a repo — no Locate/Remove actions here (no
          // recursion; the original row is still in the list to re-offer).
          toast.error(`${picked} is not a git repository.`);
        } else {
          toastError(e);
        }
      }
    },
    [relocate, recordOpenAndTrack, recentRepos, queryClient],
  );

  return useCallback(
    async (
      path: string,
      source: "recent" | "picker" = "recent",
    ): Promise<boolean> => {
      // Claimed before validating, so the latest intent wins: a newer open retires
      // this one even when that newer open then fails.
      const stillCurrent = claimRepoOpen();
      try {
        const info = await validateRepo(path);
        return await recordOpenAndTrack(info, source, stillCurrent);
      } catch (e) {
        if (isAppError(e) && e.kind === "notARepo") {
          if (source === "picker") {
            // The user is acting on a folder they just picked, not on a recents
            // row, so the row-repair actions (Locate/Remove) don't apply here.
            toast.error(`${path} is not a git repository.`);
          } else {
            toast.error(`${path} is no longer a git repository.`, {
              duration: 10_000,
              action: {
                label: "Locate…",
                onClick: () => void locateAndReopen(path),
              },
              cancel: {
                label: "Remove",
                onClick: () =>
                  void removeRecent.mutateAsync(path).catch(() => undefined),
              },
            });
          }
        } else {
          toastError(e);
        }
        return false;
      }
    },
    [recordOpenAndTrack, locateAndReopen, removeRecent],
  );
}

/**
 * Switches the active repo to a linked worktree directory. A worktree's `.git`
 * is a pointer file, but `validateRepo` runs `rev-parse --show-toplevel`, which
 * resolves it to the worktree root — so opening it Just Works. Unlike
 * {@link useOpenRepoByPath} this does NOT record the path in recents: worktrees
 * are child checkouts of a repo already in the switcher, not first-class repos.
 *
 * Resolves TRUE only once the app is actually in the worktree — false when the
 * open failed (which toasts), when the user switched repos, navigated, or asked
 * for another open meanwhile, or when `stillWanted` retired it; all but the
 * failure are silent. A caller that reports the navigation to the user must
 * await this and gate on it; callers that only navigate ignore the value,
 * awaited or not. The guard reads the live repo when this is CALLED, so a
 * caller that awaits something else FIRST needs its own check before calling.
 *
 * @param stillWanted Re-checked after `validateRepo` and the shell warm-up, for
 * a caller that sequences several opens: a newer one can start while those run,
 * and the repo is unchanged in that case, so only the caller knows it is stale.
 * A standalone open passes nothing.
 */
export function useOpenWorktree() {
  const openRepo = useUiStore((s) => s.openRepo);
  const queryClient = useQueryClient();
  return useCallback(
    async (path: string, stillWanted?: () => boolean) => {
      // `openRepo` writes GLOBAL navigation state, so it may only fire while the
      // app is still where this call started — the user can switch repositories,
      // open Settings, or start another open while the awaits below run, and an
      // unguarded write would yank them back into the previous repo's worktree.
      // The toast stays unconditional: the validation failed wherever they are now.
      //
      // `stillWanted` covers what those checks can't: a caller sequencing
      // several opens (the branch switcher) can have the user pick again while
      // THIS open is pending, and nothing global moves in that case. A caller
      // whose open stands alone passes nothing.
      const firedOn = useUiStore.getState().repoPath;
      const stillCurrent = claimRepoOpen();
      try {
        const info = await validateRepo(path);
        await warmRepoShell(queryClient, info.root);
        if (useUiStore.getState().repoPath !== firedOn) return false;
        if (!stillCurrent()) return false;
        if (stillWanted && !stillWanted()) return false;
        openRepo(info);
        return true;
      } catch (e) {
        toastError(e);
        return false;
      }
    },
    [openRepo, queryClient],
  );
}

/**
 * Prompts for a local folder, then opens it as a repository (validate, record
 * in recents, switch to it). App is the sole caller — it registers this as the
 * `add-local-repository` action, and every surface offering "Open repository…"
 * dispatches that action rather than calling here.
 */
export function usePickAndOpenRepo() {
  const openByPath = useOpenRepoByPath();
  return useCallback(async () => {
    const path = await openDialog({
      directory: true,
      title: "Open repository",
    });
    if (typeof path === "string") await openByPath(path, "picker");
  }, [openByPath]);
}
