- GitDesktop spends far fewer GitHub API requests. Window focus refreshes only
  data that has gone stale; fetch, pull, checkout, stash and discard no longer
  refresh GitHub data; the CI badge and run notifications share one check per
  branch; and History fetches a commit's remote comments and diff only when
  they are needed.
