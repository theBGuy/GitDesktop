- Repo-aware AI reviews and sessions run with the Claude CLI can now actually
  call the attached GitDesktop MCP tools. Previously the tools were exposed but
  never granted permission, so every call was denied in headless mode and the
  reviewer silently fell back to files on disk (losing full-diff, PR-metadata,
  and blame lookups); the read-only server's tools are now granted explicitly.
