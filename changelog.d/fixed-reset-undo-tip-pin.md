- Reset to upstream and Undo last commit now act only on the branch and
  commit you saw: if another Git process (a terminal, an agent, or another
  window) commits or switches branches while one runs, it stops with a
  toast and a refreshed view, and nothing is reset or undone, so you can
  decide again. Amend also stays tied to the branch, or detached HEAD, you
  started it on: it waits while HEAD is elsewhere. When another Git process
  moves HEAD just as an amend runs, the amend still completes, and its
  toast says the amend raced another Git process and names the commit or
  branch when it can tell; the replaced commit stays in the reflog. Undo
  explains when there is nothing to undo onto (a detached first commit, or
  a shallow clone whose latest commit's parent was never fetched), and asks
  you to finish a merge, cherry-pick or revert in progress, or to resolve
  conflicts, first. MCP agents get the same commit check through an
  optional `expectedHead` on the `commit` (amend) and `undo_last_commit`
  tools, and the `commit` result reports a raced amend in `raced`.
