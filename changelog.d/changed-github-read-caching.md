- GitDesktop spends far fewer GitHub API requests: reads reuse unchanged server
  responses and share short-lived caches; window focus refreshes only data that
  has gone stale; fetch, pull, checkout, stash and discard no longer refresh
  GitHub data; the CI badge and run notifications share one check per branch;
  History fetches a commit's remote comments and diff only when they are needed;
  a finished Actions run's details are reused while unchanged, in the app and
  through the MCP server; and the MCP server's comment, edit, label and pull
  request description tools read only what they need (issue edits no longer
  require GitHub CLI 2.94). Changes you make in the app still show right away.
