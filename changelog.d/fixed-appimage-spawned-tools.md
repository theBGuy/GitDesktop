- Git, the GitHub/GitLab CLIs, agent tools, and commands run in the built-in
  terminal no longer inherit the AppImage bundle's library paths — fixing
  fetches and pushes failing with a `git-remote-https: symbol lookup error`
  on newer Linux distributions.
