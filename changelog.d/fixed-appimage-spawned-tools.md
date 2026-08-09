- Git and other external tools launched from the Linux AppImage (including
  commands run in the built-in terminal) no longer inherit the bundle's
  library paths — fixing fetches and pushes failing with a
  `git-remote-https: symbol lookup error` on newer distributions.
