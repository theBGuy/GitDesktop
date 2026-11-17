- When a forge accepts a write but its reply comes back incomplete or
  unreadable, the app says where things stand, so a retry doesn't make a
  duplicate. A new pull request, merge request, issue, discussion or GitLab
  release whose reply lacks its number or link shows as created, and the MCP
  server's create tools return it with a `created_warning`. Promoting a local
  pull request or issue does the same, with a link to view the new item when
  the reply has one, and the note says the local item isn't linked to it and,
  if it had comments, that they weren't carried over. For other new items
  (Bitbucket comments, tasks, pipelines, repository settings and forks; GitLab
  forks and time entries; Jira issues, comments and worklogs; GitHub projects,
  views, project items, status updates and webhooks), an unreadable reply says
  the item may already exist, so you can check before creating it again. A
  Bitbucket edit, or a Jira comment or worklog edit, says the change may
  already be saved, and a delete, approval, merge or Jira issue field change
  shows as done.
