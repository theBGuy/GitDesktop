- **Full PR/issue forge-write surface for GitDesktop's MCP server.** The
  `--allow-remote-write` tools now go well beyond commenting: an agent can create, merge,
  update, and close/reopen a pull request, toggle its draft state, request reviewers, edit
  labels, set assignees (on issues and PRs), approve or withdraw approval, reply to and
  resolve review threads, rerun/cancel/dispatch CI, and create or update releases — all
  under your authenticated forge identity (GitHub `gh`, GitLab `glab`, or a stored Bitbucket
  token). New read tools round it out: list labels, milestones, and releases, get a release,
  list assignable users, and fetch a PR's full timeline. It stays gated behind the same
  `--allow-remote-write` opt-in, off by default.
