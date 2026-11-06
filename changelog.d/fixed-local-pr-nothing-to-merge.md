- The new local pull request dialog says when the head branch is already in
  the base and keeps Create disabled until there is something to merge, so a
  new local pull request always starts open. The MCP `create_local_pr` tool
  refuses the same case.
