- The new local pull request dialog checks whether the head branch has
  anything to merge: when it's already in the base, the dialog says so and
  holds Create, and the MCP `create_local_pr` tool refuses the same case.
