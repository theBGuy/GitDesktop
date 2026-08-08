- **Continuing a conflicted merge records just your merge message.** Git's
  `# Conflicts:` comment block stays out of the commit, so what lands — and what
  everyone reads on the forge — is the message you meant. GitDesktop cleans that
  message the way git's own editor flow does, so any line that *starts* with `#`
  is dropped from a merge message you wrote yourself; a `#` mid-line, like the
  issue reference in `Fix #42`, is left alone.
