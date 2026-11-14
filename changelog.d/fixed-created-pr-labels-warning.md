- When GitHub creates a pull request but can't apply its labels or
  assignees, the app reports the new pull request as created, with a
  warning to add them from the pull request. The MCP server's
  `create_pull_request` tool returns the created pull request with a
  `followup_warning` in that case, instead of an error.
