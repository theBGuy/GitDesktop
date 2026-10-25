- A finished GitHub Actions run's details are reused while unchanged, in the
  app and through the MCP server, and the MCP server's pull request comments
  tool reads only the conversation, so these reads use less of your GitHub API
  rate limit.
