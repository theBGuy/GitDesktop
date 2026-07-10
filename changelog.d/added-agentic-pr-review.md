- **Agentic PR review.** When your review model is a CLI agent (Claude Code, Copilot CLI,
  or opencode), turn on **Agentic review** and GitDesktop attaches itself to the run as a
  read-only MCP server: the reviewer pulls the full PR diff (past the prompt's truncation
  budget), reads any file at any ref, runs blame and history, and reads the PR's existing
  comments — reporting what it explores live in the status line. It's read-only end to end
  (no write tools, no repo changes), and after a run whose diff outgrew the prompt budget
  the panel nudges you to enable agentic review or switch to a CLI agent model for full
  coverage. Codex reviews explore the repo natively but can't attach the GitDesktop tools.
