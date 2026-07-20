- **Notes for reviewers.** Hand review context to the AI reviewer: an agent (or any
  MCP client with write access) deposits per-branch notes via the GitDesktop MCP, and
  the Create pull request dialog shows an optional **Notes for reviewers** field that
  pre-fills from that deposit for the head branch. On create the notes are posted as the
  PR's first comment and fed to the automated review as first-class context, so
  deliberate, documented decisions stop getting re-flagged. A new *Review draft PRs when
  created* automation setting (off by default) holds a draft PR's first review until it's
  marked ready for review.
