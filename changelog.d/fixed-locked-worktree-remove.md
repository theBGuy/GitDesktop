- **Deleting a locked worktree now works, and a refused deletion says so.** A
  locked worktree is removed for real — folder and git registration together —
  instead of leaving a ghost entry stuck in the worktree list.
  When git declines a deletion (the worktree is locked, or holds uncommitted
  work), GitDesktop reports why and leaves the folder untouched, so you can
  unlock it or confirm the forced delete. Renaming a locked worktree is blocked
  up front too — the menu item says why, and **Unlock** is the way through —
  instead of failing with a raw git error.
