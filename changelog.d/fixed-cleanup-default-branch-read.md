- Clean up branches never lists your default branch, even when reading which
  branch that is fails: the list stays empty and says why until the read
  succeeds, so the default branch can't end up selected for archiving or
  deleting.
