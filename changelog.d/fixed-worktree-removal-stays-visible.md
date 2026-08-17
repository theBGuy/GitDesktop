- Removing a worktree now stays on screen until it finishes. A big folder can
  take minutes, and closing the confirmation used to take the spinner with it,
  leaving nothing to say the removal was still running; it now shows at the top
  of the repository the whole time, its row in **Worktrees** says "Removing…"
  and stops accepting actions, and a second attempt on the same worktree is
  turned away instead of queueing behind the first.
