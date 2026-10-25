- On GitHub, the MCP server's edit, label and pull request description tools
  read only the fields they need, and opening an unchanged issue again shortly
  after sends one fewer request that counts toward your GitHub API rate limit.
  Editing an issue's title, body or labels through the MCP server no longer
  requires GitHub CLI 2.94.
