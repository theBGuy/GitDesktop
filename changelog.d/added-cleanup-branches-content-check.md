- **Unmerged-work check in Clean up branches.** On Git 2.38 or later,
  unless your Git configuration sets a merge driver, `merge.default` or
  `merge.renormalize`, the dialog checks whether a stale branch's work went
  into the default branch, directly or through its merged pull request's
  final version. A squash-merged branch reads as safe to delete even after
  later commits edit the same lines, and starts checked (unless a linked
  worktree holds it); a branch the check flags as carrying work it can't
  trace there starts unchecked. When the check is off, the dialog says why.
