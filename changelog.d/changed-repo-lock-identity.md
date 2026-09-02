- Operations that reach one repository through a different path spelling now
  share its operation locks, and transfers and worktree maintenance from a
  linked worktree take their turn with the main checkout's instead of racing.
