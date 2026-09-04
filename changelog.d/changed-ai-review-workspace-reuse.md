- Repo-aware AI reviews now reuse a single review workspace per repository, shared
  by all its worktrees, so "Preparing review workspace…" is near-instant on every
  review after the first. A workspace left untouched for a week is reclaimed on
  startup.
