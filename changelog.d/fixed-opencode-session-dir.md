- opencode agent sessions and reviews now run in the directory the app gives
  them. When GitDesktop was started from a shell that exports `PWD` (Git Bash,
  for example), opencode read that path instead and could work in whatever
  directory that shell was in rather than the session's isolated worktree.
