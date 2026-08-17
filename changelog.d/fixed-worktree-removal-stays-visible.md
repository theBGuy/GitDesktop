- Removing a worktree now stays on screen until it finishes. A big folder can
  take minutes, so the removal shows at the top of the repository the whole
  time, even after the confirmation closes; its row in **Worktrees** says
  "Removing…" and holds every action except copying its path, and a second
  attempt on the same worktree is turned away instead of queueing behind the
  first.
