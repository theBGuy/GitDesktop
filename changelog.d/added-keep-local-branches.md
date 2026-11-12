- **Keep a branch local.** Mark a branch **Keep local** from its menu in the
  branch switcher (or toggle the current branch from the command palette) and
  GitDesktop holds Push, Publish, force push, Create PR, publishing a local
  pull request and publishing the repository for it, each saying why, and
  resolving a hosted pull request's conflicts won't push it either; the MCP
  server's push, force-push and pull-request creation tools refuse it too.
  The row wears a "kept local" chip, and one more menu item (also in the
  command palette) adds an optional pre-push hook so `git push` from a
  terminal stops as well (this clone only; `git push --no-verify` skips it).
