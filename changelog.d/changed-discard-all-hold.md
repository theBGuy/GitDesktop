- Discard all runs as one atomic operation: the repository stays held from
  snapshot to reset, so a stage or commit attempted mid-discard waits behind
  a labeled busy notice.
