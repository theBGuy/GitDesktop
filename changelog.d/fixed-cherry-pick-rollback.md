- When a cherry-pick onto another branch can't complete, the whole batch is
  rolled back — the target branch returns to its prior tip and you return to
  the branch you started from — and the error now tells the truth about that
  rollback: if a step of it fails, it names the tip the target had before the
  run and the exact commands to recover.
