- Discarding selected files, or selected lines of a new file, acts only on
  what Git still sees: a new file goes to the recycle bin (or loses the
  chosen lines) only while Git still lists it as new. If it has changed
  state since, nothing changes and you're asked to refresh and try again.
  Discards also wait their turn behind GitDesktop's other Git operations on
  the repository. The MCP server's `discard_changes` and `discard_all_changes`
  tools read paths from the repository root, even when the server is
  started in a subfolder.
