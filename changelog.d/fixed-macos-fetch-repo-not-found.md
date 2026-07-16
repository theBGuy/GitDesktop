- **Fixed private-repo Fetch/Pull/Push failing on a Finder-launched macOS app.**
  When the app was launched from Finder or the Dock, network operations against a
  private HTTPS repo could fail with "Repository not found" because git's
  credential helper couldn't find `gh`/`glab` on the minimal launchd PATH, so the
  request went out unauthenticated. Fetch, pull, and push now inject the forge
  credential helper with a resolved absolute CLI path, so authentication is
  deterministic regardless of how the app was launched.
