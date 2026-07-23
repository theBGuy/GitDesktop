import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback } from "react";
import { toast } from "sonner";
import { track } from "@/lib/analytics";
import { validateRepo } from "@/lib/git/api";
import { useAddRecentRepo, useRemoveRecentRepo } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { isAppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";

/**
 * Opens a repository by path: validates it, records it in recents, and switches
 * the app to it. A path that's no longer a git repo offers a "Remove" toast.
 * Shared by the welcome list and the in-app repo switcher.
 */
export function useOpenRepoByPath() {
  const openRepo = useUiStore((s) => s.openRepo);
  const addRecent = useAddRecentRepo();
  const removeRecent = useRemoveRecentRepo();

  return useCallback(
    async (path: string, source: "recent" | "picker" = "recent") => {
      try {
        const info = await validateRepo(path);
        // Await the recents write so the row exists before RepositoryView mounts
        // and its open-time visibility probe persists onto it (best-effort — a
        // settings-write failure must never block opening the repo).
        await addRecent
          .mutateAsync({ path: info.root, name: info.name })
          .catch(() => undefined);
        openRepo(info);
        track({ name: "repo_opened", properties: { source } });
      } catch (e) {
        if (isAppError(e) && e.kind === "notARepo") {
          toast.error(`${path} is no longer a git repository.`, {
            action: {
              label: "Remove",
              onClick: () => removeRecent.mutate(path),
            },
          });
        } else {
          toastError(e);
        }
      }
    },
    [openRepo, addRecent, removeRecent],
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
 * in recents, switch to it). Shared by the welcome screen and the in-app repo
 * switcher so "Open repository…" behaves identically everywhere.
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
