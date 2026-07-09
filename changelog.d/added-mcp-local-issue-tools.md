- **Local-issue tools for GitDesktop's MCP server.** Alongside the existing local-PR tools,
  the `--allow-write` opt-in now also lets a connected agent create a local issue, comment on
  one, and set its status — GitDesktop's own app-data issue records for the bound repo,
  nothing pushed to a forge. New ungated read tools list and get local issues (and list/get
  local PRs), so an agent can read the app's local review artifacts without any write opt-in.
