- **Deleting a locked worktree now works, and a refused deletion says so.** A
  locked worktree is removed for real — folder and git registration together —
  instead of leaving a half-removed entry that nothing could clear afterwards.
  When git declines a deletion (the worktree is locked, or holds uncommitted
  work), GitDesktop reports why and leaves the folder untouched, so you can
  unlock it or confirm the forced delete.
