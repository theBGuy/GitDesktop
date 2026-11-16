- A new pull request, merge request, issue, discussion or GitLab release shows as
  created when the forge accepted it, even when its reply is missing the item's
  number or link; the MCP server's create tools return it with a
  `created_warning` in that case. For other new items (a Bitbucket comment,
  task, pipeline, repository setting or fork, a Jira issue, comment or worklog,
  or a GitHub project, view, project item, status update or webhook), when the
  reply can't be read the app says the item may already exist and to check
  before creating it again.
