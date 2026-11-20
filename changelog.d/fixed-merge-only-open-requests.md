- **Merge** acts only on a pull request or merge request that is still open.
  GitDesktop checks its state with GitHub, GitLab or Bitbucket first, so one
  that was closed, declined or already merged in the meantime is left as it
  is and the app says why. When GitDesktop can't read the state, nothing is
  merged and you can try again. Merges sent through the MCP server get the
  same check.
