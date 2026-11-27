- **Rename a branch on its remote too.** The Rename branch dialog offers
  **Also rename on _remote_** for a branch that tracks a branch of the same
  name: GitDesktop pushes the new name, then deletes the old one only if it
  hasn't moved since the dialog checked it. Before you confirm, it lists the
  open pull or merge requests that use the old name (in the repository and,
  for a fork, in its parent) and asks for a deliberate **Rename anyway** when
  there are any, or when it couldn't check one of those repositories. The
  branch's row shows the rename while it runs, and a result that stops
  partway says what is where. Works with GitHub, GitLab, Bitbucket and plain
  Git remotes.
