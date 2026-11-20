- **Edit the commit message when you merge a pull request.** The merge dialog
  shows the message the merge will write: a **Commit message** row with the
  forge's default title (Bitbucket, which doesn't report one, shows
  **Bitbucket's default message**) and an **Edit** button that opens
  **Title** and **Description** fields in place, plus **Reset to default**
  once you've changed them. It covers merge commits and squashes on GitHub,
  GitLab and Bitbucket, and GitLab auto-merge; a GitLab squash that also
  writes a merge commit gets a **Squash commit** row and a **Merge commit**
  row. Leave the message alone and the forge applies its own default or
  template. Local pull requests merge through the same dialog, starting from
  the pull request's title and description. Rebase, fast-forward and stacked
  GitHub merges have no single message to edit, and the dialog says so.
  `Ctrl`/`⌘`+`Enter` merges from a field, a merge that fails keeps what you
  typed, and the MCP `merge_pull_request` tool takes the message too, tied on
  GitHub and GitLab to the head commit it was written for.
