- Your **AI ignore patterns** are now honored when generating the description
  for a pull request you're creating (local PRs included, and the MCP
  `generate_pr_description` tool) and when generating a squashed or reworded
  commit's message in Edit history — those paths previously sent the whole
  branch diff to the provider. The
  prompt states how many files were held back rather than passing the diff off
  as complete. (Regenerating the description of an existing remote
  PR still uses the forge's own diff, which has no path filtering to apply.)
