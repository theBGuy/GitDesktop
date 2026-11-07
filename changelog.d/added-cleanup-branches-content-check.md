- **Unmerged-work check in Clean up branches.** On Git 2.38 or later, unless
  your Git configuration sets a merge driver or `merge.renormalize`, the dialog
  checks whether a stale branch still carries work that never went into the
  default branch, directly or through its merged pull request's final version.
  A squash-merged branch reads as safe to delete even after later commits edit
  the same lines, and starts checked (unless a linked worktree holds it), while
  one whose work the check can't find there is flagged and starts unchecked.
