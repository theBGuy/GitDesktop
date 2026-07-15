- MCP servers scoped to "this repo" — and the per-repo On/Optional/Off overrides
  of global servers — are now shared across the repo's worktrees, so a server you
  scoped or tuned in one checkout is offered in its sibling worktrees too.
  Existing entries keep working and migrate to the shared key the next time you
  edit them.
