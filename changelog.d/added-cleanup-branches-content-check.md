- **Unmerged-work check in Clean up branches.** The dialog checks whether a
  stale branch's work went into the default branch, directly or through its
  merged pull request's final version. A squash-merged branch usually reads
  as safe to delete even after later commits edit the same lines, and then
  starts checked (unless a linked worktree holds it); a branch carrying work
  the check can't trace there starts unchecked. The check needs Git 2.38 or
  later and stays off when your Git configuration sets a merge driver,
  `merge.default` or `merge.renormalize`; the dialog says why.
