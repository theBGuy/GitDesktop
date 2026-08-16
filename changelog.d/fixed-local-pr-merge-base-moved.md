- Completing a local pull-request merge now leaves the base branch's own history
  alone. If the branch moved at all while the merge was being prepared — a commit
  landing from another window or worktree, or a reset winding it back during a
  long conflict-resolution session — the merge stops and says so, with your
  resolution still waiting where you left it, ready to re-run from where the
  branch now stands.
