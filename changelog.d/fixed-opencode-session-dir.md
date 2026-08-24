- opencode agent sessions and reviews now always run in the directory the app
  assigns them (a session's isolated worktree, a review's repository), even when
  GitDesktop is launched from a shell such as Git Bash that exports `PWD`.
