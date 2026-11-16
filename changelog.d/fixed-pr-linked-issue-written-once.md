- A closing line you type in a pull request description (`Closes #12`, `Fixes #12`
  and the like) keeps closing the issue when that issue is also a linked-issue chip.
  A chip adds its own line only when the description doesn't already reference the
  issue or Jira key at least as strongly on a line of its own, outside code blocks
  and HTML comments, so a chip set to close the issue still adds its `Closes` line
  when the description only relates to it.
