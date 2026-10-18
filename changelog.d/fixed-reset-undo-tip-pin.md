- Reset to upstream and Undo last commit now act only on the commit you saw: a
  commit that lands meanwhile (from a terminal, an agent, or another window) is
  kept, with a toast and a refreshed view so you can decide again. Undo also
  explains when there is nothing to undo onto: on a detached first commit, and
  in a shallow clone whose latest commit's parent was never fetched. MCP agents
  get the same guarantee through an optional `expectedHead` on the `commit`
  (amend) and `undo_last_commit` tools.
