- **More forge-write tools for GitDesktop's MCP server.** The `--allow-remote-write`
  surface now lets an agent **start a new file:line review thread** on a pull request
  (not just reply to an existing one), **request changes** or **withdraw** a change
  request, **edit an issue's** title/body and set its **milestone**, and **add or remove
  reactions** on an issue or pull request (or one of its comments) — all under your
  authenticated forge identity (GitHub `gh`, GitLab `glab`, or a stored Bitbucket token),
  and still gated behind the same `--allow-remote-write` opt-in, off by default.
