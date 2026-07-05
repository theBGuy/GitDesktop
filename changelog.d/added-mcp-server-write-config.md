- **Write GitDesktop's MCP config straight into `.mcp.json`.** The *Use GitDesktop
  as an MCP server* panel now writes (and merges) its `gitdesktop` entry into your
  repo's `.mcp.json` for you, preserving any other servers — no more copy-paste.
  A **Shareable entry** toggle switches between machine-specific absolute paths and
  portable `${GITDESKTOP_BIN}` / `${CLAUDE_PROJECT_DIR}` paths a teammate can commit,
  and an **Allow write tools** toggle adds `--allow-write` so agents can create,
  comment on, approve, and set the status of *this repo's* local PRs — kept off by
  default, leaving the server read-only.
