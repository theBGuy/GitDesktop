- **MCP `approve_pull_request` and `request_changes` now work on GitHub.** Both forge write
  tools previously dead-ended on GitHub repos with a "goes through the Review menu" error;
  they now route the GitHub arm through `gh pr review`, so approving and requesting changes on
  a PR work across GitHub, GitLab, and Bitbucket. (GitHub's `request_changes` requires a
  non-empty body; the error surfaces if it's omitted, and withdrawing a requested-changes
  review stays unsupported on GitHub, as `gh` can't do it.)
