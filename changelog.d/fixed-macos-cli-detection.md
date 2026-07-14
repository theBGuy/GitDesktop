- **macOS: GitHub and Git are found when launched from Finder or the Dock.** A
  GUI launch doesn't inherit your shell's `PATH`, so a Homebrew-installed `gh` or
  `git` used to read as "not found" everywhere except the About screen — breaking
  clone, pull requests, issues, and other GitHub features. GitDesktop now resolves
  these tools the same robust way About already did.
