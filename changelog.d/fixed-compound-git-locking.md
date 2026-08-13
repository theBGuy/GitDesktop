- Multi-step Git operations now run as one uninterruptible unit, so
  editing history, resolving a conflict by taking one side, and keeping
  or discarding an agent session can no longer collide with another Git
  operation running at the same time — from a second window or your own
  next click. A commit made alongside one of these is kept instead of
  being swept away if the operation rolls itself back.
