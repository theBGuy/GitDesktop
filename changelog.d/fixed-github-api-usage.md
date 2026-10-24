- GitDesktop spends far fewer GitHub API requests: window focus refreshes only
  data that has gone stale, local Git actions refresh only local state, the CI
  badge and run notifications share one check per branch, and History fetches a
  commit's remote comments and diff only when they are needed.
