import { useCallback } from "react";
import { toast } from "sonner";
import { validateRepo } from "@/lib/git/api";
import type { RepoInfo } from "@/lib/git/types";
import { isWindows } from "@/lib/hotkeys/binding";
import { isAppError } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import { sameRepoRoot } from "./submodule-row";
import { claimRepoOpen, useOpenRepoByPath } from "./useOpenRepoByPath";

/** Resolves true once useOpenRepoByPath requested the switch, which Settings'
 *  "Keep editing" over unsaved edits can still cancel. Resolves false, having
 *  toasted, when the folder is no repository of its own (the
 *  toast names the submodule-relative path) or the probe failed some other
 *  way; false with NO toast when a newer open or navigation retired the
 *  press while the probe ran; and false when the open itself didn't land. */
export function useOpenSubmoduleAsRepo(
  repoPath: string,
): (subPath: string) => Promise<boolean> {
  const openByPath = useOpenRepoByPath();
  return useCallback(
    async (subPath: string) => {
      // Repo-root-relative with forward slashes, which Windows accepts mixed
      // with the repo path's backslashes.
      const full = `${repoPath.replace(/[/\\]+$/, "")}/${subPath}`;
      // Claimed before the probe, which is part of this open's request: a
      // newer open during it wins, and a failed probe retires older ones like
      // any failed open does.
      const stillCurrent = claimRepoOpen();
      const notARepo = () => toast.error(`${subPath} is not a git repository.`);
      // Probed here rather than left to useOpenRepoByPath, whose failure toast
      // names the full path: a bad submodule reports its relative path.
      let info: RepoInfo;
      try {
        info = await validateRepo(full);
      } catch (e) {
        if (!stillCurrent()) return false;
        if (isAppError(e) && e.kind === "notARepo") notARepo();
        else toastError(e);
        return false;
      }
      if (!stillCurrent()) return false;
      // A folder with no `.git` of its own answers with the parent's root
      // (rev-parse walks up), so the submodule has no repository to open.
      if (sameRepoRoot(info.root, repoPath, isWindows)) {
        notARepo();
        return false;
      }
      // A submodule is an independent repository that nothing else in the app
      // can reach, so it earns a recents row like any other opened repo.
      return await openByPath(full, "picker", stillCurrent);
    },
    [repoPath, openByPath],
  );
}
