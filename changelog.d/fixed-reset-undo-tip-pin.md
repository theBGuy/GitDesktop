- Reset to upstream and Undo last commit now act only on the commit you saw: a
  commit that lands meanwhile (from a terminal, an agent, or another window) is
  kept, with a toast and a refreshed view so you can decide again. Undo on a
  detached first commit now explains there is nothing to undo onto and leaves the
  repository intact. MCP agents get the same guarantee through an optional
  `expectedHead` on the `commit` (amend) and `undo_last_commit` tools.
