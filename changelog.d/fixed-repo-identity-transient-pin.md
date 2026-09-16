- Repository-scoped MCP servers find their repository on their own: if the
  repository's identity can't be read as it opens, the lookup retries, so a
  scoped server matches without a restart. A folder replaced by a different
  repository mid-session is recognized as the new one, so per-repository
  data keeps landing where it belongs.
