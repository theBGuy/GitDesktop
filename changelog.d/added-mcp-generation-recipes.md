- **AI generation recipes over MCP.** GitDesktop's MCP server exposes three ungated
  `generate_commit_message`, `generate_pr_description`, and `generate_branch_name` tools that
  hand a connected agent the *same* fully assembled context and prompt the in-app AI features
  build — the staged or branch diff with GitDesktop's low-value-file budgeting, recent commit
  subjects as a style reference, your repo and global instructions, and `.aiignore`
  filtering. The tools don't call a model themselves; the agent completes the returned prompt
  with its own inference, so you can trigger GitDesktop's generation from any MCP client.
