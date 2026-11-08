- On GitLab, Load 100 more keeps adding open merge requests and issues past
  the first 100, up to 500, and long Closed merge request lists stay in
  newest-first order. The MCP `list_pull_requests` tool reads up to 500 open
  merge requests on GitLab too, and `list_issues` up to 500 issues.
