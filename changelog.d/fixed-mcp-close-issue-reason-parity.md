- **MCP issue tools** (closing, reopening, commenting, editing, and setting
  assignees, milestones or labels) refuse a pull request's number on GitHub.
  `close_issue` and `reopen_issue` say when an issue was already closed or
  open, and `close_issue` checks the close reason the same way on GitHub and
  GitLab; its GitLab reply shows that GitLab keeps no close reason.
- **Closing or reopening a GitLab issue** confirms the issue's new state, and
  reports an error when GitLab keeps the issue as it was.
