- The MCP `push` tool sends a named branch only to a remote branch of the same
  name: a branch tracking a differently named one, such as `origin/main`, is
  refused, and the error names the `set_upstream: true` call that publishes it
  under its own name.
