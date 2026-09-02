- Operations that reach one repository through a different path spelling or
  from a linked worktree now share that repository's operation locks, so
  transfers and worktree maintenance take turns instead of racing.
