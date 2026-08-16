- Completing a local pull-request merge now keeps every commit on the base
  branch. If the branch picked up a commit while the merge was being prepared —
  from another window, another worktree, or a long conflict-resolution session —
  the merge stops and says so, with your resolution still waiting where you left
  it, ready to re-run.
