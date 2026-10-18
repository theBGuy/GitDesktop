- Reset to upstream and Undo last commit now act only on the branch and commit
  you saw: a commit or branch switch that happens meanwhile (from a terminal, an
  agent, or another window) leaves everything as it is, with a toast and a
  refreshed view so you can decide again. Amend now also holds, with the reason
  shown, if HEAD detaches, or reattaches to the branch you started from, before
  you commit, and a branch switch that lands while the commit runs is refused.
  Undo also explains when there is nothing to undo onto: on a detached first
  commit, and in a shallow clone whose latest commit's parent was never fetched.
  MCP agents get the same commit check through an optional `expectedHead` on the
  `commit` (amend) and `undo_last_commit` tools.
