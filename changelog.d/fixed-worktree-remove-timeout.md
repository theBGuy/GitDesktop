- Deleting a worktree with a big working tree — `node_modules`, build output, a
  large checkout — now runs to completion instead of failing with a 30-second
  timeout, and a deletion that was cut short part-way finishes on the next try
  rather than insisting the worktree isn't there.
