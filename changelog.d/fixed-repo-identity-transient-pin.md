- Repository-scoped MCP servers find their repository on their own: if the
  repository's identity can't be read as it opens, the lookup retries, so a
  scoped server matches without a restart.
