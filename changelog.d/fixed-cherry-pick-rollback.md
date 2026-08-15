- When a cherry-pick onto another branch can't complete, the automatic
  rollback returns the target branch to its prior tip and puts you back on
  the branch you started from; if that rollback itself can't complete, the
  error names the target's pre-run tip and the exact commands to recover.
