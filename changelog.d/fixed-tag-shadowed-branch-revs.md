- When a tag shares its name with a branch or a remote-tracking branch (such as
  `origin/main`), the app now reads the branch. The branch menu offers a reset
  to the upstream only when your local commits really are upstream already,
  updating a branch from another one brings in the real base branch, a new
  branch starts from the base you picked, and the branch menu's ahead/behind
  counts and the Insights branch summary measure the branches themselves. The
  pull request conflict preview, the commits previewed when creating a pull
  request or local pull request and when rebasing onto another branch, branch
  names the MCP server drafts from committed work, and newly installed hook
  templates that check the current branch read the right branch too.
