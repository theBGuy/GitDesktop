- When a branch's `branch.<name>.remote` setting names a remote the repository
  doesn't have, and no push remote is set, pushing the branch without choosing
  a remote stops with `unknown remote: <name>` and leaves the setting as you
  made it.
