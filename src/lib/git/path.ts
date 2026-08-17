/**
 * Compares repo and worktree paths, which reach the frontend in two spellings:
 * git prints forward slashes (`worktree list`), while `validate_repo` hands back
 * backslashes on Windows — where paths also compare case-insensitively. Use the
 * result for comparison only: it is lower-cased, so it must never be shown to
 * the user, written to disk, or handed to git.
 *
 * Mirrors the backend's `normalize_wt_path`, so a path compared on one side of
 * the IPC boundary compares the same way on the other.
 */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}
