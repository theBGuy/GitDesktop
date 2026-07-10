- **See which permission tier your global MCP install runs.** In **Settings → MCP servers →
  Use GitDesktop as an MCP server**, each *Install globally* row (Claude Code / Copilot) now
  reads out the installed entry's permission tier — e.g. *Installed (local + remote writes)*,
  or *Installed (read-only)*. When the installed permissions no longer match the checkboxes
  you've selected, the row switches to a warning and offers **Reinstall** to apply them, so a
  stale global entry can't keep running old flags unnoticed.
