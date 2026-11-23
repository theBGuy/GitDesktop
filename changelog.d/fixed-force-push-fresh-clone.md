- **Force push** works in a fresh clone, where Git has no fetch history for
  `--force-if-includes` to check: GitDesktop pushes under a lease pinned to
  the remote tip from the clone's last fetch, still refuses when the remote
  has moved past it, and the success notice says which protection it used.
