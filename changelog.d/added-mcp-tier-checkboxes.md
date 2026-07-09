- **MCP server write tiers as checkboxes.** The *Use GitDesktop as an MCP server*
  panel now has toggles for all four write tiers — **Allow write tools**, **Allow
  remote write**, **Allow git writes** (`--allow-git-write`, recoverable repo
  mutations: stage/commit, branches, push/pull, stash, merge/rebase, tags), and
  **Allow destructive git writes** (`--allow-destructive`, only enabled once git
  writes are on: discard, reset, force-push, force deletions). Each toggle threads
  its flag into the copyable snippet, the *Write to .mcp.json* action, and both
  global installs, so you no longer hand-edit the config to grant a tier.
