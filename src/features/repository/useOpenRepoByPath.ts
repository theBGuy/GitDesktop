import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { toast } from "sonner";
import { track } from "@/lib/analytics";
import { validateRepo } from "@/lib/git/api";
import type { RepoInfo } from "@/lib/git/types";
import { migrateRepoData } from "@/lib/repo-data-migration";
import {
  useAddRecentRepo,
  useRelocateRecentRepo,
  useRemoveRecentRepo,
  useSettings,
} from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { isAppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";

/**
 * Opens a repository by path: validates it, records it in recents, and switches
 * the app to it. A path that's no longer a git repo offers a toast to **Locate…**
 * the folder's new home (moved on disk) or **Remove** the stale row.
 * Every open-by-path route lands here: the shared recents list, macOS
 * File → Open Recent, and the folder picker in {@link usePickAndOpenRepo}.
 */
export function useOpenRepoByPath() {
  const openRepo = useUiStore((s) => s.openRepo);
  const addRecent = useAddRecentRepo();
  const removeRecent = useRemoveRecentRepo();
  const relocate = useRelocateRecentRepo();
  const settings = useSettings();
  const recentRepos = settings.data?.recentRepos;

  // Shared tail for every successful open: record in recents (best-effort — a
  // settings-write failure must never block opening), switch to the repo, track.
  // Awaiting the recents write means the row exists before RepositoryView mounts
  // and its open-time visibility probe persists onto it.
  const recordOpenAndTrack = useCallback(
    async (info: RepoInfo, source: "recent" | "picker" | "relocate") => {
      await addRecent
        .mutateAsync({ path: info.root, name: info.name })
        .catch(() => undefined);
      openRepo(info);
      track({ name: "repo_opened", properties: { source } });
    },
    [addRecent, openRepo],
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
          oldRow?.alias?.trim() ||
          oldRow?.name ||
          oldPath.split(/[/\\]/).pop() ||
          oldPath;
        const confirmed = await useConfirm.getState().ask({
          title: `Relocate "${oldName}"?`,
          body: `GitDesktop will point this entry at ${info.root} — its alias, local PRs, issues, review history, and settings will follow the folder. If this is a different repository, that data is merged in and can't be undone.`,
          confirmLabel: "Relocate",
        });
        if (!confirmed) return;
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
        await recordOpenAndTrack(info, "relocate");
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
    [relocate, recordOpenAndTrack, recentRepos],
  );

  return useCallback(
    async (path: string, source: "recent" | "picker" = "recent") => {
      try {
        const info = await validateRepo(path);
        await recordOpenAndTrack(info, source);
      } catch (e) {
        if (isAppError(e) && e.kind === "notARepo") {
          toast.error(`${path} is no longer a git repository.`, {
            duration: 10_000,
            action: {
              label: "Locate…",
              onClick: () => void locateAndReopen(path),
            },
            cancel: {
              label: "Remove",
              onClick: () => removeRecent.mutate(path),
            },
          });
        } else {
          toastError(e);
        }
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
 */
export function useOpenWorktree() {
  const openRepo = useUiStore((s) => s.openRepo);
  return useCallback(
    async (path: string) => {
      try {
        const info = await validateRepo(path);
        openRepo(info);
      } catch (e) {
        toastError(e);
      }
    },
    [openRepo],
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
