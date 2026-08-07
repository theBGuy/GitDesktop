- **Pull-request conflicts, surfaced and resolved in-app.** A remote pull request
  now shows whether it merges cleanly into its base — as GitHub and GitLab report
  it, and as a local prediction on Bitbucket — with a **Conflicts** chip on the
  open rows in the list. When it doesn't, **Resolve conflicts** merges the base
  into the PR's head in a hidden isolated worktree, leaving your branch and
  working tree untouched: resolve the files in the in-app conflict editor, then
  **Finish & push** updates the pull request's head branch (never force-pushed).
  **Discard** throws the attempt away, and an unfinished resolution is offered
  back when you return to the pull request.
