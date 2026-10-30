- Accepting a conflict region, or an AI proposal, keeps edits made to the file
  outside GitDesktop: when the file changed on disk after it was read, the
  accept writes nothing and says so. The conflict editor re-reads the file, and
  the AI proposal stays on screen to regenerate.
