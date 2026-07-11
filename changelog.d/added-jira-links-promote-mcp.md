- **Jira issue links, promote-to-Jira, and agent access.** The linked project's issue keys
  (e.g. `PROJ-123`) are now spotted in the current branch name, a commit's message, and a PR's
  title/description, and surfaced as a compact "referenced Jira issues" row that jumps to the
  issue in the Issues tab. A local issue can be promoted to Jira (alongside GitHub or GitLab
  when both are available) — its comments carry over and the local one closes with a back-link.
  And agents connected through GitDesktop's MCP server get `jira_*` tools to list and read the
  linked project's issues, plus comment, close/reopen, create, and assign behind the
  `--allow-remote-write` opt-in. The status chip in the Jira issue view is now also a menu
  (when your permissions allow transitions) for moving an issue to any of its workflow's
  available statuses, alongside the existing close/reopen quick action.
