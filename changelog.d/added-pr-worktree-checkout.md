- **Check out a pull request into its own worktree.** On GitHub, GitLab and
  Bitbucket, Checkout switches to a pull or merge request's branch. The caret
  beside it offers "Check out in a worktree…", so you can review a pull or
  merge request without touching your current branch or uncommitted files,
  and switch to it in one step from the success message. The suggested folder
  sits inside the repository and is kept out of `git status`, an existing
  worktree can be updated to the pull request, and a reset that would discard
  commits lists them and asks first.
