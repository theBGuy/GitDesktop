- Your **AI ignore patterns** are now honored when generating the description
  for a pull request you're creating (local PRs included, and the MCP
  `generate_pr_description` tool), when generating a squashed commit's message,
  and when generating a reworded commit's message in Edit history — those paths
  previously sent the whole branch diff to the provider. The prompt states how
  many files were held back rather than passing the diff off as complete.