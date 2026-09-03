- GitHub calls that target a repository now run against that repository's own host
  whenever you're signed in to that host: pull requests, Actions, releases, and
  rulesets on a GitHub Enterprise remote reach its instance, and a `GH_HOST` left set
  in your shell no longer redirects them.
