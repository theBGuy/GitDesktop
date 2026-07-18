- Push, pull, fetch, and clone to private repos no longer fail with "Repository not
  found" when a stale credential in the system keychain (macOS Keychain, Windows
  Credential Manager) shadows your `gh`/`glab` sign-in — Git is now told to use exactly
  the signed-in CLI's identity for that host. Tag pushes, remote branch deletion, and
  fork PR pushes now authenticate the same way.
