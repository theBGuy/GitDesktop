- Creating a pull request with labels or assignees no longer records each one
  **twice** on the PR's activity timeline (e.g. "added the documentation label"
  appearing twice). Labels and assignees are now applied right after the PR is
  created rather than during creation, which GitHub's CLI double-recorded.
