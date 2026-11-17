- The MCP server's `delete_branch` tool reports the full commit id the branch
  pointed at, so `create_branch` with `from` set to it can restore the branch,
  and takes an optional `expectedTip` (a full commit id) that deletes the
  branch only while it still points at that commit.
