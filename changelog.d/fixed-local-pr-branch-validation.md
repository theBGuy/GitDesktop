- Local PR branch fields now accept only real branch names — a Git revision
  expression such as `feature~1` or `main^` (possible via the MCP server's
  `create_local_pr`) previously passed validation and could merge a different
  commit than the branch it named.
