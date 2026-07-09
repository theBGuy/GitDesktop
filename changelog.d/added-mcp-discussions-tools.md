- **GitHub Discussions tools for GitDesktop's MCP server.** When run *as* an MCP server
  against a GitHub repo, an agent can now browse discussions: **list categories**, **list
  discussions**, and **read a full thread** with its nested replies (always-on reads). With
  `--allow-remote-write` it can also **create** a discussion in a category, **comment** on
  one, **mark/unmark a reply as the answer**, and **close or reopen** a discussion — under
  your authenticated `gh` identity, with a **Posted by GitDesktop** footer on posted
  comments. Discussions are a GitHub feature, so these tools return an actionable error on a
  GitLab or Bitbucket remote.
