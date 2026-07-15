- Setting a PR's reviewers or assignees, editing an issue field (assignee,
  milestone, due date, …), or changing a Jira field no longer briefly reverts a
  different field you changed at the same time if one of the requests fails —
  each rollback now restores only the field it owns. Approving or requesting
  changes on a merge request also cancels any in-flight refresh first, so the
  button state can't flip back on you.
