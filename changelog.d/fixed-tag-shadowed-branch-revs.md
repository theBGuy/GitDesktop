- When a tag shares its name with a branch or a remote-tracking branch (such as
  `origin/main`), the app now reads the branch. The branch menu offers a reset
  to the upstream only when every local commit is already upstream, updating a
  branch from another one brings in the real base branch, a new branch starts
  from the base you picked, and the branch menu's ahead/behind counts and the
  Insights branch summary measure the branches themselves. The pull request
  conflict preview, the commits previewed when creating a pull request or local
  pull request and when rebasing onto another branch, branch names drafted from
  committed work in the New branch and Rename branch dialogs and by the MCP
  server, and newly installed hook templates that check the current branch read
  the right branch too.
