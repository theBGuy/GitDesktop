- **AI generation recipes are now also MCP prompts.** GitDesktop's MCP server exposes its
  commit-message, PR-description, and branch-name generation recipes as native MCP prompts
  (`commit-message`, `pr-description`, `branch-name`) — the slash-command-like primitive many
  clients surface — alongside the existing recipe tools. Each assembles the *same* fully
  prepared context and prompt the in-app AI feature builds and hands it to the client's own
  model to complete. The prompts are read-only and always available, with no opt-in flag.
