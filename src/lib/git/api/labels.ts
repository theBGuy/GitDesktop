import { invoke } from "@/lib/tauri/invoke";
import type { RemoteLens, RepoLabel } from "../types";

export const forgeRepoLabels = (repoPath: string, lens: RemoteLens) =>
  invoke<RepoLabel[]>("forge_repo_labels", { repoPath, lens });

// No lens on the wire: GitHub addresses this write by global node id (`repoPath`
// only picks the cwd/host) and the lens switcher is GitHub-only, so it is
// lens-free by construction; lens support on another forge must thread one.
/** Add/remove labels on an issue or MR. GitHub keys them by GraphQL node id
 *  (`addIds`/`removeIds` on `labelableId`); GitLab keys them by name
 *  (`addNames`/`removeNames` on `number`). Callers pass both; the forge command
 *  takes whichever pair the repo's provider addresses by. `target` is "issue"|"mr". */
export const forgeEditLabels = (
  repoPath: string,
  target: "issue" | "mr",
  number: number,
  labelableId: string,
  addIds: string[],
  removeIds: string[],
  addNames: string[],
  removeNames: string[],
) =>
  invoke<void>("forge_edit_labels", {
    repoPath,
    target,
    number,
    labelableId,
    addIds,
    removeIds,
    addNames,
    removeNames,
  });
