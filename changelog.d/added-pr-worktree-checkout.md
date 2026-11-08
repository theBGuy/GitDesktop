- **Check out a pull or merge request into its own worktree.** Checkout now
  works on GitLab merge requests and Bitbucket pull requests as well as
  GitHub, and the caret beside it offers "Check out in a worktree…", so you
  can review a request without touching your current branch or uncommitted
  files, and switch to it in one step from the success message. The
  suggested folder sits inside the repository and is kept out of
  `git status`, an existing worktree can be updated to the request's latest
  changes, and a reset that would discard commits lists them and asks first.
