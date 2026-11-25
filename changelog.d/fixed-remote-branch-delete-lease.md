- **Delete on _remote_…** in the branch menu's **Remote** section removes the
  branch only at the commit the app had read for it when the confirmation
  opened: a branch that changed on the remote since stays there, and the
  message says to fetch and check it first. It's refused, with nothing
  removed, when the remote has more than one push address, or a push address
  GitDesktop can't match to the repository it fetches from.
