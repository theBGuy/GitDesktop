- Stashing is now refused while a merge, rebase or cherry-pick is in progress —
  including one whose conflicts you have already resolved and staged — so the
  resolution stays with the operation git is still tracking, and promoting a
  worktree is blocked while the main workspace is mid-operation, before the
  point of no return.
