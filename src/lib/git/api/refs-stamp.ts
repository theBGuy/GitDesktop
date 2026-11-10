import { invoke } from "@/lib/tauri/invoke";

/** An opaque stamp that changes whenever a ref under refs/heads or
 *  refs/remotes (loose or packed) changes. Compare it to the previous reading
 *  only; never parse it. */
export const gitRefsStamp = (repoPath: string) =>
  invoke<string>("git_refs_stamp", { repoPath });
