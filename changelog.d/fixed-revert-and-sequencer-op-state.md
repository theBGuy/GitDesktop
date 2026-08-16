- A **revert** that hits a conflict now gets the same treatment as a merge or
  rebase: the conflict bar names it and offers **Continue revert** and **Abort**,
  and the guards that protect an operation in flight — stashing, editing history,
  promoting a worktree — hold while it is open. The same guards now also cover the
  window a multi-commit squash or fixup leaves behind when it stops on a conflict.
