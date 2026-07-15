- On a detached HEAD (for example mid-rebase or after checking out a specific
  commit), Push/Publish is disabled with an explanation instead of failing with a
  raw git error, "Update from upstream" is hidden so it can't orphan a merge, and
  the window title shows `detached @ <commit>` instead of dropping the branch name.
