- **Resolve all with AI** now checks the conflicted files up front and walks
  only the ones a model can take. Files that are already resolved are always
  set aside; with more than one file, so are binary and non-UTF-8 files, files
  too large for AI, symbolic links and files reached through one, and files
  excluded from AI. One notice sums up what was skipped.
