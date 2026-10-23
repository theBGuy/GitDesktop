- When a branch tracks one repository and pushes to another
  (`branch.<name>.pushRemote` or `remote.pushDefault`), the MCP `push` tool's
  refusal for a branch whose upstream has a different name now suggests a
  retry that pushes to that push remote and keeps the upstream.
