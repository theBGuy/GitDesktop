- The MCP `drop_stash` tool takes the stash's `sha` (which `list_stashes` now
  returns) instead of an index, and drops exactly that stash wherever it sits
  in the list, refusing when it's already gone.
