- **Unmerged-work check in Clean up branches.** On Git 2.38 or later, unless
  your Git configuration sets a merge driver, the dialog checks whether a stale
  branch still carries work the default branch lacks, so a squash-merged branch
  with nothing left reads as safe to delete and starts checked (unless a linked
  worktree holds it), while one that still carries changes is flagged and starts
  unchecked.
