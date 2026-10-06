- Merging, closing, reopening, commenting, draft changes, approvals,
  auto-merge, branch updates, and starting or continuing a conflict resolution
  on a GitHub, GitLab, or Bitbucket pull request stay available while one of
  them finishes on a different pull request (a stack merge holds the rest of
  its stack until it lands), and a control held by an action on the same pull
  request says what it is waiting for or shows its progress. Checkout names the
  pull request it is checking out, a local pull request's Merge and Update
  branch name the branches they are waiting on, and Create stack and Add to
  stack hold every pull request in the stack being written, all of them still
  held after switching away and back. Auto-merge confirmations name their pull
  request, and the Create stack and Add to stack offers tell a viewer without
  push access why they can't be used.
