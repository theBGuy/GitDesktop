- **MCP server no longer blocks installs or gets killed by updates (Windows).** When you
  use GitDesktop as an MCP server, the generated config now launches a dedicated
  `gitdesktop-mcp` copy of the app instead of the installed executable. Running MCP
  servers no longer lock the installer out with a "Files in Use" dialog, and are no
  longer silently terminated mid-session by a passive auto-update. **Add to PATH** now
  points at this launcher and migrates any older install-folder entry automatically.
