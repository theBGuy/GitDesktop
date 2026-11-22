- **Re-check** under **Settings → About** now also has the app reload the data
  it had cached, so after installing a tool you no longer wait out each
  screen's own refresh or restart the app. On macOS and Linux, fetches, pulls
  and pushes to GitHub or GitLab over HTTPS also start sooner when `gh` or
  `glab` isn't installed: GitDesktop remembers that your login shell couldn't
  find it, and **Re-check** (or a restart) has it look again after you install
  one that only your shell's startup files add to your PATH.
