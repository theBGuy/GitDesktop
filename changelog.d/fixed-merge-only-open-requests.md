- **Merge** checks that a pull request or merge request is still open before
  merging it. GitDesktop reads its state from GitHub, GitLab or Bitbucket
  first, so one that was closed, declined or already merged in the meantime
  is left as it is and the app says why. When the state check itself fails,
  nothing is merged and you can try again. Merges sent through the MCP server
  get the same check.
