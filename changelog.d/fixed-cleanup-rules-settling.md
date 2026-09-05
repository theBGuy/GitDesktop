- Cleaning up branches and deleting a branch now wait for branch protection
  rules to finish loading before any delete runs, so a protected branch can't
  slip through while the rules are still being read.
