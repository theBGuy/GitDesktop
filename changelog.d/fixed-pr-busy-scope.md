- Merge, close, comment, and the other actions on a GitHub, GitLab, or
  Bitbucket pull request stay available while an action on a different pull
  request finishes (a stack merge holds the rest of its stack until it lands),
  and a control held by an action on the same pull request says what it is
  waiting for or shows its progress. A local pull request's Merge waits for
  any local merge in progress and names the one that is running, and the
  Create stack and Add to stack offers tell a viewer without push access why
  they can't be used.
