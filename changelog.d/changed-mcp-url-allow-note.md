- Remote (HTTP) MCP servers now surface the same allowed-hosts affordance as
  custom AI provider URLs: the add/edit dialog shows an advisory note under a
  URL whose host isn't on your AI allowlist, with a one-click **Allow host**,
  and the MCP servers list flags such a server with a **host not allowed**
  badge. It's advisory only — nothing is blocked or disabled, and existing
  servers keep working — a reminder that the CLI connects to that host outside
  GitDesktop's AI host allowlist.
