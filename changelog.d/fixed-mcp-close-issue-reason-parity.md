- **MCP issue tools** (closing, reopening, commenting, editing, and setting
  assignees, milestones or labels) refuse a pull request's number on GitHub, so
  an issue tool doesn't change a pull request by mistake. `close_issue` and
  `reopen_issue` say when an issue was already closed or open, and
  `close_issue` checks the close reason the same way on GitHub and GitLab; its
  GitLab reply shows that GitLab keeps no close reason.
- **Closing or reopening a GitLab issue** reports an error when GitLab answers
  but keeps the issue as it was.
