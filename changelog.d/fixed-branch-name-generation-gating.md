- Dialogs that generate text with AI no longer let you save past a suggestion
  that is still being written. Create branch, Rename branch, the repository
  General settings on GitHub, GitLab and Bitbucket, and the task editor now keep
  their confirm button (and the Enter key) disabled until the suggestion lands.
  Closing either branch dialog also cancels the suggestion instead of leaving it
  running, which previously let a late result drop into the name field the next
  time the dialog opened — even when it was naming a different branch.
