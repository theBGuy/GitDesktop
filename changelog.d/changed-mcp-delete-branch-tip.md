- The MCP server's `delete_branch` tool reports the commit the branch pointed
  at, so `create_branch` can restore it, and takes an optional `expectedTip`
  that deletes the branch only while it still points at that commit.
