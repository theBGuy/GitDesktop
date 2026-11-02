- **Git hooks and agents find your tools on macOS and Linux.** Commits,
  pushes and the other git operations GitDesktop runs now see your login
  shell's PATH, so hooks that call node, npx, or pre-commit work when
  GitDesktop is launched from Finder, the Dock, or a Linux desktop launcher,
  and keep working after an in-app update relaunch. The Hooks dialog's
  install commands resolve the same way. Agent sessions and AI reviews that
  run on your machine (not in a container) get the same PATH, as do the
  built-in terminal and GitDesktop's MCP server when another app starts it.
  If reading that PATH fails at launch, GitDesktop tries again a minute
  later.
