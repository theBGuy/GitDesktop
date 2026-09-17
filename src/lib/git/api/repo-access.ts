import { invoke } from "@/lib/tauri/invoke";
import type {
  ForgeRepoAdmin,
  ForgeRepoWriteAccess,
  RemoteLens,
} from "../types";

/** Whether the signed-in user can manage this repo's settings, behind the
 *  abstraction (GitHub admin; GitLab Maintainer, with `owner` for the
 *  Owner-only lifecycle actions). Gates the settings UI. */
export const forgeRepoAdmin = (repoPath: string) =>
  invoke<ForgeRepoAdmin>("forge_repo_admin", { repoPath });

/** Whether the signed-in user can PUSH to the repo behind the lens — the
 *  permission axis the per-action forge flags don't cover (they answer "is this
 *  wired for this provider?"). Nulls mean the probe couldn't answer: fail open. */
export const forgeRepoWriteAccess = (repoPath: string, lens?: RemoteLens) =>
  invoke<ForgeRepoWriteAccess>("forge_repo_write_access", { repoPath, lens });
