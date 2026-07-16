- On a GitHub fork, the app now consistently targets **your fork** instead of the
  parent repository. Previously the GitHub CLI's own auto-resolution preferred the
  upstream repo, so PR and issue surfaces (lists, detail views, comments, reviews,
  merges, labels, assignees, milestones, stars, reactions) and the PR-notification
  poller could silently act on the parent's data. They now all pin to the fork's
  own `origin`. This also covers the History tab: commit diffs and commit comments
  resolve against your fork, and a new commit comment is posted to your fork rather
  than the parent. Forks with issues turned off (GitHub's default for new forks) now
  show an informative "issues are disabled" notice instead of a failing retry.
  Repositories without an `upstream` remote are unaffected — the behavior there is
  identical to before.
